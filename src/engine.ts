import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { settleWithAbort } from './abort.js'
import { canonicalSourceUrl, sameSourceIdentity } from './url.js'
import { layoutProse, proseLayoutReport, type ProseLayoutOptions, type ProseLayoutReport } from './prose.js'
import { formatDraftRoute } from './route.js'
import { sourceInspectionSha256 } from './source.js'
import { renderWikiPages } from './wiki.js'

import {
  CLAIM_DISPOSITIONS,
  CLAIM_IMPORTANCE,
  CLAIM_KINDS,
  EMPTY_SOURCE_POLICY,
  GROUNDING_POLICIES,
  LIMITATION_KINDS,
  OUTCOMES,
  RAVEN_LIMITS,
  RAVEN_STAGES,
  SOURCE_ORIGINS,
  SOURCE_ROLES,
  type ClaimDisposition,
  type ClaimImportance,
  type ClaimKind,
  type DraftGenerator,
  type DraftResult,
  type GroundingPolicy,
  type LeadSearchResult,
  type RavenCheckpointRecord,
  type RavenClaimRecord,
  RavenError,
  RavenTypeError,
  type RavenDispatchResult,
  type RavenDraftRoute,
  type RavenExecution,
  type RavenLimitation,
  type RavenLimitationKind,
  type RavenOutcome,
  type RavenSourceCheck,
  type RavenSourcePolicy,
  type RavenSourceRecord,
  type RavenSourceRepresentation,
  type RavenSourceResource,
  type RavenStage,
  type RavenTaskState,
  type RavenVerificationReceipt,
  type SourceCheckResult,
  type SourceOrigin,
  type SourceRole,
  type SourceSearcher,
  type SourceVerifier,
} from './domain.js'

/** Deployment-owned discovery bounds, read per call so a settings change needs no restart. */
export interface RavenSearchLimits {
  readonly maxQueries: number
  readonly maxResults: number
}

/** Deployment-owned drafting bounds, read per call for the same reason. */
export interface RavenDraftLimits {
  readonly maxTokens: number
  /**
   * Every route a Draft Variant may be requested from. The deployment owns this
   * list, not the agent: naming a model is naming money and a data path, so the
   * agent may only select a subset of what a deployment already allowed.
   */
  readonly routes: readonly RavenDraftRoute[]
}

interface RavenEngineOptions {
  readonly now: () => string
  readonly sourceVerifier: SourceVerifier
  /** Omitted where the embedder composes no discovery: `discover` then reports the absence instead of failing. */
  readonly sourceSearcher?: SourceSearcher
  readonly searchLimits?: () => RavenSearchLimits
  /** Omitted where the embedder composes no model access: `draft` reports the absence. */
  readonly draftGenerator?: DraftGenerator
  readonly draftLimits?: () => RavenDraftLimits
  /**
   * The Prose Layout every stored Artifact is normalized into. Read per call so
   * a settings change takes effect on the next Checkpoint with nothing to migrate.
   */
  readonly proseLayout?: () => ProseLayoutOptions
}

const NO_SEARCHER: SourceSearcher = {
  search: () => Promise.resolve({
    leads: [],
    failures: [],
    truncated: false,
    notes: [],
    unavailable: 'this Raven deployment composed no Lead discovery seam',
  }),
}

const NO_DRAFTER: DraftGenerator = {
  generate: () => Promise.resolve({
    variants: [],
    unavailable: 'this Raven deployment composed no model access for Draft Variants',
  }),
}

const DEFAULT_SEARCH_LIMITS: RavenSearchLimits = {
  maxQueries: RAVEN_LIMITS.searchQueries,
  maxResults: RAVEN_LIMITS.searchResults,
}

const DEFAULT_DRAFT_LIMITS: RavenDraftLimits = { maxTokens: 4_000, routes: [] }

const DEFAULT_PROSE_LAYOUT: ProseLayoutOptions = { layout: 'sentence-per-line', format: 'markdown' }

interface RavenEngine {
  dispatch(
    previous: RavenTaskState | null,
    input: unknown,
    execution: RavenExecution,
  ): Promise<RavenDispatchResult>
}

/**
 * The exact field set each action accepts. This is the single source of truth
 * for both halves of the boundary: the runtime rejects anything outside it, and
 * the model-facing parameter schema derives its per-action guidance from it. A
 * flat schema that advertises every action's fields at once invites a caller to
 * send one action's field to another, so the two must never drift apart.
 */
export const ACTION_FIELDS: Record<string, readonly string[]> = {
  start: ['action', 'outcome', 'request', 'grounding', 'sourcePolicy'],
  discover: ['action', 'taskId', 'queries'],
  draft: ['action', 'taskId', 'instruction', 'routes'],
  checkpoint: ['action', 'taskId', 'stage', 'summary', 'artifact', 'sources', 'claims', 'failures'],
  steer: ['action', 'taskId', 'correction', 'sourcePolicy'],
  complete: ['action', 'taskId', 'artifact'],
  status: ['action', 'taskId'],
  stop: ['action', 'taskId', 'reason'],
  resume: ['action', 'taskId'],
  export: ['action', 'taskId', 'title', 'tags', 'init'],
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RavenTypeError('invalid-value', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  // Name the accepted set too: a caller that only learns which field was wrong
  // has to guess the right one, and the fields it guesses are usually another
  // action's fields.
  if (unknown.length > 0) {
    throw new RavenTypeError(
      'unknown-field',
      `${label} contains unknown field(s): ${unknown.join(', ')}. `
      + `Accepted field(s): ${allowed.join(', ')}`,
    )
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RavenTypeError('invalid-value', `${label} must be a non-empty string`)
  }
  return value.trim()
}

function boundedText(value: unknown, label: string, maximum: number): string {
  const text = requiredText(value, label)
  if (text.length > maximum) throw new RavenTypeError('limit-exceeded', `${label} must be at most ${maximum} characters`)
  return text
}

function optionalBoundedText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined
  return boundedText(value, label, maximum)
}

function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    // Name the accepted set, exactly as assertOnlyKeys does. "stage is invalid"
    // was the one error in this codebase a caller could not act on: it named
    // neither what it received nor what it would have taken, so the only repair
    // was to guess an enum member.
    throw new RavenTypeError(
      'invalid-enum',
      `${label} must be one of: ${values.join(', ')}. Received: ${typeof value === 'string' ? JSON.stringify(value) : typeof value}`,
    )
  }
  return value as T
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new RavenTypeError('invalid-value', `${label} must be an array`)
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

/**
 * Checkpoint identity, derived from the state revision rather than the ordinal.
 *
 * A per-Task-ordinal id (`${taskId}-cp-${n}`) was not unique across concurrent
 * writers: two Agent Team members checkpointing the same Task from the same
 * loaded state both minted `-cp-4`, so one Checkpoint's identity silently
 * described the other's bytes. The revision is monotonic per accepted write and
 * a compare-and-set on the book write is what makes only one of the two land, so
 * the surviving Checkpoint has an id no other writer can have produced. (That
 * compare-and-set is plugin.ts's half and is NOT implemented here.)
 */
function checkpointId(task: string, revision: number): string {
  return `${task}-cp-r${revision}`
}

function nextCheckpointOrdinal(checkpoints: readonly RavenCheckpointRecord[]): number {
  return (checkpoints.at(-1)?.ordinal ?? 0) + 1
}

/**
 * Append one Checkpoint, trimming to stay inside the cap.
 *
 * The cap used to be a terminal deadlock: `checkpoint` threw at 128 and
 * `complete` refused for want of a slot, so a Task that reached the cap could
 * never finish and every remaining byte of work was unreachable. Old Checkpoints
 * are descriptors, not content — the Artifacts they describe already live in
 * prior durable tool results — so dropping the oldest one costs a pointer, while
 * refusing costs the Task.
 *
 * The FIRST Checkpoint is preserved: it is the Task's earliest independently
 * useful result and the only record of where the work started, and it is the one
 * descriptor a reader reaches for when auditing how an Artifact evolved. The
 * oldest trimmable Checkpoint is therefore the second one. `reserve` lets
 * Completion demand its own slot in advance so it is never the call that is
 * refused. Ordinals stay strictly increasing across a trim, exactly as draft
 * rounds already do, and every trim is reported rather than silent.
 */
function admitCheckpoint(
  state: RavenTaskState,
  addition: RavenCheckpointRecord,
  reserve: number,
): { checkpoints: RavenCheckpointRecord[]; issues: string[] } {
  const checkpoints = [...state.checkpoints]
  const issues: string[] = []
  let trimmed = 0
  while (checkpoints.length + 1 + reserve > RAVEN_LIMITS.checkpoints && checkpoints.length > 1) {
    checkpoints.splice(1, 1)
    trimmed += 1
  }
  checkpoints.push(addition)
  if (trimmed > 0) {
    issues.push(
      `${trimmed} older Checkpoint descriptor(s) were trimmed to stay inside the maximum of`
      + ` ${RAVEN_LIMITS.checkpoints}; the first Checkpoint and every later one are retained,`
      + ' and the trimmed Artifacts remain in their original tool results.',
    )
  }
  return { checkpoints, issues }
}

function requireTask(previous: RavenTaskState | null, requestedTaskId: unknown): RavenTaskState {
  if (previous === null) throw new RavenError('task-not-found', 'No Raven Task exists in this session')
  const requested = requiredText(requestedTaskId, 'taskId')
  if (requested !== previous.taskId) {
    throw new RavenError('task-not-found', `Raven Task ${requested} was not found in this session`)
  }
  return previous
}

function requireActiveTask(previous: RavenTaskState | null, requestedTaskId: unknown): RavenTaskState {
  const state = requireTask(previous, requestedTaskId)
  if (state.phase !== 'active') throw new RavenError('task-phase', `Raven Task ${state.taskId} is ${state.phase}`)
  return state
}

function canonicalUri(value: unknown, label: string, origin: SourceOrigin): string {
  const input = boundedText(value, label, RAVEN_LIMITS.sourceLocatorChars)
  if (origin === 'web') return canonicalSourceUrl(input)
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new RavenTypeError('invalid-value', label + ' must be an absolute URI')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new RavenTypeError('invalid-value', label + ' must not contain credentials')
  }
  const allowedSchemes: Record<Exclude<SourceOrigin, 'web'>, readonly string[]> = {
    local: ['file:'],
    'llm-wiki': ['file:', 'llm-wiki:'],
    mcp: ['mcp:'],
  }
  if (!allowedSchemes[origin].includes(parsed.protocol)) {
    throw new RavenTypeError('invalid-value', label + ' has a scheme incompatible with Source origin ' + origin)
  }
  return parsed.href
}

function parseRepresentation(
  value: unknown,
  resource: RavenSourceResource,
): RavenSourceRepresentation | null {
  if (value === null) {
    if (resource.origin === 'web') {
      throw new RavenTypeError('invalid-value', 'a web Source must name its Markdown conversion provenance')
    }
    return null
  }
  const input = record(value, 'source.representation')
  assertOnlyKeys(input, ['format', 'derivation', 'coverage', 'producedBy', 'inspectionCallId', 'markdown'], 'source.representation')
  if (input.format !== 'markdown') {
    throw new RavenTypeError('invalid-value', 'source.representation.format must be markdown')
  }
  const derivation = member(input.derivation, ['original', 'converted'] as const, 'source.representation.derivation')
  const coverage = member(input.coverage, ['full', 'segment', 'unknown'] as const, 'source.representation.coverage')
  const producedBy = boundedText(input.producedBy, 'source.representation.producedBy', RAVEN_LIMITS.sourceProducedByChars)
  const inspectionCallId = optionalBoundedText(input.inspectionCallId, 'source.representation.inspectionCallId', RAVEN_LIMITS.sourceInspectionCallIdChars)
  const markdown = input.markdown
  if (markdown !== undefined && typeof markdown !== 'string') {
    throw new RavenTypeError('invalid-value', 'source.representation.markdown must be a string')
  }
  if (typeof markdown === 'string' && markdown.length > RAVEN_LIMITS.sourceMarkdownChars) {
    throw new RavenTypeError('limit-exceeded', 'source.representation.markdown must be at most ' + RAVEN_LIMITS.sourceMarkdownChars + ' characters')
  }
  if (resource.origin !== 'web' && markdown === undefined) {
    throw new RavenTypeError('invalid-value', 'a non-web Markdown representation must include its exact markdown bytes')
  }
  if (resource.origin !== 'web' && inspectionCallId === undefined) {
    throw new RavenTypeError('invalid-value', 'a non-web Markdown representation must name its Harness inspectionCallId')
  }
  if (resource.origin === 'web' && coverage !== 'unknown') {
    throw new RavenTypeError('invalid-value', 'web representation coverage is determined by re-fetch and must be unknown at registration')
  }
  if (resource.origin === 'web' && inspectionCallId !== undefined) {
    throw new RavenTypeError('invalid-value', 'web Sources are independently re-fetched and must not claim an inspectionCallId')
  }
  const mediaType = resource.mediaType?.split(';', 1)[0]?.trim().toLowerCase()
  if (derivation === 'original' && mediaType !== 'text/markdown') {
    throw new RavenTypeError('invalid-value', 'an original Markdown representation requires resource.mediaType=text/markdown')
  }
  return {
    format: 'markdown',
    derivation,
    coverage,
    producedBy,
    ...(inspectionCallId === undefined ? {} : { inspectionCallId }),
    ...(markdown === undefined ? {} : { markdown }),
  }
}

function parseSourceResource(input: Record<string, unknown>): {
  resource: RavenSourceResource
  representation: RavenSourceRepresentation | null
  url: string
} {
  if (input.resource === undefined) {
    const url = canonicalUri(input.url, 'source.url', 'web')
    return {
      url,
      resource: { origin: 'web', uri: url },
      representation: { format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'web_fetch' },
    }
  }
  if (!Object.hasOwn(input, 'representation')) {
    throw new RavenTypeError('invalid-value', 'a unified Source must provide representation (or null on conversion failure)')
  }
  const raw = record(input.resource, 'source.resource')
  assertOnlyKeys(raw, ['origin', 'uri', 'mediaType', 'sourceName'], 'source.resource')
  const origin = member<SourceOrigin>(raw.origin, SOURCE_ORIGINS, 'source.resource.origin')
  const uri = canonicalUri(raw.uri, 'source.resource.uri', origin)
  const mediaType = optionalBoundedText(raw.mediaType, 'source.resource.mediaType', RAVEN_LIMITS.sourceMediaTypeChars)
  const sourceName = optionalBoundedText(raw.sourceName, 'source.resource.sourceName', RAVEN_LIMITS.sourceNameChars)
  if ((origin === 'llm-wiki' || origin === 'mcp') && sourceName === undefined) {
    throw new RavenTypeError('invalid-value', 'source.resource.sourceName is required for ' + origin + ' Sources')
  }
  if ((origin === 'web' || origin === 'local') && sourceName !== undefined) {
    throw new RavenTypeError('invalid-value', 'source.resource.sourceName is not valid for ' + origin + ' Sources')
  }
  if (origin === 'mcp' && new URL(uri).hostname !== sourceName) {
    throw new RavenTypeError('invalid-value', 'an MCP resource URI authority must equal source.resource.sourceName')
  }
  if (origin === 'llm-wiki' && new URL(uri).protocol === 'llm-wiki:' && new URL(uri).hostname !== sourceName) {
    throw new RavenTypeError('invalid-value', 'an llm-wiki URI authority must equal source.resource.sourceName')
  }
  const url = input.url === undefined ? uri : canonicalUri(input.url, 'source.url', origin)
  if (url !== uri) throw new RavenError('evidence-conflict', 'source.url must equal source.resource.uri')
  const resource: RavenSourceResource = {
    origin,
    uri,
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(sourceName === undefined ? {} : { sourceName }),
  }
  return { resource, representation: parseRepresentation(input.representation, resource), url }
}

const SOURCE_POLICY_KEYS = [
  'allowedWebHosts', 'blockedWebHosts', 'preferPrimary', 'localRoots', 'llmWikiRoots',
  'includedMcpSources', 'excludedMcpSources',
] as const

function policyStrings(value: unknown, label: string, transform: (value: string) => string = value => value): string[] {
  if (!Array.isArray(value)) throw new RavenTypeError('invalid-value', label + ' must be an array')
  if (value.length > RAVEN_LIMITS.sourcePolicyItems) {
    throw new RavenTypeError('limit-exceeded', label + ' may contain at most ' + RAVEN_LIMITS.sourcePolicyItems + ' items')
  }
  const parsed = value.map((item, index) => transform(boundedText(item, label + '[' + index + ']', RAVEN_LIMITS.sourcePolicyStringChars)))
  if (new Set(parsed).size !== parsed.length) throw new RavenTypeError('invalid-value', label + ' must not contain duplicates')
  return parsed
}

function policyHost(value: string): string {
  const host = value.toLowerCase()
  let parsed: URL
  try {
    parsed = new URL('https://' + host)
  } catch {
    throw new RavenTypeError('invalid-value', 'invalid Source Policy web host: ' + JSON.stringify(value))
  }
  if (parsed.hostname !== host || parsed.port !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new RavenTypeError('invalid-value', 'Source Policy web hosts must be bare host names: ' + JSON.stringify(value))
  }
  return host
}

function policyRoot(origin: 'local' | 'llm-wiki'): (value: string) => string {
  return value => canonicalUri(value, 'Source Policy root', origin)
}

function parseSourcePolicy(value: unknown, base: RavenSourcePolicy, label = 'sourcePolicy'): RavenSourcePolicy {
  if (value === undefined) return base
  const input = record(value, label)
  assertOnlyKeys(input, SOURCE_POLICY_KEYS, label)
  const next: RavenSourcePolicy = {
    allowedWebHosts: input.allowedWebHosts === undefined ? base.allowedWebHosts : policyStrings(input.allowedWebHosts, label + '.allowedWebHosts', policyHost),
    blockedWebHosts: input.blockedWebHosts === undefined ? base.blockedWebHosts : policyStrings(input.blockedWebHosts, label + '.blockedWebHosts', policyHost),
    preferPrimary: input.preferPrimary === undefined ? base.preferPrimary : (() => {
      if (typeof input.preferPrimary !== 'boolean') throw new RavenTypeError('invalid-value', label + '.preferPrimary must be a boolean')
      return input.preferPrimary
    })(),
    localRoots: input.localRoots === undefined ? base.localRoots : policyStrings(input.localRoots, label + '.localRoots', policyRoot('local')),
    llmWikiRoots: input.llmWikiRoots === undefined ? base.llmWikiRoots : policyStrings(input.llmWikiRoots, label + '.llmWikiRoots', policyRoot('llm-wiki')),
    includedMcpSources: input.includedMcpSources === undefined ? base.includedMcpSources : policyStrings(input.includedMcpSources, label + '.includedMcpSources'),
    excludedMcpSources: input.excludedMcpSources === undefined ? base.excludedMcpSources : policyStrings(input.excludedMcpSources, label + '.excludedMcpSources'),
  }
  if (next.allowedWebHosts.some(host => next.blockedWebHosts.includes(host))) {
    throw new RavenTypeError('invalid-value', 'sourcePolicy cannot both allow and block the same web host')
  }
  if (next.includedMcpSources.some(name => next.excludedMcpSources.includes(name))) {
    throw new RavenTypeError('invalid-value', 'sourcePolicy cannot both include and exclude the same MCP source')
  }
  return next
}

function hostMatches(host: string, rule: string): boolean {
  return host === rule || host.endsWith('.' + rule)
}

function uriWithin(uri: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    if (uri === root) return true
    const prefix = root.endsWith('/') ? root : root + '/'
    return uri.startsWith(prefix)
  })
}

function sourcePolicyViolation(source: RavenSourceRecord, policy: RavenSourcePolicy): string | undefined {
  const { origin, uri, sourceName } = source.resource
  if (origin === 'web') {
    const host = new URL(uri).hostname.toLowerCase()
    if (policy.blockedWebHosts.some(rule => hostMatches(host, rule))) return 'web host ' + host + ' is blocked'
    if (policy.allowedWebHosts.length > 0 && !policy.allowedWebHosts.some(rule => hostMatches(host, rule))) {
      return 'web host ' + host + ' is outside allowedWebHosts'
    }
  }
  if (origin === 'local') {
    if (policy.localRoots.length === 0) return 'no localRoots are included by this Task'
    if (!uriWithin(uri, policy.localRoots)) return 'local resource is outside localRoots'
  }
  if (origin === 'llm-wiki') {
    if (policy.llmWikiRoots.length === 0) return 'no llmWikiRoots are included by this Task'
    if (!uriWithin(uri, policy.llmWikiRoots)) return 'llm-wiki resource is outside llmWikiRoots'
  }
  if (origin === 'mcp') {
    if (sourceName === undefined) return 'MCP resource has no sourceName'
    if (policy.includedMcpSources.length === 0 && policy.excludedMcpSources.length === 0) {
      return 'no MCP sources are included by this Task'
    }
    if (policy.excludedMcpSources.includes(sourceName)) return 'MCP source ' + sourceName + ' is excluded'
    if (policy.includedMcpSources.length > 0 && !policy.includedMcpSources.includes(sourceName)) {
      return 'MCP source ' + sourceName + ' is outside includedMcpSources'
    }
  }
  return undefined
}

function stableId(value: unknown, label: string): string {
  const id = requiredText(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new RavenTypeError('invalid-value', `${label} must use 1-64 letters, digits, dot, underscore, or hyphen`)
  }
  return id
}

function sourceIdentity(resource: RavenSourceResource): string {
  return resource.uri
}

function parseSources(
  value: unknown,
  existing: readonly RavenSourceRecord[],
  inspectedAt: string,
): RavenSourceRecord[] {
  const byId = new Map(existing.map(source => [source.sourceId, source]))
  const idByIdentity = new Map(existing.map(source => [sourceIdentity(source.resource), source.sourceId]))
  for (const raw of optionalArray(value, 'sources')) {
    const input = record(raw, 'source')
    assertOnlyKeys(input, [
      'sourceId', 'url', 'resource', 'representation', 'title', 'locator', 'excerpt', 'role', 'sourceFamily', 'asOf',
    ], 'source')
    const sourceId = stableId(input.sourceId, 'source.sourceId')
    const { resource, representation, url } = parseSourceResource(input)
    const identity = sourceIdentity(resource)
    const otherId = idByIdentity.get(identity)
    if (otherId !== undefined && otherId !== sourceId) {
      throw new RavenError('evidence-conflict', `source resource ${resource.origin}:${resource.uri} is already registered as ${otherId}`)
    }
    const current = byId.get(sourceId)
    if (current !== undefined
      && (sourceIdentity(current.resource) !== identity
        || JSON.stringify(current.resource) !== JSON.stringify(resource))) {
      throw new RavenError('evidence-conflict', `source ID ${sourceId} is already bound to ${current.resource.origin}:${current.resource.uri}`)
    }
    const sourceFamily = optionalBoundedText(input.sourceFamily, 'source.sourceFamily', RAVEN_LIMITS.sourceFamilyChars)
    const asOf = optionalBoundedText(input.asOf, 'source.asOf', RAVEN_LIMITS.sourceAsOfChars)
    const next: RavenSourceRecord = {
      sourceId,
      url,
      resource,
      representation,
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
        && JSON.stringify(current.resource) === JSON.stringify(next.resource)
        && JSON.stringify(current.representation) === JSON.stringify(next.representation)
        && current.title === next.title
        && current.locator === next.locator
        && current.excerpt === next.excerpt
        && current.role === next.role
        && current.sourceFamily === next.sourceFamily
        && current.asOf === next.asOf
      // A Source the verifier REFUSED is the one case where rewriting the record
      // is repair rather than substitution, and the system depends on it: a check
      // that finds the excerpt absent, or a retrieval truncated before it, tells the
      // agent to repair the recorded excerpt from the nearest passage — and until
      // a failed Checkpoint began retaining its Sources, that repair worked only
      // because the refused record had been thrown away with everything else.
      // Retaining evidence without this exemption made one mistyped excerpt
      // permanently uncitable: the ID could not be rewritten, and the same URL
      // could not be registered under a new ID either.
      //
      // This exemption and that retention are load-bearing for each other. Narrowing
      // it back to `failed` alone would silently make the truncated-retrieval guidance
      // unfollowable — that detail tells the agent to cite a passage INSIDE the
      // retrieved range, which is itself a rewrite of a Source reported `unavailable`.
      // It is exactly the kind of tightening that reads as safe cleanup.
      //
      // The exemption stops exactly where the danger starts. A `reachable` Source
      // is confirmed evidence that Claims and citations already rest on, and an
      // `unchecked` one is simply a different Source nobody has judged; neither may
      // be swapped out behind its own ID. A repaired record returns to
      // `unchecked`, so it is re-verified before it can support anything.
      const refused = current.check.status === 'failed' || current.check.status === 'unavailable'
      if (!sameEvidence && !refused) {
        throw new RavenError(
          'evidence-conflict',
          `source ID ${sourceId} cannot be rewritten while its check is ${current.check.status};`
          + ' register changed evidence under a new Source ID, or repair this one after a check refuses it',
        )
      }
      byId.set(sourceId, sameEvidence ? current : next)
    } else {
      byId.set(sourceId, next)
    }
    idByIdentity.set(identity, sourceId)
  }
  if (byId.size > RAVEN_LIMITS.sources) {
    throw new RavenError('limit-exceeded', `Raven Task may retain at most ${RAVEN_LIMITS.sources} Sources`)
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
    assertOnlyKeys(input, ['claimId', 'text', 'kind', 'importance', 'disposition', 'sourceIds', 'contradicts'], 'claim')
    const claimId = stableId(input.claimId, 'claim.claimId')
    const text = boundedText(input.text, 'claim.text', RAVEN_LIMITS.claimTextChars)
    const current = byId.get(claimId)
    if (current !== undefined && current.text !== text) {
      throw new RavenError('evidence-conflict', `claim ID ${claimId} cannot be reused for different text`)
    }
    const sourceIds = optionalArray(input.sourceIds, 'claim.sourceIds')
      .map(sourceId => stableId(sourceId, 'claim.sourceIds[]'))
    if (sourceIds.length > RAVEN_LIMITS.sources) {
      throw new RavenError('limit-exceeded', `claim.sourceIds may contain at most ${RAVEN_LIMITS.sources} Source IDs`)
    }
    if (new Set(sourceIds).size !== sourceIds.length) {
      throw new RavenError('evidence-conflict', `claim ${claimId} contains duplicate Source IDs`)
    }
    for (const sourceId of sourceIds) {
      if (!knownSourceIds.has(sourceId)) throw new RavenError('evidence-conflict', `claim ${claimId} references unknown source ${sourceId}`)
    }
    const kind = member<ClaimKind>(input.kind, CLAIM_KINDS, 'claim.kind')
    const importance = member<ClaimImportance>(input.importance, CLAIM_IMPORTANCE, 'claim.importance')
    const disposition = member<ClaimDisposition>(input.disposition, CLAIM_DISPOSITIONS, 'claim.disposition')
    if (kind === 'external' && (disposition === 'supported' || disposition === 'qualified') && sourceIds.length === 0) {
      throw new RavenError('evidence-conflict', `external claim ${claimId} requires at least one source`)
    }
    const contradicts = optionalArray(input.contradicts, 'claim.contradicts')
      .map(other => stableId(other, 'claim.contradicts[]'))
    if (contradicts.length > RAVEN_LIMITS.claims) {
      throw new RavenError('limit-exceeded', `claim.contradicts may name at most ${RAVEN_LIMITS.claims} Claim IDs`)
    }
    if (new Set(contradicts).size !== contradicts.length) {
      throw new RavenError('evidence-conflict', `claim ${claimId} contains duplicate contradiction links`)
    }
    if (contradicts.includes(claimId)) throw new RavenError('evidence-conflict', `claim ${claimId} cannot contradict itself`)
    byId.set(claimId, {
      claimId,
      text,
      kind,
      importance,
      disposition,
      sourceIds,
      ...(contradicts.length === 0 ? {} : { contradicts }),
    })
  }
  // Resolved after the batch so a mutually contradicting pair can be submitted together.
  for (const claim of byId.values()) {
    for (const other of claim.contradicts ?? []) {
      if (!byId.has(other)) throw new RavenError('evidence-conflict', `claim ${claim.claimId} contradicts unknown Claim ${other}`)
    }
  }
  if (byId.size > RAVEN_LIMITS.claims) {
    throw new RavenError('limit-exceeded', `Raven Task may retain at most ${RAVEN_LIMITS.claims} Claims`)
  }
  return [...byId.values()]
}

/**
 * Fold-key for duplicate suppression.
 *
 * Exact-detail comparison never folded near-identical verifier details — the same
 * dead host reported with a fresh timestamp, a different status code, or a
 * different elapsed-ms figure produced N Limitations that all say one thing, and
 * they accumulated toward the cap until a real Limitation could not be recorded.
 * Digits, punctuation, and case are therefore normalized away and the key is
 * bounded, so "HTTP 503 after 1200ms" and "HTTP 504 after 1900ms" fold together.
 * The retained record keeps the FIRST detail verbatim: the fold is a dedupe, not
 * a summarization, and the earliest observation is the one with full context.
 *
 * The digit pass is redundant with the character-class pass that follows it, which
 * already drops every digit; it is kept only so the intent survives if that class
 * is ever widened to admit digits. Removing it changes no observable behaviour.
 */
function limitationFoldKey(kind: RavenLimitationKind, detail: string, sourceId?: string): string {
  const normalized = detail
    .toLowerCase()
    .replaceAll(/\d+/g, '#')
    .replaceAll(/[^a-z#\u4E00-\u9FFF]+/g, ' ')
    .trim()
    .slice(0, 160)
  return `${kind}\u0000${sourceId ?? ''}\u0000${normalized}`
}

/**
 * The ONE place a Limitation is appended.
 *
 * Three call sites used to have three policies: `parseLimitations` threw at the
 * cap, `propagateSourceChecks` threw at the cap mid-mutation (discarding the
 * Claim deferrals computed in the same pass and turning an actionable "this
 * Source is broken" result into a contextless throw), and `discover` silently
 * dropped. Dropping is the right policy — a Limitation is a record ABOUT a
 * failure and losing the Task over it is worse than losing the record — but it
 * has to be visible, so the drop is reported to the caller instead of vanishing.
 *
 * Identity is a monotonic counter over everything the Task has ever recorded,
 * never the array index. A positional id (`${kind}-${length + 1}`) collided
 * across kinds and disagreed with the replay codec the moment two kinds
 * interleaved, and the codec then rejected the whole snapshot.
 *
 * Scope, measured rather than assumed: now that the codec validates shape and
 * uniqueness instead of position, the counter and a positional id only produce
 * DIFFERENT values once the array length falls behind the highest ordinal -- which
 * happens only after a Limitation was dropped at the cap. That is a real state
 * this engine can reach, but it is not reachable in a unit test without first
 * filling 256 Limitations and then folding one, so the guarantee here rests on
 * the counter being obviously monotonic rather than on a regression test.
 */
interface LimitationAppend {
  readonly limitations: RavenLimitation[]
  readonly dropped: number
}

function nextLimitationOrdinal(existing: readonly RavenLimitation[]): number {
  let highest = 0
  for (const item of existing) {
    const ordinal = Number.parseInt(item.limitationId.slice(item.limitationId.lastIndexOf('-') + 1), 10)
    if (Number.isSafeInteger(ordinal) && ordinal > highest) highest = ordinal
  }
  return highest + 1
}

function appendLimitations(
  existing: readonly RavenLimitation[],
  additions: readonly Omit<RavenLimitation, 'limitationId' | 'createdAt'>[],
  createdAt: string,
): LimitationAppend {
  const limitations = [...existing]
  const seen = new Set(limitations.map(item => limitationFoldKey(item.kind, item.detail, item.sourceId)))
  let ordinal = nextLimitationOrdinal(limitations)
  let dropped = 0
  for (const addition of additions) {
    const key = limitationFoldKey(addition.kind, addition.detail, addition.sourceId)
    if (seen.has(key)) continue
    if (limitations.length >= RAVEN_LIMITS.limitations) {
      dropped += 1
      continue
    }
    seen.add(key)
    limitations.push({
      limitationId: `${addition.kind}-${ordinal}`,
      kind: addition.kind,
      detail: addition.detail,
      ...(addition.sourceId === undefined ? {} : { sourceId: addition.sourceId }),
      createdAt,
    })
    ordinal += 1
  }
  return { limitations, dropped }
}

function limitationCapIssue(dropped: number): string[] {
  return dropped === 0
    ? []
    : [`${dropped} Limitation(s) could not be recorded: the Task already holds the maximum of`
      + ` ${RAVEN_LIMITS.limitations}. The Task is unaffected; older Limitations still describe the same failures.`]
}

function parseLimitations(
  value: unknown,
  existing: readonly RavenLimitation[],
  knownSourceIds: ReadonlySet<string>,
  createdAt: string,
): LimitationAppend {
  const additions: Omit<RavenLimitation, 'limitationId' | 'createdAt'>[] = []
  for (const raw of optionalArray(value, 'failures')) {
    const input = record(raw, 'failure')
    assertOnlyKeys(input, ['kind', 'detail', 'sourceId'], 'failure')
    const kind = member<RavenLimitationKind>(input.kind, LIMITATION_KINDS, 'failure.kind')
    const detail = boundedText(input.detail, 'failure.detail', RAVEN_LIMITS.limitationDetailChars)
    const sourceId = input.sourceId === undefined
      ? undefined
      : stableId(input.sourceId, 'failure.sourceId')
    if (sourceId !== undefined && !knownSourceIds.has(sourceId)) {
      throw new RavenError('evidence-conflict', `failure references unknown source ${sourceId}`)
    }
    additions.push({ kind, detail, ...(sourceId === undefined ? {} : { sourceId }) })
  }
  // Hitting the Limitation cap costs the Limitations that did not fit and nothing
  // else. Throwing here used to discard the Sources, Claims, and Artifact that
  // were submitted in the same call.
  return appendLimitations(existing, additions, createdAt)
}

function propagateSourceChecks(
  claims: readonly RavenClaimRecord[],
  limitations: readonly RavenLimitation[],
  sources: readonly RavenSourceRecord[],
  createdAt: string,
): { claims: RavenClaimRecord[]; limitations: RavenLimitation[]; droppedLimitations: number } {
  const checkById = new Map(sources.map(source => [source.sourceId, source.check]))
  const propagatedClaims = claims.map((claim): RavenClaimRecord => {
    if (claim.kind !== 'external') return claim
    const hasUsableSupport = claim.sourceIds.some(sourceId => checkById.get(sourceId)?.status === 'reachable')
    if (claim.disposition === 'deferred' && claim.deferredFrom !== undefined && hasUsableSupport) {
      const { deferredFrom, ...restored } = claim
      return { ...restored, disposition: deferredFrom }
    }
    if ((claim.disposition === 'supported' || claim.disposition === 'qualified') && !hasUsableSupport) {
      return { ...claim, disposition: 'deferred', deferredFrom: claim.disposition }
    }
    return claim
  })
  // Total on purpose. This runs on the `complete` failure path, where throwing at
  // the Limitation cap converted an actionable "this Source is broken" result into
  // a contextless throw AND lost the Claim deferrals computed in the same pass —
  // the deferrals being the more valuable half. A cap now drops the record and
  // says so; it never costs the propagation.
  const activeLimitations = limitations.filter((item) => {
    if (item.kind !== 'source' || item.sourceId === undefined) return true
    const generated = item.detail.startsWith(`Source ${item.sourceId} failed verification:`)
    return !generated || checkById.get(item.sourceId)?.status !== 'reachable'
  })
  const alreadyRecorded = new Set(activeLimitations
    .filter(item => item.kind === 'source' && item.sourceId !== undefined)
    .map(item => item.sourceId))
  const additions = sources
    .filter(source => source.check.status !== 'unchecked'
      && source.check.status !== 'reachable'
      && !alreadyRecorded.has(source.sourceId))
    .map(source => ({
      kind: 'source' as const,
      sourceId: source.sourceId,
      detail: `Source ${source.sourceId} failed verification: ${source.check.status === 'unchecked' ? 'unchecked' : source.check.detail ?? source.check.status}`,
    }))
  const appended = appendLimitations(activeLimitations, additions, createdAt)
  return {
    claims: propagatedClaims,
    limitations: appended.limitations,
    droppedLimitations: appended.dropped,
  }
}

function citationIds(artifact: string): string[] {
  return [...artifact.matchAll(/\[@([A-Za-z0-9][A-Za-z0-9._-]{0,63})\]/g)]
    .map(match => match[1])
    .filter((id): id is string => id !== undefined)
}

/**
 * The Artifact regions where a raw URL is content, not a citation.
 *
 * Scanning the WHOLE Artifact for `http(s)://` refused a research Artifact that
 * merely QUOTED a config snippet, a curl line, or an `[ref]: https://…` link
 * definition — none of which is the author asserting an unregistered source.
 * The protected regions are exactly the ones the Prose Layout already refuses to
 * reflow (prose.ts: fenced code, YAML frontmatter, link reference definitions),
 * plus inline code spans, and the rules are restated here rather than shared
 * because prose.ts exports no region walker yet; a shared `protectedRegions`
 * export in prose.ts is the right long-term home for both callers.
 */
const FRONTMATTER_DELIMITER = /^-{3,}\s*$/
const ARTIFACT_FENCE = /^(\s*)(`{3,}|~{3,})/
const ARTIFACT_LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:/

/** Blank out every protected region, preserving offsets so reported text still lines up. */
function citationScannableText(artifact: string): string {
  const lines = artifact.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const output: string[] = []
  let fence: string | undefined
  let inFrontmatter = false
  for (const [index, line] of lines.entries()) {
    if (index === 0 && FRONTMATTER_DELIMITER.test(line)) {
      inFrontmatter = true
      output.push('')
      continue
    }
    if (inFrontmatter) {
      if (FRONTMATTER_DELIMITER.test(line)) inFrontmatter = false
      output.push('')
      continue
    }
    if (fence !== undefined) {
      if (line.trimStart().startsWith(fence)) fence = undefined
      output.push('')
      continue
    }
    const fenceMatch = ARTIFACT_FENCE.exec(line)
    if (fenceMatch !== null) {
      fence = fenceMatch[2] ?? '```'
      output.push('')
      continue
    }
    if (ARTIFACT_LINK_DEFINITION.test(line)) {
      output.push('')
      continue
    }
    // Inline code spans: a backtick run is closed by an equal-length run.
    output.push(line.replaceAll(/(`+)(?:(?!\1)[\s\S])*?\1/g, match => ' '.repeat(match.length)))
  }
  return output.join('\n')
}

/**
 * Whether a registered Source authorizes an Artifact URL.
 *
 * A registered `https://x/a` did not authorize `https://x/a#section`, so citing
 * the exact anchor the excerpt came from — the more precise, more honest form —
 * was refused as an unregistered URL. A fragment is a client-side pointer inside
 * the SAME retrieved document, so it is allowed. A trailing slash is allowed for
 * the same reason in the other direction: `https://x/a` and `https://x/a/` are
 * the one identity most authorities serve interchangeably. A different path,
 * query, or host is still refused, because those retrieve a different document.
 */
function urlIsAuthorized(url: URL, knownUrls: ReadonlySet<string>): boolean {
  const withoutFragment = new URL(url.href)
  withoutFragment.hash = ''
  const bases = [url.href, withoutFragment.href]
  const candidates = new Set(bases)
  for (const base of bases) {
    const parsed = new URL(base)
    parsed.pathname = parsed.pathname.endsWith('/') && parsed.pathname !== '/'
      ? parsed.pathname.slice(0, -1)
      : `${parsed.pathname}/`
    candidates.add(parsed.href)
  }
  for (const candidate of candidates) {
    if (knownUrls.has(candidate)) return true
  }
  return false
}

function validateArtifactCitations(
  artifact: string,
  sources: readonly RavenSourceRecord[],
  claims: readonly RavenClaimRecord[],
): void {
  const cited = new Set(citationIds(artifact))
  const known = new Set(sources.map(source => source.sourceId))
  for (const sourceId of cited) {
    if (!known.has(sourceId)) throw new RavenError('evidence-conflict', `artifact cites unknown source ${sourceId}`)
  }
  const knownUrls = new Set(sources.filter(source => source.resource.origin === 'web').map(source => source.url))
  for (const match of citationScannableText(artifact).matchAll(/https?:\/\/[^\s<>\]]+/g)) {
    const rawUrl = match[0].replace(/[),.;!?]+$/, '')
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new RavenError('evidence-conflict', `artifact contains invalid external URL ${rawUrl}`)
    }
    if (!urlIsAuthorized(url, knownUrls)) {
      throw new RavenError('evidence-conflict', `artifact contains unregistered external URL ${rawUrl}`)
    }
  }
  for (const claim of claims) {
    if (claim.kind !== 'external' || claim.importance !== 'material') continue
    if (claim.disposition !== 'supported' && claim.disposition !== 'qualified') continue
    if (!claim.sourceIds.some(sourceId => cited.has(sourceId))) {
      throw new RavenError('evidence-conflict', `material claim ${claim.claimId} has no source citation in the artifact`)
    }
  }
}

function relevantSources(
  artifact: string,
  sources: readonly RavenSourceRecord[],
  claims: readonly RavenClaimRecord[],
): RavenSourceRecord[] {
  const relevantIds = new Set(citationIds(artifact))
  // EVERY external supported/qualified Claim, not only the material ones.
  // Verifying material Claims alone left a context Claim's Sources at
  // `{status:'unchecked'}`, which the replay codec rejects for the whole snapshot
  // — so the engine emitted states that were silently dropped on session replay,
  // taking the entire Task with them. The invariant architecture.md states carries
  // no importance qualifier either: a supported external Claim cannot have an
  // unknown or failed Source set. The cost is one fetch per context Claim; the
  // alternative was losing Tasks.
  for (const claim of claims) {
    if (claim.kind !== 'external') continue
    if (claim.disposition !== 'supported' && claim.disposition !== 'qualified') continue
    for (const sourceId of claim.sourceIds) relevantIds.add(sourceId)
  }
  return sources.filter(source => relevantIds.has(source.sourceId))
}

/**
 * One-line form of an arbitrary failure.
 *
 * The bound used to be a flat 300 characters, which cut the verifier's
 * nearest-passage repair guidance mid-quotation: the whole point of that detail
 * is that the agent can see the passage it should have quoted, and a truncated
 * quotation is worse than none because it invites weakening a correct excerpt to
 * fit the visible prefix. Long details therefore keep BOTH ends — the leading
 * diagnosis and the actionable tail — with the middle elided.
 */
const COMPACT_ERROR_HEAD = 300
const COMPACT_ERROR_TAIL = 700

function compactError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, ' ')
  if (message.length <= COMPACT_ERROR_HEAD + COMPACT_ERROR_TAIL) return message
  return `${message.slice(0, COMPACT_ERROR_HEAD)} […] ${message.slice(-COMPACT_ERROR_TAIL)}`
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
    const requested = requestedById.get(sourceId)
    if (requested === undefined) throw new Error(`source verifier protocol lost request for ${sourceId}`)
    let resolvedUrl: string | undefined
    if (result.resolvedUrl !== undefined) resolvedUrl = canonicalSourceUrl(requiredText(result.resolvedUrl, 'source verifier result.resolvedUrl'))
    const detail = optionalBoundedText(result.detail, 'source verifier result.detail', RAVEN_LIMITS.limitationDetailChars)
    if (requested.resource.origin === 'web') {
      if (status !== 'unavailable' && (statusCode === undefined || resolvedUrl === undefined)) {
        throw new Error(`source verifier protocol omitted HTTP identity for ${sourceId}`)
      }
      if (status === 'reachable' && (statusCode === undefined || statusCode < 200 || statusCode >= 400)) {
        throw new Error(`source verifier protocol marked non-success HTTP status reachable for ${sourceId}`)
      }
      if (status === 'reachable' && resolvedUrl !== undefined && !sameSourceIdentity(requested.url, resolvedUrl)) {
        throw new Error(`source verifier protocol marked a cross-host redirect reachable for ${sourceId}`)
      }
    } else if (statusCode !== undefined || resolvedUrl !== undefined) {
      throw new Error(`source verifier protocol returned HTTP identity for non-web source ${sourceId}`)
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
  policy: RavenSourcePolicy,
  artifactSha256: string,
  checkedAt: string,
  execution: RavenExecution,
): Promise<{ sources: RavenSourceRecord[]; receipt: RavenVerificationReceipt }> {
  const signal = execution.signal
  let observed: readonly SourceCheckResult[]
  const allowed = selected.filter(source => sourcePolicyViolation(source, policy) === undefined)
  const policyResults: SourceCheckResult[] = selected.flatMap((source) => {
    const violation = sourcePolicyViolation(source, policy)
    return violation === undefined ? [] : [{
      sourceId: source.sourceId,
      status: 'unavailable' as const,
      checkedAt,
      detail: `Task Source Policy excludes ${source.resource.origin} resource ${source.resource.uri}: ${violation}`,
    }]
  })
  try {
    const raw: unknown = await settleWithAbort(verifier.verify(allowed.map(source => ({
      sourceId: source.sourceId,
      url: source.url,
      resource: source.resource,
      representation: source.representation,
      ...(source.inspectionSha256 === undefined ? {} : { inspectionSha256: source.inspectionSha256 }),
      locator: source.locator,
      excerpt: source.excerpt,
    })), signal, execution), signal)
    try {
      observed = [...policyResults, ...validatedVerifierResults(allowed, raw)]
    } catch (error) {
      throw new RavenError('verifier-protocol', `source verifier protocol error: ${compactError(error)}`, { cause: error })
    }
  } catch (error) {
    signal.throwIfAborted()
    const message = compactError(error)
    const detail = message.includes('source verifier protocol')
      ? message
      : `source verifier unavailable: ${message}`
    observed = [...policyResults, ...allowed.map(source => ({
      sourceId: source.sourceId,
      status: 'unavailable' as const,
      checkedAt,
      detail,
    }))]
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
    const inspectionSha256 = source.resource.origin !== 'web'
      && source.representation !== null
      && result?.status === 'reachable'
      ? sourceInspectionSha256(source.resource, source.representation)
      : source.inspectionSha256
    return {
      ...source,
      ...(inspectionSha256 === undefined ? {} : { inspectionSha256 }),
      check,
    }
  })
  const checks = sources.filter(source => selectedIds.has(source.sourceId)).map(source => source.check)
  const reachable = checks.filter(check => check.status === 'reachable').length
  const failed = checks.filter(check => check.status === 'failed').length
  const unavailable = checks.filter(check => check.status === 'unavailable').length
  return {
    sources,
    receipt: {
      verifiedAt: checkedAt,
      mode: selected.some(source => source.resource.origin !== 'web')
        ? 'source'
        : selected.length > 0 && reachable + failed > 0 ? 'remote' : 'structural-only',
      checked: selected.length,
      reachable,
      failed,
      unavailable,
      artifactSha256,
    },
  }
}

/** The human label for one Lead: its title when it has one, else its host. */
function leadLabel(lead: { readonly url: string; readonly title?: string }): string {
  if (lead.title !== undefined && lead.title.trim().length > 0) return markdownText(lead.title)
  try {
    return new URL(lead.url).hostname
  } catch {
    return lead.url
  }
}

// The route vocabulary lives in a dependency-free module so the browser
// settings card can share it without pulling `node:crypto` into the page.
export { formatDraftRoute, parseDraftRoute } from './route.js'

/**
 * Render one comparison round. Every variant is labelled a candidate on every
 * path, for the same reason a Lead is: this render is the only place the agent
 * reads them, and prose that looks authoritative invites adopting its facts
 * along with its wording.
 */
export function renderVariants(result: DraftResult): string {
  const lines: string[] = []
  if (result.unavailable !== undefined) {
    lines.push(`Draft Variants did not run: ${result.unavailable}`)
  }
  const drafted = result.variants.filter(variant => variant.status === 'drafted')
  if (drafted.length > 0) {
    lines.push('## Draft Variants (candidate wording, not evidence)')
    lines.push(
      'Each variant is one model\'s rendering of the same instruction. Adopt phrasing, never facts:'
      + ' a sentence every variant agrees on is still unsupported until a Source excerpt supports it.'
      + ' Lines are aligned one sentence per line so variants diff line by line.',
    )
    for (const variant of drafted) {
      lines.push(`### ${markdownIdentifier(formatDraftRoute(variant.route))}`)
      lines.push(variant.text ?? '')
    }
  }
  const failed = result.variants.filter(variant => variant.status === 'failed')
  if (failed.length > 0) {
    lines.push('## Routes that produced no variant')
    for (const variant of failed) {
      lines.push(`- ${markdownIdentifier(formatDraftRoute(variant.route))}: ${markdownText(variant.detail ?? 'no detail')}`)
    }
  }
  return lines.join('\n\n')
}

/**
 * Render one discovery batch. Leads are labelled as uninspected on every path so
 * the batch can never read as an evidence set: the render is the only place the
 * agent sees them, and a list that looks like Sources invites citing them.
 */
export function renderLeads(outcome: LeadSearchResult): string {
  const lines: string[] = []
  if (outcome.unavailable !== undefined) {
    lines.push(`Lead discovery did not run: ${outcome.unavailable}`)
  }
  if (outcome.leads.length > 0) {
    lines.push('## Leads (uninspected candidates, not Sources)')
    outcome.leads.forEach((lead, index) => {
      lines.push(`${index + 1}. [${leadLabel(lead)}](${lead.url})`)
      const facts = [
        ...(lead.publishedAt === undefined ? [] : [`published ${markdownText(lead.publishedAt)}`]),
        `found by: ${lead.queries.map(query => markdownText(query)).join(' | ')}`,
      ]
      lines.push(`   - ${facts.join(' · ')}`)
      if (lead.snippet !== undefined && lead.snippet.trim().length > 0) {
        lines.push(`   - snippet: ${markdownText(lead.snippet)}`)
      }
    })
  } else if (outcome.unavailable === undefined) {
    lines.push('## Leads (uninspected candidates, not Sources)')
    lines.push('No candidate was returned.')
  }
  if (outcome.notes.length > 0) {
    lines.push('## Backend answer text (context only, never evidence)')
    for (const note of outcome.notes) {
      lines.push(`### ${markdownText(note.query)}`)
      lines.push(markdownText(note.content))
    }
  }
  if (outcome.failures.length > 0) {
    lines.push('## Failed queries (recorded as Limitations)')
    for (const failure of outcome.failures) {
      lines.push(`- ${markdownText(failure.query)} — ${markdownText(failure.detail)}`)
    }
  }
  if (outcome.truncated) {
    lines.push('Candidates were dropped to stay inside the batch bound; the visible set is not exhaustive.')
  }
  return lines.join('\n')
}

/** Preserved disagreement: a contested Claim must never read as settled fact. */
function contestedNote(claim: RavenClaimRecord): string {
  const contested = claim.contradicts ?? []
  if (contested.length === 0) return ''
  return ` — contested with ${contested.map(other => markdownText(other)).join(', ')}`
}

/**
 * Independence note for one Claim's cited Sources.
 *
 * Multiple publishers repeating one originating record remain one epistemic family,
 * so a Claim citing three reprints must not read as three independent confirmations.
 * Family is declared, never derived from host: distinct formal documents on one host
 * can be separate families, and one document mirrored across hosts is still one.
 * Independence is only meaningful per atomic proposition; that judgment stays with
 * the agent, so this annotates the rendered trace instead of blocking Completion.
 */
function independenceNote(
  claim: RavenClaimRecord,
  byId: Map<string, RavenSourceRecord>,
): string {
  if (claim.sourceIds.length < 2) return ''
  const families = claim.sourceIds.map(sourceId => byId.get(sourceId)?.sourceFamily)
  if (families.some(family => family === undefined)) return ' — independence unverified (undeclared Source family)'
  const distinct = new Set(families)
  if (distinct.size > 1) return ''
  const [only] = distinct
  return ` — single Source family "${markdownText(only ?? '')}"; not independent corroboration`
}

/**
 * Escape one untrusted string for inline Markdown.
 *
 * Markdown punctuation is backslashed FIRST and the HTML-significant characters
 * are replaced LAST, so the emitted entities are never themselves rescanned.
 *
 * Recorded honestly: the ordering is defensive, not a bug fix. It was changed
 * under the belief that the old order turned a title containing `&` into
 * `&amp\;`, and that does NOT reproduce -- `;` is not in the escaped character
 * class, so no entity a pass emits can be re-escaped by the other, and the two
 * orders are behaviourally identical for every input tried. The order is kept
 * this way because it stays correct if a `;` or `&` is ever added to the class,
 * which is exactly the change that would silently start double-escaping.
 */
/**
 * A machine identifier rendered for a human to match, not prose.
 *
 * A Draft route is a `provider/model` pair the DEPLOYMENT configured, so it is not
 * untrusted text and it must survive rendering byte-for-byte: the agent selects
 * routes by this exact string. Running it through markdownText escaped the hyphen
 * in a model name (`deep-v2` became `deep\\-v2`), which silently changed the label
 * the reader is meant to copy. Backticks make it inert without rewriting it; a
 * backtick inside the identifier is stripped rather than escaped, since it cannot
 * legally occur in a configured route and must never break out of the span.
 */
function markdownIdentifier(value: string): string {
  return `\`${value.replaceAll('`', '')}\``
}

function markdownText(value: string): string {
  return value
    .replace(/([\\`*_[\]{}()#+.!|-])/g, '\\$1')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function sourceProvenance(source: RavenSourceRecord): string {
  if (source.representation === null) return `${source.resource.origin}; no Markdown representation`
  return `${source.resource.origin}; ${source.representation.derivation} ${source.representation.coverage} Markdown by ${source.representation.producedBy}`
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
      return `- [${sourceId}] [${markdownText(source.title)}](${source.url.replaceAll(')', '%29')}) — ${markdownText(source.locator)}; ${markdownText(sourceProvenance(source))}`
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
      return `- **${claim.claimId}**: ${markdownText(claim.text)} — ${links.join(', ')}${independenceNote(claim, byId)}${contestedNote(claim)}`
    })
    sections.push(`## Claim trace\n${lines.join('\n')}`)
  }
  return sections.join('\n\n')
}

/**
 * The exact bytes a Task stores for one submitted Artifact.
 *
 * Raven owns the canonical layout because Completion compares byte hashes: if
 * each executor laid out its own text, one model's line-wrapping habits would
 * decide whether the final Artifact matches its Checkpoint. Normalizing here
 * means the render shows the stored bytes, the agent edits those exact bytes on
 * the next round, and one sentence per line makes a line the smallest edit unit.
 */
function storedArtifact(value: unknown, layout: ProseLayoutOptions): {
  readonly text: string
  readonly report: ProseLayoutReport
} {
  const submitted = boundedText(value, 'artifact', RAVEN_LIMITS.artifactChars)
  const text = layoutProse(submitted, layout)
  if (text.length > RAVEN_LIMITS.artifactChars) {
    throw new RavenTypeError(
      'limit-exceeded',
      `artifact must be at most ${RAVEN_LIMITS.artifactChars} characters after the Prose Layout`
      + ' puts one sentence on each line; shorten it rather than packing sentences together',
    )
  }
  return { text, report: proseLayoutReport(submitted, layout) }
}

/**
 * The Task material a drafter may see. Steering is included because a variant
 * that ignores the user's latest correction is worse than no variant, and the
 * current Artifact because most rounds revise rather than start over.
 */
function draftContext(state: RavenTaskState): string {
  const parts = [
    `Outcome: ${state.outcome}`,
    `Task request:\n${state.request}`,
  ]
  const steering = state.steering.slice(-4)
  if (steering.length > 0) {
    parts.push(`User corrections, most recent last:\n${steering.map(item => `- ${item.correction}`).join('\n')}`)
  }
  if (state.latestArtifact !== null) {
    parts.push(`Current Artifact:\n${state.latestArtifact}`)
  }
  return parts.join('\n\n')
}

function draftSystemPrompt(layout: ProseLayoutOptions): string {
  return [
    'You are drafting candidate prose for one section of a larger work.',
    'Return ONLY the prose. No preamble, no explanation of your choices, no meta-commentary.',
    `The output format is ${layout.format === 'markdown' ? 'Markdown' : 'plain text'}.`,
    ...(layout.layout === 'sentence-per-line'
      ? ['Put exactly one sentence on each line so the reader can compare candidates line by line.']
      : []),
    'Never invent a citation, a statistic, a quotation, or a source. Where the material you were given'
    + ' does not support a statement, write the statement without a citation, or leave the gap visible.',
  ].join('\n')
}

function assertStateBudget(state: RavenTaskState, maximum: number): void {
  const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8')
  if (bytes > maximum) {
    throw new RavenError(
      'limit-exceeded',
      `Raven Task state would occupy ${bytes} bytes, above this mutation's durable snapshot budget of`
      + ` ${maximum} (${RAVEN_LIMITS.stateBytes} total with`
      + ` ${RAVEN_LIMITS.stateCompletionReserveBytes} reserved for Completion).`
      + ' Shorten or split Sources, Claims, excerpts, corrections, or Limitations',
    )
  }
}

export function createRavenEngine(options: RavenEngineOptions): RavenEngine {
  const dispatchUnchecked: RavenEngine['dispatch'] = async (previous, input, execution) => {
      execution.signal.throwIfAborted()
      const args = record(input, 'Raven action')
      const action = requiredText(args.action, 'action')
      const allowedFields = ACTION_FIELDS[action]
      if (allowedFields === undefined) throw new RavenTypeError('unsupported-action', `Unsupported Raven action: ${action}`)
      assertOnlyKeys(args, allowedFields, `Raven ${action} action`)

      if (action === 'start') {
        if (previous?.phase === 'active') {
          throw new RavenError('task-already-active', `Raven Task ${previous.taskId} is already active`)
        }
        const outcome = member<RavenOutcome>(args.outcome, OUTCOMES, 'outcome')
        const request = boundedText(args.request, 'request', RAVEN_LIMITS.requestChars)
        const grounding = args.grounding === undefined
          ? defaultGrounding(outcome)
          : member<GroundingPolicy>(args.grounding, GROUNDING_POLICIES, 'grounding')
        // The evidence floor belongs to the Outcome, not to the executor's convenience.
        // `research` and `academic-writing` are defined by external evidence, so they may
        // narrow the floor to `optional` but may never switch it off entirely.
        if (grounding === 'none' && defaultGrounding(outcome) === 'required') {
          throw new RavenError('invalid-value', `a ${outcome} Task cannot disable its evidence floor; use grounding=optional or start a general-writing Task`)
        }
        const sourcePolicy = parseSourcePolicy(args.sourcePolicy, EMPTY_SOURCE_POLICY)
        const ordinal = (previous?.ordinal ?? 0) + 1
        const at = options.now()
        const state: RavenTaskState = {
          schemaVersion: 2,
          taskId: taskId(execution.sessionId, ordinal),
          ordinal,
          outcome,
          request,
          grounding,
          sourcePolicy,
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
        if (previous === null) throw new RavenError('task-not-found', 'No Raven Task exists in this session')
        if (args.taskId !== undefined && requiredText(args.taskId, 'taskId') !== previous.taskId) {
          throw new RavenError('task-not-found', `Raven Task ${String(args.taskId)} was not found in this session`)
        }
        return {
          status: previous.phase,
          state: previous,
          message: `Raven Task ${previous.taskId} is ${previous.phase}.`,
          issues: [],
        }
      }

      if (action === 'discover') {
        const state = requireActiveTask(previous, args.taskId)
        const limits = options.searchLimits?.() ?? DEFAULT_SEARCH_LIMITS
        const maxQueries = limits.maxQueries > 0 ? limits.maxQueries : RAVEN_LIMITS.searchQueries
        const maxResults = limits.maxResults > 0 ? limits.maxResults : RAVEN_LIMITS.searchResults
        const raw = optionalArray(args.queries, 'queries')
        if (raw.length === 0) throw new RavenTypeError('invalid-value', 'queries must contain at least one query')
        // Bound the batch BEFORE deduplicating, exactly as the Harness web_search
        // tool does: repeating one query spends its slot instead of buying extra
        // breadth, so the advertised bound means the same thing on both sides.
        if (raw.length > maxQueries) {
          throw new RavenTypeError(
            'limit-exceeded',
            `queries must contain at most ${maxQueries} ${maxQueries === 1 ? 'query' : 'queries'};`
            + ' issue complementary queries in one call rather than one query per call',
          )
        }
        const queries = [...new Set(raw.map((query, index) =>
          boundedText(query, `queries[${index}]`, RAVEN_LIMITS.searchQueryChars)))]
        const outcome = await (options.sourceSearcher ?? NO_SEARCHER).search({ queries, maxResults }, execution.signal)
        execution.signal.throwIfAborted()
        const at = options.now()
        // One append policy for the whole engine. discover used to drop silently at
        // the cap while parseLimitations and propagateSourceChecks threw; a Limitation
        // is a record ABOUT a failure, so losing the Task over it is worse than losing
        // the record -- but the drop has to be visible rather than silent.
        const discovered: Omit<RavenLimitation, 'limitationId' | 'createdAt'>[] = []
        if (outcome.unavailable !== undefined) {
          discovered.push({
            kind: 'tool',
            detail: `Lead discovery is unavailable: ${outcome.unavailable}`.slice(0, RAVEN_LIMITS.limitationDetailChars),
          })
        }
        for (const failure of outcome.failures) {
          discovered.push({
            kind: 'tool',
            detail: `Lead discovery query "${failure.query}" failed: ${failure.detail}`
              .slice(0, RAVEN_LIMITS.limitationDetailChars),
          })
        }
        const appendedDiscovery = appendLimitations(state.limitations, discovered, at)
        const limitations = appendedDiscovery.limitations
        // A failed batch is a Task fact, so it changes the Task; a clean batch
        // discovers nothing the Task owns yet and leaves the revision alone.
        const changed = limitations.length !== state.limitations.length
        const next: RavenTaskState = changed
          ? { ...state, limitations, revision: state.revision + 1, updatedAt: at }
          : state
        const issues: string[] = [
          'Leads are not Sources: open each Lead and record a verbatim excerpt before it can support a Claim.',
          ...limitationCapIssue(appendedDiscovery.dropped),
        ]
        if (outcome.failures.length > 0) {
          issues.push(
            `${outcome.failures.length} quer${outcome.failures.length === 1 ? 'y' : 'ies'} failed and are recorded as Limitations;`
            + ' a query that could not run is not evidence that nothing exists',
          )
        }
        if (outcome.truncated) {
          issues.push('the candidate list was truncated; narrow or re-aim the queries instead of treating the visible set as exhaustive')
        }
        if (outcome.leads.length === 0 && outcome.unavailable === undefined && outcome.failures.length === 0) {
          issues.push('no candidate was returned; rephrase or widen the queries, and record a coverage failure only after searching for material that would exist if the claim were true')
        }
        const message = outcome.unavailable === undefined
          ? `Raven Task ${state.taskId}: ${outcome.leads.length} Lead(s) from ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}.`
          : `Lead discovery did not run for Raven Task ${state.taskId}.`
        return {
          status: 'active',
          state: next,
          message,
          issues,
          leads: outcome,
        }
      }

      if (action === 'draft') {
        const state = requireActiveTask(previous, args.taskId)
        const layout = options.proseLayout?.() ?? DEFAULT_PROSE_LAYOUT
        const limits = options.draftLimits?.() ?? DEFAULT_DRAFT_LIMITS
        const instruction = boundedText(args.instruction, 'instruction', RAVEN_LIMITS.draftInstructionChars)
        const allowed = new Map(limits.routes.map(route => [formatDraftRoute(route), route]))
        const requested = optionalArray(args.routes, 'routes').map((raw, index) => {
          const spec = requiredText(raw, `routes[${index}]`)
          const route = allowed.get(spec)
          // Naming a model is naming spend and a data path, so the deployment's
          // list is the whole universe: an unknown route is refused with the
          // configured set named, never quietly substituted with a default.
          if (route === undefined) {
            throw new RavenTypeError(
              'invalid-value',
              `routes[${index}] "${spec}" is not configured for this deployment.`
              + ` Configured route(s): ${allowed.size === 0 ? 'none' : [...allowed.keys()].join(', ')}`,
            )
          }
          return route
        })
        const routes = requested.length > 0 ? [...new Set(requested)] : limits.routes
        if (routes.length > RAVEN_LIMITS.draftRoutes) {
          throw new RavenTypeError('limit-exceeded', `routes must name at most ${RAVEN_LIMITS.draftRoutes} configured route(s)`)
        }
        const outcome: DraftResult = routes.length === 0
          ? {
              variants: [],
              unavailable: 'no Draft Variant route is configured for this deployment'
                + ' (set raven-research.draftRoutes to one or more provider/model routes)',
            }
          : await (options.draftGenerator ?? NO_DRAFTER).generate(
              {
                instruction,
                routes,
                system: draftSystemPrompt(layout),
                context: draftContext(state),
                maxTokens: limits.maxTokens > 0 ? limits.maxTokens : DEFAULT_DRAFT_LIMITS.maxTokens,
              },
              execution.signal,
            )
        execution.signal.throwIfAborted()
        const at = options.now()
        const laid: DraftResult = {
          ...outcome,
          variants: outcome.variants.map(variant => variant.text === undefined
            ? variant
            : { ...variant, text: layoutProse(variant.text.slice(0, RAVEN_LIMITS.draftVariantChars), layout) }),
        }
        const rounds = [...(state.drafts ?? [])]
        if (rounds.length >= RAVEN_LIMITS.draftRounds) rounds.shift()
        rounds.push({
          ordinal: rounds.length === 0 ? 1 : (rounds.at(-1)?.ordinal ?? 0) + 1,
          instruction,
          requestedAt: at,
          routes: laid.variants.map(variant => ({
            provider: variant.route.provider,
            model: variant.route.model,
            status: variant.status,
            chars: variant.text?.length ?? 0,
          })),
        })
        // A comparison round changes the Task's provenance but publishes nothing;
        // the Artifact, the evidence, and the Checkpoint list are all untouched.
        const next: RavenTaskState = laid.variants.length === 0
          ? state
          : { ...state, drafts: rounds, revision: state.revision + 1, updatedAt: at }
        const drafted = laid.variants.filter(variant => variant.status === 'drafted').length
        // A round where EVERY route failed is a failed round, not a comparison of
        // nothing. Reporting it as `0 Draft Variant(s) from 2 route(s)` reads as an
        // empty success, and the partial-failure line ('compare the ones that did')
        // points the agent at a comparison set that does not exist. Both are wrong
        // here, so a total failure gets its own message and its own issue.
        const allRoutesFailed = laid.variants.length > 0 && drafted === 0
        return {
          status: 'active',
          state: next,
          message: laid.unavailable !== undefined
            ? `Draft Variants did not run for Raven Task ${state.taskId}.`
            : allRoutesFailed
              ? `Raven Task ${state.taskId}: no route produced a Draft Variant; all ${laid.variants.length} route(s) failed.`
              : `Raven Task ${state.taskId}: ${drafted} Draft Variant(s) from ${laid.variants.length} route(s).`,
          issues: [
            'Draft Variants are candidates, not Checkpoints: adopt wording into a Checkpoint,'
            + ' and support every factual sentence with a recorded Source excerpt before publishing it.',
            ...(allRoutesFailed
              ? ['no route produced a variant, so there is nothing to compare; re-run the round or write the'
                + ' section directly rather than treating the empty set as a result']
              : laid.variants.some(variant => variant.status === 'failed')
                ? ['one or more routes produced no variant; compare the ones that did rather than waiting for a full set']
                : []),
          ],
          variants: laid,
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
        if (state.phase !== 'active') throw new RavenError('task-phase', `Raven Task ${state.taskId} is ${state.phase}`)
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

      if (action === 'export') {
        const state = requireTask(previous, args.taskId)
        if (state.latestArtifact === null) {
          return {
            status: 'needs-revision',
            state,
            message: `Raven Task ${state.taskId} has no Artifact to export yet.`,
            issues: ['publish a Checkpoint before exporting the Task to a wiki'],
          }
        }
        const title = optionalBoundedText(args.title, 'title', RAVEN_LIMITS.summaryChars)
          ?? state.request.split('\n')[0]?.slice(0, 120)
          ?? state.taskId
        const tags = optionalArray(args.tags, 'tags').map((raw) => {
          const tag = requiredText(raw, 'tags[]')
          if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tag)) {
            throw new RavenTypeError('invalid-value', 'tags[] must be lowercase letters, digits, or hyphens and appear in the wiki taxonomy')
          }
          return tag
        })
        if (args.init !== undefined && typeof args.init !== 'boolean') {
          throw new RavenTypeError('invalid-value', 'init must be a boolean')
        }
        const wiki = renderWikiPages(
          state,
          renderArtifact(state.latestArtifact, state.sources, state.claims),
          {
            title,
            tags: tags.length > 0 ? tags : [state.outcome],
            init: args.init === true,
            at: options.now(),
          },
        )
        return {
          status: state.phase === 'active' ? 'active' : state.phase,
          state,
          message: `Exported Raven Task ${state.taskId} as ${wiki.pages.length} llm-wiki page(s); write them and append the log entry.`,
          issues: [],
          wiki,
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
        if (state.phase !== 'stopped') throw new RavenError('task-phase', `Raven Task ${state.taskId} is ${state.phase}`)
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
          throw new RavenError('limit-exceeded', `Raven Task may retain at most ${RAVEN_LIMITS.steeringRevisions} Steering Revisions`)
        }
        const at = options.now()
        const steeringRevision = state.steeringRevision + 1
        const sourcePolicy = parseSourcePolicy(args.sourcePolicy, state.sourcePolicy)
        const sources = args.sourcePolicy === undefined
          ? state.sources
          : state.sources.map((source): RavenSourceRecord => {
              const violation = sourcePolicyViolation(source, sourcePolicy)
              if (violation === undefined) {
                const wasPolicyExcluded = source.check.status === 'unavailable'
                  && source.check.detail?.startsWith('Task Source Policy excludes ') === true
                return wasPolicyExcluded ? { ...source, check: { status: 'unchecked' } } : source
              }
              return {
                    ...source,
                    check: {
                      status: 'unavailable',
                      checkedAt: at,
                      detail: `Task Source Policy excludes ${source.resource.origin} resource ${source.resource.uri}: ${violation}`,
                    },
                  }
            })
        const propagated = args.sourcePolicy === undefined
          ? { claims: [...state.claims], limitations: [...state.limitations], droppedLimitations: 0 }
          : propagateSourceChecks(state.claims, state.limitations, sources, at)
        const next: RavenTaskState = {
          ...state,
          revision: state.revision + 1,
          steeringRevision,
          steering: [...state.steering, {
            revision: steeringRevision,
            correction,
            createdAt: at,
            ...(args.sourcePolicy === undefined ? {} : { sourcePolicy }),
          }],
          sourcePolicy,
          sources,
          claims: propagated.claims,
          limitations: propagated.limitations,
          verification: null,
          finalArtifactSha256: null,
          updatedAt: at,
        }
        return {
          status: 'active',
          state: next,
          message: `Applied Steering Revision ${steeringRevision} to Raven Task ${state.taskId}; continue the same Task.`,
          issues: limitationCapIssue(propagated.droppedLimitations),
        }
      }

      if (action === 'checkpoint') {
        const state = requireActiveTask(previous, args.taskId)
        const at = options.now()
        const stage = member<RavenStage>(args.stage, RAVEN_STAGES, 'stage')
        const summary = boundedText(args.summary, 'summary', RAVEN_LIMITS.summaryChars)
        const layout = options.proseLayout?.() ?? DEFAULT_PROSE_LAYOUT
        const stored = storedArtifact(args.artifact, layout)
        const artifact = stored.text
        const artifactSha256 = sha256(artifact)
        const parsedSources = parseSources(args.sources, state.sources, at)
        const knownSourceIds = new Set(parsedSources.map(source => source.sourceId))
        const claims = parseClaims(args.claims, state.claims, knownSourceIds)
        const parsedLimitations = parseLimitations(args.failures, state.limitations, knownSourceIds, at)
        const limitations = parsedLimitations.limitations
        validateArtifactCitations(artifact, parsedSources, claims)
        const relevant = relevantSources(artifact, parsedSources, claims)
        const verified = await checkSources(
          options.sourceVerifier,
          parsedSources,
          relevant,
          state.sourcePolicy,
          artifactSha256,
          at,
          execution,
        )
        const unverified = verified.sources.filter(source => relevant.some(candidate => candidate.sourceId === source.sourceId)
          && source.check.status !== 'reachable')
        if (unverified.length > 0) {
          // Rejection with NO state loss, which is what architecture.md promises.
          // This used to rebuild from the PRIOR state, so one unfetchable Source
          // threw away every Source, Claim, Limitation and Artifact byte in the
          // same call and the agent had to resend all of it. The parsed
          // contribution is retained WITH its check results; only the Checkpoint
          // is withheld, because publishing it is the thing the failure forbids.
          // The Artifact is deliberately NOT stored as latestArtifact: the codec
          // ties latestArtifact to the newest Checkpoint's hash, and an
          // unpublished Artifact has no Checkpoint to be tied to.
          const propagated = propagateSourceChecks(claims, limitations, verified.sources, at)
          const checkedState: RavenTaskState = {
            ...state,
            revision: state.revision + 1,
            sources: verified.sources,
            claims: propagated.claims,
            limitations: propagated.limitations,
            verification: null,
            finalArtifactSha256: null,
            updatedAt: at,
          }
          return {
            status: 'needs-revision',
            state: checkedState,
            message: `Raven Task ${state.taskId} cannot publish an externally grounded Checkpoint yet;`
              + ' the submitted Sources, Claims, and Limitations were retained, so resend only the repaired evidence and the Artifact.',
            issues: [
              ...unverified.map((source) => {
                const detail = source.check.status === 'unchecked'
                  ? 'source was not checked'
                  : source.check.detail ?? `source check was ${source.check.status}`
                return `source ${source.sourceId} failed evidence verification: ${detail}`
              }),
              ...limitationCapIssue(parsedLimitations.dropped + propagated.droppedLimitations),
            ],
          }
        }
        const sources = verified.sources
        const propagated = propagateSourceChecks(claims, limitations, sources, at)
        const revision = state.revision + 1
        const admitted = admitCheckpoint(state, {
          checkpointId: checkpointId(state.taskId, revision),
          ordinal: nextCheckpointOrdinal(state.checkpoints),
          stage,
          summary,
          artifactSha256,
          artifactChars: artifact.length,
          steeringRevision: state.steeringRevision,
          createdAt: at,
          proseLayout: layout.layout,
          // Reserve one slot for Completion, so the Task can always finish: a
          // checkpoint that filled the last slot is what made the cap terminal.
        }, 1)
        const next: RavenTaskState = {
          ...state,
          revision,
          checkpoints: admitted.checkpoints,
          sources,
          claims: propagated.claims,
          limitations: propagated.limitations,
          latestArtifact: artifact,
          verification: null,
          finalArtifactSha256: null,
          updatedAt: at,
        }
        return {
          status: 'active',
          state: next,
          message: `Published Raven Checkpoint ${admitted.checkpoints.at(-1)?.ordinal ?? 0} for ${state.taskId}; the Task remains active.`,
          issues: [
            ...admitted.issues,
            ...limitationCapIssue(parsedLimitations.dropped + propagated.droppedLimitations),
          ],
          renderedArtifact: renderArtifact(artifact, sources, propagated.claims),
          ...(stored.report.changed
            ? {
                relaidArtifact: {
                  sourceLines: stored.report.sourceLines,
                  laidOutLines: stored.report.laidOutLines,
                },
              }
            : {}),
        }
      }

      if (action === 'complete') {
        const state = requireActiveTask(previous, args.taskId)
        const layout = options.proseLayout?.() ?? DEFAULT_PROSE_LAYOUT
        const stored = storedArtifact(args.artifact, layout)
        const artifact = stored.text
        const artifactSha256 = sha256(artifact)
        const issues: string[] = []
        if (state.checkpoints.length === 0) issues.push('publish at least one useful Checkpoint before Completion')
        // No slot check. Completion refusing for want of a Checkpoint slot made the
        // cap a terminal deadlock; admitCheckpoint trims an older descriptor instead.
        const latestCheckpoint = state.checkpoints.at(-1)
        if (latestCheckpoint !== undefined && latestCheckpoint.steeringRevision !== state.steeringRevision) {
          issues.push('publish a Checkpoint that applies the latest Steering Revision before Completion')
        }
        if (latestCheckpoint !== undefined && latestCheckpoint.artifactSha256 !== artifactSha256) {
          const stored = latestCheckpoint.proseLayout ?? 'as-written'
          // A layout change rewrites the bytes without anyone editing the text.
          // Reported as its own cause so it does not read as an unauthorized
          // final edit, which is what the generic message would accuse.
          issues.push(stored === layout.layout
            ? 'the exact latest Checkpoint Artifact must be completed; publish substantive final edits as a new Checkpoint first'
            : `the Prose Layout changed from ${stored} to ${layout.layout} after Checkpoint ${latestCheckpoint.ordinal},`
              + ' so the stored bytes no longer match; publish one Checkpoint under the current layout and complete those bytes')
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
          state.sourcePolicy,
          artifactSha256,
          at,
          execution,
        )
        const unusable = verified.sources.filter(source => relevant.some(candidate => candidate.sourceId === source.sourceId)
          && source.check.status !== 'reachable')
        if (unusable.length > 0) {
          // The same no-state-loss rule as `checkpoint`: the verification results
          // and the Claim deferrals computed from them are retained, so the agent
          // repairs the named Source instead of re-establishing the Task.
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
            issues: [
              ...unusable.map((source) => {
                const detail = source.check.status === 'unchecked'
                  ? 'source was not checked'
                  : source.check.detail ?? `source check was ${source.check.status}`
                return `source ${source.sourceId} failed remote verification: ${detail}`
              }),
              ...limitationCapIssue(propagated.droppedLimitations),
            ],
          }
        }

        const propagated = propagateSourceChecks(state.claims, state.limitations, verified.sources, at)
        const hasDeferredClaims = propagated.claims.some(claim => claim.disposition === 'deferred')
        const phase = verified.receipt.unavailable > 0 || propagated.limitations.length > 0 || hasDeferredClaims
          ? 'completed-with-limits'
          : 'completed'
        const revision = state.revision + 1
        const admitted = admitCheckpoint(state, {
          checkpointId: checkpointId(state.taskId, revision),
          ordinal: nextCheckpointOrdinal(state.checkpoints),
          stage: 'verify',
          summary: phase === 'completed' ? 'Verified final Artifact.' : 'Final Artifact with verification limits.',
          artifactSha256,
          artifactChars: artifact.length,
          steeringRevision: state.steeringRevision,
          createdAt: at,
          proseLayout: layout.layout,
        }, 0)
        const completed: RavenTaskState = {
          ...state,
          phase,
          revision,
          checkpoints: admitted.checkpoints,
          sources: verified.sources,
          claims: propagated.claims,
          limitations: propagated.limitations,
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
            ? admitted.issues
            : [
                ...admitted.issues,
                ...propagated.limitations.map(item => item.detail),
                ...(verified.receipt.unavailable === 0
                  ? []
                  : [`${verified.receipt.unavailable} Source reference(s) could not be remotely verified`]),
                ...(hasDeferredClaims ? ['one or more Claims remain deferred'] : []),
              ],
          renderedArtifact: renderArtifact(artifact, verified.sources, propagated.claims),
        }
      }

      throw new RavenTypeError('unsupported-action', `Unsupported Raven action: ${action}`)
  }
  return {
    async dispatch(previous, input, execution) {
      const result = await dispatchUnchecked(previous, input, execution)
      const changed = previous === null
        || previous.taskId !== result.state.taskId
        || previous.revision !== result.state.revision
      if (changed) {
        const action = (input as Record<string, unknown>).action
        const maximum = action === 'complete'
          ? RAVEN_LIMITS.stateBytes
          : RAVEN_LIMITS.stateBytes - RAVEN_LIMITS.stateCompletionReserveBytes
        assertStateBudget(result.state, maximum)
      }
      return result
    },
  }
}
