import { describe, expect, it } from 'vitest'

import { decodeRavenTaskState } from '../../src/codec.js'
import {
  createRavenEngine,
  formatDraftRoute,
  parseDraftRoute,
  type RavenDraftLimits,
  renderVariants,
} from '../../src/engine.js'
import { DRAFT_CRITERIA, RAVEN_LIMITS } from '../../src/domain.js'
import { apply } from '../../src/plugin.js'
import type {
  DraftGenerator,
  DraftRequest,
  ProseLayoutOptions,
  RavenDraftRoute,
  SourceVerifier,
} from '../../src/index.js'

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

const fast: RavenDraftRoute = { provider: 'alpha', model: 'fast' }
const deep: RavenDraftRoute = { provider: 'beta', model: 'org/deep-v2' }

interface DraftHarness {
  readonly generator: DraftGenerator
  readonly requests: DraftRequest[]
}

function recordingDrafter(
  reply: (route: RavenDraftRoute) => { status: 'drafted' | 'failed'; text?: string; detail?: string },
): DraftHarness {
  const requests: DraftRequest[] = []
  return {
    requests,
    generator: {
      generate: async (request) => {
        requests.push(request)
        const variants = request.routes.map(route => ({ route, ...reply(route) }))
        const drafted = variants.filter(variant => variant.status === 'drafted').length
        return {
          path: drafted >= 2 ? 'multi-model' : drafted === 1 ? 'single-model' : 'main-agent',
          variants,
        }
      },
    },
  }
}

function comparisonJsonForAdapter(): string {
  return JSON.stringify({
    recommendation: 'proceed',
    reason: 'The candidates contain complementary strengths.',
    criteria: Object.fromEntries(DRAFT_CRITERIA.map(criterion => [criterion, `${criterion} compared.`])),
  })
}

function synthesisJsonForAdapter(): string {
  return JSON.stringify({
    text: 'The synthesized section combines mechanism and boundary.',
    contributions: [{
      route: 'alpha/writer', strength: 'mechanism', candidateExcerpt: 'mechanism', synthesisExcerpt: 'mechanism',
    }, {
      route: 'beta/critic', strength: 'boundary', candidateExcerpt: 'boundary', synthesisExcerpt: 'boundary',
    }],
  })
}

function harness(options: {
  readonly draft?: DraftGenerator
  readonly routes?: readonly RavenDraftRoute[]
  readonly layout?: ProseLayoutOptions
}) {
  const limits: RavenDraftLimits = { maxTokens: 1_000, routes: options.routes ?? [fast, deep] }
  return createRavenEngine({
    now,
    sourceVerifier,
    ...(options.draft === undefined ? {} : { draftGenerator: options.draft }),
    draftLimits: () => limits,
    proseLayout: () => options.layout ?? { layout: 'sentence-per-line', format: 'markdown' },
  })
}

async function startedTask(engine: ReturnType<typeof harness>, sessionId: string) {
  return engine.dispatch(null, {
    action: 'start',
    outcome: 'general-writing',
    request: 'Write the introduction of a short report.',
  }, { sessionId, signal })
}

describe('draft route parsing', () => {
  it('splits on the first slash so a namespaced model id survives', () => {
    expect(parseDraftRoute('beta/org/deep-v2')).toEqual({ provider: 'beta', model: 'org/deep-v2' })
    expect(formatDraftRoute({ provider: 'beta', model: 'org/deep-v2' })).toBe('beta/org/deep-v2')
  })

  it('refuses a spec with no model or no provider', () => {
    expect(parseDraftRoute('alpha')).toBeUndefined()
    expect(parseDraftRoute('/fast')).toBeUndefined()
    expect(parseDraftRoute('alpha/')).toBeUndefined()
    expect(parseDraftRoute('   ')).toBeUndefined()
  })
})

describe('Draft Variants', () => {
  it('runs the full candidate, critique, and synthesis chain through the Harness llm adapter', async () => {
    interface ModelRequest {
      readonly provider: string
      readonly model: string
      readonly system: string
      readonly messages: readonly unknown[]
    }
    interface TaskTool {
      readonly name: string
      execute(args: unknown, exec: unknown): Promise<{
        readonly state: { readonly taskId: string }
        readonly variants?: { readonly synthesis?: { readonly text: string } }
      }>
    }
    const modelRequests: ModelRequest[] = []
    let taskTool: TaskTool | undefined
    const llm = {
      async *stream(request: ModelRequest) {
        modelRequests.push(request)
        const text = request.system.includes('adversarial editor')
          ? comparisonJsonForAdapter()
          : request.system.includes('Synthesize the strongest')
            ? synthesisJsonForAdapter()
            : request.provider === 'alpha'
              ? 'Alpha supplies the mechanism.'
              : 'Beta supplies the boundary.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    apply({
      tools: {
        register(definition: TaskTool) {
          if (definition.name === 'raven_task') taskTool = definition
          return () => undefined
        },
      },
      systemPrompt: { section() { return () => undefined } },
      inject() { return () => undefined },
      get(name: string) { return name === 'llm' ? llm : undefined },
      on() { return () => undefined },
    } as never, {
      role: 'agent',
      draftRoutes: ['alpha/writer', 'beta/critic'],
      draftMaxTokens: 1_000,
      draftTimeoutMs: 0,
    })
    if (taskTool === undefined) throw new Error('expected raven_task tool')
    const agent = { id: 'adapter-draft', session: { events: [] } }
    const started = await taskTool.execute({
      action: 'start', outcome: 'general-writing', grounding: 'none', request: 'Draft one bounded section.',
    }, { agent, signal })
    const drafted = await taskTool.execute({
      action: 'draft', taskId: started.state.taskId, instruction: 'Draft the opening section.',
    }, { agent, signal })

    expect(modelRequests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'alpha/writer', 'beta/critic', 'beta/critic', 'alpha/writer',
    ])
    expect(drafted.variants?.synthesis?.text).toBe('The synthesized section combines mechanism and boundary.')
  })

  it('times out a stalled llm stream even when the iterator never yields', async () => {
    interface TaskTool {
      readonly name: string
      execute(args: unknown, exec: unknown): Promise<{
        readonly state: { readonly taskId: string }
        readonly message: string
        readonly variants?: { readonly path?: string; readonly variants: ReadonlyArray<{ readonly detail?: string }> }
      }>
    }
    let taskTool: TaskTool | undefined
    const llm = {
      async *stream() {
        await new Promise<never>(() => undefined)
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    apply({
      tools: {
        register(definition: TaskTool) {
          if (definition.name === 'raven_task') taskTool = definition
          return () => undefined
        },
      },
      systemPrompt: { section() { return () => undefined } },
      inject() { return () => undefined },
      get(name: string) { return name === 'llm' ? llm : undefined },
      on() { return () => undefined },
    } as never, {
      role: 'agent', draftRoutes: ['alpha/writer'], draftMaxTokens: 100, draftTimeoutMs: 5,
    })
    if (taskTool === undefined) throw new Error('expected raven_task tool')
    const agent = { id: 'adapter-timeout', session: { events: [] } }
    const started = await taskTool.execute({
      action: 'start', outcome: 'general-writing', grounding: 'none', request: 'Draft one bounded section.',
    }, { agent, signal })
    const drafted = await taskTool.execute({
      action: 'draft', taskId: started.state.taskId, instruction: 'Draft the opening section.',
    }, { agent, signal })

    expect(drafted.message).toContain('no route produced a Draft Variant')
    expect(drafted.variants?.path).toBe('main-agent')
    expect(drafted.variants?.variants[0]?.detail).toContain('configured 5ms deadline')
  })

  it('drafts from every configured route and lays each variant out one sentence per line', async () => {
    const drafter = recordingDrafter(route => ({
      status: 'drafted',
      text: `A claim from ${route.model}. A second sentence.`,
    }))
    const engine = harness({ draft: drafter.generator })
    const started = await startedTask(engine, 'session-draft-all')

    const round = await engine.dispatch(started.state, {
      action: 'draft',
      taskId: started.state.taskId,
      instruction: 'Draft the opening paragraph.',
    }, { sessionId: 'session-draft-all', signal })

    expect(round.status).toBe('active')
    expect(round.variants?.variants).toHaveLength(2)
    expect(round.variants?.variants[0]?.text).toBe('A claim from fast.\nA second sentence.')
    expect(round.variants?.variants[1]?.text).toBe('A claim from org/deep-v2.\nA second sentence.')
    expect(drafter.requests[0]?.routes).toEqual([fast, deep])
    expect(drafter.requests[0]?.system).toContain('one sentence on each line')
    expect(drafter.requests[0]?.context).toContain('Write the introduction of a short report.')
    expect(round.issues.join(' ')).toContain('candidates, not Checkpoints')
  })

  it('derives a compatibility path for pre-v5 DraftGenerator results', async () => {
    const engine = harness({
      draft: {
        generate: async request => ({
          variants: request.routes.map(route => ({ route, status: 'drafted', text: 'Legacy generator candidate.' })),
        }),
      },
    })
    const started = await startedTask(engine, 'session-draft-legacy-generator')
    const round = await engine.dispatch(started.state, {
      action: 'draft', taskId: started.state.taskId, instruction: 'Draft it.',
    }, { sessionId: 'session-draft-legacy-generator', signal })

    expect(round.variants?.path).toBe('multi-model')
    expect(round.state.drafts?.at(-1)?.path).toBe('multi-model')
    expect(decodeRavenTaskState(JSON.parse(JSON.stringify(round.state)))).toEqual(round.state)
  })

  it('honours a requested subset and refuses a route the deployment never configured', async () => {
    const drafter = recordingDrafter(() => ({ status: 'drafted', text: 'One sentence.' }))
    const engine = harness({ draft: drafter.generator })
    const started = await startedTask(engine, 'session-draft-subset')

    await engine.dispatch(started.state, {
      action: 'draft',
      taskId: started.state.taskId,
      instruction: 'Draft it.',
      routes: ['beta/org/deep-v2'],
    }, { sessionId: 'session-draft-subset', signal })
    expect(drafter.requests[0]?.routes).toEqual([deep])

    await expect(engine.dispatch(started.state, {
      action: 'draft',
      taskId: started.state.taskId,
      instruction: 'Draft it.',
      routes: ['gamma/secret'],
    }, { sessionId: 'session-draft-subset', signal }))
      .rejects.toThrow('is not configured for this deployment')
  })

  it('reports that drafting is unavailable instead of quietly using the session model', async () => {
    const engine = harness({ routes: [] })
    const started = await startedTask(engine, 'session-draft-none')

    const round = await engine.dispatch(started.state, {
      action: 'draft',
      taskId: started.state.taskId,
      instruction: 'Draft it.',
    }, { sessionId: 'session-draft-none', signal })

    expect(round.variants?.unavailable).toContain('no Draft Variant route is configured')
    expect(round.variants?.variants).toEqual([])
    // Nothing was generated or published, but the explicit main-agent fallback is durable provenance.
    expect(round.state.latestArtifact).toBe(started.state.latestArtifact)
    expect(round.state.checkpoints).toEqual(started.state.checkpoints)
    expect(round.state.drafts?.at(-1)).toMatchObject({ path: 'main-agent', routes: [] })
    expect(round.issues.join(' ')).toContain('continue drafting with the main agent')

    const checkpoint = await engine.dispatch(round.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'draft',
      summary: 'The main agent used the graceful fallback.', artifact: 'A useful main-agent draft.',
    }, { sessionId: 'session-draft-none', signal })
    const completed = await engine.dispatch(checkpoint.state, {
      action: 'complete', taskId: started.state.taskId, artifact: checkpoint.state.latestArtifact,
    }, { sessionId: 'session-draft-none', signal })
    expect(completed.status).toBe('completed')
  })

  it('keeps the surviving variants when one route fails', async () => {
    const drafter = recordingDrafter(route => route.provider === 'alpha'
      ? { status: 'failed', detail: 'provider is down' }
      : { status: 'drafted', text: 'The surviving candidate.' })
    const engine = harness({ draft: drafter.generator })
    const started = await startedTask(engine, 'session-draft-partial')

    const round = await engine.dispatch(started.state, {
      action: 'draft',
      taskId: started.state.taskId,
      instruction: 'Draft it.',
    }, { sessionId: 'session-draft-partial', signal })

    expect(round.variants?.variants.map(variant => variant.status)).toEqual(['failed', 'drafted'])
    expect(round.issues.join(' ')).toContain('Only one candidate survived')
  })

  it('reports an explicit unavailability when EVERY route fails, never an empty success', async () => {
    // The partial case above is the easy one. When no route survives there is no
    // 'compare the ones that did' to fall back on, and a round that renders zero
    // variants while reporting `status: active` with no stated reason reads to the
    // agent as 'the models had nothing to add' rather than 'drafting did not run'.
    // The per-route reasons are the whole value of the round in that case.
    const drafter = recordingDrafter(route => ({
      status: 'failed',
      detail: `${route.provider} refused the request`,
    }))
    const engine = harness({ draft: drafter.generator })
    const started = await startedTask(engine, 'session-draft-all-failed')

    const round = await engine.dispatch(started.state, {
      action: 'draft',
      taskId: started.state.taskId,
      instruction: 'Draft it.',
    }, { sessionId: 'session-draft-all-failed', signal })

    // Every route is accounted for, and each carries its own reason.
    expect(round.variants?.variants).toHaveLength(2)
    expect(round.variants?.variants.every(variant => variant.status === 'failed')).toBe(true)
    expect(round.variants?.variants.map(variant => variant.detail))
      .toEqual(['alpha refused the request', 'beta refused the request'])

    // The round must SAY it produced nothing rather than presenting an empty set as
    // a successful comparison.
    const reported = [
      round.message,
      round.variants?.unavailable ?? '',
      ...round.issues,
    ].join(' ')
    // The wording must state that NO route produced anything. The partial-failure
    // phrasing ('one or more routes produced no variant; compare the ones that did')
    // is specifically wrong here: it points the agent at a comparison set that is
    // empty, and the surrounding message reads '0 Draft Variant(s) from 2 route(s)',
    // which is an empty success rather than a stated failure.
    expect(reported).toMatch(/no route produced|every route|none of the .* routes|did not run/i)
    expect(round.issues.join(' ')).not.toContain('compare the ones that did')

    // The rendered round names every failed route and its reason, because that is
    // the only actionable content a fully failed round has.
    const rendered = renderVariants(round.variants ?? { path: 'main-agent', variants: [] })
    expect(rendered).toContain('Routes that produced no variant')
    expect(rendered).toContain('alpha/fast')
    expect(rendered).toContain('alpha refused the request')
    expect(rendered).toContain('beta/org/deep-v2')

    // Nothing was published: a failed comparison round is not a Checkpoint.
    expect(round.state.latestArtifact).toBe(started.state.latestArtifact)
    expect(round.state.checkpoints).toEqual(started.state.checkpoints)
  })

  it.each([
    { recommendation: 'research' as const, issue: 'return to inspection or discovery' },
    { recommendation: 'synthesis' as const, issue: 'run action=synthesize' },
  ])('persists $recommendation recovery until a later draft supersedes it', async ({ recommendation, issue }) => {
    const draft: DraftGenerator = {
      generate: async request => ({
        path: 'multi-model',
        variants: request.routes.map(route => ({ route, status: 'drafted', text: `${route.provider} candidate.` })),
        comparison: {
          route: deep,
          recommendation,
          reason: 'The current section contract exposes a material gap.',
          criteria: DRAFT_CRITERIA.map(criterion => ({ criterion, assessment: `${criterion} exposes the gap.` })),
        },
      }),
    }
    const engine = harness({ draft })
    const started = await startedTask(engine, `session-draft-${recommendation}`)
    const rejected = await engine.dispatch(started.state, {
      action: 'draft', taskId: started.state.taskId, instruction: 'Draft the section.',
    }, { sessionId: `session-draft-${recommendation}`, signal })

    expect(rejected.status).toBe('needs-revision')
    const status = await engine.dispatch(rejected.state, {
      action: 'status', taskId: started.state.taskId,
    }, { sessionId: `session-draft-${recommendation}`, signal })
    expect(status.issues.join(' ')).toContain(issue)
    await expect(engine.dispatch(rejected.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'draft',
      summary: 'Premature prose.', artifact: 'The unresolved draft.',
    }, { sessionId: `session-draft-${recommendation}`, signal })).rejects.toThrow(/then run action=draft again/)
  })

  it('records bounded route provenance without retaining the variant text, and survives replay', async () => {
    const drafter = recordingDrafter(() => ({ status: 'drafted', text: 'Kept out of the record.' }))
    const engine = harness({ draft: drafter.generator })
    const started = await startedTask(engine, 'session-draft-record')

    const round = await engine.dispatch(started.state, {
      action: 'draft',
      taskId: started.state.taskId,
      instruction: 'Draft the opening paragraph.',
    }, { sessionId: 'session-draft-record', signal })

    const rounds = round.state.drafts ?? []
    expect(rounds).toHaveLength(1)
    expect(rounds[0]).toEqual({
      ordinal: 1,
      instruction: 'Draft the opening paragraph.',
      requestedAt: now(),
      steeringRevision: 0,
      path: 'multi-model',
      routes: [
        { provider: 'alpha', model: 'fast', status: 'drafted', chars: 23 },
        { provider: 'beta', model: 'org/deep-v2', status: 'drafted', chars: 23 },
      ],
    })
    expect(JSON.stringify(rounds)).not.toContain('Kept out of the record')

    const replayed = decodeRavenTaskState(JSON.parse(JSON.stringify(round.state)))
    expect(replayed?.drafts).toEqual(rounds)
  })

  it('rotates rounds at the bound while keeping ordinals strictly increasing for replay', async () => {
    const drafter = recordingDrafter(() => ({ status: 'drafted', text: 'A sentence.' }))
    const engine = harness({ draft: drafter.generator })
    let state = (await startedTask(engine, 'session-draft-rotate')).state
    const taskId = state.taskId
    for (let round = 0; round < RAVEN_LIMITS.draftRounds + 8; round += 1) {
      state = (await engine.dispatch(state, {
        action: 'draft',
        taskId,
        instruction: `round ${round}`,
      }, { sessionId: 'session-draft-rotate', signal })).state
    }
    const rounds = state.drafts ?? []
    expect(rounds).toHaveLength(RAVEN_LIMITS.draftRounds)
    // Trimming from the front must not restart the numbering: the replay codec
    // requires strictly increasing ordinals, so a reset would make the whole
    // Task unreadable after a long writing session.
    expect(rounds.at(-1)?.ordinal).toBe(RAVEN_LIMITS.draftRounds + 8)
    expect(rounds.every((entry, index) => index === 0 || entry.ordinal > (rounds[index - 1]?.ordinal ?? 0))).toBe(true)
    expect(decodeRavenTaskState(JSON.parse(JSON.stringify(state)))).not.toBeUndefined()
  })

  it('never lets variants, comparison, or synthesized prose reach the evidence floor', async () => {
    const engine = harness({
      draft: {
        generate: async request => ({
          path: 'multi-model',
          variants: request.routes.map(route => ({
            route,
            status: 'drafted',
            text: route.provider === 'alpha'
              ? 'Nuclear output rose by 12 percent.'
              : 'The reported increase was 12 percent.',
          })),
          comparison: {
            route: deep,
            recommendation: 'proceed',
            reason: 'Both candidates are fluent but still require real evidence.',
            criteria: DRAFT_CRITERIA.map(criterion => ({ criterion, assessment: `${criterion} remains candidate analysis.` })),
          },
          synthesis: {
            route: fast,
            variantRoutes: request.routes,
            contributions: [{
              route: fast, strength: 'compression', candidateExcerpt: 'Nuclear output', synthesisExcerpt: 'Nuclear output',
            }, {
              route: deep, strength: 'qualification', candidateExcerpt: 'reported increase', synthesisExcerpt: 'reported increase',
            }],
            text: 'Nuclear output and the reported increase were both described as 12 percent.',
          },
        }),
      },
    })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Report on generation capacity.',
    }, { sessionId: 'session-draft-floor', signal })

    const round = await engine.dispatch(started.state, {
      action: 'draft',
      taskId: started.state.taskId,
      instruction: 'Draft the finding.',
    }, { sessionId: 'session-draft-floor', signal })

    // The round produced prose, and the Task still owns no Source and no Claim.
    expect(round.variants?.variants[0]?.text).toContain('12 percent')
    expect(round.variants?.synthesis?.text).toContain('12 percent')
    expect(round.state.sources).toEqual([])
    expect(round.state.claims).toEqual([])

    const checkpoint = await engine.dispatch(round.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Adopted the variant wording verbatim.',
      artifact: 'Nuclear output rose by 12 percent.',
    }, { sessionId: 'session-draft-floor', signal })

    const completed = await engine.dispatch(checkpoint.state, {
      action: 'complete',
      taskId: started.state.taskId,
      artifact: checkpoint.state.latestArtifact ?? '',
    }, { sessionId: 'session-draft-floor', signal })

    expect(completed.status).toBe('needs-revision')
    expect(completed.issues.join(' ')).toContain('at least one verified material external Claim')
  })
})

describe('Prose Layout on the stored Artifact', () => {
  it('stores the laid-out bytes and reports the reflow', async () => {
    const engine = harness({})
    const started = await startedTask(engine, 'session-layout-store')

    const checkpoint = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'First useful draft.',
      artifact: 'The first point holds. The second point does not.',
    }, { sessionId: 'session-layout-store', signal })

    expect(checkpoint.state.latestArtifact).toBe('The first point holds.\nThe second point does not.')
    expect(checkpoint.relaidArtifact).toEqual({ sourceLines: 1, laidOutLines: 2 })
    expect(checkpoint.state.checkpoints[0]?.proseLayout).toBe('sentence-per-line')
    expect(checkpoint.state.checkpoints[0]?.artifactChars).toBe(49)
  })

  it('accepts Completion of the bytes it stored, whichever line shape the caller resends', async () => {
    const engine = harness({})
    const started = await startedTask(engine, 'session-layout-complete')
    const checkpoint = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'First useful draft.',
      artifact: 'The first point holds. The second point does not.',
    }, { sessionId: 'session-layout-complete', signal })

    // The caller resends the ORIGINAL packed text; the layout is idempotent, so
    // it normalizes to the same stored bytes and Completion is not blocked on a
    // formatting difference nobody made.
    const completed = await engine.dispatch(checkpoint.state, {
      action: 'complete',
      taskId: started.state.taskId,
      artifact: 'The first point holds. The second point does not.',
    }, { sessionId: 'session-layout-complete', signal })

    expect(completed.status).toBe('completed')
    expect(completed.state.latestArtifact).toBe('The first point holds.\nThe second point does not.')
  })

  it('names the layout change when it is what made the bytes differ', async () => {
    let layout: ProseLayoutOptions = { layout: 'sentence-per-line', format: 'markdown' }
    const engine = createRavenEngine({ now, sourceVerifier, proseLayout: () => layout })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      request: 'Write a paragraph.',
    }, { sessionId: 'session-layout-switch', signal })
    const checkpoint = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Draft under the default layout.',
      artifact: 'One point holds. Another does not.',
    }, { sessionId: 'session-layout-switch', signal })

    layout = { layout: 'as-written', format: 'markdown' }
    const completed = await engine.dispatch(checkpoint.state, {
      action: 'complete',
      taskId: started.state.taskId,
      artifact: 'One point holds. Another does not.',
    }, { sessionId: 'session-layout-switch', signal })

    expect(completed.status).toBe('needs-revision')
    expect(completed.issues.join(' ')).toContain('Prose Layout changed from sentence-per-line to as-written')
    expect(completed.issues.join(' ')).not.toContain('substantive final edits')
  })

  it('stores exactly what the agent submitted when the layout is disabled', async () => {
    const engine = harness({ layout: { layout: 'as-written', format: 'markdown' } })
    const started = await startedTask(engine, 'session-layout-off')

    const checkpoint = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Draft with the layout disabled.',
      artifact: 'The first point holds. The second point does not.',
    }, { sessionId: 'session-layout-off', signal })

    expect(checkpoint.state.latestArtifact).toBe('The first point holds. The second point does not.')
    expect(checkpoint.relaidArtifact).toBeUndefined()
    expect(checkpoint.state.checkpoints[0]?.proseLayout).toBe('as-written')
  })

  it('leaves a fenced code block in an Artifact untouched', async () => {
    const engine = harness({})
    const started = await startedTask(engine, 'session-layout-code')
    const artifact = 'Intro. Detail.\n\n```js\nconst a = 1. // not prose. really\n```'

    const checkpoint = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Draft with code.',
      artifact,
    }, { sessionId: 'session-layout-code', signal })

    expect(checkpoint.state.latestArtifact)
      .toBe('Intro.\nDetail.\n\n```js\nconst a = 1. // not prose. really\n```')
  })
})