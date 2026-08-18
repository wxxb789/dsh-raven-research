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
}

