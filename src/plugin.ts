import { installSettingsSection } from '@deepseek-ai/dsh-settings'

import { decodeRavenTaskState } from './codec.js'
import { Config, RAVEN_SETTINGS_NAMESPACE, type RavenConfig } from './config.js'
import { ACTION_FIELDS, createRavenEngine, renderArtifact } from './engine.js'
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
/**
 * Rendered from the runtime allow-list so the advertised per-action field sets
 * cannot drift from the ones the engine enforces.
 */
const ACTION_FIELD_SUMMARY = Object.entries(ACTION_FIELDS)
  .map(([action, fields]) => `${action}(${fields.filter(field => field !== 'action').join(', ') || 'no other field'})`)
  .join('; ')
/**
 * Plugin-owned session event carrying the record `presentationMeta` publishes.
 * A nested Code Mode sub-call has no result card, so the Harness registry computes
 * no presentation metadata for it and the dispatch bridge logs rendered content
 * without any. Task steps taken from inside a `run_code` program would then vanish
 * from a resumed session while the in-memory book still looked complete. The event
 * type intentionally repeats the metadata kind: both name the same durable record.
 */
const STATE_EVENT = META_KIND

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

interface ContentBlockLike extends Record<string, unknown> {
  readonly type: string
}

/** The normalized outcome the Harness hands to `finalizeContent`, narrowed to what Raven reads. */
interface ToolOutcomeLike {
  readonly isError: boolean
  readonly content: readonly ContentBlockLike[]
}

/** Execution identity as `finalizeContent` sees it: no signal, no context deferral. */
interface ToolIdentityLike {
  readonly agent?: AgentLike
  readonly arguments?: unknown
}

interface RavenToolDefinition extends Record<string, unknown> {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: ToolOutput
  execute(args: unknown, exec: ToolExecutionLike): Promise<RavenToolValue>
  finalizeContent(exec: ToolIdentityLike, result: ToolOutcomeLike): ContentBlockLike[] | undefined
}

interface SessionLike {
  readonly events: readonly unknown[]
  /** Absent on a host that exposes a read-only session view; durability then rests on result metadata alone. */
  append?(type: string, data: unknown): unknown
}

interface AgentLike {
  readonly id: string
  readonly session: SessionLike
}

interface ToolExecutionLike {
  readonly agent?: AgentLike
  /** Present only for a nested sub-call, such as a Code Mode dispatch inside `run_code`. */
  readonly parent?: unknown
  readonly signal: AbortSignal
}

interface WebFetchResultLike {
  readonly url: string
  readonly statusCode: number
  readonly body: {
    readonly kind: 'html' | 'text'
    readonly content: string
  }
  /** The Harness fetch contract caps body size; a cut-off tail is a retrieval limit, not missing evidence. */
  readonly truncated?: boolean
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
  /** Cordis dependency gate; the settings wiring rides it so an absent service simply never runs. */
  inject(dependencies: readonly string[], callback: (ctx: ContextLike) => void): unknown
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

/** The durable Task record an event carries, from either publication path. */
function readTaskStateMeta(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (event.type === 'tool/result') return asRecord(asRecord(event.data)?.meta)
  if (event.type === STATE_EVENT) return asRecord(event.data)
  return undefined
}

function restoreTaskBook(events: readonly unknown[]): SessionTaskBook {
  const book: SessionTaskBook = { tasks: new Map() }
  const currentDeclarations: string[] = []
  let lastStateTaskId: string | undefined
  for (const raw of events) {
    const event = asRecord(raw)
    if (event === undefined) continue
    const meta = readTaskStateMeta(event)
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

/** The session's Task book, restored from the durable log the first time this Agent is seen. */
function taskBookFor(books: Map<string, SessionTaskBook>, agent: AgentLike): SessionTaskBook {
  const existing = books.get(agent.id)
  if (existing !== undefined) return existing
  const restored = restoreTaskBook(agent.session.events)
  books.set(agent.id, restored)
  return restored
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

/**
 * Block-level elements create a real visible-text boundary; inline elements do not.
 * Replacing every tag with a space splits words that inline markup interrupts
 * (`pre<em>cise</em>`, `50<sup>th</sup>`, and any CJK text wrapped in a span),
 * which produces false "excerpt not found" rejections against genuine sources.
 */
const BLOCK_LEVEL_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'dialog',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

function fetchedVisibleText(result: WebFetchResultLike): string {
  if (result.body.kind === 'text') return result.body.content
  return result.body.content
    .replaceAll(/<!--[\s\S]*?-->/g, ' ')
    .replaceAll(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replaceAll(
      /<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi,
      (_tag, tagName: string) => BLOCK_LEVEL_TAGS.has(tagName.toLowerCase()) ? ' ' : '',
    )
    .replaceAll(/<[^>]*>/g, ' ')
}

/**
 * Longest prefix of `excerpt` that occurs in `body`. Prefix containment is monotone,
 * so a binary search finds the exact divergence point.
 */
function longestPrefixMatch(body: string, excerpt: string): { length: number; index: number } {
  let low = 1
  let high = excerpt.length
  let length = 0
  let index = -1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const found = body.indexOf(excerpt.slice(0, middle))
    if (found === -1) {
      high = middle - 1
    } else {
      length = middle
      index = found
      low = middle + 1
    }
  }
  return { length, index }
}

/** Actionable repair guidance: where the recorded anchor stops matching, and what the source actually says. */
function excerptMismatchDetail(body: string, excerpt: string, locator: string): string {
  const { length, index } = longestPrefixMatch(body, excerpt)
  if (length === 0 || index === -1) {
    return `no part of the recorded excerpt occurs in the retrieved source at ${locator};`
      + ' treat this as a possible fabricated quotation rather than an anchor repair'
  }
  const window = body.slice(index, index + Math.min(excerpt.length + 40, 240)).trim()
  return `recorded excerpt diverges from the retrieved source at ${locator} after ${length}`
    + ` matching character(s); nearest retrieved passage: "${window}".`
    + ' Replace the excerpt with the shortest exact contiguous phrase that still carries the Claim,'
    + ' without adding terminal punctuation the source does not contain'
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

function sourceVerifier(
  ctx: ContextLike,
  now: () => string,
  settings: () => RavenConfig,
): SourceVerifier {
  return {
    async verify(sources: readonly SourceCheckRequest[], signal: AbortSignal): Promise<readonly SourceCheckResult[]> {
      const config = settings()
      const unverifiable = (detail: string): readonly SourceCheckResult[] => {
        const checkedAt = now()
        return sources.map(source => ({
          sourceId: source.sourceId,
          status: 'unavailable' as const,
          checkedAt,
          detail,
        }))
      }
      if ((config.sourceVerification ?? 'remote') === 'structural-only') {
        // Withholding the network is a deployment decision, so it reports the same
        // way an absent capability does: unverifiable evidence, never silent trust.
        return unverifiable(
          'remote Source verification is disabled for this deployment'
          + ' (raven-research.sourceVerification=structural-only)',
        )
      }
      const web = webCapability(ctx.get('web'))
      if (web === undefined) return unverifiable('DeepSeek Harness web capability is not composed')
      const timeoutMs = config.sourceCheckTimeoutMs ?? 0
      const results: SourceCheckResult[] = []
      for (const source of sources) {
        signal.throwIfAborted()
        const checkedAt = now()
        // One deadline per Source: a slow origin costs that Source its verification,
        // not the whole Checkpoint.
        const deadline = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
        const attempt = deadline === undefined ? signal : AbortSignal.any([signal, deadline])
        try {
          const fetched = await settleWithAbort(web.fetch({ url: source.url }, attempt), attempt)
          const httpReachable = fetched.statusCode >= 200 && fetched.statusCode < 400
          const resolvedUrl = new URL(fetched.url)
          const identityMatched = sameSourceIdentity(source.url, fetched.url)
          const body = httpReachable && identityMatched
            ? normalizedEvidence(fetchedVisibleText(fetched))
            : ''
          const excerpt = normalizedEvidence(source.excerpt)
          const excerptMatched = body.length > 0 && body.includes(excerpt)
          // A cut-off body cannot disprove an excerpt from the tail. Report it as
          // unverifiable rather than as an evidence defect: both block publication,
          // but only one of them accuses the agent of fabricating a quotation.
          const truncatedMiss = !excerptMatched && httpReachable && identityMatched && fetched.truncated === true
          results.push({
            sourceId: source.sourceId,
            status: excerptMatched ? 'reachable' : truncatedMiss ? 'unavailable' : 'failed',
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
                      : truncatedMiss
                        ? `the retrieved body was truncated before the excerpt at ${source.locator} could be confirmed;`
                          + ' narrow the retrieval or cite a passage inside the retrieved range,'
                          + ' and do not weaken the excerpt to fit the visible prefix'
                        : excerptMismatchDetail(body, excerpt, source.locator),
                }),
          })
        } catch (error) {
          signal.throwIfAborted()
          results.push({
            sourceId: source.sourceId,
            status: 'unavailable',
            checkedAt,
            detail: deadline?.aborted === true
              ? `the Source check exceeded the configured ${timeoutMs}ms deadline`
              : compactError(error),
          })
        }
      }
      return results
    },
  }
}

function taskStateMeta(value: RavenToolValue): RavenTaskMeta {
  return {
    kind: META_KIND,
    version: 2,
    currentTaskId: value.currentTaskId,
    state: value.state,
  }
}

function renderToolValue(value: RavenToolValue): string {
  const lines = [
    value.message,
    `Task: ${value.state.taskId} | Outcome: ${value.state.outcome} | Phase: ${value.state.phase} | Revision: ${value.state.revision}`,
  ]
  if (value.issues.length > 0) lines.push(`Issues:\n${value.issues.map(issue => `- ${issue}`).join('\n')}`)
  if (value.wiki !== undefined) {
    // Exact bytes: the agent writes these files, so the render must not summarize them.
    for (const page of value.wiki.pages) {
      lines.push(`Write \`${page.path}\`:\n\n\`\`\`markdown\n${page.content}\`\`\``)
    }
    lines.push(`Append to \`wiki/log.md\`:\n\n\`\`\`markdown\n${value.wiki.logEntry}\`\`\``)
    return lines.join('\n\n')
  }
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
    contradicts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Claim IDs this Claim genuinely conflicts with. Preserve disagreement instead of silently choosing a side; the rendered Claim trace marks both as contested.',
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
        action: {
          type: 'string',
          enum: ['start', 'checkpoint', 'steer', 'complete', 'status', 'stop', 'resume', 'export'],
          description: `Requested Task action. Each action accepts only its own fields — ${ACTION_FIELD_SUMMARY} — and any other field fails the call.`,
        },
        taskId: { type: 'string', description: 'Existing Raven Task ID. Required by every action except start.' },
        title: { type: 'string', description: `Wiki page title for export, at most ${RAVEN_LIMITS.summaryChars} characters; defaults to the Task request. Only with action=export.` },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Wiki tags for export; lowercase letters, digits, and hyphens, and each must exist in the wiki tag taxonomy. Only with action=export.',
        },
        init: { type: 'boolean', description: 'Export also seeds wiki/SCHEMA.md, wiki/index.md, and wiki/log.md for a new repository. Only with action=export.' },
        outcome: {
          type: 'string',
          enum: ['research', 'general-writing', 'academic-writing', 'learning'],
          description: 'Kind of useful result this Task owes the user. Only with action=start.',
        },
        request: { type: 'string', description: `Task request, at most ${RAVEN_LIMITS.requestChars} characters. Only with action=start.` },
        grounding: {
          type: 'string',
          enum: ['required', 'optional', 'none'],
          description: 'Evidence policy for this Task. Only with action=start; defaults from the outcome.',
        },
        stage: {
          type: 'string',
          enum: ['discover', 'read', 'analyze', 'draft', 'verify', 'refine'],
          description: 'Stage this Checkpoint reports. Only with action=checkpoint.',
        },
        summary: { type: 'string', description: `Checkpoint summary, at most ${RAVEN_LIMITS.summaryChars} characters. Only with action=checkpoint; completion carries no summary of its own.` },
        artifact: { type: 'string', description: `Artifact bytes, at most ${RAVEN_LIMITS.artifactChars} characters. With action=checkpoint or action=complete; completion must carry the exact latest Checkpoint bytes.` },
        correction: { type: 'string', description: `Steering correction, at most ${RAVEN_LIMITS.correctionChars} characters. Only with action=steer.` },
        reason: { type: 'string', description: `Stop reason, at most ${RAVEN_LIMITS.limitationDetailChars} characters. Only with action=stop.` },
        sources: {
          type: 'array',
          items: SOURCE_SCHEMA,
          description: `Source contributions; Task state retains at most ${RAVEN_LIMITS.sources}. Only with action=checkpoint.`,
        },
        claims: {
          type: 'array',
          items: CLAIM_SCHEMA,
          description: `Claim contributions; Task state retains at most ${RAVEN_LIMITS.claims}. Only with action=checkpoint.`,
        },
        failures: {
          type: 'array',
          items: FAILURE_SCHEMA,
          description: `Failure contributions; Task state retains at most ${RAVEN_LIMITS.limitations} Limitations. Only with action=checkpoint.`,
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderToolValue(value) }],
      presentationMeta: (_args, value) => taskStateMeta(value),
    },
    finalizeContent(exec, result) {
      // Total by contract: a throw here would replace a real outcome with a
      // finalizer failure, so every step that can fail is contained.
      try {
        if (!result.isError) return undefined
        const agent = exec.agent
        if (agent === undefined) return undefined
        const book = taskBookFor(books, agent)
        const requested = asRecord(exec.arguments)?.taskId
        const state = (typeof requested === 'string' ? book.tasks.get(requested) : undefined)
          ?? (book.currentTaskId === undefined ? undefined : book.tasks.get(book.currentTaskId))
        if (state === undefined) return undefined
        return [...result.content, { type: 'text', text: taskRecoveryHint(state) }]
      } catch {
        return undefined
      }
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const book = taskBookFor(books, agent)
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
      const value: RavenToolValue = { kind: 'raven-task-result', currentTaskId, ...withStatusArtifact }
      // A direct call publishes its state through `presentationMeta` on the durable
      // tool result. A nested sub-call gets neither, so it publishes the same record
      // itself; appending on both paths would store every Task twice.
      if (exec.parent !== undefined) agent.session.append?.(STATE_EVENT, taskStateMeta(value))
      return value
    },
  }
}

/**
 * A failed call carries only the registry's error text, which cannot know that a
 * Raven Task is open. Naming the Task, its phase, and the recovery action keeps a
 * rejected call from reading as a reason to abandon the Task and start another one.
 */
function taskRecoveryHint(state: RavenTaskState): string {
  return [
    '<raven_task_recovery>',
    `This call failed. Raven Task ${state.taskId} is unchanged at revision ${state.revision}.`,
    `Outcome: ${state.outcome}. Phase: ${state.phase}. Steering revision: ${state.steeringRevision}.`,
    `Evidence: ${state.sources.length} Source(s), ${state.claims.length} Claim(s), ${state.limitations.length} Limitation(s).`,
    state.phase === 'stopped'
      ? `Call raven_task action=resume taskId=${state.taskId} before steer or checkpoint.`
      : `Correct this call against Task ${state.taskId} instead of starting a replacement Task;`
        + ` re-read it with raven_task action=status taskId=${state.taskId}.`,
    '</raven_task_recovery>',
  ].join('\n')
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

export function apply(ctx: ContextLike, config: RavenConfig = {}): void {
  const now = () => new Date().toISOString()
  const books = new Map<string, SessionTaskBook>()
  // The composition entry stays authoritative until a settings service attaches;
  // the wiring then points this thunk at the resolved scope, and points it back at
  // the entry if that service goes away. A Harness that serves no settings at all
  // never runs any of it.
  let settings: () => RavenConfig = () => config
  installSettingsSection(
    ctx as unknown as Parameters<typeof installSettingsSection>[0],
    RAVEN_SETTINGS_NAMESPACE,
    Config,
    config,
    {
      setSource: (current) => { settings = current },
      // Nothing is derived from the section: every Source check reads the thunk, so a
      // committed change takes effect on the next check with nothing to re-judge.
      onChange: () => undefined,
    },
  )
  const engine = createRavenEngine({ now, sourceVerifier: sourceVerifier(ctx, now, () => settings()) })

  ctx.systemPrompt.section({ name: 'tool:raven-task', order: 116, text: RAVEN_PROMPT })
  ctx.tools.register(toolDefinition(engine, books))
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const book = taskBookFor(books, agent)
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
