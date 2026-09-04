import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { safeEvaluationOutputPath } from '../../scripts/live-evaluation.js'
import {
  analyzeEvaluationReviewsForPromotion,
  checkEvaluationSuite,
  CORE_EVALUATION_SCENARIO_IDS,
  decodeEvaluationReview,
  decodeEvaluationScenario,
  evaluatePair,
  evaluatePairFromEvidence,
  evaluationSuiteSha256,
  normalizeEvaluationToolsSdk,
  verifyEvaluationReviews,
  verifyPairEvidence,
  type EvaluationPair,
  type EvaluationScenario,
} from '../../scripts/evaluation.js'

const scenario: EvaluationScenario = {
  schemaVersion: 1,
  id: 'grounded-policy-brief',
  title: 'Grounded policy brief',
  description: 'A compact paired-contract fixture.',
  kind: 'primary',
  outcome: 'academic-writing',
  workflow: ['research', 'academic-writing', 'web', 'steering'],
  turns: [
    { id: 'initial', delivery: 'followup', trigger: 'idle', content: 'Compare the supplied records and write a grounded policy brief.' },
    { id: 'risk-steer', delivery: 'steer', trigger: 'after-checkpoint', content: 'Focus the recommendation on implementation risk.' },
  ],
  sources: [
    {
      id: 'record-a',
      title: 'Record A',
      origin: 'web',
      uri: 'https://example.com/raven-eval/record-a',
      path: 'fixtures/sources/record-a.md',
      sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      quality: 'primary',
      family: 'agency-a',
      asOf: '2026-01-01',
    },
    {
      id: 'record-b',
      title: 'Record B',
      origin: 'web',
      uri: 'https://example.com/raven-eval/record-b',
      path: 'fixtures/sources/record-b.md',
      sha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      quality: 'primary',
      family: 'agency-b',
      asOf: '2026-01-02',
    },
  ],
  expectations: {
    requiredFactIds: ['claim-a', 'claim-b'],
    contradictionIds: ['tension-a-b'],
    forbiddenArtifactQuotes: [],
    minimumIndependentSourceFamilies: 2,
    minimumCheckpoints: 1,
    requireStopResume: false,
    requireKnowledgeReuse: false,
    requireStructureChoice: false,
    requireMultiModelDraft: false,
    allowedTerminalStatuses: ['completed', 'completed-with-limits'],
  },
  reviewDimensions: ['insight-defensibility', 'synthesis-usefulness', 'final-prose-quality'],
}

const reviewBinding = {
  packetManifestSha256: `sha256:${'1'.repeat(64)}`,
  mappingCommitmentSha256: `sha256:${'2'.repeat(64)}`,
  scenarioSha256: `sha256:${'3'.repeat(64)}`,
  rubricSha256: `sha256:${'4'.repeat(64)}`,
  assessorChecklistSha256: `sha256:${'5'.repeat(64)}`,
  artifacts: {
    A: `sha256:${'6'.repeat(64)}`,
    B: `sha256:${'7'.repeat(64)}`,
  },
}

const environment = {
  ravenCommit: '6057170000000000000000000000000000000000',
  ravenDirty: false,
  harnessVersion: '0.1.2-alpha.1',
  harnessCommit: 'cd5ef8148158c3a752a658978873241fdf8e2bbc',
  harnessDirty: false,
  nodeVersion: '22.19.0',
  platform: 'win32',
  arch: 'x64',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 8192,
  availableModelRoutes: ['deepseek-official/deepseek-v4-flash'],
  basePreset: 'ptc',
  baseCompositionSha256: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  baseTools: ['read', 'web_fetch'],
  baseToolSchemasSha256: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  basePromptSectionsSha256: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'never',
  networkPolicy: 'fixture-only',
  sourceSnapshotSha256: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  workspaceSnapshotSha256: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  inputsSha256: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
}

function condition(kind: 'vanilla' | 'raven') {
  return {
    schemaVersion: 1 as const,
    runId: `${kind}-run`,
    scenarioId: scenario.id,
    condition: kind,
    environment,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    terminalStatus: 'completed' as const,
    transcript: {
      path: `${kind}/session.jsonl`,
      sha256: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    },
    artifact: {
      path: `${kind}/artifact.md`,
      sha256: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    },
    claims: [
      {
        factId: 'claim-a',
        artifactQuote: 'Record A reports the implementation risk.',
        sourceIds: ['record-a'],
        support: [{ sourceId: 'record-a', excerpt: 'implementation risk' }],
      },
      {
        factId: 'claim-b',
        artifactQuote: 'Record B disputes the timing assumption.',
        sourceIds: ['record-b'],
        support: [{ sourceId: 'record-b', excerpt: 'timing assumption' }],
      },
    ],
    contradictions: [{ id: 'tension-a-b', factIds: ['claim-a', 'claim-b'], handled: true }],
    citations: [
      { sourceId: 'record-a', artifactQuote: 'Record A reports the implementation risk.' },
      { sourceId: 'record-b', artifactQuote: 'Record B disputes the timing assumption.' },
    ],
    checkpoints: [{
      artifactPath: `${kind}/checkpoint-1.md`,
      sha256: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
      at: '2026-01-01T00:00:30.000Z',
    }],
    lifecycle: {
      sessionIds: [`${kind}-session-1`],
      taskIds: [kind === 'raven' ? 'rvn-1' : 'session-1'],
      processGenerationIds: ['process-1'],
      stopEventSeq: null,
      resumeEventSeq: null,
      preservedStateSha256BeforeStop: null,
      preservedStateSha256AfterResume: null,
    },
    knowledgeUses: [],
    structure: { candidateCount: 0, selected: false },
    drafting: { routes: [], modelCallCount: 1 },
    usage: {
      uncachedInputTokens: kind === 'raven' ? 1200 : 1000,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: 500,
      totalTokens: kind === 'raven' ? 1700 : 1500,
      reasoningTokens: null,
      modelCalls: 1,
      toolCalls: kind === 'raven' ? 4 : 2,
      ptcNestedCalls: kind === 'raven' ? 2 : 0,
      searchCalls: 1,
      fetchCalls: kind === 'raven' ? 4 : 2,
      durationMs: 60_000,
    },
  }
}

function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function pair(): EvaluationPair {
  return {
    schemaVersion: 1,
    pairId: 'pair-1',
    scenarioId: scenario.id,
    vanilla: condition('vanilla'),
    raven: condition('raven'),
  }
}

describe('Raven paired evaluation contract', () => {
  it('normalizes only Raven declarations from the model-facing tools SDK', () => {
    const common = [
      'Shared SDK guidance.',
      'interface ToolArgsMap {',
      '  /** Read a file. */',
      '  read: { file_path: string };',
      '}',
    ].join('\n')
    const treatment = [
      'Shared SDK guidance.',
      'interface ToolArgsMap {',
      '  /** Read a file. */',
      '  read: { file_path: string };',
      '  /** Raven task. */',
      '  raven_task: unknown;',
      '  /** Raven workspace. */',
      '  raven_workspace: {',
      '    action: string;',
      '  };',
      '}',
    ].join('\n')

    expect(normalizeEvaluationToolsSdk(treatment)).toBe(common)
    expect(normalizeEvaluationToolsSdk(treatment.replace('Shared SDK guidance.', 'Drifted SDK guidance.'))).not.toBe(common)
  })

  it('confines destructive run output to one safe evaluation child', async () => {
    const safeRun = `.tmp/evaluation/safe-run-${process.pid}-${Date.now()}`
    await expect(safeEvaluationOutputPath(safeRun)).resolves.toMatch(/[\\/]\.tmp[\\/]evaluation[\\/]safe-run-/)
    await expect(safeEvaluationOutputPath('.')).rejects.toThrow('must be exactly .tmp/evaluation/<safe-run-id>')
    await expect(safeEvaluationOutputPath('.tmp/evaluation/nested/run')).rejects.toThrow('must be exactly .tmp/evaluation/<safe-run-id>')
    await expect(safeEvaluationOutputPath('..')).rejects.toThrow('must be exactly .tmp/evaluation/<safe-run-id>')
    const existing = '.tmp/evaluation/existing-run-test'
    await mkdir(existing, { recursive: true })
    try {
      await expect(safeEvaluationOutputPath(existing)).rejects.toThrow('output already exists')
    } finally {
      await rm(existing, { recursive: true, force: true })
    }
  })

  it('decodes scenarios strictly and rejects future, unknown, duplicate, or unsafe input', () => {
    expect(decodeEvaluationScenario(JSON.parse(JSON.stringify(scenario)))).toEqual(scenario)
    expect(decodeEvaluationScenario({ ...scenario, schemaVersion: 2 })).toBeUndefined()
    expect(decodeEvaluationScenario({ ...scenario, unexpected: true })).toBeUndefined()
    expect(decodeEvaluationScenario({ ...scenario, turns: [...scenario.turns, scenario.turns[0]] })).toBeUndefined()
    expect(decodeEvaluationScenario({ ...scenario, sources: [...scenario.sources, scenario.sources[0]] })).toBeUndefined()
    expect(decodeEvaluationScenario({
      ...scenario,
      sources: [{ ...scenario.sources[0]!, path: '../outside.md' }, scenario.sources[1]!],
    })).toBeUndefined()
    expect(decodeEvaluationScenario({
      ...scenario,
      sources: [{ ...scenario.sources[0]!, sha256: 'not-a-digest' }, scenario.sources[1]!],
    })).toBeUndefined()
    expect(decodeEvaluationScenario({
      ...scenario,
      sources: [{ ...scenario.sources[0]!, path: 'assessor-facts.json' }, scenario.sources[1]!],
    })).toBeUndefined()
  })

  it('decodes evidence-backed blinded reviews and rejects duplicate dimensions', () => {
    const review = {
      schemaVersion: 1,
      reviewId: 'review-1',
      reviewerId: 'reviewer-1',
      scenarioId: scenario.id,
      pairId: 'pair-1',
      blindOrder: ['A', 'B'],
      rubricVersion: 'v1',
      binding: reviewBinding,
      assessorIds: ['claim-a', 'claim-b', 'tension-a-b'],
      dimensions: scenario.reviewDimensions.map(dimension => ({
        dimension,
        A: 'pass',
        B: 'concern',
        preference: 'A',
        confidence: 'medium',
        evidence: [{
          arm: 'A', exactQuote: 'Exact preserved quote.', sourceId: 'record-a', eventSeq: null,
          note: 'The quote demonstrates the A judgment.',
        }, {
          arm: 'B', exactQuote: 'Exact B quote.', sourceId: null, eventSeq: null,
          note: 'The quote demonstrates the B judgment.',
        }],
        rationale: 'The cited evidence supports this categorical judgment.',
      })),
      overallPreference: 'A',
      confidence: 'medium',
      armGuess: 'unknown',
      createdAt: '2026-01-02T00:00:00.000Z',
    }
    const first = decodeEvaluationReview(review)
    expect(first).toEqual(review)
    expect(decodeEvaluationReview({ ...review, unexpected: true })).toBeUndefined()
    const { binding: _binding, ...unboundReview } = review
    expect(decodeEvaluationReview(unboundReview)).toBeUndefined()
    expect(decodeEvaluationReview({
      ...review,
      dimensions: [...review.dimensions, review.dimensions[0]],
    })).toBeUndefined()
    if (first === undefined) throw new Error('expected review to decode')
    expect(verifyEvaluationReviews(scenario, 'pair-1', [first], true, reviewBinding)).toMatchObject({ pass: false })
    const second = { ...first, reviewId: 'review-2', reviewerId: 'reviewer-2' }
    expect(verifyEvaluationReviews(scenario, 'pair-1', [first, second], true, reviewBinding)).toEqual({ pass: true, issues: [] })
    expect(verifyEvaluationReviews(scenario, 'pair-1', [
      first,
      { ...second, binding: { ...reviewBinding, packetManifestSha256: `sha256:${'8'.repeat(64)}` } },
    ], true, reviewBinding).issues).toContain('review review-2 binding does not match the immutable review packet')
    const evidenceFree = {
      ...second,
      dimensions: second.dimensions.map(item => ({ ...item, evidence: [] })),
    }
    expect(verifyEvaluationReviews(scenario, 'pair-1', [first, evidenceFree]).issues)
      .toContain('review review-2 dimension insight-defensibility has an evidence-free A judgment')
  })

  it('blocks Raven failures and requires explicit retention of concerns or disagreements', () => {
    const makeReview = (id: number, preference: 'A' | 'B' | 'tie' = 'tie', raven: 'pass' | 'concern' | 'fail' = 'pass') => decodeEvaluationReview({
      schemaVersion: 1,
      reviewId: `promotion-review-${id}`,
      reviewerId: `promotion-reviewer-${id}`,
      scenarioId: scenario.id,
      pairId: 'pair-1',
      blindOrder: ['A', 'B'],
      rubricVersion: 'v1',
      binding: reviewBinding,
      assessorIds: ['claim-a', 'claim-b', 'tension-a-b'],
      dimensions: scenario.reviewDimensions.map(dimension => ({
        dimension,
        A: 'pass',
        B: raven,
        preference,
        confidence: 'high',
        evidence: [{
          arm: 'A', exactQuote: 'Grounded A evidence.', sourceId: null, eventSeq: null,
          note: 'The exact quote supports the A judgment.',
        }, {
          arm: 'B', exactQuote: 'Grounded B evidence.', sourceId: null, eventSeq: null,
          note: 'The exact quote supports the B judgment.',
        }],
        rationale: 'The preserved evidence supports this categorical judgment.',
      })),
      overallPreference: preference,
      confidence: 'high',
      armGuess: 'unknown',
      createdAt: `2026-01-0${id}T00:00:00.000Z`,
    })
    const first = makeReview(1)
    const second = makeReview(2)
    if (first === undefined || second === undefined) throw new Error('expected promotion reviews to decode')
    const mapping = { A: 'vanilla', B: 'raven' }

    expect(analyzeEvaluationReviewsForPromotion(scenario, [first, second], mapping, [])).toEqual({ pass: true, issues: [] })
    const firstAgainst = makeReview(1, 'A')
    const secondAgainst = makeReview(2, 'A')
    if (firstAgainst === undefined || secondAgainst === undefined) throw new Error('expected negative-preference reviews')
    expect(analyzeEvaluationReviewsForPromotion(scenario, [firstAgainst, secondAgainst], mapping, []).issues)
      .toContain('review promotion-review-1 has an unretained overall preference against Raven')
    const pureOverallAgainst = { ...second, overallPreference: 'A' as const }
    expect(analyzeEvaluationReviewsForPromotion(scenario, [first, pureOverallAgainst], mapping, [{
      dimension: scenario.reviewDimensions[0]!,
      reviewIds: ['promotion-review-1', 'promotion-review-2'],
      overallReviewIds: ['promotion-review-2'],
      disposition: 'retained',
      rationale: 'The adverse overall preference remains visible despite identical dimension judgments.',
    }])).toEqual({ pass: true, issues: [] })

    const negative = makeReview(2, 'A', 'fail')
    if (negative === undefined) throw new Error('expected negative review to decode')
    expect(analyzeEvaluationReviewsForPromotion(scenario, [first, negative], mapping, []).issues)
      .toContain('review promotion-review-2 gives Raven a hard failure for insight-defensibility')
    const concern = makeReview(2, 'A', 'concern')
    if (concern === undefined) throw new Error('expected concern review to decode')
    expect(analyzeEvaluationReviewsForPromotion(scenario, [first, concern], mapping, []).issues)
      .toContain('dimension insight-defensibility has an unresolved disagreement, retainable Raven failure/concern, or preference against Raven')
    const concernResolutions = scenario.reviewDimensions.map(dimension => ({
      dimension,
      reviewIds: ['promotion-review-1', 'promotion-review-2'],
      disposition: 'retained' as const,
      rationale: 'The evidence-backed Raven concern is accepted as a visible release limitation.',
    }))
    expect(analyzeEvaluationReviewsForPromotion(scenario, [first, concern], mapping, concernResolutions).issues)
      .toContain('review promotion-review-2 has an unretained overall preference against Raven')
    expect(analyzeEvaluationReviewsForPromotion(scenario, [first, concern], mapping, concernResolutions.map((resolution, index) => ({
      ...resolution,
      ...(index === 0 ? { overallReviewIds: ['promotion-review-2'] } : {}),
    })))).toEqual({ pass: true, issues: [] })

    const disagreeing = makeReview(2, 'A')
    if (disagreeing === undefined) throw new Error('expected disagreeing review to decode')
    expect(analyzeEvaluationReviewsForPromotion(scenario, [first, disagreeing], mapping, []).issues)
      .toContain('dimension insight-defensibility has an unresolved disagreement, retainable Raven failure/concern, or preference against Raven')
    expect(analyzeEvaluationReviewsForPromotion(scenario, [first, disagreeing], mapping, [{
      dimension: 'insight-defensibility',
      reviewIds: ['promotion-review-1', 'promotion-review-2'],
      overallReviewIds: ['promotion-review-2'],
      disposition: 'retained',
      rationale: 'Both evidence-backed judgments remain visible in the promoted baseline.',
    }, ...scenario.reviewDimensions.slice(1).map(dimension => ({
      dimension,
      reviewIds: ['promotion-review-1', 'promotion-review-2'],
      disposition: 'retained' as const,
      rationale: 'Both evidence-backed judgments remain visible in the promoted baseline.',
    }))])).toEqual({ pass: true, issues: [] })
  })

  it('checks every tracked core scenario and frozen fixture from disk', async () => {
    const checked = await checkEvaluationSuite(fileURLToPath(new URL('../../evaluation/', import.meta.url)))

    expect(checked.pass, checked.issues.join('\n')).toBe(true)
    expect(checked.scenarioIds).toEqual(CORE_EVALUATION_SCENARIO_IDS)
    expect(checked.issues).toEqual([])
  })

  it('rejects fixture symlinks before hashing tracked source bytes', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'raven-evaluation-suite-'))
    const evaluationRoot = join(temp, 'evaluation')
    const trackedRoot = fileURLToPath(new URL('../../evaluation/', import.meta.url))
    await mkdir(evaluationRoot)
    await Promise.all([
      cp(join(trackedRoot, 'scenarios'), join(evaluationRoot, 'scenarios'), { recursive: true }),
      cp(join(trackedRoot, 'fixtures'), join(evaluationRoot, 'fixtures'), { recursive: true }),
      copyFile(join(trackedRoot, 'README.md'), join(evaluationRoot, 'README.md')),
      copyFile(join(trackedRoot, 'rubric.md'), join(evaluationRoot, 'rubric.md')),
      copyFile(join(trackedRoot, 'assessor-facts.json'), join(evaluationRoot, 'assessor-facts.json')),
    ])
    const fixturePath = join(evaluationRoot, 'fixtures', 'local', 'operations-notes.md')
    const outsidePath = join(temp, 'outside.md')
    await writeFile(outsidePath, await readFile(fixturePath))
    await rm(fixturePath)
    await symlink(outsidePath, fixturePath, 'file')

    await expect(evaluationSuiteSha256(evaluationRoot)).rejects
      .toThrow('fixture must be a regular non-symlink file: fixtures/local/operations-notes.md')
    expect((await checkEvaluationSuite(evaluationRoot)).issues)
      .toContain('fixture must be a regular non-symlink file: fixtures/local/operations-notes.md')
  })

  it('keeps the comparison fair and reports deterministic evidence without an invented total score', () => {
    const report = evaluatePair(scenario, pair())

    expect(report.valid).toBe(false)
    expect(report.baselinePass).toBe(false)
    expect(report.evidence).toEqual({ status: 'unchecked', pass: false, issues: ['evidence files were not verified'] })
    expect(report.fairness).toEqual({ pass: true, differences: [] })
    expect(report.conditions.vanilla.automated).toMatchObject({
      completion: true,
      claimCoverage: { found: 2, required: 2 },
      contradictionHandling: { found: 1, required: 1 },
      independentSourceFamilies: { found: 2, required: 2 },
      progressiveCheckpoints: { found: 1, required: 1 },
    })
    expect(report.costDelta).toEqual({
      uncachedInputTokens: 200,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: 0,
      totalTokens: 200,
      reasoningTokens: null,
      modelCalls: 0,
      toolCalls: 2,
      ptcNestedCalls: 2,
      searchCalls: 0,
      fetchCalls: 2,
      durationMs: 0,
    })
    expect(report).not.toHaveProperty('score')
    expect(report).not.toHaveProperty('winner')
    expect(report.review.status).toBe('required')
    expect(report.review.missingDimensions).toEqual(scenario.reviewDimensions)
  })

  it('never counts an unknown source family as independent corroboration', () => {
    const unknownFamilyScenario: EvaluationScenario = {
      ...scenario,
      sources: scenario.sources.map(source => ({ ...source, family: null })),
      expectations: { ...scenario.expectations, minimumIndependentSourceFamilies: 1 },
    }
    const report = evaluatePair(unknownFamilyScenario, pair())

    expect(report.conditions.raven.automated.independentSourceFamilies).toEqual({ found: 0, required: 1 })
    expect(report.conditions.raven.pass).toBe(false)
  })

  it('invalidates a pair when Raven gets a different underlying model', () => {
    const value = pair()
    value.raven = {
      ...value.raven,
      environment: { ...value.raven.environment, model: 'more-capable-model' },
    }

    const report = evaluatePair(scenario, value)

    expect(report.valid).toBe(false)
    expect(report.fairness.pass).toBe(false)
    expect(report.fairness.differences).toEqual([
      { field: 'model', vanilla: 'deepseek-v4-flash', raven: 'more-capable-model' },
    ])
  })

  it('fails auditable citation support when a cited source is outside the frozen corpus', () => {
    const value = pair()
    value.raven = {
      ...value.raven,
      citations: [{ sourceId: 'unknown-source', artifactQuote: 'Unsupported sentence.' }],
    }

    const report = evaluatePair(scenario, value)

    expect(report.valid).toBe(false)
    expect(report.baselinePass).toBe(false)
    expect(report.conditions.raven.pass).toBe(false)
    expect(report.conditions.raven.automated.citationFidelity).toEqual({
      pass: false,
      checked: 1,
      issues: ['citation references source outside the scenario corpus: unknown-source'],
    })
  })

  it('verifies preserved artifacts, source excerpts, and transcript hashes from disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-evaluation-evidence-'))
    const scenarioRoot = join(root, 'scenario')
    const pairRoot = join(root, 'pair')
    const sourceText = '# Record A\n\nThe record documents implementation risk.\n'
    const artifactText = 'Record A reports the implementation risk.'
    const transcriptText = '{"type":"turn/end","reason":"completed"}\n'
    await Promise.all([
      mkdir(join(scenarioRoot, 'fixtures', 'sources'), { recursive: true }),
      mkdir(join(pairRoot, 'vanilla'), { recursive: true }),
      mkdir(join(pairRoot, 'raven'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(scenarioRoot, 'fixtures', 'sources', 'record-a.md'), sourceText),
      writeFile(join(scenarioRoot, 'fixtures', 'sources', 'record-b.md'), 'The timing assumption is disputed.\n'),
      writeFile(join(pairRoot, 'vanilla', 'artifact.md'), artifactText),
      writeFile(join(pairRoot, 'raven', 'artifact.md'), artifactText),
      writeFile(join(pairRoot, 'vanilla', 'checkpoint-1.md'), artifactText),
      writeFile(join(pairRoot, 'raven', 'checkpoint-1.md'), artifactText),
      writeFile(join(pairRoot, 'vanilla', 'session.jsonl'), transcriptText),
      writeFile(join(pairRoot, 'raven', 'session.jsonl'), transcriptText),
    ])
    const value = pair()
    const sourceB = 'The timing assumption is disputed.\n'
    const evidenceScenario: EvaluationScenario = {
      ...scenario,
      sources: [
        { ...scenario.sources[0]!, sha256: digest(sourceText) },
        { ...scenario.sources[1]!, sha256: digest(sourceB) },
      ],
      expectations: {
        ...scenario.expectations,
        requiredFactIds: ['claim-a'],
        contradictionIds: [],
        minimumIndependentSourceFamilies: 1,
      },
    }
    for (const run of [value.vanilla, value.raven]) {
      run.artifact.sha256 = digest(artifactText)
      run.transcript.sha256 = digest(transcriptText)
      run.checkpoints[0]!.sha256 = digest(artifactText)
      run.claims = [{
        factId: 'claim-a',
        artifactQuote: artifactText,
        sourceIds: ['record-a'],
        support: [{ sourceId: 'record-a', excerpt: 'documents implementation risk' }],
      }]
      run.citations = [{ sourceId: 'record-a', artifactQuote: artifactText }]
    }

    const verified = await verifyPairEvidence(evidenceScenario, value, { scenarioRoot, pairRoot })
    expect(verified).toEqual({ pass: true, issues: [] })
    const report = await evaluatePairFromEvidence(evidenceScenario, value, { scenarioRoot, pairRoot })
    expect(report.valid).toBe(true)
    expect(report.baselinePass).toBe(true)
    expect(report.evidence).toEqual({ status: 'verified', pass: true, issues: [] })

    const canaryReport = await evaluatePairFromEvidence({
      ...evidenceScenario,
      expectations: { ...evidenceScenario.expectations, forbiddenArtifactQuotes: [artifactText] },
    }, value, { scenarioRoot, pairRoot })
    expect(canaryReport.valid).toBe(false)
    expect(canaryReport.evidence.issues).toContain('raven artifact contains forbidden canary: ' + artifactText)

    value.raven.checkpoints[0]!.at = '2026-01-01T00:02:00.000Z'
    const lateCheckpoint = await verifyPairEvidence(evidenceScenario, value, { scenarioRoot, pairRoot })
    expect(lateCheckpoint.issues).toContain('raven checkpoint 1 is not earlier than run completion')
    value.raven.checkpoints[0]!.at = '2026-01-01T00:00:30.000Z'

    value.raven.claims[0]!.support[0]!.excerpt = 'words absent from the frozen source'
    const rejected = await verifyPairEvidence(evidenceScenario, value, { scenarioRoot, pairRoot })
    expect(rejected.pass).toBe(false)
    expect(rejected.issues).toContain('raven claim claim-a support excerpt is absent from record-a')
    const rejectedReport = await evaluatePairFromEvidence(evidenceScenario, value, { scenarioRoot, pairRoot })
    expect(rejectedReport.valid).toBe(false)
    expect(rejectedReport.baselinePass).toBe(false)
  })

  it('requires lifecycle evidence instead of trusting a completion label', () => {
    const durable: EvaluationScenario = {
      ...scenario,
      expectations: { ...scenario.expectations, requireStopResume: true },
    }
    const value = pair()
    value.raven = {
      ...value.raven,
      lifecycle: {
        sessionIds: ['raven-session-1'],
        taskIds: ['rvn-1', 'rvn-2'],
        processGenerationIds: ['process-1', 'process-2'],
        stopEventSeq: 10,
        resumeEventSeq: 20,
        preservedStateSha256BeforeStop: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        preservedStateSha256AfterResume: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    }

    const report = evaluatePair(durable, value)

    expect(report.conditions.raven.automated.stopResume).toEqual({
      pass: false,
      required: true,
      stopped: true,
      resumed: true,
      processRestarted: true,
      stableIdentity: false,
      preservedState: true,
    })
    expect(report.valid).toBe(false)
    expect(report.baselinePass).toBe(false)
    expect(report.conditions.raven.pass).toBe(false)
  })
})
