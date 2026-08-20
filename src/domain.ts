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
}

