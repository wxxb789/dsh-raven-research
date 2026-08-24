import { createHash } from 'node:crypto'

import { canonicalSourceUrl, sameSourceIdentity } from './url.js'
import { PROSE_LAYOUTS } from './prose.js'

import {
  CLAIM_DISPOSITIONS,
  CLAIM_IMPORTANCE,
  CLAIM_KINDS,
  DRAFT_STATUSES,
  GROUNDING_POLICIES,
  LIMITATION_KINDS,
  OUTCOMES,
  RAVEN_LIMITS,
  RAVEN_STAGES,
  SOURCE_ROLES,
  type RavenSourceCheck,
  type RavenTaskState,
} from './domain.js'

const PHASES = ['active', 'stopped', 'completed', 'completed-with-limits'] as const
const CHECK_STATUSES = ['reachable', 'failed', 'unavailable'] as const
const VERIFICATION_MODES = ['remote', 'structural-only'] as const
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

function validCheck(value: unknown, sourceUrl: string): value is RavenSourceCheck {
  const check = record(value)
  if (check === undefined || !string(check.status)) return false
  if (check.status === 'unchecked') return exactKeys(check, ['status']) && Object.keys(check).length === 1
  if (!exactKeys(check, ['status', 'checkedAt', 'statusCode', 'resolvedUrl', 'detail'])) return false
  if (!member(check.status, CHECK_STATUSES) || !timestamp(check.checkedAt)) return false
  if (check.statusCode !== undefined && (!integer(check.statusCode, 100) || check.statusCode > 599)) return false
  if (check.resolvedUrl !== undefined && !validUrl(check.resolvedUrl)) return false
  if (check.detail !== undefined && !string(check.detail)) return false
  if (check.status === 'reachable') {
    if (!integer(check.statusCode, 200)
      || check.statusCode >= 400
      || !validUrl(check.resolvedUrl)
      || !sameSourceIdentity(sourceUrl, check.resolvedUrl)) return false
  }
  if (check.status === 'failed'
    && (!integer(check.statusCode, 100) || !validUrl(check.resolvedUrl) || !string(check.detail))) return false
  if (check.status === 'unavailable' && !string(check.detail)) return false
  return true
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

/** The schema version this build writes. Older versions are migrated forward. */
export const RAVEN_SCHEMA_VERSION = 1

/**
 * Forward migrations, keyed by the version being migrated FROM.
 *
 * The decoder used to reject any `schemaVersion` but 1 outright, so the first
 * bump would have silently dropped every stored Task on replay — a data-loss
 * path with no code path to fix it in. The seam exists now even though it holds
 * nothing: the next bump adds one entry here instead of rediscovering that the
 * only place to put it does not exist.
 */
const MIGRATIONS: Record<number, (state: Record<string, unknown>) => Record<string, unknown> | undefined> = {}

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
      'startedAt', 'updatedAt',
    ])
    || state.schemaVersion !== RAVEN_SCHEMA_VERSION
    || !string(state.taskId)
    || !integer(state.ordinal, 1)
    || !member(state.outcome, OUTCOMES)
    || !string(state.request)
    || state.request.length > RAVEN_LIMITS.requestChars
    || !member(state.grounding, GROUNDING_POLICIES)
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
      || !exactKeys(item, ['revision', 'correction', 'createdAt'])
      || item.revision !== index + 1
      || !string(item.correction)
      || item.correction.length > RAVEN_LIMITS.correctionChars
      || !timestamp(item.createdAt)) return undefined
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
  const sourceUrls = new Set<string>()
  const sourceChecks = new Map<string, RavenSourceCheck>()
  for (const raw of state.sources) {
    const item = record(raw)
    if (item === undefined
      || !exactKeys(item, [
        'sourceId', 'url', 'title', 'locator', 'excerpt', 'role', 'sourceFamily', 'asOf',
        'inspectedAt', 'check',
      ])
      || !string(item.sourceId)
      || !STABLE_ID.test(item.sourceId)
      || sourceIds.has(item.sourceId)
      || !validUrl(item.url)
      || sourceUrls.has(item.url)
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
      || !validCheck(item.check, item.url)) return undefined
    sourceIds.add(item.sourceId)
    sourceUrls.add(item.url)
    sourceChecks.set(item.sourceId, item.check as RavenSourceCheck)
  }

  // A single unusable Claim must never cost the whole Task.
  //
  // Rejecting the snapshot when one external supported/qualified Claim's Sources
  // are not currently reachable meant plugin.ts's replay skipped the state
  // entirely and the Task vanished — a whole research session lost to one dead
  // link. Downgrading that Claim to `deferred` is exactly what the engine's own
  // propagation does when a Source later fails (`propagateSourceChecks`), so the
  // repair is the engine's rule applied at the boundary rather than a second
  // policy. The threshold below is therefore "no Source reachable", NOT "any
  // Source unreachable": those are not complements for a multi-Source Claim, and
  // the stricter reading silently turned a published `supported` Claim into a
  // `deferred` one on replay whenever one of several Sources had failed — a Claim
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
      || !exactKeys(item, ['claimId', 'text', 'kind', 'importance', 'disposition', 'sourceIds', 'contradicts'])
      || !string(item.claimId)
      || !STABLE_ID.test(item.claimId)
      || claimIds.has(item.claimId)
      || !string(item.text)
      || item.text.length > RAVEN_LIMITS.claimTextChars
      || !member(item.kind, CLAIM_KINDS)
      || !member(item.importance, CLAIM_IMPORTANCE)
      || !member(item.disposition, CLAIM_DISPOSITIONS)
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
      repairedClaims.push({ ...item, disposition: 'deferred' })
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