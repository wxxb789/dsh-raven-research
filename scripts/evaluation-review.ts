import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import {
  decodeEvaluationAssessorCatalog,
  decodeEvaluationScenario,
  type EvaluationReviewBinding,
} from './evaluation.js'

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function confined(root: string, ...parts: string[]): string {
  const path = resolve(root, ...parts)
  const fromRoot = relative(root, path)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('run manifest path escapes its evidence root')
  return path
}

async function readIfPresent(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const PROCESS_GENERATION_ID = /^process-[1-9][0-9]*$/u

interface RunManifest {
  scenarioId: string
  scenarioSha256: string
  rubricSha256: string
  order: [string, string]
  arms: Record<string, { path: string; artifactPath: string; artifactSha256: string }>
}

async function artifactPath(runRoot: string, armPath: string): Promise<string> {
  const root = confined(runRoot, armPath)
  const progress = JSON.parse(await readFile(join(root, 'progress.json'), 'utf8')) as {
    processGenerationIds?: unknown
  }
  if (!Array.isArray(progress.processGenerationIds) || progress.processGenerationIds.length === 0) {
    throw new Error(`run arm has no process generation evidence: ${armPath}`)
  }
  const generation = progress.processGenerationIds.at(-1)
  if (typeof generation !== 'string' || !PROCESS_GENERATION_ID.test(generation)) {
    throw new Error(`run arm has an invalid process generation: ${armPath}`)
  }
  return confined(root, `artifact-${generation}.md`)
}

export function evaluationAssessorChecklist(
  scenario: NonNullable<ReturnType<typeof decodeEvaluationScenario>>,
  catalog: NonNullable<ReturnType<typeof decodeEvaluationAssessorCatalog>>,
): string {
  const facts = scenario.expectations.requiredFactIds.map((id) => {
    const fact = catalog.facts.find(candidate => candidate.id === id)
    if (fact === undefined) throw new Error(`scenario ${scenario.id} requires missing assessor fact: ${id}`)
    return fact
  })
  const contradictions = scenario.expectations.contradictionIds.map((id) => {
    const contradiction = catalog.contradictions.find(candidate => candidate.id === id)
    if (contradiction === undefined) throw new Error(`scenario ${scenario.id} requires missing assessor contradiction: ${id}`)
    return contradiction
  })
  return JSON.stringify({
    schemaVersion: 1,
    scenarioId: scenario.id,
    notice: 'Assessor-only checklist for blinded human review. Never provide this file to an evaluated model arm.',
    facts,
    contradictions,
    forbiddenArtifactQuotes: scenario.expectations.forbiddenArtifactQuotes,
    automatedFloors: {
      minimumIndependentSourceFamilies: scenario.expectations.minimumIndependentSourceFamilies,
      minimumCheckpoints: scenario.expectations.minimumCheckpoints,
      requireStopResume: scenario.expectations.requireStopResume,
      requireKnowledgeReuse: scenario.expectations.requireKnowledgeReuse,
      requireStructureChoice: scenario.expectations.requireStructureChoice,
      requireMultiModelDraft: scenario.expectations.requireMultiModelDraft,
      allowedTerminalStatuses: scenario.expectations.allowedTerminalStatuses,
    },
  }, null, 2) + '\n'
}

const LIFECYCLE_DIMENSIONS = new Set([
  'steering-retention', 'checkpoint-usefulness', 'stop-resume-durability', 'knowledge-reuse',
  'completion-reliability', 'cost-value',
])

export function evaluationReviewInstructions(
  scenario: NonNullable<ReturnType<typeof decodeEvaluationScenario>>,
): { content: string; lifecycle: string } {
  const reviewRows = scenario.reviewDimensions.map(dimension => LIFECYCLE_DIMENSIONS.has(dimension)
    ? `| ${dimension} | n/a | n/a | cannot-judge | defer to unblinded lifecycle review |`
    : `| ${dimension} | pass / concern / fail / n/a | pass / concern / fail / n/a | A / B / tie / cannot-judge | exact Artifact or Source quote; rationale |`).join('\n')
  const content = [
    `# Blinded review — ${scenario.title}`,
    '',
    scenario.description,
    '',
    'Read `scenario.json`, `assessor-checklist.json`, `rubric.md`, `manifest.json`, the frozen `sources/`, and `A.md` / `B.md`. Do not inspect the parent directory until the review is committed.',
    'Copy the exact object from `binding.json` into the review record `binding` field and list every assessor-checklist fact/contradiction ID in `assessorIds`. Every non-n/a judgment needs exact evidence. Set sourceId only when exactQuote comes from that frozen Source; use sourceId=null for an Artifact quote.',
    'Mark lifecycle/control/cost dimensions n/a here; they are reviewed only after content judgments are fixed. Do not calculate an aggregate score.',
    '',
    '| Dimension | A | B | Preference | Evidence and rationale |',
    '| --- | --- | --- | --- | --- |',
    reviewRows,
    '',
    'Overall preference: A / B / tie / cannot-judge',
    'Confidence: low / medium / high',
    'Arm guess: A-is-vanilla / B-is-vanilla / unknown',
    '',
  ].join('\n')
  const lifecycleRows = scenario.reviewDimensions.map(dimension => LIFECYCLE_DIMENSIONS.has(dimension)
    ? `| ${dimension} | pass / concern / fail / n/a | pass / concern / fail / n/a | event seq / usage field / workspace path and rationale |`
    : `| ${dimension} | n/a | n/a | content-only; already reviewed blind |`).join('\n')
  const lifecycle = [
    `# Unblinded lifecycle review — ${scenario.title}`,
    '',
    'Start only after the blinded content review is immutable. Use unblinding.json for A/B identity.',
    'Copy the exact review binding from unblinding.json and use assessorIds=[]. Checkpoint, steering, stop/resume, knowledge reuse, and Completion judgments require exact Session event sequence evidence.',
    'Cost-value cites manifest usage fields. Do not revise content judgments here.',
    '',
    '| Dimension | A | B | Evidence and rationale |',
    '| --- | --- | --- | --- |',
    lifecycleRows,
    '',
  ].join('\n')
  return { content, lifecycle }
}

/** Prepare one create-once content-blinded review batch and keep the mapping outside its packet. */
export async function prepareEvaluationReview(
  runRootValue: string,
  seed: string,
  evaluationRootValue = resolve('evaluation'),
): Promise<string> {
  if (seed.trim() === '') throw new Error('review seed must be non-empty')
  const runRoot = resolve(runRootValue)
  const evaluationRoot = resolve(evaluationRootValue)
  const manifestBytes = await readFile(join(runRoot, 'manifest.json'))
  const rawManifest = JSON.parse(manifestBytes.toString('utf8')) as Partial<RunManifest>
  if (typeof rawManifest.scenarioId !== 'string' || typeof rawManifest.arms !== 'object' || rawManifest.arms === null
    || !Array.isArray(rawManifest.order) || rawManifest.order.length !== 2 || new Set(rawManifest.order).size !== 2) {
    throw new Error('run manifest is missing scenario, arm paths, or a two-arm order')
  }
  const manifest = rawManifest as RunManifest
  const firstArm = manifest.arms[manifest.order[0]]
  const secondArm = manifest.arms[manifest.order[1]]
  if (firstArm === undefined || secondArm === undefined) throw new Error('run manifest order names an absent arm')

  const scenarioPath = confined(runRoot, firstArm.path, 'scenario.json')
  const scenarioBytes = await readFile(scenarioPath)
  if (digest(scenarioBytes) !== manifest.scenarioSha256) throw new Error('frozen scenario digest does not match run manifest')
  const scenario = decodeEvaluationScenario(JSON.parse(scenarioBytes.toString('utf8')))
  if (scenario === undefined || scenario.id !== manifest.scenarioId) {
    throw new Error(`run references an invalid scenario: ${manifest.scenarioId}`)
  }
  const rubricPath = confined(runRoot, firstArm.path, 'rubric.md')
  const rubricBytes = await readFile(rubricPath)
  if (digest(rubricBytes) !== manifest.rubricSha256) throw new Error('frozen rubric digest does not match run manifest')
  const catalog = decodeEvaluationAssessorCatalog(JSON.parse(
    await readFile(resolve(evaluationRoot, 'assessor-facts.json'), 'utf8'),
  ))
  if (catalog === undefined) throw new Error('evaluation assessor catalog is invalid')
  const checklistContent = evaluationAssessorChecklist(scenario, catalog)

  const artifactPaths = Object.fromEntries(await Promise.all(manifest.order.map(async condition => [
    condition,
    await artifactPath(runRoot, manifest.arms[condition]!.path),
  ]))) as Record<string, string>
  const swap = createHash('sha256').update(`${seed}\0${manifest.scenarioId}`).digest()[0]! % 2 === 0
  const mapping = swap
    ? { A: manifest.order[1]!, B: manifest.order[0]! }
    : { A: manifest.order[0]!, B: manifest.order[1]! }
  const seedSha256 = digest(seed)
  const mappingCommitmentSha256 = digest(`${seedSha256}\0${JSON.stringify(mapping)}`)
  const artifactContents = {} as Record<'A' | 'B', Buffer>
  const artifactDigests = {} as Record<'A' | 'B', string>
  for (const alias of ['A', 'B'] as const) {
    const condition = mapping[alias]
    const arm = manifest.arms[condition]
    if (arm === undefined) throw new Error(`run manifest has no arm ${condition}`)
    const content = await readFile(artifactPaths[condition] as string)
    if (digest(content) !== arm.artifactSha256) throw new Error(`${condition} Artifact digest does not match run manifest`)
    artifactContents[alias] = content
    artifactDigests[alias] = digest(content)
  }

  const sourceContents = await Promise.all(scenario.sources.map(async (source) => {
    const sourcePath = confined(runRoot, firstArm.path, 'input-workspace', source.path)
    const content = await readFile(sourcePath)
    if (digest(content) !== source.sha256) throw new Error(`frozen Source digest does not match scenario: ${source.id}`)
    return { path: `sources/${source.id}-${basename(source.path)}`, content }
  }))
  const lifecycleCopies = await Promise.all(manifest.order.map(async (condition) => {
    const arm = manifest.arms[condition]
    if (arm === undefined) throw new Error(`run manifest has no arm ${condition}`)
    const root = confined(runRoot, arm.path)
    const files = await Promise.all(['session.jsonl', 'progress.json', 'model-calls.jsonl', 'service-calls.jsonl'].map(async name => ({
      name,
      content: await readIfPresent(join(root, name)),
    })))
    return { condition, files }
  }))

  const instructions = evaluationReviewInstructions(scenario)
  const reviewContent = instructions.content
  const lifecycleReviewContent = instructions.lifecycle

  const packetFiles = new Map<string, string | Buffer>([
    ['A.md', artifactContents.A],
    ['B.md', artifactContents.B],
    ['rubric.md', rubricBytes],
    ['scenario.json', scenarioBytes],
    ['assessor-checklist.json', checklistContent],
    ['REVIEW.md', reviewContent],
    ...sourceContents.map(source => [source.path, source.content] as const),
  ])
  const fileDigests = Object.fromEntries([...packetFiles.entries()]
    .map(([path, content]) => [path, digest(content)] as const)
    .sort(([left], [right]) => left.localeCompare(right)))
  const packetManifestContent = JSON.stringify({
    schemaVersion: 1,
    pairId: basename(runRoot),
    scenarioId: scenario.id,
    scenarioSha256: digest(scenarioBytes),
    rubricVersion: 'v1',
    rubricSha256: digest(rubricBytes),
    assessorChecklistSha256: digest(checklistContent),
    mappingCommitmentSha256,
    artifacts: artifactDigests,
    files: fileDigests,
    sources: scenario.sources.map(source => ({
      id: source.id,
      title: source.title,
      origin: source.origin,
      uri: source.uri,
      quality: source.quality,
      family: source.family,
      asOf: source.asOf,
      sha256: source.sha256,
    })),
  }, null, 2) + '\n'
  const binding: EvaluationReviewBinding = {
    packetManifestSha256: digest(packetManifestContent),
    mappingCommitmentSha256,
    scenarioSha256: digest(scenarioBytes),
    rubricSha256: digest(rubricBytes),
    assessorChecklistSha256: digest(checklistContent),
    artifacts: artifactDigests,
  }
  const unblindingContent = JSON.stringify({
    schemaVersion: 1,
    seedSha256,
    pairId: basename(runRoot),
    scenarioId: scenario.id,
    binding,
    mapping,
  }, null, 2) + '\n'

  const reviewRoot = join(runRoot, 'review')
  const stagingRoot = join(runRoot, `.review-${randomUUID()}`)
  const packetRoot = join(stagingRoot, 'packet')
  const lifecycleRoot = join(stagingRoot, 'lifecycle')
  await mkdir(join(packetRoot, 'sources'), { recursive: true })
  try {
    await mkdir(lifecycleRoot, { recursive: true })
    await Promise.all([...packetFiles.entries()].map(async ([path, content]) => {
      const target = join(packetRoot, path)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, content)
    }))
    await Promise.all([
      writeFile(join(packetRoot, 'manifest.json'), packetManifestContent),
      writeFile(join(packetRoot, 'binding.json'), JSON.stringify(binding, null, 2) + '\n'),
      writeFile(join(stagingRoot, 'unblinding.json'), unblindingContent),
      writeFile(join(lifecycleRoot, 'manifest.json'), manifestBytes),
      writeFile(join(lifecycleRoot, 'LIFECYCLE_REVIEW.md'), lifecycleReviewContent),
    ])
    for (const copy of lifecycleCopies) {
      const target = join(lifecycleRoot, copy.condition)
      await mkdir(target, { recursive: true })
      await Promise.all(copy.files.flatMap(file => file.content === undefined
        ? []
        : [writeFile(join(target, file.name), file.content)]))
    }
    try {
      await rename(stagingRoot, reviewRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST'
        || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY'
        || (error as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error(`review batch already exists and is immutable: ${reviewRoot}`)
      }
      throw error
    }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    throw error
  }
  return join(reviewRoot, 'packet')
}
