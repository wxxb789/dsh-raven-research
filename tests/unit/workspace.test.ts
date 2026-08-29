import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createRavenEngine } from '../../src/engine.js'
import {
  createRavenWorkspaceEngine,
  type RavenWorkspaceFile,
  type RavenWorkspaceTaskContribution,
  WORKSPACE_PAGE_TYPES,
} from '../../src/workspace.js'
import type { SourceVerifier } from '../../src/domain.js'

const signal = new AbortController().signal
const now = () => '2026-08-16T16:00:00.000Z'
const sourceVerifier: SourceVerifier = {
  verify: async sources => sources.map(source => ({
    sourceId: source.sourceId,
    status: 'reachable',
    checkedAt: now(),
    ...(source.resource.origin === 'web' ? { statusCode: 200, resolvedUrl: source.url } : {}),
  })),
}
const execution = { sessionId: 'workspace-session', signal }

function applyEmission(
  files: readonly RavenWorkspaceFile[],
  pages: readonly RavenWorkspaceFile[],
  logEntry?: string,
): RavenWorkspaceFile[] {
  const next = new Map(files.map(file => [file.path, file.content]))
  for (const page of pages) next.set(page.path, page.content)
  if (logEntry !== undefined) {
    next.set('wiki/log.md', (next.get('wiki/log.md') ?? '') + logEntry)
  }
  return [...next].map(([path, content]) => ({ path, content }))
}

function frontmatter(content: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content)
  if (match === null) return {}
  return Object.fromEntries((match[1] ?? '').split('\n').flatMap((line) => {
    const field = /^([a-z0-9_]+):\s*(.*)$/.exec(line)
    return field === null ? [] : [[field[1] ?? '', (field[2] ?? '').trim()]]
  }))
}

async function completedTask(sessionId: string, request = 'Explain durable workspaces.') {
  const task = createRavenEngine({ now, sourceVerifier })
  const started = await task.dispatch(null, {
    action: 'start', outcome: 'general-writing', grounding: 'none', request,
  }, { sessionId, signal })
  const checkpoint = await task.dispatch(started.state, {
    action: 'checkpoint', taskId: started.state.taskId, stage: 'draft',
    summary: 'A reusable explanation.', artifact: 'Durable workspaces preserve useful context across bounded tasks.',
  }, { sessionId, signal })
  return task.dispatch(checkpoint.state, {
    action: 'complete', taskId: checkpoint.state.taskId, artifact: checkpoint.state.latestArtifact,
  }, { sessionId, signal })
}

function taskContribution(
  result: Awaited<ReturnType<typeof completedTask>>,
): RavenWorkspaceTaskContribution {
  return {
    state: result.state,
    renderedArtifact: result.renderedArtifact ?? result.state.latestArtifact ?? '',
  }
}

describe('Raven Workspace', () => {
  it('initializes a fresh llm-wiki as disposable Markdown-derived structure', async () => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const initialized = await workspace.dispatch({ action: 'initialize', files: [] }, execution)

    expect(initialized.status).toBe('ready')
    expect(initialized.pages.map(page => page.path)).toEqual([
      'wiki/SCHEMA.md', 'wiki/index.md', 'wiki/log.md',
    ])
    expect(initialized.pages.find(page => page.path === 'wiki/index.md')?.content)
      .toContain('<!-- raven-workspace-index:v1 -->')
    expect(initialized.pages.find(page => page.path === 'wiki/SCHEMA.md')?.content)
      .toContain('Markdown files are the source of truth')

    const files = applyEmission([], initialized.pages, initialized.logEntry)
    const health = await workspace.dispatch({ action: 'health', complete: true, files }, execution)
    expect(health.health?.status).toBe('healthy')
    expect(health.health?.issues).toEqual([])
  })

  it('adopts an existing llm-wiki without rewriting its existing files', async () => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const existing: RavenWorkspaceFile[] = [
      { path: 'wiki/SCHEMA.md', content: '# Existing Schema\n' },
      { path: 'wiki/index.md', content: '# Existing Index\n\nHand curated.\n' },
      { path: 'wiki/log.md', content: '# Wiki Log\n' },
      {
        path: 'wiki/concepts/existing.md',
        content: '---\ntitle: Existing\ncreated: 2024-01-01\nupdated: 2024-01-01\ntype: concept\ntags: []\nsources: []\nconfidence: medium\n---\n# Existing\n\nKeep these bytes.\n',
      },
    ]

    const adopted = await workspace.dispatch({ action: 'adopt', kind: 'wiki', files: existing }, execution)

    expect(adopted.status).toBe('ready')
    expect(adopted.pages).toEqual([])
    expect(adopted.logEntry).toBeUndefined()
    expect(applyEmission(existing, adopted.pages, adopted.logEntry)).toEqual(existing)
    expect(existing[3]?.content).toContain('Keep these bytes.')

    const repeated = await workspace.dispatch({ action: 'adopt', kind: 'wiki', files: existing }, execution)
    expect(repeated.pages).toEqual([])
    expect(repeated.logEntry).toBeUndefined()

    const sparse = existing.filter(file => file.path.endsWith('/existing.md'))
    const expanded = await workspace.dispatch({ action: 'adopt', kind: 'wiki', files: sparse }, execution)
    expect(expanded.pages.map(page => page.path)).toEqual([
      'wiki/SCHEMA.md', 'wiki/index.md', 'wiki/log.md',
    ])
    expect(expanded.logEntry).toBeUndefined()
    expect(expanded.pages.find(page => page.path === 'wiki/log.md')?.content).not.toContain('adopt-wiki')
    const expandedFiles = applyEmission(sparse, expanded.pages, expanded.logEntry)
    const expandedAgain = await workspace.dispatch({ action: 'adopt', kind: 'wiki', files: expandedFiles }, execution)
    expect(expandedAgain.pages).toEqual([])
    expect(expandedAgain.logEntry).toBeUndefined()
  })

  it('rejects documents for wiki adoption before normalization', async () => {
    let verificationCalls = 0
    const workspace = createRavenWorkspaceEngine({
      now,
      sourceVerifier: {
        verify: async () => {
          verificationCalls += 1
          return []
        },
      },
    })

    await expect(workspace.dispatch({
      action: 'adopt',
      kind: 'wiki',
      files: [],
      documents: [{
        title: 'Unexpected document',
        resource: { origin: 'local', uri: 'file:///workspace/unexpected.md', mediaType: 'text/markdown' },
        representation: {
          format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read',
          inspectionCallId: 'unexpected-read', markdown: '# Unexpected',
        },
      }],
    }, execution)).rejects.toThrow(/documents.*kind=folder.*action=ingest/)
    expect(verificationCalls).toBe(0)
  })

  it('adopts a mixed-document folder through Source Markdown normalization and preserves originals', async () => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const documents = [
      {
        title: 'Original notes',
        resource: { origin: 'local', uri: 'file:///workspace/notes.md', mediaType: 'text/markdown' },
        representation: {
          format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read',
          inspectionCallId: 'read-notes', markdown: '# Notes\n\nOriginal Markdown.\n',
        },
      },
      {
        title: 'Converted brief',
        resource: { origin: 'local', uri: 'file:///workspace/brief.pdf', mediaType: 'application/pdf' },
        representation: {
          format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'document_to_markdown',
          inspectionCallId: 'convert-brief', markdown: '# Brief\n\nNormalized once by the source layer.\n',
        },
      },
    ]

    const adopted = await workspace.dispatch({
      action: 'adopt', kind: 'folder', files: [], documents,
    }, execution)
    const raw = adopted.pages.filter(page => page.path.startsWith('wiki/raw/documents/'))

    expect(raw).toHaveLength(2)
    expect(adopted.pages.some(page => page.path === 'notes.md' || page.path === 'brief.pdf')).toBe(false)
    expect(raw.map(page => frontmatter(page.content).source_uri)).toEqual(expect.arrayContaining([
      '"file:///workspace/notes.md"', '"file:///workspace/brief.pdf"',
    ]))
    expect(raw.find(page => page.content.includes('Normalized once'))?.content)
      .toContain('representation_produced_by: "document_to_markdown"')
    expect(raw.find(page => page.content.includes('Normalized once'))?.content)
      .toContain('capture: normalized-markdown')

    const files = applyEmission([], adopted.pages, adopted.logEntry)
    const repeated = await workspace.dispatch({
      action: 'adopt', kind: 'folder', files, documents,
    }, execution)
    expect(repeated.pages).toEqual([])
    expect(repeated.logEntry).toBeUndefined()
  })

  it('rejects direct web document ingest instead of attesting a Markdown prefix', async () => {
    let verificationCalls = 0
    const workspace = createRavenWorkspaceEngine({
      now,
      sourceVerifier: {
        verify: async () => {
          verificationCalls += 1
          return []
        },
      },
    })
    const forgedMarkdown = `${'trusted '.repeat(125)}\n\nFabricated suffix.`

    await expect(workspace.dispatch({
      action: 'ingest',
      files: [],
      documents: [{
        title: 'Web page',
        resource: { origin: 'web', uri: 'https://example.test/source', mediaType: 'text/markdown' },
        representation: {
          format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'web-fetch',
          markdown: forgedMarkdown,
        },
      }],
    }, execution)).rejects.toThrow(/origin=web.*use grow.*completed Raven Task/)
    expect(verificationCalls).toBe(0)
  })

  it.each([
    ['web', { origin: 'web', uri: 'https://user:token@example.test/private', mediaType: 'text/markdown' }],
    ['llm-wiki', { origin: 'llm-wiki', uri: 'llm-wiki://user:token@vault/page', mediaType: 'text/markdown', sourceName: 'vault' }],
    ['mcp', { origin: 'mcp', uri: 'mcp://user:token@server/resource', mediaType: 'text/markdown', sourceName: 'server' }],
  ])('rejects credential-bearing %s Workspace resource URIs before verification', async (_origin, resource) => {
    let verificationCalls = 0
    const workspace = createRavenWorkspaceEngine({
      now,
      sourceVerifier: {
        verify: async () => {
          verificationCalls += 1
          return []
        },
      },
    })

    await expect(workspace.dispatch({
      action: 'ingest',
      files: [],
      documents: [{
        title: 'Credential-bearing resource',
        resource,
        representation: {
          format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read',
          inspectionCallId: 'credential-read', markdown: '# Private',
        },
      }],
    }, execution)).rejects.toThrow(/must not contain credentials/)
    expect(verificationCalls).toBe(0)
  })

  it('ingests changed material as a new immutable raw revision without corrupting prior knowledge', async () => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const first = await workspace.dispatch({
      action: 'ingest', files: [], documents: [{
        title: 'Living notes',
        resource: { origin: 'local', uri: 'file:///workspace/living.md', mediaType: 'text/markdown' },
        representation: {
          format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read',
          inspectionCallId: 'read-v1', markdown: '# Living\n\nVersion one.\n',
        },
      }],
    }, execution)
    const files = applyEmission([], first.pages, first.logEntry)
    const oldRaw = first.pages.find(page => page.path.startsWith('wiki/raw/documents/'))
    if (oldRaw === undefined) throw new Error('expected first raw page')

    const second = await workspace.dispatch({
      action: 'ingest', files, documents: [{
        title: 'Living notes',
        resource: { origin: 'local', uri: 'file:///workspace/living.md', mediaType: 'text/markdown' },
        representation: {
          format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read',
          inspectionCallId: 'read-v2', markdown: '# Living\n\nVersion two.\n',
        },
      }],
    }, execution)
    const newRaw = second.pages.find(page => page.path.startsWith('wiki/raw/documents/'))

    expect(newRaw?.path).not.toBe(oldRaw.path)
    expect(newRaw?.content).toContain(`supersedes: "${oldRaw.path.replace(/^wiki\//, '')}"`)
    expect(files.find(file => file.path === oldRaw.path)?.content).toBe(oldRaw.content)
  })

  it('grows one concept across completed Tasks while retaining provenance, contradictions, and history', async () => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const firstTask = await completedTask('grow-one')
    const first = await workspace.dispatch({
      action: 'grow', files: [], taskId: firstTask.state.taskId,
      pageType: 'concept', title: 'Durable Workspace', tags: ['research'],
    }, execution, taskContribution(firstTask))
    const concept = first.pages.find(page => page.path === 'wiki/concepts/durable-workspace.md')
    if (concept === undefined) throw new Error('expected concept page')
    const files = applyEmission([], first.pages, first.logEntry)

    const secondTask = await completedTask('grow-two', 'Refine durable workspaces.')
    const secondState = {
      ...secondTask.state,
      claims: [
        { claimId: 'C1', text: 'Position one.', kind: 'analysis' as const, importance: 'material' as const, disposition: 'supported' as const, sourceIds: [], contradicts: ['C2'] },
        { claimId: 'C2', text: 'Position two.', kind: 'analysis' as const, importance: 'material' as const, disposition: 'supported' as const, sourceIds: [], contradicts: ['C1'] },
      ],
    }
    const second = await workspace.dispatch({
      action: 'grow', files, taskId: secondState.taskId,
      pageType: 'concept', title: 'Durable Workspace', tags: ['method'],
    }, execution, taskContribution({ ...secondTask, state: secondState }))
    const grown = second.pages.find(page => page.path === concept.path)

    expect(grown?.content).toContain(`raven_tasks: [${firstTask.state.taskId}, ${secondState.taskId}]`)
    expect(grown?.content).toContain('contested: true')
    expect(grown?.content).toContain('contradictions:')
    expect(grown?.content).toContain(`Raven Task ${firstTask.state.taskId}`)
    expect(grown?.content).toContain(`Raven Task ${secondState.taskId}`)
    expect(grown?.content).toContain('Durable workspaces preserve useful context')

    const repeatedFiles = applyEmission(files, second.pages, second.logEntry)
    const repeated = await workspace.dispatch({
      action: 'grow', files: repeatedFiles, taskId: secondState.taskId,
      pageType: 'concept', title: 'Durable Workspace', tags: ['method'],
    }, execution, taskContribution({ ...secondTask, state: secondState }))
    expect(repeated.pages.filter(page => page.path === concept.path)).toEqual([])
    expect(repeated.logEntry).toBeUndefined()
  })

  it('keeps page freshness at the grow time when an older completed Task arrives out of order', async () => {
    let workspaceAt = '2026-08-16T16:00:00.000Z'
    const workspace = createRavenWorkspaceEngine({ now: () => workspaceAt, sourceVerifier })
    const newerTask = await completedTask('grow-newer-task')
    const first = await workspace.dispatch({
      action: 'grow', files: [], taskId: newerTask.state.taskId,
      pageType: 'concept', title: 'Ordered Freshness',
    }, execution, taskContribution(newerTask))
    const files = applyEmission([], first.pages, first.logEntry)

    workspaceAt = '2027-09-20T08:00:00.000Z'
    const olderTask = await completedTask('grow-older-task')
    const outOfOrderContribution = taskContribution({
      ...olderTask,
      state: {
        ...olderTask.state,
        startedAt: '2024-01-10T09:00:00.000Z',
        updatedAt: '2024-01-11T10:00:00.000Z',
      },
    })
    const grown = await workspace.dispatch({
      action: 'grow', files, taskId: olderTask.state.taskId,
      pageType: 'concept', title: 'Ordered Freshness',
    }, execution, outOfOrderContribution)
    const target = grown.pages.find(page => page.path === 'wiki/concepts/ordered-freshness.md')
    if (target === undefined) throw new Error('expected out-of-order growth page')

    expect(frontmatter(target.content)).toMatchObject({
      created: '2026-08-16',
      updated: '2027-09-20',
    })
    const reuse = await workspace.dispatch({
      action: 'reuse', files: [target], query: 'Ordered Freshness', freshness: 'current', maxAgeDays: 30,
    }, execution)
    expect(reuse.candidates?.[0]).toMatchObject({ updated: '2027-09-20', freshness: 'current' })
  })

  it('round-trips managed YAML lists and preserves unknown frontmatter while growing', async () => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const task = await completedTask('yaml-lists')
    const targetPath = 'wiki/concepts/yaml-lists.md'
    const existing: RavenWorkspaceFile[] = [{
      path: targetPath,
      content: `---
title: "YAML Lists"
created: 2024-01-01
updated: 2024-01-01
type: concept
tags: ["legacy,tag"]
sources:
  - "raw/documents/source,one.md"
confidence: medium
contested: true
raven_tasks:
  - "prior,task"
contradictions:
  - "prior,conflict"
custom_metadata:
  owner: research
# preserve this comment
---
# YAML Lists

Existing history.
`,
    }]

    const grown = await workspace.dispatch({
      action: 'grow', files: existing, taskId: task.state.taskId,
      pageType: 'concept', title: 'YAML Lists',
    }, execution, taskContribution(task))
    const target = grown.pages.find(page => page.path === targetPath)
    if (target === undefined) throw new Error('expected grown YAML list page')

    expect(target.content).toContain('tags: ["legacy,tag", general-writing]')
    expect(target.content).toContain('sources:\n  - "raw/documents/source,one.md"')
    expect(target.content).toContain(`raven_tasks:\n  - "prior,task"\n  - ${task.state.taskId}`)
    expect(target.content.match(/raw\/documents\/source,one\.md/g)).toHaveLength(1)
    expect(target.content).toContain('contradictions:\n  - "prior,conflict"')
    expect(target.content).toContain('custom_metadata:\n  owner: research\n# preserve this comment')
    const reuse = await workspace.dispatch({
      action: 'reuse', files: [target], query: 'durable workspaces',
    }, execution)
    expect(reuse.candidates?.[0]?.sources).toEqual(['raw/documents/source,one.md'])

    const repeatedFiles = applyEmission(existing, grown.pages, grown.logEntry)
    const repeated = await workspace.dispatch({
      action: 'grow', files: repeatedFiles, taskId: task.state.taskId,
      pageType: 'concept', title: 'YAML Lists',
    }, execution, taskContribution(task))
    expect(repeated.pages.filter(page => page.path === targetPath)).toEqual([])
  })

  it('fails closed when a managed frontmatter list has an unsupported YAML shape', async () => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const task = await completedTask('yaml-unsafe')
    const existing: RavenWorkspaceFile[] = [{
      path: 'wiki/concepts/unsafe-yaml.md',
      content: '---\ntitle: "Unsafe YAML"\ncreated: 2024-01-01\nupdated: 2024-01-01\ntype: concept\ntags: []\nsources:\n  primary: raw/documents/a.md\nconfidence: medium\nraven_tasks: []\n---\n# Unsafe YAML\n',
    }]

    await expect(workspace.dispatch({
      action: 'grow', files: existing, taskId: task.state.taskId,
      pageType: 'concept', title: 'Unsafe YAML',
    }, execution, taskContribution(task))).rejects.toThrow(/parseable frontmatter|safe YAML sequence/)
  })

  it.each(WORKSPACE_PAGE_TYPES)('grows existing %s pages without replacing their history', async (pageType) => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const firstTask = await completedTask(`page-${pageType}-a`)
    const title = `${pageType} knowledge`
    const first = await workspace.dispatch({
      action: 'grow', files: [], taskId: firstTask.state.taskId, pageType, title,
    }, execution, taskContribution(firstTask))
    const files = applyEmission([], first.pages, first.logEntry)
    const secondTask = await completedTask(`page-${pageType}-b`)
    const second = await workspace.dispatch({
      action: 'grow', files, taskId: secondTask.state.taskId, pageType, title,
    }, execution, taskContribution(secondTask))
    const directory = {
      query: 'queries', concept: 'concepts', entity: 'entities', comparison: 'comparisons',
    }[pageType]
    const target = second.pages.find(page => page.path === `wiki/${directory}/${pageType}-knowledge.md`)

    expect(target?.content).toContain(`Raven Task ${firstTask.state.taskId}`)
    expect(target?.content).toContain(`Raven Task ${secondTask.state.taskId}`)

    const grownFiles = applyEmission(files, second.pages, second.logEntry)
    const maintained = await workspace.dispatch({ action: 'maintain', complete: true, files: grownFiles }, execution)
    const finalFiles = applyEmission(grownFiles, maintained.pages, maintained.logEntry)
    const report = await workspace.dispatch({ action: 'health', complete: true, files: finalFiles }, execution)
    expect(report.health?.issues.map(item => item.code)).not.toContain('page-type-mismatch')
  })

  it.each(['health', 'maintain'] as const)('requires complete=true for global %s operations', async (action) => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const initialized = await workspace.dispatch({ action: 'initialize', files: [] }, execution)
    const files = applyEmission([], initialized.pages, initialized.logEntry)

    await expect(workspace.dispatch({ action, files }, execution)).rejects.toThrow(/complete=true/)
    await expect(workspace.dispatch({ action, complete: false, files }, execution)).rejects.toThrow(/complete=true/)
    await expect(workspace.dispatch({ action, complete: true, files }, execution)).resolves.toMatchObject({ action })
  })

  it('decodes quoted raw digests while still rejecting mismatches', async () => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const rawBody = '# Raw\n\nImmutable bytes.\n'
    const files: RavenWorkspaceFile[] = [
      { path: 'wiki/SCHEMA.md', content: '# Wiki Schema\n' },
      { path: 'wiki/log.md', content: '# Wiki Log\n' },
      { path: 'wiki/index.md', content: '# Wiki Index\n' },
      {
        path: 'wiki/raw/documents/quoted.md',
        content: `---\nsource_uri: "file:///quoted.md"\nsha256: "${createHash('sha256').update(rawBody).digest('hex')}"\ncapture: normalized-markdown\n---\n${rawBody}`,
      },
    ]

    const healthy = await workspace.dispatch({ action: 'health', complete: true, files }, execution)
    expect(healthy.health).toMatchObject({ status: 'healthy', issues: [] })

    const wrongDigestFiles = files.map(file => file.path === 'wiki/raw/documents/quoted.md'
      ? { ...file, content: file.content.replace(/sha256: "[a-f0-9]+"/, `sha256: "${'0'.repeat(64)}"`) }
      : file)
    const unhealthy = await workspace.dispatch({ action: 'health', complete: true, files: wrongDigestFiles }, execution)
    expect(unhealthy.health?.status).toBe('unhealthy')
    expect(unhealthy.health?.issues.map(item => item.code)).toEqual(['raw-digest-mismatch'])
  })

  it('regenerates the index, reports health defects, and returns stored knowledge with freshness guidance', async () => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const badRawBody = '# Raw\n\nChanged bytes.\n'
    const files: RavenWorkspaceFile[] = [
      { path: 'wiki/SCHEMA.md', content: '# Wiki Schema\n' },
      { path: 'wiki/log.md', content: '# Wiki Log\n' },
      { path: 'wiki/index.md', content: '# Wiki Index\n\n<!-- raven-workspace-index:v1 -->\n' },
      {
        path: 'wiki/concepts/workspace.md',
        content: '---\ntitle: Workspace\ncreated: 2024-01-01\nupdated: 2024-01-01\ntype: concept\ntags: [research]\nsources: [raw/documents/missing.md]\nconfidence: medium\n---\n# Workspace\n\nA durable Markdown knowledge substrate.\n',
      },
      {
        path: 'wiki/raw/documents/bad.md',
        content: `---\nsource_uri: "file:///bad.md"\nsha256: ${createHash('sha256').update('other').digest('hex')}\ncapture: normalized-markdown\n---\n${badRawBody}`,
      },
    ]

    const unhealthy = await workspace.dispatch({ action: 'health', complete: true, files }, execution)
    expect(unhealthy.health?.status).toBe('unhealthy')
    expect(unhealthy.health?.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'raw-digest-mismatch', 'dangling-source', 'stale-index',
    ]))

    const maintained = await workspace.dispatch({ action: 'maintain', complete: true, files }, execution)
    const index = maintained.pages.find(page => page.path === 'wiki/index.md')
    expect(index?.content).toContain('[[concepts/workspace|Workspace]]')
    expect(index?.content).toContain('A durable Markdown knowledge substrate.')

    const maintainedFiles = applyEmission(files, maintained.pages, maintained.logEntry)
    const reuse = await workspace.dispatch({
      action: 'reuse', files: maintainedFiles, query: 'durable workspace knowledge',
      freshness: 'current', maxAgeDays: 30, maxResults: 5,
    }, execution)
    expect(reuse.candidates?.[0]).toMatchObject({
      path: 'wiki/concepts/workspace.md',
      knowledgeStatus: 'stored',
      freshness: 'stale',
      requiresFreshVerification: true,
    })
  })

  it('reuses exact-title and body matches for one-character Han terms but filters Latin and digit noise', async () => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const page = (path: string, title: string, body: string): RavenWorkspaceFile => ({
      path,
      content: `---\ntitle: "${title}"\ncreated: 2026-08-16\nupdated: 2026-08-16\ntype: concept\ntags: []\nsources: []\nconfidence: high\n---\n# ${title}\n\n${body}\n`,
    })
    const files = [
      page('wiki/concepts/han-title.md', '税', '财政制度。'),
      page('wiki/concepts/han-body.md', 'Fiscal Policy', '税'),
      page('wiki/concepts/latin-noise.md', 'A', 'Single Latin character.'),
      page('wiki/concepts/digit-noise.md', '7', 'Single digit character.'),
    ]

    const han = await workspace.dispatch({ action: 'reuse', files, query: '税' }, execution)
    expect(han.candidates?.map(candidate => candidate.path)).toEqual([
      'wiki/concepts/han-title.md',
      'wiki/concepts/han-body.md',
    ])
    expect((han.candidates?.[0]?.score ?? 0)).toBeGreaterThan(han.candidates?.[1]?.score ?? 0)

    const latin = await workspace.dispatch({ action: 'reuse', files, query: 'a' }, execution)
    const digit = await workspace.dispatch({ action: 'reuse', files, query: '7' }, execution)
    expect(latin.candidates).toEqual([])
    expect(digit.candidates).toEqual([])
  })

  it('scores only the first 32 distinct lexical query terms deterministically', async () => {
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier })
    const files: RavenWorkspaceFile[] = [{
      path: 'wiki/concepts/term-ceiling.md',
      content: '---\ntitle: "Term Ceiling"\ncreated: 2026-08-16\nupdated: 2026-08-16\ntype: concept\ntags: []\nsources: []\nconfidence: high\n---\n# Term Ceiling\n\noverflowtoken appears only in the body.\n',
    }]
    const firstThirtyTwo = Array.from({ length: 32 }, (_, index) => `term${index}`)

    const beyondCeiling = await workspace.dispatch({
      action: 'reuse', files, query: [...firstThirtyTwo, 'overflowtoken'].join(' '),
    }, execution)
    const withinCeiling = await workspace.dispatch({
      action: 'reuse', files, query: ['overflowtoken', ...firstThirtyTwo].join(' '),
    }, execution)

    expect(beyondCeiling.candidates).toEqual([])
    expect(withinCeiling.candidates?.map(candidate => candidate.path)).toEqual(['wiki/concepts/term-ceiling.md'])
  })

  it('makes repeated ingest stable across time and exposes conditional write preconditions', async () => {
    let at = '2026-08-16T16:00:00.000Z'
    const timedVerifier: SourceVerifier = {
      verify: async sources => sources.map(source => ({
        sourceId: source.sourceId, status: 'reachable', checkedAt: at,
      })),
    }
    const workspace = createRavenWorkspaceEngine({ now: () => at, sourceVerifier: timedVerifier })
    const document = {
      title: 'Stable source',
      resource: { origin: 'local', uri: 'file:///workspace/stable.md', mediaType: 'text/markdown' },
      representation: {
        format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read',
        inspectionCallId: 'stable-read', markdown: '# Stable\n\nSame bytes.\n',
      },
    }
    const first = await workspace.dispatch({ action: 'ingest', files: [], documents: [document] }, execution)
    expect(first.preconditions).toEqual(first.pages.map(page => ({ path: page.path, expected: 'absent' })))
    const files = applyEmission([], first.pages, first.logEntry)

    at = '2027-09-20T08:00:00.000Z'
    const repeated = await workspace.dispatch({ action: 'ingest', files, documents: [document] }, execution)
    expect(repeated.pages).toEqual([])
    expect(repeated.logEntry).toBeUndefined()

    const withPage = [...files, {
      path: 'wiki/concepts/stable.md',
      content: '---\ntitle: Stable\ncreated: 2026-08-16\nupdated: 2026-08-16\ntype: concept\ntags: []\nsources: []\nconfidence: high\n---\n# Stable\n\nStable concept.\n',
    }]
    const maintained = await workspace.dispatch({ action: 'maintain', complete: true, files: withPage }, execution)
    expect(maintained.preconditions.find(item => item.path === 'wiki/index.md')?.expected)
      .toBe(`sha256:${createHash('sha256').update(files.find(file => file.path === 'wiki/index.md')?.content ?? '').digest('hex')}`)
  })

  it('records failed normalization and a later successful retry exactly once each', async () => {
    let acceptsNormalization = false
    const retryingVerifier: SourceVerifier = {
      verify: async sources => sources.map(source => acceptsNormalization
        ? { sourceId: source.sourceId, status: 'reachable' as const, checkedAt: now() }
        : {
            sourceId: source.sourceId,
            status: 'unavailable' as const,
            checkedAt: now(),
            detail: 'converter unavailable',
          }),
    }
    const workspace = createRavenWorkspaceEngine({ now, sourceVerifier: retryingVerifier })
    const document = {
      title: 'Retry source',
      resource: { origin: 'local', uri: 'file:///workspace/retry.md', mediaType: 'text/markdown' },
      representation: {
        format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read',
        inspectionCallId: 'retry-read', markdown: '# Retry\n\nRecovered bytes.\n',
      },
    }

    const failed = await workspace.dispatch({ action: 'ingest', files: [], documents: [document] }, execution)
    expect(failed.status).toBe('needs-revision')
    const failedFiles = applyEmission([], failed.pages, failed.logEntry)
    const failedLog = failedFiles.find(file => file.path === 'wiki/log.md')?.content ?? ''
    const failedMarkers = [...failedLog.matchAll(/<!-- raven-workspace-op:([a-f0-9]+) -->/g)].map(match => match[1])
    expect(failedMarkers).toHaveLength(1)
    expect(failedLog).toContain('Documents accepted: 0')

    acceptsNormalization = true
    const succeeded = await workspace.dispatch({ action: 'ingest', files: failedFiles, documents: [document] }, execution)
    expect(succeeded.status).toBe('ready')
    expect(succeeded.pages.some(page => page.path.startsWith('wiki/raw/documents/'))).toBe(true)
    expect(succeeded.logEntry).toContain('Documents accepted: 1')
    const succeededFiles = applyEmission(failedFiles, succeeded.pages, succeeded.logEntry)
    const succeededLog = succeededFiles.find(file => file.path === 'wiki/log.md')?.content ?? ''
    const outcomeMarkers = [...succeededLog.matchAll(/<!-- raven-workspace-op:([a-f0-9]+) -->/g)].map(match => match[1])
    expect(new Set(outcomeMarkers).size).toBe(2)
    expect(outcomeMarkers).toHaveLength(2)

    const repeated = await workspace.dispatch({ action: 'ingest', files: succeededFiles, documents: [document] }, execution)
    expect(repeated.pages).toEqual([])
    expect(repeated.logEntry).toBeUndefined()
    expect(applyEmission(succeededFiles, repeated.pages, repeated.logEntry)).toEqual(succeededFiles)
  })

  it('contains SourceVerifier rejection as per-document normalization issues without raw writes', async () => {
    const workspace = createRavenWorkspaceEngine({
      now,
      sourceVerifier: {
        verify: async () => { throw new Error('verifier offline') },
      },
    })
    const documents = ['one', 'two'].map(name => ({
      title: `Document ${name}`,
      resource: { origin: 'local', uri: `file:///workspace/${name}.md`, mediaType: 'text/markdown' },
      representation: {
        format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read',
        inspectionCallId: `read-${name}`, markdown: `# ${name}`,
      },
    }))

    const rejected = await workspace.dispatch({ action: 'ingest', files: [], documents }, execution)

    expect(rejected.status).toBe('needs-revision')
    expect(rejected.issues).toHaveLength(2)
    expect(rejected.issues.every(item => item.code === 'normalization-unverified')).toBe(true)
    expect(rejected.issues.map(item => item.detail).join(' ')).toContain('verifier offline')
    expect(rejected.pages.some(page => page.path.startsWith('wiki/raw/'))).toBe(false)
  })

  it('propagates abort when a Workspace SourceVerifier never settles', { timeout: 2_000 }, async () => {
    const workspace = createRavenWorkspaceEngine({
      now,
      sourceVerifier: {
        verify: () => new Promise<never>(() => undefined),
      },
    })
    const controller = new AbortController()
    const pending = workspace.dispatch({
      action: 'ingest',
      files: [],
      documents: [{
        title: 'Stuck document',
        resource: { origin: 'local', uri: 'file:///workspace/stuck.md', mediaType: 'text/markdown' },
        representation: {
          format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read',
          inspectionCallId: 'read-stuck', markdown: '# Stuck',
        },
      }],
    }, { sessionId: 'workspace-abort', signal: controller.signal })
    controller.abort(new Error('cancelled Workspace verifier'))

    await expect(pending).rejects.toThrow('cancelled Workspace verifier')
  })

  it('fails closed on unsafe paths, unavailable normalization, and title-slug collisions', async () => {
    const workspace = createRavenWorkspaceEngine({
      now,
      sourceVerifier: {
        verify: async sources => sources.map(source => ({
          sourceId: source.sourceId, status: 'unavailable', checkedAt: now(), detail: 'converter unavailable',
        })),
      },
    })
    await expect(workspace.dispatch({
      action: 'health', complete: true, files: [{ path: 'wiki/../outside.md', content: '# Outside' }],
    }, execution)).rejects.toThrow(/stay below wiki/)
    await expect(workspace.dispatch({
      action: 'health',
      complete: true,
      files: [
        { path: 'wiki/concepts/Case.md', content: '# One' },
        { path: 'wiki/concepts/case.md', content: '# Two' },
      ],
    }, execution)).rejects.toThrow(/case-insensitive path collision/)

    const unavailable = await workspace.dispatch({
      action: 'ingest', files: [], documents: [{
        title: 'Unavailable document',
        resource: { origin: 'local', uri: 'file:///workspace/input.pdf', mediaType: 'application/pdf' },
        representation: {
          format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'document_to_markdown',
          inspectionCallId: 'failed-conversion', markdown: '# Candidate',
        },
      }],
    }, execution)
    expect(unavailable.status).toBe('needs-revision')
    expect(unavailable.issues.map(item => item.code)).toContain('normalization-unverified')
    expect(unavailable.pages.some(page => page.path.startsWith('wiki/raw/'))).toBe(false)

    const accepting = createRavenWorkspaceEngine({ now, sourceVerifier })
    const taskA = await completedTask('slug-a')
    const first = await accepting.dispatch({
      action: 'grow', files: [], taskId: taskA.state.taskId, pageType: 'concept', title: 'A/B',
    }, execution, taskContribution(taskA))
    const files = applyEmission([], first.pages, first.logEntry)
    const taskB = await completedTask('slug-b')
    await expect(accepting.dispatch({
      action: 'grow', files, taskId: taskB.state.taskId, pageType: 'concept', title: 'A B',
    }, execution, taskContribution(taskB))).rejects.toThrow(/already belongs to title/)
  })
})
