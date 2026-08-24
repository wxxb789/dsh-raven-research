/**
 * llm-wiki emission.
 *
 * Raven renders page bytes; the Harness agent writes the files. Keeping this a pure
 * projection is what lets the plugin stay free of a filesystem dependency while still
 * producing a repository that the llm-wiki skill, Obsidian, and that skill's own
 * tooling can read. See docs/adr/0002-llm-wiki-repo-format.md.
 */

import { createHash } from 'node:crypto'

import type {
  RavenClaimRecord,
  RavenSourceRecord,
  RavenTaskState,
  RavenWikiEmission,
  RavenWikiPage,
} from './domain.js'

export interface RavenWikiOptions {
  readonly title: string
  readonly tags: readonly string[]
  readonly init: boolean
  /** Emission time; the page date and `ingested` come from here, not from Task history. */
  readonly at: string
}

/** Filesystem-safe slug that keeps CJK intact, since research corpora are frequently not Latin. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[\\/:*?"<>|#[\]]/g, ' ')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    || 'untitled'
}

function yamlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(/\s+/g, ' ').trim()}"`
}

function yamlList(values: readonly string[]): string {
  return `[${values.join(', ')}]`
}

function digest(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

function page(frontmatter: readonly string[], body: string): string {
  return `---\n${frontmatter.join('\n')}\n---\n${body}`
}

function blockquote(value: string): string {
  return value.split('\n').map(line => `> ${line}`).join('\n')
}

/**
 * Path for one Source's immutable raw page.
 *
 * The slug is truncated to 80 characters, so two long, similarly-titled Sources
 * produced the SAME path and the second silently overwrote the first — losing an
 * inspected Source and leaving the artifact page's `sources:` list pointing at a
 * page describing something else. A short digest of the full identity is
 * therefore appended: it is derived only from the Source's own stable ID and
 * title, so the path is a pure function of the record and exporting the same Task
 * twice still produces byte-identical paths.
 */
function rawPagePath(source: RavenSourceRecord): string {
  const identity = `${source.sourceId} ${source.title}`
  return `wiki/raw/articles/${slug(identity)}-${digest(identity).slice(0, 8)}.md`
}

/**
 * Confidence is reported from what the Task actually achieved. An in-progress Artifact is
 * never high confidence, and any recorded limit or deferral caps it at medium, so a page
 * cannot silently harden into wiki fact.
 */
function confidence(state: RavenTaskState): 'high' | 'medium' | 'low' {
  if (state.phase === 'active' || state.phase === 'stopped') return 'low'
  if (state.phase === 'completed-with-limits') return 'medium'
  return state.limitations.length > 0 || state.claims.some(claim => claim.disposition === 'deferred')
    ? 'medium'
    : 'high'
}

function materialExternal(claims: readonly RavenClaimRecord[]): RavenClaimRecord[] {
  return claims.filter(claim => claim.kind === 'external' && claim.importance === 'material')
}

function renderRawPage(source: RavenSourceRecord, state: RavenTaskState, at: string): RavenWikiPage {
  const lines = [
    `# ${source.title}`,
    '',
    blockquote(source.excerpt),
    '',
    `- Locator: ${source.locator}`,
    `- Role: ${source.role}`,
    `- Inspected: ${source.inspectedAt}`,
  ]
  if (source.asOf !== undefined) lines.push(`- As of: ${source.asOf}`)
  if (source.check.status === 'unchecked') {
    lines.push('- Verification: unverified (Raven never reopened this URL)')
  } else {
    lines.push(`- Verification: ${source.check.status} at ${source.check.checkedAt}`)
    if (source.check.resolvedUrl !== undefined) lines.push(`- Resolved URL: ${source.check.resolvedUrl}`)
    if (source.check.detail !== undefined) lines.push(`- Detail: ${source.check.detail}`)
  }
  lines.push(
    '',
    source.check.status === 'reachable'
      ? `Recorded by Raven Task ${state.taskId}. Excerpt verified against the retrieved body; this page is not a full-page capture.`
      : `Recorded by Raven Task ${state.taskId}. The excerpt below was NOT confirmed against the retrieved body; do not treat it as verified fact.`,
    '',
  )
  const body = lines.join('\n')

  const frontmatter = [
    `source_url: ${source.url}`,
    `ingested: ${at.slice(0, 10)}`,
    `sha256: ${digest(body)}`,
    'capture: excerpt-only',
    `locator: ${yamlString(source.locator)}`,
    `source_role: ${source.role}`,
  ]
  if (source.sourceFamily !== undefined) frontmatter.push(`source_family: ${yamlString(source.sourceFamily)}`)
  if (source.asOf !== undefined) frontmatter.push(`as_of: ${yamlString(source.asOf)}`)
  // An unchecked Source must declare itself unverified rather than simply omitting
  // the field. Omission left the page carrying only `capture: excerpt-only` and a
  // sha256, which read exactly like a verified capture — the sha256 covers the page
  // body, not the upstream document, so nothing on the page contradicted it and an
  // unverified excerpt could harden into wiki fact on the next read.
  if (source.check.status === 'unchecked') {
    frontmatter.push('verification: unverified')
  } else {
    frontmatter.push(`verification: ${source.check.status}`, `verified_at: ${source.check.checkedAt}`)
  }
  frontmatter.push(`raven_task: ${state.taskId}`)
  return { path: rawPagePath(source), content: page(frontmatter, body) }
}

const SCHEMA_SEED = `# Wiki Schema

## Domain

Research, writing, and learning artifacts produced by Raven Tasks, plus the inspected
sources that support them.

## Layers

- \`raw/\` — immutable source material. Never edit; corrections belong in wiki pages.
- \`queries/\`, \`entities/\`, \`concepts/\`, \`comparisons/\` — agent-owned pages.
- \`SCHEMA.md\`, \`index.md\`, \`log.md\` — conventions, catalog, and append-only history.

## Conventions

- File names: lowercase, hyphens, no spaces.
- Every page starts with YAML frontmatter.
- Use \`[[wikilinks]]\` between pages.
- Every action is appended to \`log.md\`; \`log.md\` is append-only.
- Raven pages carry their originating \`raven_task\` so an artifact can be traced to its Task.

## Page frontmatter

\`\`\`yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | query | summary
tags: [from the taxonomy below]
sources: [raw/articles/source-name.md]
confidence: high | medium | low
contested: true          # set when the page carries unresolved contradictions
---
\`\`\`

\`confidence\` is reported from evidence state, not from tone. A page whose Task recorded
limitations or deferred claims is at most \`medium\`; an unfinished artifact is \`low\`.

## raw/ frontmatter

\`\`\`yaml
---
source_url: https://example.com/article
ingested: YYYY-MM-DD
sha256: <hex digest of the body below the frontmatter>
capture: excerpt-only
locator: "Section 3"
source_role: primary | secondary | dataset | user-provided
source_family: "originating record or institutional lineage"
verification: reachable | failed | unavailable | unverified
verified_at: <timestamp>
---
\`\`\`

\`verification: unverified\` means Raven never reopened \`source_url\`, so the excerpt on that
page carries no verification receipt at all and \`verified_at\` is absent. It is an explicit
negative marker rather than an omission, so an unverified excerpt cannot read as a verified
capture.

\`capture: excerpt-only\` means the page stores the verified excerpt and its verification
receipt rather than a full page capture. \`sha256\` therefore detects drift in what was
stored, not in the upstream document. Re-verify against \`source_url\` when currency matters.

\`source_family\` is the originating record and institutional lineage, never the host.
Several outlets republishing one wire item are one family and are not independent
corroboration.

## Tag taxonomy

Add a tag here before using it.

- Outcomes: research, general-writing, academic-writing, learning
- Evidence: primary-source, contested, unresolved
- Meta: method, limitation
`

const INDEX_SEED = `# Wiki Index

> Content catalog. Every page listed under its type with a one-line summary.
> Read this first to find relevant pages for any query.

## Queries

## Concepts

## Entities

## Comparisons
`

const LOG_SEED = `# Wiki Log

> Chronological record of wiki actions. Append-only.
> Format: \`## [YYYY-MM-DD] action | subject\`
`

/** Project one Raven Task into llm-wiki page bytes plus one appendable log entry. */
export function renderWikiPages(
  state: RavenTaskState,
  renderedArtifact: string,
  options: RavenWikiOptions,
): RavenWikiEmission {
  const date = options.at.slice(0, 10)
  const artifactSlug = slug(options.title)
  const artifactPath = `wiki/queries/query-${date}-${artifactSlug}.md`
  // Deduplicate by path as a second line of defence. Source IDs are unique, so
  // the digested path already is — but an emission that ever repeated a path
  // would ask the agent to write one file twice with different bytes, and a
  // silently discarded write is exactly the failure the digest above prevents.
  const rawPages: RavenWikiPage[] = []
  const seenRawPaths = new Set<string>()
  for (const source of state.sources) {
    const rendered = renderRawPage(source, state, options.at)
    if (seenRawPaths.has(rendered.path)) continue
    seenRawPaths.add(rendered.path)
    rawPages.push(rendered)
  }
  const contested = state.claims.some(claim => (claim.contradicts ?? []).length > 0)

  const frontmatter = [
    `title: ${yamlString(options.title)}`,
    `created: ${state.startedAt.slice(0, 10)}`,
    `updated: ${state.updatedAt.slice(0, 10)}`,
    'type: query',
    `tags: ${yamlList(options.tags)}`,
    `sources: ${yamlList(rawPages.map(item => item.path.replace(/^wiki\//, '')))}`,
    `confidence: ${confidence(state)}`,
  ]
  if (contested) frontmatter.push('contested: true')
  frontmatter.push(
    `raven_task: ${state.taskId}`,
    `raven_outcome: ${state.outcome}`,
    `raven_phase: ${state.phase}`,
  )
  if (state.finalArtifactSha256 !== null) frontmatter.push(`raven_artifact_sha256: ${state.finalArtifactSha256}`)

  const body = `# ${options.title}\n\n${renderedArtifact.trimEnd()}\n`
  const pages: RavenWikiPage[] = [{ path: artifactPath, content: page(frontmatter, body) }, ...rawPages]
  if (options.init) {
    pages.push(
      { path: 'wiki/SCHEMA.md', content: SCHEMA_SEED },
      { path: 'wiki/index.md', content: INDEX_SEED },
      { path: 'wiki/log.md', content: LOG_SEED },
    )
  }

  const external = materialExternal(state.claims)
  const verified = state.sources.filter(source => source.check.status === 'reachable').length
  const logEntry = [
    `## [${date}] raven | ${state.outcome} — ${options.title}`,
    `- Task: ${state.taskId} · revision ${state.revision} · steering ${state.steeringRevision} · phase ${state.phase}`,
    `- Checkpoints: ${state.checkpoints.length} · Sources: ${state.sources.length} (${verified} verified)`,
    `- Material external Claims: ${external.length}`
      + ` (${external.filter(claim => claim.disposition === 'supported').length} supported,`
      + ` ${external.filter(claim => claim.disposition === 'qualified').length} qualified,`
      + ` ${external.filter(claim => claim.disposition === 'deferred').length} deferred)`,
    `- Limitations: ${state.limitations.length}${contested ? ' · contested claims present' : ''}`,
    `- Artifact: ${artifactPath}`,
    '',
  ].join('\n')

  return { pages, logEntry }
}
