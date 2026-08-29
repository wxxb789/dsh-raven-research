import { settleWithAbort } from './abort.js'
import {
  RAVEN_LIMITS,
  SOURCE_ORIGINS,
  type RavenExecution,
  type RavenSourceRepresentation,
  type RavenSourceResource,
  type RavenTaskState,
  RavenTypeError,
  type SourceCheckRequest,
  type SourceCheckResult,
  type SourceVerifier,
} from './domain.js'
import { markdownText, renderWikiPage, sha256Hex, wikiSlug, wikiYamlList, wikiYamlString } from './wiki-format.js'
import { sourceInspectionSha256 } from './source.js'
import { canonicalSourceUrl } from './url.js'
import { renderWikiRawPages, WIKI_LOG_SEED, wikiConfidence } from './wiki.js'

export const WORKSPACE_PAGE_TYPES = ['query', 'concept', 'entity', 'comparison'] as const
export type RavenWorkspacePageType = typeof WORKSPACE_PAGE_TYPES[number]

export const WORKSPACE_ACTION_FIELDS = {
  initialize: ['action', 'files'],
  adopt: ['action', 'kind', 'files', 'documents'],
  ingest: ['action', 'files', 'documents'],
  grow: ['action', 'files', 'taskId', 'pageType', 'title', 'tags'],
  maintain: ['action', 'files', 'complete'],
  health: ['action', 'files', 'complete'],
  reuse: ['action', 'files', 'query', 'freshness', 'maxAgeDays', 'maxResults'],
} as const satisfies Readonly<Record<string, readonly string[]>>
export type RavenWorkspaceAction = keyof typeof WORKSPACE_ACTION_FIELDS

export const RAVEN_WORKSPACE_LIMITS = {
  files: 512,
  fileChars: 200_000,
  totalFileChars: 4_000_000,
  documents: 64,
  queryChars: 2_000,
  queryTerms: 32,
  maxResults: 20,
} as const

export interface RavenWorkspaceFile {
  readonly path: string
  readonly content: string
}

export interface RavenWorkspaceDocument {
  readonly title: string
  readonly resource: RavenSourceResource
  readonly representation: RavenSourceRepresentation | null
  readonly asOf?: string
}

export interface RavenWorkspaceIssue {
  readonly severity: 'error' | 'warning'
  readonly code: string
  readonly detail: string
  readonly path?: string
}

export interface RavenWorkspaceHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy'
  readonly issues: readonly RavenWorkspaceIssue[]
}

export interface RavenWorkspaceCandidate {
  readonly path: string
  readonly title: string
  readonly type: RavenWorkspacePageType
  readonly summary: string
  readonly confidence: 'high' | 'medium' | 'low' | 'unknown'
  readonly sources: readonly string[]
  readonly updated?: string
  readonly knowledgeStatus: 'stored'
  readonly freshness: 'current' | 'stale' | 'undated'
  readonly requiresFreshVerification: boolean
  readonly score: number
}

export interface RavenWorkspacePrecondition {
  readonly path: string
  readonly expected: 'absent' | `sha256:${string}`
}

export interface RavenWorkspaceResult {
  readonly status: 'ready' | 'needs-revision'
  readonly action: RavenWorkspaceAction
  readonly message: string
  /** Conditional write plan. Re-read each path and enforce its matching precondition before writing. */
  readonly pages: readonly RavenWorkspaceFile[]
  readonly preconditions: readonly RavenWorkspacePrecondition[]
  /** Append only when its embedded operation marker is absent from wiki/log.md. */
  readonly logEntry?: string
  readonly issues: readonly RavenWorkspaceIssue[]
  readonly health?: RavenWorkspaceHealth
  readonly candidates?: readonly RavenWorkspaceCandidate[]
}

export interface RavenWorkspaceTaskContribution {
  readonly state: RavenTaskState
  readonly renderedArtifact: string
}

export interface RavenWorkspaceEngineOptions {
  readonly now: () => string
  readonly sourceVerifier: SourceVerifier
}

export interface RavenWorkspaceEngine {
  dispatch(
    input: unknown,
    execution: RavenExecution,
    contribution?: RavenWorkspaceTaskContribution,
  ): Promise<RavenWorkspaceResult>
}

interface ParsedPage {
  readonly fields: Readonly<Record<string, string>>
  readonly lists: Readonly<Record<string, readonly string[]>>
  readonly body: string
}

interface FrontmatterField {
  readonly key: string
  readonly start: number
  readonly end: number
  readonly value: string
  readonly continuation: readonly string[]
}

interface VerifiedDocument {
  readonly document: RavenWorkspaceDocument
  readonly check: SourceCheckResult
}

const STRUCTURE_PATHS = ['wiki/SCHEMA.md', 'wiki/index.md', 'wiki/log.md'] as const
const GENERATED_INDEX_MARKER = '<!-- raven-workspace-index:v1 -->'
const SINGLE_CJK_TOKEN = /^(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Bopomofo})$/u
const PAGE_DIRECTORIES: Readonly<Record<RavenWorkspacePageType, string>> = {
  query: 'queries',
  concept: 'concepts',
  entity: 'entities',
  comparison: 'comparisons',
}
const PAGE_HEADINGS: Readonly<Record<RavenWorkspacePageType, string>> = {
  query: 'Queries',
  concept: 'Concepts',
  entity: 'Entities',
  comparison: 'Comparisons',
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RavenTypeError('invalid-value', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new RavenTypeError(
      'unknown-field',
      `${label} contains unknown field(s): ${unknown.join(', ')}. Accepted field(s): ${allowed.join(', ')}`,
    )
  }
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RavenTypeError('invalid-value', `${label} must be a non-empty string`)
  }
  if (value.length > max) throw new RavenTypeError('limit-exceeded', `${label} must be at most ${max} characters`)
  return value
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, label, max)
}

function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new RavenTypeError('invalid-value', `${label} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new RavenTypeError('invalid-value', `${label} must be an array`)
  return value
}

function requireCompleteSnapshot(input: Record<string, unknown>, action: 'health' | 'maintain'): void {
  if (input.complete !== true) {
    throw new RavenTypeError('invalid-value', `${action} requires complete=true for the full Workspace Markdown snapshot`)
  }
}

function workspacePath(value: unknown, label = 'file.path'): string {
  const path = requiredText(value, label, 512)
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new RavenTypeError('invalid-value', `${label} must be a slash-separated path below wiki/`)
  }
  const segments = path.split('/')
  if (segments[0] !== 'wiki' || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new RavenTypeError('invalid-value', `${label} must stay below wiki/ without empty, dot, or parent segments`)
  }
  if (!path.endsWith('.md')) throw new RavenTypeError('invalid-value', `${label} must identify a Markdown file`)
  return path
}

function parseFiles(value: unknown): RavenWorkspaceFile[] {
  const rawFiles = value === undefined ? [] : array(value, 'files')
  if (rawFiles.length > RAVEN_WORKSPACE_LIMITS.files) {
    throw new RavenTypeError('limit-exceeded', `files may contain at most ${RAVEN_WORKSPACE_LIMITS.files} entries`)
  }
  const files: RavenWorkspaceFile[] = []
  const seen = new Set<string>()
  const seenCaseFolded = new Map<string, string>()
  let total = 0
  for (const [index, raw] of rawFiles.entries()) {
    const input = record(raw, `files[${index}]`)
    assertOnlyKeys(input, ['path', 'content'], `files[${index}]`)
    const path = workspacePath(input.path, `files[${index}].path`)
    if (seen.has(path)) throw new RavenTypeError('invalid-value', `files contains duplicate path ${path}`)
    seen.add(path)
    const folded = path.toLowerCase()
    const casePeer = seenCaseFolded.get(folded)
    if (casePeer !== undefined) {
      throw new RavenTypeError('invalid-value', `files contains case-insensitive path collision: ${casePeer} and ${path}`)
    }
    seenCaseFolded.set(folded, path)
    if (typeof input.content !== 'string') {
      throw new RavenTypeError('invalid-value', `files[${index}].content must be a string`)
    }
    if (input.content.length > RAVEN_WORKSPACE_LIMITS.fileChars) {
      throw new RavenTypeError(
        'limit-exceeded',
        `files[${index}].content must be at most ${RAVEN_WORKSPACE_LIMITS.fileChars} characters`,
      )
    }
    total += input.content.length
    if (total > RAVEN_WORKSPACE_LIMITS.totalFileChars) {
      throw new RavenTypeError(
        'limit-exceeded',
        `files content may total at most ${RAVEN_WORKSPACE_LIMITS.totalFileChars} characters`,
      )
    }
    files.push({ path, content: input.content })
  }
  return files
}

function canonicalResource(value: unknown, label: string): RavenSourceResource {
  const input = record(value, label)
  assertOnlyKeys(input, ['origin', 'uri', 'mediaType', 'sourceName'], label)
  const origin = member(input.origin, SOURCE_ORIGINS, `${label}.origin`)
  const uri = requiredText(input.uri, `${label}.uri`, RAVEN_LIMITS.sourcePolicyStringChars)
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new RavenTypeError('invalid-value', `${label}.uri must be absolute`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new RavenTypeError('invalid-value', `${label}.uri must not contain credentials`)
  }
  const schemes: Record<typeof origin, readonly string[]> = {
    web: ['http:', 'https:'],
    local: ['file:'],
    'llm-wiki': ['file:', 'llm-wiki:'],
    mcp: ['mcp:'],
  }
  if (!schemes[origin].includes(parsed.protocol)) {
    throw new RavenTypeError('invalid-value', `${label}.uri has a scheme incompatible with ${origin}`)
  }
  const canonicalUri = origin === 'web' ? canonicalSourceUrl(uri) : parsed.href
  const mediaType = optionalText(input.mediaType, `${label}.mediaType`, RAVEN_LIMITS.sourceMediaTypeChars)
  const sourceName = optionalText(input.sourceName, `${label}.sourceName`, RAVEN_LIMITS.sourceNameChars)
  if ((origin === 'llm-wiki' || origin === 'mcp') && sourceName === undefined) {
    throw new RavenTypeError('invalid-value', `${label}.sourceName is required for ${origin}`)
  }
  if ((origin === 'web' || origin === 'local') && sourceName !== undefined) {
    throw new RavenTypeError('invalid-value', `${label}.sourceName is not valid for ${origin}`)
  }
  return {
    origin,
    uri: canonicalUri,
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(sourceName === undefined ? {} : { sourceName }),
  }
}

function parseRepresentation(value: unknown, resource: RavenSourceResource, label: string): RavenSourceRepresentation | null {
  if (value === null) return null
  const input = record(value, label)
  assertOnlyKeys(input, ['format', 'derivation', 'coverage', 'producedBy', 'inspectionCallId', 'markdown'], label)
  if (input.format !== 'markdown') throw new RavenTypeError('invalid-value', `${label}.format must be markdown`)
  const derivation = member(input.derivation, ['original', 'converted'] as const, `${label}.derivation`)
  const coverage = member(input.coverage, ['full', 'segment', 'unknown'] as const, `${label}.coverage`)
  const producedBy = requiredText(input.producedBy, `${label}.producedBy`, RAVEN_LIMITS.sourceProducedByChars)
  const inspectionCallId = optionalText(
    input.inspectionCallId,
    `${label}.inspectionCallId`,
    RAVEN_LIMITS.sourceInspectionCallIdChars,
  )
  if (typeof input.markdown !== 'string') {
    throw new RavenTypeError('invalid-value', `${label}.markdown must contain the exact normalized Markdown bytes`)
  }
  if (input.markdown.length > RAVEN_LIMITS.sourceMarkdownChars) {
    throw new RavenTypeError(
      'limit-exceeded',
      `${label}.markdown must be at most ${RAVEN_LIMITS.sourceMarkdownChars} characters`,
    )
  }
  if (resource.origin !== 'web' && inspectionCallId === undefined) {
    throw new RavenTypeError('invalid-value', `${label}.inspectionCallId is required for non-web material`)
  }
  const mediaType = resource.mediaType?.split(';', 1)[0]?.trim().toLowerCase()
  if (derivation === 'original' && mediaType !== 'text/markdown') {
    throw new RavenTypeError('invalid-value', `${label}.derivation=original requires resource.mediaType=text/markdown`)
  }
  return {
    format: 'markdown',
    derivation,
    coverage,
    producedBy,
    ...(inspectionCallId === undefined ? {} : { inspectionCallId }),
    markdown: input.markdown,
  }
}

function parseDocuments(value: unknown): RavenWorkspaceDocument[] {
  const rawDocuments = value === undefined ? [] : array(value, 'documents')
  if (rawDocuments.length > RAVEN_WORKSPACE_LIMITS.documents) {
    throw new RavenTypeError('limit-exceeded', `documents may contain at most ${RAVEN_WORKSPACE_LIMITS.documents} entries`)
  }
  const documents: RavenWorkspaceDocument[] = []
  const identities = new Set<string>()
  for (const [index, raw] of rawDocuments.entries()) {
    const label = `documents[${index}]`
    const input = record(raw, label)
    assertOnlyKeys(input, ['title', 'resource', 'representation', 'asOf'], label)
    const resource = canonicalResource(input.resource, `${label}.resource`)
    if (resource.origin === 'web') {
      throw new RavenTypeError(
        'invalid-value',
        `${label}.resource.origin=web is not accepted for direct Workspace adoption or ingest; use grow with a completed Raven Task`,
      )
    }
    if (identities.has(resource.uri)) {
      throw new RavenTypeError('invalid-value', `documents contains duplicate Original Resource ${resource.uri}`)
    }
    identities.add(resource.uri)
    documents.push({
      title: requiredText(input.title, `${label}.title`, RAVEN_LIMITS.sourceTitleChars),
      resource,
      representation: parseRepresentation(input.representation, resource, `${label}.representation`),
      ...(input.asOf === undefined
        ? {}
        : { asOf: requiredText(input.asOf, `${label}.asOf`, RAVEN_LIMITS.sourceAsOfChars) }),
    })
  }
  return documents
}

const MANAGED_LIST_FIELDS = new Set(['tags', 'sources', 'raven_tasks', 'contradictions'])

function frontmatterFields(lines: readonly string[]): FrontmatterField[] {
  const starts: Array<{ readonly key: string; readonly start: number; readonly value: string }> = []
  for (const [index, line] of lines.entries()) {
    const match = /^([a-z0-9_]+):(?:[ \t]*(.*))$/.exec(line)
    if (match !== null) starts.push({ key: match[1] ?? '', start: index, value: (match[2] ?? '').trim() })
  }
  return starts.map((field, index) => {
    const end = starts[index + 1]?.start ?? lines.length
    return { ...field, end, continuation: lines.slice(field.start + 1, end) }
  })
}

function yamlString(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"')) return undefined
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return typeof parsed === 'string' ? parsed : undefined
    } catch {
      return undefined
    }
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) return undefined
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  if (['[', '{', '&', '*', '!', '|', '>'].some(prefix => trimmed.startsWith(prefix))) return undefined
  if (/(?:^|\s)#/.test(trimmed)) return undefined
  return trimmed
}

function flowYamlList(value: string): string[] | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined
  const body = trimmed.slice(1, -1)
  if (body.trim().length === 0) return []
  const rawItems: string[] = []
  let start = 0
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (quote === '"') {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        quote = undefined
      }
      continue
    }
    if (quote === "'") {
      if (character === "'" && body[index + 1] === "'") {
        index += 1
      } else if (character === "'") {
        quote = undefined
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
    } else if (character === ',') {
      rawItems.push(body.slice(start, index))
      start = index + 1
    } else if (character === '[' || character === ']' || character === '{' || character === '}') {
      return undefined
    }
  }
  if (quote !== undefined || escaped) return undefined
  rawItems.push(body.slice(start))
  const items = rawItems.map(yamlString)
  return items.some(item => item === undefined) ? undefined : items as string[]
}

function managedYamlList(field: FrontmatterField): string[] | undefined {
  const structural = field.continuation.filter(line => line.trim().length > 0 && !/^\s*#/.test(line))
  if (field.value.length > 0) {
    if (structural.length > 0) return undefined
    return flowYamlList(field.value)
  }
  const items: string[] = []
  for (const line of structural) {
    const match = /^[ \t]*-[ \t]+(.+)$/.exec(line)
    if (match === null) return undefined
    const item = yamlString(match[1] ?? '')
    if (item === undefined) return undefined
    items.push(item)
  }
  return items
}

function parsePage(content: string): ParsedPage | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content)
  if (match === null) return undefined
  const lines = (match[1] ?? '').split(/\r?\n/)
  const fields: Record<string, string> = {}
  const lists: Record<string, readonly string[]> = {}
  const seenManaged = new Set<string>()
  for (const field of frontmatterFields(lines)) {
    fields[field.key] = field.value
    if (!MANAGED_LIST_FIELDS.has(field.key)) continue
    if (seenManaged.has(field.key)) return undefined
    seenManaged.add(field.key)
    const values = managedYamlList(field)
    if (values === undefined) return undefined
    lists[field.key] = values
  }
  return { fields, lists, body: match[2] ?? '' }
}

function unquote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return yamlString(value) ?? value.trim()
}

function pageList(page: ParsedPage | undefined, key: string): readonly string[] {
  return page?.lists[key] ?? []
}

function fileMap(files: readonly RavenWorkspaceFile[]): Map<string, string> {
  return new Map(files.map(file => [file.path, file.content]))
}

function relativeWikiPath(path: string): string {
  return path.replace(/^wiki\//, '')
}

function operationMarker(id: string): string {
  return `<!-- raven-workspace-op:${id} -->`
}

function logHas(files: readonly RavenWorkspaceFile[], marker: string): boolean {
  return files.find(file => file.path === 'wiki/log.md')?.content.includes(marker) === true
}

function logEntry(at: string, action: string, subject: string, id: string, details: readonly string[]): string {
  const safeSubject = markdownText(subject)
  return [
    `\n## [${at.slice(0, 10)}] ${action} | ${safeSubject}`,
    ...details.map(detail => `- ${detail}`),
    operationMarker(id),
    '',
  ].join('\n')
}

const SCHEMA_SEED = `# Wiki Schema

Markdown files are the source of truth. Generated indexes are disposable derived state and may be rebuilt from pages.

## Layers

- \`raw/\` — immutable source material. New observations create new pages; never rewrite an older capture.
- \`queries/\`, \`concepts/\`, \`entities/\`, \`comparisons/\` — maintained knowledge pages.
- \`SCHEMA.md\`, \`index.md\`, \`log.md\` — conventions, a derived catalog, and append-only history.

## Conventions

- Every knowledge and raw page starts with YAML frontmatter.
- Knowledge pages use \`sources:\` to link immutable raw pages and record \`confidence\` honestly.
- Unresolved disagreement uses \`contested: true\` and retains \`contradictions:\`; history is appended, not erased.
- Existing llm-wiki pages remain valid. Raven adds no required database, embeddings, or proprietary repository manifest.
- Non-Markdown Original Resources are normalized once by the ordinary Source layer; raw pages name that producer and preserve the normalized Markdown bytes.
`

function summaryFromBody(body: string): string {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    if (/^#{1,6}\s+[^\r\n]+$/.test(block.trim())) continue
    const text = block
      .replaceAll(/<!--.*?-->/gs, ' ')
      .replaceAll(/^#{1,6}\s+/gm, '')
      .replaceAll(/^>\s?/gm, '')
      .replaceAll(/\[([^\]]+)]\([^)]*\)/g, '$1')
      .replaceAll(/\[\[([^\]|]+)(?:\|([^\]]+))?]]/g, '$2$1')
      .replaceAll(/[*_`~]/g, '')
      .replaceAll(/\s+/g, ' ')
      .trim()
    if (text.length > 0) return text.slice(0, 200)
  }
  return 'No summary recorded.'
}

function titleFrom(file: RavenWorkspaceFile, parsed: ParsedPage | undefined): string {
  const declared = unquote(parsed?.fields.title)
  if (declared !== undefined && declared.length > 0) return declared
  const heading = /^#\s+(.+)$/m.exec(parsed?.body ?? file.content)?.[1]?.trim()
  return heading === undefined || heading.length === 0 ? file.path.split('/').at(-1)?.replace(/\.md$/, '') ?? file.path : heading
}

function renderIndex(files: readonly RavenWorkspaceFile[]): string {
  const sections: Array<{ readonly heading: string; readonly prefix: string }> = [
    ...WORKSPACE_PAGE_TYPES.map(type => ({
      heading: PAGE_HEADINGS[type],
      prefix: `wiki/${PAGE_DIRECTORIES[type]}/`,
    })),
    { heading: 'Sources', prefix: 'wiki/raw/' },
  ]
  const lines = [
    '# Wiki Index',
    '',
    '> Disposable catalog generated from Markdown pages. Rebuild it whenever pages change.',
    GENERATED_INDEX_MARKER,
  ]
  for (const section of sections) {
    lines.push('', `## ${section.heading}`, '')
    const entries = files
      .filter(file => file.path.startsWith(section.prefix) && file.path.endsWith('.md'))
      .sort((left, right) => left.path.localeCompare(right.path))
    for (const file of entries) {
      const parsed = parsePage(file.content)
      const title = titleFrom(file, parsed)
      const summary = summaryFromBody(parsed?.body ?? file.content)
      const alias = title.replaceAll(/[|[\]]/g, ' ').replaceAll(/\s+/g, ' ').trim()
      lines.push(`- [[${relativeWikiPath(file.path).replace(/\.md$/, '')}|${alias}]] — ${summary}`)
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function issue(
  severity: RavenWorkspaceIssue['severity'],
  code: string,
  detail: string,
  path?: string,
): RavenWorkspaceIssue {
  return { severity, code, detail, ...(path === undefined ? {} : { path }) }
}

function health(files: readonly RavenWorkspaceFile[]): RavenWorkspaceHealth {
  const issues: RavenWorkspaceIssue[] = []
  const byPath = fileMap(files)
  for (const path of STRUCTURE_PATHS) {
    if (!byPath.has(path)) issues.push(issue('error', 'missing-structure', `Required llm-wiki structure is missing: ${path}`, path))
  }
  for (const file of files) {
    const pageType = WORKSPACE_PAGE_TYPES.find(type => file.path.startsWith(`wiki/${PAGE_DIRECTORIES[type]}/`))
    const isKnowledge = pageType !== undefined
    const isRaw = file.path.startsWith('wiki/raw/')
    if (!isKnowledge && !isRaw) continue
    const parsed = parsePage(file.content)
    if (parsed === undefined) {
      issues.push(issue('error', 'missing-frontmatter', 'Markdown page has no parseable YAML frontmatter', file.path))
      continue
    }
    if (isRaw) {
      const expected = parsed.fields.sha256
      if (expected === undefined) {
        issues.push(issue('error', 'missing-raw-digest', 'Immutable raw page has no sha256 field', file.path))
      } else if (yamlString(expected) !== sha256Hex(parsed.body)) {
        issues.push(issue('error', 'raw-digest-mismatch', 'Immutable raw page body no longer matches sha256', file.path))
      }
      if (parsed.fields.source_uri === undefined) {
        issues.push(issue('warning', 'missing-source-provenance', 'Raw page has no source_uri provenance', file.path))
      }
      continue
    }
    if (parsed.fields.type !== pageType) {
      issues.push(issue('error', 'page-type-mismatch', `Page type must be ${pageType ?? 'known'} for its directory`, file.path))
    }
    if (parsed.fields.title === undefined) issues.push(issue('warning', 'missing-title', 'Knowledge page has no title', file.path))
    if (!['high', 'medium', 'low'].includes(parsed.fields.confidence ?? '')) {
      issues.push(issue('warning', 'missing-confidence', 'Knowledge page has no valid confidence', file.path))
    }
    for (const source of pageList(parsed, 'sources')) {
      const target = source.startsWith('wiki/') ? source : `wiki/${source}`
      if (!byPath.has(target)) {
        issues.push(issue('error', 'dangling-source', `Knowledge page references missing Source ${source}`, file.path))
      }
    }
    if (parsed.fields.contested === 'true' && pageList(parsed, 'contradictions').length === 0) {
      issues.push(issue('warning', 'unexplained-contestation', 'Contested page names no contradictions', file.path))
    }
  }
  const currentIndex = byPath.get('wiki/index.md')
  if (currentIndex?.includes(GENERATED_INDEX_MARKER) === true && currentIndex !== renderIndex(files)) {
    issues.push(issue('warning', 'stale-index', 'Generated index does not match current Markdown pages', 'wiki/index.md'))
  }
  return {
    status: issues.some(item => item.severity === 'error')
      ? 'unhealthy'
      : issues.length > 0
        ? 'degraded'
        : 'healthy',
    issues,
  }
}

function structurePages(
  existing: readonly RavenWorkspaceFile[],
  additions: readonly RavenWorkspaceFile[],
  entry?: string,
): { readonly pages: RavenWorkspaceFile[]; readonly logEntry?: string } {
  const current = fileMap(existing)
  const virtual = [...existing, ...additions.filter(page => !current.has(page.path))]
  const pages: RavenWorkspaceFile[] = []
  if (!current.has('wiki/SCHEMA.md')) pages.push({ path: 'wiki/SCHEMA.md', content: SCHEMA_SEED })
  if (!current.has('wiki/index.md')) {
    pages.push(additions.find(pageValue => pageValue.path === 'wiki/index.md')
      ?? { path: 'wiki/index.md', content: renderIndex(virtual) })
  }
  if (!current.has('wiki/log.md')) {
    pages.push({ path: 'wiki/log.md', content: WIKI_LOG_SEED + (entry ?? '') })
    return { pages }
  }
  return { pages, ...(entry === undefined ? {} : { logEntry: entry }) }
}

function documentIdentity(document: RavenWorkspaceDocument): string {
  const representation = document.representation
  return JSON.stringify([
    document.resource,
    representation?.derivation ?? null,
    representation?.coverage ?? null,
    representation?.producedBy ?? null,
    representation?.markdown ?? null,
    document.asOf ?? null,
  ])
}

function excerpt(markdown: string): string {
  return markdown.trim().slice(0, Math.min(1_000, RAVEN_LIMITS.sourceExcerptChars))
}

function compactVerifierError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, ' ')
  return message.slice(0, RAVEN_LIMITS.limitationDetailChars)
}

function validatedDocumentChecks(
  requests: readonly SourceCheckRequest[],
  value: unknown,
): SourceCheckResult[] {
  if (!Array.isArray(value)) throw new Error('source verifier protocol response must be an array')
  const expected = new Set(requests.map(request => request.sourceId))
  const seen = new Set<string>()
  const results: SourceCheckResult[] = []
  for (const raw of value) {
    const result = record(raw, 'source verifier result')
    assertOnlyKeys(result, ['sourceId', 'status', 'checkedAt', 'statusCode', 'resolvedUrl', 'detail'], 'source verifier result')
    const sourceId = requiredText(result.sourceId, 'source verifier result.sourceId', 128)
    if (!expected.has(sourceId)) throw new Error(`source verifier protocol returned unknown source ${sourceId}`)
    if (seen.has(sourceId)) throw new Error(`source verifier protocol returned duplicate source ${sourceId}`)
    seen.add(sourceId)
    const status = member(result.status, ['reachable', 'failed', 'unavailable'] as const, 'source verifier result.status')
    const checkedAt = requiredText(result.checkedAt, 'source verifier result.checkedAt', RAVEN_LIMITS.sourceAsOfChars)
    if (!Number.isFinite(Date.parse(checkedAt))) {
      throw new Error(`source verifier protocol returned invalid checkedAt for ${sourceId}`)
    }
    if (result.statusCode !== undefined || result.resolvedUrl !== undefined) {
      throw new Error(`source verifier protocol returned HTTP identity for non-web source ${sourceId}`)
    }
    const detail = optionalText(result.detail, 'source verifier result.detail', RAVEN_LIMITS.limitationDetailChars)
    if (status !== 'reachable' && detail === undefined) {
      throw new Error(`source verifier protocol omitted failure detail for ${sourceId}`)
    }
    results.push({ sourceId, status, checkedAt, ...(detail === undefined ? {} : { detail }) })
  }
  return results
}

async function verifyDocuments(
  documents: readonly RavenWorkspaceDocument[],
  options: RavenWorkspaceEngineOptions,
  execution: RavenExecution,
): Promise<{ readonly verified: VerifiedDocument[]; readonly issues: RavenWorkspaceIssue[] }> {
  const issues: RavenWorkspaceIssue[] = []
  const requests: SourceCheckRequest[] = []
  const byId = new Map<string, RavenWorkspaceDocument>()
  for (const document of documents) {
    const markdown = document.representation?.markdown
    if (markdown === undefined || markdown.trim().length === 0) {
      issues.push(issue(
        'error',
        'normalization-unavailable',
        `No normalized Markdown is available for ${document.resource.uri}; the Original Resource was not changed`,
      ))
      continue
    }
    const sourceId = `W${sha256Hex(documentIdentity(document)).slice(0, 31)}`
    byId.set(sourceId, document)
    requests.push({
      sourceId,
      url: document.resource.uri,
      resource: document.resource,
      representation: document.representation,
      locator: 'full normalized Markdown',
      excerpt: excerpt(markdown),
    })
  }
  let checks: readonly SourceCheckResult[] = []
  if (requests.length > 0) {
    try {
      const raw: unknown = await settleWithAbort(
        options.sourceVerifier.verify(requests, execution.signal, execution),
        execution.signal,
      )
      execution.signal.throwIfAborted()
      checks = validatedDocumentChecks(requests, raw)
    } catch (error) {
      execution.signal.throwIfAborted()
      const detail = compactVerifierError(error)
      issues.push(...requests.map(request => issue(
        'error',
        'normalization-unverified',
        `Normalized Markdown for ${request.resource.uri} could not be verified: source verifier unavailable: ${detail}`,
      )))
      return { verified: [], issues }
    }
  }
  execution.signal.throwIfAborted()
  const checkedById = new Map(checks.map(check => [check.sourceId, check]))
  const verified: VerifiedDocument[] = []
  for (const request of requests) {
    const check = checkedById.get(request.sourceId)
    const document = byId.get(request.sourceId)
    if (document === undefined || check === undefined) {
      issues.push(issue('error', 'verification-missing', `Source verifier returned no result for ${request.resource.uri}`))
      continue
    }
    if (check.status !== 'reachable') {
      issues.push(issue(
        'error',
        'normalization-unverified',
        `Normalized Markdown for ${request.resource.uri} was not accepted: ${check.detail ?? check.status}`,
      ))
      continue
    }
    verified.push({ document, check })
  }
  return { verified, issues }
}

function resourceSlug(resource: RavenSourceResource, fallback: string): string {
  try {
    const segment = decodeURIComponent(new URL(resource.uri).pathname.split('/').filter(Boolean).at(-1) ?? '')
      .replace(/\.[^.]+$/, '')
    return wikiSlug(segment.length > 0 ? segment : fallback)
  } catch {
    return wikiSlug(fallback)
  }
}

function latestRawPages(files: readonly RavenWorkspaceFile[]): ReadonlyMap<string, RavenWorkspaceFile> {
  const latest = new Map<string, { readonly file: RavenWorkspaceFile; readonly date: string }>()
  for (const file of files) {
    if (!file.path.startsWith('wiki/raw/')) continue
    const parsed = parsePage(file.content)
    const uri = unquote(parsed?.fields.source_uri)
    if (uri === undefined) continue
    const date = unquote(parsed?.fields.ingested_at) ?? parsed?.fields.ingested ?? ''
    const current = latest.get(uri)
    if (current === undefined || date.localeCompare(current.date) > 0
      || (date === current.date && file.path.localeCompare(current.file.path) > 0)) {
      latest.set(uri, { file, date })
    }
  }
  return new Map([...latest].map(([uri, value]) => [uri, value.file]))
}

function renderDocumentPage(
  value: VerifiedDocument,
  latestByUri: ReadonlyMap<string, RavenWorkspaceFile>,
  at: string,
): RavenWorkspaceFile {
  const { document, check } = value
  const representation = document.representation
  if (representation?.markdown === undefined) throw new Error('verified document lost its Markdown representation')
  const identity = documentIdentity(document)
  const path = `wiki/raw/documents/${resourceSlug(document.resource, document.title)}-${sha256Hex(identity).slice(0, 16)}.md`
  const previous = latestByUri.get(document.resource.uri)
  const prior = previous?.path === path ? undefined : previous
  const frontmatter = [
    `title: ${wikiYamlString(document.title)}`,
    'type: source',
    `source_url: ${wikiYamlString(document.resource.uri)}`,
    `source_origin: ${document.resource.origin}`,
    `source_uri: ${wikiYamlString(document.resource.uri)}`,
    ...(document.resource.mediaType === undefined ? [] : [`source_media_type: ${wikiYamlString(document.resource.mediaType)}`]),
    ...(document.resource.sourceName === undefined ? [] : [`source_name: ${wikiYamlString(document.resource.sourceName)}`]),
    `representation: ${representation.derivation}`,
    `representation_coverage: ${representation.coverage}`,
    `representation_produced_by: ${wikiYamlString(representation.producedBy)}`,
    ...(representation.inspectionCallId === undefined
      ? []
      : [`inspection_call_id: ${wikiYamlString(representation.inspectionCallId)}`]),
    `inspection_sha256: ${sourceInspectionSha256(document.resource, representation).slice('sha256:'.length)}`,
    `ingested: ${at.slice(0, 10)}`,
    `ingested_at: ${wikiYamlString(at)}`,
    `sha256: ${sha256Hex(representation.markdown)}`,
    'capture: normalized-markdown',
    `verification: ${check.status}`,
    `verified_at: ${check.checkedAt}`,
    ...(document.asOf === undefined ? [] : [`as_of: ${wikiYamlString(document.asOf)}`]),
    ...(prior === undefined ? [] : [`supersedes: ${wikiYamlString(relativeWikiPath(prior.path))}`]),
  ]
  return { path, content: renderWikiPage(frontmatter, representation.markdown) }
}

function sameDocumentRevision(existing: string, proposed: string): boolean {
  const left = parsePage(existing)
  const right = parsePage(proposed)
  if (left === undefined || right === undefined) return false
  return left.fields.source_uri === right.fields.source_uri
    && left.fields.sha256 === right.fields.sha256
    && left.body === right.body
}

function mergeConfidence(left: string | undefined, right: 'high' | 'medium' | 'low'): 'high' | 'medium' | 'low' {
  const ranks = { low: 0, medium: 1, high: 2 } as const
  if (left !== 'high' && left !== 'medium' && left !== 'low') return right
  return ranks[left] <= ranks[right] ? left : right
}

function updateFrontmatter(content: string, updates: Readonly<Record<string, string>>): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/.exec(content)
  if (match === null) throw new RavenTypeError('invalid-value', 'existing target page has no parseable frontmatter')
  const eol = (match[1] ?? '').includes('\r\n') ? '\r\n' : '\n'
  const lines = (match[2] ?? '').split(/\r?\n/)
  const fields = frontmatterFields(lines)
  const byKey = new Map<string, FrontmatterField[]>()
  for (const field of fields) byKey.set(field.key, [...byKey.get(field.key) ?? [], field])
  const replacements = new Map<number, { readonly end: number; readonly lines: readonly string[] }>()
  const additions: string[] = []

  for (const [key, value] of Object.entries(updates)) {
    const existing = byKey.get(key) ?? []
    if (existing.length > 1) {
      throw new RavenTypeError('invalid-value', `existing target page repeats managed frontmatter field ${key}`)
    }
    const field = existing[0]
    if (field === undefined) {
      additions.push(`${key}: ${value}`)
      continue
    }
    const preserved = field.continuation.filter(line => line.trim().length === 0 || /^\s*#/.test(line))
    const structural = field.continuation.filter(line => line.trim().length > 0 && !/^\s*#/.test(line))
    let rendered: string[]
    if (MANAGED_LIST_FIELDS.has(key)) {
      if (managedYamlList(field) === undefined) {
        throw new RavenTypeError('invalid-value', `existing target page ${key} must be a safe YAML sequence`)
      }
      const values = flowYamlList(value)
      if (values === undefined) throw new Error(`Raven emitted an invalid managed YAML sequence for ${key}`)
      rendered = field.value.length === 0 && values.length > 0
        ? [`${key}:`, ...values.map(item => `  - ${wikiYamlList([item]).slice(1, -1)}`)]
        : [`${key}: ${wikiYamlList(values)}`]
    } else {
      if (structural.length > 0) {
        throw new RavenTypeError('invalid-value', `existing target page ${key} uses a YAML shape Raven cannot safely update`)
      }
      rendered = [`${key}: ${value}`]
    }
    replacements.set(field.start, { end: field.end, lines: [...rendered, ...preserved] })
  }

  const updated: string[] = []
  for (let index = 0; index < lines.length;) {
    const replacement = replacements.get(index)
    if (replacement === undefined) {
      updated.push(lines[index] ?? '')
      index += 1
    } else {
      updated.push(...replacement.lines)
      index = replacement.end
    }
  }
  updated.push(...additions)
  return `${match[1] ?? `---${eol}`}${updated.join(eol)}${match[3] ?? `${eol}---${eol}`}${match[4] ?? ''}`
}

function contradictionIds(state: RavenTaskState): string[] {
  const pairs = new Set<string>()
  for (const claim of state.claims) {
    for (const other of claim.contradicts ?? []) {
      const pair = [claim.claimId, other].sort().join('<->')
      pairs.add(`${state.taskId}:${pair}`)
    }
  }
  return [...pairs].sort()
}

function replaceRawCollision(
  pageValue: RavenWorkspaceFile,
  existing: ReadonlyMap<string, string>,
): RavenWorkspaceFile {
  const current = existing.get(pageValue.path)
  if (current === undefined || current === pageValue.content) return pageValue
  const replacement = pageValue.path.replace(/\.md$/, `-${sha256Hex(pageValue.content).slice(0, 12)}.md`)
  const replacementCurrent = existing.get(replacement)
  if (replacementCurrent !== undefined && replacementCurrent !== pageValue.content) {
    throw new RavenTypeError('invalid-value', `immutable raw page collision at ${pageValue.path} and ${replacement}`)
  }
  return { path: replacement, content: pageValue.content }
}

function growPage(
  input: Record<string, unknown>,
  files: readonly RavenWorkspaceFile[],
  contribution: RavenWorkspaceTaskContribution | undefined,
  at: string,
): { readonly pages: RavenWorkspaceFile[]; readonly operationId: string; readonly subject: string } {
  if (contribution === undefined) {
    throw new RavenTypeError('invalid-value', 'grow requires a completed Raven Task contribution from the current Task book')
  }
  const taskId = requiredText(input.taskId, 'taskId', 128)
  if (taskId !== contribution.state.taskId) throw new RavenTypeError('invalid-value', 'taskId does not match the supplied Task')
  if (contribution.state.phase !== 'completed' && contribution.state.phase !== 'completed-with-limits') {
    throw new RavenTypeError('invalid-value', 'grow requires a completed Raven Task; Task and Workspace lifecycles remain separate')
  }
  const pageType = member(input.pageType, WORKSPACE_PAGE_TYPES, 'pageType')
  const title = requiredText(input.title, 'title', RAVEN_LIMITS.summaryChars)
  const rawTags = input.tags === undefined ? [] : array(input.tags, 'tags')
  const tags = rawTags.map((tag, index) => {
    const parsed = requiredText(tag, `tags[${index}]`, 64)
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed)) {
      throw new RavenTypeError('invalid-value', `tags[${index}] must use lowercase letters, digits, or hyphens`)
    }
    return parsed
  })
  if (new Set(tags).size !== tags.length) throw new RavenTypeError('invalid-value', 'tags must not contain duplicates')
  const directory = PAGE_DIRECTORIES[pageType]
  const targetPath = `wiki/${directory}/${wikiSlug(title)}.md`
  const byPath = fileMap(files)
  const existingTarget = byPath.get(targetPath)
  const parsedExisting = existingTarget === undefined ? undefined : parsePage(existingTarget)
  if (existingTarget !== undefined && parsedExisting === undefined) {
    throw new RavenTypeError('invalid-value', `existing target ${targetPath} has no parseable frontmatter`)
  }
  if (parsedExisting?.fields.type !== undefined && parsedExisting.fields.type !== pageType) {
    throw new RavenTypeError('evidence-conflict', `existing target ${targetPath} has type ${parsedExisting.fields.type}, not ${pageType}`)
  }
  const existingTitle = unquote(parsedExisting?.fields.title)
  if (existingTitle !== undefined && existingTitle !== title) {
    throw new RavenTypeError(
      'evidence-conflict',
      `existing target ${targetPath} already belongs to title ${JSON.stringify(existingTitle)}, not ${JSON.stringify(title)}`,
    )
  }
  const rawPages = renderWikiRawPages(contribution.state)
    .map(pageValue => replaceRawCollision(pageValue, byPath))
  const sourcePaths = rawPages.map(pageValue => relativeWikiPath(pageValue.path))
  const confidence = wikiConfidence(contribution.state)
  const contradictions = contradictionIds(contribution.state)
  const operationId = sha256Hex([
    'grow', targetPath, contribution.state.taskId,
    contribution.state.finalArtifactSha256 ?? sha256Hex(contribution.renderedArtifact),
  ].join('\0')).slice(0, 24)
  const marker = operationMarker(operationId)
  const existingBody = parsedExisting?.body ?? ''
  const existingTasks = pageList(parsedExisting, 'raven_tasks')
  if (existingBody.includes(marker) || existingTasks.includes(contribution.state.taskId)) {
    return {
      pages: rawPages.filter(pageValue => !byPath.has(pageValue.path)),
      operationId,
      subject: `${pageType} ${title}`,
    }
  }
  const allTags = [...new Set([...pageList(parsedExisting, 'tags'), ...(tags.length > 0 ? tags : [contribution.state.outcome])])]
  const allSources = [...new Set([...pageList(parsedExisting, 'sources'), ...sourcePaths])]
  const allTasks = [...new Set([...existingTasks, contribution.state.taskId])]
  const allContradictions = [...new Set([...pageList(parsedExisting, 'contradictions'), ...contradictions])]
  const contested = parsedExisting?.fields.contested === 'true' || contradictions.length > 0
  const update = [
    `## Raven update ${at.slice(0, 10)} — Raven Task ${contribution.state.taskId}`,
    '',
    contribution.renderedArtifact.trimEnd(),
    '',
    `- Confidence at this update: ${confidence}`,
    `- Task phase: ${contribution.state.phase}`,
    ...(contradictions.length === 0
      ? []
      : ['', '### Contradictions retained', '', ...contradictions.map(value => `- ${value}`)]),
    marker,
    '',
  ].join('\n')
  const created = parsedExisting?.fields.created ?? contribution.state.startedAt.slice(0, 10)
  const fields = {
    title: wikiYamlString(title),
    created,
    updated: at.slice(0, 10),
    type: pageType,
    tags: wikiYamlList(allTags),
    sources: wikiYamlList(allSources),
    confidence: mergeConfidence(parsedExisting?.fields.confidence, confidence),
    ...(contested ? { contested: 'true' } : {}),
    raven_tasks: wikiYamlList(allTasks),
    ...(allContradictions.length === 0 ? {} : { contradictions: wikiYamlList(allContradictions) }),
  }
  const targetContent = existingTarget === undefined
    ? renderWikiPage(Object.entries(fields).map(([key, value]) => `${key}: ${value}`), `# ${markdownText(title)}\n\n${update}`)
    : updateFrontmatter(existingTarget, fields).trimEnd() + `\n\n${update}`
  return {
    pages: [
      { path: targetPath, content: targetContent },
      ...rawPages.filter(pageValue => byPath.get(pageValue.path) !== pageValue.content),
    ],
    operationId,
    subject: `${pageType} ${title}`,
  }
}

function tokens(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(token => [...token].length > 1 || SINGLE_CJK_TOKEN.test(token)))]
}

function occurrences(haystack: string, needle: string, limit = Number.POSITIVE_INFINITY): number {
  let count = 0
  let position = 0
  while (count < limit && (position = haystack.indexOf(needle, position)) !== -1) {
    count += 1
    position += needle.length
  }
  return count
}

function reuseCandidates(
  input: Record<string, unknown>,
  files: readonly RavenWorkspaceFile[],
  at: string,
): RavenWorkspaceCandidate[] {
  const query = requiredText(input.query, 'query', RAVEN_WORKSPACE_LIMITS.queryChars)
  const freshnessRequest = input.freshness === undefined
    ? 'durable'
    : member(input.freshness, ['durable', 'current'] as const, 'freshness')
  const maxAgeDays = input.maxAgeDays === undefined ? 30 : input.maxAgeDays
  if (!Number.isSafeInteger(maxAgeDays) || (maxAgeDays as number) < 0 || (maxAgeDays as number) > 36_500) {
    throw new RavenTypeError('invalid-value', 'maxAgeDays must be an integer from 0 to 36500')
  }
  const maxResults = input.maxResults === undefined ? 8 : input.maxResults
  if (!Number.isSafeInteger(maxResults) || (maxResults as number) < 1 || (maxResults as number) > RAVEN_WORKSPACE_LIMITS.maxResults) {
    throw new RavenTypeError('invalid-value', `maxResults must be an integer from 1 to ${RAVEN_WORKSPACE_LIMITS.maxResults}`)
  }
  const queryTokens = tokens(query).slice(0, RAVEN_WORKSPACE_LIMITS.queryTerms)
  const nowMs = Date.parse(at)
  return files.flatMap((file): RavenWorkspaceCandidate[] => {
    const directory = /^wiki\/([^/]+)\/.+\.md$/.exec(file.path)?.[1]
    const type = WORKSPACE_PAGE_TYPES.find(candidate => PAGE_DIRECTORIES[candidate] === directory)
    if (type === undefined) return []
    const parsed = parsePage(file.content)
    if (parsed === undefined) return []
    const title = titleFrom(file, parsed)
    const searchableTitle = title.toLowerCase()
    const searchableBody = parsed.body.toLowerCase()
    const searchableTags = pageList(parsed, 'tags').join(' ').toLowerCase()
    const score = queryTokens.reduce((sum, token) => sum
      + occurrences(searchableTitle, token) * 8
      + occurrences(searchableTags, token) * 3
      + occurrences(searchableBody, token, 5), 0)
    if (score === 0) return []
    const updated = unquote(parsed.fields.updated)
    const updatedMs = updated === undefined ? Number.NaN : Date.parse(updated)
    const ageDays = Number.isNaN(updatedMs) ? Number.POSITIVE_INFINITY : Math.max(0, (nowMs - updatedMs) / 86_400_000)
    const freshness: RavenWorkspaceCandidate['freshness'] = updated === undefined || Number.isNaN(updatedMs)
      ? 'undated'
      : ageDays > (maxAgeDays as number)
        ? 'stale'
        : 'current'
    const confidence = parsed.fields.confidence
    return [{
      path: file.path,
      title,
      type,
      summary: summaryFromBody(parsed.body),
      confidence: confidence === 'high' || confidence === 'medium' || confidence === 'low' ? confidence : 'unknown',
      sources: pageList(parsed, 'sources'),
      ...(updated === undefined ? {} : { updated }),
      knowledgeStatus: 'stored',
      freshness,
      requiresFreshVerification: freshnessRequest === 'current',
      score,
    }]
  }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, maxResults as number)
}

interface OperationResultInput extends Pick<RavenWorkspaceResult, 'logEntry' | 'health' | 'candidates'> {
  readonly action: RavenWorkspaceAction
  readonly existing: readonly RavenWorkspaceFile[]
  readonly pages: readonly RavenWorkspaceFile[]
  readonly issues: readonly RavenWorkspaceIssue[]
  readonly message: string
}

function operationResult(input: OperationResultInput): RavenWorkspaceResult {
  const { action, existing, pages, issues, message, ...extra } = input
  const current = fileMap(existing)
  return {
    status: issues.some(item => item.severity === 'error') ? 'needs-revision' : 'ready',
    action,
    message,
    pages,
    preconditions: pages.map((pageValue) => {
      const content = current.get(pageValue.path)
      return {
        path: pageValue.path,
        expected: content === undefined ? 'absent' : `sha256:${sha256Hex(content)}`,
      }
    }),
    issues,
    ...extra,
  }
}

export function createRavenWorkspaceEngine(options: RavenWorkspaceEngineOptions): RavenWorkspaceEngine {
  return {
    async dispatch(
      rawInput: unknown,
      execution: RavenExecution,
      contribution?: RavenWorkspaceTaskContribution,
    ): Promise<RavenWorkspaceResult> {
      const input = record(rawInput, 'Raven Workspace input')
      const action = member(input.action, Object.keys(WORKSPACE_ACTION_FIELDS), 'action') as RavenWorkspaceAction
      assertOnlyKeys(input, WORKSPACE_ACTION_FIELDS[action] ?? [], `Raven Workspace ${action} action`)
      if (action === 'health' || action === 'maintain') requireCompleteSnapshot(input, action)
      const files = parseFiles(input.files)
      const at = options.now()

      if (action === 'health') {
        const report = health(files)
        return operationResult({
          action,
          existing: files,
          pages: [],
          issues: report.issues,
          message: `Workspace health is ${report.status}.`,
          health: report,
        })
      }

      if (action === 'reuse') {
        const candidates = reuseCandidates(input, files, at)
        return operationResult({
          action,
          existing: files,
          pages: [],
          issues: [],
          message: `Found ${candidates.length} stored knowledge candidate(s); current claims still require fresh verification when requested.`,
          candidates,
        })
      }

      if (action === 'initialize') {
        const current = fileMap(files)
        if (STRUCTURE_PATHS.every(path => current.has(path))) {
          return operationResult({
            action,
            existing: files,
            pages: [],
            issues: [],
            message: 'Workspace is already initialized; no files changed.',
          })
        }
        const id = sha256Hex('initialize\0llm-wiki').slice(0, 24)
        const marker = operationMarker(id)
        const entry = logHas(files, marker)
          ? undefined
          : logEntry(at, 'initialize', 'Raven-compatible llm-wiki', id, ['Markdown is authoritative; indexes are derived'])
        const structure = structurePages(files, [], entry)
        return operationResult({
          action,
          existing: files,
          pages: structure.pages,
          issues: [],
          message: structure.pages.length === 0 && structure.logEntry === undefined
            ? 'Workspace is already initialized; no files changed.'
            : 'Initialized Raven Workspace structure without creating a Raven-only repository format.',
          ...(structure.logEntry === undefined ? {} : { logEntry: structure.logEntry }),
        })
      }

      if (action === 'maintain') {
        const generated = renderIndex(files)
        const current = fileMap(files).get('wiki/index.md')
        const indexPages = current === generated ? [] : [{ path: 'wiki/index.md', content: generated }]
        const id = sha256Hex(`maintain\0${sha256Hex(generated)}`).slice(0, 24)
        const marker = operationMarker(id)
        const entry = indexPages.length === 0 || logHas(files, marker)
          ? undefined
          : logEntry(at, 'maintain', 'wiki structure', id, ['Regenerated index.md from Markdown source pages'])
        const structure = structurePages(files, indexPages, entry)
        const pages = [...structure.pages.filter(pageValue => pageValue.path !== 'wiki/index.md'), ...indexPages]
        return operationResult({
          action,
          existing: files,
          pages,
          issues: [],
          message: pages.length === 0 && structure.logEntry === undefined
            ? 'Workspace structure is current; no files changed.'
            : 'Regenerated disposable Workspace structure from Markdown source pages.',
          ...(structure.logEntry === undefined ? {} : { logEntry: structure.logEntry }),
        })
      }

      if (action === 'grow') {
        const grown = growPage(input, files, contribution, at)
        const marker = operationMarker(grown.operationId)
        const entry = logHas(files, marker)
          ? undefined
          : logEntry(at, 'grow', grown.subject, grown.operationId, [
              `Task: ${contribution?.state.taskId ?? 'unavailable'}`,
              `Pages emitted: ${grown.pages.length}`,
            ])
        const structure = structurePages(files, grown.pages, entry)
        return operationResult({
          action,
          existing: files,
          pages: [...structure.pages, ...grown.pages],
          issues: [],
          message: grown.pages.length === 0 && structure.logEntry === undefined
            ? 'This completed Task contribution is already present; no files changed.'
            : `Grew Workspace ${grown.subject} from completed Raven Task ${contribution?.state.taskId}.`,
          ...(structure.logEntry === undefined ? {} : { logEntry: structure.logEntry }),
        })
      }

      const kind = action === 'adopt' ? member(input.kind, ['wiki', 'folder'] as const, 'kind') : undefined
      if (action === 'adopt' && kind === 'wiki') {
        if (input.documents !== undefined) {
          throw new RavenTypeError(
            'invalid-value',
            'documents are accepted only for adopt kind=folder or action=ingest; adopt kind=wiki is byte-preserving',
          )
        }
        const structure = structurePages(files, [])
        return operationResult({
          action,
          existing: files,
          pages: structure.pages,
          issues: [],
          message: structure.pages.length === 0
            ? 'Existing llm-wiki adopted without changing any existing file.'
            : 'Existing llm-wiki adopted by creating only missing standard structure.',
        })
      }
      const documents = parseDocuments(input.documents)
      const verified = await verifyDocuments(documents, options, execution)
      const latestByUri = verified.verified.length === 0 ? undefined : latestRawPages(files)
      const additions = latestByUri === undefined
        ? []
        : verified.verified.map(value => renderDocumentPage(value, latestByUri, at))
      const existing = fileMap(files)
      const changed = additions.filter((pageValue) => {
        const current = existing.get(pageValue.path)
        if (current === undefined) return true
        if (sameDocumentRevision(current, pageValue.content)) return false
        throw new RavenTypeError('evidence-conflict', `immutable raw page ${pageValue.path} already exists with different source bytes`)
      })
      const acceptedIdentity = verified.verified.map(value => documentIdentity(value.document)).sort()
      const issueIdentity = verified.issues
        .map(item => JSON.stringify([item.severity, item.code, item.detail, item.path ?? null]))
        .sort()
      const outcomeIdentity = JSON.stringify([acceptedIdentity, issueIdentity])
      const id = sha256Hex(`${action}\0${kind ?? ''}\0${outcomeIdentity}`).slice(0, 24)
      const marker = operationMarker(id)
      const actionLabel = action === 'adopt' ? `adopt-${kind}` : 'ingest'
      const entry = logHas(files, marker)
        ? undefined
        : logEntry(at, actionLabel, 'normalized documents', id, [
            `Documents accepted: ${verified.verified.length}`,
            `Documents needing revision: ${verified.issues.length}`,
            'Original Resources were not modified',
          ])
      const structure = structurePages(files, changed, entry)
      const pages = [...structure.pages, ...changed]
      return operationResult({
        action,
        existing: files,
        pages,
        issues: verified.issues,
        message: pages.length === 0 && structure.logEntry === undefined
          ? 'Workspace already contains this material; no files changed.'
          : `${action === 'adopt' ? 'Adopted' : 'Ingested'} ${verified.verified.length} normalized document(s) without modifying originals.`,
        ...(structure.logEntry === undefined ? {} : { logEntry: structure.logEntry }),
      })
    },
  }
}
