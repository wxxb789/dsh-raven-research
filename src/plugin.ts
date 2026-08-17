import { decodeRavenTaskState } from './codec.js'
import { createRavenEngine, renderArtifact } from './engine.js'
import { RAVEN_PROMPT } from './prompt.js'
import { sameSourceIdentity } from './url.js'
import { RAVEN_LIMITS } from './domain.js'
import type {
  RavenDispatchResult,
  RavenTaskState,
  SourceCheckRequest,
  SourceCheckResult,
  SourceVerifier,
} from './domain.js'

const META_KIND = 'dsh-raven-research/task-state'
const TOOL_NAME = 'raven_task'

interface PromptSection extends Record<string, unknown> {
  readonly name: string
  readonly order: number
  readonly text: string
}

interface ToolOutput {
  readonly schema: { readonly type: 'object'; readonly additionalProperties: true }
  render(args: unknown, value: RavenToolValue): Array<{ readonly type: 'text'; readonly text: string }>
  presentationMeta(args: unknown, value: RavenToolValue): RavenTaskMeta
}

interface RavenToolDefinition extends Record<string, unknown> {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: ToolOutput
  execute(args: unknown, exec: ToolExecutionLike): Promise<RavenToolValue>
}

interface AgentLike {
  readonly id: string
  readonly session: { readonly events: readonly unknown[] }
}

interface ToolExecutionLike {
  readonly agent?: AgentLike
  readonly signal: AbortSignal
}

interface WebFetchResultLike {
  readonly url: string
  readonly statusCode: number
  readonly body: {
    readonly kind: 'html' | 'text'
    readonly content: string
  }
}

interface WebLike {
  fetch(request: { readonly url: string }, signal?: AbortSignal): Promise<WebFetchResultLike>
}

interface PreStepInput {
  readonly agent: AgentLike
}

interface PreStepDecision {
  readonly kind: 'reject' | 'enter'
  readonly messages?: readonly unknown[]
}

interface ContextLike {
  readonly tools: { register(definition: RavenToolDefinition): () => void }
  readonly systemPrompt: { section(section: PromptSection): () => void }
  get(name: string): unknown
  on(
    event: 'agent/pre-step',
    listener: (input: PreStepInput, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>,
  ): unknown
}

interface RavenToolValue extends RavenDispatchResult {
  readonly kind: 'raven-task-result'
  readonly currentTaskId: string
}

interface RavenTaskMeta {
  readonly kind: typeof META_KIND
  readonly version: 2
  readonly currentTaskId: string
  readonly state: RavenTaskState
}

interface SessionTaskBook {
  currentTaskId?: string
  readonly tasks: Map<string, RavenTaskState>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function restoreTaskBook(events: readonly unknown[]): SessionTaskBook {
  const book: SessionTaskBook = { tasks: new Map() }
  const currentDeclarations: string[] = []
  let lastStateTaskId: string | undefined
  for (const raw of events) {
    const event = asRecord(raw)
    if (event?.type !== 'tool/result') continue
    const data = asRecord(event.data)
    const meta = asRecord(data?.meta)
    if (meta?.kind !== META_KIND || (meta.version !== 1 && meta.version !== 2)) continue
    const state = decodeRavenTaskState(meta.state)
    if (state === undefined) continue
    const existing = book.tasks.get(state.taskId)
    if (existing === undefined || state.revision > existing.revision) {
      book.tasks.set(state.taskId, state)
    }
    currentDeclarations.push(meta.version === 2 && typeof meta.currentTaskId === 'string'
      ? meta.currentTaskId
      : state.taskId)
    lastStateTaskId = state.taskId
  }
  for (const taskId of currentDeclarations.toReversed()) {
    if (!book.tasks.has(taskId)) continue
    book.currentTaskId = taskId
    break
  }
  if (book.currentTaskId === undefined && lastStateTaskId !== undefined) {
    book.currentTaskId = lastStateTaskId
  }
  return book
}

function requireAgent(exec: ToolExecutionLike): AgentLike {
  if (exec.agent === undefined) throw new Error('raven_task requires an Agent-backed session')
  return exec.agent
}

function compactError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replaceAll(/\s+/g, ' ').slice(0, 300)
}

function webCapability(value: unknown): WebLike | undefined {
  const candidate = asRecord(value)
  return typeof candidate?.fetch === 'function' ? value as WebLike : undefined
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }
  return value
    .replace(/&#(\d+);/g, (entity, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10)
      return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : entity
    })
    .replace(/&#x([\da-f]+);/gi, (entity, hexadecimal: string) => {
      const codePoint = Number.parseInt(hexadecimal, 16)
      return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : entity
    })
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity)
}

function normalizedEvidence(value: string): string {
  return decodeHtmlEntities(value).replaceAll(/\s+/g, ' ').trim()
}

function fetchedVisibleText(result: WebFetchResultLike): string {
  if (result.body.kind === 'text') return result.body.content
  return result.body.content
    .replaceAll(/<!--[\s\S]*?-->/g, ' ')
    .replaceAll(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replaceAll(/<[^>]+>/g, ' ')
}

function settleWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      callback()
    }
    const aborted = () => finish(() => reject(signal.reason))
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    void operation.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

function sourceVerifier(ctx: ContextLike, now: () => string): SourceVerifier {
  return {
    async verify(sources: readonly SourceCheckRequest[], signal: AbortSignal): Promise<readonly SourceCheckResult[]> {
      const web = webCapability(ctx.get('web'))
      if (web === undefined) {
        const checkedAt = now()
        return sources.map(source => ({
          sourceId: source.sourceId,
          status: 'unavailable',
          checkedAt,
          detail: 'DeepSeek Harness web capability is not composed',
        }))
      }
      const results: SourceCheckResult[] = []
      for (const source of sources) {
        signal.throwIfAborted()
        const checkedAt = now()
        try {
          const fetched = await settleWithAbort(web.fetch({ url: source.url }, signal), signal)
          const httpReachable = fetched.statusCode >= 200 && fetched.statusCode < 400
          const resolvedUrl = new URL(fetched.url)
          const identityMatched = sameSourceIdentity(source.url, fetched.url)
          const excerptMatched = httpReachable
            && identityMatched
            && normalizedEvidence(fetchedVisibleText(fetched)).includes(normalizedEvidence(source.excerpt))
          results.push({
            sourceId: source.sourceId,
            status: excerptMatched ? 'reachable' : 'failed',
            checkedAt,
            statusCode: fetched.statusCode,
            resolvedUrl: fetched.url,
            ...(excerptMatched
              ? {}
              : {
                  detail: !httpReachable
                    ? `HTTP ${fetched.statusCode}`
                    : !identityMatched
                      ? `source resolved to a different host: ${resolvedUrl.hostname}`
                      : `recorded excerpt was not found in the retrieved source at ${source.locator}`,
                }),
          })
        } catch (error) {
          signal.throwIfAborted()
          results.push({
            sourceId: source.sourceId,
            status: 'unavailable',
            checkedAt,
            detail: compactError(error),
          })
        }
      }
      return results
    },
  }
}

function renderToolValue(value: RavenToolValue): string {
  const lines = [
    value.message,
    `Task: ${value.state.taskId} | Outcome: ${value.state.outcome} | Phase: ${value.state.phase} | Revision: ${value.state.revision}`,
  ]
  if (value.issues.length > 0) lines.push(`Issues:\n${value.issues.map(issue => `- ${issue}`).join('\n')}`)
  if (value.renderedArtifact !== undefined) lines.push(value.renderedArtifact)
  else if (value.state.latestArtifact !== null && value.status === 'stopped') {
    lines.push(renderArtifact(value.state.latestArtifact, value.state.sources, value.state.claims))
  }
  return lines.join('\n\n')
}

const SOURCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceId', 'url', 'title', 'locator', 'excerpt'],
  properties: {
    sourceId: { type: 'string', description: 'Stable Source ID, 1-64 safe identifier characters.' },
    url: { type: 'string', description: 'Canonical HTTP(S) URL, at most 2048 characters.' },
    title: { type: 'string', description: `Source title, at most ${RAVEN_LIMITS.sourceTitleChars} characters.` },
    locator: { type: 'string', description: `Evidence locator, at most ${RAVEN_LIMITS.sourceLocatorChars} characters.` },
    excerpt: { type: 'string', description: `Bounded verbatim excerpt, at most ${RAVEN_LIMITS.sourceExcerptChars} characters.` },
    role: { type: 'string', enum: ['primary', 'secondary', 'dataset', 'user-provided'] },
    sourceFamily: { type: 'string', description: `Source-family identity, at most ${RAVEN_LIMITS.sourceFamilyChars} characters.` },
    asOf: { type: 'string', description: `Evidence as-of label, at most ${RAVEN_LIMITS.sourceAsOfChars} characters.` },
  },
} as const

const CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claimId', 'text', 'kind', 'importance', 'disposition', 'sourceIds'],
  properties: {
    claimId: { type: 'string', description: 'Stable Claim ID, 1-64 safe identifier characters.' },
    text: { type: 'string', description: `Claim text, at most ${RAVEN_LIMITS.claimTextChars} characters.` },
    kind: { type: 'string', enum: ['external', 'analysis'] },
    importance: { type: 'string', enum: ['material', 'context'] },
    disposition: { type: 'string', enum: ['supported', 'qualified', 'deferred', 'rejected'] },
    sourceIds: {
      type: 'array',
      items: { type: 'string' },
      description: `Unique registered Source IDs; at most ${RAVEN_LIMITS.sources}.`,
    },
  },
} as const

const FAILURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'detail'],
  properties: {
    kind: { type: 'string', enum: ['source', 'tool', 'coverage'] },
    detail: { type: 'string', description: `Failure detail, at most ${RAVEN_LIMITS.limitationDetailChars} characters.` },
    sourceId: { type: 'string' },
  },
} as const

function toolDefinition(
  engine: ReturnType<typeof createRavenEngine>,
  books: Map<string, SessionTaskBook>,
): RavenToolDefinition {
  return {
    name: TOOL_NAME,
    description: 'Maintain one progressive Raven Task across research, general writing, academic writing, or learning. Start once; publish useful Checkpoints before exhaustive work; apply user corrections with steer on the same taskId; record inspected Sources, Claims, and partial failures; stop/resume without loss; and complete only against the exact final Artifact. Normal research stages need no approval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'checkpoint', 'steer', 'complete', 'status', 'stop', 'resume'] },
        taskId: { type: 'string' },
        outcome: { type: 'string', enum: ['research', 'general-writing', 'academic-writing', 'learning'] },
        request: { type: 'string', description: `Task request, at most ${RAVEN_LIMITS.requestChars} characters.` },
        grounding: { type: 'string', enum: ['required', 'optional', 'none'] },
        stage: { type: 'string', enum: ['discover', 'read', 'analyze', 'draft', 'verify', 'refine'] },
        summary: { type: 'string', description: `Checkpoint summary, at most ${RAVEN_LIMITS.summaryChars} characters.` },
        artifact: { type: 'string', description: `Artifact bytes, at most ${RAVEN_LIMITS.artifactChars} characters.` },
        correction: { type: 'string', description: `Steering correction, at most ${RAVEN_LIMITS.correctionChars} characters.` },
        reason: { type: 'string', description: `Stop reason, at most ${RAVEN_LIMITS.limitationDetailChars} characters.` },
        sources: {
          type: 'array',
          items: SOURCE_SCHEMA,
          description: `Source contributions; Task state retains at most ${RAVEN_LIMITS.sources}.`,
        },
        claims: {
          type: 'array',
          items: CLAIM_SCHEMA,
          description: `Claim contributions; Task state retains at most ${RAVEN_LIMITS.claims}.`,
        },
        failures: {
          type: 'array',
          items: FAILURE_SCHEMA,
          description: `Failure contributions; Task state retains at most ${RAVEN_LIMITS.limitations} Limitations.`,
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderToolValue(value) }],
      presentationMeta: (_args, value) => ({
        kind: META_KIND,
        version: 2,
        currentTaskId: value.currentTaskId,
        state: value.state,
      }),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      let book = books.get(agent.id)
      if (book === undefined) {
        book = restoreTaskBook(agent.session.events)
        books.set(agent.id, book)
      }
      const input = asRecord(args)
      const action = input?.action
      const requestedTaskId = typeof input?.taskId === 'string' ? input.taskId : undefined
      let previous: RavenTaskState | null
      if (action === 'start') {
        const active = [...book.tasks.values()].find(state => state.phase === 'active')
        previous = active ?? [...book.tasks.values()].sort((left, right) => right.ordinal - left.ordinal)[0] ?? null
      } else if (requestedTaskId !== undefined) {
        previous = book.tasks.get(requestedTaskId) ?? null
      } else {
        previous = book.currentTaskId === undefined ? null : book.tasks.get(book.currentTaskId) ?? null
      }
      if (action === 'resume'
        && requestedTaskId !== undefined
        && [...book.tasks.values()].some(state => state.taskId !== requestedTaskId && state.phase === 'active')) {
        throw new Error('stop the current active Raven Task before resuming another Task in this session')
      }
      const result = await engine.dispatch(previous, args, {
        sessionId: agent.id,
        signal: exec.signal,
      })
      book.tasks.set(result.state.taskId, result.state)
      if (action !== 'status' || book.currentTaskId === undefined) book.currentTaskId = result.state.taskId
      const currentTaskId = book.currentTaskId ?? result.state.taskId
      book.currentTaskId = currentTaskId
      const withStatusArtifact = action === 'status'
        && result.renderedArtifact === undefined
        && result.state.latestArtifact !== null
        ? { ...result, renderedArtifact: renderArtifact(result.state.latestArtifact, result.state.sources, result.state.claims) }
        : result
      return { kind: 'raven-task-result', currentTaskId, ...withStatusArtifact }
    },
  }
}

function activeTaskContext(state: RavenTaskState): string {
  const latest = state.checkpoints.at(-1)
  return [
    '<raven_task_context>',
    state.phase === 'stopped'
      ? `Raven Task ${state.taskId} is stopped. Preserve it and resume only if the current user explicitly asks.`
      : `Continue Raven Task ${state.taskId}; do not start a replacement Task.`,
    `Outcome: ${state.outcome}. Phase: ${state.phase}. Task revision: ${state.revision}. Steering revision: ${state.steeringRevision}.`,
    `Evidence: ${state.sources.length} Source(s), ${state.claims.length} Claim(s), ${state.limitations.length} Limitation(s).`,
    latest === undefined
      ? 'No Checkpoint exists yet; publish the first useful Artifact early.'
      : `Latest Checkpoint ${latest.ordinal}: ${latest.stage} — ${latest.summary}`,
    state.phase === 'stopped'
      ? 'If the user asks to continue, call raven_task action=resume before steer or checkpoint.'
      : 'If the current user message corrects assumptions or emphasis, call raven_task action=steer before the next Checkpoint.',
    '</raven_task_context>',
  ].join('\n')
}

export const name = 'raven-research'
export const inject = ['tools', 'systemPrompt'] as const

export function apply(ctx: ContextLike): void {
  const now = () => new Date().toISOString()
  const books = new Map<string, SessionTaskBook>()
  const engine = createRavenEngine({ now, sourceVerifier: sourceVerifier(ctx, now) })

  ctx.systemPrompt.section({ name: 'tool:raven-task', order: 116, text: RAVEN_PROMPT })
  ctx.tools.register(toolDefinition(engine, books))
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    let book = books.get(agent.id)
    if (book === undefined) {
      book = restoreTaskBook(agent.session.events)
      books.set(agent.id, book)
    }
    const state = book.currentTaskId === undefined ? undefined : book.tasks.get(book.currentTaskId)
    if (state === undefined || (state.phase !== 'active' && state.phase !== 'stopped')) return decision
    return {
      kind: 'enter',
      messages: [
        ...(decision.messages ?? []),
        {
          role: 'user',
          content: [{ type: 'text', text: activeTaskContext(state) }],
          source: { kind: 'plugin', plugin: name, form: 'instructions' },
        },
      ],
    }
  })
}
