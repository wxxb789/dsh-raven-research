import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import {
  analysisLineageCycle,
  propagateAnalysisPremiseDispositions,
  semanticTextFold,
  semanticTextSimilarity,
  skeletonSemanticText,
} from './analysis.js'
import { canonicalSourceUrl, sameSourceIdentity } from './url.js'
import { PROSE_LAYOUTS } from './prose.js'
import { sourceInspectionSha256 } from './source.js'

import {
  CLAIM_DISPOSITIONS,
  CLAIM_IMPORTANCE,
  CLAIM_KINDS,
  DRAFT_PATHS,
  DRAFT_RECOMMENDATIONS,
  DRAFT_STATUSES,
  GROUNDING_POLICIES,
  INSIGHT_CONFIDENCE,
  INSIGHT_KINDS,
  INSIGHT_PATTERNS,
  LIMITATION_KINDS,
  OUTCOMES,
  EMPTY_SOURCE_POLICY,
  RAVEN_LIMITS,
  RAVEN_SCHEMA_VERSION,
  RAVEN_STAGES,
  SKELETON_RECOMMENDATION_KINDS,
  SKELETON_SELECTION_ACTORS,
  SOURCE_ORIGINS,
  SOURCE_ROLES,
  STRUCTURE_MODES,
  SUMMARY_DEBT_LEVELS,
  SYNTHESIS_PURPOSES,
  type RavenArgumentSkeleton,
  type RavenClaimRecord,
  type RavenInsightCandidate,
  type RavenSourceCheck,
  type RavenSourcePolicy,
  type RavenSourceRepresentation,
  type RavenSourceResource,
  type RavenTaskState,
} from './domain.js'

const PHASES = ['active', 'stopped', 'completed', 'completed-with-limits'] as const
const CHECK_STATUSES = ['reachable', 'failed', 'unavailable'] as const
const VERIFICATION_MODES = ['remote', 'source', 'structural-only'] as const
const SHA256 = /^sha256:[a-f0-9]{64}$/
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function string(value: unknown, nonEmpty = true): value is string {
  return typeof value === 'string' && (!nonEmpty || value.trim().length > 0)
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function timestamp(value: unknown): value is string {
  return string(value) && Number.isFinite(Date.parse(value))
}

function validUrl(value: unknown): value is string {
  if (!string(value)) return false
  try {
    canonicalSourceUrl(value)
    return true
  } catch {
    return false
  }
}

function uniqueStrings(value: unknown, valid: (item: string) => boolean = () => true): value is string[] {
  return Array.isArray(value)
    && value.every(item => string(item) && valid(item))
    && new Set(value).size === value.length
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index])
}

function jsonWithinBudget(value: unknown, maximum: number): boolean {
  const stack: unknown[] = [value]
  let bytes = 0
  const add = (count: number) => {
    bytes += count
    return bytes <= maximum
  }
  while (stack.length > 0) {
    const item = stack.pop()
    if (item === null || item === undefined || typeof item === 'function' || typeof item === 'symbol') {
      if (!add(4)) return false
      continue
    }
    if (typeof item === 'string') {
      if (!add(Buffer.byteLength(JSON.stringify(item), 'utf8'))) return false
      continue
    }
    if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'bigint') {
      let encoded: string
      try {
        encoded = JSON.stringify(item) ?? 'null'
      } catch {
        return false
      }
      if (!add(Buffer.byteLength(encoded, 'utf8'))) return false
      continue
    }
    if (typeof item !== 'object') return false
    if (Array.isArray(item)) {
      if (!add(2 + Math.max(0, item.length - 1))) return false
      for (const child of item) stack.push(child)
      continue
    }
    const entries = Object.entries(item)
    if (!add(2 + Math.max(0, entries.length - 1))) return false
    for (const [key, child] of entries) {
      if (!add(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1)) return false
      stack.push(child)
    }
  }
  return true
}

function validStructureTextList(value: unknown, allowEmpty = false): value is string[] {
  return Array.isArray(value)
    && value.length <= RAVEN_LIMITS.skeletonItems
    && (allowEmpty || value.length > 0)
    && uniqueStrings(value, item => item.length <= RAVEN_LIMITS.skeletonTextChars)
}

function validStructureIds(value: unknown, known: Pick<ReadonlySet<string>, 'has'>): value is string[] {
  return Array.isArray(value)
    && value.length <= RAVEN_LIMITS.skeletonItems
    && uniqueStrings(value, id => STABLE_ID.test(id) && known.has(id))
}

function validArgumentSkeleton(
  value: unknown,
  claimIds: Pick<ReadonlySet<string>, 'has'>,
  insightIds: Pick<ReadonlySet<string>, 'has'>,
): boolean {
  const skeleton = record(value)
  if (skeleton === undefined
    || !exactKeys(skeleton, [
      'frame', 'thesis', 'centralQuestion', 'reasoningFlow', 'sections',
      'unresolvedWeaknesses', 'readerTakeaway',
    ])
    || !string(skeleton.frame)
    || skeleton.frame.length > RAVEN_LIMITS.skeletonTextChars
    || !string(skeleton.thesis)
    || skeleton.thesis.length > RAVEN_LIMITS.skeletonTextChars
    || !string(skeleton.centralQuestion)
    || skeleton.centralQuestion.length > RAVEN_LIMITS.skeletonTextChars
    || !validStructureTextList(skeleton.reasoningFlow)
    || !Array.isArray(skeleton.sections)
    || skeleton.sections.length === 0
    || skeleton.sections.length > RAVEN_LIMITS.skeletonSections
    || !validStructureTextList(skeleton.unresolvedWeaknesses, true)
    || !string(skeleton.readerTakeaway)
    || skeleton.readerTakeaway.length > RAVEN_LIMITS.skeletonTextChars) return false
  const sectionIds = new Set<string>()
  let hasReasoningLink = false
  for (const raw of skeleton.sections) {
    const section = record(raw)
    if (section === undefined
      || !exactKeys(section, [
        'sectionId', 'title', 'purpose', 'claimIds', 'insightIds', 'evidenceNeeds', 'counterarguments',
      ])
      || !string(section.sectionId)
      || !STABLE_ID.test(section.sectionId)
      || sectionIds.has(section.sectionId)
      || !string(section.title)
      || section.title.length > RAVEN_LIMITS.skeletonTextChars
      || !string(section.purpose)
      || section.purpose.length > RAVEN_LIMITS.skeletonTextChars
      || !validStructureIds(section.claimIds, claimIds)
      || !validStructureIds(section.insightIds, insightIds)
      || !validStructureTextList(section.evidenceNeeds, true)
      || !Array.isArray(section.counterarguments)
      || section.counterarguments.length > RAVEN_LIMITS.skeletonItems) return false
    sectionIds.add(section.sectionId)
    hasReasoningLink ||= section.claimIds.length > 0 || section.insightIds.length > 0
    for (const rawCounter of section.counterarguments) {
      const counter = record(rawCounter)
      if (counter === undefined
        || !exactKeys(counter, ['text', 'claimIds', 'insightIds'])
        || !string(counter.text)
        || counter.text.length > RAVEN_LIMITS.skeletonTextChars
        || !validStructureIds(counter.claimIds, claimIds)
        || !validStructureIds(counter.insightIds, insightIds)) return false
      hasReasoningLink ||= counter.claimIds.length > 0 || counter.insightIds.length > 0
    }
  }
  return hasReasoningLink
}

function validUri(value: unknown, origin: string): value is string {
  if (!string(value) || value.length > RAVEN_LIMITS.sourceLocatorChars) return false
  if (origin === 'web') return validUrl(value)
  try {
    const parsed = new URL(value)
    const schemeMatches = origin === 'local'
      ? parsed.protocol === 'file:'
      : origin === 'llm-wiki'
        ? parsed.protocol === 'file:' || parsed.protocol === 'llm-wiki:'
        : origin === 'mcp' && parsed.protocol === 'mcp:'
    return parsed.username === '' && parsed.password === '' && parsed.href === value && schemeMatches
  } catch {
    return false
  }
}

function validPolicyHost(value: string): boolean {
  if (value !== value.trim() || value !== value.toLowerCase()) return false
  try {
    const parsed = new URL(`https://${value}`)
    return parsed.hostname === value && parsed.port === '' && parsed.pathname === '/' && parsed.search === '' && parsed.hash === ''
  } catch {
    return false
  }
}

function validPolicyRoot(value: string, origin: 'local' | 'llm-wiki'): boolean {
  if (value !== value.trim() || !validUri(value, origin)) return false
  return new URL(value).href === value
}

function validPolicy(value: unknown): value is RavenSourcePolicy {
  const policy = record(value)
  if (policy === undefined || !exactKeys(policy, [
    'allowedWebHosts', 'blockedWebHosts', 'preferPrimary', 'localRoots', 'llmWikiRoots',
    'includedMcpSources', 'excludedMcpSources',
  ]) || typeof policy.preferPrimary !== 'boolean') return false
  const lists = ['allowedWebHosts', 'blockedWebHosts', 'localRoots', 'llmWikiRoots', 'includedMcpSources', 'excludedMcpSources'] as const
  for (const key of lists) {
    if (!uniqueStrings(policy[key], item => item.length <= RAVEN_LIMITS.sourcePolicyStringChars)
      || policy[key].length > RAVEN_LIMITS.sourcePolicyItems) return false
  }
  const typed = policy as unknown as RavenSourcePolicy
  if (typed.allowedWebHosts.some(host => !validPolicyHost(host))
    || typed.blockedWebHosts.some(host => !validPolicyHost(host))
    || typed.localRoots.some(root => !validPolicyRoot(root, 'local'))
    || typed.llmWikiRoots.some(root => !validPolicyRoot(root, 'llm-wiki'))
    || typed.includedMcpSources.some(name => name !== name.trim())
    || typed.excludedMcpSources.some(name => name !== name.trim())) return false
  const overlaps = (left: readonly string[], right: readonly string[]) => left.some(item => right.includes(item))
  return !overlaps(typed.allowedWebHosts, typed.blockedWebHosts)
    && !overlaps(typed.includedMcpSources, typed.excludedMcpSources)
}

function validRepresentation(value: unknown, resourceValue: unknown): boolean {
  const resource = record(resourceValue)
  if (resource === undefined || !member(resource.origin, SOURCE_ORIGINS)) return false
  if (value === null) return resource.origin !== 'web'
  const representation = record(value)
  if (representation === undefined
    || !exactKeys(representation, ['format', 'derivation', 'coverage', 'producedBy', 'inspectionCallId', 'markdown'])
    || representation.format !== 'markdown'
    || !member(representation.derivation, ['original', 'converted'] as const)
    || !member(representation.coverage, ['full', 'segment', 'unknown'] as const)
    || !string(representation.producedBy)
    || representation.producedBy.length > RAVEN_LIMITS.sourceProducedByChars
    || (representation.inspectionCallId !== undefined
      && (!string(representation.inspectionCallId) || representation.inspectionCallId.length > RAVEN_LIMITS.sourceInspectionCallIdChars))
    || (representation.markdown !== undefined
      && (!string(representation.markdown, false) || representation.markdown.length > RAVEN_LIMITS.sourceMarkdownChars))
    || (resource.origin !== 'web' && (representation.markdown === undefined || representation.inspectionCallId === undefined))
    || (resource.origin === 'web' && (representation.inspectionCallId !== undefined || representation.coverage !== 'unknown'))) return false
  const mediaType = typeof resource.mediaType === 'string'
    ? resource.mediaType.split(';', 1)[0]?.trim().toLowerCase()
    : undefined
  return representation.derivation !== 'original' || mediaType === 'text/markdown'
}

function validDraftRoute(value: unknown): value is { readonly provider: string; readonly model: string } {
  const route = record(value)
  return route !== undefined
    && exactKeys(route, ['provider', 'model'])
    && string(route.provider)
    && string(route.model)
}

function validCheck(value: unknown, sourceUrl: string, origin: string): value is RavenSourceCheck {
  const check = record(value)
  if (check === undefined || !string(check.status)) return false
  if (check.status === 'unchecked') return exactKeys(check, ['status']) && Object.keys(check).length === 1
  if (!exactKeys(check, ['status', 'checkedAt', 'statusCode', 'resolvedUrl', 'detail'])) return false
  if (!member(check.status, CHECK_STATUSES) || !timestamp(check.checkedAt)) return false
  if (check.statusCode !== undefined && (!integer(check.statusCode, 100) || check.statusCode > 599)) return false
  if (check.resolvedUrl !== undefined && !validUrl(check.resolvedUrl)) return false
  if (check.detail !== undefined && !string(check.detail)) return false
  if (check.status === 'reachable' && origin === 'web') {
    if (!integer(check.statusCode, 200)
      || check.statusCode >= 400
      || !validUrl(check.resolvedUrl)
      || !sameSourceIdentity(sourceUrl, check.resolvedUrl)) return false
  }
  if (origin !== 'web' && (check.statusCode !== undefined || check.resolvedUrl !== undefined)) return false
  if (check.status === 'failed' && origin === 'web'
    && (!integer(check.statusCode, 100) || !validUrl(check.resolvedUrl) || !string(check.detail))) return false
  if (check.status === 'failed' && origin !== 'web' && !string(check.detail)) return false
  if (check.status === 'unavailable' && !string(check.detail)) return false
  return true
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

/** The schema version this build writes. Older versions are migrated forward. */
export { RAVEN_SCHEMA_VERSION } from './domain.js'

function v3ToV4CompatibilityFields() {
  return {
    structureMode: 'skip',
    structureRounds: [],
    selectedSkeleton: null,
  } as const
}

// A non-empty v3 root keeps its closing brace and gains one comma plus the
// compatibility object interior, so its exact additive JSON cost is size - 1.
const V3_TO_V4_MIGRATION_OVERHEAD_BYTES = Buffer.byteLength(
  JSON.stringify(v3ToV4CompatibilityFields()),
  'utf8',
) - 1

/**
 * Forward migrations, keyed by the version being migrated FROM.
 *
 * The decoder used to reject any `schemaVersion` but 1 outright, so the first
 * bump would have silently dropped every stored Task on replay — a data-loss
 * path with no code path to fix it in. The table carries the v1 web-to-v2 Source
 * fabric migration, isolates legacy v1/v2 analysis Source links during the
 * v2-to-v3 synthesis migration, places v3 Tasks on the v4 lightweight Structure
 * Studio compatibility path, and admits v5 draft-refinement provenance; future
 * bumps add one entry per forward step.
 */
const MIGRATIONS: Record<number, (state: Record<string, unknown>) => Record<string, unknown> | undefined> = {
  1: state => {
    if (!Array.isArray(state.sources)) return undefined
    const sources = state.sources.map(raw => {
      const source = record(raw)
      if (source === undefined || !string(source.url)) return raw
      let url: string
      try {
        url = canonicalSourceUrl(source.url)
      } catch {
        return raw
      }
      return {
        ...source,
        url,
        resource: { origin: 'web', uri: url },
        representation: { format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'web_fetch' },
      }
    })
    return { ...state, schemaVersion: 2, sourcePolicy: EMPTY_SOURCE_POLICY, sources }
  },
  2: state => {
    if (!Array.isArray(state.claims)) return undefined
    const claims = state.claims.map((raw) => {
      const claim = record(raw)
      if (claim === undefined
        || claim.kind !== 'analysis'
        || !Array.isArray(claim.sourceIds)
        || claim.sourceIds.length === 0) return raw
      return { ...claim, sourceIds: [], legacySourceIds: claim.sourceIds }
    })
    return { ...state, schemaVersion: 3, claims, insightCandidates: [], syntheses: [] }
  },
  3: state => ({
    ...state,
    schemaVersion: 4,
    ...v3ToV4CompatibilityFields(),
  }),
  4: state => ({ ...state, schemaVersion: 5 }),
}

function migrateToCurrent(state: Record<string, unknown>): Record<string, unknown> | undefined {
  let current = state
  let guard = 0
  while (current.schemaVersion !== RAVEN_SCHEMA_VERSION) {
    const version = current.schemaVersion
    if (typeof version !== 'number' || !Number.isSafeInteger(version)) return undefined
    // A snapshot from a NEWER build cannot be migrated backwards; refusing it is
    // correct, and it is the one case the seam deliberately does not rescue.
    if (version > RAVEN_SCHEMA_VERSION) return undefined
    const migrate = MIGRATIONS[version]
    if (migrate === undefined) return undefined
    const migrated = migrate(current)
    if (migrated === undefined) return undefined
    current = migrated
    guard += 1
    if (guard > RAVEN_SCHEMA_VERSION) return undefined
  }
  return current
}

/** Decode and fully validate the compact replay snapshot, migrating older versions forward. */
export function decodeRavenTaskState(value: unknown): RavenTaskState | undefined {
  const raw = record(value)
  const migratingV3 = raw?.schemaVersion === 3
  if (migratingV3 && !jsonWithinBudget(raw, RAVEN_LIMITS.stateBytes)) return undefined
  const state = raw === undefined ? undefined : migrateToCurrent(raw)
  // Once migrated state is serialized again its original version is no longer visible.
  // Replay therefore keeps this exact, bounded v3→v4 compatibility allowance for every
  // current snapshot; the engine still admits newly produced state against RAVEN_LIMITS.stateBytes.
  const replayStateBudget = RAVEN_LIMITS.stateBytes + V3_TO_V4_MIGRATION_OVERHEAD_BYTES
  if (state === undefined
    || !jsonWithinBudget(state, replayStateBudget)
    || !exactKeys(state, [
      'schemaVersion', 'taskId', 'ordinal', 'outcome', 'request', 'grounding', 'phase',
      'revision', 'steeringRevision', 'steering', 'checkpoints', 'sources', 'claims',
      'insightCandidates', 'syntheses', 'structureMode', 'structureRounds', 'selectedSkeleton',
      'limitations', 'latestArtifact', 'drafts', 'verification', 'finalArtifactSha256',
      'sourcePolicy', 'startedAt', 'updatedAt',
    ])
    || state.schemaVersion !== RAVEN_SCHEMA_VERSION
    || !string(state.taskId)
    || !integer(state.ordinal, 1)
    || !member(state.outcome, OUTCOMES)
    || !string(state.request)
    || state.request.length > RAVEN_LIMITS.requestChars
    || !member(state.grounding, GROUNDING_POLICIES)
    || !validPolicy(state.sourcePolicy)
    || !member(state.structureMode, STRUCTURE_MODES)
    || !member(state.phase, PHASES)
    || !integer(state.revision, 1)
    || !integer(state.steeringRevision)
    || !Array.isArray(state.steering)
    || !Array.isArray(state.checkpoints)
    || !Array.isArray(state.sources)
    || !Array.isArray(state.claims)
    || !Array.isArray(state.insightCandidates)
    || !Array.isArray(state.syntheses)
    || !Array.isArray(state.structureRounds)
    || !Array.isArray(state.limitations)
    || state.steering.length > RAVEN_LIMITS.steeringRevisions
    || state.checkpoints.length > RAVEN_LIMITS.checkpoints
    || state.sources.length > RAVEN_LIMITS.sources
    || state.claims.length > RAVEN_LIMITS.claims
    || state.insightCandidates.length > RAVEN_LIMITS.insightCandidates
    || state.syntheses.length > RAVEN_LIMITS.synthesisRounds
    || state.structureRounds.length > RAVEN_LIMITS.structureRounds
    || state.limitations.length > RAVEN_LIMITS.limitations
    || !(state.latestArtifact === null || (string(state.latestArtifact, false)
      && state.latestArtifact.length <= RAVEN_LIMITS.artifactChars))
    || !timestamp(state.startedAt)
    || !timestamp(state.updatedAt)
    || !new RegExp(`^rvn-[a-f0-9]{12}-${state.ordinal}$`).test(state.taskId)) return undefined

  if (state.steering.length !== state.steeringRevision) return undefined
  for (const [index, raw] of state.steering.entries()) {
    const item = record(raw)
    if (item === undefined
      || !exactKeys(item, ['revision', 'correction', 'createdAt', 'sourcePolicy', 'structureMode'])
      || item.revision !== index + 1
      || !string(item.correction)
      || item.correction.length > RAVEN_LIMITS.correctionChars
      || !timestamp(item.createdAt)
      || (item.sourcePolicy !== undefined && !validPolicy(item.sourcePolicy))
      || (item.structureMode !== undefined && !member(item.structureMode, STRUCTURE_MODES))) return undefined
  }

  // Checkpoint identity is NOT positional any more. Ordinals used to be
  // `index + 1` and ids `${taskId}-cp-${ordinal}`, so trimming an older
  // descriptor at the cap — the fix for the terminal 128-Checkpoint deadlock —
  // made every surviving snapshot undecodable, and two concurrent Agent Team
  // writers minted the same id. What is still required is what actually matters:
  // ids belong to this Task, are unique, and ordinals strictly increase.
  const checkpointIds = new Set<string>()
  let previousCheckpointOrdinal = 0
  for (const raw of state.checkpoints) {
    const item = record(raw)
    if (item === undefined
      || !exactKeys(item, [
        'checkpointId', 'ordinal', 'stage', 'summary', 'artifactSha256', 'artifactChars',
        'steeringRevision', 'selectedStructureRevision', 'createdAt', 'proseLayout',
      ])
      || !string(item.checkpointId)
      || !item.checkpointId.startsWith(`${state.taskId}-cp-`)
      || checkpointIds.has(item.checkpointId)
      || !integer(item.ordinal, previousCheckpointOrdinal + 1)
      || !member(item.stage, RAVEN_STAGES)
      || !string(item.summary)
      || item.summary.length > RAVEN_LIMITS.summaryChars
      || !string(item.artifactSha256)
      || !SHA256.test(item.artifactSha256)
      || !integer(item.artifactChars)
      || !integer(item.steeringRevision)
      || item.steeringRevision > state.steeringRevision
      || (item.selectedStructureRevision !== undefined
        && (!integer(item.selectedStructureRevision, 1) || item.selectedStructureRevision > state.revision))
      // Absent means the record predates Prose Layouts, which is `as-written`.
      || (item.proseLayout !== undefined && !member(item.proseLayout, PROSE_LAYOUTS))
      || !timestamp(item.createdAt)) return undefined
    checkpointIds.add(item.checkpointId)
    previousCheckpointOrdinal = item.ordinal as number
  }

  if (state.drafts !== undefined) {
    if (!Array.isArray(state.drafts) || state.drafts.length > RAVEN_LIMITS.draftRounds) return undefined
    let previousOrdinal = 0
    for (const raw of state.drafts) {
      const item = record(raw)
      if (item === undefined
        || !exactKeys(item, [
          'ordinal', 'instruction', 'requestedAt', 'routes', 'steeringRevision',
          'selectedStructureRevision', 'sectionId', 'path', 'recommendation',
          'comparisonRoute', 'synthesisRoute', 'synthesizedFromRoutes',
        ])
        // Rounds are trimmed from the front at the bound, so ordinals stay strictly
        // increasing without restarting at one.
        || !integer(item.ordinal, previousOrdinal + 1)
        || !string(item.instruction)
        || item.instruction.length > RAVEN_LIMITS.draftInstructionChars
        || !timestamp(item.requestedAt)
        || !Array.isArray(item.routes)
        || item.routes.length > RAVEN_LIMITS.draftRoutes) return undefined
      previousOrdinal = item.ordinal
      const routeKeys = new Set<string>()
      const draftedRouteKeys = new Set<string>()
      for (const rawRoute of item.routes) {
        const route = record(rawRoute)
        if (route === undefined
          || !exactKeys(route, ['provider', 'model', 'status', 'chars'])
          || !string(route.provider)
          || !string(route.model)
          || !member(route.status, DRAFT_STATUSES)
          || !integer(route.chars)
          || route.chars > RAVEN_LIMITS.draftVariantChars) return undefined
        const key = `${route.provider}\n${route.model}`
        if (routeKeys.has(key)
          || (route.status === 'drafted' && route.chars === 0)
          || (route.status === 'failed' && route.chars !== 0)) return undefined
        routeKeys.add(key)
        if (route.status === 'drafted') draftedRouteKeys.add(key)
      }
      const modernFields = [
        item.steeringRevision, item.selectedStructureRevision, item.sectionId, item.recommendation,
        item.comparisonRoute, item.synthesisRoute, item.synthesizedFromRoutes,
      ]
      if (item.path === undefined) {
        if (modernFields.some(value => value !== undefined)) return undefined
        continue
      }
      if (!member(item.path, DRAFT_PATHS)
        || !integer(item.steeringRevision)
        || item.steeringRevision > state.steeringRevision
        || (item.sectionId !== undefined && (!string(item.sectionId) || !STABLE_ID.test(item.sectionId)))
        || (item.selectedStructureRevision !== undefined
          && (!integer(item.selectedStructureRevision, 1) || item.selectedStructureRevision > state.revision))
        || ((item.sectionId === undefined) !== (item.selectedStructureRevision === undefined))) return undefined
      if ((item.path === 'main-agent' && draftedRouteKeys.size !== 0)
        || (item.path === 'single-model' && draftedRouteKeys.size !== 1)
        || (item.path === 'multi-model' && draftedRouteKeys.size < 2)) return undefined

      const comparisonRoute = item.comparisonRoute
      if ((item.recommendation === undefined) !== (comparisonRoute === undefined)) return undefined
      if (comparisonRoute !== undefined) {
        if (!member(item.recommendation, DRAFT_RECOMMENDATIONS) || !validDraftRoute(comparisonRoute)) return undefined
        if (!draftedRouteKeys.has(`${comparisonRoute.provider}\n${comparisonRoute.model}`)) return undefined
      }

      const synthesisRoute = item.synthesisRoute
      const synthesized = item.synthesizedFromRoutes
      if ((synthesisRoute === undefined) !== (synthesized === undefined)) return undefined
      if (synthesisRoute !== undefined) {
        if (item.recommendation !== 'proceed'
          || !validDraftRoute(synthesisRoute)
          || !Array.isArray(synthesized)
          || synthesized.length < 2
          || synthesized.length > RAVEN_LIMITS.draftRoutes) return undefined
        const synthesizedKeys = new Set<string>()
        for (const route of synthesized) {
          if (!validDraftRoute(route)) return undefined
          const key = `${route.provider}\n${route.model}`
          if (synthesizedKeys.has(key) || !draftedRouteKeys.has(key)) return undefined
          synthesizedKeys.add(key)
        }
        if (!draftedRouteKeys.has(`${synthesisRoute.provider}\n${synthesisRoute.model}`)) return undefined
      }
    }
  }

  const sourceIds = new Set<string>()
  const sourceIdentities = new Set<string>()
  const sourceChecks = new Map<string, RavenSourceCheck>()
  for (const raw of state.sources) {
    const item = record(raw)
    if (item === undefined
      || !exactKeys(item, [
        'sourceId', 'url', 'resource', 'representation', 'inspectionSha256', 'title', 'locator', 'excerpt', 'role',
        'sourceFamily', 'asOf', 'inspectedAt', 'check',
      ])
      || !string(item.sourceId)
      || !STABLE_ID.test(item.sourceId)
      || sourceIds.has(item.sourceId)
      || !string(item.url)
      || (() => {
        const resource = record(item.resource)
        return resource === undefined
          || !exactKeys(resource, ['origin', 'uri', 'mediaType', 'sourceName'])
          || !member(resource.origin, SOURCE_ORIGINS)
          || !validUri(resource.uri, resource.origin)
          || sourceIdentities.has(resource.uri)
          || item.url !== resource.uri
          || (resource.mediaType !== undefined && (!string(resource.mediaType) || resource.mediaType !== resource.mediaType.trim() || resource.mediaType.length > RAVEN_LIMITS.sourceMediaTypeChars))
          || (resource.sourceName !== undefined && (!string(resource.sourceName) || resource.sourceName !== resource.sourceName.trim() || resource.sourceName.length > RAVEN_LIMITS.sourceNameChars))
          || ((resource.origin === 'llm-wiki' || resource.origin === 'mcp') && !string(resource.sourceName))
          || ((resource.origin === 'web' || resource.origin === 'local') && resource.sourceName !== undefined)
          || (resource.origin === 'mcp' && new URL(resource.uri as string).hostname !== resource.sourceName)
          || (resource.origin === 'llm-wiki' && new URL(resource.uri as string).protocol === 'llm-wiki:'
            && new URL(resource.uri as string).hostname !== resource.sourceName)
      })()
      || !validRepresentation(item.representation, item.resource)
      || (item.inspectionSha256 !== undefined && (!string(item.inspectionSha256) || !SHA256.test(item.inspectionSha256)))
      || ((item.resource as Record<string, unknown>).origin === 'web' && item.inspectionSha256 !== undefined)
      || ((item.resource as Record<string, unknown>).origin !== 'web'
        && record(item.check)?.status === 'reachable'
        && item.inspectionSha256 === undefined)
      || !string(item.title)
      || item.title.length > RAVEN_LIMITS.sourceTitleChars
      || !string(item.locator)
      || item.locator.length > RAVEN_LIMITS.sourceLocatorChars
      || !string(item.excerpt)
      || item.excerpt.length > RAVEN_LIMITS.sourceExcerptChars
      || !member(item.role, SOURCE_ROLES)
      || (item.sourceFamily !== undefined
        && (!string(item.sourceFamily) || item.sourceFamily.length > RAVEN_LIMITS.sourceFamilyChars))
      || (item.asOf !== undefined
        && (!string(item.asOf) || item.asOf.length > RAVEN_LIMITS.sourceAsOfChars))
      || !timestamp(item.inspectedAt)
      || !validCheck(item.check, item.url, (item.resource as Record<string, unknown>).origin as string)) return undefined

    if (item.inspectionSha256 !== undefined) {
      if (item.representation === null
        || item.inspectionSha256 !== sourceInspectionSha256(
          item.resource as unknown as RavenSourceResource,
          item.representation as unknown as RavenSourceRepresentation,
        )) return undefined
    }
    sourceIds.add(item.sourceId)
    const resource = item.resource as Record<string, string>
    sourceIdentities.add(resource.uri as string)
    sourceChecks.set(item.sourceId, item.check as RavenSourceCheck)
  }
  // trace and an Artifact citation that changed meaning across a restart, with no
  // message, Limitation, or issue anywhere. The
  // structural checks below still reject the snapshot: a malformed Claim is a
  // corrupt record, not a stale one.
  let repairedClaims: Record<string, unknown>[] = []
  let repairedAnyClaim = false
  const claimIds = new Set<string>()
  for (const raw of state.claims) {
    const item = record(raw)
    if (item === undefined
      || !exactKeys(item, [
        'claimId', 'text', 'kind', 'importance', 'disposition', 'deferredFrom', 'sourceIds',
        'legacySourceIds', 'insightId', 'derivedFromClaimIds', 'assumptions', 'contradicts',
      ])
      || !string(item.claimId)
      || !STABLE_ID.test(item.claimId)
      || claimIds.has(item.claimId)
      || !string(item.text)
      || item.text.length > RAVEN_LIMITS.claimTextChars
      || !member(item.kind, CLAIM_KINDS)
      || !member(item.importance, CLAIM_IMPORTANCE)
      || !member(item.disposition, CLAIM_DISPOSITIONS)
      || (item.deferredFrom !== undefined
        && (item.disposition !== 'deferred'
          || !member(item.deferredFrom, ['supported', 'qualified'] as const)))
      || !uniqueStrings(item.sourceIds, id => STABLE_ID.test(id) && sourceIds.has(id))
      || (item.legacySourceIds !== undefined
        && (item.kind !== 'analysis'
          || item.sourceIds.length > 0
          || item.insightId !== undefined
          || item.derivedFromClaimIds !== undefined
          || item.assumptions !== undefined
          || !uniqueStrings(item.legacySourceIds, id => STABLE_ID.test(id) && sourceIds.has(id))
          || item.legacySourceIds.length === 0
          || item.legacySourceIds.length > RAVEN_LIMITS.sources))
      || (item.insightId !== undefined && (!string(item.insightId) || !STABLE_ID.test(item.insightId)))
      || (item.derivedFromClaimIds !== undefined
        && (!uniqueStrings(item.derivedFromClaimIds, id => STABLE_ID.test(id) && id !== item.claimId)
          || item.derivedFromClaimIds.length > RAVEN_LIMITS.claims))
      || (item.assumptions !== undefined
        && (!uniqueStrings(item.assumptions, assumption => assumption.length <= RAVEN_LIMITS.insightAssumptionChars)
          || item.assumptions.length > RAVEN_LIMITS.insightAssumptions))
      || (item.kind === 'external'
        && (item.insightId !== undefined || item.derivedFromClaimIds !== undefined || item.assumptions !== undefined))
      || (item.kind === 'analysis' && item.sourceIds.length > 0)
      || (item.contradicts !== undefined
        && (!uniqueStrings(item.contradicts, id => STABLE_ID.test(id) && id !== item.claimId)
          || item.contradicts.length > RAVEN_LIMITS.claims))) return undefined
    const unsupportable = item.kind === 'external'
      && (item.disposition === 'supported' || item.disposition === 'qualified')
      && (item.sourceIds.length === 0
        || !item.sourceIds.some(sourceId => sourceChecks.get(sourceId)?.status === 'reachable'))
    if (unsupportable) {
      repairedAnyClaim = true
      repairedClaims.push({ ...item, disposition: 'deferred', deferredFrom: item.disposition })
    } else if (item.kind === 'external' && item.disposition === 'deferred'
      && item.deferredFrom !== undefined
      && item.sourceIds.some(sourceId => sourceChecks.get(sourceId)?.status === 'reachable')) {
      repairedAnyClaim = true
      const { deferredFrom, ...restored } = item
      repairedClaims.push({ ...restored, disposition: deferredFrom })
    } else {
      repairedClaims.push(item)
    }
    claimIds.add(item.claimId)
  }
  const analysisPropagation = propagateAnalysisPremiseDispositions(
    repairedClaims as unknown as RavenClaimRecord[],
  )
  repairedClaims = analysisPropagation.claims as unknown as Record<string, unknown>[]
  repairedAnyClaim ||= analysisPropagation.changed
  const repairedClaimById = new Map(repairedClaims.map(item => [item.claimId as string, item]))
  for (const raw of state.claims) {
    const item = record(raw)
    if (item === undefined) return undefined
    const contradicts = item.contradicts
    if (Array.isArray(contradicts)
      && contradicts.some(other => typeof other !== 'string' || !claimIds.has(other))) return undefined
    const derivedFrom = item.derivedFromClaimIds
    if (Array.isArray(derivedFrom)
      && derivedFrom.some(other => typeof other !== 'string' || !claimIds.has(other))) return undefined
  }

  const insightById = new Map<string, RavenInsightCandidate>()
  for (const raw of state.insightCandidates) {
    const item = record(raw)
    if (item === undefined
      || !exactKeys(item, [
        'insightId', 'text', 'kind', 'pattern', 'claimIds', 'assumptions', 'rationale',
        'wouldChangeMind', 'confidence', 'competesWith', 'createdAt',
      ])
      || !string(item.insightId)
      || !STABLE_ID.test(item.insightId)
      || insightById.has(item.insightId)
      || !string(item.text)
      || item.text.length > RAVEN_LIMITS.insightTextChars
      || !member(item.kind, INSIGHT_KINDS)
      || !member(item.pattern, INSIGHT_PATTERNS)
      || !uniqueStrings(item.claimIds, id => STABLE_ID.test(id) && claimIds.has(id))
      || item.claimIds.length === 0
      || item.claimIds.length > RAVEN_LIMITS.claims
      || !uniqueStrings(item.assumptions, assumption => assumption.length <= RAVEN_LIMITS.insightAssumptionChars)
      || item.assumptions.length > RAVEN_LIMITS.insightAssumptions
      || !string(item.rationale)
      || item.rationale.length > RAVEN_LIMITS.insightRationaleChars
      || !string(item.wouldChangeMind)
      || item.wouldChangeMind.length > RAVEN_LIMITS.insightWouldChangeMindChars
      || !member(item.confidence, INSIGHT_CONFIDENCE)
      || (item.competesWith !== undefined
        && (!uniqueStrings(item.competesWith, id => STABLE_ID.test(id) && id !== item.insightId)
          || item.competesWith.length > RAVEN_LIMITS.insightCandidates))
      || !timestamp(item.createdAt)) return undefined
    const insight = item as unknown as RavenInsightCandidate
    insightById.set(insight.insightId, insight)
  }
  for (const insight of insightById.values()) {
    if ((insight.competesWith ?? []).some(other => !insightById.has(other))) return undefined
  }
  for (const claim of repairedClaims) {
    if (claim.kind !== 'analysis' || claim.insightId === undefined) continue
    const insight = insightById.get(claim.insightId as string)
    if (insight === undefined
      || claim.text !== insight.text
      || !sameStrings(claim.derivedFromClaimIds ?? [], insight.claimIds)
      || !sameStrings(claim.assumptions ?? [], insight.assumptions)) return undefined
    if ((claim.disposition === 'supported' || claim.disposition === 'qualified')
      && insight.claimIds.some((claimId) => {
        const premise = repairedClaimById.get(claimId)
        return premise === undefined
          || (premise.disposition !== 'supported' && premise.disposition !== 'qualified')
      })) return undefined
  }

  if (analysisLineageCycle(repairedClaims as unknown as RavenClaimRecord[]) !== undefined) return undefined

  let previousSynthesisOrdinal = 0
  for (const raw of state.syntheses) {
    const item = record(raw)
    if (item === undefined
      || !exactKeys(item, [
        'ordinal', 'scope', 'purpose', 'claimIds', 'insightIds', 'summaryDebt',
        'summaryDebtDetail', 'createdAt',
      ])
      || !integer(item.ordinal, previousSynthesisOrdinal + 1)
      || !string(item.scope)
      || item.scope.length > RAVEN_LIMITS.synthesisScopeChars
      || !member(item.purpose, SYNTHESIS_PURPOSES)
      || !uniqueStrings(item.claimIds, id => STABLE_ID.test(id) && claimIds.has(id))
      || item.claimIds.length === 0
      || item.claimIds.length > RAVEN_LIMITS.claims
      || !uniqueStrings(item.insightIds, id => STABLE_ID.test(id) && insightById.has(id))
      || item.insightIds.length > RAVEN_LIMITS.insightCandidates
      || !member(item.summaryDebt, SUMMARY_DEBT_LEVELS)
      || !string(item.summaryDebtDetail)
      || item.summaryDebtDetail.length > RAVEN_LIMITS.insightRationaleChars
      || !timestamp(item.createdAt)) return undefined
    const scoped = new Set(item.claimIds as string[])
    if ((item.insightIds as string[]).some((insightId) => {
      const insight = insightById.get(insightId)
      return insight === undefined || insight.claimIds.some(claimId => !scoped.has(claimId))
    })) return undefined
    previousSynthesisOrdinal = item.ordinal as number
  }

  let previousStructureOrdinal = 0
  let latestStructureCandidates = new Map<string, Record<string, unknown>>()
  let latestStructureSteeringRevision: number | undefined
  for (const raw of state.structureRounds) {
    const item = record(raw)
    if (item === undefined
      || !exactKeys(item, [
        'ordinal', 'steeringRevision', 'candidates', 'battle', 'recommendation', 'createdAt',
      ])
      || !integer(item.ordinal, previousStructureOrdinal + 1)
      || !integer(item.steeringRevision)
      || item.steeringRevision > state.steeringRevision
      || !Array.isArray(item.candidates)
      || item.candidates.length < 2
      || item.candidates.length > RAVEN_LIMITS.skeletonCandidates
      || !Array.isArray(item.battle)
      || item.battle.length !== item.candidates.length
      || !timestamp(item.createdAt)) return undefined
    const candidates = new Map<string, Record<string, unknown>>()
    const frames = new Set<string>()
    const theses = new Set<string>()
    for (const rawCandidate of item.candidates) {
      const candidate = record(rawCandidate)
      const skeleton = record(candidate?.skeleton)
      if (candidate === undefined
        || skeleton === undefined
        || !exactKeys(candidate, ['candidateId', 'label', 'skeleton'])
        || !string(candidate.candidateId)
        || !STABLE_ID.test(candidate.candidateId)
        || candidates.has(candidate.candidateId)
        || !string(candidate.label)
        || candidate.label.length > RAVEN_LIMITS.skeletonTextChars
        || !validArgumentSkeleton(candidate.skeleton, claimIds, insightById)) return undefined
      const frame = semanticTextFold(skeleton.frame as string)
      const thesis = semanticTextFold(skeleton.thesis as string)
      if (frames.has(frame) || theses.has(thesis)) return undefined
      frames.add(frame)
      theses.add(thesis)
      candidates.set(candidate.candidateId, candidate)
    }
    const candidateList = [...candidates.values()]
    for (const [index, candidate] of candidateList.entries()) {
      for (const other of candidateList.slice(index + 1)) {
        if (semanticTextSimilarity(
          skeletonSemanticText(candidate.skeleton as unknown as RavenArgumentSkeleton),
          skeletonSemanticText(other.skeleton as unknown as RavenArgumentSkeleton),
        ) >= 0.85) return undefined
      }
    }
    const battled = new Set<string>()
    for (const rawBattle of item.battle) {
      const entry = record(rawBattle)
      if (entry === undefined
        || !exactKeys(entry, [
          'candidateId', 'explainsBetter', 'failsToExplain', 'conventionalWisdom', 'evidenceRequired',
          'assumptions', 'nonObviousInsights', 'mergeableElements',
        ])
        || !string(entry.candidateId)
        || !candidates.has(entry.candidateId)
        || battled.has(entry.candidateId)
        || !validStructureTextList(entry.explainsBetter)
        || !validStructureTextList(entry.failsToExplain)
        || !validStructureTextList(entry.conventionalWisdom)
        || !validStructureTextList(entry.evidenceRequired)
        || !validStructureTextList(entry.assumptions)
        || !validStructureTextList(entry.nonObviousInsights)
        || !validStructureTextList(entry.mergeableElements)) return undefined
      battled.add(entry.candidateId)
    }
    const recommendation = record(item.recommendation)
    if (recommendation === undefined
      || !exactKeys(recommendation, ['kind', 'candidateIds', 'rationale'])
      || !member(recommendation.kind, SKELETON_RECOMMENDATION_KINDS)
      || !Array.isArray(recommendation.candidateIds)
      || recommendation.candidateIds.length === 0
      || recommendation.candidateIds.length > RAVEN_LIMITS.skeletonCandidates
      || !uniqueStrings(recommendation.candidateIds, id => STABLE_ID.test(id) && candidates.has(id))
      || (recommendation.kind === 'candidate' && recommendation.candidateIds.length !== 1)
      || !string(recommendation.rationale)
      || recommendation.rationale.length > RAVEN_LIMITS.skeletonTextChars) return undefined
    previousStructureOrdinal = item.ordinal as number
    latestStructureCandidates = candidates
    latestStructureSteeringRevision = item.steeringRevision as number
  }

  if (state.selectedSkeleton !== null) {
    const selected = record(state.selectedSkeleton)
    if (selected === undefined
      || state.structureMode === 'skip'
      || latestStructureCandidates.size === 0
      || latestStructureSteeringRevision !== state.steeringRevision
      || !exactKeys(selected, [
        'kind', 'chosenBy', 'candidateIds', 'skeleton', 'rationale', 'selectedAtRevision',
        'steeringRevision', 'selectedAt',
      ])
      || !member(selected.kind, SKELETON_RECOMMENDATION_KINDS)
      || !member(selected.chosenBy, SKELETON_SELECTION_ACTORS)
      || (state.structureMode === 'collaborative' && selected.chosenBy !== 'user')
      || (state.structureMode === 'autonomous' && selected.chosenBy !== 'raven')
      || !Array.isArray(selected.candidateIds)
      || selected.candidateIds.length === 0
      || selected.candidateIds.length > RAVEN_LIMITS.skeletonCandidates
      || !uniqueStrings(selected.candidateIds, id => STABLE_ID.test(id) && latestStructureCandidates.has(id))
      || (selected.kind === 'candidate' && selected.candidateIds.length !== 1)
      || !validArgumentSkeleton(selected.skeleton, claimIds, insightById)
      || !string(selected.rationale)
      || selected.rationale.length > RAVEN_LIMITS.skeletonTextChars
      || !integer(selected.selectedAtRevision, 1)
      || selected.selectedAtRevision > state.revision
      || selected.steeringRevision !== state.steeringRevision
      || !timestamp(selected.selectedAt)) return undefined
    if (selected.kind === 'candidate') {
      const candidate = latestStructureCandidates.get((selected.candidateIds as string[])[0] as string)
      if (candidate === undefined || JSON.stringify(candidate.skeleton) !== JSON.stringify(selected.skeleton)) return undefined
    }
  }

  // Limitation identity is NOT positional either. Requiring
  // `${kind}-${index + 1}` made a legally constructed ordering undecodable the
  // moment two kinds interleaved, which dropped the whole Task on replay. Unique
  // and well-shaped for its kind is the invariant that is actually load-bearing.
  const limitationIds = new Set<string>()
  for (const raw of state.limitations) {
    const item = record(raw)
    if (item === undefined
      || !exactKeys(item, ['limitationId', 'kind', 'detail', 'sourceId', 'createdAt'])
      // Kind is validated BEFORE it is interpolated into a pattern, so a stored
      // snapshot can never smuggle regex syntax through this check.
      || !member(item.kind, LIMITATION_KINDS)
      || !string(item.limitationId)
      || !new RegExp(`^${item.kind}-\\d{1,9}$`).test(item.limitationId)
      || limitationIds.has(item.limitationId)
      || !string(item.detail)
      || item.detail.length > RAVEN_LIMITS.limitationDetailChars
      || (item.sourceId !== undefined && (!string(item.sourceId) || !sourceIds.has(item.sourceId)))
      || !timestamp(item.createdAt)) return undefined
    limitationIds.add(item.limitationId)
  }

  if (state.checkpoints.length === 0 && state.latestArtifact !== null) return undefined
  if (state.checkpoints.length > 0) {
    if (!string(state.latestArtifact, false)) return undefined
    const latest = record(state.checkpoints.at(-1))
    if (latest === undefined
      || latest.artifactSha256 !== sha256(state.latestArtifact)
      || latest.artifactChars !== state.latestArtifact.length) return undefined
  }

  if (!(state.verification === null || (() => {
    const receipt = record(state.verification)
    return receipt !== undefined
      && exactKeys(receipt, [
        'verifiedAt', 'mode', 'checked', 'reachable', 'failed', 'unavailable', 'artifactSha256',
      ])
      && timestamp(receipt.verifiedAt)
      && member(receipt.mode, VERIFICATION_MODES)
      && integer(receipt.checked)
      && integer(receipt.reachable)
      && integer(receipt.failed)
      && integer(receipt.unavailable)
      && receipt.checked === receipt.reachable + receipt.failed + receipt.unavailable
      && receipt.checked <= state.sources.length
      && string(receipt.artifactSha256)
      && SHA256.test(receipt.artifactSha256)
  })())) return undefined

  if (!(state.finalArtifactSha256 === null
    || (string(state.finalArtifactSha256) && SHA256.test(state.finalArtifactSha256)))) return undefined
  const completed = state.phase === 'completed' || state.phase === 'completed-with-limits'
  if (completed && repairedAnyClaim) return undefined
  if (completed) {
    if (state.structureMode !== 'skip' && state.selectedSkeleton === null) return undefined
    const verification = record(state.verification)
    if (state.finalArtifactSha256 === null
      || verification === undefined
      || state.latestArtifact === null
      || state.finalArtifactSha256 !== sha256(state.latestArtifact)
      || verification.artifactSha256 !== state.finalArtifactSha256) return undefined
    const latest = record(state.checkpoints.at(-1))
    if (latest?.steeringRevision !== state.steeringRevision) return undefined
    const selected = record(state.selectedSkeleton)
    if (selected !== undefined && latest?.selectedStructureRevision !== selected.selectedAtRevision) return undefined
  } else if (state.finalArtifactSha256 !== null) return undefined

  return (repairedAnyClaim
    ? { ...state, claims: repairedClaims }
    : state) as unknown as RavenTaskState
}