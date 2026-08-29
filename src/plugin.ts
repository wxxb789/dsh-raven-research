import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import * as SystemPromptModule from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
// The augmented session-event map itself, so the event key below is the OFFICIAL
// one rather than a literal restated here. `@deepseek-ai/dsh-tools` declares
// `'tool/code-dispatch'` INTO this map, and both are published export subpaths.
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { WebFetchResult, WebRuntime, WebSearchResult } from '@deepseek-ai/dsh-web'

import { settleWithAbort } from './abort.js'
import { decodeRavenTaskState } from './codec.js'
import { Config, RAVEN_SETTINGS_NAMESPACE, type RavenConfig, type RavenRole } from './config.js'
import {
  ACTION_FIELDS,
  createRavenEngine,
  parseDraftRoute,
  renderArtifact,
  renderLeads,
  renderVariants,
  type RavenDraftLimits,
  type RavenSearchLimits,
} from './engine.js'
import { assertPublicDestination, SourceNetworkPolicyError } from './network-policy.js'
import { RAVEN_PROMPT } from './prompt.js'
import type { ProseLayoutOptions } from './prose.js'
import { sourceInspectionSha256 } from './source.js'
import { canonicalSourceUrl, redactedLeadUrl, sameSourceIdentity } from './url.js'
import {
  createRavenWorkspaceEngine,
  WORKSPACE_ACTION_FIELDS,
  WORKSPACE_PAGE_TYPES,
  type RavenWorkspaceResult,
} from './workspace.js'
import { RavenError, RAVEN_LIMITS } from './domain.js'
import type {
  DraftGenerator,
  DraftRequest,
  DraftResult,
  LeadSearchFailure,
  LeadSearchRequest,
  LeadSearchResult,
  RavenDispatchResult,
  RavenDraftRoute,
  RavenDraftVariant,
  RavenExecution,
  RavenLead,
  RavenTaskState,
  SourceCheckRequest,
  SourceCheckResult,
  SourceSearcher,
  SourceVerifier,
} from './domain.js'

const META_KIND = 'dsh-raven-research/task-state'
const TOOL_NAME = 'raven_task'
const WORKSPACE_TOOL_NAME = 'raven_workspace'

/** Render model guidance from the same per-action allow-list the runtime enforces. */
function summarizeActionFields(fieldsByAction: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(fieldsByAction)
    .map(([action, fields]) => `${action}(${fields.filter(field => field !== 'action').join(', ') || 'no other field'})`)
    .join('; ')
}

const WORKSPACE_ACTION_FIELD_SUMMARY = summarizeActionFields(WORKSPACE_ACTION_FIELDS)
const ACTION_FIELD_SUMMARY = summarizeActionFields(ACTION_FIELDS)
/**
 * A nested PTC mode sub-call has no result card, so the Harness registry computes
 * no presentation metadata for it and the dispatch bridge logs rendered content
 * without any. Task steps taken from inside a `run_code` program would otherwise
 * vanish from a resumed session while the in-memory book still looked complete.
 *
 * The record therefore rides the durable copy of the sub-dispatch itself, through
 * the `tools/ptc-dispatch-log` waterfall, inside an HTML comment appended to the
 * logged content. It deliberately does NOT ride a plugin-owned session event type:
 * the Harness persistence read path accepts only its generated known-event set, and
 * an out-of-repo plugin has no event-name registration seam — so one PTC mode Task
 * step written under a private type would make the whole session unloadable. A known event type keeps the session
 * loadable by construction; if a deployment's spill policy replaces the logged copy,
 * the step simply is not restored, which is the honest degradation.
 *
 * Every name on that path is INHERITED from the official PTC mode contract
 * (the Harness feature whose UI alias is "PTC mode") rather than restated here:
 * the event key is pinned to `SessionEventMap` (see {@link PTC_DISPATCH_EVENT}),
 * the settled payload to `PtcDispatchEventData`. The currently published compile
 * packages predate `PtcDispatchLog`, so the listener derives the shared fields from
 * that official durable-event map and the exact target gate exercises the waterfall.
 */
const STATE_LOG_PREFIX = `<!-- ${META_KIND} `
const STATE_LOG_SUFFIX = ' -->'
/**
 * The event type earlier Raven builds appended directly. Still read so an in-memory
 * session that predates this build keeps its PTC mode steps; never written again.
 */
const LEGACY_STATE_EVENT = META_KIND
/**
 * The official settle-event key of the PTC mode bridge, pinned to the augmented
 * `SessionEventMap` key set. `satisfies` keeps the value a literal type (so the
 * comparison below still narrows) while making an official rename fail this build.
 */
const PTC_DISPATCH_EVENT = 'tool/code-dispatch' satisfies keyof SessionEventMap
const PTC_DISPATCH_LOG_EVENT = 'tools/ptc-dispatch-log'
type PtcDispatchEventData = SessionEventMap[typeof PTC_DISPATCH_EVENT]
type PtcDispatchLogListener = (
  dispatch: PtcDispatchEventData,
  next: () => Promise<PtcDispatchEventData['content']>,
) => Promise<PtcDispatchEventData['content']>

/**
 * Register the renamed PTC waterfall while published compile packages still
 * describe its predecessor. The payload comes from the official durable-event
 * map rather than a locally copied field list; the exact target checkout gate
 * exercises the waterfall itself.
 */
function registerPtcDispatchLog(ctx: Context, listener: PtcDispatchLogListener): void {
  const on = ctx.on as unknown as (event: string, callback: PtcDispatchLogListener) => unknown
  on.call(ctx, PTC_DISPATCH_LOG_EVENT, listener)
}

/**
 * Put Raven's tool guidance after the Harness's PTC-only rule and before its
 * next first-party section. Older published compile packages predate the sparse
 * order table, so they retain Raven's legacy placement; a matching Harness
 * supplies the authoritative table at runtime.
 */
function ravenPromptOrder(): number {
  const firstParty = (SystemPromptModule as {
    FIRST_PARTY_SECTION_ORDER?: Readonly<Record<string, unknown>>
  }).FIRST_PARTY_SECTION_ORDER
  const ptcOnly = firstParty?.PTC_ONLY
  const next = firstParty?.FILE_REFERENCE
  return typeof ptcOnly === 'number' && typeof next === 'number' && next > ptcOnly
    ? (ptcOnly + next) / 2
    : 116
}

const RAVEN_PROMPT_ORDER = ravenPromptOrder()

/** Handoff slots kept while sub-dispatches settle; bounded so a lost waterfall cannot leak. */
const PENDING_LOG_STATE_LIMIT = 64

/**
 * The parts of the experimental `ctx.agentTeams` service Raven reads, mirrored
 * structurally on purpose: the Harness Team packages are private and unpublished,
 * so an out-of-repo plugin may consume the capability only by duck typing and must
 * keep working in every deployment that composes no Team at all. Every other seam
 * Raven touches is imported from its published Service Definition package instead,
 * so a contract change breaks the build rather than the running Task.
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

interface RavenToolValue extends RavenDispatchResult {
  readonly kind: 'raven-task-result'
  readonly currentTaskId: string
  /** Whether this result advanced durable Task state and therefore needs a replay snapshot. */
  readonly durableState: boolean
}

interface RavenWorkspaceToolValue extends RavenWorkspaceResult {
  readonly kind: 'raven-workspace-result'
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

/**
 * The Task record embedded in one logged PTC mode sub-dispatch, when it survived.
 *
 * The fields read are named through the official `PtcDispatchEventData`, so a
 * reshape of the settle payload breaks this build. The RUNTIME checks below stay
 * exactly as strict: this value comes off a durable session log that may be
 * truncated, spilled, or written by an older build, so the typing is a
 * compile-time contract and not a licence to trust the bytes. A reshaped or
 * truncated log still loses ONE step, never the session.
 */
function readDispatchTaskState(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = asRecord(event.data) as Partial<PtcDispatchEventData> | undefined
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
  if (event.type === PTC_DISPATCH_EVENT) return readDispatchTaskState(event)
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
function teamMembership(ctx: Context, agent: Agent): TeamMembershipLike | undefined {
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
function bookKeyFor(agent: Agent, membership: TeamMembershipLike | undefined): string {
  return membership === undefined ? `agent:${agent.id}` : `team:${membership.id}`
}

/**
 * How many session/Team Task books stay resident.
 *
 * The book is a CACHE, not the source of truth: the architecture records that the
 * in-memory registry only covers calls before results are durably appended, and
 * that replay metadata is the restart source of truth. Without a bound it was still
 * a leak — `taskBookFor` only ever inserted, so in a long-lived host every session
 * that ever touched Raven kept its Task states resident, and one Task state can
 * carry a 100k-character Artifact plus 256 Sources (~800 KB at the documented
 * ceilings, several Tasks per book).
 *
 * Ordinary Agent books and terminal-only Team books remain capped because durable
 * logs can rebuild them. Detected-Team books containing active or stopped Tasks are
 * never evicted: rebuilding one member at a time could fork a continuing Team Task.
 * The resident bound is therefore {@link TASK_BOOK_LIMIT} plus every continuing Team
 * book for which no evictable candidate remains.
 */
const TASK_BOOK_LIMIT = 64

/**
 * The Task book for this Agent, folding its own durable log in the first time it is
 * seen, and evicting the least recently used book once {@link TASK_BOOK_LIMIT} is
 * exceeded.
 *
 * Recency is maintained by re-inserting the key on every access: a JS Map iterates in
 * insertion order, so deleting and re-setting moves the entry to the end and
 * `keys().next()` is therefore always the least recently used one. The key being
 * requested is re-inserted BEFORE anything is evicted, so the book this very call is
 * about can never be the one dropped.
 *
 * An evicted book is not a lost Task, for a SINGLE-agent book: `seeded` is dropped
 * with it, the next call from that session re-folds the Agent's own durable log and
 * rebuilds the same state, and the only cost is that one re-fold.
 *
 * Two limits of that claim, stated because the earlier version of this comment
 * overstated it and a reader would have relied on it:
 *
 * A TEAM book folds several members' logs, but a re-fold seeds only the CALLING
 * agent's log. A rebuilt Team book therefore carries that member's contributions and
 * not yet its teammates', and an undurable step cannot be re-folded at all. To avoid
 * stale or forked continuing Tasks, Team books with an active or stopped Task are not
 * eviction candidates. If all over-limit candidates are such books, correctness makes
 * the resident cap soft by exactly the number of protected Team books above the limit.
 */
function taskBookFor(
  ctx: Context,
  books: Map<string, SessionTaskBook>,
  agent: Agent,
  membership: TeamMembershipLike | undefined = teamMembership(ctx, agent),
): SessionTaskBook {
  const key = bookKeyFor(agent, membership)
  const existing = books.get(key)
  const book = existing ?? { tasks: new Map<string, RavenTaskState>(), seeded: new Set<string>() }
  // Re-insert to mark this book most-recently-used, and to make it ineligible for the
  // eviction below no matter how small the cap is.
  books.delete(key)
  books.set(key, book)
  while (books.size > TASK_BOOK_LIMIT) {
    const evictable = [...books].find(([candidateKey, candidate]) =>
      candidateKey !== key
      && (!candidateKey.startsWith('team:')
        || [...candidate.tasks.values()].every(task => task.phase === 'completed' || task.phase === 'completed-with-limits')),
    )
    if (evictable === undefined) break
    books.delete(evictable[0])
  }
  if (!book.seeded.has(agent.id)) {
    book.seeded.add(agent.id)
    mergeSessionRecords(book, agent.session.events)
  }
  return book
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new Error('raven_task requires an Agent-backed session')
  return exec.agent
}

function compactError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replaceAll(/\s+/g, ' ').slice(0, 300)
}

/**
 * The two halves of the web seam are probed separately because a deployment may
 * compose one without the other, and they answer different questions: fetch
 * confirms recorded evidence, search finds candidates. Requiring both would make
 * a fetch-only deployment silently lose Source verification.
 *
 * The structural probe also survives the version skew an out-of-repo plugin
 * lives with: `ctx.get` answers from a service store this package does not own,
 * so a renamed or reshaped seam degrades to "not composed" rather than crashing
 * a Task step on a missing method.
 */
function webHalf<K extends 'fetch' | 'search'>(ctx: Context, method: K): Pick<WebRuntime, K> | undefined {
  const service: unknown = ctx.get('web')
  const candidate = asRecord(service)
  return typeof candidate?.[method] === 'function' ? service as Pick<WebRuntime, K> : undefined
}

/**
 * What a Source check reports when the fetch half is simply not there. Named
 * once so the startup warning, the start-time refusal, and the per-Source result
 * cannot drift apart and describe the same deployment three different ways.
 */
const WEB_FETCH_ABSENT_DETAIL = 'DeepSeek Harness web capability is not composed'

/** What the retrieval capability can actually do right now. */
type WebCapabilityState =
  | 'usable'
  | 'no-provider'
  | 'ambiguous'
  | 'configured-missing'
  | 'configured-unavailable'
  | 'absent'
  | 'unknown'

/**
 * What the retrieval capability can actually do RIGHT NOW, as opposed to whether
 * a service object exists.
 *
 * `ctx.get('web')` answering is not the same question as a usable provider being
 * registered: the seam resolves its provider at call time and throws
 * WEB_PROVIDER_UNAVAILABLE when none is usable. That distinction stayed invisible
 * until the money was spent -- a grounding-required Task would start, discover,
 * read, draft, and only then find every web Source check reporting the capability
 * missing, which makes the Checkpoint and then Completion refuse, against a floor
 * that `research` and `academic-writing` cannot lower. The failure has to arrive
 * BEFORE the research spend, so the provider registries are probed structurally.
 *
 * Structural, contained, and pessimistic-toward-`unknown` on purpose: the provider
 * maps are class fields the published types keep private, so this reads a shape it
 * does not own. An unrecognized shape yields `unknown`, which warns nobody and
 * blocks nothing -- a probe that guessed would either spam a healthy deployment or
 * refuse a Task that would have worked.
 */
function webCapabilityState(ctx: Context, half: 'fetch' | 'search'): WebCapabilityState {
  const service = webHalf(ctx, half)
  if (service === undefined) return 'absent'
  try {
    const runtime = asRecord(service)
    const registry = runtime?.[half === 'fetch' ? 'fetchProviders' : 'searchProviders']
    if (!(registry instanceof Map)) return 'unknown'
    const available = (provider: unknown): boolean => {
      const probe = asRecord(provider)?.available
      // A provider without `available()` is still selectable by the runtime.
      return typeof probe !== 'function' || (probe as () => unknown).call(provider) !== false
    }
    const configured = runtime?.[half === 'fetch' ? 'fetchProviderId' : 'searchProviderId']
    if (configured !== undefined) {
      if (typeof configured !== 'string') return 'unknown'
      const provider = registry.get(configured)
      if (provider === undefined) return 'configured-missing'
      return available(provider) ? 'usable' : 'configured-unavailable'
    }
    let usable = 0
    for (const provider of registry.values()) {
      if (!available(provider)) continue
      usable += 1
      if (usable > 1) return 'ambiguous'
    }
    return usable === 1 ? 'usable' : 'no-provider'
  } catch {
    return 'unknown'
  }
}

/** One sentence naming the missing capability and what composing it takes. */
function webCapabilityAdvice(state: WebCapabilityState, half: 'fetch' | 'search'): string | undefined {
  const capability = half === 'fetch' ? 'web fetch' : 'web search'
  if (state === 'absent') {
    return 'the DeepSeek Harness ' + capability + ' capability is not composed at all: add the'
      + ' @deepseek-ai/dsh-web service to this profile and register a ' + half + ' provider'
  }
  if (state === 'no-provider') {
    return 'the DeepSeek Harness ' + capability + ' seam is composed but no usable provider is'
      + ' registered: compose a ' + half + ' provider plugin and give it the credentials it needs'
      + ' (a provider whose API key is missing reports itself unavailable)'
  }
  if (state === 'ambiguous') {
    return 'the DeepSeek Harness ' + capability + ' seam has multiple usable providers and no selected one:'
      + ' set the web service\'s ' + half + 'Provider field to exactly one registered provider id'
  }
  if (state === 'configured-missing') {
    return 'the DeepSeek Harness ' + capability + ' seam selects a provider id that is not registered:'
      + ' correct the web service\'s ' + half + 'Provider field or compose that provider plugin'
  }
  if (state === 'configured-unavailable') {
    return 'the DeepSeek Harness ' + capability + ' seam selects a provider that reports unavailable:'
      + ' fix its credentials or configuration, or select another registered provider'
  }
  return undefined
}
/**
 * The renderable form of one backend-supplied candidate URL, or nothing.
 *
 * A Lead is stored and RENDERED into the transcript, so a backend answering with
 * `https://user:token@host/path` would print a live credential into the model's
 * context and into the durable session log, where no later redaction reaches it.
 * The previous code swallowed the parse failure and kept the raw string, which
 * meant the one case that most needed handling was the one that fell through.
 * Credentials are stripped rather than the candidate refused, because a Lead is
 * not evidence and dropping it would silently narrow discovery; a URL that does
 * not parse at all cannot be inspected for credentials, so it IS dropped.
 */
function leadUrl(url: string): string | undefined {
  return redactedLeadUrl(url)
}

/** Identity used to fold one candidate returned by several queries into one Lead. */
function leadKey(url: string): string {
  try {
    return canonicalSourceUrl(url)
  } catch {
    // Already redacted and parsed by {@link leadUrl}; a href that still refuses
    // canonicalization (a non-public scheme) folds under its own text rather than
    // silently merging with an unrelated candidate.
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
  | { readonly query: string; readonly result: WebSearchResult }
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
      const safeUrl = leadUrl(source.url)
      if (safeUrl === undefined) continue
      const key = leadKey(safeUrl)
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
        url: safeUrl.slice(0, 2048),
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
 * Widest fan-out one discovery batch may have in flight against a search backend.
 *
 * The batch is the unit and every query keeps its own deadline, but `searchMaxQueries`
 * is settings-reachable from the browser card, so an operator typing a large number
 * into a form previously decided how many simultaneous requests one Task step aimed
 * at one provider. The schema now caps that value, and this caps the CONCURRENCY
 * independently, so the two bounds cannot be defeated together: raising the query
 * bound buys more angles, never a wider burst. Nothing about the batch's semantics
 * changes -- every query still runs, still fails independently, and still records its
 * own Limitation.
 */
const SEARCH_CONCURRENCY = 4

/** Map with a hard ceiling on in-flight work, preserving input order in the result. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length })
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      // Terminate on the length, never on `items[index] === undefined`: a nullable
      // element would end that worker early and silently drop every item after it.
      if (index >= items.length) return
      const item = items[index] as T
      results[index] = await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
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
function sourceSearcher(ctx: Context, settings: () => RavenConfig): SourceSearcher {
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
      // The state, not merely the presence, of the seam: a composed search runtime
      // with no usable provider throws at call time, and reporting that as a generic
      // failure told the agent its queries were bad rather than that the deployment
      // has no search backend.
      const capability = webCapabilityState(ctx, 'search')
      if (capability !== 'usable' && capability !== 'unknown') {
        return unavailable(webCapabilityAdvice(capability, 'search') ?? 'DeepSeek Harness web search capability is not composed')
      }
      const web = webHalf(ctx, 'search')
      if (web === undefined) return unavailable('DeepSeek Harness web search capability is not composed')
      const timeoutMs = config.searchTimeoutMs ?? 0
      signal.throwIfAborted()
      const outcomes = await mapBounded(request.queries, SEARCH_CONCURRENCY, async (query): Promise<QueryOutcome> => {
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
      })
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

/**
 * Draft Variants over the Harness `ctx.llm` seam.
 *
 * Every route runs concurrently under its own deadline, and a route that fails
 * becomes one labelled variant rather than a rejection: the point of a
 * comparison round is the comparison, and losing three good candidates because a
 * fourth provider was down would discard work the Task already paid for. Caller
 * cancellation stays a real cancellation on every path.
 *
 * The seam does NOT throw on an adapter, dispatch, or iteration failure — it
 * ends the stream with a terminal `finish` chunk carrying the failure. A drafter
 * that only wrapped the loop in try/catch would silently accept an empty or
 * truncated draft as a real one, so the finish reason is inspected explicitly.
 */
function draftGenerator(ctx: Context, settings: () => RavenConfig): DraftGenerator {
  return {
    async generate(request: DraftRequest, signal: AbortSignal): Promise<DraftResult> {
      const service: unknown = ctx.get('llm')
      const candidate = asRecord(service)
      if (typeof candidate?.stream !== 'function') {
        return { variants: [], unavailable: 'DeepSeek Harness model capability is not composed' }
      }
      const llm = service as LlmRuntime
      const timeoutMs = settings().draftTimeoutMs ?? 0
      signal.throwIfAborted()
      const variants = await Promise.all(request.routes.map(async (route): Promise<RavenDraftVariant> => {
        const deadline = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
        const attempt = deadline === undefined ? signal : AbortSignal.any([signal, deadline])
        const failure = (detail: string): RavenDraftVariant => ({
          route,
          status: 'failed',
          detail: deadline?.aborted === true
            ? `the route exceeded the configured ${timeoutMs}ms deadline`
            : detail,
        })
        try {
          const assembler = new BlockAssembler()
          for await (const chunk of llm.stream({
            provider: route.provider,
            model: route.model,
            system: request.system,
            maxTokens: request.maxTokens,
            signal: attempt,
            messages: [createUserMessage({
              content: [{ type: 'text', text: `${request.context}\n\nWrite this now:\n${request.instruction}` }],
              source: { kind: 'plugin', plugin: name },
            })],
          })) {
            attempt.throwIfAborted()
            assembler.push(chunk)
          }
          const finish = assembler.finish
          if (finish.kind === 'error' || finish.kind === 'aborted') {
            signal.throwIfAborted()
            return failure(compactError(finish.failure.message))
          }
          const text = assembler.blocks()
            .filter(block => block.type === 'text')
            .map(block => (block as { readonly text: string }).text)
            .join('')
            .trim()
          if (text.length === 0) return failure('the route returned no prose')
          return {
            route,
            status: 'drafted',
            text,
            // A cut-off draft is still a usable candidate, but the agent must not
            // read its ending as the author's ending.
            ...(finish.kind === 'max-tokens' ? { detail: 'truncated at the configured token bound' } : {}),
          }
        } catch (error) {
          signal.throwIfAborted()
          return failure(compactError(error))
        }
      }))
      signal.throwIfAborted()
      return { variants }
    },
  }
}

/**
 * The entities real prose actually carries, not merely the five the HTML spec
 * requires escaping. A page that writes `&mdash;` or `&rsquo;` and an agent that
 * copied the rendered character are quoting the SAME text, and leaving the entity
 * undecoded made the comparison fail on presentation rather than on evidence.
 * The table stays a fixed list rather than a full HTML5 entity set: the whole set
 * is thousands of entries whose long tail never appears in a quotable passage, and
 * an unknown entity is left verbatim, which is inert.
 */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  // Typographic punctuation, the overwhelming majority of real mismatches.
  mdash: '\u2014',
  ndash: '\u2013',
  horbar: '\u2015',
  minus: '\u2212',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201A',
  ldquo: '\u201C',
  rdquo: '\u201D',
  bdquo: '\u201E',
  laquo: '\u00AB',
  raquo: '\u00BB',
  lsaquo: '\u2039',
  rsaquo: '\u203A',
  hellip: '\u2026',
  bull: '\u2022',
  middot: '\u00B7',
  prime: '\u2032',
  Prime: '\u2033',
  // Spaces a layout engine emits and a copy-paste preserves.
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  hairsp: '\u200A',
  shy: '\u00AD',
  zwnj: '\u200C',
  zwj: '\u200D',
  // Marks that ride real citations.
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  deg: '\u00B0',
  plusmn: '\u00B1',
  times: '\u00D7',
  divide: '\u00F7',
  frac12: '\u00BD',
  frac14: '\u00BC',
  frac34: '\u00BE',
  sect: '\u00A7',
  para: '\u00B6',
  dagger: '\u2020',
  Dagger: '\u2021',
  permil: '\u2030',
  euro: '\u20AC',
  pound: '\u00A3',
  yen: '\u00A5',
  cent: '\u00A2',
  larr: '\u2190',
  rarr: '\u2192',
  harr: '\u2194',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
}

/**
 * A numeric reference above the Unicode maximum is not a code point, and
 * `String.fromCodePoint` THROWS a RangeError on one. That throw escaped the
 * verifier's per-Source try/catch as a generic failure and was reported as an
 * unavailable Source, so one malformed entity anywhere in a retrieved page could
 * silently unverify honest evidence. Out-of-range references are left verbatim
 * instead, exactly as an unknown named entity is.
 */
function entityCodePoint(codePoint: number): string | undefined {
  if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return undefined
  // Lone surrogates are not scalar values; `fromCodePoint` accepts them but the
  // result cannot equal anything a real body carries, so leaving them verbatim
  // keeps the comparison honest.
  if (codePoint >= 0xD800 && codePoint <= 0xDFFF) return undefined
  return String.fromCodePoint(codePoint)
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (entity, decimal: string) =>
      entityCodePoint(Number.parseInt(decimal, 10)) ?? entity)
    .replace(/&#x([\da-f]+);/gi, (entity, hexadecimal: string) =>
      entityCodePoint(Number.parseInt(hexadecimal, 16)) ?? entity)
    .replace(/&([a-z][a-z\d]*);/gi, (entity, name: string) => HTML_ENTITIES[name]
      ?? HTML_ENTITIES[name.toLowerCase()]
      ?? entity)
}

/**
 * Presentation-only folding applied to BOTH the retrieved body and the recorded
 * excerpt before they are compared.
 *
 * Every rule here erases a difference that no reader would call a different
 * quotation, and the safety argument is that each one is many-to-one onto a
 * character that already carries the same meaning in running prose:
 *
 * - NFC first, so a precomposed `é` and a decomposed `e` + U+0301 are one string.
 *   Composition is the canonical form; it never merges two distinct graphemes.
 * - Curly quotes and primes fold to ASCII `'` and `"`. A publishing pipeline
 *   chooses these typographically and a copy-paste preserves whichever it saw, so
 *   the distinction is never evidential.
 * - En dash, em dash, horizontal bar and the other HYPHEN-like dashes fold to `-`,
 *   because both spellings occur for the SAME range in real sources.
 *   U+2212 MINUS SIGN is deliberately NOT folded, though it was at first. It is not
 *   a dash: in a financial or scientific record `−5` and `-5` are the same number
 *   written with the correct glyph and with the wrong one, and folding them let a
 *   recorded excerpt carrying the wrong sign glyph verify against a source carrying
 *   the right one. The fold's own justification — that the two spellings mean the
 *   same range — is false for arithmetic.
 * - The soft hyphen, the zero-width SPACE, the word joiner and the BOM are deleted.
 *   Those are line-breaking and byte-order hints with no orthographic role: an
 *   excerpt and a body that differ only by one are identical on the page, which is
 *   precisely the failure that made the mismatch report show a "nearest passage"
 *   indistinguishable from the recorded excerpt.
 *   ZWNJ (U+200C) and ZWJ (U+200D) are deliberately NOT deleted, though they were
 *   at first. They are orthographic in Persian, Arabic and the Indic scripts, and
 *   deleting them joins two tokens the source keeps apart — `re‌sign` (sign again)
 *   became `resign` (quit), which is a false ACCEPT of a different word, not a
 *   presentation difference.
 * - Whitespace collapses, as it already did.
 *
 * What is deliberately NOT folded: case, accents themselves, ASCII punctuation,
 * CJK full-width forms, and any letter. Folding those would let genuinely
 * different passages match, which is the failure mode that matters — a false
 * ACCEPT publishes a quotation the source does not carry, while a false reject
 * only asks the agent to look again.
 */
const TYPOGRAPHIC_FOLDS: readonly (readonly [RegExp, string])[] = [
  // Invisible formatting with no orthographic role: deleted, never replaced by a
  // space. ZWNJ (U+200C) and ZWJ (U+200D) are absent on purpose — see above.
  [/\u00AD|\u200B|\u2060|\uFEFF/g, ''],
  [/[\u2018\u2019\u201A\u201B\u2032\u02BC\u2035]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033\u2036\u3003]/g, '"'],
  // U+2212 MINUS SIGN is absent on purpose — see above.
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2043\uFE58\uFE63\uFF0D]/g, '-'],
]

function normalizedEvidence(value: string): string {
  let text = decodeHtmlEntities(value).normalize('NFC')
  for (const [pattern, replacement] of TYPOGRAPHIC_FOLDS) text = text.replaceAll(pattern, replacement)
  return text.replaceAll(/\s+/g, ' ').trim()
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

function fetchedVisibleText(result: WebFetchResult): string {
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

/**
 * Bound on the WHOLE verification pass, not merely on one Source.
 *
 * The pass walks the recorded Sources sequentially, and both Checkpoint and
 * Completion re-run it, so a per-Source deadline alone still multiplies: 256
 * Sources at a 20s deadline each is an eighty-minute Task step that no caller
 * asked for. The pass bound is what makes the worst case a number rather than a
 * product. It is not a per-Source deadline in disguise: a Source the pass no
 * longer has time for is reported unavailable with the pass named, so it is
 * clearly a Raven budget rather than an origin that failed.
 */
const VERIFICATION_PASS_BUDGET_MS = 180_000

/**
 * Minimum spacing between two checks against the SAME host.
 *
 * Raven fetches every recorded Source on every Checkpoint and Completion, and a
 * research Task's Sources cluster on a handful of publishers. Hammering one
 * origin is how Raven earns the 429 it then has to classify -- a rate limit Raven
 * caused reads to the agent exactly like a hostile origin. The spacing is small
 * because the loop is already sequential; it only prevents the degenerate case
 * where every Source on one host is a fast local hit.
 */
const HOST_THROTTLE_MS = 250

/** Bounded retry backoff for ONE Source. One retry, never a loop: see {@link retryableFetchError}. */
const SOURCE_RETRY_BACKOFF_MS = 500

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      clearTimeout(timer)
      reject(signal.reason as Error)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

interface HttpStatusOutcome {
  readonly status: 'failed' | 'unavailable'
  readonly detail: string
  readonly retryable: boolean
}

/**
 * How one HTTP status bears on the CITATION rather than on the transport.
 *
 * Collapsing every non-2xx into `failed` was wrong in both directions. `failed`
 * permanently defers the Claims a Source supports, which is the right answer for
 * a citation that does not exist and the wrong answer for one behind a login, a
 * proxy, a rate limit, or a broken origin -- none of which say anything about
 * whether the quotation is real. Only 404 and 410 are statements about the
 * resource itself: it is not there, or it was deliberately removed. Everything
 * else is a condition between Raven and the document, so it reports `unavailable`,
 * which the engine accepts without HTTP identity and which does not accuse anyone.
 */
function httpStatusOutcome(statusCode: number): HttpStatusOutcome | undefined {
  if (statusCode >= 200 && statusCode < 400) return undefined
  if (statusCode === 404 || statusCode === 410) {
    return {
      status: 'failed',
      detail: 'HTTP ' + statusCode + ': the cited document is not served at this URL'
        + (statusCode === 410 ? ' and the origin reports it permanently removed' : '')
        + '. This is an evidence defect rather than a retrieval problem: locate the record at its'
        + ' current address and register a new Source, or defer the Claim',
      retryable: false,
    }
  }
  if (statusCode === 401 || statusCode === 403 || statusCode === 407) {
    return {
      status: 'unavailable',
      detail: 'HTTP ' + statusCode + ': the document exists but Raven is not authorized to retrieve it'
        + ' (login, subscription, or proxy authentication). Nothing here disputes the excerpt, and'
        + ' retrying will not clear it: cite an openly retrievable version of the same record, or keep'
        + ' the Claim deferred with a coverage Limitation naming the access barrier',
      retryable: false,
    }
  }
  if (statusCode === 408 || statusCode === 425 || statusCode === 429) {
    return {
      status: 'unavailable',
      detail: 'HTTP ' + statusCode + ': the origin declined this attempt as a timing or rate condition'
        + (statusCode === 429 ? ' (rate limited)' : '')
        + ', not as a statement about the document. Retrying later is sensible;'
        + ' do not weaken the excerpt',
      retryable: true,
    }
  }
  if (statusCode >= 500) {
    return {
      status: 'unavailable',
      detail: 'HTTP ' + statusCode + ': the origin failed to serve the document, which says nothing'
        + ' about the excerpt. Retrying later is sensible; do not weaken the excerpt',
      retryable: true,
    }
  }
  return {
    status: 'unavailable',
    detail: 'HTTP ' + statusCode + ': the retrieval did not produce the document, and the status is not'
      + ' a statement that the citation is wrong. Confirm the URL, then retry or defer the Claim',
    retryable: false,
  }
}

/**
 * Whether a THROWN retrieval error is worth one more attempt.
 *
 * Conservative on purpose: an unrecognized failure is not retried, because the
 * cost of a wrong "retryable" is doubling the load on an origin already refusing
 * Raven, while the cost of a wrong "not retryable" is one honest unavailable
 * result the agent can act on.
 */
function retryableFetchError(error: unknown): boolean {
  if (error instanceof SourceNetworkPolicyError) return false
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return /econnreset|etimedout|econnrefused|epipe|enetunreach|eai_again|socket hang up|network|temporarily|timed out/.test(text)
}

/** Below this, an extraction produced no passage an excerpt could honestly be looked for in. */
const PROSE_FLOOR_CHARS = 24

/**
 * Whether a retrieved body yielded prose an excerpt could be looked for in.
 *
 * This is the difference between "the source does not say that" and "Raven could
 * not read this document", and getting it wrong is what made honest work look like
 * fabrication. A PDF, an SPA whose HTML is a script tag and an empty root element,
 * or a paywall interstitial are all COMPLETE retrievals carrying no extractable
 * prose -- and they are disproportionately the primary records research depends on
 * most. Reporting those as `failed` told the agent to treat a correct excerpt as a
 * possible fabricated quotation, and the prompt then pushed it to weaken a correct
 * excerpt to fit a body that contained nothing at all.
 *
 * The test is deliberately about what was EXTRACTED rather than about a declared
 * content type: the fetch seam classifies a body only as `html` or `text` and hands
 * back no headers, so the extraction result is the only honest signal available.
 */
function unreadableBodyDetail(
  fetched: WebFetchResult,
  extracted: string,
  locator: string,
): string | undefined {
  const raw = fetched.body.content
  if (raw.trimStart().startsWith('%PDF-')) {
    return 'the retrieved body is a PDF, which Raven cannot text-extract, so the excerpt at ' + locator
      + ' could be neither confirmed nor disproved. Cite an HTML or plain-text rendering of the same'
      + ' record, or keep the Claim deferred with a coverage Limitation naming the format;'
      + ' do NOT weaken the excerpt to fit a body Raven never read'
  }
  if (extracted.length >= PROSE_FLOOR_CHARS) return undefined
  const scriptOnly = fetched.body.kind === 'html' && /<script\b/i.test(raw)
  return 'the retrieved body could not be text-extracted: it yielded ' + extracted.length
    + ' usable character(s)'
    + (scriptOnly ? ', being a script-only shell whose text is rendered client-side' : '')
    + ', so the excerpt at ' + locator + ' could be neither confirmed nor disproved.'
    + ' Cite a server-rendered or plain-text version of the same record, retrieve it with a tool that'
    + " runs the page's scripts, or keep the Claim deferred with a coverage Limitation naming the"
    + ' extraction failure; do NOT weaken the excerpt to fit a body Raven never read'
}
/**
 * Turn one retrieved body into a Source check outcome.
 *
 * Shared by the first attempt and the retry so the two cannot classify the same
 * body differently -- a retry that judged a mismatch more leniently than the first
 * attempt would reintroduce exactly the non-determinism the retry exists to remove.
 */
function classifyFetched(
  source: SourceCheckRequest,
  fetched: WebFetchResult,
  checkedAt: string,
  retried: boolean,
): SourceCheckResult {
  const statusOutcome = httpStatusOutcome(fetched.statusCode)
  const identityMatched = sameSourceIdentity(source.url, fetched.url)
  const extracted = statusOutcome === undefined && identityMatched
    ? normalizedEvidence(fetchedVisibleText(fetched))
    : ''
  const excerpt = normalizedEvidence(source.excerpt)
  const excerptMatched = extracted.length > 0 && extracted.includes(excerpt)
  const retryNote = retried ? ' (unchanged after one retry)' : ''
  const outcome = ((): { status: 'reachable' | 'failed' | 'unavailable'; detail?: string } => {
    if (excerptMatched) {
      // A match inside a truncated retrieval is still a match: the excerpt occurred
      // in bytes this URL actually returned, which is the whole of what the check
      // asks. Suppressing it would be worse than useless — the fetch seam carries no
      // size control, so long primary documents are routinely truncated, and calling
      // every one of them unverifiable would refuse exactly the sources research
      // depends on.
      //
      // What it must NOT do is stay silent about it, because "a truncated retrieval
      // reported as a match" is named in SECURITY.md as a citation-integrity defect.
      // So the confirmation is recorded WITH the cut: the quotation is confirmed, the
      // document beyond the cut was never seen, and the trace and the wiki export
      // both carry that sentence next to the Source.
      return fetched.truncated === true
        ? {
            status: 'reachable',
            detail: 'confirmed inside a retrieval the provider truncated: the excerpt occurs in the'
              + ' returned bytes, but the document past the cut was never seen, so this confirms the'
              + ' quotation and not its surrounding context' + retryNote,
          }
        : { status: 'reachable' }
    }
    if (!identityMatched) {
      // Host drift is an identity defect before HTTP status: even an error page
      // from another host is not the Original Resource this Source names.
      return {
        status: 'failed',
        detail: 'source resolved to a different host: ' + new URL(fetched.url).hostname,
      }
    }
    if (statusOutcome !== undefined) {
      return { status: statusOutcome.status, detail: statusOutcome.detail + retryNote }
    }
    // A cut-off body cannot disprove an excerpt drawn from the tail. Report it as
    // unverifiable rather than as an evidence defect: both block publication, but
    // only one of them accuses the agent of fabricating a quotation.
    if (fetched.truncated === true) {
      return {
        status: 'unavailable',
        detail: 'the retrieved body was truncated before the excerpt at ' + source.locator
          + ' could be confirmed; narrow the retrieval or cite a passage inside the retrieved range,'
          + ' and do not weaken the excerpt to fit the visible prefix',
      }
    }
    const unreadable = unreadableBodyDetail(fetched, extracted, source.locator)
    if (unreadable !== undefined) return { status: 'unavailable', detail: unreadable }
    // `failed` is reserved for what it was always meant to mean: a body that WAS
    // retrieved as readable prose and genuinely does not carry the excerpt.
    return { status: 'failed', detail: excerptMismatchDetail(extracted, excerpt, source.locator) }
  })()
  return {
    sourceId: source.sourceId,
    status: outcome.status,
    checkedAt,
    statusCode: fetched.statusCode,
    resolvedUrl: fetched.url,
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  }
}
async function fetchSource(
  web: Pick<WebRuntime, 'fetch'>,
  url: string,
  signal: AbortSignal,
  policy: RavenConfig['sourceNetworkPolicy'],
): Promise<WebFetchResult> {
  if ((policy ?? 'unrestricted') === 'public-only') {
    await assertPublicDestination(url, { signal })
  }
  const fetched = await settleWithAbort(web.fetch({ url }, signal), signal)
  if ((policy ?? 'unrestricted') === 'public-only' && fetched.url !== url) {
    // The current Harness HTTP provider keeps redirects same-origin. Rechecking a
    // changed final URL protects other providers and any future relaxation, while
    // the documented DNS-rebinding window remains because the seam cannot pin an IP.
    await assertPublicDestination(fetched.url, { signal })
  }
  return fetched
}

interface InspectionReceipt {
  readonly toolName: string
  readonly arguments: unknown
  readonly text: string
  readonly meta?: Record<string, unknown>
}

type InspectionLookup =
  | { readonly status: 'ok'; readonly receipt: InspectionReceipt }
  | { readonly status: 'unavailable'; readonly detail: string }

function textBlocks(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const text: string[] = []
  for (const raw of value) {
    const block = asRecord(raw)
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text)
  }
  return text
}

function inspectionReceipt(events: readonly unknown[], callId: string): InspectionLookup {
  const calls: Record<string, unknown>[] = []
  const results: Record<string, unknown>[] = []
  for (const raw of events) {
    const event = asRecord(raw)
    const data = asRecord(event?.data)
    if (event?.type === 'tool/call' && data?.callId === callId) calls.push(data)
    if (event?.type !== 'tool/result') continue
    const message = asRecord(data?.message)
    const source = asRecord(message?.source)
    if (source?.callId === callId) results.push(data as Record<string, unknown>)
  }
  if (calls.length !== 1 || results.length !== 1) {
    return { status: 'unavailable', detail: 'inspection call ' + callId + ' is absent or ambiguous in the owning session log' }
  }
  const call = calls[0]
  const result = results[0]
  if (typeof call?.name !== 'string' || typeof call.arguments !== 'string') {
    return { status: 'unavailable', detail: 'inspection call ' + callId + ' has no usable tool identity or arguments' }
  }
  let args: unknown
  try {
    args = JSON.parse(call.arguments)
  } catch {
    return { status: 'unavailable', detail: 'inspection call ' + callId + ' has malformed recorded arguments' }
  }
  if (result?.error !== undefined) {
    return { status: 'unavailable', detail: 'inspection call ' + callId + ' ended with a recorded tool error' }
  }
  const message = asRecord(result?.message)
  const outer = Array.isArray(message?.content) ? message.content : []
  const blocks = outer
    .map(asRecord)
    .filter((block): block is Record<string, unknown> => block !== undefined && block.type === 'tool-result' && block.toolCallId === callId)
  if (blocks.length !== 1 || blocks[0]?.isError === true) {
    return { status: 'unavailable', detail: 'inspection call ' + callId + ' has no successful model-visible result' }
  }
  const meta = asRecord(result?.meta)
  return {
    status: 'ok',
    receipt: {
      toolName: call.name,
      arguments: args,
      text: textBlocks(blocks[0]?.content).join('\n'),
      ...(meta === undefined ? {} : { meta }),
    },
  }
}

function containsResourceArgument(
  value: unknown,
  candidates: readonly string[],
  origin: SourceCheckRequest['resource']['origin'],
): boolean {
  const object = asRecord(value)
  if (object === undefined) return false
  const keys = origin === 'mcp'
    ? ['uri', 'resourceUri', 'resource_uri']
    : ['file_path', 'path', 'uri']
  return keys.some(key => typeof object[key] === 'string' && candidates.includes(object[key]))
}

function fileArgumentCandidates(uri: string): string[] {
  try {
    const path = fileURLToPath(uri)
    return [uri, path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')]
  } catch {
    return [uri]
  }
}

function markdownFromReadMeta(
  meta: Record<string, unknown> | undefined,
  uri: string,
): { readonly markdown: string; readonly coverage: 'full' | 'segment' } | undefined {
  if (meta === undefined
    || typeof meta.path !== 'string'
    || !Number.isSafeInteger(meta.offset)
    || (meta.offset as number) < 1
    || !Number.isSafeInteger(meta.totalLines)
    || (meta.totalLines as number) < 0
    || !Array.isArray(meta.lines)) return undefined
  const expected = fileArgumentCandidates(uri).slice(1)
    .map(path => process.platform === 'win32' ? path.toLowerCase() : path)
  const actual = process.platform === 'win32' ? meta.path.toLowerCase() : meta.path
  if (!expected.includes(actual)) return undefined
  const offset = meta.offset as number
  const totalLines = meta.totalLines as number
  const lines: string[] = []
  let expectedNumber = offset
  for (const raw of meta.lines) {
    const line = asRecord(raw)
    if (line?.number !== expectedNumber || typeof line.text !== 'string') return undefined
    expectedNumber += 1
    lines.push(line.text)
  }
  const end = lines.length === 0 ? offset - 1 : expectedNumber - 1
  if (end > totalLines) return undefined
  return {
    markdown: lines.join('\n'),
    coverage: offset === 1 && end === totalLines ? 'full' : 'segment',
  }
}

function inspectionFailure(source: SourceCheckRequest, checkedAt: string, detail: string, status: 'failed' | 'unavailable'): SourceCheckResult {
  return {
    sourceId: source.sourceId,
    status,
    checkedAt,
    detail: detail + '. Original resource: ' + source.resource.uri + '; keep the Claim deferred',
  }
}

function validateInspectionReceipt(source: SourceCheckRequest, checkedAt: string, events: readonly unknown[]): SourceCheckResult | undefined {
  const representation = source.representation
  if (representation === null || representation.markdown === undefined || representation.inspectionCallId === undefined) return undefined
  const found = inspectionReceipt(events, representation.inspectionCallId)
  if (found.status === 'unavailable') return inspectionFailure(source, checkedAt, found.detail, 'unavailable')
  const receipt = found.receipt
  if (receipt.toolName !== representation.producedBy) {
    return inspectionFailure(source, checkedAt, 'representation producer does not match inspection tool ' + receipt.toolName, 'failed')
  }
  if (source.resource.origin === 'mcp') {
    const prefix = 'mcp__' + source.resource.sourceName + '__'
    if (!receipt.toolName.startsWith(prefix)) {
      return inspectionFailure(source, checkedAt, 'inspection tool is outside the named MCP source ' + source.resource.sourceName, 'failed')
    }
  }
  const candidates = source.resource.origin === 'local' || source.resource.origin === 'llm-wiki'
    ? fileArgumentCandidates(source.resource.uri)
    : [source.resource.uri]
  const readObservation = receipt.toolName === 'read'
    ? markdownFromReadMeta(receipt.meta, source.resource.uri)
    : undefined
  const observedMarkdown = receipt.toolName === 'read'
    ? readObservation?.markdown
    : receipt.text === representation.markdown ? representation.markdown : undefined
  if (receipt.toolName === 'read' && readObservation?.coverage !== representation.coverage) {
    return inspectionFailure(source, checkedAt, 'recorded Markdown coverage does not match the read result', 'failed')
  }
  if (receipt.toolName !== 'read' && representation.coverage !== 'unknown') {
    return inspectionFailure(source, checkedAt, 'this inspection tool cannot attest full-resource coverage', 'failed')
  }
  if (!containsResourceArgument(receipt.arguments, candidates, source.resource.origin)) {
    return inspectionFailure(source, checkedAt, 'inspection arguments do not identify this Original Resource', 'failed')
  }
  if (observedMarkdown !== representation.markdown) {
    return inspectionFailure(source, checkedAt, 'recorded Markdown does not match the successful inspection result', 'failed')
  }
  return undefined
}

function classifyMarkdownRepresentation(
  source: SourceCheckRequest,
  checkedAt: string,
  events: readonly unknown[],
): SourceCheckResult {
  const representation = source.representation
  const markdown = representation?.markdown
  if (representation === null || markdown === undefined) {
    const media = source.resource.mediaType === undefined ? 'unknown media type' : source.resource.mediaType
    const capability = source.resource.origin === 'mcp'
      ? 'the MCP capability was unavailable, returned unsupported content, or conversion failed'
      : 'the resource was unreadable, unsupported, or conversion failed'
    return {
      sourceId: source.sourceId,
      status: 'unavailable',
      checkedAt,
      detail: 'no normalized Markdown representation is available for the ' + source.resource.origin
        + ' resource (' + media + '): ' + capability + '. The original resource remains ' + source.resource.uri
        + '; keep the Claim deferred rather than treating the excerpt as verified',
    }
  }
  const expectedInspectionSha256 = sourceInspectionSha256(source.resource, representation)
  if (source.inspectionSha256 !== expectedInspectionSha256) {
    const receiptFailure = validateInspectionReceipt(source, checkedAt, events)
    if (receiptFailure !== undefined) return receiptFailure
  }
  const normalized = normalizedEvidence(markdown)
  const excerpt = normalizedEvidence(source.excerpt)
  if (normalized.length === 0) {
    return {
      sourceId: source.sourceId,
      status: 'unavailable',
      checkedAt,
      detail: 'the normalized Markdown representation is empty, so the excerpt at ' + source.locator
        + ' could be neither confirmed nor disproved; the original resource remains ' + source.resource.uri,
    }
  }
  if (!normalized.includes(excerpt)) {
    return {
      sourceId: source.sourceId,
      status: 'failed',
      checkedAt,
      detail: excerptMismatchDetail(normalized, excerpt, source.locator),
    }
  }
  return {
    sourceId: source.sourceId,
    status: 'reachable',
    checkedAt,
    detail: 'verified against the ' + representation.derivation + ' Markdown representation produced by '
      + representation.producedBy + '; original resource: ' + source.resource.uri,
  }
}

function sourceVerifier(
  ctx: Context,
  now: () => string,
  settings: () => RavenConfig,
): SourceVerifier {
  return {
    async verify(
      sources: readonly SourceCheckRequest[],
      signal: AbortSignal,
      execution?: RavenExecution,
    ): Promise<readonly SourceCheckResult[]> {
      const config = settings()
      const markdownResults = sources
        .filter(source => source.resource.origin !== 'web')
        .map(source => classifyMarkdownRepresentation(source, now(), execution?.inspectionEvents ?? []))
      const webSources = sources.filter(source => source.resource.origin === 'web')
      const unverifiable = (detail: string): readonly SourceCheckResult[] => {
        const checkedAt = now()
        return webSources.map(source => ({
          sourceId: source.sourceId,
          status: 'unavailable' as const,
          checkedAt,
          detail,
        }))
      }
      if ((config.sourceVerification ?? 'remote') === 'structural-only') {
        // Withholding the network is a deployment decision, so it reports the same
        // way an absent capability does: unverifiable evidence, never silent trust.
        return [...markdownResults, ...unverifiable(
          'remote Source verification is disabled for this deployment'
          + ' (raven-research.sourceVerification=structural-only)',
        )]
      }
      if (webSources.length === 0) return markdownResults
      const web = webHalf(ctx, 'fetch')
      if (web === undefined) return [...markdownResults, ...unverifiable(WEB_FETCH_ABSENT_DETAIL)]
      const timeoutMs = config.sourceCheckTimeoutMs ?? 0
      const passDeadline = Date.now() + VERIFICATION_PASS_BUDGET_MS
      const lastHostCheck = new Map<string, number>()
      const results: SourceCheckResult[] = []
      for (const source of webSources) {
        signal.throwIfAborted()
        const checkedAt = now()
        if (Date.now() >= passDeadline) {
          // The budget is Raven's own, so it says so rather than implying the origin failed.
          results.push({
            sourceId: source.sourceId,
            status: 'unavailable',
            checkedAt,
            detail: 'the ' + VERIFICATION_PASS_BUDGET_MS + 'ms verification pass budget was exhausted'
              + ' before this Source was checked; re-run the Checkpoint, or record fewer Sources per'
              + ' Checkpoint so one pass can reach all of them',
          })
          continue
        }
        // One deadline per Source: a slow origin costs that Source its verification,
        // not the whole Checkpoint. The pass budget caps their sum.
        const deadline = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
        const attempt = deadline === undefined ? signal : AbortSignal.any([signal, deadline])
        try {
          // Spread checks against ONE host so Raven does not manufacture the 429 it
          // would then have to classify. Registration guarantees the URL parses.
          const host = new URL(source.url).hostname.toLowerCase()
          const last = lastHostCheck.get(host)
          const wait = last === undefined ? 0 : HOST_THROTTLE_MS - (Date.now() - last)
          if (wait > 0) await sleep(Math.min(wait, HOST_THROTTLE_MS), attempt)
          lastHostCheck.set(host, Date.now())

          // ONE bounded retry, for transient conditions only. Checkpoint and
          // Completion both re-verify, so without it a flaky origin makes the SAME
          // unchanged Task complete or refuse depending on which attempt it landed
          // on. A 404, a 401, an excerpt mismatch, and a cancellation are never
          // retried: none of them can change on a second identical request, and a
          // retried mismatch is pure duplicated load on an origin that already
          // answered correctly.
          let fetched = await fetchSource(web, source.url, attempt, config.sourceNetworkPolicy)
          let retried = false
          if (httpStatusOutcome(fetched.statusCode)?.retryable === true
            && Date.now() + SOURCE_RETRY_BACKOFF_MS < passDeadline) {
            await sleep(SOURCE_RETRY_BACKOFF_MS, attempt)
            fetched = await fetchSource(web, source.url, attempt, config.sourceNetworkPolicy)
            retried = true
          }
          results.push(classifyFetched(source, fetched, checkedAt, retried))
        } catch (error) {
          signal.throwIfAborted()
          if (deadline?.aborted === true) {
            results.push({
              sourceId: source.sourceId,
              status: 'unavailable',
              checkedAt,
              detail: 'the Source check exceeded the configured ' + timeoutMs + 'ms deadline',
            })
            continue
          }
          // A thrown transient failure gets the same single bounded retry an
          // explicitly transient status does, for the same determinism reason.
          const recovered = retryableFetchError(error)
            && Date.now() + SOURCE_RETRY_BACKOFF_MS < passDeadline
            ? await sleep(SOURCE_RETRY_BACKOFF_MS, attempt)
              .then(async () => fetchSource(web, source.url, attempt, config.sourceNetworkPolicy))
              .then(fetched => classifyFetched(source, fetched, checkedAt, true))
              .catch(() => undefined)
            : undefined
          signal.throwIfAborted()
          if (recovered !== undefined) {
            results.push(recovered)
            continue
          }
          results.push({
            sourceId: source.sourceId,
            status: 'unavailable',
            checkedAt,
            detail: 'the retrieval did not complete, which is a transport condition rather than a'
              + ' statement about the excerpt: ' + compactError(error),
          })
        }
      }
      return [...markdownResults, ...results]
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
  if (value.variants !== undefined) lines.push(renderVariants(value.variants))
  if (value.relaidArtifact !== undefined) {
    lines.push(
      'The stored Artifact was re-laid to one sentence per line: '
      + `${value.relaidArtifact.sourceLines} line(s) in, ${value.relaidArtifact.laidOutLines} out. `
      + 'Edit the bytes below rather than what you submitted: Completion compares these exact bytes.',
    )
  }
  if (value.renderedArtifact !== undefined) lines.push(value.renderedArtifact)
  else if (value.state.latestArtifact !== null && value.status === 'stopped') {
    lines.push(renderArtifact(value.state.latestArtifact, value.state.sources, value.state.claims))
  }
  return lines.join('\n\n')
}

function fencedMarkdown(content: string): string {
  let longest = 0
  for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}markdown\n${content}\n${fence}`
}

function renderWorkspaceValue(value: RavenWorkspaceToolValue): string {
  const lines = [
    value.message,
    `Workspace action: ${value.action} | Status: ${value.status}`,
    'No files have been changed. Apply this conditional plan with ordinary Harness file tools, then re-read the final bytes.',
  ]
  if (value.issues.length > 0) {
    lines.push(`Issues:\n${value.issues.map(item => `- ${item.severity} ${item.code}${item.path === undefined ? '' : ` (${item.path})`}: ${item.detail}`).join('\n')}`)
  }
  for (const pageValue of value.pages) {
    const expected = value.preconditions.find(item => item.path === pageValue.path)?.expected
    lines.push(
      `Write \`${pageValue.path}\` only if its current state is still \`${expected ?? 'unknown; re-run raven_workspace'}\`:\n\n`
      + fencedMarkdown(pageValue.content),
    )
  }
  if (value.logEntry !== undefined) {
    lines.push(
      'Append to `wiki/log.md` only if its operation marker is absent (append only if its operation marker is absent):\n\n'
      + fencedMarkdown(value.logEntry),
    )
  }
  if (value.candidates !== undefined && value.candidates.length > 0) {
    lines.push([
      'Stored knowledge candidates (these are prior Workspace knowledge, not freshly verified evidence):',
      ...value.candidates.map(candidate => `- ${candidate.path} | ${candidate.type} | ${candidate.confidence}`
        + ` | ${candidate.freshness} | fresh verification required: ${candidate.requiresFreshVerification}`
        + `\n  ${candidate.summary}`),
    ].join('\n'))
  }
  if (value.health !== undefined) lines.push(`Health: ${value.health.status}`)
  return lines.join('\n\n')
}

const SOURCE_RESOURCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['origin', 'uri'],
  properties: {
    origin: { type: 'string', enum: ['web', 'local', 'llm-wiki', 'mcp'] },
    uri: { type: 'string', description: 'Absolute identity of the Original Resource.' },
    mediaType: { type: 'string', description: 'Original media type, bounded by Raven Source limits.' },
    sourceName: { type: 'string', description: 'Required named llm-wiki or MCP source; invalid for web/local.' },
  },
} as const

const SOURCE_REPRESENTATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['format', 'derivation', 'coverage', 'producedBy'],
  properties: {
    format: { type: 'string', enum: ['markdown'] },
    derivation: { type: 'string', enum: ['original', 'converted'] },
    coverage: { type: 'string', enum: ['full', 'segment', 'unknown'], description: 'Whether Markdown covers the resource, an exact segment, or an unprovable tool projection.' },
    producedBy: { type: 'string', description: 'Harness file/MCP/web tool or converter that produced this Markdown.' },
    inspectionCallId: { type: 'string', description: 'Prior successful ordinary Harness tool call that produced non-web Markdown.' },
    markdown: { type: 'string', description: 'Exact canonical Markdown. Required for non-web material.' },
  },
} as const

const SOURCE_POLICY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    allowedWebHosts: { type: 'array', items: { type: 'string' } },
    blockedWebHosts: { type: 'array', items: { type: 'string' } },
    preferPrimary: { type: 'boolean' },
    localRoots: { type: 'array', items: { type: 'string' } },
    llmWikiRoots: { type: 'array', items: { type: 'string' } },
    includedMcpSources: { type: 'array', items: { type: 'string' } },
    excludedMcpSources: { type: 'array', items: { type: 'string' } },
  },
} as const

const SOURCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceId', 'title', 'locator', 'excerpt'],
  oneOf: [
    {
      required: ['url'],
      not: { anyOf: [{ required: ['resource'] }, { required: ['representation'] }] },
    },
    { required: ['resource', 'representation'] },
  ],
  properties: {
    sourceId: { type: 'string', description: 'Stable Source ID, 1-64 safe identifier characters.' },
    url: { type: 'string', description: 'Legacy web URL or compatibility alias for resource.uri. Required only for legacy web input.' },
    resource: SOURCE_RESOURCE_SCHEMA,
    representation: {
      oneOf: [{ type: 'null' }, SOURCE_REPRESENTATION_SCHEMA],
      description: 'Canonical Markdown kept distinct from the Original Resource. Use null only when inspection/conversion failed.',
    },
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

const WORKSPACE_FILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'content'],
  properties: {
    path: { type: 'string', description: 'Slash-separated Markdown path below wiki/.' },
    content: { type: 'string', description: 'Exact current Markdown bytes inspected with ordinary Harness file tools.' },
  },
} as const

const WORKSPACE_RESOURCE_SCHEMA = {
  ...SOURCE_RESOURCE_SCHEMA,
  properties: {
    ...SOURCE_RESOURCE_SCHEMA.properties,
    origin: { type: 'string', enum: ['local', 'llm-wiki', 'mcp'] },
  },
} as const

const WORKSPACE_REPRESENTATION_SCHEMA = {
  ...SOURCE_REPRESENTATION_SCHEMA,
  required: ['format', 'derivation', 'coverage', 'producedBy', 'inspectionCallId', 'markdown'],
  properties: {
    ...SOURCE_REPRESENTATION_SCHEMA.properties,
    inspectionCallId: {
      type: 'string',
      description: 'Prior successful ordinary Harness tool call that produced these Markdown bytes; required for non-web material.',
    },
  },
} as const

const WORKSPACE_DOCUMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'resource', 'representation'],
  properties: {
    title: { type: 'string', description: 'Human-readable title for this adopted or ingested document.' },
    resource: WORKSPACE_RESOURCE_SCHEMA,
    representation: {
      oneOf: [{ type: 'null' }, WORKSPACE_REPRESENTATION_SCHEMA],
      description: 'Exact Source-layer Markdown normalization, or null when normalization failed.',
    },
    asOf: { type: 'string', description: 'Optional evidence currency label retained on the immutable raw page.' },
  },
} as const

function workspaceToolDefinition(
  ctx: Context,
  engine: ReturnType<typeof createRavenWorkspaceEngine>,
  books: Map<string, SessionTaskBook>,
): ToolDefinition {
  return {
    name: WORKSPACE_TOOL_NAME,
    description: 'Maintain a durable Markdown llm-wiki Workspace whose lifecycle is separate from Raven Task lifecycle. Initialize or adopt without overwriting existing knowledge; ingest Source-normalized documents; grow concept, entity, comparison, or query pages from a completed Task; rebuild derived indexes; report deterministic health issues; and retrieve stored lexical candidates without embeddings. The tool only returns conditional file writes. It never writes files itself.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: Object.keys(WORKSPACE_ACTION_FIELDS),
          description: `Workspace action. Each action accepts only its own fields — ${WORKSPACE_ACTION_FIELD_SUMMARY}.`,
        },
        files: {
          type: 'array',
          items: WORKSPACE_FILE_SCHEMA,
          description: 'Current Workspace Markdown snapshots for action=initialize, action=adopt, action=ingest, action=grow, action=maintain, action=health, or action=reuse. Supply files read with ordinary Harness tools; empty is valid for a new Workspace.',
        },
        kind: {
          type: 'string',
          enum: ['wiki', 'folder'],
          description: 'Whether action=adopt is adopting an existing llm-wiki or a regular document folder.',
        },
        documents: {
          type: 'array',
          items: WORKSPACE_DOCUMENT_SCHEMA,
          description: 'Non-web Source-layer normalized documents for action=adopt with kind=folder or action=ingest. Add web material through a completed Raven Task with action=grow; never invent another conversion pipeline.',
        },
        taskId: {
          type: 'string',
          description: 'Completed Raven Task to contribute with action=grow. The Task is read without changing its lifecycle or revision.',
        },
        pageType: {
          type: 'string',
          enum: WORKSPACE_PAGE_TYPES,
          description: 'Knowledge page type for action=grow.',
        },
        title: { type: 'string', description: 'Knowledge page title for action=grow.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'llm-wiki tags for action=grow; lowercase letters, digits, and hyphens.',
        },
        query: { type: 'string', description: 'Lexical knowledge query for action=reuse.' },
        freshness: {
          type: 'string',
          enum: ['durable', 'current'],
          description: 'Whether action=reuse is for durable background knowledge or a claim requiring current verification.',
        },
        maxAgeDays: { type: 'number', description: 'Age after which action=reuse labels stored knowledge stale.' },
        maxResults: { type: 'number', description: 'Maximum lexical candidates returned by action=reuse.' },
        complete: {
          type: 'boolean',
          description: 'Completeness attestation for action=health or action=maintain. May be true only after the agent inspected the complete Workspace Markdown snapshot with ordinary Harness tools.',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderWorkspaceValue(value as unknown as RavenWorkspaceToolValue) }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const membership = teamMembership(ctx, agent)
      const input = asRecord(args)
      let contribution: { readonly state: RavenTaskState; readonly renderedArtifact: string } | undefined
      if (input?.action === 'grow') {
        if (typeof input.taskId !== 'string') throw new Error('action=grow requires taskId')
        const book = taskBookFor(ctx, books, agent, membership)
        const state = book.tasks.get(input.taskId)
        if (state === undefined) throw new Error(`Raven Task ${input.taskId} is not available in this session`)
        if (state.latestArtifact === null) throw new Error(`Raven Task ${input.taskId} has no Artifact to contribute`)
        contribution = {
          state,
          renderedArtifact: renderArtifact(state.latestArtifact, state.sources, state.claims),
        }
      }
      const result = await engine.dispatch(args, {
        sessionId: membership?.id ?? agent.id,
        signal: exec.signal,
        inspectionEvents: agent.session.events,
      }, contribution)
      return { kind: 'raven-workspace-result', ...result } satisfies RavenWorkspaceToolValue
    },
  }
}

/**
 * Outcomes whose evidence floor defaults to `required` and cannot be switched off.
 * Mirrored here rather than imported because the engine owns the floor as Task
 * policy while this is a DEPLOYMENT precondition asked before a Task exists; the
 * check below re-reads the caller's own `grounding` argument, so a Task that
 * narrowed itself to `optional` is never blocked by it.
 */
const GROUNDING_REQUIRED_OUTCOMES = new Set(['research', 'academic-writing'])

/**
 * Why this `start` cannot succeed, or nothing.
 *
 * Refusal rather than a warning, argued: a warning at `start` is a line the agent
 * reads once and then spends an entire research budget past, and the refusal it
 * eventually hits arrives at Completion, phrased as a Source problem. Refusing here
 * costs one call and names the exact composition change; the deployment can still
 * run the same work as `general-writing`, or as `research` with `grounding=optional`,
 * both of which this check lets through. It fires ONLY where the floor is genuinely
 * unreachable, so a deployment that composes web normally never sees it.
 */
function groundedStartBlocker(
  ctx: Context,
  input: Record<string, unknown> | undefined,
): string | undefined {
  const outcome = input?.outcome
  if (typeof outcome !== 'string' || !GROUNDING_REQUIRED_OUTCOMES.has(outcome)) return undefined
  const grounding = input?.grounding
  // An explicitly narrowed floor is the deployment's own answer to this problem.
  if (typeof grounding === 'string' && grounding !== 'required') return undefined
  // `sourceVerification=structural-only` deliberately does NOT block here. It is a
  // deployment saying it cannot reach the network, and the recorded design answer is
  // that the Checkpoint is refused with the policy named — an honest degradation the
  // settings surface owns and tests. Refusing the Task outright would replace that
  // documented behaviour. A missing capability is not the same thing: nobody chose
  // it, and nothing downstream names it as a decision.
  const policy = asRecord(input?.sourcePolicy)
  const hasNonWebSource = ['localRoots', 'llmWikiRoots', 'includedMcpSources', 'excludedMcpSources']
    .some(key => Array.isArray(policy?.[key]) && policy[key].length > 0)
  if (hasNonWebSource) return undefined
  const advice = webCapabilityAdvice(webCapabilityState(ctx, 'fetch'), 'fetch')
  if (advice === undefined) return undefined
  return 'a ' + outcome + ' Raven Task cannot reach its evidence floor in this deployment: it needs at'
    + ' least one Source whose excerpt Raven re-fetched and matched, and ' + advice
    + '. Compose the capability and start again, or start this Task as general-writing, or pass'
    + ' grounding=optional if an unverifiable-Source outcome is genuinely acceptable for this work.'
}
function toolDefinition(
  ctx: Context,
  engine: ReturnType<typeof createRavenEngine>,
  books: Map<string, SessionTaskBook>,
  pendingLogState: Map<string, RavenTaskMeta>,
): ToolDefinition {
  return {
    name: TOOL_NAME,
    description: 'Maintain one progressive Raven Task across research, general writing, academic writing, or learning. Start once; discover Leads with a batch of complementary queries; draft candidate wording from several configured models at once; publish useful Checkpoints before exhaustive work; apply user corrections with steer on the same taskId; record inspected Sources, Claims, and partial failures; stop/resume without loss; and complete only against the exact final Artifact. The stored Artifact is Markdown laid out one sentence per line, so a LINE is the smallest edit unit and the returned bytes are the ones to edit next. Inside an Agent Team the Task belongs to the Team, so every member continues the same one. Normal research stages need no approval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'discover', 'draft', 'checkpoint', 'steer', 'complete', 'status', 'stop', 'resume', 'export'],
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
        instruction: {
          type: 'string',
          description: `What each model should write, at most ${RAVEN_LIMITS.draftInstructionChars} characters. Only with action=draft. Name one bounded piece — a section, a paragraph, an abstract — because variants are for comparing wording, not for outsourcing the whole Artifact.`,
        },
        routes: {
          type: 'array',
          items: { type: 'string' },
          description: `Which configured "provider/model" routes to draft from, at most ${RAVEN_LIMITS.draftRoutes}. Only with action=draft; omit to use every route the deployment configured. A route the deployment did not configure is refused, and the configured set is named in the refusal.`,
        },
        grounding: {
          type: 'string',
          enum: ['required', 'optional', 'none'],
          description: 'Evidence policy for this Task. Only with action=start; defaults from the outcome.',
        },
        sourcePolicy: {
          ...SOURCE_POLICY_SCHEMA,
          description: 'Task-level Source Policy patch. With action=start it sets sites, local folders, llm-wikis, MCP sources, and primary preference; with action=steer it updates the same Task.',
        },
        stage: {
          type: 'string',
          enum: ['discover', 'read', 'analyze', 'draft', 'verify', 'refine'],
          description: 'Stage this Checkpoint reports. Only with action=checkpoint.',
        },
        summary: { type: 'string', description: `Checkpoint summary, at most ${RAVEN_LIMITS.summaryChars} characters. Only with action=checkpoint; completion carries no summary of its own.` },
        artifact: { type: 'string', description: `Artifact bytes, at most ${RAVEN_LIMITS.artifactChars} characters. With action=checkpoint or action=complete; completion must carry the exact latest Checkpoint bytes.` },
        correction: { type: 'string', description: `Steering correction, at most ${RAVEN_LIMITS.correctionChars} characters. Only with action=steer.` },
        reason: { type: 'string', description: `Optional note for the stop call, at most ${RAVEN_LIMITS.limitationDetailChars} characters. It is validated but not retained in Task state. Only with action=stop.` },
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
      // The registry types a canonical tool value as lossless JSON, which is
      // exactly what it is on the wire; only this tool knows the shape it wrote,
      // so the two casts are the boundary, not a shortcut around it.
      render: (_args, value) => [{ type: 'text', text: renderToolValue(value as unknown as RavenToolValue) }],
      presentationMeta: (_args, value) => {
        const raven = value as unknown as RavenToolValue
        return (raven.durableState
          ? taskStateMeta(raven)
          : { kind: META_KIND, version: 2, currentTaskId: raven.currentTaskId }) as unknown as JsonValue
      },
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
      const membership = teamMembership(ctx, agent)
      const book = taskBookFor(ctx, books, agent, membership)
      const previousCurrentTaskId = book.currentTaskId
      const input = asRecord(args)
      const action = input?.action
      const requestedTaskId = typeof input?.taskId === 'string' ? input.taskId : undefined
      let previous: RavenTaskState | null
      if (action === 'start') {
        let active: RavenTaskState | undefined
        let latest: RavenTaskState | undefined
        for (const state of book.tasks.values()) {
          if (active === undefined && state.phase === 'active') active = state
          if (latest === undefined || state.ordinal > latest.ordinal) latest = state
        }
        previous = active ?? latest ?? null
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
      // The evidence floor is checked against the DEPLOYMENT before the Task exists.
      // A grounding-required Outcome restricted to web whose Sources can never be verified is not a Task
      // that degrades gracefully: every eligible Source reports unavailable, so the Checkpoint
      // is refused, then Completion is refused, and the floor cannot be lowered because
      // it belongs to the Outcome rather than to the executor. Discovering that after
      // the research is a total loss of the spend, so it is refused HERE, naming the
      // capability and how to compose it. Only a state the probe is certain about
      // refuses; 'unknown' proceeds, because a probe that guessed would refuse Tasks
      // that would have worked.
      if (action === 'start') {
        const blocker = groundedStartBlocker(ctx, input)
        if (blocker !== undefined) throw new Error(blocker)
      }
      const result = await engine.dispatch(previous, args, {
        // A Team shares one book and therefore one Task identity. Using the
        // calling member's Agent id here let two members racing `start` mint
        // different Task ids and bypass the book's first-write CAS guard.
        sessionId: membership?.id ?? agent.id,
        signal: exec.signal,
        inspectionEvents: agent.session.events,
      })
      // Compare-and-set, not last-writer-wins. `previous` was read BEFORE an
      // await-heavy verification pass, so inside an Agent Team two teammates
      // checkpointing concurrently both read revision N, both verify, and the second
      // write silently discarded the first one's Sources, Claims, and Checkpoint --
      // a lost contribution that looked exactly like a successful one. The losing
      // call fails instead, naming the action that recovers it: the Task itself is
      // untouched, so re-reading and resubmitting is always correct.
      const stored = book.tasks.get(result.state.taskId)
      const expected = previous?.taskId === result.state.taskId ? previous.revision : undefined
      if (expected === undefined && stored !== undefined) {
        // The FIRST write needs a guard of its own. `expected` is undefined exactly
        // when this call did not branch from a stored state — which is what `start`
        // does — so a revision comparison has nothing to compare and the write would
        // fall straight through. Two Team members racing to create the Team's Task
        // both produced revision 1 and the later `set` silently discarded the earlier
        // Task, which is the same lost contribution the comparison below exists to
        // prevent, one step earlier.
        throw new RavenError(
          'task-already-active',
          'Raven Task ' + result.state.taskId + ' already exists in this session at revision '
          + stored.revision + ': another Agent Team member created it while this call was running.'
          + ' Nothing was lost and nothing was written. Continue that Task with'
          + ' raven_task action=status taskId=' + result.state.taskId + ' instead of starting a replacement.',
        )
      }
      if (stored !== undefined && expected !== undefined && stored.revision !== expected) {
        throw new Error(
          'Raven Task ' + result.state.taskId + ' advanced to revision ' + stored.revision
          + ' while this call was verifying against revision ' + expected
          + ': another Agent Team member contributed to it first. Nothing was lost and nothing was'
          + ' written. Re-read the Task with raven_task action=status taskId=' + result.state.taskId
          + ' and resubmit this contribution against the current revision.',
        )
      }
      book.tasks.set(result.state.taskId, result.state)
      if (action !== 'status' || book.currentTaskId === undefined) book.currentTaskId = result.state.taskId
      const currentTaskId = book.currentTaskId ?? result.state.taskId
      book.currentTaskId = currentTaskId
      const withStatusArtifact = action === 'status'
        && result.renderedArtifact === undefined
        && result.state.latestArtifact !== null
        ? { ...result, renderedArtifact: renderArtifact(result.state.latestArtifact, result.state.sources, result.state.claims) }
        : result
      const durableState = previous === null
        || previous.taskId !== result.state.taskId
        || previous.revision !== result.state.revision
        || previousCurrentTaskId !== currentTaskId
      const value: RavenToolValue = {
        kind: 'raven-task-result',
        currentTaskId,
        durableState,
        ...withStatusArtifact,
      }
      // A direct call publishes its state through `presentationMeta` on the durable
      // tool result. A nested sub-call gets no result card, so its record is handed
      // to the durable-log waterfall keyed by this sub-call id; publishing on both
      // paths would store every Task twice.
      if (durableState && exec.parent !== undefined && typeof exec.callId === 'string') {
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

function guidanceContext(state: RavenTaskState | undefined): string {
  let relevant = 'During active work, a relevant hint may cover redirecting emphasis, adding or restricting sources, pausing without losing useful work, or preserving the result later.'
  if (state === undefined) {
    relevant = 'For a substantive research, writing, or learning request, begin naturally. A useful first hint may say that the user can redirect the work as it develops.'
  } else if (state.phase === 'stopped') {
    relevant = 'The current work is paused and preserved. If the user asks to continue, resume it internally; mention preservation only when that reassurance is useful.'
  } else if (state.phase === 'completed' || state.phase === 'completed-with-limits') {
    relevant = 'The current result is complete. Mention preservation only if the user asks to keep, reuse, or move the result beyond this session.'
  }
  return [
    '<raven_guidance>',
    'Contextual Raven guidance is on. Keep tool names, actions, task identifiers, phases, revisions, and protocol details internal.',
    'Offer at most one brief capability hint only when it directly helps with the current request; otherwise offer none.',
    'Never turn normal work into a tutorial or approval workflow. Do not repeat a capability the user has already used or acknowledged.',
    relevant,
    '</raven_guidance>',
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
    `Source Policy: ${JSON.stringify(state.sourcePolicy)}.`,
    latest === undefined
      ? 'No Checkpoint exists yet; publish the first useful Artifact early.'
      : `Latest Checkpoint ${latest.ordinal}: ${latest.stage} — ${latest.summary}`,
    state.phase === 'stopped'
      ? 'If the user asks to continue, call raven_task action=resume before steer or checkpoint.'
      : 'If the current user message corrects assumptions or emphasis, call raven_task action=steer before the next Checkpoint.',
    '</raven_task_context>',
  ].join('\n')
}

/**
 * Process-wide count of live Raven mounts, PER ROLE.
 *
 * `cordis.patch.yml` documents the double-mount hazard and cannot prevent it:
 * mounting the host bundle AND the preset row with the SAME role registers the same
 * surface twice. Two 'agent' (or 'both') mounts register `raven_task` into two
 * different layers with two independent Task books, so an agent's Checkpoint lands
 * in whichever copy the layered registry resolved and `action=status` may then
 * answer from the other one. That reads as a Task that lost its own Checkpoint. Two
 * 'host' (or 'both') mounts register the settings namespace twice, so which layer
 * answers a configuration read is equally arbitrary.
 *
 * A 'host' row PLUS an 'agent' row is the intended split shape and is not a
 * collision: they register disjoint surfaces, so only a repeated role is counted.
 * Nothing here can decide which mount is the intended one, so it warns rather than
 * throws — refusing the second mount would break a deployment merely reloading.
 */
const liveMounts: Record<RavenRole, number> = { host: 0, agent: 0, both: 0 }

/**
 * Log a deployment problem where an operator will see it, and never fail because of
 * logging. `ctx.logger` is an ordinary Harness service that a bare test context or a
 * reduced host need not provide, and a startup warning must not be the thing that
 * stops Raven from loading.
 */
function warnOperator(ctx: Context, message: string): void {
  try {
    const loggerService = (ctx as unknown as { logger?: unknown }).logger
    if (typeof loggerService !== 'function') return
    const logger = asRecord((loggerService as (label: string) => unknown)(name))
    const warn = logger?.warn
    if (typeof warn === 'function') (warn as (text: string) => void).call(logger, message)
  } catch {
    // A logger that throws is not a reason to fail a mount.
  }
}
export const name = 'raven-research'
export const inject = ['tools', 'systemPrompt'] as const

export function apply(ctx: Context, config: RavenConfig = {}): void {
  const now = () => new Date().toISOString()
  // Per-preset-mount state, and deliberately so: agent presets mount once under a
  // standing scope, then every joined session shares this plugin instance. `books`
  // therefore keys mutable state by Agent or Team identity, while pending PTC mode
  // records key by sub-call. Separate presets still get separate mount instances.
  const books = new Map<string, SessionTaskBook>()
  // The role is a MOUNT-TIME decision, so it is read from the composition entry and
  // never from `settings()`: a settings surface that could flip a mount's role at
  // runtime would register or unregister a tool underneath a running agent.
  const role: RavenRole = config.role ?? 'both'
  const isHost = role === 'host' || role === 'both'
  const isAgent = role === 'agent' || role === 'both'
  // The composition entry stays authoritative until a settings service attaches;
  // the wiring then points this thunk at the resolved scope, and points it back at
  // the entry if that service goes away. A Harness that serves no settings at all
  // never runs any of it.
  let settings: () => RavenConfig = () => config
  // Only the host plane registers the namespace. Mounted inside a preset instead, it
  // would be served exactly while a session using that preset is alive and vanish
  // between sessions, which is not a configuration surface an operator can edit.
  if (isHost) {
    installSettingsSection(
      ctx,
      RAVEN_SETTINGS_NAMESPACE,
      Config,
      config,
      {
        setSource: (current) => { settings = current },
        // Nothing is derived from the section: every Source check, discovery batch,
        // draft round, and Artifact layout reads the thunk, so a committed change
        // takes effect on the next call with nothing to re-judge.
        onChange: () => undefined,
      },
    )
  } else if (isAgent) {
    // A split host+agent deployment registers the namespace on the host mount but
    // executes raven_task from this preset mount. Read the host registration's RAW
    // user layer per call, then apply it over this mode's composition entry. Reading
    // the host's resolved value would lose key presence and would also replace a
    // mode-specific base with the host row's defaults.
    const entry = config
    settings = () => {
      try {
        const service = asRecord(ctx.get('settings'))
        const describe = service?.describe
        if (typeof describe !== 'function') return entry
        const rows = (describe as () => unknown).call(service)
        if (!Array.isArray(rows)) return entry
        const descriptor = rows
          .map(row => asRecord(row))
          .find(row => row?.ns === RAVEN_SETTINGS_NAMESPACE)
        const user = asRecord(descriptor?.user)
        if (user === undefined) return entry
        // `role` is mount-time and hidden from the card. A hand-written user value
        // must not turn one live mount into another role underneath the agent.
        return Config({ ...entry, ...user, role })
      } catch {
        // A missing, detaching, or structurally unfamiliar settings provider leaves
        // the preset entry authoritative, exactly as an uncomposed provider does.
        return entry
      }
    }
  }
  const searchLimits = (): RavenSearchLimits => {
    const config = settings()
    return {
      maxQueries: config.searchMaxQueries ?? RAVEN_LIMITS.searchQueries,
      maxResults: config.searchMaxResults ?? RAVEN_LIMITS.searchResults,
    }
  }
  // Skipped route specs already reported, so a settings thunk read on every draft
  // round does not repeat one warning per call. Keyed by the exact spec because the
  // operator has to be told WHICH entry was dropped.
  const reportedBadRoutes = new Set<string>()
  const draftLimits = (): RavenDraftLimits => {
    const config = settings()
    const routes: RavenDraftRoute[] = []
    const seen = new Set<string>()
    const skipped: string[] = []
    const dropped: string[] = []
    for (const spec of config.draftRoutes ?? []) {
      const route = parseDraftRoute(spec)
      // A malformed entry is skipped rather than thrown: settings are edited by
      // hand, and one typo must not take every other configured route down with it.
      // But a SILENT skip made an all-typo list indistinguishable from a deliberately
      // empty one -- the operator was told 'no Draft Variant route is configured' about
      // a list they could see in front of them. The skip stays; the silence does not.
      if (route === undefined) {
        skipped.push(spec)
        continue
      }
      const identity = `${route.provider}/${route.model}`
      if (seen.has(identity)) continue
      seen.add(identity)
      if (routes.length < RAVEN_LIMITS.draftRoutes) routes.push(route)
      else dropped.push(identity)
    }
    const unreported = [...skipped, ...dropped].filter(spec => !reportedBadRoutes.has(spec))
    if (unreported.length > 0) {
      for (const spec of unreported) reportedBadRoutes.add(spec)
      const unusable = skipped.filter(spec => unreported.includes(spec))
      const beyondBound = dropped.filter(spec => unreported.includes(spec))
      warnOperator(
        ctx,
        'Raven ignored ' + unreported.length + ' raven-research.draftRoutes entr'
        + (unreported.length === 1 ? 'y' : 'ies') + ': '
        + (unusable.length > 0
          ? unusable.map(spec => JSON.stringify(spec)).join(', ')
            + ' — each must be "provider/model", split on the FIRST slash, with a non-empty'
            + ' segment on each side. '
          : '')
        + (beyondBound.length > 0
          ? beyondBound.join(', ') + ' — beyond the ' + RAVEN_LIMITS.draftRoutes + '-route ceiling. '
          : '')
        + (routes.length === 0
          ? 'No usable route remains, so Draft Variants are OFF and raven_task action=draft will'
            + ' report that none is configured.'
          : routes.length + ' usable route(s) remain.'),
      )
    }
    return { maxTokens: config.draftMaxTokens ?? 0, routes }
  }
  const proseLayout = (): ProseLayoutOptions => {
    const config = settings()
    return {
      layout: config.proseLayout ?? 'sentence-per-line',
      format: config.proseFormat ?? 'markdown',
    }
  }
  const verifier = sourceVerifier(ctx, now, () => settings())
  const engine = createRavenEngine({
    now,
    sourceVerifier: verifier,
    sourceSearcher: sourceSearcher(ctx, () => settings()),
    searchLimits,
    draftGenerator: draftGenerator(ctx, () => settings()),
    draftLimits,
    proseLayout,
  })
  const workspaceEngine = createRavenWorkspaceEngine({ now, sourceVerifier: verifier })
  const pendingLogState = new Map<string, RavenTaskMeta>()

  // Probe the retrieval seam AT MOUNT, and say so loudly. Every grounded Raven Task
  // depends on re-fetching a Source, and the previous behaviour reported that
  // dependency for the first time as one unavailable Source per Checkpoint, after
  // the research had already been paid for. An operator reading the log at startup
  // can compose the provider before anyone spends a Task on it.
  //
  // Host-plane only. These are DEPLOYMENT warnings about a missing service, so they
  // belong once beside the configuration surface: emitted per agent-role mount they
  // would repeat the same operator advice for every agent scope composed.
  const fetchAdvice = isHost ? webCapabilityAdvice(webCapabilityState(ctx, 'fetch'), 'fetch') : undefined
  if (fetchAdvice !== undefined) {
    warnOperator(
      ctx,
      'Raven cannot verify web Sources in this deployment: ' + fetchAdvice
      + '. Until it is composed, web Sources report unavailable. A grounding-required Task without'
      + ' an explicit local, llm-wiki, or MCP Source Policy is refused before research spend; those'
      + ' non-web origins remain usable through their recorded Markdown representations.',
    )
  }
  const searchAdvice = isHost ? webCapabilityAdvice(webCapabilityState(ctx, 'search'), 'search') : undefined
  if (searchAdvice !== undefined) {
    // Discovery is optional by design, so this is information rather than a blocker.
    warnOperator(ctx, 'Raven Lead discovery is unavailable: ' + searchAdvice
      + '. raven_task action=discover will report this instead of returning Leads; the agent'
      + ' can still inspect Sources with its own tools.')
  }
  // See {@link liveMounts}: the documented double-mount hazard is otherwise silent.
  // Only a REPEATED role collides; a host row plus an agent row is the intended split.
  liveMounts[role] += 1
  if (liveMounts[role] > 1) {
    warnOperator(
      ctx,
      'Raven is mounted ' + liveMounts[role] + ' times with role "' + role + '" in this process.'
      + (isAgent
        ? ' The raven_task and raven_workspace tools are registered once per agent-role mount, into a different registry'
        + ' layer each time, and each mount keeps its OWN Task book -- a Checkpoint recorded through'
        + ' one mount is invisible to the other.'
        : '')
      + (isHost
        ? ' The raven-research settings namespace is registered once per host-role mount, so which'
        + ' registry layer answers a configuration read is arbitrary.'
        : '')
      + ' Mount the host bundle (cordis.patch.yml) OR the preset row'
      + ' (examples/agent-row.cordis.yml) for this role, never both. A "host" row and an "agent"'
      + ' row together are the intended split and do not collide.',
    )
  }
  // Released when the fiber unloads, so a reload does not accumulate a phantom
  // second mount. Read structurally and contained: `effect` is a Cordis lifetime
  // primitive this plugin's typed Context surface does not declare, and a missing
  // one costs an over-count in the warning, never a failed mount.
  try {
    const effect = asRecord(ctx)?.effect
    if (typeof effect === 'function') {
      (effect as (callback: () => () => void) => unknown).call(ctx, () => () => { liveMounts[role] -= 1 })
    }
  } catch {
    // A host without this primitive keeps the warning conservative, nothing more.
  }

  // Everything below is the AGENT half: both tools, the prompt that describes them, the
  // per-step Task context, and the PTC mode durability seam. A host-role mount
  // registers none of it, so a reduced host serves configuration without ever
  // putting Raven lifecycle tools in front of an agent.
  if (!isAgent) return
  ctx.systemPrompt.section({ name: 'tool:raven-task', order: RAVEN_PROMPT_ORDER, text: RAVEN_PROMPT })
  // Workspace lifecycle is deliberately a sibling tool. It reads completed Task contributions but never
  // mutates the Task book; Markdown on disk remains the Workspace's only durable state.
  ctx.tools.register(workspaceToolDefinition(ctx, workspaceEngine, books))
  ctx.tools.register(toolDefinition(ctx, engine, books, pendingLogState))
  // The durable half of the PTC mode path: attach the Task record to the logged
  // copy of Raven's own sub-dispatch. Total by contract — the bridge contains a
  // throwing listener by logging the original content, but a Task step must not
  // depend on that, so nothing here can fail.
  // The shared fields come from SessionEventMap; the exact target gate drives the
  // PtcDispatchLog waterfall so a runtime-only drift also fails before release.
  registerPtcDispatchLog(ctx, async (dispatch, next) => {
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
    const taskContext = state !== undefined && (state.phase === 'active' || state.phase === 'stopped')
      ? activeTaskContext(state, teamMembership(ctx, agent))
      : undefined
    const guidance = (settings().guidance ?? 'auto') === 'auto' ? guidanceContext(state) : undefined
    const context = [taskContext, guidance].filter((value): value is string => value !== undefined).join('\n')
    if (context.length === 0) return decision
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        // The factory mints the message identity the loop and the durable log
        // both key on; a hand-built literal silently omitted it.
        createUserMessage({
          content: [{ type: 'text', text: context }],
          source: { kind: 'plugin', plugin: name, form: 'instructions' },
        }),
      ],
    }
  })
}