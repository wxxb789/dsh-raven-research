import { describe, expect, it } from 'vitest'

import { decodeRavenTaskState } from '../../src/codec.js'
import { createRavenEngine, renderArtifact, renderSynthesis } from '../../src/engine.js'
import type { RavenTaskState, SourceVerifier } from '../../src/domain.js'
import { wikiConfidence } from '../../src/wiki.js'

const now = () => '2026-08-30T12:00:00.000Z'
const signal = new AbortController().signal
const sourceVerifier: SourceVerifier = {
  verify: async sources => sources.map(source => ({
    sourceId: source.sourceId,
    status: 'reachable' as const,
    checkedAt: now(),
    statusCode: 200,
    resolvedUrl: source.url,
  })),
}

function source(sourceId: string) {
  return {
    sourceId,
    url: `https://evidence.test/${sourceId.toLowerCase()}`,
    title: `Evidence ${sourceId}`,
    locator: `Section ${sourceId}`,
    excerpt: `Exact evidence for ${sourceId}`,
    role: 'primary',
    sourceFamily: `family-${sourceId}`,
  }
}

function externalClaim(claimId: string, sourceId: string, text: string) {
  return {
    claimId,
    text,
    kind: 'external',
    importance: 'material',
    disposition: 'supported',
    sourceIds: [sourceId],
  }
}

async function evidenceState(): Promise<{
  readonly engine: ReturnType<typeof createRavenEngine>
  readonly state: RavenTaskState
}> {
  const engine = createRavenEngine({ now, sourceVerifier })
  const started = await engine.dispatch(null, {
    action: 'start',
    outcome: 'research',
    request: 'Explain what follows from two observed operating constraints.',
  }, { sessionId: 'synthesis-session', signal })
  const checkpoint = await engine.dispatch(started.state, {
    action: 'checkpoint',
    taskId: started.state.taskId,
    stage: 'read',
    summary: 'Two source observations, not yet a synthesis.',
    artifact: 'The first record reports delayed settlement [@S1]. The second reports short evaluation windows [@S2].',
    sources: [source('S1'), source('S2')],
    claims: [
      externalClaim('C1', 'S1', 'The first record reports delayed settlement.'),
      externalClaim('C2', 'S2', 'The second record reports short evaluation windows.'),
    ],
  }, { sessionId: 'synthesis-session', signal })
  return { engine, state: checkpoint.state }
}

const candidate = (overrides: Record<string, unknown> = {}) => ({
  insightId: 'I1',
  text: 'Short evaluation windows may reward visible activity before delayed outcomes can be observed.',
  kind: 'explanation',
  pattern: 'incentive-mismatch',
  claimIds: ['C1', 'C2'],
  assumptions: ['Evaluators optimize decisions around outcomes observable inside the review window.'],
  rationale: 'The timing mismatch offers a mechanism connecting the two otherwise separate observations.',
  wouldChangeMind: 'Evidence that evaluation decisions routinely use outcome measures collected after settlement.',
  confidence: 'medium',
  competesWith: ['I2'],
  ...overrides,
})

describe('Raven synthesis and Insight Candidates', () => {
  it('derives inspectable competing candidates from multiple Claims, then promotes one only as traced analysis', async () => {
    const { engine, state } = await evidenceState()
    const synthesized = await engine.dispatch(state, {
      action: 'synthesize',
      taskId: state.taskId,
      scope: 'Recommendation mechanism',
      purpose: 'synthesis',
      claimIds: ['C1', 'C2'],
      insights: [
        candidate(),
        candidate({
          insightId: 'I2',
          text: 'The timing pattern may instead reflect measurement cost rather than strategic incentives.',
          kind: 'hypothesis',
          pattern: 'alternative-causal-mechanism',
          assumptions: ['Long-horizon outcomes are materially more expensive to measure.'],
          rationale: 'A measurement-cost mechanism explains the same timing observations without strategic behavior.',
          wouldChangeMind: 'Evidence that long-horizon outcomes are cheap, routinely collected, and deliberately ignored.',
          confidence: 'low',
          competesWith: ['I1'],
        }),
      ],
    }, { sessionId: 'synthesis-session', signal })

    expect(synthesized.state.insightCandidates).toHaveLength(2)
    expect(synthesized.state.insightCandidates[0]).toMatchObject({
      insightId: 'I1',
      claimIds: ['C1', 'C2'],
      assumptions: [expect.stringContaining('observable inside')],
      competesWith: ['I2'],
    })
    expect(synthesized.state.syntheses.at(-1)).toMatchObject({
      purpose: 'synthesis',
      claimIds: ['C1', 'C2'],
      insightIds: ['I1', 'I2'],
      summaryDebt: 'none',
    })
    expect(renderSynthesis(synthesized.synthesis, synthesized.state.claims)).toContain(
      'Insight Candidates (interpretations, not facts or accepted analysis)',
    )
    expect(renderSynthesis(synthesized.synthesis, synthesized.state.claims)).toContain('competes with I2')

    const promoted = await engine.dispatch(synthesized.state, {
      action: 'checkpoint',
      taskId: state.taskId,
      stage: 'analyze',
      summary: 'One interpretation adopted with its evidence lineage; the alternative remains visible.',
      artifact: 'The records report delayed settlement [@S1] and short evaluation windows [@S2]. Short evaluation windows may reward visible activity before delayed outcomes can be observed.',
      claims: [{
        claimId: 'A1',
        text: candidate().text,
        kind: 'analysis',
        importance: 'material',
        disposition: 'qualified',
        sourceIds: [],
        insightId: 'I1',
        derivedFromClaimIds: ['C1', 'C2'],
        assumptions: candidate().assumptions,
      }],
    }, { sessionId: 'synthesis-session', signal })

    const analysis = promoted.state.claims.find(claim => claim.claimId === 'A1')
    expect(analysis).toMatchObject({
      kind: 'analysis',
      insightId: 'I1',
      derivedFromClaimIds: ['C1', 'C2'],
    })
    expect(promoted.state.insightCandidates.map(insight => insight.insightId)).toEqual(['I1', 'I2'])
    expect(promoted.renderedArtifact).toContain('## Analysis lineage')
    expect(promoted.renderedArtifact).toContain('Raven inference from C1, C2')
    expect(promoted.renderedArtifact).toContain('Assumptions:')
    expect(promoted.renderedArtifact).toContain('alternative I2 remains a candidate')
  })

  it('treats a later one-way competing link as an undirected alternative after promotion', async () => {
    const { engine, state } = await evidenceState()
    const first = await engine.dispatch(state, {
      action: 'synthesize', taskId: state.taskId, scope: 'Cross-round mechanism', purpose: 'synthesis',
      claimIds: ['C1', 'C2'], insights: [candidate({ competesWith: [] })],
    }, { sessionId: 'synthesis-session', signal })
    const secondCandidate = candidate({
      insightId: 'I2',
      text: 'The timing pattern may instead reflect measurement cost rather than strategic incentives.',
      kind: 'hypothesis',
      pattern: 'alternative-causal-mechanism',
      assumptions: ['Long-horizon outcomes are materially more expensive to measure.'],
      rationale: 'Measurement cost explains the same observations without strategic behavior.',
      wouldChangeMind: 'Evidence that long-horizon outcomes are cheap and routinely collected.',
      confidence: 'low',
      competesWith: ['I1'],
    })
    const second = await engine.dispatch(first.state, {
      action: 'synthesize', taskId: state.taskId, scope: 'Cross-round mechanism', purpose: 'synthesis',
      claimIds: ['C1', 'C2'], insights: [secondCandidate],
    }, { sessionId: 'synthesis-session', signal })

    expect(first.state.insightCandidates.find(item => item.insightId === 'I1')?.competesWith).toBeUndefined()
    expect(renderSynthesis(first.synthesis, first.state.claims, second.state.insightCandidates)).toContain('competes with I2')

    const promoted = await engine.dispatch(second.state, {
      action: 'checkpoint', taskId: state.taskId, stage: 'analyze', summary: 'Earlier interpretation promoted.',
      artifact: `The records report delayed settlement [@S1] and short evaluation windows [@S2]. ${candidate().text}`,
      claims: [{
        claimId: 'A1', text: candidate().text, kind: 'analysis', importance: 'material', disposition: 'qualified',
        sourceIds: [], insightId: 'I1', derivedFromClaimIds: ['C1', 'C2'], assumptions: candidate().assumptions,
      }],
    }, { sessionId: 'synthesis-session', signal })
    const completed = await engine.dispatch(promoted.state, {
      action: 'complete', taskId: state.taskId, artifact: promoted.state.latestArtifact,
    }, { sessionId: 'synthesis-session', signal })

    expect(promoted.renderedArtifact).toContain('alternative I2 remains a candidate')
    expect(completed.status).toBe('completed')
    expect(wikiConfidence(completed.state)).toBe('medium')
  })

  it('distinguishes source evidence, candidate interpretation, and accepted Raven inference in rendering', async () => {
    const { engine, state } = await evidenceState()
    const synthesized = await engine.dispatch(state, {
      action: 'synthesize', taskId: state.taskId, scope: 'Interpretation', purpose: 'synthesis',
      claimIds: ['C1', 'C2'], insights: [candidate({ competesWith: [] })],
    }, { sessionId: 'synthesis-session', signal })
    const promoted = await engine.dispatch(synthesized.state, {
      action: 'checkpoint', taskId: state.taskId, stage: 'analyze', summary: 'Typed epistemic layers.',
      artifact: 'The first record reports delayed settlement [@S1]. The second reports short evaluation windows [@S2]. Short evaluation windows may reward visible activity before delayed outcomes can be observed.',
      claims: [{
        claimId: 'A1', text: candidate().text, kind: 'analysis', importance: 'material', disposition: 'qualified',
        sourceIds: [], insightId: 'I1', derivedFromClaimIds: ['C1', 'C2'], assumptions: candidate().assumptions,
      }],
    }, { sessionId: 'synthesis-session', signal })

    const rendered = renderArtifact(promoted.state.latestArtifact ?? '', promoted.state.sources, promoted.state.claims, promoted.state.insightCandidates)
    expect(rendered).toContain('source says')
    expect(rendered).toContain('Insight Candidate I1')
    expect(rendered).toContain('Raven inference')
  })

  it('round-trips an external Claim and Insight Candidate with identical text', async () => {
    const { engine, state } = await evidenceState()
    const externalText = state.claims.find(claim => claim.claimId === 'C1')?.text
    if (externalText === undefined) throw new Error('Expected external Claim C1')

    const synthesized = await engine.dispatch(state, {
      action: 'synthesize',
      taskId: state.taskId,
      scope: 'Same-text interpretation regression',
      purpose: 'synthesis',
      claimIds: ['C1', 'C2'],
      insights: [candidate({ text: externalText, competesWith: [] })],
    }, { sessionId: 'synthesis-session', signal })
    const replayed = decodeRavenTaskState(JSON.parse(JSON.stringify(synthesized.state)) as unknown)

    expect(synthesized.state.claims.find(claim => claim.claimId === 'C1')?.kind).toBe('external')
    expect(synthesized.state.insightCandidates[0]?.text).toBe(externalText)
    expect(replayed).toEqual(synthesized.state)
  })

  it('detects summary debt for restatement-heavy synthesis but exempts an explicit summary', async () => {
    const { engine, state } = await evidenceState()
    const debt = await engine.dispatch(state, {
      action: 'synthesize',
      taskId: state.taskId,
      scope: 'Findings section',
      purpose: 'synthesis',
      claimIds: ['C1', 'C2'],
      insights: [],
    }, { sessionId: 'synthesis-session', signal })

    expect(debt.state.syntheses.at(-1)).toMatchObject({
      scope: 'Findings section',
      summaryDebt: 'high',
    })
    expect(debt.issues.join(' ')).toContain('summary debt')
    expect(debt.issues.join(' ')).toContain('restates evidence')

    const summary = await engine.dispatch(debt.state, {
      action: 'synthesize',
      taskId: state.taskId,
      scope: 'User-requested source summary',
      purpose: 'summary',
      claimIds: ['C1', 'C2'],
      insights: [],
    }, { sessionId: 'synthesis-session', signal })
    expect(summary.state.syntheses.at(-1)).toMatchObject({ purpose: 'summary', summaryDebt: 'none' })
    expect(summary.issues.join(' ')).not.toContain('summary debt')

    const checkpoint = await engine.dispatch(summary.state, {
      action: 'checkpoint', taskId: state.taskId, stage: 'draft', summary: 'Summary did not repair findings debt.',
      artifact: summary.state.latestArtifact,
    }, { sessionId: 'synthesis-session', signal })
    expect(checkpoint.issues.join(' ')).toContain('Outstanding high summary debt for Findings section')
    const completed = await engine.dispatch(checkpoint.state, {
      action: 'complete', taskId: state.taskId, artifact: checkpoint.state.latestArtifact,
    }, { sessionId: 'synthesis-session', signal })
    expect(completed.status).toBe('completed')
    expect(completed.issues.join(' ')).toContain('Outstanding high summary debt for Findings section')
  })

  it('clears Summary Debt only with a debt-free synthesis pass over the same scope', async () => {
    const { engine, state } = await evidenceState()
    const debt = await engine.dispatch(state, {
      action: 'synthesize', taskId: state.taskId, scope: 'Findings section', purpose: 'synthesis',
      claimIds: ['C1', 'C2'], insights: [],
    }, { sessionId: 'synthesis-session', signal })
    const repaired = await engine.dispatch(debt.state, {
      action: 'synthesize', taskId: state.taskId, scope: 'Findings section', purpose: 'synthesis',
      claimIds: ['C1', 'C2'], insights: [candidate({ competesWith: [] })],
    }, { sessionId: 'synthesis-session', signal })
    const checkpoint = await engine.dispatch(repaired.state, {
      action: 'checkpoint', taskId: state.taskId, stage: 'analyze', summary: 'Findings now include synthesis.',
      artifact: repaired.state.latestArtifact,
    }, { sessionId: 'synthesis-session', signal })

    expect(repaired.state.syntheses.at(-1)?.summaryDebt).toBe('none')
    expect(checkpoint.issues.join(' ')).not.toContain('summary debt')
  })

  it('automatically defers promoted analysis when one of its premise Claims loses support', async () => {
    let failSecond = false
    const verifier: SourceVerifier = {
      verify: async sources => sources.map(item => failSecond && item.sourceId === 'S2'
        ? {
            sourceId: item.sourceId,
            status: 'failed' as const,
            checkedAt: now(),
            statusCode: 503,
            resolvedUrl: item.url,
            detail: 'HTTP 503 during final verification',
          }
        : {
            sourceId: item.sourceId,
            status: 'reachable' as const,
            checkedAt: now(),
            statusCode: 200,
            resolvedUrl: item.url,
          }),
    }
    const engine = createRavenEngine({ now, sourceVerifier: verifier })
    const started = await engine.dispatch(null, {
      action: 'start', outcome: 'research', request: 'Track analysis authority through premise failure.',
    }, { sessionId: 'synthesis-propagation', signal })
    const evidence = await engine.dispatch(started.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'read', summary: 'Two premises.',
      artifact: 'The first record reports delayed settlement [@S1]. The second reports short evaluation windows [@S2].',
      sources: [source('S1'), source('S2')],
      claims: [
        externalClaim('C1', 'S1', 'The first record reports delayed settlement.'),
        externalClaim('C2', 'S2', 'The second record reports short evaluation windows.'),
      ],
    }, { sessionId: 'synthesis-propagation', signal })
    const synthesized = await engine.dispatch(evidence.state, {
      action: 'synthesize', taskId: started.state.taskId, scope: 'Mechanism', purpose: 'synthesis',
      claimIds: ['C1', 'C2'], insights: [candidate({ competesWith: [] })],
    }, { sessionId: 'synthesis-propagation', signal })
    const analyzed = await engine.dispatch(synthesized.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'analyze', summary: 'Promoted analysis.',
      artifact: `The first record reports delayed settlement [@S1]. The second reports short evaluation windows [@S2]. ${candidate().text}`,
      claims: [{
        claimId: 'A1', text: candidate().text, kind: 'analysis', importance: 'material', disposition: 'qualified',
        sourceIds: [], insightId: 'I1', derivedFromClaimIds: ['C1', 'C2'], assumptions: candidate().assumptions,
      }],
    }, { sessionId: 'synthesis-propagation', signal })

    failSecond = true
    const rejected = await engine.dispatch(analyzed.state, {
      action: 'complete', taskId: started.state.taskId, artifact: analyzed.state.latestArtifact,
    }, { sessionId: 'synthesis-propagation', signal })

    expect(rejected.status).toBe('needs-revision')
    expect(rejected.state.claims.find(item => item.claimId === 'C2')).toMatchObject({
      disposition: 'deferred', deferredFrom: 'supported',
    })
    expect(rejected.state.claims.find(item => item.claimId === 'A1')).toMatchObject({
      disposition: 'deferred', deferredFrom: 'qualified',
    })

    const revised = await engine.dispatch(rejected.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'refine', summary: 'Removed unsupported conclusions.',
      artifact: 'The first record reports delayed settlement [@S1]. The second premise and dependent analysis remain unresolved.',
    }, { sessionId: 'synthesis-propagation', signal })
    expect(revised.status).toBe('active')
    expect(revised.state.claims.find(item => item.claimId === 'A1')?.disposition).toBe('deferred')

    const completed = await engine.dispatch(revised.state, {
      action: 'complete', taskId: started.state.taskId, artifact: revised.state.latestArtifact,
    }, { sessionId: 'synthesis-propagation', signal })
    expect(completed.status).toBe('completed-with-limits')
    expect(completed.state.claims.find(item => item.claimId === 'A1')?.disposition).toBe('deferred')
  })

  it('refuses to promote an Insight Candidate as external fact or accept analysis with unsupported lineage', async () => {
    const { engine, state } = await evidenceState()
    const synthesized = await engine.dispatch(state, {
      action: 'synthesize', taskId: state.taskId, scope: 'Guarded inference', purpose: 'synthesis',
      claimIds: ['C1', 'C2'], insights: [candidate({ competesWith: [] })],
    }, { sessionId: 'synthesis-session', signal })

    await expect(engine.dispatch(synthesized.state, {
      action: 'checkpoint', taskId: state.taskId, stage: 'analyze', summary: 'Invalid fact promotion.',
      artifact: 'Short evaluation windows reward visible activity [@S1].',
      claims: [{
        claimId: 'BAD-FACT', text: candidate().text, kind: 'external', importance: 'material', disposition: 'supported',
        sourceIds: ['S1'], insightId: 'I1', derivedFromClaimIds: ['C1', 'C2'], assumptions: candidate().assumptions,
      }],
    }, { sessionId: 'synthesis-session', signal })).rejects.toThrow(/Insight Candidate.*external fact/)

    await expect(engine.dispatch(synthesized.state, {
      action: 'checkpoint', taskId: state.taskId, stage: 'analyze', summary: 'Unlineaged analysis.',
      artifact: 'A persuasive interpretation with no recorded premises.',
      claims: [{
        claimId: 'NO-LINEAGE', text: 'A persuasive interpretation with no recorded premises.',
        kind: 'analysis', importance: 'material', disposition: 'supported', sourceIds: [],
      }],
    }, { sessionId: 'synthesis-session', signal })).rejects.toThrow(/requires an explicitly recorded Insight Candidate/)

    const deferredState = {
      ...synthesized.state,
      claims: synthesized.state.claims.map(claim => claim.claimId === 'C2'
        ? { ...claim, disposition: 'deferred' as const }
        : claim),
    }
    await expect(engine.dispatch(deferredState, {
      action: 'checkpoint', taskId: state.taskId, stage: 'analyze', summary: 'Unsupported analysis promotion.',
      artifact: 'The first record reports delayed settlement [@S1].',
      claims: [{
        claimId: 'BAD-ANALYSIS', text: candidate().text, kind: 'analysis', importance: 'material', disposition: 'qualified',
        sourceIds: [], insightId: 'I1', derivedFromClaimIds: ['C1', 'C2'], assumptions: candidate().assumptions,
      }],
    }, { sessionId: 'synthesis-session', signal })).rejects.toThrow(/cannot be promoted.*C2.*deferred/)
  })

  it.each([
    ['deferred', 'supported'],
    ['rejected', 'qualified'],
  ] as const)('requires lineage when unlineaged material analysis moves from %s to %s', async (initial, accepted) => {
    const { engine, state } = await evidenceState()
    const recorded = await engine.dispatch(state, {
      action: 'checkpoint', taskId: state.taskId, stage: 'analyze', summary: `Recorded ${initial} analysis.`,
      artifact: state.latestArtifact,
      claims: [{
        claimId: 'TRANSITION-A1', text: 'An unlineaged material interpretation.', kind: 'analysis',
        importance: 'material', disposition: initial, sourceIds: [],
      }],
    }, { sessionId: 'synthesis-session', signal })

    await expect(engine.dispatch(recorded.state, {
      action: 'checkpoint', taskId: state.taskId, stage: 'analyze', summary: `Attempted ${accepted} analysis.`,
      artifact: recorded.state.latestArtifact,
      claims: [{
        claimId: 'TRANSITION-A1', text: 'An unlineaged material interpretation.', kind: 'analysis',
        importance: 'material', disposition: accepted, sourceIds: [],
      }],
    }, { sessionId: 'synthesis-session', signal })).rejects.toThrow(/requires an explicitly recorded Insight Candidate/)
  })

  it('defers and restores multi-hop promoted analysis when an upstream Source fails and recovers', async () => {
    let failSource = false
    const verifier: SourceVerifier = {
      verify: async sources => sources.map(item => failSource
        ? {
            sourceId: item.sourceId,
            status: 'failed' as const,
            checkedAt: now(),
            statusCode: 503,
            resolvedUrl: item.url,
            detail: 'temporary verifier failure',
          }
        : {
            sourceId: item.sourceId,
            status: 'reachable' as const,
            checkedAt: now(),
            statusCode: 200,
            resolvedUrl: item.url,
          }),
    }
    const engine = createRavenEngine({ now, sourceVerifier: verifier })
    const started = await engine.dispatch(null, {
      action: 'start', outcome: 'research', request: 'Restore a multi-hop analysis chain.',
    }, { sessionId: 'multi-hop-synthesis', signal })
    const evidence = await engine.dispatch(started.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'read', summary: 'One premise.',
      artifact: 'The first record reports delayed settlement [@S1].',
      sources: [source('S1')],
      claims: [externalClaim('C1', 'S1', 'The first record reports delayed settlement.')],
    }, { sessionId: 'multi-hop-synthesis', signal })
    const firstCandidate = candidate({ claimIds: ['C1'], competesWith: [] })
    const firstSynthesis = await engine.dispatch(evidence.state, {
      action: 'synthesize', taskId: started.state.taskId, scope: 'First inference', purpose: 'synthesis',
      claimIds: ['C1'], insights: [firstCandidate],
    }, { sessionId: 'multi-hop-synthesis', signal })
    const firstPromotion = await engine.dispatch(firstSynthesis.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'analyze', summary: 'First inference promoted.',
      artifact: `The first record reports delayed settlement [@S1]. ${firstCandidate.text}`,
      claims: [{
        claimId: 'A1', text: firstCandidate.text, kind: 'analysis', importance: 'material', disposition: 'qualified',
        sourceIds: [], insightId: 'I1', derivedFromClaimIds: ['C1'], assumptions: firstCandidate.assumptions,
      }],
    }, { sessionId: 'multi-hop-synthesis', signal })
    const secondCandidate = candidate({
      insightId: 'I2',
      text: 'The timing mismatch may compound when later decisions rely on the first inference.',
      kind: 'implication',
      pattern: 'second-order-effect',
      claimIds: ['A1'],
      assumptions: ['Downstream decisions reuse the earlier timing interpretation.'],
      rationale: 'A derived decision can inherit the first inference authority.',
      wouldChangeMind: 'Evidence that downstream decisions independently re-evaluate the premise.',
      confidence: 'low',
      competesWith: [],
    })
    const secondSynthesis = await engine.dispatch(firstPromotion.state, {
      action: 'synthesize', taskId: started.state.taskId, scope: 'Second inference', purpose: 'synthesis',
      claimIds: ['A1'], insights: [secondCandidate],
    }, { sessionId: 'multi-hop-synthesis', signal })
    const secondPromotion = await engine.dispatch(secondSynthesis.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'analyze', summary: 'Second inference promoted.',
      artifact: `The first record reports delayed settlement [@S1]. ${firstCandidate.text} ${secondCandidate.text}`,
      claims: [{
        claimId: 'A2', text: secondCandidate.text, kind: 'analysis', importance: 'material', disposition: 'qualified',
        sourceIds: [], insightId: 'I2', derivedFromClaimIds: ['A1'], assumptions: secondCandidate.assumptions,
      }],
    }, { sessionId: 'multi-hop-synthesis', signal })

    failSource = true
    const failed = await engine.dispatch(secondPromotion.state, {
      action: 'complete', taskId: started.state.taskId, artifact: secondPromotion.state.latestArtifact,
    }, { sessionId: 'multi-hop-synthesis', signal })
    expect(failed.status).toBe('needs-revision')
    expect(failed.state.claims.map(claim => [claim.claimId, claim.disposition])).toEqual([
      ['C1', 'deferred'], ['A1', 'deferred'], ['A2', 'deferred'],
    ])

    failSource = false
    const restored = await engine.dispatch(failed.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'verify', summary: 'Source and lineage restored.',
      artifact: secondPromotion.state.latestArtifact,
    }, { sessionId: 'multi-hop-synthesis', signal })
    expect(restored.status).toBe('active')
    expect(restored.state.claims.map(claim => [claim.claimId, claim.disposition])).toEqual([
      ['C1', 'supported'], ['A1', 'qualified'], ['A2', 'qualified'],
    ])
    const completed = await engine.dispatch(restored.state, {
      action: 'complete', taskId: started.state.taskId, artifact: restored.state.latestArtifact,
    }, { sessionId: 'multi-hop-synthesis', signal })
    expect(completed.status).toBe('completed')
  })
})
