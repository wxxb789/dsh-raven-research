import { Buffer } from 'node:buffer'

import { installSettingsSection } from '@deepseek-ai/dsh-settings'

import { decodeRavenTaskState } from './codec.js'
import { Config, RAVEN_SETTINGS_NAMESPACE, type RavenConfig } from './config.js'
import { ACTION_FIELDS, createRavenEngine, renderArtifact, renderLeads, type RavenSearchLimits } from './engine.js'
import { RAVEN_PROMPT } from './prompt.js'
import { canonicalSourceUrl, sameSourceIdentity } from './url.js'
import { RAVEN_LIMITS } from './domain.js'
import type {
  LeadSearchFailure,
  LeadSearchRequest,
  LeadSearchResult,
  RavenDispatchResult,
  RavenLead,
  RavenTaskState,
  SourceCheckRequest,
  SourceCheckResult,
  SourceSearcher,
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
 * A nested Code Mode sub-call has no result card, so the Harness registry computes
 * no presentation metadata for it and the dispatch bridge logs rendered content
 * without any. Task steps taken from inside a `run_code` program would otherwise
 * vanish from a resumed session while the in-memory book still looked complete.
 *
 * The record therefore rides the durable copy of the sub-dispatch itself, through
 * the `tools/code-dispatch-log` waterfall, inside an HTML comment appended to the
 * logged content. It deliberately does NOT ride a plugin-owned session event type:
 * the Harness persistence read path refuses to interpret any log carrying an event
 * type it does not know unless the writer marked it `ignorable`, and `Session.append`
 * gives an out-of-repo plugin no way to set that marker — so one Code Mode Task step
 * would make the whole session unloadable. A known event type keeps the session
 * loadable by construction; if a deployment's spill policy replaces the logged copy,
 * the step simply is not restored, which is the honest degradation.
 */
const STATE_LOG_PREFIX = `<!-- ${META_KIND} `
const STATE_LOG_SUFFIX = ' -->'
/**
 * The event type earlier Raven builds appended directly. Still read so an in-memory
 * session that predates this build keeps its Code Mode steps; never written again.
 */
const LEGACY_STATE_EVENT = META_KIND
/** Handoff slots kept while sub-dispatches settle; bounded so a lost waterfall cannot leak. */
const PENDING_LOG_STATE_LIMIT = 64

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

/**
 * Raven reads the session log and never writes to it: every durable record rides a
 * Harness-owned event, so a read-only session view costs nothing.
 */
interface SessionLike {
  readonly events: readonly unknown[]
}

interface AgentLike {
  readonly id: string
  readonly session: SessionLike
}

interface ToolExecutionLike {
  readonly agent?: AgentLike
  /** Present only for a nested sub-call, such as a Code Mode dispatch inside `run_code`. */
  readonly parent?: unknown
  /** For a nested sub-call this is the sub-call id the durable-log waterfall reports. */
  readonly callId?: unknown
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

interface WebSearchSourceLike {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

interface WebSearchResultLike {
  /** Provider-generated answer text, when the selected backend produces any. */
  readonly content?: string
  readonly sources: readonly WebSearchSourceLike[]
  readonly truncated: boolean
}

interface WebLike {
  fetch(request: { readonly url: string }, signal?: AbortSignal): Promise<WebFetchResultLike>
  /** The same seam's search half; a deployment may compose fetch without a search provider. */
  search?(
    request: { readonly query: string; readonly maxResults?: number },
    signal?: AbortSignal,
  ): Promise<WebSearchResultLike>
}

/**
 * The parts of the experimental `ctx.agentTeams` service Raven reads, mirrored
 * structurally on purpose: the Harness Team packages are private and unpublished,
 * so an out-of-repo plugin may consume the capability only by duck typing and must
 * keep working in every deployment that composes no Team at all.
 */
interface TeamMembershipLike {
  /** The Team id, which is the Lead Agent's session id. */
  readonly id: string
  readonly role: 'lead' | 'teammate'
  readonly name: string
}

interface AgentTeamsLike {
  tryMembership(agent: unknown): TeamMembershipLike | undefined
}

interface PreStepInput {
  readonly agent: AgentLike
}

interface PreStepDecision {
  readonly kind: 'reject' | 'enter'
  readonly messages?: readonly unknown[]
}

/** One settled `run_code` sub-dispatch, as the durable-log waterfall presents it. */
interface CodeDispatchLogLike {
  readonly agent: AgentLike
  readonly subCallId: string
  readonly name: string
  readonly isError: boolean
  readonly content: readonly ContentBlockLike[]
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
  on(
    event: 'tools/code-dispatch-log',
    listener: (
      dispatch: CodeDispatchLogLike,
      next: () => Promise<ContentBlockLike[]>,
    ) => Promise<ContentBlockLike[]>,
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
  /** Agent ids whose own session log is already folded in; a Team book folds several. */
  readonly seeded: Set<string>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** The Task record embedded in one logged Code Mode sub-dispatch, when it survived. */
function readDispatchTaskState(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = asRecord(event.data)
  if (data?.name !== TOOL_NAME || !Array.isArray(data.content)) return undefined
  for (const raw of data.content) {
    const block = asRecord(raw)
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const start = block.text.indexOf(STATE_LOG_PREFIX)
    if (start === -1) continue
    const end = block.text.indexOf(STATE_LOG_SUFFIX, start + STATE_LOG_PREFIX.length)
    if (end === -1) continue
    try {
      const payload = block.text.slice(start + STATE_LOG_PREFIX.length, end).trim()
      return asRecord(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')))
    } catch {
      // A truncated or reshaped log copy loses this step, never the whole session.
      return undefined
    }
  }
  return undefined
}

/** The durable Task record an event carries, from any publication path. */
function readTaskStateMeta(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (event.type === 'tool/result') return asRecord(asRecord(event.data)?.meta)
  if (event.type === 'tool/code-dispatch') return readDispatchTaskState(event)
  if (event.type === LEGACY_STATE_EVENT) return asRecord(event.data)
  return undefined
}

/**
 * Fold one session's durable Raven records into `book`. Merging rather than
 * replacing is what lets an Agent Team share one Task: each member contributes its
 * own log, the highest revision of a Task wins, and the first folded session keeps
 * the current-Task pointer so a teammate joining later continues that Task instead
 * of redirecting it.
 */
function mergeSessionRecords(book: SessionTaskBook, events: readonly unknown[]): void {
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
  if (book.currentTaskId !== undefined) return
  for (const taskId of currentDeclarations.toReversed()) {
    if (!book.tasks.has(taskId)) continue
    book.currentTaskId = taskId
    return
  }
  if (lastStateTaskId !== undefined) book.currentTaskId = lastStateTaskId
}

/**
 * The Agent's Team membership, read structurally from the optional experimental
 * capability. Contained on every path: an experimental service must never be able
 * to fail a Raven Task step, and its absence is the ordinary case.
 */
function teamMembership(ctx: ContextLike, agent: AgentLike): TeamMembershipLike | undefined {
  const service = asRecord(ctx.get('agentTeams'))
  if (typeof service?.tryMembership !== 'function') return undefined
  try {
    const membership = (service as unknown as AgentTeamsLike).tryMembership(agent)
    return typeof membership?.id === 'string' && membership.id.length > 0 ? membership : undefined
  } catch {
    return undefined
  }
}

/**
 * Which book this Agent reads. A Team member resolves to the Lead's Team id, so one
 * Raven Task spans the whole Team: a teammate continues the Lead's Task and cannot
 * start a competing one, which is exactly the single-identity contract a Raven Task
 * already promises across workers.
 */
function bookKeyFor(agent: AgentLike, membership: TeamMembershipLike | undefined): string {
  return membership === undefined ? `agent:${agent.id}` : `team:${membership.id}`
}

/** The Task book for this Agent, folding its own durable log in the first time it is seen. */
function taskBookFor(
  ctx: ContextLike,
  books: Map<string, SessionTaskBook>,
  agent: AgentLike,
): SessionTaskBook {
  const key = bookKeyFor(agent, teamMembership(ctx, agent))
  const existing = books.get(key)
  const book = existing ?? { tasks: new Map<string, RavenTaskState>(), seeded: new Set<string>() }
  if (existing === undefined) books.set(key, book)
  if (!book.seeded.has(agent.id)) {
    book.seeded.add(agent.id)
    mergeSessionRecords(book, agent.session.events)
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

function searchCapability(value: unknown): Required<Pick<WebLike, 'search'>> | undefined {
  const candidate = asRecord(value)
  return typeof candidate?.search === 'function'
    ? value as Required<Pick<WebLike, 'search'>>
    : undefined
}

/** Identity used to fold one candidate returned by several queries into one Lead. */
function leadKey(url: string): string {
  try {
    return canonicalSourceUrl(url)
  } catch {
    return url
  }
}

/**
 * Bound one backend-supplied field. A search backend is third-party text: an
 * unbounded title, snippet, or answer would let one verbose provider decide how
 * much of the Task step its own output occupies.
 */
function boundedField(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length === 0 ? undefined : text.slice(0, maximum)
}

interface MutableLead {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
  readonly queries: string[]
}

/** One query's outcome; a failure is data, not a rejection, so siblings still land. */
type QueryOutcome =
  | { readonly query: string; readonly result: WebSearchResultLike }
  | { readonly query: string; readonly detail: string }

/**
 * Merge one batch: round-robin by rank across the queries so a single prolific
 * backend page cannot crowd out the other angles, deduplicated on canonical URL,
 * and bounded. A candidate returned by several queries records all of them —
 * breadth evidence for the agent's next move, never corroboration of a Claim.
 */
function mergeLeads(outcomes: readonly QueryOutcome[], cap: number): {
  readonly leads: readonly RavenLead[]
  readonly dropped: boolean
} {
  const byKey = new Map<string, MutableLead>()
  const order: string[] = []
  let dropped = false
  for (let rank = 0; ; rank += 1) {
    let seen = false
    for (const outcome of outcomes) {
      if (!('result' in outcome)) continue
      const source = outcome.result.sources[rank]
      if (source === undefined) continue
      seen = true
      const key = leadKey(source.url)
      const existing = byKey.get(key)
      if (existing !== undefined) {
        if (!existing.queries.includes(outcome.query)) existing.queries.push(outcome.query)
        continue
      }
      if (order.length >= cap) {
        dropped = true
        continue
      }
      const title = boundedField(source.title, RAVEN_LIMITS.leadTitleChars)
      const snippet = boundedField(source.snippet, RAVEN_LIMITS.leadSnippetChars)
      const publishedAt = boundedField(source.publishedAt, RAVEN_LIMITS.sourceAsOfChars)
      byKey.set(key, {
        url: source.url.slice(0, 2048),
        ...(title === undefined ? {} : { title }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
        queries: [outcome.query],
      })
      order.push(key)
    }
    if (!seen) break
  }
  const leads = order
    .map(key => byKey.get(key))
    .filter((lead): lead is MutableLead => lead !== undefined)
    .map(lead => ({ ...lead, queries: [...lead.queries] }))
  return { leads, dropped }
}

/**
 * Lead discovery over the Harness `ctx.web` search half.
 *
 * Deliberately different from the Harness `web_search` tool in one respect: that
 * tool cancels every sibling query as soon as one fails, because a model-facing
 * search either answers or errors. A Raven Task cannot afford that — a batch is a
 * Task step, and losing three good angles because a fourth backend call failed
 * would discard work the Task already paid for. Each query therefore carries its
 * own deadline, and a failure becomes a recorded Limitation instead of a batch
 * error. Caller cancellation stays a real cancellation on every path.
 */
function sourceSearcher(ctx: ContextLike, settings: () => RavenConfig): SourceSearcher {
  return {
    async search(request: LeadSearchRequest, signal: AbortSignal): Promise<LeadSearchResult> {
      const config = settings()
      const unavailable = (detail: string): LeadSearchResult => ({
        leads: [],
        failures: [],
        truncated: false,
        notes: [],
        unavailable: detail,
      })
      if ((config.sourceDiscovery ?? 'seam') === 'disabled') {
        return unavailable(
          'Lead discovery is disabled for this deployment'
          + ' (raven-research.sourceDiscovery=disabled)',
        )
      }
      const web = searchCapability(ctx.get('web'))
      if (web === undefined) return unavailable('DeepSeek Harness web search capability is not composed')
      const timeoutMs = config.searchTimeoutMs ?? 0
      signal.throwIfAborted()
      const outcomes = await Promise.all(request.queries.map(async (query): Promise<QueryOutcome> => {
        // One deadline per query: a slow backend costs that angle, not the batch.
        const deadline = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
        const attempt = deadline === undefined ? signal : AbortSignal.any([signal, deadline])
        try {
          const result = await settleWithAbort(
            web.search({ query, maxResults: request.maxResults }, attempt),
            attempt,
          )
          return { query, result }
        } catch (error) {
          // Caller cancellation is cancellation, never a per-query limitation.
          signal.throwIfAborted()
          return {
            query,
            detail: deadline?.aborted === true
              ? `the query exceeded the configured ${timeoutMs}ms deadline`
              : compactError(error),
          }
        }
      }))
      signal.throwIfAborted()
      const cap = Math.min(request.queries.length * request.maxResults, RAVEN_LIMITS.leads)
      const { leads, dropped } = mergeLeads(outcomes, cap)
      const failures: LeadSearchFailure[] = []
      const notes: { query: string; content: string }[] = []
      let truncated = dropped
      for (const outcome of outcomes) {
        if (!('result' in outcome)) {
          failures.push({ query: outcome.query, detail: outcome.detail })
          continue
        }
        if (outcome.result.truncated) truncated = true
        const content = boundedField(outcome.result.content, RAVEN_LIMITS.leadNoteChars)
        if (content !== undefined) notes.push({ query: outcome.query, content })
      }
      return { leads, failures, truncated, notes }
    },
  }
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
  if (signal.aborted) {
    // The operation promise already exists; refusing it without a rejection sink
    // would surface the provider's own abort as an unhandled rejection.
    void operation.catch(() => undefined)
    signal.throwIfAborted()
  }
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

/**
 * The record as one opaque token. Base64 keeps the payload out of the comment's
 * own grammar: a Task Artifact may legitimately contain `-->`, and a raw JSON
 * body would let that text close the comment and corrupt the record.
 */
function encodeStateLog(meta: RavenTaskMeta): string {
  const payload = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64')
  return `${STATE_LOG_PREFIX}${payload}${STATE_LOG_SUFFIX}`
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
  if (value.leads !== undefined) lines.push(renderLeads(value.leads))
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
  ctx: ContextLike,
  engine: ReturnType<typeof createRavenEngine>,
  books: Map<string, SessionTaskBook>,
  pendingLogState: Map<string, RavenTaskMeta>,
): RavenToolDefinition {
  return {
    name: TOOL_NAME,
    description: 'Maintain one progressive Raven Task across research, general writing, academic writing, or learning. Start once; discover Leads with a batch of complementary queries; publish useful Checkpoints before exhaustive work; apply user corrections with steer on the same taskId; record inspected Sources, Claims, and partial failures; stop/resume without loss; and complete only against the exact final Artifact. Inside an Agent Team the Task belongs to the Team, so every member continues the same one. Normal research stages need no approval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'discover', 'checkpoint', 'steer', 'complete', 'status', 'stop', 'resume', 'export'],
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
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: `Complementary search queries for one discovery batch, at most ${RAVEN_LIMITS.searchQueries} by default and ${RAVEN_LIMITS.searchQueryChars} characters each. Only with action=discover. Send several angles in ONE call — they share a deadline, are deduplicated against each other, and a failing query never cancels the rest. Results are Leads, never Sources: open a Lead and record a verbatim excerpt before it can support a Claim.`,
        },
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
        const book = taskBookFor(ctx, books, agent)
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
      const book = taskBookFor(ctx, books, agent)
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
      // tool result. A nested sub-call gets no result card, so its record is handed
      // to the durable-log waterfall keyed by this sub-call id; publishing on both
      // paths would store every Task twice.
      if (exec.parent !== undefined && typeof exec.callId === 'string') {
        pendingLogState.set(exec.callId, taskStateMeta(value))
        // A dispatch that never reaches the waterfall (no agent, contained listener
        // failure, abandoned run) must not accumulate; the map is a handoff, not a store.
        while (pendingLogState.size > PENDING_LOG_STATE_LIMIT) {
          const oldest = pendingLogState.keys().next()
          if (oldest.done === true) break
          pendingLogState.delete(oldest.value)
        }
      }
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

function activeTaskContext(state: RavenTaskState, membership: TeamMembershipLike | undefined): string {
  const latest = state.checkpoints.at(-1)
  return [
    '<raven_task_context>',
    state.phase === 'stopped'
      ? `Raven Task ${state.taskId} is stopped. Preserve it and resume only if the current user explicitly asks.`
      : `Continue Raven Task ${state.taskId}; do not start a replacement Task.`,
    ...(membership === undefined || membership.role !== 'teammate'
      ? []
      : [`You are Agent Team member "${membership.name}". This Raven Task belongs to the whole Team, not to you:`
        + ' contribute Sources, Claims, and Checkpoints to it, and never start a competing Task of your own.']),
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
  const searchLimits = (): RavenSearchLimits => {
    const config = settings()
    return {
      maxQueries: config.searchMaxQueries ?? RAVEN_LIMITS.searchQueries,
      maxResults: config.searchMaxResults ?? RAVEN_LIMITS.searchResults,
    }
  }
  const engine = createRavenEngine({
    now,
    sourceVerifier: sourceVerifier(ctx, now, () => settings()),
    sourceSearcher: sourceSearcher(ctx, () => settings()),
    searchLimits,
  })
  const pendingLogState = new Map<string, RavenTaskMeta>()

  ctx.systemPrompt.section({ name: 'tool:raven-task', order: 116, text: RAVEN_PROMPT })
  ctx.tools.register(toolDefinition(ctx, engine, books, pendingLogState))
  // The durable half of the Code Mode path: attach the Task record to the logged
  // copy of Raven's own sub-dispatch. Total by contract — the bridge contains a
  // throwing listener by logging the original content, but a Task step must not
  // depend on that, so nothing here can fail.
  ctx.on('tools/code-dispatch-log', async (dispatch, next) => {
    const content = await next()
    if (dispatch.name !== TOOL_NAME) return content
    const record = pendingLogState.get(dispatch.subCallId)
    if (record === undefined) return content
    pendingLogState.delete(dispatch.subCallId)
    return [...content, { type: 'text', text: encodeStateLog(record) }]
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const book = taskBookFor(ctx, books, agent)
    const state = book.currentTaskId === undefined ? undefined : book.tasks.get(book.currentTaskId)
    if (state === undefined || (state.phase !== 'active' && state.phase !== 'stopped')) return decision
    return {
      kind: 'enter',
      messages: [
        ...(decision.messages ?? []),
        {
          role: 'user',
          content: [{ type: 'text', text: activeTaskContext(state, teamMembership(ctx, agent)) }],
          source: { kind: 'plugin', plugin: name, form: 'instructions' },
        },
      ],
    }
  })
}
