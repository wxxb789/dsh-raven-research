import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createRavenEngine } from '../../src/engine.js'
import type { RavenDispatchResult, SourceVerifier } from '../../src/domain.js'
import { renderWikiPages } from '../../src/wiki.js'

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

function pageAt(result: RavenDispatchResult, path: string | RegExp) {
  const page = result.wiki?.pages.find(item => typeof path === 'string'
    ? item.path === path
    : path.test(item.path))
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
    // The trailing digest is what keeps two long, similarly-titled Sources from
    // colliding on one truncated slug and overwriting each other.
    expect(fields.sources).toMatch(
      /^\[raw\/articles\/a1-vendor-a-durability-[a-f0-9]{8}\.md, raw\/articles\/b1-vendor-b-durability-[a-f0-9]{8}\.md\]$/,
    )
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

    const raw = pageAt(exported, /^wiki\/raw\/articles\/a1-vendor-a-durability-[a-f0-9]{8}\.md$/)
    const fields = frontmatter(raw.content)
    expect(fields.source_url).toBe('"https://vendor-a.test/durability"')
    expect(fields.source_origin).toBe('web')
    expect(fields.source_uri).toBe('"https://vendor-a.test/durability"')
    expect(fields.representation).toBe('converted')
    expect(fields.representation_produced_by).toBe('"web_fetch"')
    expect(fields.ingested).toBe('2026-08-16')
    // Raven stores the verified excerpt, never a full page capture, and says so.
    expect(fields.capture).toBe('excerpt-only')
    expect(fields.verification).toBe('reachable')
    expect(fields.source_family).toBe('"vendor-a-docs"')
    // llm-wiki drift detection requires the digest to cover exactly the body.
    expect(fields.sha256).toBe(createHash('sha256').update(body(raw.content)).digest('hex'))
    expect(body(raw.content)).toContain('durable before acknowledgement')
  })

  it('keeps a local Original Resource distinct from its Markdown representation', async () => {
    const localVerifier: SourceVerifier = {
      verify: async sources => sources.map(source => ({ sourceId: source.sourceId, status: 'reachable', checkedAt: now() })),
    }
    const engine = createRavenEngine({ now, sourceVerifier: localVerifier })
    const started = await engine.dispatch(null, {
      action: 'start', outcome: 'general-writing', grounding: 'none', request: 'Record local source provenance.',
      sourcePolicy: { localRoots: ['file:///workspace'] },
    }, { sessionId: 'wiki-local-provenance', signal })
    const draft = await engine.dispatch(started.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'read', summary: 'Local provenance recorded.',
      artifact: 'Local evidence [@LOCAL1].',
      sources: [{
        sourceId: 'LOCAL1', title: 'Local notes\n## forged', locator: 'Heading', excerpt: 'An exact local excerpt.',
        resource: { origin: 'local', uri: 'file:///workspace/notes.md', mediaType: 'text/markdown' },
        representation: { format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read', inspectionCallId: 'inspect-wiki-local', markdown: '# Notes\n\nAn exact local excerpt.' },
      }],
      claims: [{
        claimId: 'LOCAL-C1', text: 'Local evidence.', kind: 'external', importance: 'material',
        disposition: 'supported', sourceIds: ['LOCAL1'],
      }],
    }, { sessionId: 'wiki-local-provenance', signal })
    const exported = await engine.dispatch(draft.state, {
      action: 'export', taskId: started.state.taskId, title: 'Local Provenance',
    }, { sessionId: 'wiki-local-provenance', signal })
    const raw = pageAt(exported, /^wiki\/raw\/articles\/local1-local-notes-forged-[a-f0-9]{8}\.md$/)
    const fields = frontmatter(raw.content)

    expect(fields.source_origin).toBe('local')
    expect(fields.source_uri).toBe('"file:///workspace/notes.md"')
    expect(fields.source_media_type).toBe('"text/markdown"')
    expect(fields.representation).toBe('original')
    expect(fields.representation_produced_by).toBe('"read"')
    expect(fields.inspection_call_id).toBe('"inspect-wiki-local"')
    expect(fields.inspection_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(body(raw.content)).toContain('# Local notes \\#\\# forged')
    expect(body(raw.content)).not.toContain('\n## forged')
    expect(body(raw.content)).toContain(String.raw`Inspection call: inspect\-wiki\-local`)
    expect(body(raw.content)).toContain(String.raw`Original resource: file:///workspace/notes\.md`)
    expect(body(raw.content)).toContain('Markdown representation: original full Markdown by read')
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

  it('declares an unverified Source unverified rather than omitting the marker', async () => {
    // A7: an unchecked Source used to emit no `verification:` field at all, so the
    // page carried only `capture: excerpt-only` and a sha256 — which reads exactly
    // like a verified capture, letting an unverified excerpt harden into wiki fact.
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Record an excerpt that was never reopened.',
    }, { sessionId: 'wiki-unverified', signal })
    const draft = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'read',
      summary: 'An uncited Source recorded for later verification.',
      artifact: 'A paragraph that does not cite the recorded Source yet.',
      sources: [{
        sourceId: 'U1',
        url: 'https://unverified.test/page',
        title: 'Never reopened',
        locator: 'Section 1',
        excerpt: 'an excerpt nobody confirmed',
        role: 'primary',
      }],
    }, { sessionId: 'wiki-unverified', signal })
    expect(draft.status).toBe('active')
    expect(draft.state.sources[0]?.check.status).toBe('unchecked')

    const exported = await engine.dispatch(draft.state, {
      action: 'export',
      taskId: started.state.taskId,
      title: 'Unverified Excerpt',
    }, { sessionId: 'wiki-unverified', signal })

    const raw = pageAt(exported, /^wiki\/raw\/articles\/u1-never-reopened-[a-f0-9]{8}\.md$/)
    const fields = frontmatter(raw.content)
    expect(fields.verification).toBe('unverified')
    expect(fields.verified_at).toBeUndefined()
    expect(body(raw.content)).toContain("NOT confirmed against the Source's Markdown representation")
    // The digest still covers exactly the body, so llm-wiki drift detection works.
    expect(fields.sha256).toBe(createHash('sha256').update(body(raw.content)).digest('hex'))
  })

  it('gives two long similarly-titled Sources distinct raw pages', async () => {
    // A13: slug() truncates to 80 characters, so these two used to collide on one
    // path and the second silently overwrote the first.
    const long = 'A Very Long Government Report On Durable Storage Acknowledgement Semantics Volume'
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Record two near-identically titled Sources.',
    }, { sessionId: 'wiki-collision', signal })
    const draft = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'read',
      summary: 'Two long, near-identical titles.',
      artifact: 'A paragraph recording two similarly titled reports.',
      sources: [
        {
          sourceId: 'L1',
          url: 'https://example.test/volume-one',
          title: `${long} One`,
          locator: 'Section 1',
          excerpt: 'volume one excerpt',
          role: 'primary',
        },
        {
          sourceId: 'L2',
          url: 'https://example.test/volume-two',
          title: `${long} Two`,
          locator: 'Section 1',
          excerpt: 'volume two excerpt',
          role: 'primary',
        },
      ],
    }, { sessionId: 'wiki-collision', signal })

    const exported = await engine.dispatch(draft.state, {
      action: 'export',
      taskId: started.state.taskId,
      title: 'Two Volumes',
    }, { sessionId: 'wiki-collision', signal })

    const rawPaths = (exported.wiki?.pages ?? [])
      .map(page => page.path)
      .filter(path => path.startsWith('wiki/raw/'))
    expect(rawPaths).toHaveLength(2)
    expect(new Set(rawPaths).size).toBe(2)
  })

  it('keeps immutable raw Source bytes stable when the same Task is projected later', async () => {
    const { completed } = await completedResearchTask('wiki-later-projection')
    const artifact = completed.renderedArtifact ?? completed.state.latestArtifact ?? ''
    const first = renderWikiPages(completed.state, artifact, {
      title: 'Durable Event Stores', tags: ['research'], init: false, at: '2026-08-16T16:00:00.000Z',
    })
    const later = renderWikiPages(completed.state, artifact, {
      title: 'Durable Event Stores', tags: ['research'], init: false, at: '2027-09-20T08:00:00.000Z',
    })
    const firstRaw = first.pages.filter(page => page.path.startsWith('wiki/raw/'))
    const laterRaw = later.pages.filter(page => page.path.startsWith('wiki/raw/'))

    expect(laterRaw).toEqual(firstRaw)
  })

  it('exports the same Task twice as byte-identical pages and one log entry', async () => {
    // A13: an export that is not a pure projection would ask the agent to rewrite
    // files with different bytes and to append the same history twice.
    const { engine, completed } = await completedResearchTask('wiki-idempotent')
    const request = {
      action: 'export',
      taskId: completed.state.taskId,
      title: 'Durable Event Stores',
      tags: ['research', 'storage'],
    }
    const first = await engine.dispatch(completed.state, request, { sessionId: 'wiki-idempotent', signal })
    const second = await engine.dispatch(first.state, request, { sessionId: 'wiki-idempotent', signal })

    expect(second.wiki?.pages).toEqual(first.wiki?.pages)
    expect(second.wiki?.logEntry).toBe(first.wiki?.logEntry)
    // Export is read-only: it never advances the Task, so nothing accumulates.
    expect(second.state).toBe(first.state)
    expect(new Set((first.wiki?.pages ?? []).map(page => page.path)).size)
      .toBe(first.wiki?.pages.length)
  })
})
