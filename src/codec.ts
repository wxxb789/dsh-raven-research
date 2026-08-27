import { createHash } from 'node:crypto'

import { canonicalSourceUrl, sameSourceIdentity } from './url.js'
import { PROSE_LAYOUTS } from './prose.js'
import { sourceInspectionSha256 } from './source.js'

import {
  CLAIM_DISPOSITIONS,
  CLAIM_IMPORTANCE,
  CLAIM_KINDS,
  DRAFT_STATUSES,
  GROUNDING_POLICIES,
  LIMITATION_KINDS,
  OUTCOMES,
  EMPTY_SOURCE_POLICY,
  RAVEN_LIMITS,
  RAVEN_STAGES,
  SOURCE_ORIGINS,
  SOURCE_ROLES,
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
export const RAVEN_SCHEMA_VERSION = 2

/**
 * Forward migrations, keyed by the version being migrated FROM.
 *
 * The decoder used to reject any `schemaVersion` but 1 outright, so the first
 * bump would have silently dropped every stored Task on replay — a data-loss
 * path with no code path to fix it in. The table now carries the v1 web-to-v2
 * Source fabric migration; future bumps add one entry per forward step.
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
  const state = raw === undefined ? undefined : migrateToCurrent(raw)
  if (state === undefined
    || !exactKeys(state, [
      'schemaVersion', 'taskId', 'ordinal', 'outcome', 'request', 'grounding', 'phase',
      'revision', 'steeringRevision', 'steering', 'checkpoints', 'sources', 'claims',
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
    || !member(state.phase, PHASES)
    || !integer(state.revision, 1)
    || !integer(state.steeringRevision)
    || !Array.isArray(state.steering)
    || !Array.isArray(state.checkpoints)
    || !Array.isArray(state.sources)
    || !Array.isArray(state.claims)
    || !Array.isArray(state.limitations)
    || state.steering.length > RAVEN_LIMITS.steeringRevisions
    || state.checkpoints.length > RAVEN_LIMITS.checkpoints
    || state.sources.length > RAVEN_LIMITS.sources
    || state.claims.length > RAVEN_LIMITS.claims
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
      || !exactKeys(item, ['revision', 'correction', 'createdAt', 'sourcePolicy'])
      || item.revision !== index + 1
      || !string(item.correction)
      || item.correction.length > RAVEN_LIMITS.correctionChars
      || !timestamp(item.createdAt)
      || (item.sourcePolicy !== undefined && !validPolicy(item.sourcePolicy))) return undefined
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
        'steeringRevision', 'createdAt', 'proseLayout',
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
        || !exactKeys(item, ['ordinal', 'instruction', 'requestedAt', 'routes'])
        // Rounds are trimmed from the front at the bound, so ordinals stay strictly
        // increasing without restarting at one.
        || !integer(item.ordinal, previousOrdinal + 1)
        || !string(item.instruction)
        || item.instruction.length > RAVEN_LIMITS.draftInstructionChars
        || !timestamp(item.requestedAt)
        || !Array.isArray(item.routes)
        || item.routes.length > RAVEN_LIMITS.draftRoutes) return undefined
      previousOrdinal = item.ordinal
      for (const rawRoute of item.routes) {
        const route = record(rawRoute)
        if (route === undefined
          || !exactKeys(route, ['provider', 'model', 'status', 'chars'])
          || !string(route.provider)
          || !string(route.model)
          || !member(route.status, DRAFT_STATUSES)
          || !integer(route.chars)
          || route.chars > RAVEN_LIMITS.draftVariantChars) return undefined
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
        && (item.check as Record<string, unknown>).status === 'reachable'
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
  const repairedClaims: Record<string, unknown>[] = []
  let repairedAnyClaim = false
  const claimIds = new Set<string>()
  for (const raw of state.claims) {
    const item = record(raw)
    if (item === undefined
      || !exactKeys(item, ['claimId', 'text', 'kind', 'importance', 'disposition', 'deferredFrom', 'sourceIds', 'contradicts'])
      || !string(item.claimId)
      || !STABLE_ID.test(item.claimId)
      || claimIds.has(item.claimId)
      || !string(item.text)
      || item.text.length > RAVEN_LIMITS.claimTextChars
      || !member(item.kind, CLAIM_KINDS)
      || !member(item.importance, CLAIM_IMPORTANCE)
      || !member(item.disposition, CLAIM_DISPOSITIONS)
      || (item.deferredFrom !== undefined
        && (item.kind !== 'external' || item.disposition !== 'deferred'
          || !member(item.deferredFrom, ['supported', 'qualified'] as const)))
      || !uniqueStrings(item.sourceIds, id => STABLE_ID.test(id) && sourceIds.has(id))
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
  for (const raw of state.claims) {
    const item = record(raw)
    const contradicts = item?.contradicts
    if (!Array.isArray(contradicts)) continue
    if (contradicts.some(other => typeof other !== 'string' || !claimIds.has(other))) return undefined
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
    const verification = record(state.verification)
    if (state.finalArtifactSha256 === null
      || verification === undefined
      || state.latestArtifact === null
      || state.finalArtifactSha256 !== sha256(state.latestArtifact)
      || verification.artifactSha256 !== state.finalArtifactSha256) return undefined
    const latest = record(state.checkpoints.at(-1))
    if (latest?.steeringRevision !== state.steeringRevision) return undefined
  } else if (state.finalArtifactSha256 !== null) return undefined

  return (repairedAnyClaim
    ? { ...state, claims: repairedClaims }
    : state) as unknown as RavenTaskState
}