import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  compareArchiveTreeTraversalOrder,
  decodeRawEvaluationArchive,
  verifyEvaluationBaseline,
  verifyTrackedEvaluationBaselines,
  writeRawEvaluationArchive,
} from '../../scripts/evaluation-baseline.js'
import {
  decodeEvaluationAssessorCatalog,
  decodeEvaluationScenario,
  evaluationSourceSnapshotSha256,
  evaluationSuiteSha256,
} from '../../scripts/evaluation.js'
import { evaluationAssessorChecklist, evaluationReviewInstructions } from '../../scripts/evaluation-review.js'

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function writeStrictProtocolBaseline(root: string): Promise<{
  manifestPath: string
  manifest: Record<string, any>
  decision: Record<string, any>
  run: Record<string, any>
}> {
  const evaluationRoot = fileURLToPath(new URL('../../evaluation/', import.meta.url))
  const scenarioBytes = await readFile(new URL('../../evaluation/scenarios/general-writing.json', import.meta.url), 'utf8')
  const rubricBytes = await readFile(new URL('../../evaluation/rubric.md', import.meta.url), 'utf8')
  const scenario = decodeEvaluationScenario(JSON.parse(scenarioBytes))
  const catalog = decodeEvaluationAssessorCatalog(JSON.parse(await readFile(
    new URL('../../evaluation/assessor-facts.json', import.meta.url), 'utf8',
  )))
  if (scenario === undefined || catalog === undefined) throw new Error('expected tracked evaluation inputs')
  const artifactA = 'Artifact A grounded evidence.\n'
  const artifactB = 'Artifact B grounded evidence.\n'
  const checklist = evaluationAssessorChecklist(scenario, catalog)
  const reviewInstructions = evaluationReviewInstructions(scenario).content
  const lifecycleInstructions = evaluationReviewInstructions(scenario).lifecycle
  const mapping = { A: 'vanilla', B: 'raven' }
  const seedSha256 = digest('strict-seed')
  const mappingCommitmentSha256 = digest(`${seedSha256}\0${JSON.stringify(mapping)}`)
  const sourceBytes = await readFile(new URL('../../evaluation/fixtures/local/operations-notes.md', import.meta.url), 'utf8')
  const packetFiles = Object.fromEntries(Object.entries({
    'A.md': digest(artifactA),
    'B.md': digest(artifactB),
    'rubric.md': digest(rubricBytes),
    'scenario.json': digest(scenarioBytes),
    'assessor-checklist.json': digest(checklist),
    'REVIEW.md': digest(reviewInstructions),
    'sources/notes-operations-notes.md': digest(sourceBytes),
  }).sort(([left], [right]) => left.localeCompare(right)))
  const packet = JSON.stringify({
    schemaVersion: 1,
    pairId: 'strict-pair-1',
    scenarioId: scenario.id,
    scenarioSha256: digest(scenarioBytes),
    rubricVersion: 'v1',
    rubricSha256: digest(rubricBytes),
    assessorChecklistSha256: digest(checklist),
    mappingCommitmentSha256,
    artifacts: { A: digest(artifactA), B: digest(artifactB) },
    files: packetFiles,
    sources: scenario.sources.map(source => ({
      id: source.id, title: source.title, origin: source.origin, uri: source.uri,
      quality: source.quality, family: source.family, asOf: source.asOf, sha256: source.sha256,
    })),
  }, null, 2) + '\n'
  const binding = {
    packetManifestSha256: digest(packet),
    mappingCommitmentSha256,
    scenarioSha256: digest(scenarioBytes),
    rubricSha256: digest(rubricBytes),
    assessorChecklistSha256: digest(checklist),
    artifacts: { A: digest(artifactA), B: digest(artifactB) },
  }
  const review = (id: number) => ({
    schemaVersion: 1,
    reviewId: `strict-review-${id}`,
    reviewerId: `strict-reviewer-${id}`,
    scenarioId: scenario.id,
    pairId: 'strict-pair-1',
    blindOrder: ['A', 'B'],
    rubricVersion: 'v1',
    binding,
    assessorIds: [...scenario.expectations.requiredFactIds, ...scenario.expectations.contradictionIds],
    dimensions: scenario.reviewDimensions.map(dimension => ({
      dimension,
      A: 'pass',
      B: 'pass',
      preference: 'tie',
      confidence: 'high',
      evidence: [{
        arm: 'A', exactQuote: 'Artifact A grounded evidence.', sourceId: null, eventSeq: null,
        note: 'Exact A Artifact evidence.',
      }, {
        arm: 'B', exactQuote: 'Artifact B grounded evidence.', sourceId: null, eventSeq: null,
        note: 'Exact B Artifact evidence.',
      }],
      rationale: 'Both preserved artifacts satisfy this protocol fixture dimension.',
    })),
    overallPreference: 'tie',
    confidence: 'high',
    armGuess: 'unknown',
    createdAt: `2026-01-0${id}T00:00:00.000Z`,
  })
  const reviews = [review(1), review(2)]
  const reviewsBytes = reviews.map(value => JSON.stringify(value)).join('\n') + '\n'
  const sourceSnapshotSha256 = await evaluationSourceSnapshotSha256(evaluationRoot, scenario)
  const runUsage = {
    uncachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null,
    totalTokens: null, reasoningTokens: null, modelCalls: 1, toolCalls: 0, ptcNestedCalls: 0, searchCalls: 0, fetchCalls: 0, durationMs: null,
  }
  const run = {
    schemaVersion: 1,
    runId: 'strict-pair-1',
    executionStartedAt: '2026-01-01T00:00:00.000Z',
    scenarioId: scenario.id,
    scenarioKind: scenario.kind,
    scenarioSha256: digest(scenarioBytes),
    rubricSha256: digest(rubricBytes),
    inputsSha256: digest(JSON.stringify(scenario.turns)),
    sourceSnapshotSha256,
    baseCompositionSha256: `sha256:${'8'.repeat(64)}`,
    parity: {
      pass: true,
      commonPromptSha256: { left: `sha256:${'9'.repeat(64)}`, right: `sha256:${'9'.repeat(64)}` },
      topLevelToolSha256: { left: `sha256:${'a'.repeat(64)}`, right: `sha256:${'a'.repeat(64)}` },
    },
    automatedFloor: {
      frozenInputParity: true,
      toolAccessFloor: true,
      canaryPass: true,
      mechanismFloor: true,
      armsComplete: true,
      ablationComplete: true,
    },
    provider: 'test-provider',
    model: 'same-model',
    reasoningEffort: null,
    maxTokens: 1000,
    order: ['vanilla', 'raven'],
    fixtureModel: false,
    outcomeComplete: true,
    promotable: true,
    harnessCommit: 'b'.repeat(40),
    harnessDirty: false,
    ravenCommit: 'c'.repeat(40),
    ravenDirty: false,
    arms: {
      vanilla: {
        path: 'vanilla', modelVisibleWorkspace: join(root, 'workspace'), initialWorkspaceSha256: `sha256:${'d'.repeat(64)}`,
        ledgersComplete: true, modelRoutesValid: true, modelRoutes: ['["test-provider","same-model"]'],
        usage: runUsage, protocolFailures: { toolResults: 0, ptcNested: 0 },
        processGenerationIds: ['process-1'], terminalStatus: 'completed', artifactPath: 'artifact.md',
        artifactSha256: digest(artifactA), ravenTask: null,
      },
      raven: {
        path: 'raven', modelVisibleWorkspace: join(root, 'workspace'), initialWorkspaceSha256: `sha256:${'d'.repeat(64)}`,
        ledgersComplete: true, modelRoutesValid: true, modelRoutes: ['["test-provider","same-model"]'],
        usage: runUsage, protocolFailures: { toolResults: 0, ptcNested: 0 },
        processGenerationIds: ['process-1'], terminalStatus: 'completed', artifactPath: 'artifact.md',
        artifactSha256: digest(artifactB), sessionIds: ['session-1'],
        ravenTask: { taskId: 'rvn-strict-1', phase: 'completed', checkpoints: 1, taskCount: 1, sourceOrigins: [], selectedStructure: false, stopResumeSameTask: false },
      },
    },
  }
  const report = {
    schemaVersion: 1,
    scenarioId: scenario.id,
    validity: {
      methodologyValid: true, parity: true, frozenInputParity: true, toolAccessFloor: true,
      modelRoutesValid: true, workspaceEqual: true, artifactIntegrity: true, hashesPresent: true,
      fixtureModel: false, harnessDirty: false,
      ravenDirty: false, promotable: true,
    },
    environment: {
      provider: run.provider,
      model: run.model,
      reasoningEffort: run.reasoningEffort,
      maxTokens: run.maxTokens,
      harnessCommit: run.harnessCommit,
      ravenCommit: run.ravenCommit,
      baseCompositionSha256: run.baseCompositionSha256,
      sourceSnapshotSha256: run.sourceSnapshotSha256,
      inputsSha256: run.inputsSha256,
      order: run.order,
    },
    outcomes: {
      left: {
        condition: 'vanilla', terminalStatus: 'completed', artifact: 'vanilla/artifact.md',
        artifactSha256: digest(artifactA),
      },
      right: {
        condition: 'raven', terminalStatus: 'completed', artifact: 'raven/artifact.md',
        artifactSha256: digest(artifactB),
      },
      scenarioFloorPassed: true,
    },
    review: { status: 'structurally-complete-unverified', pass: true, evidenceBindingVerified: false, records: reviews },
  }
  const unblinding = JSON.stringify({
    schemaVersion: 1,
    seedSha256,
    pairId: 'strict-pair-1',
    scenarioId: scenario.id,
    binding,
    mapping,
  }, null, 2) + '\n'
  const eventLogA = '{"event":{"type":"sandbox/mode","seq":1,"data":{"mode":"workspace-write"}}}\n'
  const eventLogB = '{"event":{"type":"tool/code-dispatch","seq":1,"data":{"name":"raven_task","isError":false,"arguments":{"action":"complete","taskId":"rvn-strict-1"},"content":[]}}}\n'
  const modelLog = '{"generation":"process-1","provider":"test-provider","model":"same-model"}\n'
  const rawArchive = 'raw archive bytes\n'
  const runBytes = JSON.stringify(run, null, 2) + '\n'
  const reportBytes = JSON.stringify(report, null, 2) + '\n'
  const files = {
    run: { path: 'run.json', sha256: digest(runBytes) },
    report: { path: 'report.json', sha256: digest(reportBytes) },
    reviews: { path: 'reviews.jsonl', sha256: digest(reviewsBytes) },
    unblinding: { path: 'unblinding.json', sha256: digest(unblinding) },
    packet: { path: 'packet.json', sha256: digest(packet) },
    instructions: { path: 'REVIEW.md', sha256: digest(reviewInstructions) },
    lifecycleInstructions: { path: 'LIFECYCLE_REVIEW.md', sha256: digest(lifecycleInstructions) },
    checklist: { path: 'assessor-checklist.json', sha256: digest(checklist) },
    artifactA: { arm: 'A', path: 'examples/A.md', sha256: digest(artifactA) },
    artifactB: { arm: 'B', path: 'examples/B.md', sha256: digest(artifactB) },
    eventsA: { arm: 'A', path: 'events/A.jsonl', sha256: digest(eventLogA) },
    eventsB: { arm: 'B', path: 'events/B.jsonl', sha256: digest(eventLogB) },
    modelsA: { arm: 'A', path: 'models/A.jsonl', sha256: digest(modelLog) },
    modelsB: { arm: 'B', path: 'models/B.jsonl', sha256: digest(modelLog) },
    rawArchive: { path: 'raw.tar.gz', sha256: digest(rawArchive) },
  }
  const suiteSha256 = await evaluationSuiteSha256(evaluationRoot)
  const decision = {
    schemaVersion: 1,
    decisionId: 'strict-protocol-decision',
    baselineId: 'strict-protocol-v2',
    decision: 'protocol',
    decidedAt: '2026-01-03T00:00:00.000Z',
    approverIds: ['approver-1', 'approver-2'],
    suiteSha256,
    rawArchiveSha256: digest(rawArchive),
    rawArchiveUrl: 'https://example.invalid/raw.tar.gz',
    files: Object.values(files).map(({ path, sha256 }) => ({ path, sha256 })),
    disagreements: [],
    rationale: 'Preserve this strict protocol fixture without promoting product-quality claims.',
  }
  const decisionBytes = JSON.stringify(decision, null, 2) + '\n'
  const manifest: Record<string, any> = {
    schemaVersion: 2,
    baselineId: 'strict-protocol-v2',
    status: 'protocol',
    createdAt: '2026-01-04T00:00:00.000Z',
    suiteSha256,
    harnessCommit: run.harnessCommit,
    ravenCommit: run.ravenCommit,
    rawArchiveSha256: digest(rawArchive),
    rawArchiveUrl: decision.rawArchiveUrl,
    rawArchive: files.rawArchive,
    promotionDecision: { path: 'promotion.json', sha256: digest(decisionBytes) },
    scenarios: [{
      scenarioId: scenario.id,
      pairId: 'strict-pair-1',
      replicate: 1,
      rawRunRoot: 'strict-pair-1',
      runManifest: files.run,
      report: files.report,
      reviews: files.reviews,
      unblinding: files.unblinding,
      reviewPacket: files.packet,
      reviewInstructions: files.instructions,
      lifecycleInstructions: files.lifecycleInstructions,
      assessorChecklist: files.checklist,
      examples: [files.artifactA, files.artifactB],
      eventLogs: [files.eventsA, files.eventsB],
      modelLogs: [files.modelsA, files.modelsB],
    }],
  }
  await Promise.all([
    mkdir(join(root, 'examples'), { recursive: true }),
    mkdir(join(root, 'events'), { recursive: true }),
    mkdir(join(root, 'models'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(root, 'run.json'), runBytes),
    writeFile(join(root, 'report.json'), reportBytes),
    writeFile(join(root, 'reviews.jsonl'), reviewsBytes),
    writeFile(join(root, 'unblinding.json'), unblinding),
    writeFile(join(root, 'packet.json'), packet),
    writeFile(join(root, 'REVIEW.md'), reviewInstructions),
    writeFile(join(root, 'LIFECYCLE_REVIEW.md'), lifecycleInstructions),
    writeFile(join(root, 'assessor-checklist.json'), checklist),
    writeFile(join(root, 'examples', 'A.md'), artifactA),
    writeFile(join(root, 'examples', 'B.md'), artifactB),
    writeFile(join(root, 'events', 'A.jsonl'), eventLogA),
    writeFile(join(root, 'events', 'B.jsonl'), eventLogB),
    writeFile(join(root, 'models', 'A.jsonl'), modelLog),
    writeFile(join(root, 'models', 'B.jsonl'), modelLog),
    writeFile(join(root, 'raw.tar.gz'), rawArchive),
    writeFile(join(root, 'promotion.json'), decisionBytes),
  ])
  const manifestPath = join(root, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return { manifestPath, manifest, decision, run }
}

describe('evaluation baseline manifest', () => {
  it('verifies immutable files and two independent complete reviews', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-baseline-'))
    await mkdir(join(root, 'examples'))
    const scenario = decodeEvaluationScenario(JSON.parse(await readFile(
      new URL('../../evaluation/scenarios/general-writing.json', import.meta.url), 'utf8',
    )))
    if (scenario === undefined) throw new Error('expected tracked general-writing scenario')
    const run = JSON.stringify({
      scenarioId: scenario.id,
      fixtureModel: true,
      promotable: false,
      outcomeComplete: true,
      parity: { pass: true },
    }, null, 2) + '\n'
    const report = '{"schemaVersion":1}\n'
    const artifactA = 'Artifact A.\n'
    const artifactB = 'Artifact B.\n'
    const binding = {
      packetManifestSha256: `sha256:${'1'.repeat(64)}`,
      mappingCommitmentSha256: `sha256:${'2'.repeat(64)}`,
      scenarioSha256: `sha256:${'3'.repeat(64)}`,
      rubricSha256: `sha256:${'4'.repeat(64)}`,
      assessorChecklistSha256: `sha256:${'5'.repeat(64)}`,
      artifacts: { A: digest(artifactA), B: digest(artifactB) },
    }
    const review = (id: number) => JSON.stringify({
      schemaVersion: 1,
      reviewId: `baseline-review-${id}`,
      reviewerId: `baseline-reviewer-${id}`,
      scenarioId: scenario.id,
      pairId: 'baseline-pair-1',
      blindOrder: ['A', 'B'],
      rubricVersion: 'v1',
      binding,
      dimensions: scenario.reviewDimensions.map((dimension) => {
        const traceOnly = dimension === 'checkpoint-usefulness' || dimension === 'completion-reliability'
        return {
          dimension,
          A: traceOnly ? 'n/a' : 'pass',
          B: traceOnly ? 'n/a' : 'pass',
          preference: traceOnly ? 'cannot-judge' : 'tie',
          confidence: 'medium',
          evidence: [],
          rationale: traceOnly
            ? 'Protocol fixture has no lifecycle judgment.'
            : 'No material distinction in this protocol-only fixture.',
        }
      }),
      overallPreference: 'tie',
      confidence: 'medium',
      armGuess: 'unknown',
      createdAt: `2026-01-0${id}T00:00:00.000Z`,
    })
    const reviews = review(1) + '\n' + review(2) + '\n'
    await Promise.all([
      writeFile(join(root, 'run.json'), run),
      writeFile(join(root, 'report.json'), report),
      writeFile(join(root, 'reviews.jsonl'), reviews),
      writeFile(join(root, 'examples', 'A.md'), artifactA),
      writeFile(join(root, 'examples', 'B.md'), artifactB),
    ])
    const suiteSha256 = await evaluationSuiteSha256(fileURLToPath(new URL('../../evaluation/', import.meta.url)))
    const manifest = {
      schemaVersion: 1,
      baselineId: 'protocol-v1',
      status: 'protocol',
      createdAt: '2026-01-03T00:00:00.000Z',
      suiteSha256,
      harnessCommit: 'b'.repeat(40),
      ravenCommit: 'c'.repeat(40),
      rawArchiveSha256: `sha256:${'d'.repeat(64)}`,
      rawArchiveUrl: 'https://example.invalid/protocol.tar.gz',
      scenarios: [{
        scenarioId: scenario.id,
        pairId: 'baseline-pair-1',
        runManifest: { path: 'run.json', sha256: digest(run) },
        report: { path: 'report.json', sha256: digest(report) },
        reviews: { path: 'reviews.jsonl', sha256: digest(reviews) },
        examples: [
          { arm: 'A', path: 'examples/A.md', sha256: digest(artifactA) },
          { arm: 'B', path: 'examples/B.md', sha256: digest(artifactB) },
        ],
      }],
    }
    const manifestPath = join(root, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    expect(await verifyEvaluationBaseline(manifestPath)).toEqual({
      pass: false,
      issues: ['baseline schemaVersion is unsupported; use schemaVersion 2'],
    })

    await writeFile(manifestPath, JSON.stringify({ ...manifest, status: 'production' }, null, 2) + '\n')
    expect((await verifyEvaluationBaseline(manifestPath)).issues).toContain('baseline schemaVersion is unsupported; use schemaVersion 2')

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(join(root, 'report.json'), '{"tampered":true}\n')
    expect((await verifyEvaluationBaseline(manifestPath)).issues).toContain('baseline schemaVersion is unsupported; use schemaVersion 2')
  })

  it('recomputes strict evidence instead of trusting promotable booleans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-strict-baseline-'))
    const fixture = await writeStrictProtocolBaseline(root)

    expect(await verifyEvaluationBaseline(fixture.manifestPath)).toEqual({
      pass: true,
      status: 'protocol',
      scenarios: ['general-writing'],
      issues: [],
    })

    fixture.run.fixtureModel = true
    const runBytes = JSON.stringify(fixture.run, null, 2) + '\n'
    await writeFile(join(root, 'run.json'), runBytes)
    fixture.manifest.scenarios[0].runManifest.sha256 = digest(runBytes)
    const runDecisionFile = fixture.decision.files.find((file: { path: string }) => file.path === 'run.json')
    if (runDecisionFile === undefined) throw new Error('expected decision run file')
    runDecisionFile.sha256 = digest(runBytes)
    const decisionBytes = JSON.stringify(fixture.decision, null, 2) + '\n'
    await writeFile(join(root, 'promotion.json'), decisionBytes)
    fixture.manifest.promotionDecision.sha256 = digest(decisionBytes)
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest, null, 2) + '\n')

    expect((await verifyEvaluationBaseline(fixture.manifestPath)).issues)
      .toContain('general-writing run is not independently production-eligible')
  })

  it('recomputes model-route and tool-access evidence from preserved ledgers', async () => {
    const routeRoot = await mkdtemp(join(tmpdir(), 'raven-route-baseline-'))
    const routeFixture = await writeStrictProtocolBaseline(routeRoot)
    const rogueModelLog = '{"generation":"process-1","provider":"rogue","model":"fallback"}\n'
    await writeFile(join(routeRoot, 'models', 'A.jsonl'), rogueModelLog)
    routeFixture.manifest.scenarios[0].modelLogs[0].sha256 = digest(rogueModelLog)
    routeFixture.decision.files.find((file: { path: string }) => file.path === 'models/A.jsonl').sha256 = digest(rogueModelLog)
    let decisionBytes = JSON.stringify(routeFixture.decision, null, 2) + '\n'
    await writeFile(join(routeRoot, 'promotion.json'), decisionBytes)
    routeFixture.manifest.promotionDecision.sha256 = digest(decisionBytes)
    await writeFile(routeFixture.manifestPath, JSON.stringify(routeFixture.manifest, null, 2) + '\n')
    expect((await verifyEvaluationBaseline(routeFixture.manifestPath)).issues[0]).toContain('used undeclared model route ["rogue","fallback"]')

    const toolRoot = await mkdtemp(join(tmpdir(), 'raven-tool-baseline-'))
    const toolFixture = await writeStrictProtocolBaseline(toolRoot)
    const shellEvent = '{"event":{"type":"tool/code-dispatch-start","seq":1,"data":{"name":"pwsh","arguments":{"command":"Get-Content assessor-facts.json"}}}}\n'
    await writeFile(join(toolRoot, 'events', 'A.jsonl'), shellEvent)
    toolFixture.manifest.scenarios[0].eventLogs[0].sha256 = digest(shellEvent)
    toolFixture.decision.files.find((file: { path: string }) => file.path === 'events/A.jsonl').sha256 = digest(shellEvent)
    decisionBytes = JSON.stringify(toolFixture.decision, null, 2) + '\n'
    await writeFile(join(toolRoot, 'promotion.json'), decisionBytes)
    toolFixture.manifest.promotionDecision.sha256 = digest(decisionBytes)
    await writeFile(toolFixture.manifestPath, JSON.stringify(toolFixture.manifest, null, 2) + '\n')
    expect((await verifyEvaluationBaseline(toolFixture.manifestPath)).issues[0]).toContain('used a forbidden nested tool')
  })

  it('requires real raw archive bytes and an explicit matching decision', async () => {
    const rawRoot = await mkdtemp(join(tmpdir(), 'raven-raw-baseline-'))
    const rawFixture = await writeStrictProtocolBaseline(rawRoot)
    await writeFile(join(rawRoot, 'raw.tar.gz'), 'tampered raw archive\n')
    expect((await verifyEvaluationBaseline(rawFixture.manifestPath)).issues)
      .toContain('raw archive digest mismatch')

    const decisionRoot = await mkdtemp(join(tmpdir(), 'raven-decision-baseline-'))
    const decisionFixture = await writeStrictProtocolBaseline(decisionRoot)
    decisionFixture.decision.decision = 'promote'
    const decisionBytes = JSON.stringify(decisionFixture.decision, null, 2) + '\n'
    await writeFile(join(decisionRoot, 'promotion.json'), decisionBytes)
    decisionFixture.manifest.promotionDecision.sha256 = digest(decisionBytes)
    await writeFile(decisionFixture.manifestPath, JSON.stringify(decisionFixture.manifest, null, 2) + '\n')
    expect((await verifyEvaluationBaseline(decisionFixture.manifestPath)).issues)
      .toContain('promotion decision does not authorize this baseline status')
  })

  it('binds every promotion resolution to one exact scenario pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-resolution-baseline-'))
    const fixture = await writeStrictProtocolBaseline(root)
    fixture.decision.disagreements = [{
      scenarioId: 'general-writing',
      pairId: 'unknown-pair',
      dimension: 'final-prose-quality',
      reviewIds: ['strict-review-1', 'strict-review-2'],
      overallReviewIds: ['strict-review-1'],
      disposition: 'retained',
      rationale: 'Preserve the reviewed disagreement.',
    }]
    const decisionBytes = JSON.stringify(fixture.decision, null, 2) + '\n'
    await writeFile(join(root, 'promotion.json'), decisionBytes)
    fixture.manifest.promotionDecision.sha256 = digest(decisionBytes)
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest, null, 2) + '\n')

    expect((await verifyEvaluationBaseline(fixture.manifestPath)).issues)
      .toContain('promotion decision contains a resolution for an unknown scenario pair')
  })

  it('requires unique replicate ordinals before production counterbalancing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-replicate-baseline-'))
    const fixture = await writeStrictProtocolBaseline(root)
    fixture.manifest.scenarios.push({ ...fixture.manifest.scenarios[0], pairId: 'strict-pair-2' })
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest, null, 2) + '\n')

    expect((await verifyEvaluationBaseline(fixture.manifestPath)).issues)
      .toContain('general-writing baseline replicate ordinals are not unique')
  })

  it('replays filesystem depth-first traversal order from archive paths', () => {
    expect(['wiki.md', 'wiki/concepts/item.md', 'sources/z.md', 'sources/a.md', 'SOURCE_CATALOG.json', 'AGENTS.md']
      .sort(compareArchiveTreeTraversalOrder))
      .toEqual(['AGENTS.md', 'SOURCE_CATALOG.json', 'sources/a.md', 'sources/z.md', 'wiki/concepts/item.md', 'wiki.md'])
  })

  it('decodes only canonical digest-bound raw archive members', () => {
    const content = Buffer.from('raw evidence\n')
    const archive = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      files: [{ path: 'run-1/manifest.json', sha256: digest(content), base64: content.toString('base64') }],
    }))

    expect(decodeRawEvaluationArchive(archive).get('run-1/manifest.json')).toEqual(content)
    expect(() => decodeRawEvaluationArchive(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      files: [{ path: '../escape', sha256: digest(content), base64: content.toString('base64') }],
    })))).toThrow('raw archive file 0.path is invalid')
    expect(() => decodeRawEvaluationArchive(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      files: [{ path: 'run/file', sha256: digest(content), base64: Buffer.from('tampered').toString('base64') }],
    })))).toThrow('digest or base64 mismatch')
  })

  it('writes a deterministic raw archive from immutable run trees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-archive-'))
    const run = join(root, 'run-1')
    const output = join(root, 'archive.json')
    await mkdir(join(run, 'arm'), { recursive: true })
    await writeFile(join(run, 'arm', 'evidence.txt'), 'evidence bytes\n')

    const first = await writeRawEvaluationArchive([run], output)
    const bytes = await readFile(output)
    expect(first).toBe(digest(bytes))
    expect(decodeRawEvaluationArchive(bytes).get('run-1/arm/evidence.txt')?.toString('utf8')).toBe('evidence bytes\n')
  })

  it('rejects a symlink supplied as a raw archive run root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-archive-root-link-'))
    const run = join(root, 'run-target')
    const linkedRun = join(root, 'run-link')
    await mkdir(run)
    await writeFile(join(run, 'evidence.txt'), 'evidence bytes\n')
    try {
      await symlink(run, linkedRun, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }

    await expect(writeRawEvaluationArchive([linkedRun], join(root, 'archive.json')))
      .rejects.toThrow('rejects non-directory or symlink run root')
  })

  it('enumerates only tracked baseline manifests for the deterministic check gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-baseline-git-'))
    const evaluationRoot = join(root, 'evaluation')
    await Promise.all([
      mkdir(join(evaluationRoot, 'baselines', 'tracked'), { recursive: true }),
      mkdir(join(evaluationRoot, 'baselines', 'untracked'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(evaluationRoot, 'baselines', 'tracked', 'manifest.json'), '{}\n'),
      writeFile(join(evaluationRoot, 'baselines', 'untracked', 'manifest.json'), '{}\n'),
    ])
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['add', 'evaluation/baselines/tracked/manifest.json'], { cwd: root, stdio: 'ignore' })

    const result = await verifyTrackedEvaluationBaselines(evaluationRoot, root)

    expect(result.pass).toBe(false)
    expect(result.manifests.map(manifest => manifest.path)).toEqual([
      'evaluation/baselines/tracked/manifest.json',
    ])
    expect(result.issues[0]).toContain('evaluation/baselines/tracked/manifest.json')
    expect(result.issues.join('\n')).not.toContain('untracked')
  })
})
