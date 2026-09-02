import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'

import {
  decodeEvaluationReview,
  decodeEvaluationScenario,
  verifyEvaluationReviews,
  type EvaluationReview,
  type EvaluationUsage,
} from './evaluation.js'

function digest(value: Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function confined(root: string, ...parts: string[]): string {
  const path = resolve(root, ...parts)
  const fromRoot = relative(root, path)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('run manifest path escapes its evidence root')
  return path
}

interface ArmSummary {
  path: string
  initialWorkspaceSha256: string
  terminalStatus: string | null
  artifactPath: string
  artifactSha256: string
  ravenTask: { taskId: string; phase: string; revision: number; checkpoints: number } | null
  usage: EvaluationUsage
  protocolFailures?: { toolResults: number | null; ptcNested: number | null }
  modelRoutes?: string[]
  modelRoutesValid?: boolean
}

interface Manifest {
  schemaVersion: 1
  scenarioId: string
  scenarioKind: 'primary' | 'ablation'
  scenarioSha256: string
  inputsSha256: string
  sourceSnapshotSha256: string
  baseCompositionSha256: string
  parity: { pass: boolean }
  automatedFloor?: { frozenInputParity?: boolean; toolAccessFloor?: boolean }
  provider: string
  model: string
  reasoningEffort: string | null
  maxTokens: number
  order: [string, string]
  fixtureModel: boolean
  outcomeComplete: boolean
  promotable: boolean
  harnessCommit: string
  harnessDirty: boolean
  ravenCommit: string
  ravenDirty: boolean
  arms: Record<string, ArmSummary>
}

function delta(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : right - left
}

function usageDelta(vanilla: EvaluationUsage, raven: EvaluationUsage): EvaluationUsage {
  return {
    uncachedInputTokens: delta(vanilla.uncachedInputTokens, raven.uncachedInputTokens),
    cacheReadTokens: delta(vanilla.cacheReadTokens, raven.cacheReadTokens),
    cacheWriteTokens: delta(vanilla.cacheWriteTokens, raven.cacheWriteTokens),
    outputTokens: delta(vanilla.outputTokens, raven.outputTokens),
    totalTokens: delta(vanilla.totalTokens, raven.totalTokens),
    reasoningTokens: delta(vanilla.reasoningTokens, raven.reasoningTokens),
    modelCalls: delta(vanilla.modelCalls, raven.modelCalls),
    toolCalls: delta(vanilla.toolCalls, raven.toolCalls),
    ptcNestedCalls: delta(vanilla.ptcNestedCalls, raven.ptcNestedCalls),
    searchCalls: delta(vanilla.searchCalls, raven.searchCalls),
    fetchCalls: delta(vanilla.fetchCalls, raven.fetchCalls),
    durationMs: delta(vanilla.durationMs, raven.durationMs),
  }
}

function value(input: number | null): string {
  return input === null ? 'unavailable' : String(input)
}

async function attachedReviews(runRoot: string, manifest: Manifest): Promise<{
  records: EvaluationReview[]
  pass: boolean
  issues: string[]
}> {
  let content: string
  try {
    content = await readFile(resolve(runRoot, 'reviews.jsonl'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], pass: false, issues: ['reviews.jsonl is not attached'] }
    throw error
  }
  const records = content.split('\n').filter(Boolean).map((line) => {
    const decoded = decodeEvaluationReview(JSON.parse(line))
    if (decoded === undefined) throw new Error('reviews.jsonl contains an invalid record')
    return decoded
  })
  const firstArm = manifest.arms[manifest.order[0]]
  if (firstArm === undefined) throw new Error('manifest order names an absent arm')
  const scenarioBytes = await readFile(confined(runRoot, firstArm.path, 'scenario.json'))
  const scenario = decodeEvaluationScenario(JSON.parse(scenarioBytes.toString('utf8')))
  if (scenario === undefined) throw new Error('run has an invalid frozen scenario')
  const checked = verifyEvaluationReviews(scenario, basename(runRoot), records)
  return { records, ...checked }
}

/** Produce an auditable factual report without a weighted score or automatic winner. */
export async function writeEvaluationReport(runRootValue: string): Promise<{ json: string; markdown: string }> {
  const runRoot = resolve(runRootValue)
  const manifest = JSON.parse(await readFile(resolve(runRoot, 'manifest.json'), 'utf8')) as Manifest
  const reviews = await attachedReviews(runRoot, manifest)
  const [leftCondition, rightCondition] = manifest.order
  const leftArm = manifest.arms[leftCondition]
  const rightArm = manifest.arms[rightCondition]
  if (leftArm === undefined || rightArm === undefined) throw new Error('manifest order names an absent arm')
  const workspaceEqual = leftArm.initialWorkspaceSha256 === rightArm.initialWorkspaceSha256
  const artifactIntegrity = (await Promise.all(manifest.order.map(async (condition) => {
    const arm = manifest.arms[condition]!
    const path = confined(runRoot, arm.path, arm.artifactPath)
    return digest(await readFile(path)) === arm.artifactSha256
  }))).every(Boolean)
  const hashesPresent = [
    manifest.scenarioSha256,
    manifest.inputsSha256,
    manifest.sourceSnapshotSha256,
    manifest.baseCompositionSha256,
  ].every(hash => /^sha256:[a-f0-9]{64}$/.test(hash))
  const methodologyValid = manifest.schemaVersion === 1
    && !manifest.fixtureModel
    && !manifest.harnessDirty
    && !manifest.ravenDirty
    && manifest.parity?.pass === true
    && manifest.automatedFloor?.frozenInputParity === true
    && manifest.automatedFloor.toolAccessFloor === true
    && leftArm.modelRoutesValid === true
    && rightArm.modelRoutesValid === true
    && artifactIntegrity
    && hashesPresent
    && workspaceEqual
    && manifest.order.length === 2
    && new Set(manifest.order).size === 2
  const limitations = [
    ...(manifest.fixtureModel ? ['fixture model run: output quality is not evidence'] : []),
    ...(manifest.harnessDirty ? ['Harness checkout was dirty'] : []),
    ...(manifest.ravenDirty ? ['Raven checkout was dirty; this development run cannot be promoted'] : []),
    ...(manifest.parity?.pass !== true ? ['non-treatment prompt/tool parity was not established'] : []),
    ...(manifest.automatedFloor?.frozenInputParity !== true ? ['arm scenario/rubric byte parity was not established'] : []),
    ...(manifest.automatedFloor?.toolAccessFloor !== true ? ['an arm used a tool or read path outside the model-visible evaluation surface'] : []),
    ...(leftArm.modelRoutesValid !== true || rightArm.modelRoutesValid !== true
      ? ['one or more recorded model calls used an undeclared provider/model route'] : []),
    ...(!artifactIntegrity ? ['one or more preserved Artifact digests do not match'] : []),
    ...(!hashesPresent ? ['one or more required environment/input digests are missing or malformed'] : []),
    ...(!workspaceEqual ? ['arm workspace snapshots differ'] : []),
    ...(!manifest.outcomeComplete ? ['one or more business outcomes did not complete at the scenario floor'] : []),
    ...(!reviews.pass ? reviews.issues : []),
  ]
  const report = {
    schemaVersion: 1,
    scenarioId: manifest.scenarioId,
    validity: {
      methodologyValid,
      parity: manifest.parity?.pass === true,
      frozenInputParity: manifest.automatedFloor?.frozenInputParity === true,
      toolAccessFloor: manifest.automatedFloor?.toolAccessFloor === true,
      modelRoutesValid: leftArm.modelRoutesValid === true && rightArm.modelRoutesValid === true,
      workspaceEqual,
      artifactIntegrity,
      hashesPresent,
      fixtureModel: manifest.fixtureModel,
      harnessDirty: manifest.harnessDirty,
      ravenDirty: manifest.ravenDirty,
      promotable: manifest.promotable,
    },
    environment: {
      provider: manifest.provider,
      model: manifest.model,
      reasoningEffort: manifest.reasoningEffort,
      maxTokens: manifest.maxTokens,
      harnessCommit: manifest.harnessCommit,
      ravenCommit: manifest.ravenCommit,
      baseCompositionSha256: manifest.baseCompositionSha256,
      sourceSnapshotSha256: manifest.sourceSnapshotSha256,
      inputsSha256: manifest.inputsSha256,
      order: manifest.order,
    },
    outcomes: {
      left: {
        condition: leftCondition,
        terminalStatus: leftArm.terminalStatus,
        ravenTask: leftArm.ravenTask,
        protocolFailures: leftArm.protocolFailures ?? null,
        modelRoutes: leftArm.modelRoutes ?? null,
        modelRoutesValid: leftArm.modelRoutesValid ?? false,
        artifact: `${leftArm.path}/${leftArm.artifactPath}`,
        artifactSha256: leftArm.artifactSha256,
      },
      right: {
        condition: rightCondition,
        terminalStatus: rightArm.terminalStatus,
        ravenTask: rightArm.ravenTask,
        protocolFailures: rightArm.protocolFailures ?? null,
        modelRoutes: rightArm.modelRoutes ?? null,
        modelRoutesValid: rightArm.modelRoutesValid ?? false,
        artifact: `${rightArm.path}/${rightArm.artifactPath}`,
        artifactSha256: rightArm.artifactSha256,
      },
      scenarioFloorPassed: manifest.outcomeComplete,
    },
    usage: {
      left: leftArm.usage,
      right: rightArm.usage,
      rightMinusLeft: usageDelta(leftArm.usage, rightArm.usage),
    },
    review: {
      status: reviews.pass ? 'structurally-complete-unverified' : 'required',
      attached: reviews.records.length > 0,
      pass: reviews.pass,
      evidenceBindingVerified: false,
      reviewerIds: reviews.records.map(review => review.reviewerId),
      records: reviews.records,
      issues: reviews.issues,
    },
    limitations,
  }
  const usageRows = (Object.keys(report.usage.left) as Array<keyof EvaluationUsage>).map(metric =>
    `| ${metric} | ${value(report.usage.left[metric])} | ${value(report.usage.right[metric])} | ${value(report.usage.rightMinusLeft[metric])} |`).join('\n')
  const markdown = [
    `# Raven evaluation report — ${manifest.scenarioId}`,
    '',
    '> This report preserves measured facts only. It contains no weighted score or automatic winner.',
    '',
    '## Validity',
    '',
    `- Methodologically valid pair: **${methodologyValid ? 'yes' : 'no'}**`,
    `- Baseline-promotable: **${manifest.promotable ? 'yes' : 'no'}**`,
    `- Identical initial workspace bytes: **${workspaceEqual ? 'yes' : 'no'}**`,
    `- Model-visible tool/read isolation: **${manifest.automatedFloor?.toolAccessFloor === true ? 'yes' : 'no'}**`,
    `- Recorded model routes allowed: **${leftArm.modelRoutesValid === true && rightArm.modelRoutesValid === true ? 'yes' : 'no'}**`,
    `- Arm order: ${manifest.order.join(' → ')}`,
    '',
    '## Completion',
    '',
    `- ${leftCondition} Harness terminal: ${leftArm.terminalStatus ?? 'unavailable'}`,
    `- ${rightCondition} Harness terminal: ${rightArm.terminalStatus ?? 'unavailable'}`,
    `- ${leftCondition} Raven Task phase: ${leftArm.ravenTask?.phase ?? 'not applicable'}`,
    `- ${rightCondition} Raven Task phase: ${rightArm.ravenTask?.phase ?? 'not applicable'}`,
    `- ${leftCondition} protocol failures: ${JSON.stringify(leftArm.protocolFailures ?? 'unavailable')}`,
    `- ${rightCondition} protocol failures: ${JSON.stringify(rightArm.protocolFailures ?? 'unavailable')}`,
    `- ${leftCondition} recorded model routes: ${JSON.stringify(leftArm.modelRoutes ?? 'unavailable')}`,
    `- ${rightCondition} recorded model routes: ${JSON.stringify(rightArm.modelRoutes ?? 'unavailable')}`,
    `- Scenario floor passed: **${manifest.outcomeComplete ? 'yes' : 'no'}**`,
    '',
    '## Usage',
    '',
    `| Metric | ${leftCondition} | ${rightCondition} | ${rightCondition} − ${leftCondition} |`,
    '| --- | ---: | ---: | ---: |',
    usageRows,
    '',
    '## Artifacts',
    '',
    `- ${leftCondition}: \`${report.outcomes.left.artifact}\` (${report.outcomes.left.artifactSha256})`,
    `- ${rightCondition}: \`${report.outcomes.right.artifact}\` (${report.outcomes.right.artifactSha256})`,
    '',
    '## Review',
    '',
    reviews.pass
      ? `Structurally complete: ${reviews.records.length} independent categorical review records are attached in \`reviews.jsonl\`; quote/event binding remains unverified until schema-v2 baseline verification.`
      : `Required: ${reviews.issues.join('; ')}. Use \`pnpm run eval -- review\`; preserve categorical judgments and exact evidence.`,
    '',
    '## Limitations',
    '',
    ...limitations.map(item => `- ${item}`),
    '',
  ].join('\n')
  const jsonPath = resolve(runRoot, 'report.json')
  const markdownPath = resolve(runRoot, 'report.md')
  await Promise.all([
    writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n'),
    writeFile(markdownPath, markdown),
  ])
  return { json: jsonPath, markdown: markdownPath }
}
