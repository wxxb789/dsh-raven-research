import { describe, expect, it } from 'vitest'

import { apply } from '../../src/plugin.js'
import type { RavenConfig, RavenTaskState } from '../../src/index.js'

interface TestTool extends Record<string, unknown> {
  execute(args: unknown, exec: unknown): Promise<{
    status: string
    state: RavenTaskState
    issues: readonly string[]
  }>
}

type Fetcher = (request: { url: string }, signal?: AbortSignal) => Promise<{
  url: string
  statusCode: number
  body: { kind: 'html' | 'text'; content: string }
  truncated?: boolean
}>

/**
 * A fetch half with a REGISTERED provider, which is a different question from the
 * service object merely existing: the seam resolves its provider at call time, so a
 * composed runtime with an empty registry throws instead of answering. The startup
 * probe and the start-time gate both read the registry, so a test that means "web
 * works" has to supply one.
 */
function webService(fetcher: Fetcher) {
  return {
    fetch: fetcher,
    fetchProviders: new Map([['test', { id: 'test', available: () => true, fetch: fetcher }]]),
  }
}

function mount(options: {
  fetch?: Fetcher
  web?: unknown
  warn?: (message: string) => void
  config?: RavenConfig
}) {
  let tool: TestTool | undefined
  const service = options.web !== undefined
    ? options.web
    : options.fetch === undefined ? undefined : webService(options.fetch)
  apply({
    tools: {
      register(definition: TestTool) {
        tool = definition
        return () => undefined
      },
    },
    systemPrompt: { section() { return () => undefined } },
    inject() { return () => undefined },
    get(name: string) { return name === 'web' ? service : undefined },
    on() { return () => undefined },
    logger: () => ({ warn: options.warn ?? (() => undefined) }),
  } as never, options.config ?? {})
  if (tool === undefined) throw new Error('Raven tool did not register')
  return tool
}

const signal = new AbortController().signal

/**
 * The recorded check status for the Task's single Source.
 *
 * A REFUSED Checkpoint may or may not retain the Sources submitted with it — that
 * is the engine's call and it has changed — so a test about the CHECK TAXONOMY must
 * not be a test of retention. When the Source survived, its own recorded status is
 * the authority; when it did not, the refusal issues carry the same classification,
 * and 'failed' is distinguishable from 'unavailable' by whether the Task recorded a
 * Source verification failure at all.
 */
function checkStatus(result: { state: RavenTaskState; issues: readonly string[] }): string | undefined {
  const recorded = result.state.sources[0]?.check
  if (recorded !== undefined && recorded.status !== 'unchecked') return recorded.status
  const issues = result.issues.join(' ')
  if (issues.length === 0) return undefined
  return /not served at this URL|different host|diverges from the retrieved source|no part of the recorded excerpt/.test(issues)
    ? 'failed'
    : 'unavailable'
}

async function checkOne(tool: TestTool, agentId: string, excerpt: string, url = 'https://records.test/doc') {
  const agent = { id: agentId, session: { events: [] } }
  const started = await tool.execute({
    action: 'start',
    outcome: 'research',
    request: 'Check one recorded Source.',
  }, { agent, signal })
  const checkpoint = await tool.execute({
    action: 'checkpoint',
    taskId: started.state.taskId,
    stage: 'draft',
    summary: 'One source-grounded draft.',
    artifact: 'The record carries the passage [@S1].',
    sources: [{
      sourceId: 'S1',
      url,
      title: 'A primary record',
      locator: 'Body',
      excerpt,
      role: 'primary',
    }],
    claims: [{
      claimId: 'C1',
      text: 'The record carries the passage.',
      kind: 'external',
      importance: 'material',
      disposition: 'supported',
      sourceIds: ['S1'],
    }],
  }, { agent, signal })
  return { started, checkpoint, agent }
}
describe('Source check taxonomy', () => {
  it('reports an access or rate condition as unavailable and never accuses fabrication', async () => {
    for (const statusCode of [401, 403, 407, 408, 425, 429, 500, 503]) {
      const tool = mount({
        fetch: async request => ({
          url: request.url,
          statusCode,
          body: { kind: 'text' as const, content: 'Access denied.' },
          truncated: false,
        }),
      })
      const { checkpoint } = await checkOne(tool, `status-${statusCode}-session`, 'the passage that is really there')
      const issues = checkpoint.issues.join(' ')
      // Blocked, because it genuinely could not be confirmed...
      expect(checkpoint.status, String(statusCode)).toBe('needs-revision')
      // ...but a condition between Raven and the document says NOTHING about the
      // quotation, so it must never take the fabrication branch, and it must not
      // permanently defer the Claim the way an evidence defect does.
      expect(issues, String(statusCode)).not.toContain('fabricated')
      expect(issues, String(statusCode)).toContain(String(statusCode))
      expect(checkStatus(checkpoint), String(statusCode)).toBe('unavailable')
    }
  })

  it('keeps 404 and 410 an evidence defect, because only those describe the resource', async () => {
    for (const statusCode of [404, 410]) {
      const tool = mount({
        fetch: async request => ({
          url: request.url,
          statusCode,
          body: { kind: 'text' as const, content: 'Not found.' },
          truncated: false,
        }),
      })
      const { checkpoint } = await checkOne(tool, `gone-${statusCode}-session`, 'the passage that is really there')
      expect(checkStatus(checkpoint), String(statusCode)).toBe('failed')
      expect(checkpoint.issues.join(' '), String(statusCode)).toContain('not served at this URL')
    }
  })

  it('reports a PDF and a script-only shell as unreadable rather than as a bad quotation', async () => {
    const bodies = [
      { kind: 'text' as const, content: '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj' },
      { kind: 'html' as const, content: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>' },
    ]
    for (const body of bodies) {
      const tool = mount({
        fetch: async request => ({ url: request.url, statusCode: 200, body, truncated: false }),
      })
      const { checkpoint } = await checkOne(tool, `unreadable-${body.kind}-session`, 'a passage the document really carries')
      const issues = checkpoint.issues.join(' ')
      // A complete retrieval carrying no extractable prose is exactly the primary
      // record research depends on most, and calling it `failed` told the agent to
      // weaken a correct excerpt until it matched a body Raven never read.
      expect(checkStatus(checkpoint), body.kind).toBe('unavailable')
      expect(issues, body.kind).not.toContain('fabricated')
      expect(issues, body.kind).toMatch(/text-extract|no usable prose|could not be text-extracted/)
    }
  })

  it('still calls a readable body that lacks the excerpt an evidence defect', async () => {
    const tool = mount({
      fetch: async request => ({
        url: request.url,
        statusCode: 200,
        body: { kind: 'text' as const, content: 'This document discusses something else entirely, at length and clearly.' },
        truncated: false,
      }),
    })
    const { checkpoint } = await checkOne(tool, 'genuine-miss-session', 'a passage this document does not contain')
    // `failed` is reserved for what it always meant: prose Raven DID read.
    expect(checkStatus(checkpoint)).toBe('failed')
  })

  it('retries a transient condition once and accepts the Source when the retry succeeds', async () => {
    let attempts = 0
    const tool = mount({
      fetch: async request => {
        attempts += 1
        return attempts === 1
          ? { url: request.url, statusCode: 503, body: { kind: 'text' as const, content: '' }, truncated: false }
          : { url: request.url, statusCode: 200, body: { kind: 'text' as const, content: 'the passage that is really there, stated plainly' }, truncated: false }
      },
    })
    const { checkpoint } = await checkOne(tool, 'flaky-session', 'the passage that is really there')
    // Checkpoint and Completion BOTH re-verify, so without the retry a flaky origin
    // made the same unchanged Task complete or refuse depending on the attempt.
    expect(attempts).toBe(2)
    expect(checkpoint.state.sources[0]?.check.status).toBe('reachable')
  })

  it('never retries a 404 or a genuine mismatch', async () => {
    let notFound = 0
    const missing = mount({
      fetch: async request => {
        notFound += 1
        return { url: request.url, statusCode: 404, body: { kind: 'text' as const, content: '' }, truncated: false }
      },
    })
    await checkOne(missing, 'no-retry-404-session', 'the passage that is really there')
    expect(notFound).toBe(1)

    let mismatched = 0
    const wrong = mount({
      fetch: async request => {
        mismatched += 1
        return {
          url: request.url,
          statusCode: 200,
          body: { kind: 'text' as const, content: 'A completely different sentence, written out at readable length.' },
          truncated: false,
        }
      },
    })
    await checkOne(wrong, 'no-retry-mismatch-session', 'the passage that is really there')
    // A retried mismatch is pure duplicated load on an origin that already answered.
    expect(mismatched).toBe(1)
  })
})
describe('Truncated retrievals', () => {
  const truncatedFetch = (content: string): Fetcher => async request => ({
    url: request.url,
    statusCode: 200,
    body: { kind: 'text' as const, content },
    truncated: true,
  })

  it('confirms an excerpt found inside a truncated body, and records the cut alongside it', async () => {
    // The match stands: the excerpt occurred in bytes this URL actually returned,
    // which is the whole of what the check asks. Suppressing it would refuse every
    // long primary document a provider truncates, since the fetch seam carries no
    // size control. What it must not do is stay silent — SECURITY.md names "a
    // truncated retrieval reported as a match" as a citation-integrity defect, so
    // the confirmation has to carry the cut with it.
    const tool = mount({ fetch: truncatedFetch('Intro. The record carries the passage verbatim and then the body was cut') })
    const { checkpoint } = await checkOne(tool, 'truncated-hit-session', 'The record carries the passage verbatim')
    expect(checkpoint.status).toBe('active')
    const check = checkpoint.state.sources[0]?.check
    expect(check?.status).toBe('reachable')
    // `detail` exists on every checked variant but not on `unchecked`, so the union
    // has to be narrowed rather than reached through optional chaining.
    const detail = check === undefined || check.status === 'unchecked' ? undefined : check.detail
    expect(detail).toMatch(/truncated/)
    expect(detail).toMatch(/past the cut was never seen/)
  })

  it('reports a truncated body that does not carry the excerpt as unavailable, never as fabrication', async () => {
    // A cut-off body cannot DISPROVE an excerpt drawn from the tail, so this must
    // not take the branch that tells the agent it may have invented the quotation.
    const tool = mount({ fetch: truncatedFetch('Intro. The retrieved prefix stops here') })
    const { checkpoint } = await checkOne(tool, 'truncated-miss-session', 'a passage beyond the cut')
    expect(checkpoint.status).toBe('needs-revision')
    expect(checkStatus(checkpoint)).toBe('unavailable')
    expect(checkpoint.issues.join(' ')).not.toMatch(/fabricat/i)
  })
})

describe('Excerpt normalization', () => {
  /**
   * Each of these was a reproduced false rejection, and each is compounded the same
   * way: the mismatch report then showed a "nearest retrieved passage" that looked
   * IDENTICAL to the recorded excerpt, so the agent was asked to repair something
   * invisible and did the documented anti-goal instead.
   */
  const cases: readonly (readonly [string, string, string])[] = [
    ['curly quotes', 'The court said \u201Cno\u201D and the \u2018party\u2019 left.', 'The court said "no" and the \'party\' left.'],
    ['en dash', 'the 2019\u20132020 fiscal year was reviewed', 'the 2019-2020 fiscal year was reviewed'],
    ['em dash', 'the finding \u2014 unambiguous \u2014 stands', 'the finding - unambiguous - stands'],
    ['NFD accents', 'the Bureau de la Sant\u00E9 confirmed it', 'the Bureau de la Sante\u0301 confirmed it'],
    ['soft hyphen', 'the depart\u00ADment issued the ruling', 'the department issued the ruling'],
    ['zero-width space', 'the depart\u200Bment issued the ruling', 'the department issued the ruling'],
    ['word joiner', 'the depart\u2060ment issued the ruling', 'the department issued the ruling'],
    ['entity dash', 'the 2019&ndash;2020 fiscal year was reviewed', 'the 2019-2020 fiscal year was reviewed'],
    ['entity quote', 'the court said &ldquo;no&rdquo; here', 'the court said "no" here'],
    ['entity ellipsis', 'the ruling stands&hellip; for now', 'the ruling stands\u2026 for now'],
  ]

  for (const [label, body, excerpt] of cases) {
    it(`matches an excerpt differing only by ${label}`, async () => {
      const tool = mount({
        fetch: async request => ({
          url: request.url,
          statusCode: 200,
          body: { kind: 'text' as const, content: body },
          truncated: false,
        }),
      })
      const { checkpoint } = await checkOne(tool, `fold-${label.replaceAll(' ', '-')}-session`, excerpt)
      expect(checkpoint.state.sources[0]?.check.status, label).toBe('reachable')
      expect(checkpoint.status, label).toBe('active')
    })
  }

  /**
   * Folds that were REMOVED after they were shown to accept a different meaning.
   *
   * Both were adopted as presentation folds and both turned out to change what the
   * text says: the minus sign is arithmetic rather than typography, and ZWNJ/ZWJ are
   * orthographic in Persian, Arabic and the Indic scripts, where deleting one joins
   * two tokens the source deliberately keeps apart.
   */
  const refused: readonly (readonly [string, string, string])[] = [
    ['a minus sign against a hyphen', 'the balance changed by \u22125 percent this year', 'changed by -5 percent'],
    ['a zero-width non-joiner', 'he will re\u200Csign the contract tomorrow', 'he will resign the contract'],
    ['a zero-width joiner', 'the co\u200Dop published its accounts', 'the coop published its accounts'],
  ]

  for (const [label, body, excerpt] of refused) {
    it(`refuses an excerpt that differs by ${label}`, async () => {
      const tool = mount({
        fetch: async request => ({
          url: request.url,
          statusCode: 200,
          body: { kind: 'text' as const, content: body },
          truncated: false,
        }),
      })
      const { checkpoint } = await checkOne(tool, `refuse-${label.replaceAll(' ', '-')}-session`, excerpt)
      expect(checkStatus(checkpoint), label).not.toBe('reachable')
      expect(checkpoint.status, label).toBe('needs-revision')
    })
  }

  it('keeps the folding narrow enough that two different passages cannot match', async () => {
    // The safety direction that matters: a false ACCEPT publishes a quotation the
    // source does not carry, while a false reject only asks the agent to look again.
    const tool = mount({
      fetch: async request => ({
        url: request.url,
        statusCode: 200,
        body: { kind: 'text' as const, content: 'The committee approved the measure without any recorded dissent.' },
        truncated: false,
      }),
    })
    const { checkpoint } = await checkOne(tool, 'no-overfold-session', 'The committee rejected the measure')
    expect(checkStatus(checkpoint)).toBe('failed')
  })

  it('survives a numeric entity above the Unicode maximum instead of unverifying the Source', async () => {
    // `String.fromCodePoint` THROWS a RangeError on one, and that throw escaped as a
    // generic per-Source failure, so one malformed entity anywhere in a retrieved
    // page silently unverified honest evidence.
    const tool = mount({
      fetch: async request => ({
        url: request.url,
        statusCode: 200,
        body: { kind: 'text' as const, content: 'noise &#1114112; &#x7FFFFFFF; the passage that is really there' },
        truncated: false,
      }),
    })
    const { checkpoint } = await checkOne(tool, 'bad-entity-session', 'the passage that is really there')
    expect(checkpoint.state.sources[0]?.check.status).toBe('reachable')
  })
})

describe('Source destination network policy', () => {
  it('keeps direct raw config omission unrestricted for backward compatibility', async () => {
    let fetches = 0
    const tool = mount({
      fetch: async request => {
        fetches += 1
        return {
          url: request.url,
          statusCode: 200,
          body: { kind: 'text' as const, content: 'the passage that is really there, stated plainly' },
          truncated: false,
        }
      },
    })
    const { checkpoint } = await checkOne(
      tool,
      'omitted-network-policy-session',
      'the passage that is really there',
      'http://127.0.0.1/private-record',
    )
    expect(fetches).toBe(1)
    expect(checkpoint.state.sources[0]?.check.status).toBe('reachable')
  })

  it('refuses a private destination before calling the fetch provider', async () => {
    let fetches = 0
    const tool = mount({
      config: { sourceNetworkPolicy: 'public-only' },
      fetch: async request => {
        fetches += 1
        return {
          url: request.url,
          statusCode: 200,
          body: { kind: 'text' as const, content: 'the passage that is really there, stated plainly' },
          truncated: false,
        }
      },
    })
    const { checkpoint } = await checkOne(
      tool,
      'private-destination-session',
      'the passage that is really there',
      'http://169.254.169.254/latest/meta-data',
    )
    expect(fetches).toBe(0)
    expect(checkStatus(checkpoint)).toBe('unavailable')
    expect(checkpoint.issues.join(' ')).toContain('non-public network address')
  })

  it('keeps an explicit unrestricted escape hatch for a network-confined provider', async () => {
    let fetches = 0
    const tool = mount({
      config: { sourceNetworkPolicy: 'unrestricted' },
      fetch: async request => {
        fetches += 1
        return {
          url: request.url,
          statusCode: 200,
          body: { kind: 'text' as const, content: 'the passage that is really there, stated plainly' },
          truncated: false,
        }
      },
    })
    const { checkpoint } = await checkOne(
      tool,
      'trusted-private-session',
      'the passage that is really there',
      'http://127.0.0.1/private-record',
    )
    expect(fetches).toBe(1)
    expect(checkpoint.state.sources[0]?.check.status).toBe('reachable')
  })
})

describe('Source identity across a redirect', () => {
  it('accepts a redirect that only spells the default port out', async () => {
    const tool = mount({
      fetch: async () => ({
        url: 'https://records.test:443/doc',
        statusCode: 200,
        body: { kind: 'text' as const, content: 'the passage that is really there, stated plainly' },
        truncated: false,
      }),
    })
    const { checkpoint } = await checkOne(tool, 'default-port-session', 'the passage that is really there')
    // `:443` on https is the SAME origin; rejecting it as host drift refused a
    // Source whose evidence was never in question.
    expect(checkpoint.state.sources[0]?.check.status).toBe('reachable')
  })

  it('still rejects a cross-host redirect as an identity defect', async () => {
    const tool = mount({
      fetch: async () => ({
        url: 'https://elsewhere.test/doc',
        statusCode: 200,
        body: { kind: 'text' as const, content: 'the passage that is really there, stated plainly' },
        truncated: false,
      }),
    })
    const { checkpoint } = await checkOne(tool, 'cross-host-session', 'the passage that is really there')
    expect(checkStatus(checkpoint)).toBe('failed')
    expect(checkpoint.issues.join(' ')).toContain('different host')
  })

  it('reports cross-host identity even when the redirected response is 404', async () => {
    const tool = mount({
      fetch: async () => ({
        url: 'https://elsewhere.test/missing',
        statusCode: 404,
        body: { kind: 'text' as const, content: 'not found' },
        truncated: false,
      }),
    })
    const { checkpoint } = await checkOne(tool, 'cross-host-404-session', 'the passage that is really there')
    expect(checkStatus(checkpoint)).toBe('failed')
    expect(checkpoint.issues.join(' ')).toContain('different host')
    expect(checkpoint.issues.join(' ')).not.toContain('not served at this URL')
  })

  it('still rejects a non-default port that genuinely differs', async () => {
    const tool = mount({
      fetch: async () => ({
        url: 'https://records.test:8443/doc',
        statusCode: 200,
        body: { kind: 'text' as const, content: 'the passage that is really there, stated plainly' },
        truncated: false,
      }),
    })
    const { checkpoint } = await checkOne(tool, 'other-port-session', 'the passage that is really there')
    expect(checkStatus(checkpoint)).toBe('failed')
  })
})
describe('Deployment preconditions', () => {
  it('refuses a grounding-required Task before the research spend when no fetch provider exists', async () => {
    const warnings: string[] = []
    // A composed web runtime with an EMPTY registry: `ctx.get('web')` answers, and
    // the seam then throws WEB_PROVIDER_UNAVAILABLE at call time. That distinction
    // was invisible until every Source reported the capability missing, after the
    // whole Task had been paid for, against a floor research cannot lower.
    const tool = mount({
      web: { fetch: async () => { throw new Error('no usable web provider is registered') }, fetchProviders: new Map() },
      warn: message => warnings.push(message),
    })
    expect(warnings.join(' ')).toContain('cannot verify web Sources')

    const agent = { id: 'no-provider-session', session: { events: [] } }
    await expect(tool.execute({
      action: 'start',
      outcome: 'research',
      request: 'Research something this deployment cannot ground.',
    }, { agent, signal })).rejects.toThrow(/no usable provider is registered/)

    // The refusal names the ways out, and both of them actually work.
    const narrowed = await tool.execute({
      action: 'start',
      outcome: 'research',
      grounding: 'optional',
      request: 'Research with an explicitly narrowed floor.',
    }, { agent, signal })
    expect(narrowed.state.phase).toBe('active')
  })

  it('refuses ambiguous or invalid configured fetch-provider selections before starting research', async () => {
    const provider = (usable: boolean) => ({ id: 'provider', available: () => usable })
    const cases = [
      {
        id: 'ambiguous',
        web: {
          fetch: async () => { throw new Error('must not fetch') },
          fetchProviders: new Map([['one', provider(true)], ['two', provider(true)]]),
        },
        message: /multiple usable providers/,
      },
      {
        id: 'configured-missing',
        web: {
          fetch: async () => { throw new Error('must not fetch') },
          fetchProviderId: 'missing',
          fetchProviders: new Map([['one', provider(true)]]),
        },
        message: /provider id that is not registered/,
      },
      {
        id: 'configured-unavailable',
        web: {
          fetch: async () => { throw new Error('must not fetch') },
          fetchProviderId: 'one',
          fetchProviders: new Map([['one', provider(false)]]),
        },
        message: /provider that reports unavailable/,
      },
    ]
    for (const item of cases) {
      const tool = mount({ web: item.web })
      await expect(tool.execute({
        action: 'start',
        outcome: 'research',
        request: 'Refuse a provider selection that the Harness runtime cannot execute.',
      }, { agent: { id: `provider-${item.id}`, session: { events: [] } }, signal }))
        .rejects.toThrow(item.message)
    }
  })

  it('warns but does not refuse where the capability is absent entirely and the Outcome is not grounded', async () => {
    const warnings: string[] = []
    const tool = mount({ warn: message => warnings.push(message) })
    expect(warnings.join(' ')).toContain('not composed at all')
    const started = await tool.execute({
      action: 'start',
      outcome: 'general-writing',
      request: 'Write one note that needs no external evidence.',
    }, { agent: { id: 'ungrounded-session', session: { events: [] } }, signal })
    expect(started.state.phase).toBe('active')
  })

  it('does not refuse a deployment whose provider shape it cannot recognize', async () => {
    // The provider registries are class fields the published types keep private, so
    // the probe reads a shape it does not own. An unrecognized shape must warn
    // nobody and block nothing: a probe that guessed would refuse working Tasks.
    const tool = mount({ web: { fetch: async () => { throw new Error('unused') } } })
    const started = await tool.execute({
      action: 'start',
      outcome: 'research',
      request: 'Research through an unfamiliar provider shape.',
    }, { agent: { id: 'unknown-shape-session', session: { events: [] } }, signal })
    expect(started.state.phase).toBe('active')
  })
})

describe('Concurrent Team contributions', () => {
  it('fails the losing writer instead of silently dropping its contribution', async () => {
    // Both teammates read revision N, both verify across an await-heavy pass, and
    // the second write used to overwrite the first one's Sources, Claims, and
    // Checkpoint — a lost contribution that looked exactly like a successful one.
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let gated = true
    const tool = mount({
      fetch: async request => {
        if (gated) {
          gated = false
          await gate
        }
        return {
          url: request.url,
          statusCode: 200,
          body: { kind: 'text' as const, content: 'the passage that is really there, stated plainly' },
          truncated: false,
        }
      },
    })
    const agent = { id: 'team-race-session', session: { events: [] } }
    const started = await tool.execute({
      action: 'start',
      outcome: 'research',
      request: 'One question two teammates work on.',
    }, { agent, signal })

    const contribution = (sourceId: string, claimId: string) => ({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: `A contribution recording ${sourceId}.`,
      artifact: `The record carries the passage [@${sourceId}].`,
      sources: [{
        sourceId,
        url: `https://records.test/${sourceId}`,
        title: 'A primary record',
        locator: 'Body',
        excerpt: 'the passage that is really there',
        role: 'primary',
      }],
      claims: [{
        claimId,
        text: 'The record carries the passage.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: [sourceId],
      }],
    })

    const slow = tool.execute(contribution('SLOW', 'SLOW-C'), { agent, signal })
    // The fast contribution lands and advances the Task while the slow one verifies.
    const fast = await tool.execute(contribution('FAST', 'FAST-C'), { agent, signal })
    expect(fast.state.revision).toBeGreaterThan(started.state.revision)
    release?.()

    const outcome = await slow.then(() => 'landed', (error: unknown) => (error as Error).message)
    expect(outcome).toContain('another Agent Team member contributed to it first')
    expect(outcome).toContain('action=status')

    // Nothing was lost: the winning contribution is still the Task's own state.
    const current = await tool.execute({ action: 'status', taskId: started.state.taskId }, { agent, signal })
    expect(current.state.sources.map(source => source.sourceId)).toContain('FAST')
  })

  it('refuses the second of two racing Task creations instead of replacing the first', async () => {
    // The revision comparison cannot cover this one: a `start` branches from no
    // stored state, so there is no revision to compare and the write fell straight
    // through. Two members racing to create the Team's Task both produced revision 1
    // and the later write silently discarded the earlier Task — the same lost
    // contribution the comparison prevents, one step earlier.
    const tool = mount({
      web: {
        fetch: async () => { throw new Error('the start gate must not fetch') },
        fetchProviders: new Map([['test', { id: 'test', available: () => true }]]),
      },
    })
    const agent = { id: 'team-start-race-session', session: { events: [] } }
    const start = () => tool.execute({
      action: 'start',
      outcome: 'research',
      request: 'One question two teammates both try to open.',
    }, { agent, signal })

    // Fired without awaiting the first: both calls read the book — and therefore
    // `previous` — before either has written, which is precisely the interleaving a
    // sequential second `start` cannot reproduce (that one is refused earlier, by
    // the engine, for a Task that is already active).
    const [left, right] = await Promise.allSettled([start(), start()])
    const settled = [left, right]
    const created = settled.filter(entry => entry.status === 'fulfilled')
    const refused = settled.filter(entry => entry.status === 'rejected')
    expect(created).toHaveLength(1)
    expect(refused).toHaveLength(1)
    const message = refused[0]?.status === 'rejected' ? String(refused[0].reason) : ''
    expect(message).toContain('already exists in this session')
    expect(message).toContain('action=status')

    // The surviving Task is untouched and is the one the session continues.
    const winner = created[0]?.status === 'fulfilled' ? created[0].value : undefined
    const current = await tool.execute({ action: 'status', taskId: winner?.state.taskId }, { agent, signal })
    expect(current.state.taskId).toBe(winner?.state.taskId)
    expect(current.state.revision).toBe(1)
  })
})

describe('Task book residency', () => {
  it('bounds resident Task books and rebuilds an evicted one from the session log', async () => {
    interface BookTool extends Record<string, unknown> {
      execute(args: unknown, exec: unknown): Promise<{ state: RavenTaskState; status: string }>
      output: { presentationMeta(args: unknown, value: unknown): unknown }
    }
    let tool: BookTool | undefined
    apply({
      tools: {
        register(definition: BookTool) {
          tool = definition
          return () => undefined
        },
      },
      systemPrompt: { section() { return () => undefined } },
      inject() { return () => undefined },
      get() { return undefined },
      on() { return () => undefined },
    } as never)
    if (tool === undefined) throw new Error('Raven tool did not register')
    const registered = tool

    // The evicted session keeps its OWN durable log, exactly as a real session does.
    const events: unknown[] = []
    const first = { id: 'evicted-session', session: { events } }
    const started = await registered.execute({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'A Task whose book will be evicted.',
    }, { agent: first, signal })
    events.push({ type: 'tool/result', data: { meta: registered.output.presentationMeta({}, started) } })
    const checkpoint = await registered.execute({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A draft that must survive eviction.',
      artifact: 'A draft that must survive eviction of its book.',
    }, { agent: first, signal })
    events.push({ type: 'tool/result', data: { meta: registered.output.presentationMeta({}, checkpoint) } })

    // Push the first session past the residency cap with unrelated sessions. Without
    // a bound these all stayed resident forever, each able to hold a 100k-character
    // Artifact and 256 Sources.
    for (let index = 0; index < 80; index += 1) {
      await registered.execute({
        action: 'start',
        outcome: 'general-writing',
        grounding: 'none',
        request: `An unrelated Task ${index}.`,
      }, { agent: { id: `filler-${index}`, session: { events: [] } }, signal })
    }

    // The book was evicted, so this call re-folds the durable log rather than reading
    // a resident book: eviction costs one re-fold, never a Task.
    const restored = await registered.execute({
      action: 'status',
      taskId: started.state.taskId,
    }, { agent: first, signal })
    expect(restored.state.taskId).toBe(started.state.taskId)
    expect(restored.state.checkpoints).toHaveLength(1)
    expect(restored.state.latestArtifact).toBe('A draft that must survive eviction of its book.')

    // Eviction must actually HAVE happened, or this test would pass against an
    // unbounded store and prove nothing. A session with no durable log of its own is
    // the observable: its Task exists only in the resident book, so once that book is
    // evicted the Task is genuinely gone. (Losing it is correct — the record was
    // never durable — and it is the only externally visible signal that the cap is
    // enforced at all.)
    const undurable = { id: 'undurable-session', session: { events: [] as unknown[] } }
    const ephemeral = await registered.execute({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'A Task with no durable record at all.',
    }, { agent: undurable, signal })
    for (let index = 0; index < 80; index += 1) {
      await registered.execute({
        action: 'start',
        outcome: 'general-writing',
        grounding: 'none',
        request: `A later unrelated Task ${index}.`,
      }, { agent: { id: `evictor-${index}`, session: { events: [] } }, signal })
    }
    const gone = await registered.execute({ action: 'status', taskId: ephemeral.state.taskId }, {
      agent: { id: 'undurable-session', session: { events: [] } },
      signal,
    }).then(() => 'resident', (error: unknown) => (error as Error).message)
    expect(gone).toContain('No Raven Task exists in this session')
  })

  it('never evicts the book the current call is about', async () => {
    interface BookTool extends Record<string, unknown> {
      execute(args: unknown, exec: unknown): Promise<{ state: RavenTaskState; status: string }>
    }
    let tool: BookTool | undefined
    apply({
      tools: {
        register(definition: BookTool) {
          tool = definition
          return () => undefined
        },
      },
      systemPrompt: { section() { return () => undefined } },
      inject() { return () => undefined },
      get() { return undefined },
      on() { return () => undefined },
    } as never)
    if (tool === undefined) throw new Error('Raven tool did not register')
    const registered = tool

    // A session with NO durable log at all: if its own book were evicted mid-use it
    // could not be rebuilt, so the eviction must always exempt the requested key.
    const agent = { id: 'hot-session', session: { events: [] as unknown[] } }
    const started = await registered.execute({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'A Task with no durable record of its own.',
    }, { agent, signal })
    for (let index = 0; index < 80; index += 1) {
      await registered.execute({
        action: 'start',
        outcome: 'general-writing',
        grounding: 'none',
        request: `Another unrelated Task ${index}.`,
      }, { agent: { id: `other-${index}`, session: { events: [] } }, signal })
      // Touching the hot session keeps it most-recently-used.
      await registered.execute({ action: 'status', taskId: started.state.taskId }, { agent, signal })
    }
    const still = await registered.execute({ action: 'status', taskId: started.state.taskId }, { agent, signal })
    expect(still.state.taskId).toBe(started.state.taskId)
  })
})