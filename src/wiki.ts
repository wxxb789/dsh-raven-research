/**
 * llm-wiki emission.
 *
 * Raven renders page bytes; the Harness agent writes the files. Keeping this a pure
 * projection is what lets the plugin stay free of a filesystem dependency while still
 * producing a repository that the llm-wiki skill, Obsidian, and that skill's own
 * tooling can read. See docs/adr/0002-llm-wiki-repo-format.md.
 */

import {
  markdownText,
  renderWikiPage,
  sha256Hex,
  wikiSlug,
  wikiYamlList,
  wikiYamlString,
} from './wiki-format.js'
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
  /** Emission time for the knowledge page and log; immutable raw pages use Source inspection time. */
  readonly at: string
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
  return `wiki/raw/articles/${wikiSlug(identity)}-${sha256Hex(identity).slice(0, 8)}.md`
}

/**
 * Confidence is reported from what the Task actually achieved. An in-progress Artifact is
 * never high confidence, and any recorded limit or deferral caps it at medium, so a page
 * cannot silently harden into wiki fact.
 */
export function wikiConfidence(state: RavenTaskState): 'high' | 'medium' | 'low' {
  if (state.phase === 'active' || state.phase === 'stopped') return 'low'
  if (state.phase === 'completed-with-limits') return 'medium'
  return state.limitations.length > 0 || state.claims.some(claim => claim.disposition === 'deferred')
    ? 'medium'
    : 'high'
}

function materialExternal(claims: readonly RavenClaimRecord[]): RavenClaimRecord[] {
  return claims.filter(claim => claim.kind === 'external' && claim.importance === 'material')
}

function renderRawPage(source: RavenSourceRecord, state: RavenTaskState): RavenWikiPage {
  const representation = source.representation === null
    ? 'unavailable'
    : `${source.representation.derivation} ${source.representation.coverage} Markdown by ${source.representation.producedBy}`
  const lines = [
    `# ${markdownText(source.title)}`,
    '',
    blockquote(source.excerpt),
    '',
    `- Locator: ${markdownText(source.locator)}`,
    `- Role: ${source.role}`,
    `- Source origin: ${source.resource.origin}`,
    `- Original resource: ${markdownText(source.resource.uri)}`,
    `- Markdown representation: ${markdownText(representation)}`,
    ...(source.representation?.inspectionCallId === undefined
      ? []
      : [`- Inspection call: ${markdownText(source.representation.inspectionCallId)}`]),
    `- Inspected: ${source.inspectedAt}`,
  ]
  if (source.asOf !== undefined) lines.push(`- As of: ${markdownText(source.asOf)}`)
  if (source.check.status === 'unchecked') {
    lines.push('- Verification: unverified (Raven never checked this excerpt against its Markdown representation)')
  } else {
    lines.push(`- Verification: ${source.check.status} at ${source.check.checkedAt}`)
    if (source.check.resolvedUrl !== undefined) lines.push(`- Resolved URL: ${markdownText(source.check.resolvedUrl)}`)
    if (source.check.detail !== undefined) lines.push(`- Detail: ${markdownText(source.check.detail)}`)
  }
  lines.push(
    '',
    source.check.status === 'reachable'
      ? `Recorded by Raven Task ${state.taskId}. Excerpt verified against the Source's Markdown representation; this page is not a full-resource capture.`
      : `Recorded by Raven Task ${state.taskId}. The excerpt below was NOT confirmed against the Source's Markdown representation; do not treat it as verified fact.`,
    '',
  )
  const body = lines.join('\n')

  const frontmatter = [
    `source_url: ${wikiYamlString(source.url)}`,
    `source_origin: ${source.resource.origin}`,
    `source_uri: ${wikiYamlString(source.resource.uri)}`,
    `representation: ${source.representation?.derivation ?? 'unavailable'}`,
    `representation_produced_by: ${wikiYamlString(source.representation?.producedBy ?? 'unavailable')}`,
    // Immutable Source bytes must not change merely because the same Task is projected later.
    `ingested: ${source.inspectedAt.slice(0, 10)}`,
    `sha256: ${sha256Hex(body)}`,
    'capture: excerpt-only',
    `locator: ${wikiYamlString(source.locator)}`,
    `source_role: ${source.role}`,
  ]
  if (source.representation?.inspectionCallId !== undefined) frontmatter.push(`inspection_call_id: ${wikiYamlString(source.representation.inspectionCallId)}`)
  if (source.inspectionSha256 !== undefined) frontmatter.push(`inspection_sha256: ${source.inspectionSha256.slice('sha256:'.length)}`)
  if (source.resource.mediaType !== undefined) frontmatter.push(`source_media_type: ${wikiYamlString(source.resource.mediaType)}`)
  if (source.resource.sourceName !== undefined) frontmatter.push(`source_name: ${wikiYamlString(source.resource.sourceName)}`)
  if (source.sourceFamily !== undefined) frontmatter.push(`source_family: ${wikiYamlString(source.sourceFamily)}`)
  if (source.asOf !== undefined) frontmatter.push(`as_of: ${wikiYamlString(source.asOf)}`)
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
  return { path: rawPagePath(source), content: renderWikiPage(frontmatter, body) }
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
source_url: https://example.com/article  # legacy compatibility alias for source_uri
source_origin: web | local | llm-wiki | mcp
source_uri: "identity of the Original Resource"
source_media_type: "optional original media type"
source_name: "required for llm-wiki and MCP"
representation: original | converted | unavailable
representation_produced_by: "Harness tool or converter"
inspection_call_id: "owning session tool receipt for non-web Markdown"
inspection_sha256: <digest binding Original Resource, Markdown, producer, and call id>
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

\`verification: unverified\` means Raven never checked the excerpt against the Source's Markdown
representation, so the page carries no verification receipt at all and \`verified_at\` is absent. It is an explicit
negative marker rather than an omission, so an unverified excerpt cannot read as a verified
capture.

\`capture: excerpt-only\` means the page stores the verified excerpt and its verification
receipt rather than a full Original Resource or Markdown representation. \`sha256\` therefore
detects drift in what was stored, not in the Original Resource. Re-inspect \`source_uri\` and
produce a fresh Markdown representation when currency matters.

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

export const WIKI_LOG_SEED = `# Wiki Log

> Chronological record of wiki actions. Append-only.
> Format: \`## [YYYY-MM-DD] action | subject\`
`

/** Render the immutable Source projection shared by one-off export and maintained Workspaces. */
export function renderWikiRawPages(state: RavenTaskState): RavenWikiPage[] {
  // Deduplicate by path as a second line of defence. Source IDs are unique, so
  // the digested path already is — but an emission that ever repeated a path
  // would ask the agent to write one file twice with different bytes.
  const rawPages: RavenWikiPage[] = []
  const seenRawPaths = new Set<string>()
  for (const source of state.sources) {
    const rendered = renderRawPage(source, state)
    if (seenRawPaths.has(rendered.path)) continue
    seenRawPaths.add(rendered.path)
    rawPages.push(rendered)
  }
  return rawPages
}

/** Project one Raven Task into llm-wiki page bytes plus one appendable log entry. */
export function renderWikiPages(
  state: RavenTaskState,
  renderedArtifact: string,
  options: RavenWikiOptions,
): RavenWikiEmission {
  const date = options.at.slice(0, 10)
  const artifactSlug = wikiSlug(options.title)
  const artifactPath = `wiki/queries/query-${date}-${artifactSlug}.md`
  const rawPages = renderWikiRawPages(state)
  const contested = state.claims.some(claim => (claim.contradicts ?? []).length > 0)

  const frontmatter = [
    `title: ${wikiYamlString(options.title)}`,
    `created: ${state.startedAt.slice(0, 10)}`,
    `updated: ${state.updatedAt.slice(0, 10)}`,
    'type: query',
    `tags: ${wikiYamlList(options.tags)}`,
    `sources: ${wikiYamlList(rawPages.map(item => item.path.replace(/^wiki\//, '')))}`,
    `confidence: ${wikiConfidence(state)}`,
  ]
  if (contested) frontmatter.push('contested: true')
  frontmatter.push(
    `raven_task: ${state.taskId}`,
    `raven_outcome: ${state.outcome}`,
    `raven_phase: ${state.phase}`,
  )
  if (state.finalArtifactSha256 !== null) frontmatter.push(`raven_artifact_sha256: ${state.finalArtifactSha256}`)

  const body = `# ${options.title}\n\n${renderedArtifact.trimEnd()}\n`
  const pages: RavenWikiPage[] = [{ path: artifactPath, content: renderWikiPage(frontmatter, body) }, ...rawPages]
  if (options.init) {
    pages.push(
      { path: 'wiki/SCHEMA.md', content: SCHEMA_SEED },
      { path: 'wiki/index.md', content: INDEX_SEED },
      { path: 'wiki/log.md', content: WIKI_LOG_SEED },
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
