import { createHash } from 'node:crypto'

import { canonicalSourceUrl, sameSourceIdentity } from './url.js'

import {
  CLAIM_DISPOSITIONS,
  CLAIM_IMPORTANCE,
  CLAIM_KINDS,
  GROUNDING_POLICIES,
  LIMITATION_KINDS,
  OUTCOMES,
  RAVEN_LIMITS,
  RAVEN_STAGES,
  SOURCE_ROLES,
  type ClaimDisposition,
  type ClaimImportance,
  type ClaimKind,
  type GroundingPolicy,
  type RavenClaimRecord,
  type RavenDispatchResult,
  type RavenExecution,
  type RavenLimitation,
  type RavenLimitationKind,
  type RavenOutcome,
  type RavenSourceCheck,
  type RavenSourceRecord,
  type RavenStage,
  type RavenTaskState,
  type RavenVerificationReceipt,
  type SourceCheckResult,
  type SourceRole,
  type SourceVerifier,
} from './domain.js'

interface RavenEngineOptions {
  readonly now: () => string
  readonly sourceVerifier: SourceVerifier
}

interface RavenEngine {
  dispatch(
    previous: RavenTaskState | null,
    input: unknown,
    execution: RavenExecution,
  ): Promise<RavenDispatchResult>
}

const ACTION_FIELDS: Record<string, readonly string[]> = {
  start: ['action', 'outcome', 'request', 'grounding'],
  checkpoint: ['action', 'taskId', 'stage', 'summary', 'artifact', 'sources', 'claims', 'failures'],
  steer: ['action', 'taskId', 'correction'],
  complete: ['action', 'taskId', 'artifact'],
  status: ['action', 'taskId'],
  stop: ['action', 'taskId', 'reason'],
  resume: ['action', 'taskId'],
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown field(s): ${unknown.join(', ')}`)
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function boundedText(value: unknown, label: string, maximum: number): string {
  const text = requiredText(value, label)
  if (text.length > maximum) throw new TypeError(`${label} must be at most ${maximum} characters`)
  return text
}

function optionalBoundedText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined
  return boundedText(value, label, maximum)
}

function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as T
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value
}

function defaultGrounding(outcome: RavenOutcome): GroundingPolicy {
  return outcome === 'research' || outcome === 'academic-writing' ? 'required' : 'optional'
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function taskId(sessionId: string, ordinal: number): string {
  return `rvn-${sha256(sessionId).slice(7, 19)}-${ordinal}`
}

function requireTask(previous: RavenTaskState | null, requestedTaskId: unknown): RavenTaskState {
  if (previous === null) throw new Error('No Raven Task exists in this session')
  const requested = requiredText(requestedTaskId, 'taskId')
  if (requested !== previous.taskId) {
    throw new Error(`Raven Task ${requested} was not found in this session`)
  }
  return previous
}

function requireActiveTask(previous: RavenTaskState | null, requestedTaskId: unknown): RavenTaskState {
  const state = requireTask(previous, requestedTaskId)
  if (state.phase !== 'active') throw new Error(`Raven Task ${state.taskId} is ${state.phase}`)
  return state
}

function canonicalUrl(value: unknown): string {
  const input = requiredText(value, 'source.url')
  if (input.length > 2048) throw new TypeError('source.url is too long')
  return canonicalSourceUrl(input)
}

function stableId(value: unknown, label: string): string {
  const id = requiredText(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new TypeError(`${label} must use 1-64 letters, digits, dot, underscore, or hyphen`)
  }
  return id
}

function parseSources(
  value: unknown,
  existing: readonly RavenSourceRecord[],
  inspectedAt: string,
): RavenSourceRecord[] {
  const byId = new Map(existing.map(source => [source.sourceId, source]))
  const idByUrl = new Map(existing.map(source => [source.url, source.sourceId]))
  for (const raw of optionalArray(value, 'sources')) {
    const input = record(raw, 'source')
    assertOnlyKeys(input, [
      'sourceId', 'url', 'title', 'locator', 'excerpt', 'role', 'sourceFamily', 'asOf',
    ], 'source')
    const sourceId = stableId(input.sourceId, 'source.sourceId')
    const url = canonicalUrl(input.url)
    const otherId = idByUrl.get(url)
    if (otherId !== undefined && otherId !== sourceId) {
      throw new Error(`source URL ${url} is already registered as ${otherId}`)
    }
    const current = byId.get(sourceId)
    if (current !== undefined && current.url !== url) {
      throw new Error(`source ID ${sourceId} is already bound to ${current.url}`)
    }
    const sourceFamily = optionalBoundedText(input.sourceFamily, 'source.sourceFamily', RAVEN_LIMITS.sourceFamilyChars)
    const asOf = optionalBoundedText(input.asOf, 'source.asOf', RAVEN_LIMITS.sourceAsOfChars)
    const next: RavenSourceRecord = {
      sourceId,
      url,
      title: boundedText(input.title, 'source.title', RAVEN_LIMITS.sourceTitleChars),
      locator: boundedText(input.locator, 'source.locator', RAVEN_LIMITS.sourceLocatorChars),
      excerpt: boundedText(input.excerpt, 'source.excerpt', RAVEN_LIMITS.sourceExcerptChars),
      role: input.role === undefined
        ? 'secondary'
        : member<SourceRole>(input.role, SOURCE_ROLES, 'source.role'),
      ...(sourceFamily === undefined ? {} : { sourceFamily }),
      ...(asOf === undefined ? {} : { asOf }),
      inspectedAt,
      check: { status: 'unchecked' },
    }
    if (current !== undefined) {
      const sameEvidence = current.url === next.url
        && current.title === next.title
        && current.locator === next.locator
        && current.excerpt === next.excerpt
        && current.role === next.role
        && current.sourceFamily === next.sourceFamily
        && current.asOf === next.asOf
      if (!sameEvidence) {
        throw new Error(`source ID ${sourceId} cannot be rewritten; register changed evidence under a new Source ID`)
      }
      byId.set(sourceId, current)
    } else {
      byId.set(sourceId, next)
    }
    idByUrl.set(url, sourceId)
  }
  if (byId.size > RAVEN_LIMITS.sources) {
    throw new Error(`Raven Task may retain at most ${RAVEN_LIMITS.sources} Sources`)
  }
  return [...byId.values()]
}

function parseClaims(
  value: unknown,
  existing: readonly RavenClaimRecord[],
  knownSourceIds: ReadonlySet<string>,
): RavenClaimRecord[] {
  const byId = new Map(existing.map(claim => [claim.claimId, claim]))
  for (const raw of optionalArray(value, 'claims')) {
    const input = record(raw, 'claim')
    assertOnlyKeys(input, ['claimId', 'text', 'kind', 'importance', 'disposition', 'sourceIds'], 'claim')
    const claimId = stableId(input.claimId, 'claim.claimId')
    const text = boundedText(input.text, 'claim.text', RAVEN_LIMITS.claimTextChars)
    const current = byId.get(claimId)
    if (current !== undefined && current.text !== text) {
      throw new Error(`claim ID ${claimId} cannot be reused for different text`)
    }
    const sourceIds = optionalArray(input.sourceIds, 'claim.sourceIds')
      .map(sourceId => stableId(sourceId, 'claim.sourceIds[]'))
    if (sourceIds.length > RAVEN_LIMITS.sources) {
      throw new Error(`claim.sourceIds may contain at most ${RAVEN_LIMITS.sources} Source IDs`)
    }
    if (new Set(sourceIds).size !== sourceIds.length) {
      throw new Error(`claim ${claimId} contains duplicate Source IDs`)
    }
    for (const sourceId of sourceIds) {
      if (!knownSourceIds.has(sourceId)) throw new Error(`claim ${claimId} references unknown source ${sourceId}`)
    }
    const kind = member<ClaimKind>(input.kind, CLAIM_KINDS, 'claim.kind')
    const importance = member<ClaimImportance>(input.importance, CLAIM_IMPORTANCE, 'claim.importance')
    const disposition = member<ClaimDisposition>(input.disposition, CLAIM_DISPOSITIONS, 'claim.disposition')
    if (kind === 'external' && (disposition === 'supported' || disposition === 'qualified') && sourceIds.length === 0) {
      throw new Error(`external claim ${claimId} requires at least one source`)
    }
    byId.set(claimId, { claimId, text, kind, importance, disposition, sourceIds })
  }
  if (byId.size > RAVEN_LIMITS.claims) {
    throw new Error(`Raven Task may retain at most ${RAVEN_LIMITS.claims} Claims`)
  }
  return [...byId.values()]
}

function parseLimitations(
  value: unknown,
  existing: readonly RavenLimitation[],
  knownSourceIds: ReadonlySet<string>,
  createdAt: string,
): RavenLimitation[] {
  const next = [...existing]
  for (const raw of optionalArray(value, 'failures')) {
    const input = record(raw, 'failure')
    assertOnlyKeys(input, ['kind', 'detail', 'sourceId'], 'failure')
    const kind = member<RavenLimitationKind>(input.kind, LIMITATION_KINDS, 'failure.kind')
    const detail = boundedText(input.detail, 'failure.detail', RAVEN_LIMITS.limitationDetailChars)
    const sourceId = input.sourceId === undefined
      ? undefined
      : stableId(input.sourceId, 'failure.sourceId')
    if (sourceId !== undefined && !knownSourceIds.has(sourceId)) {
      throw new Error(`failure references unknown source ${sourceId}`)
    }
    const duplicate = next.some(item => item.kind === kind
      && item.detail === detail
      && item.sourceId === sourceId)
    if (duplicate) continue
    next.push({
      limitationId: `${kind}-${next.length + 1}`,
      kind,
      detail,
      ...(sourceId === undefined ? {} : { sourceId }),
      createdAt,
    })
  }
  if (next.length > RAVEN_LIMITS.limitations) {
    throw new Error(`Raven Task may retain at most ${RAVEN_LIMITS.limitations} Limitations`)
  }
  return next
}

function propagateSourceChecks(
  claims: readonly RavenClaimRecord[],
  limitations: readonly RavenLimitation[],
  sources: readonly RavenSourceRecord[],
  createdAt: string,
): { claims: RavenClaimRecord[]; limitations: RavenLimitation[] } {
  const checkById = new Map(sources.map(source => [source.sourceId, source.check]))
  const propagatedClaims = claims.map((claim): RavenClaimRecord => {
    if (claim.kind !== 'external'
      || (claim.disposition !== 'supported' && claim.disposition !== 'qualified')) return claim
    const hasUsableSupport = claim.sourceIds.some(sourceId => checkById.get(sourceId)?.status === 'reachable')
    return hasUsableSupport ? claim : { ...claim, disposition: 'deferred' }
  })
  const propagatedLimitations = [...limitations]
  for (const source of sources) {
    if (source.check.status === 'unchecked' || source.check.status === 'reachable') continue
    if (propagatedLimitations.some(item => item.kind === 'source' && item.sourceId === source.sourceId)) continue
    if (propagatedLimitations.length >= RAVEN_LIMITS.limitations) {
      throw new Error(`Raven Task may retain at most ${RAVEN_LIMITS.limitations} Limitations`)
    }
    propagatedLimitations.push({
      limitationId: `source-${propagatedLimitations.length + 1}`,
      kind: 'source',
      sourceId: source.sourceId,
      detail: `Source ${source.sourceId} failed verification: ${source.check.detail ?? source.check.status}`,
      createdAt,
    })
  }
  return { claims: propagatedClaims, limitations: propagatedLimitations }
}

function citationIds(artifact: string): string[] {
  return [...artifact.matchAll(/\[@([A-Za-z0-9][A-Za-z0-9._-]{0,63})\]/g)]
    .map(match => match[1])
    .filter((id): id is string => id !== undefined)
}

function validateArtifactCitations(
  artifact: string,
  sources: readonly RavenSourceRecord[],
  claims: readonly RavenClaimRecord[],
): void {
  const cited = new Set(citationIds(artifact))
  const known = new Set(sources.map(source => source.sourceId))
  for (const sourceId of cited) {
    if (!known.has(sourceId)) throw new Error(`artifact cites unknown source ${sourceId}`)
  }
  const knownUrls = new Set(sources.map(source => source.url))
  for (const match of artifact.matchAll(/https?:\/\/[^\s<>\]]+/g)) {
    const rawUrl = match[0].replace(/[),.;!?]+$/, '')
    let url: string
    try {
      url = new URL(rawUrl).href
    } catch {
      throw new Error(`artifact contains invalid external URL ${rawUrl}`)
    }
    if (!knownUrls.has(url)) throw new Error(`artifact contains unregistered external URL ${rawUrl}`)
  }
  for (const claim of claims) {
    if (claim.kind !== 'external' || claim.importance !== 'material') continue
    if (claim.disposition !== 'supported' && claim.disposition !== 'qualified') continue
    if (!claim.sourceIds.some(sourceId => cited.has(sourceId))) {
      throw new Error(`material claim ${claim.claimId} has no source citation in the artifact`)
    }
  }
}

function relevantSources(
  artifact: string,
  sources: readonly RavenSourceRecord[],
  claims: readonly RavenClaimRecord[],
): RavenSourceRecord[] {
  const relevantIds = new Set(citationIds(artifact))
  for (const claim of claims) {
    if (claim.kind !== 'external' || claim.importance !== 'material') continue
    if (claim.disposition !== 'supported' && claim.disposition !== 'qualified') continue
    for (const sourceId of claim.sourceIds) relevantIds.add(sourceId)
  }
  return sources.filter(source => relevantIds.has(source.sourceId))
}

function settleWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
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

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replaceAll(/\s+/g, ' ').slice(0, 300)
}

function validatedVerifierResults(
  selected: readonly RavenSourceRecord[],
  value: unknown,
): SourceCheckResult[] {
  if (!Array.isArray(value)) throw new Error('source verifier protocol response must be an array')
  const expected = new Set(selected.map(source => source.sourceId))
  const requestedById = new Map(selected.map(source => [source.sourceId, source]))
  const seen = new Set<string>()
  const results: SourceCheckResult[] = []
  for (const raw of value) {
    const result = record(raw, 'source verifier result')
    assertOnlyKeys(result, ['sourceId', 'status', 'checkedAt', 'statusCode', 'resolvedUrl', 'detail'], 'source verifier result')
    const sourceId = requiredText(result.sourceId, 'source verifier result.sourceId')
    if (!expected.has(sourceId)) throw new Error(`source verifier protocol returned unknown source ${sourceId}`)
    if (seen.has(sourceId)) throw new Error(`source verifier protocol returned duplicate source ${sourceId}`)
    seen.add(sourceId)
    const status = member(result.status, ['reachable', 'failed', 'unavailable'] as const, 'source verifier result.status')
    const resultCheckedAt = requiredText(result.checkedAt, 'source verifier result.checkedAt')
    if (!Number.isFinite(Date.parse(resultCheckedAt))) {
      throw new Error(`source verifier protocol returned invalid checkedAt for ${sourceId}`)
    }
    let statusCode: number | undefined
    if (result.statusCode !== undefined) {
      if (!Number.isSafeInteger(result.statusCode)
        || (result.statusCode as number) < 100
        || (result.statusCode as number) > 599) {
        throw new Error(`source verifier protocol returned invalid statusCode for ${sourceId}`)
      }
      statusCode = result.statusCode as number
    }
    let resolvedUrl: string | undefined
    if (result.resolvedUrl !== undefined) resolvedUrl = canonicalUrl(result.resolvedUrl)
    const detail = optionalBoundedText(result.detail, 'source verifier result.detail', RAVEN_LIMITS.limitationDetailChars)
    if (status !== 'unavailable' && (statusCode === undefined || resolvedUrl === undefined)) {
      throw new Error(`source verifier protocol omitted HTTP identity for ${sourceId}`)
    }
    if (status === 'reachable' && (statusCode === undefined || statusCode < 200 || statusCode >= 400)) {
      throw new Error(`source verifier protocol marked non-success HTTP status reachable for ${sourceId}`)
    }
    const requested = requestedById.get(sourceId)
    if (status === 'reachable'
      && resolvedUrl !== undefined
      && requested !== undefined
      && !sameSourceIdentity(requested.url, resolvedUrl)) {
      throw new Error(`source verifier protocol marked a cross-host redirect reachable for ${sourceId}`)
    }
    if (status !== 'reachable' && detail === undefined) {
      throw new Error(`source verifier protocol omitted failure detail for ${sourceId}`)
    }
    results.push({
      sourceId,
      status,
      checkedAt: resultCheckedAt,
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(resolvedUrl === undefined ? {} : { resolvedUrl }),
      ...(detail === undefined ? {} : { detail }),
    })
  }
  const missing = [...expected].filter(sourceId => !seen.has(sourceId))
  if (missing.length > 0) throw new Error(`source verifier protocol omitted source(s): ${missing.join(', ')}`)
  return results
}

async function checkSources(
  verifier: SourceVerifier,
  allSources: readonly RavenSourceRecord[],
  selected: readonly RavenSourceRecord[],
  artifactSha256: string,
  checkedAt: string,
  signal: AbortSignal,
): Promise<{ sources: RavenSourceRecord[]; receipt: RavenVerificationReceipt }> {
  let observed: readonly SourceCheckResult[]
  try {
    const raw: unknown = await settleWithAbort(verifier.verify(selected.map(source => ({
      sourceId: source.sourceId,
      url: source.url,
      locator: source.locator,
      excerpt: source.excerpt,
    })), signal), signal)
    try {
      observed = validatedVerifierResults(selected, raw)
    } catch (error) {
      throw new Error(`source verifier protocol error: ${compactError(error)}`, { cause: error })
    }
  } catch (error) {
    signal.throwIfAborted()
    const message = compactError(error)
    const detail = message.includes('source verifier protocol')
      ? message
      : `source verifier unavailable: ${message}`
    observed = selected.map(source => ({
      sourceId: source.sourceId,
      status: 'unavailable' as const,
      checkedAt,
      detail,
    }))
  }
  signal.throwIfAborted()
  const byId = new Map(observed.map(result => [result.sourceId, result]))
  const selectedIds = new Set(selected.map(source => source.sourceId))
  const sources = allSources.map((source): RavenSourceRecord => {
    if (!selectedIds.has(source.sourceId)) return source
    const result = byId.get(source.sourceId)
    const check: RavenSourceCheck = result === undefined
      ? { status: 'unavailable', checkedAt, detail: 'source verifier returned no result' }
      : {
          status: result.status,
          checkedAt: result.checkedAt,
          ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
          ...(result.resolvedUrl === undefined ? {} : { resolvedUrl: result.resolvedUrl }),
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        }
    return { ...source, check }
  })
  const checks = sources.filter(source => selectedIds.has(source.sourceId)).map(source => source.check)
  const reachable = checks.filter(check => check.status === 'reachable').length
  const failed = checks.filter(check => check.status === 'failed').length
  const unavailable = checks.filter(check => check.status === 'unavailable').length
  return {
    sources,
    receipt: {
      verifiedAt: checkedAt,
      mode: selected.length > 0 && reachable + failed > 0 ? 'remote' : 'structural-only',
      checked: selected.length,
      reachable,
      failed,
      unavailable,
      artifactSha256,
    },
  }
}

function markdownText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_[\]{}()#+.!|-])/g, '\\$1')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

export function renderArtifact(
  artifact: string,
  sources: readonly RavenSourceRecord[],
  claims: readonly RavenClaimRecord[] = [],
): string {
  const byId = new Map(sources.map(source => [source.sourceId, source]))
  const used: string[] = []
  const rendered = artifact.replace(/\[@([A-Za-z0-9][A-Za-z0-9._-]{0,63})\]/g, (_token, sourceId: string) => {
    const source = byId.get(sourceId)
    if (source === undefined) return `[@${sourceId}]`
    if (source.check.status !== 'reachable') {
      return `[${markdownText(source.title)} — ${source.check.status}]`
    }
    if (!used.includes(sourceId)) used.push(sourceId)
    return `[${markdownText(source.title)}](${source.url.replaceAll(')', '%29')})`
  })
  const sections = [rendered]
  if (used.length > 0) {
    const lines = used.map((sourceId) => {
      const source = byId.get(sourceId)
      if (source === undefined) throw new Error(`source ${sourceId} disappeared during rendering`)
      return `- [${sourceId}] [${markdownText(source.title)}](${source.url.replaceAll(')', '%29')}) — ${markdownText(source.locator)}`
    })
    sections.push(`## Sources\n${lines.join('\n')}`)
  }
  const traced = claims.filter(claim => claim.kind === 'external'
    && claim.importance === 'material'
    && (claim.disposition === 'supported' || claim.disposition === 'qualified'))
  if (traced.length > 0) {
    const lines = traced.map((claim) => {
      const links = claim.sourceIds.map((sourceId) => {
        const source = byId.get(sourceId)
        if (source === undefined) throw new Error(`claim ${claim.claimId} lost source ${sourceId} during rendering`)
        return `[${sourceId}](${source.url.replaceAll(')', '%29')})`
      })
      return `- **${claim.claimId}**: ${markdownText(claim.text)} — ${links.join(', ')}`
    })
    sections.push(`## Claim trace\n${lines.join('\n')}`)
  }
  return sections.join('\n\n')
}

export function createRavenEngine(options: RavenEngineOptions): RavenEngine {
  return {
    async dispatch(previous, input, execution) {
      execution.signal.throwIfAborted()
      const args = record(input, 'Raven action')
      const action = requiredText(args.action, 'action')
      const allowedFields = ACTION_FIELDS[action]
      if (allowedFields === undefined) throw new TypeError(`Unsupported Raven action: ${action}`)
      assertOnlyKeys(args, allowedFields, `Raven ${action} action`)

      if (action === 'start') {
        if (previous?.phase === 'active') {
          throw new Error(`Raven Task ${previous.taskId} is already active`)
        }
        const outcome = member<RavenOutcome>(args.outcome, OUTCOMES, 'outcome')
        const request = boundedText(args.request, 'request', RAVEN_LIMITS.requestChars)
        const grounding = args.grounding === undefined
          ? defaultGrounding(outcome)
          : member<GroundingPolicy>(args.grounding, GROUNDING_POLICIES, 'grounding')
        const ordinal = (previous?.ordinal ?? 0) + 1
        const at = options.now()
        const state: RavenTaskState = {
          schemaVersion: 1,
          taskId: taskId(execution.sessionId, ordinal),
          ordinal,
          outcome,
          request,
          grounding,
          phase: 'active',
          revision: 1,
          steeringRevision: 0,
          steering: [],
          checkpoints: [],
          sources: [],
          claims: [],
          limitations: [],
          latestArtifact: null,
          verification: null,
          finalArtifactSha256: null,
          startedAt: at,
          updatedAt: at,
        }
        return {
          status: 'active',
          state,
          message: `Started Raven Task ${state.taskId} for ${state.outcome}.`,
          issues: [],
        }
      }

      if (action === 'status') {
        if (previous === null) throw new Error('No Raven Task exists in this session')
        if (args.taskId !== undefined && requiredText(args.taskId, 'taskId') !== previous.taskId) {
          throw new Error(`Raven Task ${String(args.taskId)} was not found in this session`)
        }
        return {
          status: previous.phase,
          state: previous,
          message: `Raven Task ${previous.taskId} is ${previous.phase}.`,
          issues: [],
        }
      }

      if (action === 'stop') {
        const state = requireTask(previous, args.taskId)
        if (state.phase === 'stopped') {
          return {
            status: 'stopped',
            state,
            message: `Raven Task ${state.taskId} is already stopped; its Checkpoints and evidence remain available.`,
            issues: [],
          }
        }
        if (state.phase !== 'active') throw new Error(`Raven Task ${state.taskId} is ${state.phase}`)
        if (args.reason !== undefined) boundedText(args.reason, 'reason', RAVEN_LIMITS.limitationDetailChars)
        const next: RavenTaskState = {
          ...state,
          phase: 'stopped',
          revision: state.revision + 1,
          updatedAt: options.now(),
        }
        return {
          status: 'stopped',
          state: next,
          message: `Stopped Raven Task ${state.taskId}; its identity, Checkpoints, evidence, and Artifact are preserved.`,
          issues: [],
          ...(state.latestArtifact === null
            ? {}
            : { renderedArtifact: renderArtifact(state.latestArtifact, state.sources, state.claims) }),
        }
      }

      if (action === 'resume') {
        const state = requireTask(previous, args.taskId)
        if (state.phase === 'active') {
          return {
            status: 'active',
            state,
            message: `Raven Task ${state.taskId} is already active.`,
            issues: [],
          }
        }
        if (state.phase !== 'stopped') throw new Error(`Raven Task ${state.taskId} is ${state.phase}`)
        const next: RavenTaskState = {
          ...state,
          phase: 'active',
          revision: state.revision + 1,
          updatedAt: options.now(),
        }
        return {
          status: 'active',
          state: next,
          message: `Resumed Raven Task ${state.taskId} from its preserved Checkpoint.`,
          issues: [],
        }
      }

      if (action === 'steer') {
        const state = requireActiveTask(previous, args.taskId)
        const correction = boundedText(args.correction, 'correction', RAVEN_LIMITS.correctionChars)
        if (state.steering.length >= RAVEN_LIMITS.steeringRevisions) {
          throw new Error(`Raven Task may retain at most ${RAVEN_LIMITS.steeringRevisions} Steering Revisions`)
        }
        const at = options.now()
        const steeringRevision = state.steeringRevision + 1
        const next: RavenTaskState = {
          ...state,
          revision: state.revision + 1,
          steeringRevision,
          steering: [...state.steering, { revision: steeringRevision, correction, createdAt: at }],
          verification: null,
          finalArtifactSha256: null,
          updatedAt: at,
        }
        return {
          status: 'active',
          state: next,
          message: `Applied Steering Revision ${steeringRevision} to Raven Task ${state.taskId}; continue the same Task.`,
          issues: [],
        }
      }

      if (action === 'checkpoint') {
        const state = requireActiveTask(previous, args.taskId)
        if (state.checkpoints.length >= RAVEN_LIMITS.checkpoints) {
          throw new Error(`Raven Task may retain at most ${RAVEN_LIMITS.checkpoints} Checkpoints`)
        }
        const at = options.now()
        const stage = member<RavenStage>(args.stage, RAVEN_STAGES, 'stage')
        const summary = boundedText(args.summary, 'summary', RAVEN_LIMITS.summaryChars)
        const artifact = boundedText(args.artifact, 'artifact', RAVEN_LIMITS.artifactChars)
        const artifactSha256 = sha256(artifact)
        const parsedSources = parseSources(args.sources, state.sources, at)
        const knownSourceIds = new Set(parsedSources.map(source => source.sourceId))
        const claims = parseClaims(args.claims, state.claims, knownSourceIds)
        const limitations = parseLimitations(args.failures, state.limitations, knownSourceIds, at)
        validateArtifactCitations(artifact, parsedSources, claims)
        const relevant = relevantSources(artifact, parsedSources, claims)
        const verified = await checkSources(
          options.sourceVerifier,
          parsedSources,
          relevant,
          artifactSha256,
          at,
          execution.signal,
        )
        const unverified = verified.sources.filter(source => relevant.some(candidate => candidate.sourceId === source.sourceId)
          && source.check.status !== 'reachable')
        if (unverified.length > 0) {
          const verifiedById = new Map(verified.sources.map(source => [source.sourceId, source]))
          const existingSources = state.sources.map(source => verifiedById.get(source.sourceId) ?? source)
          const existingFailure = existingSources.some(source => source.check.status !== 'unchecked'
            && source.check.status !== 'reachable')
          const propagated = propagateSourceChecks(state.claims, state.limitations, existingSources, at)
          const checkedState: RavenTaskState = existingFailure
            ? {
                ...state,
                revision: state.revision + 1,
                sources: existingSources,
                claims: propagated.claims,
                limitations: propagated.limitations,
                verification: null,
                finalArtifactSha256: null,
                updatedAt: at,
              }
            : state
          return {
            status: 'needs-revision',
            state: checkedState,
            message: `Raven Task ${state.taskId} cannot publish an externally grounded Checkpoint yet.`,
            issues: unverified.map((source) => {
              const detail = source.check.status === 'unchecked'
                ? 'source was not checked'
                : source.check.detail ?? `source check was ${source.check.status}`
              return `source ${source.sourceId} failed evidence verification: ${detail}`
            }),
          }
        }
        const sources = verified.sources
        const ordinal = state.checkpoints.length + 1
        const next: RavenTaskState = {
          ...state,
          revision: state.revision + 1,
          checkpoints: [...state.checkpoints, {
            checkpointId: `${state.taskId}-cp-${ordinal}`,
            ordinal,
            stage,
            summary,
            artifactSha256,
            artifactChars: artifact.length,
            steeringRevision: state.steeringRevision,
            createdAt: at,
          }],
          sources,
          claims,
          limitations,
          latestArtifact: artifact,
          verification: null,
          finalArtifactSha256: null,
          updatedAt: at,
        }
        return {
          status: 'active',
          state: next,
          message: `Published Raven Checkpoint ${ordinal} for ${state.taskId}; the Task remains active.`,
          issues: [],
          renderedArtifact: renderArtifact(artifact, sources, claims),
        }
      }

      if (action === 'complete') {
        const state = requireActiveTask(previous, args.taskId)
        const artifact = boundedText(args.artifact, 'artifact', RAVEN_LIMITS.artifactChars)
        const artifactSha256 = sha256(artifact)
        const issues: string[] = []
        if (state.checkpoints.length === 0) issues.push('publish at least one useful Checkpoint before Completion')
        if (state.checkpoints.length >= RAVEN_LIMITS.checkpoints) {
          issues.push(`Completion needs one final Checkpoint slot; the limit is ${RAVEN_LIMITS.checkpoints}`)
        }
        const latestCheckpoint = state.checkpoints.at(-1)
        if (latestCheckpoint !== undefined && latestCheckpoint.steeringRevision !== state.steeringRevision) {
          issues.push('publish a Checkpoint that applies the latest Steering Revision before Completion')
        }
        if (latestCheckpoint !== undefined && latestCheckpoint.artifactSha256 !== artifactSha256) {
          issues.push('the exact latest Checkpoint Artifact must be completed; publish substantive final edits as a new Checkpoint first')
        }
        try {
          validateArtifactCitations(artifact, state.sources, state.claims)
        } catch (error) {
          issues.push(compactError(error))
        }
        const checkBySourceId = new Map(state.sources.map(source => [source.sourceId, source.check]))
        const verifiedMaterialClaims = state.claims.filter(claim => claim.kind === 'external'
          && claim.importance === 'material'
          && (claim.disposition === 'supported' || claim.disposition === 'qualified')
          && claim.sourceIds.some(sourceId => checkBySourceId.get(sourceId)?.status === 'reachable'))
        if (state.grounding === 'required' && verifiedMaterialClaims.length === 0) {
          issues.push('grounding-required Completion needs at least one verified material external Claim; zero valid research remains active')
        }
        if (issues.length > 0) {
          return {
            status: 'needs-revision',
            state,
            message: `Raven Task ${state.taskId} is not ready for Completion.`,
            issues,
          }
        }

        const at = options.now()
        const relevant = relevantSources(artifact, state.sources, state.claims)
        const verified = await checkSources(
          options.sourceVerifier,
          state.sources,
          relevant,
          artifactSha256,
          at,
          execution.signal,
        )
        const unusable = verified.sources.filter(source => relevant.some(candidate => candidate.sourceId === source.sourceId)
          && source.check.status !== 'reachable')
        if (unusable.length > 0) {
          const propagated = propagateSourceChecks(state.claims, state.limitations, verified.sources, at)
          const checkedState: RavenTaskState = {
            ...state,
            revision: state.revision + 1,
            sources: verified.sources,
            claims: propagated.claims,
            limitations: propagated.limitations,
            verification: verified.receipt,
            finalArtifactSha256: null,
            updatedAt: at,
          }
          return {
            status: 'needs-revision',
            state: checkedState,
            message: `Raven Task ${state.taskId} has broken or unverifiable Source references.`,
            issues: unusable.map((source) => {
              const detail = source.check.status === 'unchecked'
                ? 'source was not checked'
                : source.check.detail ?? `source check was ${source.check.status}`
              return `source ${source.sourceId} failed remote verification: ${detail}`
            }),
          }
        }

        const hasDeferredClaims = state.claims.some(claim => claim.disposition === 'deferred')
        const phase = verified.receipt.unavailable > 0 || state.limitations.length > 0 || hasDeferredClaims
          ? 'completed-with-limits'
          : 'completed'
        const ordinal = state.checkpoints.length + 1
        const completed: RavenTaskState = {
          ...state,
          phase,
          revision: state.revision + 1,
          checkpoints: [...state.checkpoints, {
            checkpointId: `${state.taskId}-cp-${ordinal}`,
            ordinal,
            stage: 'verify',
            summary: phase === 'completed' ? 'Verified final Artifact.' : 'Final Artifact with verification limits.',
            artifactSha256,
            artifactChars: artifact.length,
            steeringRevision: state.steeringRevision,
            createdAt: at,
          }],
          sources: verified.sources,
          latestArtifact: artifact,
          verification: verified.receipt,
          finalArtifactSha256: artifactSha256,
          updatedAt: at,
        }
        return {
          status: phase,
          state: completed,
          message: phase === 'completed'
            ? `Completed Raven Task ${state.taskId} with verified Source references.`
            : `Completed Raven Task ${state.taskId} with explicit verification limits.`,
          issues: phase === 'completed'
            ? []
            : [
                ...state.limitations.map(item => item.detail),
                ...(verified.receipt.unavailable === 0
                  ? []
                  : [`${verified.receipt.unavailable} Source reference(s) could not be remotely verified`]),
                ...(hasDeferredClaims ? ['one or more Claims remain deferred'] : []),
              ],
          renderedArtifact: renderArtifact(artifact, verified.sources, state.claims),
        }
      }

      throw new TypeError(`Unsupported Raven action: ${action}`)
    },
  }
}
