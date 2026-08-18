import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createRavenEngine } from '../../src/engine.js'
import type { RavenDispatchResult, SourceVerifier } from '../../src/domain.js'

const signal = new AbortController().signal
const now = () => '2026-08-16T16:00:00.000Z'
const sourceVerifier: SourceVerifier = {
  verify: async sources => sources.map(source => ({
    sourceId: source.sourceId,
    status: 'reachable',
    checkedAt: now(),
    statusCode: 200,
    resolvedUrl: source.url,
  })),
}

function frontmatter(content: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content)
  if (match === null) throw new Error('page has no frontmatter')
  const fields: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    const field = /^([a-z0-9_]+):\s*(.*)$/.exec(line)
    if (field !== null) fields[field[1] ?? ''] = (field[2] ?? '').trim()
  }
  return fields
}

function body(content: string): string {
  const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(content)
  if (match === null) throw new Error('page has no body')
  return match[1] ?? ''
}

async function completedResearchTask(session: string) {
  const engine = createRavenEngine({ now, sourceVerifier })
  const started = await engine.dispatch(null, {
    action: 'start',
    outcome: 'research',
    request: 'Compare two durable event stores.',
  }, { sessionId: session, signal })
  const draft = await engine.dispatch(started.state, {
    action: 'checkpoint',
    taskId: started.state.taskId,
    stage: 'draft',
    summary: 'Both vendors documented.',
    artifact: 'Vendor A acknowledges durably [@A1]. Vendor B disagrees [@B1].',
    sources: [
      {
        sourceId: 'A1',
        url: 'https://vendor-a.test/durability',
        title: 'Vendor A durability',
        locator: 'Durability',
        excerpt: 'durable before acknowledgement',
        role: 'primary',
        sourceFamily: 'vendor-a-docs',
      },
      {
        sourceId: 'B1',
        url: 'https://vendor-b.test/durability',
        title: 'Vendor B durability',
        locator: 'Durability',
        excerpt: 'acknowledged before flush',
        role: 'primary',
        sourceFamily: 'vendor-b-docs',
      },
    ],
    claims: [
      {
        claimId: 'A-C1',
        text: 'Vendor A acknowledges durably.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['A1'],
        contradicts: ['B-C1'],
      },
      {
        claimId: 'B-C1',
        text: 'Vendor B disagrees.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['B1'],
        contradicts: ['A-C1'],
      },
    ],
  }, { sessionId: session, signal })
  const completed = await engine.dispatch(draft.state, {
    action: 'complete',
    taskId: started.state.taskId,
    artifact: draft.state.latestArtifact,
  }, { sessionId: session, signal })
  return { engine, completed }
}

function pageAt(result: RavenDispatchResult, path: string) {
  const page = result.wiki?.pages.find(item => item.path === path)
  if (page === undefined) {
    throw new Error(`missing ${path}; got ${(result.wiki?.pages ?? []).map(item => item.path).join(', ')}`)
  }
  return page
}

describe('llm-wiki emission', () => {
  it('exports a completed Task as a valid llm-wiki artifact page', async () => {
    const { engine, completed } = await completedResearchTask('wiki-session')
    const exported = await engine.dispatch(completed.state, {
      action: 'export',
      taskId: completed.state.taskId,
      title: 'Durable Event Stores',
      tags: ['research', 'storage'],
    }, { sessionId: 'wiki-session', signal })

    expect(exported.status).toBe('completed')
    const page = pageAt(exported, 'wiki/queries/query-2026-08-16-durable-event-stores.md')
    const fields = frontmatter(page.content)
    expect(fields.title).toBe('"Durable Event Stores"')
    expect(fields.type).toBe('query')
    expect(fields.created).toBe('2026-08-16')
    expect(fields.updated).toBe('2026-08-16')
    expect(fields.tags).toBe('[research, storage]')
    // Every Source becomes a raw/ page and is listed as a source of this page.
    expect(fields.sources).toBe('[raw/articles/a1-vendor-a-durability.md, raw/articles/b1-vendor-b-durability.md]')
    // Contradiction links registered on Claims surface as llm-wiki contested pages.
    expect(fields.contested).toBe('true')
    expect(body(page.content)).toContain('Vendor A durability')
  })

  it('writes each Source as an immutable raw page with a body-accurate digest', async () => {
    const { engine, completed } = await completedResearchTask('wiki-raw-session')
    const exported = await engine.dispatch(completed.state, {
      action: 'export',
      taskId: completed.state.taskId,
      title: 'Durable Event Stores',
    }, { sessionId: 'wiki-raw-session', signal })

    const raw = pageAt(exported, 'wiki/raw/articles/a1-vendor-a-durability.md')
    const fields = frontmatter(raw.content)
    expect(fields.source_url).toBe('https://vendor-a.test/durability')
    expect(fields.ingested).toBe('2026-08-16')
    // Raven stores the verified excerpt, never a full page capture, and says so.
    expect(fields.capture).toBe('excerpt-only')
    expect(fields.verification).toBe('reachable')
    expect(fields.source_family).toBe('"vendor-a-docs"')
    // llm-wiki drift detection requires the digest to cover exactly the body.
    expect(fields.sha256).toBe(createHash('sha256').update(body(raw.content)).digest('hex'))
    expect(body(raw.content)).toContain('durable before acknowledgement')
  })

  it('emits an appendable log entry rather than rewriting the log', async () => {
    const { engine, completed } = await completedResearchTask('wiki-log-session')
    const exported = await engine.dispatch(completed.state, {
      action: 'export',
      taskId: completed.state.taskId,
      title: 'Durable Event Stores',
    }, { sessionId: 'wiki-log-session', signal })

    expect(exported.wiki?.logEntry).toMatch(/^## \[2026-08-16\] raven \| research/)
    expect(exported.wiki?.logEntry).toContain(completed.state.taskId)
    expect(exported.wiki?.pages.some(page => page.path === 'wiki/log.md')).toBe(false)
  })

  it('seeds SCHEMA, index, and log only when initializing a repository', async () => {
    const { engine, completed } = await completedResearchTask('wiki-init-session')
    const plain = await engine.dispatch(completed.state, {
      action: 'export',
      taskId: completed.state.taskId,
      title: 'Durable Event Stores',
    }, { sessionId: 'wiki-init-session', signal })
    expect(plain.wiki?.pages.some(page => page.path === 'wiki/SCHEMA.md')).toBe(false)

    const seeded = await engine.dispatch(completed.state, {
      action: 'export',
      taskId: completed.state.taskId,
      title: 'Durable Event Stores',
      init: true,
    }, { sessionId: 'wiki-init-session', signal })
    const schema = pageAt(seeded, 'wiki/SCHEMA.md')
    expect(schema.content).toContain('capture: excerpt-only')
    expect(schema.content).toContain('raw/')
    expect(pageAt(seeded, 'wiki/index.md').content).toContain('# Wiki Index')
    expect(pageAt(seeded, 'wiki/log.md').content).toContain('# Wiki Log')
  })

  it('reports confidence honestly from the Task phase and its limits', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Draft one clean paragraph.',
    }, { sessionId: 'wiki-conf-session', signal })
    const draft = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A clean paragraph.',
      artifact: 'A clean paragraph with no external Claims.',
    }, { sessionId: 'wiki-conf-session', signal })

    // Still active: the artifact is work in progress, never high confidence.
    const active = await engine.dispatch(draft.state, {
      action: 'export',
      taskId: started.state.taskId,
      title: 'Clean Paragraph',
    }, { sessionId: 'wiki-conf-session', signal })
    expect(frontmatter(pageAt(active, 'wiki/queries/query-2026-08-16-clean-paragraph.md').content).confidence).toBe('low')

    const completed = await engine.dispatch(draft.state, {
      action: 'complete',
      taskId: started.state.taskId,
      artifact: draft.state.latestArtifact,
    }, { sessionId: 'wiki-conf-session', signal })
    const done = await engine.dispatch(completed.state, {
      action: 'export',
      taskId: started.state.taskId,
      title: 'Clean Paragraph',
    }, { sessionId: 'wiki-conf-session', signal })
    expect(frontmatter(pageAt(done, 'wiki/queries/query-2026-08-16-clean-paragraph.md').content).confidence).toBe('high')
  })
})
