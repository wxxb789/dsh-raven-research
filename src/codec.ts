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

/** Decode and fully validate the schema-v1 compact replay snapshot. */
export function decodeRavenTaskState(value: unknown): RavenTaskState | undefined {
  const state = record(value)
  if (state === undefined
    || !exactKeys(state, [
      'schemaVersion', 'taskId', 'ordinal', 'outcome', 'request', 'grounding', 'phase',
      'revision', 'steeringRevision', 'steering', 'checkpoints', 'sources', 'claims',
      'limitations', 'latestArtifact', 'drafts', 'verification', 'finalArtifactSha256',
      'startedAt', 'updatedAt',
    ])
    || state.schemaVersion !== 1
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

  for (const [index, raw] of state.checkpoints.entries()) {
    const item = record(raw)
    const ordinal = index + 1
    if (item === undefined
      || !exactKeys(item, [
        'checkpointId', 'ordinal', 'stage', 'summary', 'artifactSha256', 'artifactChars',
        'steeringRevision', 'createdAt', 'proseLayout',
      ])
      || item.checkpointId !== `${state.taskId}-cp-${ordinal}`
      || item.ordinal !== ordinal
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
    if (item.kind === 'external'
      && (item.disposition === 'supported' || item.disposition === 'qualified')) {
      if (item.sourceIds.length === 0
        || item.sourceIds.some(sourceId => sourceChecks.get(sourceId)?.status !== 'reachable')) return undefined
    }
    claimIds.add(item.claimId)
  }
  for (const raw of state.claims) {
    const item = record(raw)
    const contradicts = item?.contradicts
    if (!Array.isArray(contradicts)) continue
    if (contradicts.some(other => typeof other !== 'string' || !claimIds.has(other))) return undefined
  }

  const limitationIds = new Set<string>()
  for (const [index, raw] of state.limitations.entries()) {
    const item = record(raw)
    if (item === undefined
      || !exactKeys(item, ['limitationId', 'kind', 'detail', 'sourceId', 'createdAt'])
      || item.limitationId !== `${String(item.kind)}-${index + 1}`
      || limitationIds.has(item.limitationId)
      || !member(item.kind, LIMITATION_KINDS)
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

  return state as unknown as RavenTaskState
}
