import {
  type RavenClaimRecord,
  type RavenInsightCandidate,
  type RavenInsightRecall,
  type RavenSynthesisRound,
  type SummaryDebtLevel,
  type SynthesisPurpose,
} from './domain.js'

export function acceptedAnalysisPremise(claim: RavenClaimRecord): boolean {
  return claim.disposition === 'supported' || claim.disposition === 'qualified'
}

/** Build the symmetric competition relation while preserving durable Candidate order. */
export function insightCompetitionMap(
  candidates: readonly RavenInsightCandidate[],
): ReadonlyMap<string, readonly string[]> {
  const competitors = new Map(candidates.map(candidate => [candidate.insightId, [] as string[]]))
  for (const candidate of candidates) {
    const own = competitors.get(candidate.insightId)
    if (own === undefined) continue
    for (const otherId of candidate.competesWith ?? []) {
      if (!own.includes(otherId)) own.push(otherId)
      const other = competitors.get(otherId)
      if (other !== undefined && !other.includes(candidate.insightId)) other.push(candidate.insightId)
    }
  }
  return competitors
}

/** Return one bounded page of unpromoted Candidate IDs for status and replay context. */
export function insightCandidateRecall(
  claims: readonly RavenClaimRecord[],
  candidates: readonly RavenInsightCandidate[],
  limit: number,
  insightOffset = 0,
): RavenInsightRecall {
  const promoted = new Set(claims
    .map(claim => claim.insightId)
    .filter((insightId): insightId is string => insightId !== undefined))
  const unpromoted = candidates.filter(candidate => !promoted.has(candidate.insightId))
  const unpromotedInsightIds = unpromoted
    .slice(insightOffset, insightOffset + Math.max(0, limit))
    .map(candidate => candidate.insightId)
  const nextInsightOffset = insightOffset + unpromotedInsightIds.length
  return {
    unpromotedInsightIds,
    totalUnpromoted: unpromoted.length,
    insightOffset,
    nextInsightOffset: nextInsightOffset < unpromoted.length ? nextInsightOffset : null,
  }
}

/** Only a later synthesis-purpose pass over the same scope can clear its debt. */
export function outstandingSummaryDebt(
  rounds: readonly RavenSynthesisRound[],
): RavenSynthesisRound[] {
  const latestByScope = new Map<string, RavenSynthesisRound>()
  for (const round of rounds) {
    if (round.purpose === 'synthesis') latestByScope.set(round.scope, round)
  }
  return [...latestByScope.values()]
    .filter(round => round.summaryDebt !== 'none')
    .sort((left, right) => left.ordinal - right.ordinal)
}

/**
 * Append one pass without evicting the newest pass or any scope's outstanding debt.
 *
 * Protection is computed after the append: a debt-free synthesis over the same scope
 * supersedes its debt record, while summary and explanation passes deliberately do not.
 */
export function appendBoundedSynthesisRound(
  rounds: readonly RavenSynthesisRound[],
  next: RavenSynthesisRound,
  limit: number,
): RavenSynthesisRound[] | undefined {
  const bounded = [...rounds, next]
  while (bounded.length > limit) {
    const protectedRounds = new Set(outstandingSummaryDebt(bounded))
    const newest = bounded.at(-1)
    if (newest !== undefined) protectedRounds.add(newest)
    const evictionIndex = bounded.findIndex(round => !protectedRounds.has(round))
    if (evictionIndex === -1) return undefined
    bounded.splice(evictionIndex, 1)
  }
  return bounded
}

/**
 * Propagate premise authority through promoted analysis without changing Claim order.
 *
 * A dependent queue avoids rescanning the entire Claim set for each lineage level.
 * Claims may restore and later defer in one pass when an upstream Claim is processed
 * after them, so dependents are requeued only when their premise disposition changes.
 */
export function propagateAnalysisPremiseDispositions(
  claims: readonly RavenClaimRecord[],
): { readonly claims: RavenClaimRecord[]; readonly changed: boolean } {
  const next = [...claims]
  const indexById = new Map(next.map((claim, index) => [claim.claimId, index]))
  const dependents = new Map<string, string[]>()
  const queue: string[] = []
  const queued = new Set<string>()

  for (const claim of next) {
    if (claim.kind !== 'analysis' || claim.insightId === undefined) continue
    queue.push(claim.claimId)
    queued.add(claim.claimId)
    for (const premiseId of claim.derivedFromClaimIds ?? []) {
      const existing = dependents.get(premiseId)
      if (existing === undefined) dependents.set(premiseId, [claim.claimId])
      else existing.push(claim.claimId)
    }
  }

  let changed = false
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const claimId = queue[cursor]
    if (claimId === undefined) continue
    queued.delete(claimId)
    const index = indexById.get(claimId)
    if (index === undefined) continue
    const claim = next[index]
    if (claim === undefined || claim.kind !== 'analysis' || claim.insightId === undefined) continue
    const premiseIds = claim.derivedFromClaimIds ?? []
    const usable = premiseIds.length > 0 && premiseIds.every((premiseId) => {
      const premiseIndex = indexById.get(premiseId)
      const premise = premiseIndex === undefined ? undefined : next[premiseIndex]
      return premise !== undefined && acceptedAnalysisPremise(premise)
    })

    let replacement: RavenClaimRecord | undefined
    if (claim.disposition === 'deferred' && claim.deferredFrom !== undefined && usable) {
      const { deferredFrom, ...restored } = claim
      replacement = { ...restored, disposition: deferredFrom }
    } else if ((claim.disposition === 'supported' || claim.disposition === 'qualified') && !usable) {
      replacement = { ...claim, disposition: 'deferred', deferredFrom: claim.disposition }
    }
    if (replacement === undefined) continue

    next[index] = replacement
    changed = true
    for (const dependentId of dependents.get(claimId) ?? []) {
      if (queued.has(dependentId)) continue
      queue.push(dependentId)
      queued.add(dependentId)
    }
  }

  return { claims: next, changed }
}

/** Return the first analysis Claim encountered twice on one lineage path, if any. */
export function analysisLineageCycle(claims: readonly RavenClaimRecord[]): string | undefined {
  const byId = new Map(claims.map(claim => [claim.claimId, claim]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (claimId: string): string | undefined => {
    if (visited.has(claimId)) return undefined
    if (visiting.has(claimId)) return claimId
    const claim = byId.get(claimId)
    if (claim === undefined || claim.kind !== 'analysis') return undefined
    visiting.add(claimId)
    for (const premiseId of claim.derivedFromClaimIds ?? []) {
      const cycle = visit(premiseId)
      if (cycle !== undefined) return cycle
    }
    visiting.delete(claimId)
    visited.add(claimId)
    return undefined
  }

  for (const claim of claims) {
    const cycle = visit(claim.claimId)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

export function assessSummaryDebt(
  purpose: SynthesisPurpose,
  scope: string,
  claims: readonly RavenClaimRecord[],
  candidates: readonly RavenInsightCandidate[],
): { readonly level: SummaryDebtLevel; readonly detail: string } {
  if (purpose !== 'synthesis') {
    return {
      level: 'none',
      detail: purpose === 'summary'
        ? `No summary debt for ${scope}: the user explicitly requested summary rather than novel synthesis.`
        : `No summary debt for ${scope}: explanation, not novelty, is the goal.`,
    }
  }
  if (claims.some(claim => claim.kind === 'analysis' && acceptedAnalysisPremise(claim))) {
    return { level: 'none', detail: `No summary debt for ${scope}: accepted analysis is already present in the assessed Claim set.` }
  }
  if (candidates.length === 0) {
    return {
      level: 'high',
      detail: `High summary debt in ${scope}: the section organizes or restates evidence but records no interpretation, explanation, connection, or implication.`,
    }
  }
  const claimById = new Map(claims.map(claim => [claim.claimId, claim]))
  const traceable = candidates.some(candidate => candidate.claimIds.every((claimId) => {
    const claim = claimById.get(claimId)
    return claim !== undefined && acceptedAnalysisPremise(claim)
  }))
  if (!traceable) {
    return {
      level: 'low',
      detail: `Low summary debt in ${scope}: interpretive candidates exist, but none has fully usable Claim lineage yet.`,
    }
  }
  return {
    level: 'none',
    detail: `No summary debt in ${scope}: at least one interpretation has explicit, currently usable Claim lineage.`,
  }
}
