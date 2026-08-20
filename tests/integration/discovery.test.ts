import { describe, expect, it, vi } from 'vitest'

import { createRavenEngine, renderLeads } from '../../src/engine.js'
import * as RavenPlugin from '../../src/index.js'
import type { LeadSearchResult, SourceSearcher, SourceVerifier } from '../../src/domain.js'

const signal = new AbortController().signal
const now = () => '2026-08-19T09:00:00.000Z'
const sourceVerifier: SourceVerifier = {
  verify: async sources => sources.map(source => ({
    sourceId: source.sourceId,
    status: 'reachable' as const,
    checkedAt: now(),
    statusCode: 200,
    resolvedUrl: source.url,
  })),
}

const emptyOutcome: LeadSearchResult = { leads: [], failures: [], truncated: false, notes: [] }

async function startedTask(engine: ReturnType<typeof createRavenEngine>, sessionId: string) {
  return engine.dispatch(null, {
    action: 'start',
    outcome: 'research',
    request: 'Find what the record actually says.',
  }, { sessionId, signal })
}

describe('Raven Lead discovery', () => {
  it('sends one batch of complementary queries and returns Leads, never Sources', async () => {
    const seen: string[][] = []
    const sourceSearcher: SourceSearcher = {
      search: async (request) => {
        seen.push([...request.queries])
        return {
          ...emptyOutcome,
          leads: [
            { url: 'https://one.test/a', title: 'A', queries: [...request.queries] },
            { url: 'https://two.test/b', queries: [request.queries[0] ?? ''] },
          ],
        }
      },
    }
    const engine = createRavenEngine({ now, sourceVerifier, sourceSearcher })
    const started = await startedTask(engine, 'discovery-batch')
    const found = await engine.dispatch(started.state, {
      action: 'discover',
      taskId: started.state.taskId,
      queries: ['original filing text', 'independent coverage of the filing'],
    }, { sessionId: 'discovery-batch', signal })

    expect(seen).toEqual([['original filing text', 'independent coverage of the filing']])
    expect(found.status).toBe('active')
    expect(found.leads?.leads).toHaveLength(2)
    // Discovery finds candidates; it never touches the Task's evidence.
    expect(found.state.sources).toEqual([])
    expect(found.state.claims).toEqual([])
    expect(found.state).toBe(started.state)
    expect(found.issues.join(' ')).toContain('Leads are not Sources')
    expect(renderLeads(found.leads!)).toContain('uninspected candidates')
  })

  it('bounds the batch before deduplicating, exactly as the Harness web_search tool does', async () => {
    const sourceSearcher: SourceSearcher = { search: async () => emptyOutcome }
    const engine = createRavenEngine({
      now,
      sourceVerifier,
      sourceSearcher,
      searchLimits: () => ({ maxQueries: 2, maxResults: 3 }),
    })
    const started = await startedTask(engine, 'discovery-bounds')
    await expect(engine.dispatch(started.state, {
      action: 'discover',
      taskId: started.state.taskId,
      queries: ['a', 'a', 'a'],
    }, { sessionId: 'discovery-bounds', signal })).rejects.toThrow('at most 2 queries')
    await expect(engine.dispatch(started.state, {
      action: 'discover',
      taskId: started.state.taskId,
      queries: [],
    }, { sessionId: 'discovery-bounds', signal })).rejects.toThrow('at least one query')
  })

  it('records a failed query as a Task Limitation instead of losing the batch', async () => {
    const sourceSearcher: SourceSearcher = {
      search: async () => ({
        leads: [{ url: 'https://kept.test/a', queries: ['kept'] }],
        failures: [{ query: 'lost', detail: 'the query exceeded the configured 30000ms deadline' }],
        truncated: true,
        notes: [],
      }),
    }
    const engine = createRavenEngine({ now, sourceVerifier, sourceSearcher })
    const started = await startedTask(engine, 'discovery-partial')
    const found = await engine.dispatch(started.state, {
      action: 'discover',
      taskId: started.state.taskId,
      queries: ['kept', 'lost'],
    }, { sessionId: 'discovery-partial', signal })

    expect(found.leads?.leads).toHaveLength(1)
    expect(found.state.limitations).toHaveLength(1)
    expect(found.state.limitations[0]?.kind).toBe('tool')
    expect(found.state.limitations[0]?.detail).toContain('"lost"')
    expect(found.state.revision).toBe(started.state.revision + 1)
    expect(found.issues.join(' ')).toContain('not evidence that nothing exists')
    expect(found.issues.join(' ')).toContain('truncated')
  })

  it('reports an absent discovery seam as unavailable rather than as an empty search', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await startedTask(engine, 'discovery-absent')
    const found = await engine.dispatch(started.state, {
      action: 'discover',
      taskId: started.state.taskId,
      queries: ['anything'],
    }, { sessionId: 'discovery-absent', signal })

    expect(found.leads?.unavailable).toContain('no Lead discovery seam')
    expect(found.state.limitations[0]?.detail).toContain('unavailable')
    expect(renderLeads(found.leads!)).toContain('did not run')
  })
})

interface DiscoverTool extends Record<string, unknown> {
  execute(args: unknown, exec: unknown): Promise<RavenPlugin.RavenDispatchResult>
}

function harness(web: unknown, config: RavenPlugin.RavenConfig = {}) {
  let tool: DiscoverTool | undefined
  RavenPlugin.apply({
    tools: {
      register(definition: DiscoverTool) {
        tool = definition
        return vi.fn()
      },
    },
    systemPrompt: { section() { return vi.fn() } },
    inject() { return vi.fn() },
    get(service: string) { return service === 'web' ? web : undefined },
    on() { return vi.fn() },
  } as never, config)
  if (tool === undefined) throw new Error('Raven tool did not register')
  return tool
}

describe('Raven discovery over the Harness web seam', () => {
  it('fans out every query, keeps siblings when one fails, and folds one URL into one Lead', async () => {
    const calls: Array<{ query: string; maxResults?: number }> = []
    const web = {
      fetch: () => Promise.reject(new Error('not used')),
      search: async (request: { query: string; maxResults?: number }) => {
        calls.push(request)
        if (request.query === 'broken') throw new Error('backend refused the query')
        return {
          content: request.query === 'primary' ? 'a provider answer' : undefined,
          sources: [
            { url: 'https://shared.test/record', title: 'Shared record', snippet: 'a snippet' },
            { url: `https://${request.query}.test/only`, title: request.query },
          ],
          truncated: false,
        }
      },
    }
    const tool = harness(web)
    const agent = { id: 'web-discovery-session', session: { events: [] } }
    const started = await tool.execute({
      action: 'start',
      outcome: 'research',
      request: 'Search several angles at once.',
    }, { agent, signal })
    const found = await tool.execute({
      action: 'discover',
      taskId: started.state.taskId,
      queries: ['primary', 'secondary', 'broken'],
    }, { agent, signal })

    expect(calls.map(call => call.query)).toEqual(['primary', 'secondary', 'broken'])
    expect(calls.every(call => call.maxResults === 8)).toBe(true)
    const leads = found.leads?.leads ?? []
    // One shared URL across two working queries collapses to one Lead that records both.
    const shared = leads.find(lead => lead.url === 'https://shared.test/record')
    expect(shared?.queries).toEqual(['primary', 'secondary'])
    expect(leads.map(lead => lead.url)).toContain('https://primary.test/only')
    expect(leads.map(lead => lead.url)).toContain('https://secondary.test/only')
    // The failing query is a recorded Limitation, not a lost batch.
    expect(found.leads?.failures.map(failure => failure.query)).toEqual(['broken'])
    expect(found.state.limitations.map(item => item.detail).join(' ')).toContain('backend refused the query')
    expect(found.leads?.notes).toEqual([{ query: 'primary', content: 'a provider answer' }])
  })

  it('reports a deployment that withholds discovery, and one with no search provider', async () => {
    const agent = { id: 'discovery-policy-session', session: { events: [] } }
    const disabled = harness({ fetch: () => Promise.reject(new Error('unused')), search: () => Promise.reject(new Error('unused')) }, { sourceDiscovery: 'disabled' })
    const startedDisabled = await disabled.execute({
      action: 'start',
      outcome: 'research',
      request: 'Discovery is withheld here.',
    }, { agent, signal })
    const withheld = await disabled.execute({
      action: 'discover',
      taskId: startedDisabled.state.taskId,
      queries: ['anything'],
    }, { agent, signal })
    expect(withheld.leads?.unavailable).toContain('sourceDiscovery=disabled')

    const fetchOnly = harness({ fetch: () => Promise.reject(new Error('unused')) })
    const other = { id: 'discovery-fetch-only-session', session: { events: [] } }
    const startedFetchOnly = await fetchOnly.execute({
      action: 'start',
      outcome: 'research',
      request: 'No search provider is composed here.',
    }, { agent: other, signal })
    const absent = await fetchOnly.execute({
      action: 'discover',
      taskId: startedFetchOnly.state.taskId,
      queries: ['anything'],
    }, { agent: other, signal })
    expect(absent.leads?.unavailable).toContain('web search capability is not composed')
  })

  it('gives each query its own deadline so a slow backend costs one angle', async () => {
    const web = {
      fetch: () => Promise.reject(new Error('unused')),
      search: async (request: { query: string }, attempt?: AbortSignal) => {
        if (request.query !== 'slow') {
          return { sources: [{ url: 'https://fast.test/a' }], truncated: false }
        }
        return new Promise<never>((_resolve, reject) => {
          attempt?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
      },
    }
    const tool = harness(web, { searchTimeoutMs: 20 })
    const agent = { id: 'discovery-deadline-session', session: { events: [] } }
    const started = await tool.execute({
      action: 'start',
      outcome: 'research',
      request: 'One slow backend must not hold the batch.',
    }, { agent, signal })
    const found = await tool.execute({
      action: 'discover',
      taskId: started.state.taskId,
      queries: ['fast', 'slow'],
    }, { agent, signal })

    expect(found.leads?.leads.map(lead => lead.url)).toEqual(['https://fast.test/a'])
    expect(found.leads?.failures[0]?.query).toBe('slow')
    expect(found.leads?.failures[0]?.detail).toContain('20ms deadline')
  })

  it('propagates caller cancellation as cancellation, never as a per-query limitation', async () => {
    const controller = new AbortController()
    const web = {
      fetch: () => Promise.reject(new Error('unused')),
      search: async (_request: unknown, attempt?: AbortSignal) => new Promise<never>((_resolve, reject) => {
        attempt?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        controller.abort(new Error('caller went away'))
      }),
    }
    const tool = harness(web)
    const agent = { id: 'discovery-cancel-session', session: { events: [] } }
    const started = await tool.execute({
      action: 'start',
      outcome: 'research',
      request: 'Cancellation stays cancellation.',
    }, { agent, signal })
    await expect(tool.execute({
      action: 'discover',
      taskId: started.state.taskId,
      queries: ['one'],
    }, { agent, signal: controller.signal })).rejects.toThrow('caller went away')
  })
})
