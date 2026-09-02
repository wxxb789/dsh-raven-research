import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, posix, relative, resolve, win32 } from 'node:path'

import {
  analyzeEvaluationReviewsForPromotion,
  CORE_EVALUATION_SCENARIO_IDS,
  decodeEvaluationAssessorCatalog,
  EVALUATION_EXECUTION_TOOL_ALLOWLIST,
  normalizeEvaluationToolsSdk,
  decodeEvaluationReview,
  decodeEvaluationReviewBinding,
  decodeEvaluationScenario,
  evaluationSourceSnapshotSha256,
  evaluationSuiteSha256,
  verifyEvaluationReviews,
  type EvaluationReview,
  type EvaluationReviewBinding,
  type EvaluationReviewDimension,
  type EvaluationReviewDisagreementResolution,
  type EvaluationScenario,
} from './evaluation.js'
import { decodeRavenTaskState } from '../src/codec.js'
import { ravenStateMetas } from './evaluation-runner-plugin.js'
import { evaluationAssessorChecklist, evaluationReviewInstructions } from './evaluation-review.js'
import { runProcess } from './process.js'

interface BaselineFile {
  path: string
  sha256: string
}

interface BaselineScenarioV2 {
  scenarioId: string
  pairId: string
  replicate: number
  rawRunRoot: string
  runManifest: BaselineFile
  report: BaselineFile
  reviews: BaselineFile
  unblinding: BaselineFile
  reviewPacket: BaselineFile
  reviewInstructions: BaselineFile
  lifecycleInstructions: BaselineFile
  assessorChecklist: BaselineFile
  examples: Array<BaselineFile & { arm: 'A' | 'B' }>
  eventLogs: Array<BaselineFile & { arm: 'A' | 'B' }>
  modelLogs: Array<BaselineFile & { arm: 'A' | 'B' }>
}

interface BaselineManifestV2 {
  schemaVersion: 2
  baselineId: string
  status: 'production' | 'protocol'
  createdAt: string
  suiteSha256: string
  harnessCommit: string
  ravenCommit: string
  rawArchiveSha256: string
  rawArchiveUrl: string
  rawArchive: BaselineFile
  promotionDecision: BaselineFile
  scenarios: BaselineScenarioV2[]
}

interface PromotionDecision {
  schemaVersion: 1
  decisionId: string
  baselineId: string
  decision: 'promote' | 'protocol'
  decidedAt: string
  approverIds: string[]
  suiteSha256: string
  rawArchiveSha256: string
  rawArchiveUrl: string
  files: BaselineFile[]
  disagreements: Array<EvaluationReviewDisagreementResolution & { scenarioId: string; pairId: string }>
  rationale: string
}

const SHA256 = /^sha256:[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const COMMIT = /^[a-f0-9]{40}$/
const EVALUATION_AGENTS = [
  '# Evaluation workspace',
  '',
  'This workspace contains synthetic controlled evidence, not real-world facts.',
  'Use SOURCE_CATALOG.json as the authority for each Source origin and URI. Local and llm-wiki fixtures are readable files; retrieve web and MCP Sources only through their catalogued tools.',
  'Do not look outside this workspace for scenario evidence. Do not infer access to assessor-only fact IDs.',
  '',
].join('\n')

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function exactRecord(value: unknown, keys: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !keys.includes(key))
    || keys.some(key => !optional.includes(key) && !(key in record))) {
    throw new Error(`${label} has missing or unknown fields`)
  }
  return record
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} is invalid`)
  return value as number
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
}

function archivePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '' || hasControlCharacters(value)
    || value.includes('\\') || value.startsWith('/')
    || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function file(value: unknown, label: string): BaselineFile {
  const item = exactRecord(value, ['path', 'sha256'], label)
  if (typeof item.path !== 'string' || item.path === '') throw new Error(`${label}.path is invalid`)
  return { path: item.path, sha256: sha256(item.sha256, `${label}.sha256`) }
}

function aliasedFiles(value: unknown, label: string): Array<BaselineFile & { arm: 'A' | 'B' }> {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label} must contain exactly A and B`)
  const result = value.map((raw, index) => {
    const item = exactRecord(raw, ['arm', 'path', 'sha256'], `${label}[${index}]`)
    if (item.arm !== 'A' && item.arm !== 'B') throw new Error(`${label}[${index}].arm is invalid`)
    return { arm: item.arm as 'A' | 'B', ...file({ path: item.path, sha256: item.sha256 }, `${label}[${index}]`) }
  })
  if (new Set(result.map(item => item.arm)).size !== 2) throw new Error(`${label} must contain exactly A and B`)
  return result
}

function commonManifest(root: Record<string, unknown>): Omit<BaselineManifestV2, 'schemaVersion' | 'rawArchive' | 'promotionDecision' | 'scenarios'> {
  const status = root.status
  if (status !== 'production' && status !== 'protocol') throw new Error('baseline status is invalid')
  const rawArchiveUrl = root.rawArchiveUrl
  if (typeof rawArchiveUrl !== 'string' || !rawArchiveUrl.startsWith('https://')) throw new Error('baseline rawArchiveUrl is invalid')
  const harnessCommit = root.harnessCommit
  const ravenCommit = root.ravenCommit
  if (typeof harnessCommit !== 'string' || !COMMIT.test(harnessCommit)) throw new Error('baseline harnessCommit is invalid')
  if (typeof ravenCommit !== 'string' || !COMMIT.test(ravenCommit)) throw new Error('baseline ravenCommit is invalid')
  return {
    baselineId: safeId(root.baselineId, 'baselineId'),
    status,
    createdAt: timestamp(root.createdAt, 'baseline createdAt'),
    suiteSha256: sha256(root.suiteSha256, 'baseline suiteSha256'),
    harnessCommit,
    ravenCommit,
    rawArchiveSha256: sha256(root.rawArchiveSha256, 'baseline rawArchiveSha256'),
    rawArchiveUrl,
  }
}

function decodeV2(value: unknown): BaselineManifestV2 {
  const root = exactRecord(value, [
    'schemaVersion', 'baselineId', 'status', 'createdAt', 'suiteSha256', 'harnessCommit', 'ravenCommit',
    'rawArchiveSha256', 'rawArchiveUrl', 'rawArchive', 'promotionDecision', 'scenarios',
  ], 'baseline')
  if (root.schemaVersion !== 2) throw new Error('baseline schemaVersion is unsupported')
  if (!Array.isArray(root.scenarios)) throw new Error('baseline scenarios must be an array')
  const scenarios = root.scenarios.map((raw, index): BaselineScenarioV2 => {
    const entry = exactRecord(raw, [
      'scenarioId', 'pairId', 'replicate', 'rawRunRoot', 'runManifest', 'report', 'reviews', 'unblinding', 'reviewPacket', 'reviewInstructions', 'lifecycleInstructions',
      'assessorChecklist', 'examples', 'eventLogs', 'modelLogs',
    ], `baseline.scenarios[${index}]`)
    return {
      scenarioId: safeId(entry.scenarioId, 'baseline scenarioId'),
      pairId: safeId(entry.pairId, 'baseline pairId'),
      replicate: positiveInteger(entry.replicate, 'baseline replicate'),
      rawRunRoot: archivePath(entry.rawRunRoot, 'baseline rawRunRoot'),
      runManifest: file(entry.runManifest, 'runManifest'),
      report: file(entry.report, 'report'),
      reviews: file(entry.reviews, 'reviews'),
      unblinding: file(entry.unblinding, 'unblinding'),
      reviewPacket: file(entry.reviewPacket, 'reviewPacket'),
      reviewInstructions: file(entry.reviewInstructions, 'reviewInstructions'),
      lifecycleInstructions: file(entry.lifecycleInstructions, 'lifecycleInstructions'),
      assessorChecklist: file(entry.assessorChecklist, 'assessorChecklist'),
      examples: aliasedFiles(entry.examples, 'baseline examples'),
      eventLogs: aliasedFiles(entry.eventLogs, 'baseline eventLogs'),
      modelLogs: aliasedFiles(entry.modelLogs, 'baseline modelLogs'),
    }
  })
  return {
    schemaVersion: 2,
    ...commonManifest(root),
    rawArchive: file(root.rawArchive, 'rawArchive'),
    promotionDecision: file(root.promotionDecision, 'promotionDecision'),
    scenarios,
  }
}

function decodeDecision(value: unknown): PromotionDecision {
  const root = exactRecord(value, [
    'schemaVersion', 'decisionId', 'baselineId', 'decision', 'decidedAt', 'approverIds', 'suiteSha256',
    'rawArchiveSha256', 'rawArchiveUrl', 'files', 'disagreements', 'rationale',
  ], 'promotion decision')
  if (root.schemaVersion !== 1) throw new Error('promotion decision schemaVersion is unsupported')
  if (root.decision !== 'promote' && root.decision !== 'protocol') throw new Error('promotion decision is invalid')
  if (!Array.isArray(root.approverIds) || root.approverIds.length < 2) throw new Error('promotion decision requires two approvers')
  const approverIds = root.approverIds.map(value => safeId(value, 'promotion approver id'))
  if (new Set(approverIds).size !== approverIds.length) throw new Error('promotion approver IDs are not unique')
  if (!Array.isArray(root.files)) throw new Error('promotion decision files must be an array')
  if (!Array.isArray(root.disagreements)) throw new Error('promotion decision disagreements must be an array')
  const disagreements = root.disagreements.map((raw, index) => {
    const item = exactRecord(raw, [
      'scenarioId', 'pairId', 'dimension', 'reviewIds', 'overallReviewIds', 'disposition', 'rationale',
    ], `promotion disagreement ${index}`, ['overallReviewIds'])
    if (!Array.isArray(item.reviewIds) || item.reviewIds.length < 2) throw new Error('promotion disagreement reviewIds are invalid')
    if (item.overallReviewIds !== undefined
      && (!Array.isArray(item.overallReviewIds) || item.overallReviewIds.length === 0)) {
      throw new Error('promotion disagreement overallReviewIds are invalid')
    }
    if (item.disposition !== 'resolved' && item.disposition !== 'retained') throw new Error('promotion disagreement disposition is invalid')
    const overallReviewIds = item.overallReviewIds === undefined
      ? undefined
      : item.overallReviewIds.map(value => safeId(value, 'promotion disagreement overall reviewId'))
    if (overallReviewIds !== undefined && new Set(overallReviewIds).size !== overallReviewIds.length) {
      throw new Error('promotion disagreement overallReviewIds are not unique')
    }
    return {
      scenarioId: safeId(item.scenarioId, 'promotion disagreement scenarioId'),
      pairId: safeId(item.pairId, 'promotion disagreement pairId'),
      dimension: item.dimension as EvaluationReviewDimension,
      reviewIds: item.reviewIds.map(value => safeId(value, 'promotion disagreement reviewId')),
      ...(overallReviewIds === undefined ? {} : { overallReviewIds }),
      disposition: item.disposition as 'resolved' | 'retained',
      rationale: typeof item.rationale === 'string' ? item.rationale : '',
    }
  })
  const rawArchiveUrl = root.rawArchiveUrl
  if (typeof rawArchiveUrl !== 'string' || !rawArchiveUrl.startsWith('https://')) throw new Error('promotion rawArchiveUrl is invalid')
  return {
    schemaVersion: 1,
    decisionId: safeId(root.decisionId, 'promotion decisionId'),
    baselineId: safeId(root.baselineId, 'promotion baselineId'),
    decision: root.decision,
    decidedAt: timestamp(root.decidedAt, 'promotion decidedAt'),
    approverIds,
    suiteSha256: sha256(root.suiteSha256, 'promotion suiteSha256'),
    rawArchiveSha256: sha256(root.rawArchiveSha256, 'promotion rawArchiveSha256'),
    rawArchiveUrl,
    files: root.files.map((value, index) => file(value, `promotion file ${index}`)),
    disagreements,
    rationale: typeof root.rationale === 'string' ? root.rationale : '',
  }
}

function confined(root: string, path: string): string {
  const full = resolve(root, path)
  const fromRoot = relative(root, full)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error(`baseline path escapes its root: ${path}`)
  return full
}

async function verifiedFile(root: string, value: BaselineFile, label: string): Promise<Buffer> {
  const full = confined(root, value.path)
  const segments = relative(root, full).split(/[\\/]/u).filter(Boolean)
  let cursor = root
  for (const [index, segment] of segments.entries()) {
    cursor = resolve(cursor, segment)
    const info = await lstat(cursor)
    if (info.isSymbolicLink()) throw new Error(`${label} path contains a symlink`)
    if (index < segments.length - 1 && !info.isDirectory()) throw new Error(`${label} path has a non-directory ancestor`)
    if (index === segments.length - 1 && !info.isFile()) throw new Error(`${label} is not a regular file`)
  }
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(full)])
  const fromRoot = relative(realRoot, realFile)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error(`${label} resolves outside its baseline root`)
  const bytes = await readFile(realFile)
  if (digest(bytes) !== value.sha256) throw new Error(`${label} digest mismatch`)
  return bytes
}

export function decodeRawEvaluationArchive(bytes: Buffer): Map<string, Buffer> {
  const root = exactRecord(JSON.parse(bytes.toString('utf8')), ['schemaVersion', 'files'], 'raw archive')
  if (root.schemaVersion !== 1 || !Array.isArray(root.files) || root.files.length === 0) {
    throw new Error('raw archive must contain canonical files')
  }
  const files = new Map<string, Buffer>()
  const suspiciousSecret = /\b(?:sk-[A-Za-z0-9_-]{12,}|rft_[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,})\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,}/u
  let previousPath = ''
  for (const [index, raw] of root.files.entries()) {
    const entry = exactRecord(raw, ['path', 'sha256', 'base64'], `raw archive file ${index}`)
    const path = archivePath(entry.path, `raw archive file ${index}.path`)
    if (files.has(path) || (previousPath !== '' && path.localeCompare(previousPath) <= 0)) {
      throw new Error(`raw archive paths are duplicate or not canonically sorted: ${path}`)
    }
    previousPath = path
    if (typeof entry.base64 !== 'string') throw new Error(`raw archive file ${path} has invalid base64`)
    const content = Buffer.from(entry.base64, 'base64')
    if (content.toString('base64') !== entry.base64 || digest(content) !== sha256(entry.sha256, `raw archive file ${path}.sha256`)) {
      throw new Error(`raw archive file ${path} digest or base64 mismatch`)
    }
    const text = content.toString('utf8')
    if (content.includes(0) || text.includes('\uFFFD') || suspiciousSecret.test(text)) {
      throw new Error(`raw archive file ${path} is binary or contains a credential-shaped secret`)
    }
    files.set(path, content)
  }
  return files
}

export async function writeRawEvaluationArchive(runRoots: readonly string[], outputPath: string): Promise<string> {
  if (runRoots.length === 0) throw new Error('raw archive requires at least one run root')
  const roots = runRoots.map(value => resolve(value))
  const rootNames = roots.map(value => basename(value))
  if (new Set(rootNames).size !== rootNames.length) throw new Error('raw archive run root names must be unique')
  for (const root of roots) {
    const info = await lstat(root)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`raw archive rejects non-directory or symlink run root: ${root}`)
  }
  const files: Array<{ path: string; sha256: string; base64: string }> = []
  const visit = async (root: string, directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = resolve(directory, name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`raw archive rejects symlink: ${path}`)
      if (info.isDirectory()) await visit(root, path)
      else if (info.isFile()) {
        const bytes = await readFile(path)
        const archiveName = `${basename(root)}/${relative(root, path).replaceAll('\\', '/')}`
        files.push({ path: archivePath(archiveName, 'raw archive path'), sha256: digest(bytes), base64: bytes.toString('base64') })
      } else throw new Error(`raw archive rejects special file: ${path}`)
    }
  }
  for (const root of roots) await visit(root, root)
  files.sort((left, right) => left.path.localeCompare(right.path))
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files }) + '\n')
  decodeRawEvaluationArchive(bytes)
  await writeFile(resolve(outputPath), bytes)
  return digest(bytes)
}

function rawFile(files: Map<string, Buffer>, path: string): Buffer {
  const value = files.get(path)
  if (value === undefined) throw new Error(`raw archive is missing ${path}`)
  return value
}

export function compareArchiveTreeTraversalOrder(left: string, right: string): number {
  const leftSegments = left.split('/')
  const rightSegments = right.split('/')
  for (let index = 0; index < Math.min(leftSegments.length, rightSegments.length); index += 1) {
    const leftSegment = leftSegments[index]!
    const rightSegment = rightSegments[index]!
    if (leftSegment < rightSegment) return -1
    if (leftSegment > rightSegment) return 1
  }
  return leftSegments.length - rightSegments.length
}

function archiveTreeEntries(files: Map<string, Buffer>, prefix: string): Array<{ path: string; bytes: Buffer }> {
  const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`
  return [...files.entries()].flatMap(([path, bytes]) => path.startsWith(normalized)
    ? [{ path: path.slice(normalized.length), bytes }]
    : []).sort((left, right) => compareArchiveTreeTraversalOrder(left.path, right.path))
}

function archiveTreeDigest(files: Map<string, Buffer>, prefix: string): string {
  const entries = archiveTreeEntries(files, prefix)
  if (entries.length === 0) throw new Error(`raw archive tree is empty: ${prefix}`)
  return digest(entries.map(entry => `${entry.path}\0${digest(entry.bytes)}`).join('\n'))
}

function expectedModelPath(source: EvaluationScenario['sources'][number]): string {
  if (source.origin !== 'local' && source.origin !== 'llm-wiki') return source.path
  try {
    const pathname = decodeURIComponent(new URL(source.uri).pathname).replaceAll('\\', '/')
    if (pathname.startsWith('/workspace/')) return pathname.slice('/workspace/'.length)
  } catch {}
  return source.path
}

function parseReviews(bytes: Buffer, scenarioId: string): EvaluationReview[] {
  return bytes.toString('utf8').split('\n').filter(Boolean).map((line) => {
    const review = decodeEvaluationReview(JSON.parse(line))
    if (review === undefined) throw new Error(`${scenarioId} has an invalid or unbound review record`)
    return review
  })
}

function expectedConditions(scenario: EvaluationScenario): string[] {
  return scenario.kind === 'ablation' ? ['raven-single', 'raven-multi'] : ['vanilla', 'raven']
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return new Set(left).size === left.length && new Set(right).size === right.length
    && left.length === right.length && left.every(value => right.includes(value))
}

function recomputeRunEligibility(
  run: Record<string, unknown>,
  scenario: EvaluationScenario,
  scenarioSha256: string,
  rubricSha256: string,
  sourceSnapshotSha256: string,
  manifest: BaselineManifestV2,
  pairId: string,
  artifacts: Record<'A' | 'B', string>,
  mapping: Record<'A' | 'B', string>,
): void {
  if (run.schemaVersion !== 1 || run.runId !== pairId || typeof run.executionStartedAt !== 'string'
    || !Number.isFinite(Date.parse(run.executionStartedAt))
    || run.scenarioId !== scenario.id || run.scenarioKind !== scenario.kind) {
    throw new Error(`${scenario.id} run manifest identity mismatch`)
  }
  if (run.scenarioSha256 !== scenarioSha256 || run.rubricSha256 !== rubricSha256
    || run.inputsSha256 !== digest(JSON.stringify(scenario.turns)) || run.sourceSnapshotSha256 !== sourceSnapshotSha256) {
    throw new Error(`${scenario.id} run input digests do not match the frozen suite`)
  }
  if (run.harnessCommit !== manifest.harnessCommit || run.ravenCommit !== manifest.ravenCommit) {
    throw new Error(`${scenario.id} run commit identity mismatch`)
  }
  const parity = record(run.parity, `${scenario.id} run parity`)
  const promptHashes = record(parity.commonPromptSha256, `${scenario.id} run prompt parity hashes`)
  const toolHashes = record(parity.topLevelToolSha256, `${scenario.id} run tool parity hashes`)
  if (parity.pass !== true || promptHashes.left !== promptHashes.right || toolHashes.left !== toolHashes.right) {
    throw new Error(`${scenario.id} run did not establish paired prompt/tool parity`)
  }
  const floor = record(run.automatedFloor, `${scenario.id} automated floor`)
  for (const field of ['frozenInputParity', 'toolAccessFloor', 'canaryPass', 'mechanismFloor', 'armsComplete', 'ablationComplete']) {
    if (floor[field] !== true) throw new Error(`${scenario.id} automated floor ${field} did not pass`)
  }
  const order = run.order
  const conditions = expectedConditions(scenario)
  if (!Array.isArray(order) || !order.every(value => typeof value === 'string') || !sameSet(order, conditions)) {
    throw new Error(`${scenario.id} run order does not contain the expected arms`)
  }
  const arms = record(run.arms, `${scenario.id} run arms`)
  const initialWorkspaces = new Set<string>()
  for (const condition of conditions) {
    const arm = record(arms[condition], `${scenario.id} ${condition} arm`)
    if (arm.ledgersComplete !== true || arm.modelRoutesValid !== true || arm.terminalStatus !== 'completed') {
      throw new Error(`${scenario.id} ${condition} arm did not complete with valid ledgers and model routes`)
    }
    if (typeof arm.initialWorkspaceSha256 !== 'string') throw new Error(`${scenario.id} ${condition} arm lacks its initial workspace digest`)
    initialWorkspaces.add(arm.initialWorkspaceSha256)
    const aliases = (['A', 'B'] as const).filter(alias => mapping[alias] === condition)
    if (aliases.length !== 1 || arm.artifactSha256 !== artifacts[aliases[0] as 'A' | 'B']) {
      throw new Error(`${scenario.id} example does not match the mapped run Artifact`)
    }
    const artifact = artifacts[aliases[0] as 'A' | 'B']
    if (!SHA256.test(artifact)) throw new Error(`${scenario.id} mapped Artifact digest is invalid`)
    if (condition !== 'vanilla') {
      const task = record(arm.ravenTask, `${scenario.id} ${condition} Raven Task`)
      if (!scenario.expectations.allowedTerminalStatuses.includes(task.phase as never)) {
        throw new Error(`${scenario.id} ${condition} Raven Task phase did not meet the scenario floor`)
      }
      if (typeof task.checkpoints !== 'number' || task.checkpoints < scenario.expectations.minimumCheckpoints) {
        throw new Error(`${scenario.id} ${condition} Raven Task lacks required checkpoints`)
      }
      if (scenario.expectations.requireStopResume
        && (!Array.isArray(arm.processGenerationIds) || new Set(arm.processGenerationIds).size < 2)) {
        throw new Error(`${scenario.id} ${condition} did not cross a process restart`)
      }
      if (scenario.expectations.requireKnowledgeReuse
        && (!Array.isArray(arm.sessionIds) || arm.sessionIds.length < 2
          || typeof task.taskCount !== 'number' || task.taskCount < 2
          || !Array.isArray(task.sourceOrigins) || !task.sourceOrigins.includes('llm-wiki'))) {
        throw new Error(`${scenario.id} ${condition} did not prove knowledge reuse`)
      }
      if (scenario.expectations.requireStructureChoice && task.selectedStructure !== true) {
        throw new Error(`${scenario.id} ${condition} did not prove structure selection`)
      }
    }
  }
  if (initialWorkspaces.size !== 1) throw new Error(`${scenario.id} arm initial workspaces differ`)
  if (scenario.kind === 'ablation') {
    const single = record(record(arms['raven-single'], 'raven-single arm').ravenTask, 'raven-single task')
    const multi = record(record(arms['raven-multi'], 'raven-multi arm').ravenTask, 'raven-multi task')
    if (typeof single.distinctDraftRoutes !== 'number' || single.distinctDraftRoutes > 1
      || typeof multi.distinctDraftRoutes !== 'number' || multi.distinctDraftRoutes < 2) {
      throw new Error(`${scenario.id} did not prove the declared drafting ablation`)
    }
  }
  if (run.fixtureModel !== false || run.harnessDirty !== false || run.ravenDirty !== false || run.outcomeComplete !== true) {
    throw new Error(`${scenario.id} run is not independently production-eligible`)
  }
  if (run.promotable !== true) throw new Error(`${scenario.id} run promotable flag is stale or false`)
}

function verifyReport(
  report: Record<string, unknown>,
  run: Record<string, unknown>,
  scenario: EvaluationScenario,
  reviews: readonly EvaluationReview[],
  strictProduction: boolean,
): void {
  if (report.schemaVersion !== 1 || report.scenarioId !== scenario.id) throw new Error(`${scenario.id} report identity mismatch`)
  const validity = record(report.validity, `${scenario.id} report validity`)
  for (const field of ['methodologyValid', 'parity', 'frozenInputParity', 'toolAccessFloor', 'modelRoutesValid', 'workspaceEqual', 'artifactIntegrity', 'hashesPresent', 'promotable']) {
    if (validity[field] !== true) throw new Error(`${scenario.id} report validity ${field} did not pass`)
  }
  if (validity.fixtureModel !== false || validity.harnessDirty !== false || validity.ravenDirty !== false) {
    throw new Error(`${scenario.id} report describes non-production evidence`)
  }
  const environment = record(report.environment, `${scenario.id} report environment`)
  for (const field of ['provider', 'model', 'reasoningEffort', 'maxTokens', 'harnessCommit', 'ravenCommit', 'baseCompositionSha256', 'sourceSnapshotSha256', 'inputsSha256', 'order']) {
    if (JSON.stringify(environment[field]) !== JSON.stringify(run[field])) {
      throw new Error(`${scenario.id} report environment ${field} does not match the run`)
    }
  }
  const outcomes = record(report.outcomes, `${scenario.id} report outcomes`)
  if (outcomes.scenarioFloorPassed !== true) throw new Error(`${scenario.id} report scenario floor did not pass`)
  const order = run.order as string[]
  const arms = run.arms as Record<string, Record<string, unknown>>
  for (const [side, condition] of [['left', order[0]], ['right', order[1]]] as const) {
    const outcome = record(outcomes[side], `${scenario.id} report ${side} outcome`)
    const arm = record(arms[condition as string], `${scenario.id} ${String(condition)} arm`)
    if (outcome.condition !== condition || outcome.artifact !== `${String(arm.path)}/${String(arm.artifactPath)}`
      || outcome.artifactSha256 !== arm.artifactSha256 || outcome.terminalStatus !== arm.terminalStatus) {
      throw new Error(`${scenario.id} report ${side} outcome does not match the run`)
    }
    if (strictProduction && (JSON.stringify(outcome.ravenTask) !== JSON.stringify(arm.ravenTask)
      || JSON.stringify(outcome.protocolFailures) !== JSON.stringify(arm.protocolFailures)
      || JSON.stringify(outcome.modelRoutes) !== JSON.stringify(arm.modelRoutes)
      || outcome.modelRoutesValid !== arm.modelRoutesValid)) {
      throw new Error(`${scenario.id} report ${side} operational evidence does not match the run`)
    }
  }
  if (strictProduction) {
    const usage = record(report.usage, `${scenario.id} report usage`)
    const leftUsage = record(record(arms[order[0] as string], 'left arm').usage, 'left usage')
    const rightUsage = record(record(arms[order[1] as string], 'right arm').usage, 'right usage')
    if (JSON.stringify(usage.left) !== JSON.stringify(leftUsage) || JSON.stringify(usage.right) !== JSON.stringify(rightUsage)) {
      throw new Error(`${scenario.id} report usage does not match the run`)
    }
    if (!Array.isArray(report.limitations) || report.limitations.length !== 0) {
      throw new Error(`${scenario.id} production report contains unresolved validity limitations`)
    }
  }
  const review = record(report.review, `${scenario.id} report review`)
  if (review.pass !== true || review.status !== 'structurally-complete-unverified'
    || review.evidenceBindingVerified !== false || JSON.stringify(review.records) !== JSON.stringify(reviews)) {
    throw new Error(`${scenario.id} report reviews do not match the immutable review records`)
  }
}

function decodeUnblinding(value: unknown, scenarioId: string, pairId: string): {
  binding: EvaluationReviewBinding
  mapping: Record<'A' | 'B', string>
  seedSha256: string
} {
  const root = exactRecord(value, ['schemaVersion', 'seedSha256', 'pairId', 'scenarioId', 'binding', 'mapping'], 'unblinding')
  if (root.schemaVersion !== 1 || root.scenarioId !== scenarioId || root.pairId !== pairId) {
    throw new Error(`${scenarioId} unblinding identity mismatch`)
  }
  const binding = decodeEvaluationReviewBinding(root.binding)
  if (binding === undefined) throw new Error(`${scenarioId} unblinding binding is invalid`)
  const mappingValue = exactRecord(root.mapping, ['A', 'B'], 'unblinding mapping')
  if (typeof mappingValue.A !== 'string' || typeof mappingValue.B !== 'string' || mappingValue.A === mappingValue.B) {
    throw new Error(`${scenarioId} unblinding mapping is invalid`)
  }
  return {
    binding,
    mapping: { A: mappingValue.A, B: mappingValue.B },
    seedSha256: sha256(root.seedSha256, 'unblinding seedSha256'),
  }
}

async function verifyReviewEvidence(
  evaluationRoot: string,
  scenario: EvaluationScenario,
  reviews: readonly EvaluationReview[],
  artifactTexts: Record<'A' | 'B', string>,
  eventTexts: Record<'A' | 'B', string>,
): Promise<void> {
  const sources = new Map(await Promise.all(scenario.sources.map(async source => [
    source.id,
    await readFile(resolve(evaluationRoot, source.path), 'utf8'),
  ] as const)))
  const events = Object.fromEntries((['A', 'B'] as const).map(alias => [
    alias,
    eventTexts[alias].split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>),
  ])) as Record<'A' | 'B', Array<Record<string, unknown>>>
  for (const review of reviews) {
    for (const dimension of review.dimensions) {
      for (const evidence of dimension.evidence) {
        let present = false
        if (evidence.eventSeq !== null) {
          present = events[evidence.arm].filter((entry) => {
            const event = typeof entry.event === 'object' && entry.event !== null
              ? entry.event as Record<string, unknown>
              : undefined
            return event?.seq === evidence.eventSeq && JSON.stringify(entry).includes(evidence.exactQuote)
          }).length === 1
        } else if (evidence.sourceId !== null) {
          const source = sources.get(evidence.sourceId)
          if (source === undefined) throw new Error(`review ${review.reviewId} cites unknown source ${evidence.sourceId}`)
          present = source.includes(evidence.exactQuote)
        } else {
          present = artifactTexts[evidence.arm].includes(evidence.exactQuote)
        }
        if (!present) {
          throw new Error(`review ${review.reviewId} dimension ${dimension.dimension} evidence is absent from preserved bytes`)
        }
      }
    }
  }
}

function referencedFiles(manifest: BaselineManifestV2): BaselineFile[] {
  return [
    manifest.rawArchive,
    ...manifest.scenarios.flatMap(entry => [
      entry.runManifest,
      entry.report,
      entry.reviews,
      entry.unblinding,
      entry.reviewPacket,
      entry.reviewInstructions,
      entry.lifecycleInstructions,
      entry.assessorChecklist,
      ...entry.examples,
      ...entry.eventLogs,
      ...entry.modelLogs,
    ]),
  ]
}

function verifyDecisionFiles(decision: PromotionDecision, manifest: BaselineManifestV2): void {
  const expected = referencedFiles(manifest).map(value => `${value.path}\0${value.sha256}`).sort()
  const declared = decision.files.map(value => `${value.path}\0${value.sha256}`).sort()
  if (!sameSet(expected, declared)) throw new Error('promotion decision does not bind the complete baseline evidence set')
}

function jsonLines(bytes: Buffer, label: string): Array<Record<string, unknown>> {
  return bytes.toString('utf8').split('\n').filter(Boolean).map((line) => {
    const value = JSON.parse(line)
    return record(value, label)
  })
}

function recordedRelativePath(workspaceRoot: string, input: string): string | undefined {
  const pathApi = win32.isAbsolute(workspaceRoot) ? win32 : posix
  let recordedPath = input
  if (recordedPath.startsWith('file:')) {
    try {
      recordedPath = decodeURIComponent(new URL(recordedPath).pathname)
      if (pathApi === win32 && /^\/[A-Za-z]:\//u.test(recordedPath)) recordedPath = recordedPath.slice(1)
    } catch {
      return undefined
    }
  }
  const path = pathApi.isAbsolute(recordedPath) ? recordedPath : pathApi.resolve(workspaceRoot, recordedPath)
  const fromRoot = pathApi.relative(workspaceRoot, path)
  return fromRoot === '..' || fromRoot.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(fromRoot)
    ? undefined
    : fromRoot.replaceAll('\\', '/')
}

function verifyToolIsolation(bytes: Buffer, workspaceRoot: string, label: string): {
  toolCalls: number
  nestedCalls: number
  toolFailures: number
  nestedFailures: number
} {
  const allowed = new Set<string>(EVALUATION_EXECUTION_TOOL_ALLOWLIST.filter(name => name !== 'run_code'))
  let toolCalls = 0
  let nestedCalls = 0
  let toolFailures = 0
  let nestedFailures = 0
  for (const row of jsonLines(bytes, label)) {
    const event = record(row.event, `${label} event`)
    const data = record(event.data, `${label} event data`)
    if (event.type === 'tool/call') toolCalls += 1
    if (event.type === 'tool/code-dispatch-start') nestedCalls += 1
    if (event.type === 'tool/code-dispatch' && data.isError === true) nestedFailures += 1
    if (event.type === 'tool/result') {
      const message = typeof data.message === 'object' && data.message !== null ? data.message as Record<string, unknown> : undefined
      const content = Array.isArray(message?.content) ? message.content : []
      if (content.some(item => typeof item === 'object' && item !== null
        && (item as Record<string, unknown>).type === 'tool-result'
        && (item as Record<string, unknown>).isError === true)) toolFailures += 1
    }
    if (event.type === 'tool/call' && data.name !== 'run_code') throw new Error(`${label} used a direct tool outside run_code`)
    if (event.type !== 'tool/code-dispatch-start') continue
    if (typeof data.name !== 'string' || !allowed.has(data.name)) throw new Error(`${label} used a forbidden nested tool`)
    if (!['read', 'write', 'edit', 'glob', 'grep'].includes(data.name)) continue
    const args = record(data.arguments, `${label} file-tool arguments`)
    if (data.name === 'glob' && (typeof args.pattern !== 'string' || posix.isAbsolute(args.pattern)
      || win32.isAbsolute(args.pattern) || args.pattern.replaceAll('\\', '/').split('/').includes('..'))) {
      throw new Error(`${label} glob pattern escapes the archived model-visible workspace`)
    }
    const pathValue = data.name === 'read' || data.name === 'write' || data.name === 'edit'
      ? args.file_path
      : args.path
    if (pathValue === undefined && (data.name === 'glob' || data.name === 'grep')) continue
    if (typeof pathValue !== 'string') throw new Error(`${label} file tool has no file path`)
    const fromRoot = recordedRelativePath(workspaceRoot, pathValue)
    if (fromRoot === undefined) throw new Error(`${label} file tool escaped the archived model-visible workspace`)
  }
  return { toolCalls, nestedCalls, toolFailures, nestedFailures }
}

function verifyUserTurns(bytes: Buffer, scenario: EvaluationScenario, label: string): void {
  const messages = jsonLines(bytes, label).flatMap((row) => {
    const event = typeof row.event === 'object' && row.event !== null ? row.event as Record<string, unknown> : undefined
    const data = typeof event?.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : undefined
    const source = typeof data?.source === 'object' && data.source !== null ? data.source as Record<string, unknown> : undefined
    if (event?.type !== 'user/message' || source?.kind !== 'user' || !Array.isArray(data?.content)) return []
    const text = data.content.flatMap((part) => typeof part === 'object' && part !== null
      && (part as Record<string, unknown>).type === 'text' && typeof (part as Record<string, unknown>).text === 'string'
      ? [(part as Record<string, unknown>).text as string]
      : []).join('')
    return [text]
  })
  if (JSON.stringify(messages) !== JSON.stringify(scenario.turns.map(turn => turn.content))) {
    throw new Error(`${label} model-visible user turns differ from the frozen scenario`)
  }
}

function verifyTaskLifecycle(bytes: Buffer, taskId: string, scenario: EvaluationScenario, label: string): void {
  const actions = jsonLines(bytes, label).flatMap((row) => {
    const event = typeof row.event === 'object' && row.event !== null ? row.event as Record<string, unknown> : undefined
    const data = typeof event?.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : undefined
    const args = typeof data?.arguments === 'object' && data.arguments !== null
      ? data.arguments as Record<string, unknown>
      : undefined
    return event?.type === 'tool/code-dispatch' && data?.name === 'raven_task' && data.isError === false
      && args?.taskId === taskId && typeof args.action === 'string' && typeof event.seq === 'number'
      ? [{
          action: args.action,
          seq: event.seq,
          generation: typeof row.generation === 'string' ? row.generation : null,
          sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
        }]
      : []
  })
  const last = (action: string) => actions.filter(item => item.action === action)
    .reduce((value, item) => Math.max(value, item.seq), -1)
  if (last('complete') < 0) throw new Error(`${label} final Task has no successful Completion event`)
  if (scenario.expectations.requireStopResume) {
    const stopped = actions.findLast(item => item.action === 'stop')
    const resumed = actions.findLast(item => item.action === 'resume')
    const completed = actions.findLast(item => item.action === 'complete')
    if (stopped === undefined || resumed === undefined || completed === undefined
      || stopped.generation === null || resumed.generation === null || completed.generation === null
      || stopped.sessionId === null || stopped.sessionId !== resumed.sessionId || resumed.sessionId !== completed.sessionId
      || stopped.generation === resumed.generation || resumed.generation !== completed.generation
      || !(stopped.seq < resumed.seq && resumed.seq < completed.seq)) {
      throw new Error(`${label} stop, resume, and Completion do not prove one Task across a process generation`)
    }
  }
}

function verifyModelRoutes(
  bytes: Buffer,
  run: Record<string, unknown>,
  condition: string,
  arm: Record<string, unknown>,
  label: string,
): void {
  if (typeof run.provider !== 'string' || typeof run.model !== 'string') throw new Error(`${label} run route is invalid`)
  const main = { provider: run.provider, model: run.model }
  const draftRoutes = Array.isArray(run.draftRoutes) ? run.draftRoutes.flatMap((raw) => {
    const route = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : undefined
    return typeof route?.provider === 'string' && typeof route.model === 'string'
      ? [{ provider: route.provider, model: route.model }]
      : []
  }) : []
  const allowed = [main, ...(condition === 'raven-single' ? draftRoutes.slice(0, 1) : condition === 'raven-multi' ? draftRoutes : [])]
  const calls = jsonLines(bytes, label)
  const observed = [...new Set(calls.map((call) => {
    if (typeof call.provider !== 'string' || typeof call.model !== 'string') throw new Error(`${label} model call route is invalid`)
    if (!allowed.some(route => route.provider === call.provider && route.model === call.model)) {
      throw new Error(`${label} used undeclared model route ${JSON.stringify([call.provider, call.model])}`)
    }
    return JSON.stringify([call.provider, call.model])
  }))].sort()
  const generations = Array.isArray(arm.processGenerationIds)
    && arm.processGenerationIds.every(value => typeof value === 'string')
    ? arm.processGenerationIds as string[]
    : []
  const usage = record(arm.usage, `${label} usage`)
  const tokenTotal = (field: string): number | null => {
    let total = 0
    for (const call of calls) {
      const callUsage = typeof call.usage === 'object' && call.usage !== null ? call.usage as Record<string, unknown> : undefined
      const value = callUsage?.[field]
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null
      total += value
    }
    return Number.isSafeInteger(total) ? total : null
  }
  for (const [manifestField, ledgerField] of [
    ['uncachedInputTokens', 'inputTokens'], ['cacheReadTokens', 'cacheReadTokens'],
    ['cacheWriteTokens', 'cacheWriteTokens'], ['outputTokens', 'outputTokens'], ['totalTokens', 'totalTokens'],
    ['reasoningTokens', 'reasoningTokens'],
  ] as const) {
    if (usage[manifestField] !== tokenTotal(ledgerField)) throw new Error(`${label} usage ${manifestField} does not match model calls`)
  }
  if (usage.modelCalls !== calls.length
    || generations.length === 0 || calls.some(call => typeof call.generation !== 'string' || !generations.includes(call.generation))
    || generations.some(generation => !calls.some(call => call.generation === generation
    && call.provider === main.provider && call.model === main.model))
    || arm.modelRoutesValid !== true
    || JSON.stringify(observed) !== JSON.stringify(Array.isArray(arm.modelRoutes) ? [...arm.modelRoutes].sort() : [])) {
    throw new Error(`${label} model route attestation does not match preserved calls and generations`)
  }
}

function verifyRawPromptParity(files: Map<string, Buffer>, rawRunRoot: string, run: Record<string, unknown>, scenario: EvaluationScenario): void {
  const conditions = expectedConditions(scenario)
  const arms = record(run.arms, `${scenario.id} run arms`)
  const snapshots = conditions.map((condition) => {
    const arm = record(arms[condition], `${scenario.id} ${condition} arm`)
    if (typeof arm.path !== 'string' || !Array.isArray(arm.processGenerationIds)) {
      throw new Error(`${scenario.id} ${condition} prompt evidence is incomplete`)
    }
    const root = `${rawRunRoot}/${archivePath(arm.path, 'raw arm path')}`
    return {
      condition,
      values: arm.processGenerationIds.map((generation) => {
        if (typeof generation !== 'string') throw new Error(`${scenario.id} process generation is invalid`)
        const prompt = record(JSON.parse(rawFile(files, `${root}/prompt-${generation}.json`).toString('utf8')), 'raw prompt')
        const schemas = JSON.parse(rawFile(files, `${root}/tool-schemas-${generation}.json`).toString('utf8')) as unknown
        if (!Array.isArray(schemas)) throw new Error(`${scenario.id} raw tool schemas are invalid`)
        const sections = Array.isArray(prompt.sections) ? prompt.sections as Array<Record<string, unknown>> : []
        const common = {
          sections: sections
            .filter(section => section.name !== 'tool:raven-task')
            .map(section => section.name === 'tools:sdk' && typeof section.text === 'string'
              ? { ...section, text: normalizeEvaluationToolsSdk(section.text) }
              : section),
          contexts: prompt.contexts,
          tools: prompt.tools,
          variables: prompt.variables,
        }
        const commonSchemas = schemas.filter((tool) => {
          const value = typeof tool === 'object' && tool !== null ? tool as Record<string, unknown> : undefined
          return value?.name !== 'raven_task' && value?.name !== 'raven_workspace'
        })
        const treatment = {
          sections: sections.filter(section => section.name === 'tool:raven-task'),
          schemas: schemas.filter((tool) => {
            const value = typeof tool === 'object' && tool !== null ? tool as Record<string, unknown> : undefined
            return value?.name === 'raven_task' || value?.name === 'raven_workspace'
          }),
        }
        return { common, commonSchemas, treatment }
      }),
    }
  })
  if (snapshots.some(snapshot => snapshot.values.length === 0)
    || JSON.stringify(snapshots[0]?.values.map(value => value.common)) !== JSON.stringify(snapshots[1]?.values.map(value => value.common))
    || JSON.stringify(snapshots[0]?.values.map(value => value.commonSchemas)) !== JSON.stringify(snapshots[1]?.values.map(value => value.commonSchemas))) {
    throw new Error(`${scenario.id} raw prompt or tool parity failed`)
  }
  if (snapshots.every(snapshot => snapshot.condition !== 'vanilla')
    && JSON.stringify(snapshots[0]?.values.map(value => value.treatment))
      !== JSON.stringify(snapshots[1]?.values.map(value => value.treatment))) {
    throw new Error(`${scenario.id} Raven treatment differs between ablation arms`)
  }
  for (const snapshot of snapshots) {
    const expectedTreatment = snapshot.condition === 'vanilla' ? { sections: 0, schemas: 0 } : { sections: 1, schemas: 2 }
    const first = snapshot.values[0]?.treatment
    if (first === undefined || snapshot.values.some(value => value.treatment.sections.length !== expectedTreatment.sections
      || value.treatment.schemas.length !== expectedTreatment.schemas
      || JSON.stringify(value.treatment) !== JSON.stringify(first))) {
      throw new Error(`${scenario.id} ${snapshot.condition} treatment drifted across process generations`)
    }
  }
}

async function verifyV2(
  root: string,
  manifest: BaselineManifestV2,
  evaluationRoot: string,
): Promise<string[]> {
  const scenarioIds = manifest.scenarios.map(item => item.scenarioId)
  const pairIds = manifest.scenarios.map(item => item.pairId)
  if (new Set(pairIds).size !== pairIds.length) throw new Error('baseline pair IDs are not unique')
  for (const scenarioId of new Set(scenarioIds)) {
    const replicates = manifest.scenarios.filter(item => item.scenarioId === scenarioId).map(item => item.replicate)
    if (new Set(replicates).size !== replicates.length) throw new Error(`${scenarioId} baseline replicate ordinals are not unique`)
  }
  if (manifest.status === 'production') {
    for (const id of CORE_EVALUATION_SCENARIO_IDS) {
      const replicates = manifest.scenarios.filter(item => item.scenarioId === id)
      if (replicates.length < 2) throw new Error(`production baseline requires two counterbalanced replicates for ${id}`)
    }
    const repositoryRoot = resolve(evaluationRoot, '..')
    const packageManifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
      dshRaven?: { harnessCommit?: unknown }
    }
    if (packageManifest.dshRaven?.harnessCommit !== manifest.harnessCommit) {
      throw new Error('production baseline Harness commit does not match the package pin')
    }
    const head = (await runProcess('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot, capture: true, timeoutMs: 20_000,
    })).stdout.trim()
    await runProcess('git', ['merge-base', '--is-ancestor', manifest.ravenCommit, head], {
      cwd: repositoryRoot, capture: true, timeoutMs: 20_000,
    }).catch(() => { throw new Error('production baseline Raven commit is not an ancestor of release HEAD') })
    const changed = (await runProcess('git', ['diff', '--name-only', '-z', manifest.ravenCommit, head], {
      cwd: repositoryRoot, capture: true, timeoutMs: 20_000,
    })).stdout.split('\0').filter(Boolean)
    if (changed.some(path => !path.startsWith('evaluation/baselines/'))) {
      throw new Error('release HEAD changed product or evaluation code after the evaluated Raven commit')
    }
  }
  const rawArchiveBytes = await verifiedFile(root, manifest.rawArchive, 'raw archive')
  if (digest(rawArchiveBytes) !== manifest.rawArchiveSha256) throw new Error('raw archive digest does not match the baseline declaration')
  const rawArchiveFiles = manifest.status === 'production' ? decodeRawEvaluationArchive(rawArchiveBytes) : undefined
  const decision = decodeDecision(JSON.parse((await verifiedFile(root, manifest.promotionDecision, 'promotion decision')).toString('utf8')))
  if (decision.baselineId !== manifest.baselineId || decision.suiteSha256 !== manifest.suiteSha256
    || decision.rawArchiveSha256 !== manifest.rawArchiveSha256 || decision.rawArchiveUrl !== manifest.rawArchiveUrl) {
    throw new Error('promotion decision identity or archive binding mismatch')
  }
  if ((manifest.status === 'production' && decision.decision !== 'promote')
    || (manifest.status === 'protocol' && decision.decision !== 'protocol')) {
    throw new Error('promotion decision does not authorize this baseline status')
  }
  if (Date.parse(decision.decidedAt) > Date.parse(manifest.createdAt)) throw new Error('promotion decision is newer than the baseline')
  if (decision.rationale.trim() === '') throw new Error('promotion decision requires a rationale')
  verifyDecisionFiles(decision, manifest)
  if (decision.disagreements.some(resolution => !manifest.scenarios.some(entry =>
    entry.scenarioId === resolution.scenarioId && entry.pairId === resolution.pairId))) {
    throw new Error('promotion decision contains a resolution for an unknown scenario pair')
  }

  const allReviews: EvaluationReview[] = []
  const firstArms = new Map<string, string[]>()
  const environments = new Map<string, string>()
  const evidenceIdentities = new Map<string, Set<string>>()
  for (const entry of manifest.scenarios) {
    const scenarioBytes = await readFile(resolve(evaluationRoot, 'scenarios', `${entry.scenarioId}.json`))
    const scenario = decodeEvaluationScenario(JSON.parse(scenarioBytes.toString('utf8')))
    if (scenario === undefined) throw new Error(`${entry.scenarioId} current scenario is invalid`)
    const rubricBytes = await readFile(resolve(evaluationRoot, 'rubric.md'))
    const sourceSnapshotSha256 = await evaluationSourceSnapshotSha256(evaluationRoot, scenario)
    const runBytes = await verifiedFile(root, entry.runManifest, `${entry.scenarioId} run manifest`)
    if (rawArchiveFiles !== undefined
      && !runBytes.equals(rawFile(rawArchiveFiles, `${entry.rawRunRoot}/manifest.json`))) {
      throw new Error(`${entry.scenarioId} baseline run manifest differs from the raw archive`)
    }
    const run = JSON.parse(runBytes.toString('utf8')) as Record<string, unknown>
    if (rawArchiveFiles !== undefined) {
      if (rawFile(rawArchiveFiles, `${entry.rawRunRoot}/SAFE_TO_UPLOAD`).toString('utf8')
        !== 'Secret scan passed; raw evidence still requires access control.\n') {
        throw new Error(`${entry.scenarioId} raw run has no canonical upload admission receipt`)
      }
      if (archiveTreeDigest(rawArchiveFiles, `${entry.rawRunRoot}/source-snapshot`) !== run.sourceSnapshotSha256) {
        throw new Error(`${entry.scenarioId} raw Source snapshot digest does not match the run manifest`)
      }
    }
    if (!Array.isArray(run.order) || typeof run.order[0] !== 'string') throw new Error(`${entry.scenarioId} run order is invalid`)
    firstArms.set(entry.scenarioId, [...(firstArms.get(entry.scenarioId) ?? []), run.order[0]])
    const environment = JSON.stringify([
      run.provider, run.model, run.reasoningEffort, run.maxTokens, run.settingsSha256,
      run.baseCompositionSha256, run.draftRoutes, run.nodeVersion, run.platform, run.arch,
    ])
    const priorEnvironment = environments.get(entry.scenarioId)
    if (priorEnvironment !== undefined && priorEnvironment !== environment) {
      throw new Error(`${entry.scenarioId} replicates do not share one environment tuple`)
    }
    environments.set(entry.scenarioId, environment)
    if (rawArchiveFiles !== undefined) verifyRawPromptParity(rawArchiveFiles, entry.rawRunRoot, run, scenario)
    const report = JSON.parse((await verifiedFile(root, entry.report, `${entry.scenarioId} report`)).toString('utf8')) as Record<string, unknown>
    const reviewBytes = await verifiedFile(root, entry.reviews, `${entry.scenarioId} reviews`)
    const reviews = parseReviews(reviewBytes, entry.scenarioId)
    const packetBytes = await verifiedFile(root, entry.reviewPacket, `${entry.scenarioId} review packet`)
    const instructionsBytes = await verifiedFile(root, entry.reviewInstructions, `${entry.scenarioId} review instructions`)
    const lifecycleInstructionsBytes = await verifiedFile(
      root, entry.lifecycleInstructions, `${entry.scenarioId} lifecycle review instructions`,
    )
    const canonicalInstructions = evaluationReviewInstructions(scenario)
    if (instructionsBytes.toString('utf8') !== canonicalInstructions.content
      || lifecycleInstructionsBytes.toString('utf8') !== canonicalInstructions.lifecycle) {
      throw new Error(`${entry.scenarioId} review instructions are not canonical`)
    }
    const checklistBytes = await verifiedFile(root, entry.assessorChecklist, `${entry.scenarioId} assessor checklist`)
    const assessorCatalog = decodeEvaluationAssessorCatalog(JSON.parse(
      await readFile(resolve(evaluationRoot, 'assessor-facts.json'), 'utf8'),
    ))
    if (assessorCatalog === undefined) throw new Error('current assessor catalog is invalid')
    if (checklistBytes.toString('utf8') !== evaluationAssessorChecklist(scenario, assessorCatalog)) {
      throw new Error(`${entry.scenarioId} assessor checklist does not match the current scenario and catalog`)
    }
    const unblinding = decodeUnblinding(
      JSON.parse((await verifiedFile(root, entry.unblinding, `${entry.scenarioId} unblinding`)).toString('utf8')),
      entry.scenarioId,
      entry.pairId,
    )
    const exampleBytes = Object.fromEntries(await Promise.all(entry.examples.map(async example => [
      example.arm,
      await verifiedFile(root, example, `${entry.scenarioId} ${example.arm} example`),
    ]))) as Record<'A' | 'B', Buffer>
    const eventBytes = Object.fromEntries(await Promise.all(entry.eventLogs.map(async eventLog => [
      eventLog.arm,
      await verifiedFile(root, eventLog, `${entry.scenarioId} ${eventLog.arm} event log`),
    ]))) as Record<'A' | 'B', Buffer>
    const modelBytes = Object.fromEntries(await Promise.all(entry.modelLogs.map(async modelLog => [
      modelLog.arm,
      await verifiedFile(root, modelLog, `${entry.scenarioId} ${modelLog.arm} model log`),
    ]))) as Record<'A' | 'B', Buffer>
    const expectedBinding: EvaluationReviewBinding = {
      packetManifestSha256: digest(packetBytes),
      mappingCommitmentSha256: digest(`${unblinding.seedSha256}\0${JSON.stringify(unblinding.mapping)}`),
      scenarioSha256: digest(scenarioBytes),
      rubricSha256: digest(rubricBytes),
      assessorChecklistSha256: digest(checklistBytes),
      artifacts: { A: digest(exampleBytes.A), B: digest(exampleBytes.B) },
    }
    if (JSON.stringify(unblinding.binding) !== JSON.stringify(expectedBinding)) {
      throw new Error(`${entry.scenarioId} unblinding does not match the preserved review packet`)
    }
    const packet = exactRecord(JSON.parse(packetBytes.toString('utf8')), [
      'schemaVersion', 'pairId', 'scenarioId', 'scenarioSha256', 'rubricVersion', 'rubricSha256',
      'assessorChecklistSha256', 'mappingCommitmentSha256', 'artifacts', 'files', 'sources',
    ], `${entry.scenarioId} review packet`)
    for (const field of ['scenarioSha256', 'rubricSha256', 'assessorChecklistSha256', 'mappingCommitmentSha256', 'artifacts']) {
      const expected = field === 'artifacts' ? expectedBinding.artifacts : expectedBinding[field as keyof EvaluationReviewBinding]
      if (JSON.stringify(packet[field]) !== JSON.stringify(expected)) {
        throw new Error(`${entry.scenarioId} review packet ${field} binding mismatch`)
      }
    }
    if (packet.schemaVersion !== 1 || packet.rubricVersion !== 'v1'
      || packet.pairId !== entry.pairId || packet.scenarioId !== entry.scenarioId) {
      throw new Error(`${entry.scenarioId} review packet identity mismatch`)
    }
    const expectedPacketFiles: Record<string, string> = {
      'A.md': expectedBinding.artifacts.A,
      'B.md': expectedBinding.artifacts.B,
      'rubric.md': digest(rubricBytes),
      'scenario.json': digest(scenarioBytes),
      'assessor-checklist.json': digest(checklistBytes),
      'REVIEW.md': digest(instructionsBytes),
    }
    for (const source of scenario.sources) {
      expectedPacketFiles[`sources/${source.id}-${basename(source.path)}`] = digest(await readFile(resolve(evaluationRoot, source.path)))
    }
    const orderedFiles = Object.fromEntries(Object.entries(expectedPacketFiles).sort(([left], [right]) => left.localeCompare(right)))
    if (JSON.stringify(packet.files) !== JSON.stringify(orderedFiles)) {
      throw new Error(`${entry.scenarioId} review packet file manifest is not canonical`)
    }
    const expectedSources = scenario.sources.map(source => ({
      id: source.id,
      title: source.title,
      origin: source.origin,
      uri: source.uri,
      quality: source.quality,
      family: source.family,
      asOf: source.asOf,
      sha256: source.sha256,
    }))
    if (JSON.stringify(packet.sources) !== JSON.stringify(expectedSources)) {
      throw new Error(`${entry.scenarioId} review packet Source manifest is not canonical`)
    }
    if (!sameSet(Object.values(unblinding.mapping), expectedConditions(scenario))) {
      throw new Error(`${entry.scenarioId} unblinding mapping does not match run arms`)
    }
    const evidenceIdentity = digest((['A', 'B'] as const).flatMap(alias => {
      const condition = unblinding.mapping[alias]
      const files = [
        entry.examples.find(file => file.arm === alias),
        entry.eventLogs.find(file => file.arm === alias),
        entry.modelLogs.find(file => file.arm === alias),
      ]
      if (files.some(file => file === undefined)) throw new Error(`${entry.scenarioId} evidence aliases are incomplete`)
      return files.map(file => `${condition}\0${file!.sha256}`)
    }).sort().join('\n'))
    const identities = evidenceIdentities.get(entry.scenarioId) ?? new Set<string>()
    if (identities.has(evidenceIdentity)) throw new Error(`${entry.scenarioId} replicates reuse the same condition evidence`)
    identities.add(evidenceIdentity)
    evidenceIdentities.set(entry.scenarioId, identities)
    const runArms = record(run.arms, `${entry.scenarioId} run arms`)
    for (const alias of ['A', 'B'] as const) {
      const condition = unblinding.mapping[alias]
      const arm = record(runArms[condition], `${entry.scenarioId} ${condition} arm`)
      if (typeof arm.modelVisibleWorkspace !== 'string'
        || (!posix.isAbsolute(arm.modelVisibleWorkspace) && !win32.isAbsolute(arm.modelVisibleWorkspace))) {
        throw new Error(`${entry.scenarioId} ${condition} model-visible workspace is invalid`)
      }
      let rawArmRoot: string | undefined
      if (rawArchiveFiles !== undefined) {
        if (typeof arm.path !== 'string') throw new Error(`${entry.scenarioId} ${condition} arm path is invalid`)
        rawArmRoot = `${entry.rawRunRoot}/${archivePath(arm.path, `${entry.scenarioId} arm path`)}`
        if (!rawFile(rawArchiveFiles, `${rawArmRoot}/scenario.json`).equals(scenarioBytes)
          || !rawFile(rawArchiveFiles, `${rawArmRoot}/rubric.md`).equals(rubricBytes)) {
          throw new Error(`${entry.scenarioId} ${condition} raw scenario or rubric bytes differ`)
        }
        if (typeof arm.artifactPath !== 'string') throw new Error(`${entry.scenarioId} ${condition} raw Artifact path is invalid`)
        const rawArtifact = rawFile(rawArchiveFiles, `${rawArmRoot}/${archivePath(arm.artifactPath, 'arm artifact path')}`)
        if (digest(rawArtifact) !== arm.artifactSha256
          || scenario.expectations.forbiddenArtifactQuotes.some(quote => rawArtifact.toString('utf8').includes(quote))) {
          throw new Error(`${entry.scenarioId} ${condition} raw Artifact does not match the run manifest or canary floor`)
        }
        if (!eventBytes[alias].equals(rawFile(rawArchiveFiles, `${rawArmRoot}/session.jsonl`))
          || !modelBytes[alias].equals(rawFile(rawArchiveFiles, `${rawArmRoot}/model-calls.jsonl`))) {
          throw new Error(`${entry.scenarioId} ${condition} preserved ledgers differ from the raw archive`)
        }
        const serviceCalls = jsonLines(rawFile(rawArchiveFiles, `${rawArmRoot}/service-calls.jsonl`), `${entry.scenarioId} service ledger`)
        if (serviceCalls.some(call => call.kind !== 'search' && call.kind !== 'fetch' && call.kind !== 'mcp')) {
          throw new Error(`${entry.scenarioId} ${condition} service ledger contains an unknown operation`)
        }
        const mcpUris = new Set(scenario.sources.filter(source => source.origin === 'mcp').map(source => source.uri))
        if (serviceCalls.some(call => call.kind === 'mcp'
          && (typeof call.subject !== 'string' || !mcpUris.has(call.subject)))) {
          throw new Error(`${entry.scenarioId} ${condition} service ledger contains an unknown MCP resource`)
        }
        const usage = record(arm.usage, `${entry.scenarioId} ${condition} usage`)
        if (usage.searchCalls !== serviceCalls.filter(call => call.kind === 'search').length
          || usage.fetchCalls !== serviceCalls.filter(call => call.kind === 'fetch').length) {
          throw new Error(`${entry.scenarioId} ${condition} service usage does not match raw calls`)
        }
        const progress = exactRecord(JSON.parse(
          rawFile(rawArchiveFiles, `${rawArmRoot}/progress.json`).toString('utf8'),
        ), [
          'schemaVersion', 'nextTurnIndex', 'currentSessionId', 'sessionIds', 'processGenerationIds',
          'startedAt', 'completedAt', 'finished', 'terminalStatus', 'terminalReason',
        ], `${entry.scenarioId} progress`)
        if (progress.schemaVersion !== 1 || progress.finished !== true
          || JSON.stringify(progress.sessionIds) !== JSON.stringify(arm.sessionIds)
          || JSON.stringify(progress.processGenerationIds) !== JSON.stringify(arm.processGenerationIds)
          || progress.terminalStatus !== arm.terminalStatus) {
          throw new Error(`${entry.scenarioId} ${condition} progress does not match the run manifest`)
        }
        const initialRoot = `${rawArmRoot}/model-workspace-initial`
        if (archiveTreeDigest(rawArchiveFiles, initialRoot) !== arm.initialWorkspaceSha256
          || archiveTreeDigest(rawArchiveFiles, `${rawArmRoot}/final-workspace`) !== arm.finalWorkspaceSha256) {
          throw new Error(`${entry.scenarioId} ${condition} workspace digests do not match raw bytes`)
        }
        const inputEntries = archiveTreeEntries(rawArchiveFiles, `${rawArmRoot}/input-workspace`)
        const expectedInputPaths = [...new Set([
          'AGENTS.md',
          'SOURCE_CATALOG.json',
          ...scenario.sources.map(source => source.path),
        ])].sort()
        if (!sameSet(inputEntries.map(item => item.path), expectedInputPaths)) {
          throw new Error(`${entry.scenarioId} ${condition} reviewer input workspace contains unexpected files`)
        }
        for (const source of scenario.sources) {
          const archived = inputEntries.find(item => item.path === source.path)?.bytes
          const current = await readFile(resolve(evaluationRoot, source.path))
          if (archived === undefined || !archived.equals(current)) {
            throw new Error(`${entry.scenarioId} ${condition} reviewer Source bytes differ from the frozen suite`)
          }
        }
        const initialEntries = archiveTreeEntries(rawArchiveFiles, initialRoot)
        const expectedPaths = [
          'AGENTS.md',
          'SOURCE_CATALOG.json',
          ...scenario.sources.filter(source => source.origin === 'local' || source.origin === 'llm-wiki').map(expectedModelPath),
        ].sort()
        if (!sameSet(initialEntries.map(item => item.path), expectedPaths)) {
          throw new Error(`${entry.scenarioId} ${condition} initial model workspace contains unexpected files`)
        }
        if (initialEntries.find(item => item.path === 'AGENTS.md')?.bytes.toString('utf8') !== EVALUATION_AGENTS) {
          throw new Error(`${entry.scenarioId} ${condition} model instructions differ from the evaluator contract`)
        }
        const catalog = exactRecord(JSON.parse(
          initialEntries.find(item => item.path === 'SOURCE_CATALOG.json')?.bytes.toString('utf8') ?? '',
        ), ['notice', 'sources'], `${entry.scenarioId} Source catalog`)
        if (catalog.notice !== 'Synthetic controlled evidence for Raven evaluation; not real-world facts.'
          || !Array.isArray(catalog.sources) || catalog.sources.length !== scenario.sources.length) {
          throw new Error(`${entry.scenarioId} ${condition} Source catalog is incomplete`)
        }
        for (const [index, source] of scenario.sources.entries()) {
          const catalogSource = exactRecord(catalog.sources[index], [
            'id', 'title', 'origin', 'uri', 'path', 'quality', 'family', 'asOf',
          ], `${entry.scenarioId} Source catalog entry`)
          if (catalogSource.id !== source.id || catalogSource.title !== source.title || catalogSource.origin !== source.origin
            || catalogSource.path !== expectedModelPath(source) || catalogSource.quality !== source.quality
            || catalogSource.family !== source.family || catalogSource.asOf !== source.asOf
            || ((source.origin === 'web' || source.origin === 'mcp') && catalogSource.uri !== source.uri)
            || ((source.origin === 'local' || source.origin === 'llm-wiki')
              && (typeof catalogSource.uri !== 'string'
                || recordedRelativePath(arm.modelVisibleWorkspace, catalogSource.uri) !== expectedModelPath(source)))) {
            throw new Error(`${entry.scenarioId} ${condition} Source catalog differs from the frozen scenario`)
          }
        }
        for (const source of scenario.sources.filter(source => source.origin === 'local' || source.origin === 'llm-wiki')) {
          const archived = initialEntries.find(item => item.path === expectedModelPath(source))?.bytes
          const current = await readFile(resolve(evaluationRoot, source.path))
          if (archived === undefined || !archived.equals(current)) {
            throw new Error(`${entry.scenarioId} ${condition} model-visible Source bytes differ from the frozen suite`)
          }
        }
      }
      if (manifest.status === 'production') verifyUserTurns(eventBytes[alias], scenario, `${entry.scenarioId} ${condition}`)
      const eventCounts = verifyToolIsolation(
        eventBytes[alias], arm.modelVisibleWorkspace, `${entry.scenarioId} ${condition}`,
      )
      const usage = record(arm.usage, `${entry.scenarioId} ${condition} usage`)
      const failures = record(arm.protocolFailures, `${entry.scenarioId} ${condition} protocol failures`)
      if (usage.toolCalls !== eventCounts.toolCalls || usage.ptcNestedCalls !== eventCounts.nestedCalls
        || failures.toolResults !== eventCounts.toolFailures || failures.ptcNested !== eventCounts.nestedFailures) {
        throw new Error(`${entry.scenarioId} ${condition} tool usage does not match Session events`)
      }
      verifyModelRoutes(modelBytes[alias], run, condition, arm, `${entry.scenarioId} ${condition}`)
      if (condition !== 'vanilla') {
        const task = record(arm.ravenTask, `${entry.scenarioId} ${condition} Raven Task`)
        if (typeof task.taskId !== 'string') throw new Error(`${entry.scenarioId} ${condition} Task ID is invalid`)
        const lastGeneration = (arm.processGenerationIds as string[]).at(-1)
        if (rawArchiveFiles !== undefined) {
          if (lastGeneration === undefined || rawArmRoot === undefined) {
            throw new Error(`${entry.scenarioId} ${condition} final Raven state is absent from raw evidence`)
          }
          const allStates = (arm.processGenerationIds as string[]).flatMap((generation) => {
            const rawStates = JSON.parse(rawFile(rawArchiveFiles, `${rawArmRoot}/raven-states-${generation}.json`).toString('utf8')) as unknown
            if (!Array.isArray(rawStates)) throw new Error(`${entry.scenarioId} ${condition} Raven state ledger is invalid`)
            return rawStates.map((meta) => {
              const value = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>).state : undefined
              const state = decodeRavenTaskState(value)
              if (state === undefined) throw new Error(`${entry.scenarioId} ${condition} Raven state ledger contains invalid state`)
              return state
            })
          })
          const eventStates = ravenStateMetas(
            jsonLines(eventBytes[alias], `${entry.scenarioId} Session events`) as never,
          ).map((meta) => decodeRavenTaskState(typeof meta === 'object' && meta !== null
            ? (meta as Record<string, unknown>).state
            : undefined))
          if (eventStates.some(state => state === undefined)
            || JSON.stringify(eventStates.at(-1)) !== JSON.stringify(allStates.at(-1))) {
            throw new Error(`${entry.scenarioId} ${condition} Raven state snapshots are not bound to Session events`)
          }
          for (let index = 1; index < allStates.length; index += 1) {
            const previous = allStates[index - 1]!
            const current = allStates[index]!
            if (previous.taskId === current.taskId && current.revision < previous.revision) {
              throw new Error(`${entry.scenarioId} ${condition} Raven state revisions are not monotonic`)
            }
          }
          const finalState = allStates.at(-1)
          const finalOrigins = [...new Set(finalState?.sources.map(source => source.resource.origin) ?? [])].sort()
          const routeCount = new Set((finalState?.drafts ?? []).flatMap(round => round.path === 'multi-model'
            ? round.routes.filter(route => route.status === 'drafted').map(route => JSON.stringify([route.provider, route.model]))
            : [])).size
          const taskActions = jsonLines(eventBytes[alias], `${entry.scenarioId} Session events`).flatMap((item) => {
            const event = record(item.event, `${entry.scenarioId} Session event`)
            const data = typeof event.data === 'object' && event.data !== null
              ? event.data as Record<string, unknown>
              : undefined
            const args = typeof data?.arguments === 'object' && data.arguments !== null
              ? data.arguments as Record<string, unknown>
              : undefined
            if (event.type !== 'tool/code-dispatch' || data?.name !== 'raven_task' || data.isError !== false
              || typeof args?.action !== 'string' || typeof event.seq !== 'number'
              || args.taskId !== finalState?.taskId) return []
            const rendered = Array.isArray(data.content)
              ? data.content.flatMap(block => typeof block === 'object' && block !== null
                && (block as Record<string, unknown>).type === 'text'
                && typeof (block as Record<string, unknown>).text === 'string'
                ? [(block as Record<string, unknown>).text as string]
                : []).join('\n')
              : ''
            return [{
              action: args.action,
              seq: event.seq,
              rendered,
              generation: typeof item.generation === 'string' ? item.generation : null,
              sessionId: typeof item.sessionId === 'string' ? item.sessionId : null,
            }]
          })
          const lastActionSeq = (action: string) => taskActions
            .filter(item => item.action === action)
            .reduce((latest, item) => Math.max(latest, item.seq), -1)
          const completedAction = taskActions.findLast(item => item.action === 'complete')
          const finalPhase = completedAction === undefined
            ? finalState?.phase
            : completedAction.rendered.includes('completed-with-limits') ? 'completed-with-limits' : 'completed'
          const checkpointCount = Math.max(
            finalState?.checkpoints.length ?? 0,
            taskActions.filter(item => item.action === 'checkpoint').length,
          )
          const selectedStructure = finalState?.selectedSkeleton !== null
            || lastActionSeq('select-structure') > lastActionSeq('steer')
          const stopped = taskActions.findLast(item => item.action === 'stop')
          const resumed = taskActions.findLast(item => item.action === 'resume')
          const completed = taskActions.findLast(item => item.action === 'complete')
          const stopResumeSameTask = stopped !== undefined && resumed !== undefined && completed !== undefined
            && stopped.sessionId !== null && stopped.sessionId === resumed.sessionId && resumed.sessionId === completed.sessionId
            && stopped.generation !== null && resumed.generation !== null && completed.generation !== null
            && stopped.generation !== resumed.generation && resumed.generation === completed.generation
            && stopped.seq < resumed.seq && resumed.seq < completed.seq
          if (finalState === undefined || finalState.taskId !== task.taskId || finalPhase !== task.phase
            || finalState.revision !== task.revision || checkpointCount !== task.checkpoints
            || new Set(allStates.map(state => state.taskId)).size !== task.taskCount
            || JSON.stringify(finalOrigins) !== JSON.stringify(task.sourceOrigins)
            || routeCount !== task.distinctDraftRoutes
            || selectedStructure !== task.selectedStructure
            || stopResumeSameTask !== task.stopResumeSameTask) {
            throw new Error(`${entry.scenarioId} ${condition} Raven Task summary does not match decoded raw states and actions`)
          }
        }
        verifyTaskLifecycle(eventBytes[alias], task.taskId, scenario, `${entry.scenarioId} ${condition}`)
      }
    }
    const reviewCheck = verifyEvaluationReviews(scenario, entry.pairId, reviews, manifest.status === 'production', expectedBinding)
    if (!reviewCheck.pass) throw new Error(reviewCheck.issues.join('; '))
    await verifyReviewEvidence(
      evaluationRoot,
      scenario,
      reviews,
      { A: exampleBytes.A.toString('utf8'), B: exampleBytes.B.toString('utf8') },
      { A: eventBytes.A.toString('utf8'), B: eventBytes.B.toString('utf8') },
    )
    recomputeRunEligibility(
      run,
      scenario,
      digest(scenarioBytes),
      digest(rubricBytes),
      sourceSnapshotSha256,
      manifest,
      entry.pairId,
      expectedBinding.artifacts,
      unblinding.mapping,
    )
    verifyReport(report, run, scenario, reviews, manifest.status === 'production')
    if (manifest.status === 'production') {
      const resolutions = decision.disagreements.filter(item => item.scenarioId === entry.scenarioId && item.pairId === entry.pairId)
      const promotion = analyzeEvaluationReviewsForPromotion(scenario, reviews, unblinding.mapping, resolutions)
      if (!promotion.pass) throw new Error(promotion.issues.join('; '))
    }
    allReviews.push(...reviews)
  }
  if (manifest.status === 'production') {
    for (const scenarioId of CORE_EVALUATION_SCENARIO_IDS) {
      const scenario = decodeEvaluationScenario(JSON.parse(await readFile(
        resolve(evaluationRoot, 'scenarios', `${scenarioId}.json`), 'utf8',
      )))
      if (scenario === undefined) throw new Error(`${scenarioId} current scenario is invalid`)
      const observed = firstArms.get(scenarioId) ?? []
      const expected = expectedConditions(scenario)
      const perArm = observed.length / expected.length
      if (!Number.isInteger(perArm) || perArm < 1
        || observed.some(value => !expected.includes(value))
        || expected.some(value => observed.filter(item => item === value).length !== perArm)) {
        throw new Error(`${scenarioId} production replicates are not counterbalanced`)
      }
    }
  }
  if (decision.approverIds.some(approver => allReviews.some(review => review.reviewerId === approver))) {
    throw new Error('promotion approvers must be independent from evidence reviewers')
  }
  const latestReviewAt = Math.max(...allReviews.map(review => Date.parse(review.createdAt)))
  if (!Number.isFinite(latestReviewAt) || Date.parse(decision.decidedAt) < latestReviewAt) {
    throw new Error('promotion decision predates the immutable reviews')
  }
  return [...new Set(scenarioIds)]
}

/** Validate a frozen baseline without rerunning paid model calls. */
export async function verifyEvaluationBaseline(
  manifestPathValue: string,
  evaluationRootValue = resolve('evaluation'),
): Promise<{
  pass: boolean
  status?: 'production' | 'protocol'
  scenarios?: string[]
  issues: string[]
}> {
  const issues: string[] = []
  try {
    const manifestPath = resolve(manifestPathValue)
    const evaluationRoot = resolve(evaluationRootValue)
    const root = dirname(manifestPath)
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as { schemaVersion?: unknown }
    if (parsed.schemaVersion !== 2) throw new Error('baseline schemaVersion is unsupported; use schemaVersion 2')
    const manifest = decodeV2(parsed)
    const currentSuiteSha256 = await evaluationSuiteSha256(evaluationRoot)
    if (manifest.suiteSha256 !== currentSuiteSha256) throw new Error('baseline suite digest does not match current evaluation inputs')
    const scenarioIds = await verifyV2(root, manifest, evaluationRoot)
    return { pass: true, status: manifest.status, scenarios: scenarioIds, issues }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error))
    return { pass: false, issues }
  }
}

export async function verifyTrackedEvaluationBaselines(
  evaluationRootValue = resolve('evaluation'),
  repositoryRootValue = resolve('.'),
): Promise<{
  pass: boolean
  manifests: Array<{ path: string; pass: boolean; status?: 'production' | 'protocol'; issues: string[] }>
  issues: string[]
}> {
  const evaluationRoot = resolve(evaluationRootValue)
  const repositoryRoot = resolve(repositoryRootValue)
  const relativeEvaluationRoot = relative(repositoryRoot, evaluationRoot).replaceAll('\\', '/')
  if (relativeEvaluationRoot === '' || relativeEvaluationRoot.startsWith('../') || isAbsolute(relativeEvaluationRoot)) {
    return { pass: false, manifests: [], issues: ['evaluation root must stay inside the Git repository'] }
  }
  try {
    const listed = await runProcess('git', ['ls-files', '-z', '--', `${relativeEvaluationRoot}/baselines`], {
      cwd: repositoryRoot,
      capture: true,
      timeoutMs: 20_000,
    })
    const paths = listed.stdout.split('\0')
      .filter(path => path.endsWith('/manifest.json'))
      .sort()
    const manifests = await Promise.all(paths.map(async path => {
      const result = await verifyEvaluationBaseline(resolve(repositoryRoot, path), evaluationRoot)
      return { path, pass: result.pass, ...(result.status === undefined ? {} : { status: result.status }), issues: result.issues }
    }))
    const issues = manifests.flatMap(manifest => manifest.issues.map(issue => `${manifest.path}: ${issue}`))
    return { pass: manifests.every(manifest => manifest.pass), manifests, issues }
  } catch (error) {
    return {
      pass: false,
      manifests: [],
      issues: [`could not enumerate tracked evaluation baselines: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
}
