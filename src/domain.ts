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
  sourceMediaTypeChars: 256,
  sourceNameChars: 512,
  sourceProducedByChars: 512,
  sourceInspectionCallIdChars: 512,
  sourceMarkdownChars: 40_000,
  sourcePolicyItems: 256,
  sourcePolicyStringChars: 4_000,
  claimTextChars: 10_000,
  insightTextChars: 10_000,
  insightRationaleChars: 4_000,
  insightWouldChangeMindChars: 4_000,
  insightAssumptionChars: 2_000,
  synthesisScopeChars: 2_000,
  limitationDetailChars: 4_000,
  sources: 256,
  claims: 512,
  insightCandidates: 256,
  insightAssumptions: 32,
  insightInspectionIds: 8,
  synthesisRounds: 64,
  structureRounds: 16,
  skeletonCandidates: 4,
  skeletonSections: 16,
  skeletonItems: 16,
  skeletonTextChars: 4_000,
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
  draftContextChars: 64_000,
  draftRounds: 32,
  draftVariantChars: 40_000,
  /** Maximum UTF-8 JSON size of one durable Task snapshot. */
  stateBytes: 1_000_000,
  /** Headroom non-final mutations leave so Completion cannot deadlock on the state cap. */
  stateCompletionReserveBytes: 64_000,
} as const

export const RAVEN_SCHEMA_VERSION = 4 as const

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

export const SOURCE_ORIGINS = ['web', 'local', 'llm-wiki', 'mcp'] as const

export type SourceOrigin = typeof SOURCE_ORIGINS[number]

export interface RavenSourceResource {
  readonly origin: SourceOrigin
  readonly uri: string
  readonly mediaType?: string
  readonly sourceName?: string
}

export interface RavenSourceRepresentation {
  readonly format: 'markdown'
  readonly derivation: 'original' | 'converted'
  /** Whether Markdown covers the whole Original Resource, an exact segment, or an unprovable tool projection. */
  readonly coverage: 'full' | 'segment' | 'unknown'
  readonly producedBy: string
  /** Harness tool call whose result supplied this Markdown. Required for non-web Sources. */
  readonly inspectionCallId?: string
  readonly markdown?: string
}

export const EMPTY_SOURCE_POLICY: RavenSourcePolicy = {
  allowedWebHosts: [],
  blockedWebHosts: [],
  preferPrimary: false,
  localRoots: [],
  llmWikiRoots: [],
  includedMcpSources: [],
  excludedMcpSources: [],
}

export interface RavenSourcePolicy {
  readonly allowedWebHosts: readonly string[]
  readonly blockedWebHosts: readonly string[]
  readonly preferPrimary: boolean
  readonly localRoots: readonly string[]
  readonly llmWikiRoots: readonly string[]
  readonly includedMcpSources: readonly string[]
  readonly excludedMcpSources: readonly string[]
}

export const CLAIM_KINDS = ['external', 'analysis'] as const

export type ClaimKind = typeof CLAIM_KINDS[number]

export const CLAIM_IMPORTANCE = ['material', 'context'] as const

export type ClaimImportance = typeof CLAIM_IMPORTANCE[number]

export const CLAIM_DISPOSITIONS = ['supported', 'qualified', 'deferred', 'rejected'] as const

export type ClaimDisposition = typeof CLAIM_DISPOSITIONS[number]

export const INSIGHT_KINDS = [
  'interpretation',
  'connection',
  'explanation',
  'hypothesis',
  'reframing',
  'implication',
  'thesis',
] as const

export type InsightKind = typeof INSIGHT_KINDS[number]

export const INSIGHT_PATTERNS = [
  'tension',
  'hidden-assumption',
  'alternative-causal-mechanism',
  'boundary-condition',
  'counterfactual',
  'second-order-effect',
  'incentive-mismatch',
  'temporal-shift',
  'scale-shift',
  'missing-variable',
  'cross-domain-analogy',
  'unexpected-connection',
  'other',
] as const

export type InsightPattern = typeof INSIGHT_PATTERNS[number]

export const INSIGHT_CONFIDENCE = ['low', 'medium', 'high'] as const

export type InsightConfidence = typeof INSIGHT_CONFIDENCE[number]

export const SYNTHESIS_PURPOSES = ['summary', 'explanation', 'synthesis'] as const

export type SynthesisPurpose = typeof SYNTHESIS_PURPOSES[number]

/** Whether this Task needs a collaborative, delegated, or deliberately skipped pre-writing structure decision. */
export const STRUCTURE_MODES = ['collaborative', 'autonomous', 'skip'] as const

export type StructureMode = typeof STRUCTURE_MODES[number]

export const SKELETON_RECOMMENDATION_KINDS = ['candidate', 'hybrid'] as const

export type SkeletonRecommendationKind = typeof SKELETON_RECOMMENDATION_KINDS[number]

export const SKELETON_SELECTION_ACTORS = ['user', 'raven'] as const

export type SkeletonSelectionActor = typeof SKELETON_SELECTION_ACTORS[number]

export const SUMMARY_DEBT_LEVELS = ['none', 'low', 'high'] as const

export type SummaryDebtLevel = typeof SUMMARY_DEBT_LEVELS[number]

export const LIMITATION_KINDS = ['source', 'tool', 'coverage'] as const

export type RavenLimitationKind = typeof LIMITATION_KINDS[number]

export interface RavenSourceRecord {
  readonly sourceId: string
  /** @deprecated Compatibility alias for resource.uri. */
  readonly url: string
  readonly resource: RavenSourceResource
  readonly representation: RavenSourceRepresentation | null
  /** Persisted after a trusted SourceVerifier attests this exact non-web representation. */
  readonly inspectionSha256?: string
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
  /** Original accepted state when Raven temporarily deferred this Claim after Source or premise verification failed. */
  readonly deferredFrom?: Extract<ClaimDisposition, 'supported' | 'qualified'>
  readonly sourceIds: readonly string[]
  /**
   * Codec-only residue for source-linked analysis Claims migrated from schema v1/v2.
   * These IDs preserve history but confer no direct Source authority and are never tool input.
   */
  readonly legacySourceIds?: readonly string[]
  /** Insight Candidate explicitly promoted into this accepted analysis Claim. Invalid for external Claims. */
  readonly insightId?: string
  /** Claim premises from which Raven derived this analysis. Invalid for external Claims. */
  readonly derivedFromClaimIds?: readonly string[]
  /** Assumptions carried from the promoted Insight Candidate. Invalid for external Claims. */
  readonly assumptions?: readonly string[]
  /** Claim IDs this Claim genuinely conflicts with; disagreement is preserved, never silently resolved. */
  readonly contradicts?: readonly string[]
}

/**
 * A candidate interpretation of recorded Claims, never evidence or accepted analysis by itself.
 *
 * Promotion is an explicit later Checkpoint contribution: an analysis Claim names this
 * Insight ID and repeats its exact Claim lineage and assumptions. Competing candidates
 * remain inspectable even when one is promoted.
 */
export interface RavenInsightCandidate {
  readonly insightId: string
  readonly text: string
  readonly kind: InsightKind
  readonly pattern: InsightPattern
  readonly claimIds: readonly string[]
  readonly assumptions: readonly string[]
  readonly rationale: string
  readonly wouldChangeMind: string
  readonly confidence: InsightConfidence
  readonly competesWith?: readonly string[]
  readonly createdAt: string
}

/** One explicit pass over a section or Artifact, including its deterministic summary-debt assessment. */
export interface RavenSynthesisRound {
  readonly ordinal: number
  readonly scope: string
  readonly purpose: SynthesisPurpose
  readonly claimIds: readonly string[]
  readonly insightIds: readonly string[]
  readonly summaryDebt: SummaryDebtLevel
  readonly summaryDebtDetail: string
  readonly createdAt: string
}

/** Candidate payload returned by action=synthesize; the same records also enter durable Task state. */
export interface RavenSynthesisResult {
  readonly round: RavenSynthesisRound
  readonly candidates: readonly RavenInsightCandidate[]
}

/** A challenge to one section of an argument, with the same reasoning links as the section it tests. */
export interface RavenSkeletonCounterargument {
  readonly text: string
  readonly claimIds: readonly string[]
  readonly insightIds: readonly string[]
}

/** One purposeful step in an argument rather than a heading-only outline entry. */
export interface RavenSkeletonSection {
  readonly sectionId: string
  readonly title: string
  readonly purpose: string
  readonly claimIds: readonly string[]
  readonly insightIds: readonly string[]
  readonly evidenceNeeds: readonly string[]
  readonly counterarguments: readonly RavenSkeletonCounterargument[]
}

/** The complete argument architecture later drafting must follow. */
export interface RavenArgumentSkeleton {
  readonly frame: string
  readonly thesis: string
  readonly centralQuestion: string
  readonly reasoningFlow: readonly string[]
  readonly sections: readonly RavenSkeletonSection[]
  readonly unresolvedWeaknesses: readonly string[]
  readonly readerTakeaway: string
}

/** One materially distinct candidate architecture considered by Structure Studio. */
export interface RavenSkeletonCandidate {
  readonly candidateId: string
  readonly label: string
  readonly skeleton: RavenArgumentSkeleton
}

/** Structured critique of one candidate; the user receives only a compact projection of this battle. */
export interface RavenSkeletonBattleEntry {
  readonly candidateId: string
  readonly explainsBetter: readonly string[]
  readonly failsToExplain: readonly string[]
  readonly conventionalWisdom: readonly string[]
  readonly evidenceRequired: readonly string[]
  readonly assumptions: readonly string[]
  readonly nonObviousInsights: readonly string[]
  readonly mergeableElements: readonly string[]
}

export type RavenSkeletonChoice =
  | { readonly kind: 'candidate'; readonly candidateIds: readonly [string] }
  | { readonly kind: 'hybrid'; readonly candidateIds: readonly string[] }

export type RavenSkeletonRecommendation = RavenSkeletonChoice & {
  readonly rationale: string
}

/** One candidate generation and critique round under a specific Steering Revision. */
export interface RavenStructureRound {
  readonly ordinal: number
  readonly steeringRevision: number
  readonly candidates: readonly RavenSkeletonCandidate[]
  readonly battle: readonly RavenSkeletonBattleEntry[]
  readonly recommendation: RavenSkeletonRecommendation
  readonly createdAt: string
}

/** The intentionally resolved architecture that constrains drafting. */
export type RavenSelectedSkeleton = RavenSkeletonChoice & {
  readonly chosenBy: SkeletonSelectionActor
  readonly skeleton: RavenArgumentSkeleton
  readonly rationale: string
  /** Task revision created by select-structure; later prose Checkpoints must record this exact revision. */
  readonly selectedAtRevision: number
  readonly steeringRevision: number
  readonly selectedAt: string
}

export interface RavenSteeringRevision {
  readonly revision: number
  readonly correction: string
  readonly createdAt: string
  readonly sourcePolicy?: RavenSourcePolicy
  readonly structureMode?: StructureMode
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
  /** Selected Skeleton Task revision this Artifact follows; absent on skip and pre-v4 records. */
  readonly selectedStructureRevision?: number
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
  readonly mode: 'remote' | 'source' | 'structural-only'
  readonly checked: number
  readonly reachable: number
  readonly failed: number
  readonly unavailable: number
  readonly artifactSha256: string
}

export type RavenTaskPhase = 'active' | 'stopped' | 'completed' | 'completed-with-limits'

export interface RavenTaskState {
  readonly schemaVersion: typeof RAVEN_SCHEMA_VERSION
  readonly taskId: string
  readonly ordinal: number
  readonly outcome: RavenOutcome
  readonly request: string
  readonly grounding: GroundingPolicy
  readonly sourcePolicy: RavenSourcePolicy
  readonly structureMode: StructureMode
  readonly phase: RavenTaskPhase
  readonly revision: number
  readonly steeringRevision: number
  readonly steering: readonly RavenSteeringRevision[]
  readonly checkpoints: readonly RavenCheckpointRecord[]
  readonly sources: readonly RavenSourceRecord[]
  readonly claims: readonly RavenClaimRecord[]
  readonly insightCandidates: readonly RavenInsightCandidate[]
  readonly syntheses: readonly RavenSynthesisRound[]
  readonly structureRounds: readonly RavenStructureRound[]
  readonly selectedSkeleton: RavenSelectedSkeleton | null
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
  readonly resource: RavenSourceResource
  readonly representation: RavenSourceRepresentation | null
  readonly inspectionSha256?: string
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
    execution?: RavenExecution,
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
  /** Current owning session events, used only to attest prior ordinary tool inspections. */
  readonly inspectionEvents?: readonly unknown[]
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

/** One bounded page of discovery data attached to status without rendering every durable Candidate. */
export interface RavenInsightRecall {
  readonly unpromotedInsightIds: readonly string[]
  readonly totalUnpromoted: number
  readonly insightOffset: number
  readonly nextInsightOffset: number | null
}

/** Exact selected Candidate records returned by the read-only inspect action. */
export interface RavenInsightInspection {
  readonly candidates: readonly RavenInsightCandidate[]
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
  readonly synthesis?: RavenSynthesisResult
  readonly studio?: RavenStructureRound
  readonly selection?: RavenSelectedSkeleton
  readonly recall?: RavenInsightRecall
  readonly inspection?: RavenInsightInspection
  /** Set when the Prose Layout rewrote the submitted Artifact bytes before storing them. */
  readonly relaidArtifact?: { readonly sourceLines: number; readonly laidOutLines: number }
}

