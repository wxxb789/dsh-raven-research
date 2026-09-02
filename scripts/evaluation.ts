import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export const EVALUATION_SCHEMA_VERSION = 1 as const

export const EVALUATION_WORKFLOWS = [
  'research',
  'general-writing',
  'academic-writing',
  'knowledge-reuse',
  'local',
  'llm-wiki',
  'mcp',
  'web',
  'steering',
  'structure-selection',
  'multi-model-drafting',
] as const

export const CORE_EVALUATION_SCENARIO_IDS = [
  'research',
  'general-writing',
  'academic-grounded',
  'knowledge-reuse',
  'mixed-origins',
  'steering-checkpoint',
  'structure-selection',
  'multi-model-drafting',
] as const

export type EvaluationWorkflow = (typeof EVALUATION_WORKFLOWS)[number]
export type EvaluationCondition = 'vanilla' | 'raven'

export const EVALUATION_GLOBAL_TOOL_ALLOWLIST = [
  'read', 'write', 'edit', 'glob', 'grep',
  'web_search', 'web_fetch', 'mcp__raven_eval__read_resource',
] as const

export const EVALUATION_EXECUTION_TOOL_ALLOWLIST = [
  ...EVALUATION_GLOBAL_TOOL_ALLOWLIST,
  'raven_task', 'raven_workspace', 'run_code',
] as const

export const EVALUATION_REVIEW_DIMENSIONS = [
  'research-correctness',
  'claim-support-fidelity',
  'source-quality-independence',
  'coverage-contradiction-handling',
  'insight-defensibility',
  'synthesis-usefulness',
  'anti-summary',
  'argument-skeleton-quality',
  'final-prose-quality',
  'steering-retention',
  'checkpoint-usefulness',
  'stop-resume-durability',
  'knowledge-reuse',
  'completion-reliability',
  'cost-value',
  'provenance-completeness',
] as const

export type EvaluationReviewDimension = (typeof EVALUATION_REVIEW_DIMENSIONS)[number]

/** Remove only Raven-owned declarations from a generated PTC SDK section. */
export function normalizeEvaluationToolsSdk(text: string): string {
  const lines = text.split('\n')
  const normalized: string[] = []
  for (let index = 0; index < lines.length;) {
    if (!/^  raven_(?:task|workspace):/u.test(lines[index] ?? '')) {
      normalized.push(lines[index] ?? '')
      index += 1
      continue
    }
    if (/^  \/\*\*.*\*\/$/u.test(normalized.at(-1) ?? '')) normalized.pop()
    index += 1
    while (index < lines.length
      && !/^  [A-Za-z0-9_$-]+:/u.test(lines[index] ?? '')
      && lines[index] !== '}'
      && !(/^  \/\*\*.*\*\/$/u.test(lines[index] ?? '')
        && /^  [A-Za-z0-9_$-]+:/u.test(lines[index + 1] ?? ''))) {
      index += 1
    }
  }
  return normalized.join('\n')
}

export interface EvaluationSource {
  id: string
  title: string
  origin: 'web' | 'local' | 'llm-wiki' | 'mcp'
  uri: string
  path: string
  sha256: string
  quality: 'primary' | 'secondary' | 'dataset' | 'user-provided'
  family: string | null
  asOf: string | null
}

export interface EvaluationExpectations {
  requiredFactIds: string[]
  contradictionIds: string[]
  /** Exact planted phrases only; this canary is not a general semantic-completeness check. */
  forbiddenArtifactQuotes: string[]
  minimumIndependentSourceFamilies: number
  minimumCheckpoints: number
  requireStopResume: boolean
  requireKnowledgeReuse: boolean
  requireStructureChoice: boolean
  requireMultiModelDraft: boolean
  allowedTerminalStatuses: Array<EvaluationRun['terminalStatus']>
}

export interface EvaluationTurn {
  id: string
  delivery: 'followup' | 'steer'
  trigger: 'idle' | 'after-checkpoint' | 'after-process-restart' | 'new-session'
  content: string
}

export interface EvaluationScenario {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION
  id: string
  title: string
  description: string
  kind: 'primary' | 'ablation'
  outcome: 'research' | 'general-writing' | 'academic-writing' | 'learning'
  workflow: EvaluationWorkflow[]
  turns: EvaluationTurn[]
  sources: EvaluationSource[]
  expectations: EvaluationExpectations
  reviewDimensions: EvaluationReviewDimension[]
}

function strictRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => !(key in record))) {
    throw new TypeError(`${label} has missing or unknown fields`)
  }
  return record
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be non-empty text`)
  return value
}

function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new TypeError(`${label} is invalid`)
  return value as T
}

function uniqueTexts(value: unknown, label: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new TypeError(`${label} must be an array`)
  const items = value.map((item, index) => text(item, `${label}[${index}]`))
  if (new Set(items).size !== items.length) throw new TypeError(`${label} contains duplicates`)
  return items
}

function natural(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a nonnegative safe integer`)
  return value as number
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

function safeRelativePath(value: unknown, label: string): string {
  const path = text(value, label)
  const normalized = path.replaceAll('\\', '/')
  if (isAbsolute(path) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new TypeError(`${label} must stay inside the evaluation root`)
  }
  if (!normalized.startsWith('fixtures/') || normalized === 'fixtures/') {
    throw new TypeError(`${label} must name a file under evaluation/fixtures`)
  }
  return normalized
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const TERMINAL_STATUSES = ['completed', 'completed-with-limits', 'failed', 'cancelled'] as const
const OUTCOMES = ['research', 'general-writing', 'academic-writing', 'learning'] as const
const SOURCE_ORIGINS = ['web', 'local', 'llm-wiki', 'mcp'] as const
const SOURCE_QUALITIES = ['primary', 'secondary', 'dataset', 'user-provided'] as const

/** Strict, total decoder for tracked scenario manifests. */
export function decodeEvaluationScenario(value: unknown): EvaluationScenario | undefined {
  try {
    const root = strictRecord(value, [
      'schemaVersion', 'id', 'title', 'description', 'kind', 'outcome', 'workflow', 'turns',
      'sources', 'expectations', 'reviewDimensions',
    ], 'scenario')
    if (root.schemaVersion !== EVALUATION_SCHEMA_VERSION) throw new TypeError('unsupported scenario schemaVersion')
    const id = text(root.id, 'scenario.id')
    if (!SAFE_ID.test(id)) throw new TypeError('scenario.id is unsafe')
    const rawWorkflows = uniqueTexts(root.workflow, 'scenario.workflow', false)
    const workflow = rawWorkflows.map(item => member(item, EVALUATION_WORKFLOWS, 'scenario.workflow[]'))
    if (!Array.isArray(root.turns) || root.turns.length === 0) throw new TypeError('scenario.turns must be non-empty')
    const turns = root.turns.map((raw, index): EvaluationTurn => {
      const item = strictRecord(raw, ['id', 'delivery', 'trigger', 'content'], `scenario.turns[${index}]`)
      const turnId = text(item.id, `scenario.turns[${index}].id`)
      if (!SAFE_ID.test(turnId)) throw new TypeError('scenario turn id is unsafe')
      return {
        id: turnId,
        delivery: member(item.delivery, ['followup', 'steer'] as const, 'turn.delivery'),
        trigger: member(item.trigger, ['idle', 'after-checkpoint', 'after-process-restart', 'new-session'] as const, 'turn.trigger'),
        content: text(item.content, 'turn.content'),
      }
    })
    if (new Set(turns.map(turn => turn.id)).size !== turns.length) throw new TypeError('scenario turn ids are not unique')
    if (!Array.isArray(root.sources)) throw new TypeError('scenario.sources must be an array')
    const sources = root.sources.map((raw, index): EvaluationSource => {
      const item = strictRecord(raw, [
        'id', 'title', 'origin', 'uri', 'path', 'sha256', 'quality', 'family', 'asOf',
      ], `scenario.sources[${index}]`)
      const sourceId = text(item.id, `scenario.sources[${index}].id`)
      if (!SAFE_ID.test(sourceId)) throw new TypeError('scenario source id is unsafe')
      const digest = text(item.sha256, 'source.sha256')
      if (!SHA256.test(digest)) throw new TypeError('source.sha256 is invalid')
      if (item.family !== null && (typeof item.family !== 'string' || item.family.trim() === '')) {
        throw new TypeError('source.family must be non-empty text or null')
      }
      if (item.asOf !== null && (typeof item.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.asOf))) {
        throw new TypeError('source.asOf must be YYYY-MM-DD or null')
      }
      return {
        id: sourceId,
        title: text(item.title, 'source.title'),
        origin: member(item.origin, SOURCE_ORIGINS, 'source.origin'),
        uri: text(item.uri, 'source.uri'),
        path: safeRelativePath(item.path, 'source.path'),
        sha256: digest,
        quality: member(item.quality, SOURCE_QUALITIES, 'source.quality'),
        family: item.family,
        asOf: item.asOf,
      } as EvaluationSource
    })
    if (new Set(sources.map(source => source.id)).size !== sources.length) throw new TypeError('scenario source ids are not unique')
    const expected = strictRecord(root.expectations, [
      'requiredFactIds', 'contradictionIds', 'forbiddenArtifactQuotes', 'minimumIndependentSourceFamilies',
      'minimumCheckpoints', 'requireStopResume', 'requireKnowledgeReuse', 'requireStructureChoice',
      'requireMultiModelDraft', 'allowedTerminalStatuses',
    ], 'scenario.expectations')
    const allowedTerminalStatuses = uniqueTexts(expected.allowedTerminalStatuses, 'allowedTerminalStatuses', false)
      .map(status => member(status, TERMINAL_STATUSES, 'allowedTerminalStatuses[]'))
    const expectations: EvaluationExpectations = {
      requiredFactIds: uniqueTexts(expected.requiredFactIds, 'requiredFactIds'),
      contradictionIds: uniqueTexts(expected.contradictionIds, 'contradictionIds'),
      forbiddenArtifactQuotes: uniqueTexts(expected.forbiddenArtifactQuotes, 'forbiddenArtifactQuotes'),
      minimumIndependentSourceFamilies: natural(expected.minimumIndependentSourceFamilies, 'minimumIndependentSourceFamilies'),
      minimumCheckpoints: natural(expected.minimumCheckpoints, 'minimumCheckpoints'),
      requireStopResume: bool(expected.requireStopResume, 'requireStopResume'),
      requireKnowledgeReuse: bool(expected.requireKnowledgeReuse, 'requireKnowledgeReuse'),
      requireStructureChoice: bool(expected.requireStructureChoice, 'requireStructureChoice'),
      requireMultiModelDraft: bool(expected.requireMultiModelDraft, 'requireMultiModelDraft'),
      allowedTerminalStatuses,
    }
    const reviewDimensions = uniqueTexts(root.reviewDimensions, 'scenario.reviewDimensions', false)
      .map(item => member(item, EVALUATION_REVIEW_DIMENSIONS, 'scenario.reviewDimensions[]'))
    return {
      schemaVersion: EVALUATION_SCHEMA_VERSION,
      id,
      title: text(root.title, 'scenario.title'),
      description: text(root.description, 'scenario.description'),
      kind: member(root.kind, ['primary', 'ablation'] as const, 'scenario.kind'),
      outcome: member(root.outcome, OUTCOMES, 'scenario.outcome'),
      workflow,
      turns,
      sources,
      expectations,
      reviewDimensions,
    }
  } catch {
    return undefined
  }
}

export type EvaluationReviewStatus = 'pass' | 'concern' | 'fail' | 'n/a'
export type EvaluationPreference = 'A' | 'B' | 'tie' | 'cannot-judge'

export interface EvaluationReviewBinding {
  packetManifestSha256: string
  mappingCommitmentSha256: string
  scenarioSha256: string
  rubricSha256: string
  assessorChecklistSha256: string
  artifacts: { A: string; B: string }
}

export interface EvaluationReview {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION
  reviewId: string
  reviewerId: string
  scenarioId: string
  pairId: string
  blindOrder: ['A', 'B'] | ['B', 'A']
  rubricVersion: string
  binding: EvaluationReviewBinding
  assessorIds: string[]
  dimensions: Array<{
    dimension: EvaluationReviewDimension
    A: EvaluationReviewStatus
    B: EvaluationReviewStatus
    preference: EvaluationPreference
    confidence: 'low' | 'medium' | 'high'
    evidence: Array<{
      arm: 'A' | 'B'
      exactQuote: string
      sourceId: string | null
      eventSeq: number | null
      note: string
    }>
    rationale: string
  }>
  overallPreference: EvaluationPreference
  confidence: 'low' | 'medium' | 'high'
  armGuess: 'A-is-vanilla' | 'B-is-vanilla' | 'unknown'
  createdAt: string
}

export interface EvaluationAssessorCatalog {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION
  notice: string
  facts: Array<{ id: string; statement: string; sourceIds: string[] }>
  contradictions: Array<{ id: string; factIds: string[]; handlingRule: string }>
  canary: { exactForbiddenArtifactQuote: string; rule: string }
}

function evaluationReviewBinding(value: unknown, label: string): EvaluationReviewBinding {
  const record = strictRecord(value, [
    'packetManifestSha256', 'mappingCommitmentSha256', 'scenarioSha256', 'rubricSha256',
    'assessorChecklistSha256', 'artifacts',
  ], label)
  const artifacts = strictRecord(record.artifacts, ['A', 'B'], `${label}.artifacts`)
  const digestField = (field: unknown, fieldLabel: string): string => {
    const value = text(field, fieldLabel)
    if (!SHA256.test(value)) throw new TypeError(`${fieldLabel} is invalid`)
    return value
  }
  return {
    packetManifestSha256: digestField(record.packetManifestSha256, `${label}.packetManifestSha256`),
    mappingCommitmentSha256: digestField(record.mappingCommitmentSha256, `${label}.mappingCommitmentSha256`),
    scenarioSha256: digestField(record.scenarioSha256, `${label}.scenarioSha256`),
    rubricSha256: digestField(record.rubricSha256, `${label}.rubricSha256`),
    assessorChecklistSha256: digestField(record.assessorChecklistSha256, `${label}.assessorChecklistSha256`),
    artifacts: {
      A: digestField(artifacts.A, `${label}.artifacts.A`),
      B: digestField(artifacts.B, `${label}.artifacts.B`),
    },
  }
}

export function decodeEvaluationReviewBinding(value: unknown): EvaluationReviewBinding | undefined {
  try {
    return evaluationReviewBinding(value, 'review binding')
  } catch {
    return undefined
  }
}

/** Strict, append-only review record decoder. */
export function decodeEvaluationReview(value: unknown): EvaluationReview | undefined {
  try {
    const root = strictRecord(value, [
      'schemaVersion', 'reviewId', 'reviewerId', 'scenarioId', 'pairId', 'blindOrder', 'rubricVersion',
      'binding', 'assessorIds', 'dimensions', 'overallPreference', 'confidence', 'armGuess', 'createdAt',
    ], 'review')
    if (root.schemaVersion !== EVALUATION_SCHEMA_VERSION) throw new TypeError('unsupported review schemaVersion')
    for (const field of ['reviewId', 'reviewerId', 'scenarioId', 'pairId'] as const) {
      if (!SAFE_ID.test(text(root[field], `review.${field}`))) throw new TypeError(`review.${field} is unsafe`)
    }
    if (!Array.isArray(root.blindOrder) || root.blindOrder.length !== 2
      || !((root.blindOrder[0] === 'A' && root.blindOrder[1] === 'B')
        || (root.blindOrder[0] === 'B' && root.blindOrder[1] === 'A'))) {
      throw new TypeError('review.blindOrder must contain A and B exactly once')
    }
    const assessorIds = uniqueTexts(root.assessorIds, 'review.assessorIds')
    if (assessorIds.some(id => !SAFE_ID.test(id))) throw new TypeError('review.assessorIds contains an unsafe ID')
    if (!Array.isArray(root.dimensions) || root.dimensions.length === 0) throw new TypeError('review.dimensions must be non-empty')
    const dimensions = root.dimensions.map((raw, index): EvaluationReview['dimensions'][number] => {
      const item = strictRecord(raw, [
        'dimension', 'A', 'B', 'preference', 'confidence', 'evidence', 'rationale',
      ], `review.dimensions[${index}]`)
      if (!Array.isArray(item.evidence)) throw new TypeError('review dimension evidence must be an array')
      const evidence = item.evidence.map((rawEvidence, evidenceIndex) => {
        const entry = strictRecord(rawEvidence, ['arm', 'exactQuote', 'sourceId', 'eventSeq', 'note'], `review evidence[${evidenceIndex}]`)
        if (entry.sourceId !== null && typeof entry.sourceId !== 'string') throw new TypeError('review evidence sourceId is invalid')
        if (entry.eventSeq !== null) natural(entry.eventSeq, 'review evidence eventSeq')
        return {
          arm: member(entry.arm, ['A', 'B'] as const, 'review evidence arm'),
          exactQuote: text(entry.exactQuote, 'review evidence exactQuote'),
          sourceId: entry.sourceId,
          eventSeq: entry.eventSeq,
          note: text(entry.note, 'review evidence note'),
        } as EvaluationReview['dimensions'][number]['evidence'][number]
      })
      return {
        dimension: member(item.dimension, EVALUATION_REVIEW_DIMENSIONS, 'review dimension'),
        A: member(item.A, ['pass', 'concern', 'fail', 'n/a'] as const, 'review A status'),
        B: member(item.B, ['pass', 'concern', 'fail', 'n/a'] as const, 'review B status'),
        preference: member(item.preference, ['A', 'B', 'tie', 'cannot-judge'] as const, 'review preference'),
        confidence: member(item.confidence, ['low', 'medium', 'high'] as const, 'review confidence'),
        evidence,
        rationale: text(item.rationale, 'review rationale'),
      }
    })
    if (new Set(dimensions.map(item => item.dimension)).size !== dimensions.length) {
      throw new TypeError('review dimensions contain duplicates')
    }
    const createdAt = text(root.createdAt, 'review.createdAt')
    if (!Number.isFinite(Date.parse(createdAt))) throw new TypeError('review.createdAt is invalid')
    return {
      schemaVersion: EVALUATION_SCHEMA_VERSION,
      reviewId: root.reviewId as string,
      reviewerId: root.reviewerId as string,
      scenarioId: root.scenarioId as string,
      pairId: root.pairId as string,
      blindOrder: root.blindOrder as ['A', 'B'] | ['B', 'A'],
      rubricVersion: text(root.rubricVersion, 'review.rubricVersion'),
      binding: evaluationReviewBinding(root.binding, 'review.binding'),
      assessorIds,
      dimensions,
      overallPreference: member(root.overallPreference, ['A', 'B', 'tie', 'cannot-judge'] as const, 'review overallPreference'),
      confidence: member(root.confidence, ['low', 'medium', 'high'] as const, 'review confidence'),
      armGuess: member(root.armGuess, ['A-is-vanilla', 'B-is-vanilla', 'unknown'] as const, 'review armGuess'),
      createdAt,
    }
  } catch {
    return undefined
  }
}

const TRACE_REVIEW_DIMENSIONS = new Set<EvaluationReviewDimension>([
  'steering-retention',
  'checkpoint-usefulness',
  'stop-resume-durability',
  'knowledge-reuse',
  'completion-reliability',
])
const LIFECYCLE_REVIEW_DIMENSIONS = new Set<EvaluationReviewDimension>([
  ...TRACE_REVIEW_DIMENSIONS,
  'cost-value',
])

export function verifyEvaluationReviews(
  scenario: EvaluationScenario,
  pairId: string,
  reviews: readonly EvaluationReview[],
  requireCompleteCoverage = true,
  expectedBinding?: EvaluationReviewBinding,
): { pass: boolean; issues: string[] } {
  const issues: string[] = []
  const reviewIds = new Set<string>()
  const reviewers = new Set<string>()
  const canonicalBinding = JSON.stringify(expectedBinding ?? reviews[0]?.binding)
  for (const review of reviews) {
    if (review.scenarioId !== scenario.id) issues.push(`review ${review.reviewId} names the wrong scenario`)
    if (review.pairId !== pairId) issues.push(`review ${review.reviewId} names the wrong pair`)
    if (reviewIds.has(review.reviewId)) issues.push(`review id is not unique: ${review.reviewId}`)
    reviewIds.add(review.reviewId)
    if (reviewers.has(review.reviewerId)) issues.push(`reviewer is not independent: ${review.reviewerId}`)
    reviewers.add(review.reviewerId)
    if (JSON.stringify(review.binding) !== canonicalBinding) {
      issues.push(`review ${review.reviewId} binding does not match the immutable review packet`)
    }
    const dimensions = review.dimensions.map(item => item.dimension)
    if (!equalSets(dimensions, scenario.reviewDimensions)) {
      issues.push(`review ${review.reviewId} does not cover exactly the scenario dimensions`)
    }
    const hasContentJudgment = review.dimensions.some(dimension => !LIFECYCLE_REVIEW_DIMENSIONS.has(dimension.dimension)
      && dimension.A !== 'n/a' && dimension.B !== 'n/a')
    const expectedAssessorIds = [...scenario.expectations.requiredFactIds, ...scenario.expectations.contradictionIds]
    if (hasContentJudgment && !equalSets(review.assessorIds, expectedAssessorIds)) {
      issues.push(`review ${review.reviewId} does not cover exactly the scenario assessor checklist IDs`)
    }
    if (!hasContentJudgment && review.assessorIds.length > 0) {
      issues.push(`lifecycle-only review ${review.reviewId} must not claim assessor checklist coverage`)
    }
    for (const dimension of review.dimensions) {
      for (const arm of ['A', 'B'] as const) {
        if (dimension[arm] !== 'n/a' && !dimension.evidence.some(evidence => evidence.arm === arm)) {
          issues.push(`review ${review.reviewId} dimension ${dimension.dimension} has an evidence-free ${arm} judgment`)
        }
      }
      if ((dimension.preference === 'A' || dimension.preference === 'B')
        && !dimension.evidence.some(item => item.arm === dimension.preference)) {
        issues.push(`review ${review.reviewId} dimension ${dimension.dimension} cites no evidence from preferred arm ${dimension.preference}`)
      }

    }
  }
  if (reviews.length < 2 || reviewers.size < 2) issues.push('release review requires two independent reviewers')
  if (requireCompleteCoverage) {
    for (const dimension of scenario.reviewDimensions) {
      const substantiveReviewers = new Set(reviews.flatMap((review) => {
        const item = review.dimensions.find(entry => entry.dimension === dimension)
        const substantive = item !== undefined && item.A !== 'n/a' && item.B !== 'n/a'
        const traceGrounded = item !== undefined && (!TRACE_REVIEW_DIMENSIONS.has(dimension)
          || item.evidence.some(evidence => evidence.eventSeq !== null))
        return substantive && traceGrounded ? [review.reviewerId] : []
      }))
      if (substantiveReviewers.size < 2) {
        issues.push(`dimension ${dimension} requires two independent substantive reviews`)
      }
    }
  }
  return { pass: issues.length === 0, issues }
}

export interface EvaluationReviewDisagreementResolution {
  dimension: EvaluationReviewDimension
  reviewIds: string[]
  overallReviewIds?: string[]
  disposition: 'resolved' | 'retained'
  rationale: string
}

const HARD_REVIEW_FAILURE_DIMENSIONS = new Set<EvaluationReviewDimension>([
  'research-correctness',
  'claim-support-fidelity',
  'source-quality-independence',
  'coverage-contradiction-handling',
  'insight-defensibility',
  'synthesis-usefulness',
  'anti-summary',
  'argument-skeleton-quality',
  'final-prose-quality',
  'provenance-completeness',
  'steering-retention',
  'checkpoint-usefulness',
  'stop-resume-durability',
  'knowledge-reuse',
  'completion-reliability',
])

/** Apply the human-review policy that authorizes a production baseline promotion. */
export function analyzeEvaluationReviewsForPromotion(
  scenario: EvaluationScenario,
  reviews: readonly EvaluationReview[],
  mapping: { A: string; B: string },
  resolutions: readonly EvaluationReviewDisagreementResolution[],
): { pass: boolean; issues: string[] } {
  const issues: string[] = []
  const ravenCondition = scenario.kind === 'ablation' ? 'raven-multi' : 'raven'
  const ravenAlias = mapping.A === ravenCondition ? 'A' : mapping.B === ravenCondition ? 'B' : undefined
  if (ravenAlias === undefined || mapping.A === mapping.B) {
    return { pass: false, issues: ['unblinding mapping does not identify the required Raven condition'] }
  }
  const resolutionByDimension = new Map<EvaluationReviewDimension, EvaluationReviewDisagreementResolution>()
  for (const resolution of resolutions) {
    if (resolutionByDimension.has(resolution.dimension)) {
      issues.push(`dimension ${resolution.dimension} has duplicate disagreement resolutions`)
    }
    resolutionByDimension.set(resolution.dimension, resolution)
  }
  for (const dimension of scenario.reviewDimensions) {
    const judgments = reviews.flatMap((review) => {
      const judgment = review.dimensions.find(item => item.dimension === dimension)
      return judgment === undefined ? [] : [{ review, judgment }]
    })
    const substantive = judgments.filter(({ judgment }) => judgment.A !== 'n/a' && judgment.B !== 'n/a')
    let retainedConcern = false
    let retainedFailure = false
    let retainedNegativePreference = false
    for (const { review, judgment } of judgments) {
      const ravenStatus = judgment[ravenAlias]
      const otherAlias = ravenAlias === 'A' ? 'B' : 'A'
      if ((judgment.A === 'n/a') !== (judgment.B === 'n/a')) {
        issues.push(`review ${review.reviewId} uses asymmetric n/a for ${dimension}`)
      }
      if (ravenStatus === 'fail') {
        if (HARD_REVIEW_FAILURE_DIMENSIONS.has(dimension)) {
          issues.push(`review ${review.reviewId} gives Raven a hard failure for ${dimension}`)
        } else retainedFailure = true
      }
      if (ravenStatus === 'concern') retainedConcern = true
      if (judgment.preference === otherAlias) retainedNegativePreference = true
    }
    const tuples = new Set(substantive.map(({ judgment }) => JSON.stringify([
      judgment.A, judgment.B, judgment.preference,
    ])))
    const resolution = resolutionByDimension.get(dimension)
    if ((tuples.size > 1 || retainedConcern || retainedFailure || retainedNegativePreference) && resolution === undefined) {
      issues.push(`dimension ${dimension} has an unresolved disagreement, retainable Raven failure/concern, or preference against Raven`)
      continue
    }
    if (resolution !== undefined) {
      const reviewIds = substantive.map(({ review }) => review.reviewId).sort()
      if (!equalSets([...resolution.reviewIds].sort(), reviewIds)) {
        issues.push(`dimension ${dimension} resolution names the wrong reviews`)
      }
      if (resolution.rationale.trim() === '') issues.push(`dimension ${dimension} resolution requires a rationale`)
      if ((retainedConcern || retainedFailure || retainedNegativePreference) && resolution.disposition !== 'retained') {
        issues.push(`dimension ${dimension} Raven failure, concern, or negative preference must be explicitly retained`)
      }
      if (tuples.size <= 1 && !retainedConcern && !retainedFailure && !retainedNegativePreference
        && (resolution.overallReviewIds?.length ?? 0) === 0) {
        issues.push(`dimension ${dimension} has a resolution without a disagreement or retainable Raven judgment`)
      }
    }
  }
  const otherAlias = ravenAlias === 'A' ? 'B' : 'A'
  const adverseOverallReviewIds = new Set(reviews
    .filter(review => review.overallPreference === otherAlias)
    .map(review => review.reviewId))
  const boundOverallReviewIds = new Set<string>()
  for (const resolution of resolutions) {
    if (!scenario.reviewDimensions.includes(resolution.dimension)) {
      issues.push(`disagreement resolution names unknown dimension ${resolution.dimension}`)
    }
    for (const reviewId of resolution.overallReviewIds ?? []) {
      if (!adverseOverallReviewIds.has(reviewId)) {
        issues.push(`disagreement resolution names a non-adverse overall review ${reviewId}`)
      }
      if (boundOverallReviewIds.has(reviewId)) {
        issues.push(`overall review ${reviewId} has duplicate disagreement resolutions`)
      }
      if (resolution.disposition !== 'retained' || resolution.rationale.trim() === '') {
        issues.push(`overall review ${reviewId} requires an explicit retained resolution with rationale`)
      } else {
        boundOverallReviewIds.add(reviewId)
      }
    }
  }
  for (const reviewId of adverseOverallReviewIds) {
    if (!boundOverallReviewIds.has(reviewId)) {
      issues.push(`review ${reviewId} has an unretained overall preference against Raven`)
    }
  }
  return { pass: issues.length === 0, issues }
}

function equalSets(left: readonly string[], right: readonly string[]): boolean {
  return new Set(left).size === left.length && new Set(right).size === right.length
    && left.length === right.length && left.every(item => right.includes(item))
}

/** Strict assessor catalog decoder; this content is never included in model input. */
export function decodeEvaluationAssessorCatalog(value: unknown): EvaluationAssessorCatalog | undefined {
  try {
    const root = strictRecord(value, ['schemaVersion', 'notice', 'facts', 'contradictions', 'canary'], 'assessor catalog')
    if (root.schemaVersion !== EVALUATION_SCHEMA_VERSION) throw new TypeError('unsupported assessor catalog version')
    if (!Array.isArray(root.facts) || root.facts.length === 0) throw new TypeError('assessor facts must be non-empty')
    const facts = root.facts.map((raw, index) => {
      const item = strictRecord(raw, ['id', 'statement', 'sourceIds'], `assessor facts[${index}]`)
      const id = text(item.id, 'fact.id')
      if (!SAFE_ID.test(id)) throw new TypeError('fact.id is unsafe')
      return { id, statement: text(item.statement, 'fact.statement'), sourceIds: uniqueTexts(item.sourceIds, 'fact.sourceIds') }
    })
    if (new Set(facts.map(fact => fact.id)).size !== facts.length) throw new TypeError('assessor fact ids are not unique')
    if (!Array.isArray(root.contradictions)) throw new TypeError('assessor contradictions must be an array')
    const contradictions = root.contradictions.map((raw, index) => {
      const item = strictRecord(raw, ['id', 'factIds', 'handlingRule'], `assessor contradictions[${index}]`)
      const id = text(item.id, 'contradiction.id')
      if (!SAFE_ID.test(id)) throw new TypeError('contradiction.id is unsafe')
      return {
        id,
        factIds: uniqueTexts(item.factIds, 'contradiction.factIds', false),
        handlingRule: text(item.handlingRule, 'contradiction.handlingRule'),
      }
    })
    if (new Set(contradictions.map(item => item.id)).size !== contradictions.length) {
      throw new TypeError('assessor contradiction ids are not unique')
    }
    const canaryRecord = strictRecord(root.canary, ['exactForbiddenArtifactQuote', 'rule'], 'assessor canary')
    return {
      schemaVersion: EVALUATION_SCHEMA_VERSION,
      notice: text(root.notice, 'assessor notice'),
      facts,
      contradictions,
      canary: {
        exactForbiddenArtifactQuote: text(canaryRecord.exactForbiddenArtifactQuote, 'assessor canary quote'),
        rule: text(canaryRecord.rule, 'assessor canary rule'),
      },
    }
  } catch {
    return undefined
  }
}

export interface EvaluationSuiteCheck {
  pass: boolean
  issues: string[]
  suiteSha256: string
  scenarioIds: string[]
  workflows: EvaluationWorkflow[]
  reviewDimensions: EvaluationReviewDimension[]
}

async function evaluationFixtureBytes(evaluationRoot: string, path: string): Promise<Buffer> {
  const fixturesRoot = resolve(evaluationRoot, 'fixtures')
  const full = resolve(evaluationRoot, path)
  const fromFixtures = relative(fixturesRoot, full)
  if (fromFixtures === '' || fromFixtures.startsWith('..') || isAbsolute(fromFixtures)) {
    throw new Error(`fixture path must stay under evaluation/fixtures: ${path}`)
  }
  const metadata = await lstat(full)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`fixture must be a regular non-symlink file: ${path}`)
  }
  const [realFixturesRoot, realFile] = await Promise.all([realpath(fixturesRoot), realpath(full)])
  const realRelative = relative(realFixturesRoot, realFile)
  if (realRelative === '' || realRelative.startsWith('..') || isAbsolute(realRelative)) {
    throw new Error(`fixture resolves outside evaluation/fixtures: ${path}`)
  }
  return readFile(full)
}

export async function evaluationSourceSnapshotSha256(
  evaluationRoot: string,
  scenario: EvaluationScenario,
): Promise<string> {
  const entries = await Promise.all([...new Set(scenario.sources.map(source => source.path))].sort().map(async path => [
    path,
    sha256(await evaluationFixtureBytes(evaluationRoot, path)),
  ] as const))
  return sha256(Buffer.from(entries.map(([path, digest]) => `${path}\0${digest}`).join('\n')))
}

/** Hash the methodology, rubric, assessor catalog, scenario manifests, and exact referenced Source bytes. */
export async function evaluationSuiteSha256(evaluationRoot: string): Promise<string> {
  const paths = new Set(['README.md', 'rubric.md', 'assessor-facts.json'])
  const scenarioFiles = (await readdir(resolve(evaluationRoot, 'scenarios')))
    .filter(file => file.endsWith('.json'))
    .sort()
  for (const file of scenarioFiles) {
    const scenarioPath = `scenarios/${file}`
    paths.add(scenarioPath)
    const scenario = decodeEvaluationScenario(JSON.parse(await readFile(resolve(evaluationRoot, scenarioPath), 'utf8')))
    if (scenario === undefined) throw new Error(`cannot hash invalid scenario ${file}`)
    for (const source of scenario.sources) paths.add(source.path.replaceAll('\\', '/'))
  }
  const entries: string[] = []
  for (const path of [...paths].sort()) {
    const bytes = path.startsWith('fixtures/')
      ? await evaluationFixtureBytes(evaluationRoot, path)
      : await readFile(resolve(evaluationRoot, path))
    entries.push(`${path}\0sha256:${createHash('sha256').update(bytes).digest('hex')}`)
  }
  return `sha256:${createHash('sha256').update(entries.join('\n')).digest('hex')}`
}

/** Validate every tracked scenario plus its frozen Source bytes. */
export async function checkEvaluationSuite(evaluationRoot: string): Promise<EvaluationSuiteCheck> {
  const issues: string[] = []
  const scenarios: EvaluationScenario[] = []
  let catalog: EvaluationAssessorCatalog | undefined
  try {
    catalog = decodeEvaluationAssessorCatalog(JSON.parse(
      await readFile(resolve(evaluationRoot, 'assessor-facts.json'), 'utf8'),
    ))
    if (catalog === undefined) issues.push('evaluation/assessor-facts.json violates schema v1')
  } catch {
    issues.push('evaluation/assessor-facts.json is missing or invalid JSON')
  }
  let files: string[] = []
  try {
    files = (await readdir(resolve(evaluationRoot, 'scenarios')))
      .filter(file => file.endsWith('.json'))
      .sort()
  } catch {
    issues.push('evaluation/scenarios is missing or unreadable')
  }
  for (const file of files) {
    const path = resolve(evaluationRoot, 'scenarios', file)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      issues.push(`scenario manifest is not valid JSON: ${file}`)
      continue
    }
    const scenario = decodeEvaluationScenario(parsed)
    if (scenario === undefined) {
      issues.push(`scenario manifest violates schema v1: ${file}`)
      continue
    }
    if (file !== `${scenario.id}.json`) issues.push(`scenario filename must match its id: ${file}`)
    scenarios.push(scenario)
  }
  const ids = scenarios.map(scenario => scenario.id)
  if (new Set(ids).size !== ids.length) issues.push('scenario ids are not unique')
  for (const required of CORE_EVALUATION_SCENARIO_IDS) {
    if (!ids.includes(required)) issues.push(`missing core scenario: ${required}`)
  }
  if (catalog !== undefined) {
    const factIds = new Set(catalog.facts.map(fact => fact.id))
    const contradictionIds = new Set(catalog.contradictions.map(item => item.id))
    const sourceIds = new Set(scenarios.flatMap(scenario => scenario.sources.map(source => source.id)))
    for (const fact of catalog.facts) {
      for (const sourceId of fact.sourceIds) {
        if (!sourceIds.has(sourceId)) issues.push(`assessor fact ${fact.id} references unknown source: ${sourceId}`)
      }
    }
    for (const contradiction of catalog.contradictions) {
      for (const factId of contradiction.factIds) {
        if (!factIds.has(factId)) issues.push(`assessor contradiction ${contradiction.id} references unknown fact: ${factId}`)
      }
    }
    for (const scenario of scenarios) {
      const scenarioSourceIds = new Set(scenario.sources.map(source => source.id))
      for (const factId of scenario.expectations.requiredFactIds) {
        const fact = catalog.facts.find(candidate => candidate.id === factId)
        if (fact === undefined) issues.push(`scenario ${scenario.id} requires unknown assessor fact: ${factId}`)
        else if (fact.sourceIds.length > 0 && !fact.sourceIds.some(sourceId => scenarioSourceIds.has(sourceId))) {
          issues.push(`scenario ${scenario.id} assessor fact ${factId} has no Source in that scenario`)
        }
      }
      for (const contradictionId of scenario.expectations.contradictionIds) {
        if (!contradictionIds.has(contradictionId)) {
          issues.push(`scenario ${scenario.id} requires unknown assessor contradiction: ${contradictionId}`)
        }
      }
    }
    if (!scenarios.some(scenario =>
      scenario.expectations.forbiddenArtifactQuotes.includes(catalog.canary.exactForbiddenArtifactQuote))) {
      issues.push('suite does not exercise the assessor catalog canary')
    }
  }
  const pathDigests = new Map<string, string>()
  for (const scenario of scenarios) {
    for (const source of scenario.sources) {
      const previous = pathDigests.get(source.path)
      if (previous !== undefined && previous !== source.sha256) {
        issues.push(`fixture path has conflicting digests: ${source.path}`)
      }
      pathDigests.set(source.path, source.sha256)
    }
  }
  for (const [path, expectedSha256] of pathDigests) {
    try {
      const bytes = await evaluationFixtureBytes(evaluationRoot, path)
      const actualSha256 = sha256(bytes)
      if (actualSha256 !== expectedSha256) {
        issues.push(`fixture ${path} digest mismatch: expected ${expectedSha256}, got ${actualSha256}`)
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error))
    }
  }
  const workflows = EVALUATION_WORKFLOWS.filter(workflow =>
    scenarios.some(scenario => scenario.workflow.includes(workflow)))
  const reviewDimensions = EVALUATION_REVIEW_DIMENSIONS.filter(dimension =>
    scenarios.some(scenario => scenario.reviewDimensions.includes(dimension)))
  for (const workflow of EVALUATION_WORKFLOWS) {
    if (!workflows.includes(workflow)) issues.push(`suite does not cover workflow: ${workflow}`)
  }
  for (const dimension of EVALUATION_REVIEW_DIMENSIONS) {
    if (!reviewDimensions.includes(dimension)) issues.push(`suite does not review dimension: ${dimension}`)
  }
  if (!scenarios.some(scenario => scenario.expectations.forbiddenArtifactQuotes.length > 0)) {
    issues.push('suite has no planted undeclared-assertion canary')
  }
  if (!scenarios.some(scenario => scenario.expectations.requireStopResume)) issues.push('suite does not require stop/resume')
  if (!scenarios.some(scenario => scenario.expectations.requireKnowledgeReuse)) issues.push('suite does not require knowledge reuse')
  if (!scenarios.some(scenario => scenario.expectations.requireStructureChoice)) issues.push('suite does not require structure choice')
  const multi = scenarios.find(scenario => scenario.id === 'multi-model-drafting')
  if (multi !== undefined && (multi.kind !== 'ablation' || !multi.expectations.requireMultiModelDraft)) {
    issues.push('multi-model-drafting must be an explicit Raven ablation with multi-model evidence required')
  }
  let suiteSha256 = `sha256:${'0'.repeat(64)}`
  try {
    suiteSha256 = await evaluationSuiteSha256(evaluationRoot)
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error))
  }
  return {
    pass: issues.length === 0,
    issues,
    suiteSha256,
    scenarioIds: CORE_EVALUATION_SCENARIO_IDS.filter(id => ids.includes(id)),
    workflows,
    reviewDimensions,
  }
}

export interface EvaluationEnvironment {
  ravenCommit: string
  ravenDirty: boolean
  harnessVersion: string
  harnessCommit: string
  harnessDirty: boolean
  nodeVersion: string
  platform: string
  arch: string
  provider: string
  model: string
  reasoningEffort: string | null
  maxTokens: number
  availableModelRoutes: string[]
  basePreset: string
  baseCompositionSha256: string
  baseTools: string[]
  baseToolSchemasSha256: string
  basePromptSectionsSha256: string
  sandboxMode: string
  approvalPolicy: string
  networkPolicy: string
  sourceSnapshotSha256: string
  workspaceSnapshotSha256: string
  inputsSha256: string
}

export interface EvaluationRun {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION
  runId: string
  scenarioId: string
  condition: EvaluationCondition
  environment: EvaluationEnvironment
  startedAt: string
  completedAt: string
  terminalStatus: 'completed' | 'completed-with-limits' | 'failed' | 'cancelled'
  transcript: { path: string; sha256: string }
  artifact: { path: string; sha256: string }
  claims: Array<{
    /** Assessor-side fact identity; the model is never asked to emit this ID. */
    factId: string
    artifactQuote: string
    sourceIds: string[]
    support: Array<{ sourceId: string; excerpt: string }>
  }>
  contradictions: Array<{ id: string; factIds: string[]; handled: boolean }>
  citations: Array<{ sourceId: string; artifactQuote: string }>
  checkpoints: Array<{ artifactPath: string; sha256: string; at: string }>
  lifecycle: {
    sessionIds: string[]
    taskIds: string[]
    processGenerationIds: string[]
    stopEventSeq: number | null
    resumeEventSeq: number | null
    preservedStateSha256BeforeStop: string | null
    preservedStateSha256AfterResume: string | null
  }
  knowledgeUses: Array<{
    path: string
    producerTaskId: string
    consumerTaskId: string
    eventSeq: number
    freshness: 'stored' | 'freshly-reopened'
  }>
  structure: { candidateCount: number; selected: boolean }
  drafting: { routes: string[]; modelCallCount: number }
  usage: EvaluationUsage
}

export interface EvaluationPair {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION
  pairId: string
  scenarioId: string
  vanilla: EvaluationRun
  raven: EvaluationRun
}

export interface EvaluationUsage {
  /** Provider-reported uncached input; null when the adapter supplied no exact usage. */
  uncachedInputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  reasoningTokens: number | null
  modelCalls: number | null
  toolCalls: number | null
  ptcNestedCalls: number | null
  searchCalls: number | null
  fetchCalls: number | null
  durationMs: number | null
}

interface CountCheck {
  found: number
  required: number
}

interface AutomatedChecks {
  completion: boolean
  claimCoverage: CountCheck
  contradictionHandling: CountCheck
  independentSourceFamilies: CountCheck
  progressiveCheckpoints: CountCheck
  citationFidelity: { pass: boolean; checked: number; issues: string[] }
  stopResume: {
    pass: boolean
    required: boolean
    stopped: boolean
    resumed: boolean
    processRestarted: boolean
    stableIdentity: boolean
    preservedState: boolean
  }
  knowledgeReuse: { pass: boolean; required: boolean; found: number }
  structureChoice: { pass: boolean; required: boolean; candidateCount: number; selected: boolean }
  multiModelDraft: { pass: boolean; required: boolean; routes: number; modelCalls: number }
}

interface ConditionReport {
  automated: AutomatedChecks
  pass: boolean
}

export interface EvaluationReport {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION
  pairId: string
  scenarioId: string
  /** Whether the pair is methodologically comparable; quality failures remain valid evidence. */
  valid: boolean
  /** Whether Raven meets this scenario's documented automated release floor. */
  baselinePass: boolean
  evidence: {
    status: 'unchecked' | 'verified'
    pass: boolean
    issues: string[]
  }
  fairness: {
    pass: boolean
    differences: Array<{ field: string; vanilla: unknown; raven: unknown }>
  }
  conditions: Record<EvaluationCondition, ConditionReport>
  costDelta: EvaluationUsage
  review: {
    status: 'required'
    missingDimensions: string[]
  }
}

export interface EvaluationEvidenceRoots {
  scenarioRoot: string
  pairRoot: string
}

export interface EvaluationEvidenceResult {
  pass: boolean
  issues: string[]
}

function confinedPath(root: string, path: string): string | undefined {
  const full = resolve(root, path)
  const fromRoot = relative(resolve(root), full)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot)) ? full : undefined
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function readEvidence(
  root: string,
  path: string,
  expectedSha256: string,
  label: string,
  issues: string[],
): Promise<string | undefined> {
  const full = confinedPath(root, path)
  if (full === undefined) {
    issues.push(`${label} escapes its evidence root: ${path}`)
    return undefined
  }
  let bytes: Buffer
  try {
    const info = await lstat(full)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('not a regular no-follow file')
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(full)])
    const fromRealRoot = relative(realRoot, realFile)
    if (fromRealRoot.startsWith('..') || isAbsolute(fromRealRoot)) throw new Error('resolved outside evidence root')
    bytes = await readFile(realFile)
  } catch {
    issues.push(`${label} is missing or unsafe: ${path}`)
    return undefined
  }
  const actual = sha256(bytes)
  if (actual !== expectedSha256) {
    issues.push(`${label} digest mismatch: expected ${expectedSha256}, got ${actual}`)
    return undefined
  }
  return bytes.toString('utf8')
}

/** Verify the immutable evidence files an annotated pair cites; annotations never replace the bytes. */
export async function verifyPairEvidence(
  scenario: EvaluationScenario,
  pair: EvaluationPair,
  roots: EvaluationEvidenceRoots,
): Promise<EvaluationEvidenceResult> {
  const issues: string[] = []
  const sourceTexts = new Map<string, string>()
  for (const source of scenario.sources) {
    if (sourceTexts.has(source.id)) {
      issues.push(`scenario has duplicate source id: ${source.id}`)
      continue
    }
    const text = await readEvidence(
      roots.scenarioRoot,
      source.path,
      source.sha256,
      `source ${source.id}`,
      issues,
    )
    if (text !== undefined) sourceTexts.set(source.id, text)
  }

  for (const condition of ['vanilla', 'raven'] as const) {
    const run = pair[condition]
    const artifact = await readEvidence(
      roots.pairRoot,
      run.artifact.path,
      run.artifact.sha256,
      `${condition} artifact`,
      issues,
    )
    await readEvidence(
      roots.pairRoot,
      run.transcript.path,
      run.transcript.sha256,
      `${condition} transcript`,
      issues,
    )
    const startedAt = Date.parse(run.startedAt)
    const completedAt = Date.parse(run.completedAt)
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
      issues.push(`${condition} run timestamps are invalid`)
    }
    let previousCheckpointAt = startedAt
    for (const [index, checkpoint] of run.checkpoints.entries()) {
      await readEvidence(
        roots.pairRoot,
        checkpoint.artifactPath,
        checkpoint.sha256,
        `${condition} checkpoint ${index + 1}`,
        issues,
      )
      const checkpointAt = Date.parse(checkpoint.at)
      if (!Number.isFinite(checkpointAt)) issues.push(`${condition} checkpoint ${index + 1} timestamp is invalid`)
      else {
        if (checkpointAt < previousCheckpointAt) issues.push(`${condition} checkpoint ${index + 1} is out of order`)
        if (Number.isFinite(completedAt) && checkpointAt >= completedAt) {
          issues.push(`${condition} checkpoint ${index + 1} is not earlier than run completion`)
        }
        previousCheckpointAt = checkpointAt
      }
    }
    if (artifact === undefined) continue
    for (const canary of scenario.expectations.forbiddenArtifactQuotes) {
      if (artifact.includes(canary)) issues.push(`${condition} artifact contains forbidden canary: ${canary}`)
    }
    for (const citation of run.citations) {
      if (!artifact.includes(citation.artifactQuote)) {
        issues.push(`${condition} citation quote is absent from the preserved artifact: ${citation.sourceId}`)
      }
    }
    for (const claim of run.claims) {
      if (!artifact.includes(claim.artifactQuote)) {
        issues.push(`${condition} claim ${claim.factId} quote is absent from the preserved artifact`)
      }
      for (const support of claim.support) {
        const source = sourceTexts.get(support.sourceId)
        if (source !== undefined && !source.includes(support.excerpt)) {
          issues.push(`${condition} claim ${claim.factId} support excerpt is absent from ${support.sourceId}`)
        }
      }
    }
  }
  return { pass: issues.length === 0, issues }
}

const FAIRNESS_FIELDS = [
  'ravenCommit',
  'ravenDirty',
  'harnessVersion',
  'harnessCommit',
  'harnessDirty',
  'nodeVersion',
  'platform',
  'arch',
  'provider',
  'model',
  'reasoningEffort',
  'maxTokens',
  'availableModelRoutes',
  'basePreset',
  'baseCompositionSha256',
  'baseTools',
  'baseToolSchemasSha256',
  'basePromptSectionsSha256',
  'sandboxMode',
  'approvalPolicy',
  'networkPolicy',
  'sourceSnapshotSha256',
  'workspaceSnapshotSha256',
  'inputsSha256',
] as const satisfies readonly (keyof EvaluationEnvironment)[]

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function fairness(pair: EvaluationPair): EvaluationReport['fairness'] {
  const differences = FAIRNESS_FIELDS.flatMap((field) => {
    const vanilla = pair.vanilla.environment[field]
    const raven = pair.raven.environment[field]
    return equal(vanilla, raven) ? [] : [{ field, vanilla, raven }]
  })
  return { pass: differences.length === 0, differences }
}

function count(found: number, required: number): CountCheck {
  return { found, required }
}

function evaluateCondition(scenario: EvaluationScenario, run: EvaluationRun): ConditionReport {
  const sourceById = new Map(scenario.sources.map(source => [source.id, source]))
  const citationIssues: string[] = []
  for (const citation of run.citations) {
    if (!sourceById.has(citation.sourceId)) {
      citationIssues.push(`citation references source outside the scenario corpus: ${citation.sourceId}`)
    }
  }
  for (const claim of run.claims) {
    for (const sourceId of claim.sourceIds) {
      if (!sourceById.has(sourceId)) citationIssues.push(`claim ${claim.factId} references source outside the scenario corpus: ${sourceId}`)
    }
    for (const support of claim.support) {
      if (!sourceById.has(support.sourceId)) citationIssues.push(`claim ${claim.factId} support references source outside the scenario corpus: ${support.sourceId}`)
      if (!claim.sourceIds.includes(support.sourceId)) citationIssues.push(`claim ${claim.factId} support is not named in sourceIds: ${support.sourceId}`)
    }
  }

  const factIds = new Set(run.claims.map(claim => claim.factId))
  const coveredClaims = scenario.expectations.requiredFactIds.filter(id => factIds.has(id)).length
  const handledContradictions = new Set(run.contradictions.filter(item => item.handled).map(item => item.id))
  const coveredContradictions = scenario.expectations.contradictionIds.filter(id => handledContradictions.has(id)).length
  const citedFamilies = new Set(run.citations
    .map(citation => sourceById.get(citation.sourceId)?.family)
    .filter((family): family is string => typeof family === 'string'))
  const taskIds = new Set(run.lifecycle.taskIds)
  const sessionIds = new Set(run.lifecycle.sessionIds)
  const stableIdentity = taskIds.size === 1 && sessionIds.size === 1
  const stopped = run.lifecycle.stopEventSeq !== null
  const resumed = run.lifecycle.resumeEventSeq !== null
    && (run.lifecycle.stopEventSeq === null || run.lifecycle.resumeEventSeq > run.lifecycle.stopEventSeq)
  const processRestarted = new Set(run.lifecycle.processGenerationIds).size >= 2
  const preservedState = run.lifecycle.preservedStateSha256BeforeStop !== null
    && run.lifecycle.preservedStateSha256BeforeStop === run.lifecycle.preservedStateSha256AfterResume
  const stopResumePass = !scenario.expectations.requireStopResume
    || (stopped && resumed && processRestarted && stableIdentity && preservedState)
  const validKnowledgeUses = run.knowledgeUses.filter(use => use.producerTaskId !== use.consumerTaskId)
  const knowledgeReusePass = !scenario.expectations.requireKnowledgeReuse || validKnowledgeUses.length > 0
  const structurePass = !scenario.expectations.requireStructureChoice
    || (run.structure.candidateCount >= 2 && run.structure.selected)
  const multiModelPass = !scenario.expectations.requireMultiModelDraft
    || (new Set(run.drafting.routes).size >= 2 && run.drafting.modelCallCount >= 2)
  const automated: AutomatedChecks = {
    completion: scenario.expectations.allowedTerminalStatuses.includes(run.terminalStatus),
    claimCoverage: count(coveredClaims, scenario.expectations.requiredFactIds.length),
    contradictionHandling: count(coveredContradictions, scenario.expectations.contradictionIds.length),
    independentSourceFamilies: count(citedFamilies.size, scenario.expectations.minimumIndependentSourceFamilies),
    progressiveCheckpoints: count(run.checkpoints.length, scenario.expectations.minimumCheckpoints),
    citationFidelity: { pass: citationIssues.length === 0, checked: run.citations.length, issues: citationIssues },
    stopResume: {
      pass: stopResumePass,
      required: scenario.expectations.requireStopResume,
      stopped,
      resumed,
      processRestarted,
      stableIdentity,
      preservedState,
    },
    knowledgeReuse: {
      pass: knowledgeReusePass,
      required: scenario.expectations.requireKnowledgeReuse,
      found: validKnowledgeUses.length,
    },
    structureChoice: {
      pass: structurePass,
      required: scenario.expectations.requireStructureChoice,
      candidateCount: run.structure.candidateCount,
      selected: run.structure.selected,
    },
    multiModelDraft: {
      pass: multiModelPass,
      required: scenario.expectations.requireMultiModelDraft,
      routes: new Set(run.drafting.routes).size,
      modelCalls: run.drafting.modelCallCount,
    },
  }
  const pass = automated.completion
    && automated.claimCoverage.found >= automated.claimCoverage.required
    && automated.contradictionHandling.found >= automated.contradictionHandling.required
    && automated.independentSourceFamilies.found >= automated.independentSourceFamilies.required
    && automated.progressiveCheckpoints.found >= automated.progressiveCheckpoints.required
    && automated.citationFidelity.pass
    && automated.stopResume.pass
    && automated.knowledgeReuse.pass
    && automated.structureChoice.pass
    && automated.multiModelDraft.pass
  return { automated, pass }
}

function metricDelta(vanilla: number | null, raven: number | null): number | null {
  return vanilla === null || raven === null ? null : raven - vanilla
}

function usageDelta(vanilla: EvaluationUsage, raven: EvaluationUsage): EvaluationUsage {
  return {
    uncachedInputTokens: metricDelta(vanilla.uncachedInputTokens, raven.uncachedInputTokens),
    cacheReadTokens: metricDelta(vanilla.cacheReadTokens, raven.cacheReadTokens),
    cacheWriteTokens: metricDelta(vanilla.cacheWriteTokens, raven.cacheWriteTokens),
    outputTokens: metricDelta(vanilla.outputTokens, raven.outputTokens),
    totalTokens: metricDelta(vanilla.totalTokens, raven.totalTokens),
    reasoningTokens: metricDelta(vanilla.reasoningTokens, raven.reasoningTokens),
    modelCalls: metricDelta(vanilla.modelCalls, raven.modelCalls),
    toolCalls: metricDelta(vanilla.toolCalls, raven.toolCalls),
    ptcNestedCalls: metricDelta(vanilla.ptcNestedCalls, raven.ptcNestedCalls),
    searchCalls: metricDelta(vanilla.searchCalls, raven.searchCalls),
    fetchCalls: metricDelta(vanilla.fetchCalls, raven.fetchCalls),
    durationMs: metricDelta(vanilla.durationMs, raven.durationMs),
  }
}

function evaluate(
  scenario: EvaluationScenario,
  pair: EvaluationPair,
  evidence: EvaluationReport['evidence'],
): EvaluationReport {
  const fair = fairness(pair)
  const vanilla = evaluateCondition(scenario, pair.vanilla)
  const raven = evaluateCondition(scenario, pair.raven)
  const identitiesMatch = pair.scenarioId === scenario.id
    && pair.vanilla.scenarioId === scenario.id
    && pair.raven.scenarioId === scenario.id
    && pair.vanilla.condition === 'vanilla'
    && pair.raven.condition === 'raven'
  const valid = identitiesMatch && fair.pass && evidence.pass
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    pairId: pair.pairId,
    scenarioId: scenario.id,
    valid,
    baselinePass: valid && raven.pass,
    evidence,
    fairness: fair,
    conditions: { vanilla, raven },
    costDelta: usageDelta(pair.vanilla.usage, pair.raven.usage),
    review: { status: 'required', missingDimensions: [...scenario.reviewDimensions] },
  }
}

/** Annotation-only projection for unit checks; it is deliberately never a valid release gate. */
export function evaluatePair(scenario: EvaluationScenario, pair: EvaluationPair): EvaluationReport {
  return evaluate(scenario, pair, {
    status: 'unchecked',
    pass: false,
    issues: ['evidence files were not verified'],
  })
}

/** The only release-gate entry: verify preserved bytes before evaluating annotations. */
export async function evaluatePairFromEvidence(
  scenario: EvaluationScenario,
  pair: EvaluationPair,
  roots: EvaluationEvidenceRoots,
): Promise<EvaluationReport> {
  const evidence = await verifyPairEvidence(scenario, pair, roots)
  return evaluate(scenario, pair, { status: 'verified', ...evidence })
}
