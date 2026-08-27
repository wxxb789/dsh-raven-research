import type { ProseLayout } from './prose.js'
import type { RavenDraftRoute } from './route.js'

export const RAVEN_LIMITS = {
  requestChars: 20_000,
  artifactChars: 100_000,
  summaryChars: 2_000,
  correctionChars: 20_000,
  sourceTitleChars: 1_000,
  sourceLocatorChars: 4_000,
  sourceExcerptChars: 20_000,
  sourceFamilyChars: 512,
  sourceAsOfChars: 128,
  claimTextChars: 10_000,
  limitationDetailChars: 4_000,
  sources: 256,
  claims: 512,
  limitations: 256,
  checkpoints: 128,
  steeringRevisions: 128,
  searchQueries: 4,
  searchResults: 8,
  searchQueryChars: 512,
  leads: 32,
  leadTitleChars: 512,
  leadSnippetChars: 512,
  leadNoteChars: 2_000,
  draftRoutes: 4,
  draftInstructionChars: 8_000,
  draftRounds: 32,
  draftVariantChars: 40_000,
  /** Maximum UTF-8 JSON size of one durable Task snapshot. */
  stateBytes: 1_000_000,
  /** Headroom non-final mutations leave so Completion cannot deadlock on the state cap. */
  stateCompletionReserveBytes: 64_000,
} as const

export const OUTCOMES = [
  'research',
  'general-writing',
  'academic-writing',
  'learning',
] as const

export type RavenOutcome = typeof OUTCOMES[number]

export const GROUNDING_POLICIES = ['required', 'optional', 'none'] as const

export type GroundingPolicy = typeof GROUNDING_POLICIES[number]

export const RAVEN_STAGES = ['discover', 'read', 'analyze', 'draft', 'verify', 'refine'] as const

export type RavenStage = typeof RAVEN_STAGES[number]

export const SOURCE_ROLES = ['primary', 'secondary', 'dataset', 'user-provided'] as const

export type SourceRole = typeof SOURCE_ROLES[number]

export const CLAIM_KINDS = ['external', 'analysis'] as const

export type ClaimKind = typeof CLAIM_KINDS[number]

export const CLAIM_IMPORTANCE = ['material', 'context'] as const

export type ClaimImportance = typeof CLAIM_IMPORTANCE[number]

export const CLAIM_DISPOSITIONS = ['supported', 'qualified', 'deferred', 'rejected'] as const

export type ClaimDisposition = typeof CLAIM_DISPOSITIONS[number]

export const LIMITATION_KINDS = ['source', 'tool', 'coverage'] as const

export type RavenLimitationKind = typeof LIMITATION_KINDS[number]

export interface RavenSourceRecord {
  readonly sourceId: string
  readonly url: string
  readonly title: string
  readonly locator: string
  readonly excerpt: string
  readonly role: SourceRole
  readonly sourceFamily?: string
  readonly asOf?: string
  readonly inspectedAt: string
  readonly check: RavenSourceCheck
}

export type RavenSourceCheck =
  | { readonly status: 'unchecked' }
  | {
      readonly status: 'reachable' | 'failed' | 'unavailable'
      readonly checkedAt: string
      readonly statusCode?: number
      readonly resolvedUrl?: string
      readonly detail?: string
    }

export interface RavenClaimRecord {
  readonly claimId: string
  readonly text: string
  readonly kind: ClaimKind
  readonly importance: ClaimImportance
  readonly disposition: ClaimDisposition
  readonly sourceIds: readonly string[]
  /** Claim IDs this Claim genuinely conflicts with; disagreement is preserved, never silently resolved. */
  readonly contradicts?: readonly string[]
}

export interface RavenSteeringRevision {
  readonly revision: number
  readonly correction: string
  readonly createdAt: string
}

export interface RavenLimitation {
  readonly limitationId: string
  readonly kind: RavenLimitationKind
  readonly detail: string
  readonly sourceId?: string
  readonly createdAt: string
}

export interface RavenCheckpointRecord {
  readonly checkpointId: string
  readonly ordinal: number
  readonly stage: RavenStage
  readonly summary: string
  readonly artifactSha256: string
  readonly artifactChars: number
  readonly steeringRevision: number
  readonly createdAt: string
  /**
   * The Prose Layout the stored bytes are in. Absent on a record written before
   * layouts existed, which is exactly `as-written`. Recorded because Completion
   * compares byte hashes: without it, a deployment that changes the layout
   * setting mid-Task produces a hash mismatch that reads as an unauthorized
   * final edit rather than as the reformat it is.
   */
  readonly proseLayout?: ProseLayout
}

export const DRAFT_STATUSES = ['drafted', 'failed'] as const

export type RavenDraftStatus = typeof DRAFT_STATUSES[number]

/** One model route asked for a Draft Variant. Identity is the pair, never the model alone. */
export type { RavenDraftRoute } from './route.js'

/**
 * One candidate rendering of the same writing task, produced by one route.
 *
 * A Draft Variant is a candidate, exactly as a Lead is a candidate: it carries
 * no evidence of its own, can never be cited, and joins the Task only when the
 * agent adopts its wording into a Checkpoint that Raven verifies against real
 * Sources. Comparing variants chooses phrasing; it never establishes a fact, and
 * a sentence that appears in every variant is still unsupported until a Source
 * excerpt supports it.
 */
export interface RavenDraftVariant {
  readonly route: RavenDraftRoute
  readonly status: RavenDraftStatus
  /** Present only for a drafted variant, already laid out under the Task's Prose Layout. */
  readonly text?: string
  /** Present only for a failed route; a dead model costs its own variant, never the round. */
  readonly detail?: string
}

export interface DraftRequest {
  readonly instruction: string
  readonly routes: readonly RavenDraftRoute[]
  readonly system: string
  /** Task material the drafter may use: the request, the steering, and the current Artifact. */
  readonly context: string
  readonly maxTokens: number
}

export interface DraftResult {
  readonly variants: readonly RavenDraftVariant[]
  /** Set when no route could run at all, so one reason replaces N identical failures. */
  readonly unavailable?: string
}

/** Retrieval seam for Draft Variants, kept separate from evidence seams on purpose. */
export interface DraftGenerator {
  generate(request: DraftRequest, signal: AbortSignal): Promise<DraftResult>
}

/**
 * Bounded provenance of one comparison round: which routes were consulted and
 * how each fared. The variant text is deliberately NOT retained — it is not
 * evidence, it is large, and keeping it would let unadopted wording ride the
 * Task's durable record as if it had been chosen.
 */
export interface RavenDraftRound {
  readonly ordinal: number
  readonly instruction: string
  readonly requestedAt: string
  readonly routes: readonly RavenDraftRouteOutcome[]
}

export interface RavenDraftRouteOutcome {
  readonly provider: string
  readonly model: string
  readonly status: RavenDraftStatus
  readonly chars: number
}

export interface RavenVerificationReceipt {
  readonly verifiedAt: string
  readonly mode: 'remote' | 'structural-only'
  readonly checked: number
  readonly reachable: number
  readonly failed: number
  readonly unavailable: number
  readonly artifactSha256: string
}

export type RavenTaskPhase = 'active' | 'stopped' | 'completed' | 'completed-with-limits'

export interface RavenTaskState {
  readonly schemaVersion: 1
  readonly taskId: string
  readonly ordinal: number
  readonly outcome: RavenOutcome
  readonly request: string
  readonly grounding: GroundingPolicy
  readonly phase: RavenTaskPhase
  readonly revision: number
  readonly steeringRevision: number
  readonly steering: readonly RavenSteeringRevision[]
  readonly checkpoints: readonly RavenCheckpointRecord[]
  readonly sources: readonly RavenSourceRecord[]
  readonly claims: readonly RavenClaimRecord[]
  readonly limitations: readonly RavenLimitation[]
  readonly latestArtifact: string | null
  /** Draft comparison rounds, oldest first. Absent on a record written before Draft Variants existed. */
  readonly drafts?: readonly RavenDraftRound[]
  readonly verification: RavenVerificationReceipt | null
  readonly finalArtifactSha256: string | null
  readonly startedAt: string
  readonly updatedAt: string
}

export interface SourceCheckRequest {
  readonly sourceId: string
  readonly url: string
  readonly locator: string
  readonly excerpt: string
}

export interface SourceCheckResult {
  readonly sourceId: string
  readonly status: 'reachable' | 'failed' | 'unavailable'
  readonly checkedAt: string
  readonly statusCode?: number
  readonly resolvedUrl?: string
  readonly detail?: string
}

/**
 * One candidate Raven has NOT inspected. Discovery returns Leads, never Sources:
 * a search hit is only a lead until the agent opens it and records a verbatim
 * excerpt, so a Lead can never carry a Claim or reach an Artifact citation.
 */
export interface RavenLead {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
  /** Queries that surfaced this Lead, in issue order; repetition across queries is a breadth signal, never corroboration. */
  readonly queries: readonly string[]
}

export interface LeadSearchRequest {
  /** Distinct, already-bounded queries to issue in one batch. */
  readonly queries: readonly string[]
  /** Upper bound the backend is asked for per query. */
  readonly maxResults: number
}

/** One query that could not be answered. The batch survives it; the Task records it. */
export interface LeadSearchFailure {
  readonly query: string
  readonly detail: string
}

export interface LeadSearchResult {
  readonly leads: readonly RavenLead[]
  readonly failures: readonly LeadSearchFailure[]
  /** True when either a backend or Raven's own merge dropped candidates. */
  readonly truncated: boolean
  /** Provider-generated answer text per query, when the backend returns any. Context only: never evidence. */
  readonly notes: readonly { readonly query: string; readonly content: string }[]
  /** Set when discovery could not run at all — absent capability or deployment policy — so every query shares one reason. */
  readonly unavailable?: string
}

/** Retrieval seam for Lead discovery. Kept separate from {@link SourceVerifier}: finding candidates and confirming evidence are different authorities. */
export interface SourceSearcher {
  search(request: LeadSearchRequest, signal: AbortSignal): Promise<LeadSearchResult>
}

export interface SourceVerifier {
  verify(
    sources: readonly SourceCheckRequest[],
    signal: AbortSignal,
  ): Promise<readonly SourceCheckResult[]>
}

/**
 * Stable, machine-readable classification of an engine failure.
 *
 * Errors used to be prose only, so a caller could not tell "you sent a malformed
 * action" (terminal — resending the same bytes fails again) from "the verifier
 * could not be reached" (retryable). Both read as one sentence and both were
 * retried, or neither was. The code/category ride ALONGSIDE the human sentence
 * rather than replacing it: `error.message` is unchanged, so plugin.ts and any
 * other existing consumer needs no change at all.
 */
export const RAVEN_ERROR_CATEGORIES = ['invalid-request', 'not-found', 'conflict', 'capacity', 'unavailable'] as const

export type RavenErrorCategory = typeof RAVEN_ERROR_CATEGORIES[number]

export const RAVEN_ERROR_CODES = [
  'unsupported-action',
  'unknown-field',
  'invalid-value',
  'invalid-enum',
  'task-not-found',
  'task-phase',
  'task-already-active',
  'evidence-conflict',
  'limit-exceeded',
  'verifier-protocol',
] as const

export type RavenErrorCode = typeof RAVEN_ERROR_CODES[number]

/**
 * Which categories a caller may usefully retry unchanged. `unavailable` is the
 * only one: everything else is a property of the request or of the Task state,
 * so retrying the identical call reproduces the identical failure.
 */
export function isRetryableRavenError(category: RavenErrorCategory): boolean {
  return category === 'unavailable'
}

const CATEGORY_BY_CODE: Record<RavenErrorCode, RavenErrorCategory> = {
  'unsupported-action': 'invalid-request',
  'unknown-field': 'invalid-request',
  'invalid-value': 'invalid-request',
  'invalid-enum': 'invalid-request',
  'task-not-found': 'not-found',
  'task-phase': 'conflict',
  'task-already-active': 'conflict',
  'evidence-conflict': 'conflict',
  'limit-exceeded': 'capacity',
  'verifier-protocol': 'unavailable',
}

/** An engine failure carrying its classification. The message stays the human sentence. */
export class RavenError extends Error {
  override readonly name = 'RavenError'
  readonly code: RavenErrorCode
  readonly category: RavenErrorCategory
  readonly retryable: boolean

  constructor(code: RavenErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.category = CATEGORY_BY_CODE[code]
    this.retryable = isRetryableRavenError(this.category)
  }
}

/**
 * A malformed-input failure. Still a `TypeError` by prototype so every existing
 * `rejects.toThrow(TypeError)` assertion and every `instanceof TypeError` guard
 * keeps working; the classification is additive on top.
 */
export class RavenTypeError extends TypeError {
  override readonly name = 'RavenTypeError'
  readonly code: RavenErrorCode
  readonly category: RavenErrorCategory
  readonly retryable: boolean

  constructor(code: RavenErrorCode, message: string) {
    super(message)
    this.code = code
    this.category = CATEGORY_BY_CODE[code]
    this.retryable = isRetryableRavenError(this.category)
  }
}

export interface RavenExecution {
  readonly sessionId: string
  readonly signal: AbortSignal
}

/** One llm-wiki file Raven renders for the agent to write. */
export interface RavenWikiPage {
  readonly path: string
  readonly content: string
}

/** Pages to write plus one entry to append; `log.md` is append-only, so it is never a page here. */
export interface RavenWikiEmission {
  readonly pages: readonly RavenWikiPage[]
  readonly logEntry: string
}

export interface RavenDispatchResult {
  readonly status: 'active' | 'needs-revision' | 'stopped' | 'completed' | 'completed-with-limits'
  readonly state: RavenTaskState
  readonly message: string
  readonly issues: readonly string[]
  readonly renderedArtifact?: string
  readonly wiki?: RavenWikiEmission
  readonly leads?: LeadSearchResult
  readonly variants?: DraftResult
  /** Set when the Prose Layout rewrote the submitted Artifact bytes before storing them. */
  readonly relaidArtifact?: { readonly sourceLines: number; readonly laidOutLines: number }
}

