import { describe, expect, it, vi } from 'vitest'

import * as RavenPlugin from '../../src/index.js'

describe('Raven Cordis plugin', () => {
  it('registers separate Task and Workspace tools with one concise prompt section and named exports', () => {
    const tools: Array<Record<string, unknown>> = []
    const sections: Array<Record<string, unknown>> = []
    const listeners: Array<{ event: string; listener: unknown }> = []
    const ctx = {
      tools: {
        register(definition: Record<string, unknown>) {
          tools.push(definition)
          return vi.fn()
        },
      },
      systemPrompt: {
        section(definition: Record<string, unknown>) {
          sections.push(definition)
          return vi.fn()
        },
      },
      inject() {
        return vi.fn()
      },
      get() {
        return undefined
      },
      on(event: string, listener: unknown) {
        listeners.push({ event, listener })
        return vi.fn()
      },
    }

    expect('default' in RavenPlugin).toBe(false)
    expect(RavenPlugin.name).toBe('raven-research')
    expect(RavenPlugin.inject).toEqual(['tools', 'systemPrompt'])

    RavenPlugin.apply(ctx as never)

    expect(tools.map(tool => tool.name)).toEqual(['raven_workspace', 'raven_task'])
    const [workspaceTool, taskTool] = tools
    expect(workspaceTool?.description).toContain('lifecycle is separate')
    expect(taskTool?.description).toContain('Exact action fields: start(outcome, request, grounding, sourcePolicy, structureMode)')
    const parameters = taskTool?.parameters as {
      properties: Record<string, { description?: string }>
    }
    const properties = parameters.properties
    expect(properties.artifact?.description).toContain(String(RavenPlugin.RAVEN_LIMITS.artifactChars))
    expect(properties.sources?.description).toContain(String(RavenPlugin.RAVEN_LIMITS.sources))
    const sourceItems = (properties.sources as unknown as {
      items: { properties: Record<string, { description?: string }> }
    }).items
    const claimItems = (properties.claims as unknown as {
      items: { properties: Record<string, { description?: string }> }
    }).items
    const failureItems = (properties.failures as unknown as {
      items: { properties: Record<string, { description?: string }> }
    }).items
    expect(sourceItems.properties.excerpt?.description).toContain(String(RavenPlugin.RAVEN_LIMITS.sourceExcerptChars))
    expect(claimItems.properties.text?.description).toContain(String(RavenPlugin.RAVEN_LIMITS.claimTextChars))
    expect(failureItems.properties.detail?.description).toContain(String(RavenPlugin.RAVEN_LIMITS.limitationDetailChars))
    expect(sections).toEqual([
      expect.objectContaining({ name: 'tool:raven-task' }),
    ])
    expect(Number.isFinite(sections[0]?.order)).toBe(true)
    expect(String(sections[0]?.text)).toContain('one continuing Raven Task')
    expect(listeners.map(listener => listener.event)).toEqual(['tools/ptc-dispatch-log', 'agent/pre-step'])
    expect(properties.queries?.description).toContain('Leads, never Sources')
  })

  it('reconstructs compact Task state from durable tool-result metadata after plugin reload', async () => {
    interface TestTool extends Record<string, unknown> {
      execute(args: unknown, exec: unknown): Promise<{
        state: RavenPlugin.RavenTaskState
        status: string
      }>
      output: {
        presentationMeta(args: unknown, value: unknown): unknown
      }
    }

    const capture = () => {
      let tool: TestTool | undefined
      const ctx = {
        tools: {
          register(definition: TestTool) {
            tool = definition
            return vi.fn()
          },
        },
        systemPrompt: { section() { return vi.fn() } },
        inject() { return vi.fn() },
        get() { return undefined },
        on() { return vi.fn() },
      }
      RavenPlugin.apply(ctx as never)
      if (tool === undefined) throw new Error('Raven tool did not register')
      return tool
    }

    const first = capture()
    const signal = new AbortController().signal
    const firstAgent = { id: 'replay-session', session: { events: [] } }
    const started = await first.execute({
      action: 'start',
      outcome: 'learning',
      grounding: 'none',
      request: 'Teach one concept.',
    }, { agent: firstAgent, signal })
    const checkpoint = await first.execute({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'An early explanation.',
      artifact: 'A useful explanation that survives replay.',
    }, { agent: firstAgent, signal })
    const meta = JSON.parse(JSON.stringify(first.output.presentationMeta({}, checkpoint))) as unknown
    const unchanged = await first.execute({
      action: 'status',
      taskId: started.state.taskId,
    }, { agent: firstAgent, signal })
    const unchangedMeta = first.output.presentationMeta({}, unchanged) as Record<string, unknown>
    expect(unchangedMeta).not.toHaveProperty('state')
    expect(unchangedMeta).toMatchObject({
      kind: 'dsh-raven-research/task-state',
      currentTaskId: started.state.taskId,
    })
    const malformedMeta = {
      kind: 'dsh-raven-research/task-state',
      version: 1,
      state: {
        schemaVersion: 1,
        taskId: started.state.taskId,
        revision: 999,
        checkpoints: [],
        sources: [],
        claims: [],
        limitations: [],
      },
    }
    const unknownVersionMeta = {
      kind: 'dsh-raven-research/task-state',
      version: 99,
      state: checkpoint.state,
    }

    const reloaded = capture()
    const replayAgent = {
      id: 'replay-session',
      session: {
        events: [
          { type: 'tool/result', data: { meta } },
          { type: 'tool/result', data: { meta: malformedMeta } },
          { type: 'tool/result', data: { meta: unknownVersionMeta } },
        ],
      },
    }
    const restored = await reloaded.execute({
      action: 'status',
      taskId: started.state.taskId,
    }, { agent: replayAgent, signal })

    expect(restored.state.taskId).toBe(started.state.taskId)
    expect(restored.state.checkpoints).toHaveLength(1)
    expect(restored.state.latestArtifact).toBe('A useful explanation that survives replay.')
  })

  it('recalls bounded exact Insight Candidates after replay and promotes an inspected Candidate', async () => {
    interface TestValue {
      readonly state: RavenPlugin.RavenTaskState
      readonly status: string
      readonly recall?: {
        readonly unpromotedInsightIds: readonly string[]
        readonly totalUnpromoted: number
        readonly insightOffset: number
        readonly nextInsightOffset: number | null
      }
      readonly inspection?: { readonly candidates: readonly RavenPlugin.RavenInsightCandidate[] }
    }
    interface TestTool extends Record<string, unknown> {
      execute(args: unknown, exec: unknown): Promise<TestValue>
      output: {
        render(args: unknown, value: unknown): Array<{ readonly type: string; readonly text: string }>
        presentationMeta(args: unknown, value: unknown): unknown
      }
    }
    type PreStep = (
      event: { readonly agent: unknown },
      next: () => Promise<{ readonly kind: 'enter'; readonly messages: readonly unknown[] }>,
    ) => Promise<{ readonly kind: 'enter'; readonly messages: ReadonlyArray<{ readonly content: ReadonlyArray<{ readonly text?: string }> }> }>
    const capture = () => {
      let tool: TestTool | undefined
      let preStep: PreStep | undefined
      RavenPlugin.apply({
        tools: { register(definition: TestTool) { tool = definition; return vi.fn() } },
        systemPrompt: { section() { return vi.fn() } },
        inject() { return vi.fn() },
        get() { return undefined },
        on(event: string, listener: unknown) {
          if (event === 'agent/pre-step') preStep = listener as PreStep
          return vi.fn()
        },
      } as never)
      if (tool === undefined || preStep === undefined) throw new Error('Raven recall surface did not register')
      return { tool, preStep }
    }

    const first = capture()
    const signal = new AbortController().signal
    const firstAgent = { id: 'candidate-replay-session', session: { events: [] as unknown[] } }
    const started = await first.tool.execute({
      action: 'start', outcome: 'learning', grounding: 'none', request: 'Preserve candidate reasoning across replay.',
    }, { agent: firstAgent, signal })
    const checkpoint = await first.tool.execute({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'analyze', summary: 'Premises recorded.',
      artifact: 'A durable premise.',
      claims: [{
        claimId: 'C1', text: 'A durable premise.', kind: 'analysis', importance: 'context',
        disposition: 'supported', sourceIds: [],
      }, {
        claimId: 'C-DEBT', text: 'An unresolved premise.', kind: 'analysis', importance: 'context',
        disposition: 'deferred', sourceIds: [],
      }],
    }, { agent: firstAgent, signal })
    const debt = await first.tool.execute({
      action: 'synthesize', taskId: started.state.taskId, scope: 'Findings', purpose: 'synthesis',
      claimIds: ['C-DEBT'], insights: [],
    }, { agent: firstAgent, signal })
    const summary = await first.tool.execute({
      action: 'synthesize', taskId: started.state.taskId, scope: 'User summary', purpose: 'summary',
      claimIds: ['C-DEBT'], insights: [],
    }, { agent: firstAgent, signal })
    expect(summary.state.taskId).toBe(debt.state.taskId)
    const candidates = [{
      insightId: 'I1',
      text: 'The durable premise supports an inspectable interpretation.',
      kind: 'interpretation',
      pattern: 'unexpected-connection',
      claimIds: ['C1'],
      assumptions: ['The premise remains applicable.'],
      rationale: 'It connects retained state to a later promotion decision.',
      wouldChangeMind: 'Evidence that the premise no longer applies.',
      confidence: 'medium',
    }, {
      insightId: 'I2',
      text: 'A second durable interpretation remains available.',
      kind: 'hypothesis',
      pattern: 'alternative-causal-mechanism',
      claimIds: ['C1'],
      assumptions: [],
      rationale: 'It preserves an alternative after the first is promoted.',
      wouldChangeMind: 'Evidence excluding the alternative mechanism.',
      confidence: 'low',
      competesWith: ['I1'],
    }, ...Array.from({ length: 7 }, (_, index) => ({
      insightId: `I${index + 3}`,
      text: `Bounded durable interpretation ${index + 3}.`,
      kind: 'interpretation',
      pattern: 'other',
      claimIds: ['C1'],
      assumptions: [],
      rationale: 'It proves the status index remains bounded.',
      wouldChangeMind: 'Evidence that the interpretation is inapplicable.',
      confidence: 'low',
    }))]
    const synthesized = await first.tool.execute({
      action: 'synthesize', taskId: started.state.taskId, scope: 'Mechanism', purpose: 'synthesis',
      claimIds: ['C1'], insights: candidates,
    }, { agent: firstAgent, signal })
    const meta = JSON.parse(JSON.stringify(first.tool.output.presentationMeta({}, synthesized))) as unknown

    const reloaded = capture()
    const replayAgent = {
      id: 'candidate-replay-session',
      session: { events: [{ type: 'tool/result', data: { meta } }] },
    }
    const status = await reloaded.tool.execute({
      action: 'status', taskId: started.state.taskId,
    }, { agent: replayAgent, signal })
    expect(status.recall).toEqual({
      unpromotedInsightIds: ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8'],
      totalUnpromoted: 9,
      insightOffset: 0,
      nextInsightOffset: 8,
    })
    const statusText = reloaded.tool.output.render({}, status)[0]?.text ?? ''
    expect(statusText).toContain('Unpromoted Insight Candidate IDs at insightOffset=0 (8 shown of 9): I1, I2, I3, I4, I5, I6, I7, I8')
    expect(statusText).toContain(`action=status taskId=${started.state.taskId} insightOffset=8`)
    expect(statusText).not.toContain('I9')
    expect(statusText).toContain('action=inspect')
    expect(statusText).toContain('Verification scope: current Checkpoint Artifact bytes')
    expect(statusText).not.toContain(candidates[0]?.text)

    const nextStatus = await reloaded.tool.execute({
      action: 'status', taskId: started.state.taskId, insightOffset: 8,
    }, { agent: replayAgent, signal })
    expect(nextStatus.recall).toEqual({
      unpromotedInsightIds: ['I9'],
      totalUnpromoted: 9,
      insightOffset: 8,
      nextInsightOffset: null,
    })
    const nextStatusText = reloaded.tool.output.render({}, nextStatus)[0]?.text ?? ''
    expect(nextStatusText).toContain('Unpromoted Insight Candidate IDs at insightOffset=8 (1 shown of 9): I9')
    expect(nextStatusText).not.toContain('insightOffset=16')

    const decision = await reloaded.preStep({ agent: replayAgent }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    const context = decision.messages.flatMap(message => message.content).map(part => part.text ?? '').join('\n')
    expect(context).toContain('I1, I2')
    expect(context).toContain('action=inspect')
    expect(context).toContain(`action=status taskId=${started.state.taskId} insightOffset=8`)
    expect(context).toContain('Outstanding Summary Debt remains in 1 synthesis scope')
    expect(context).toContain('high in Findings')

    const inspected = await reloaded.tool.execute({
      action: 'inspect', taskId: started.state.taskId, insightIds: ['I1'],
    }, { agent: replayAgent, signal })
    expect(inspected.state).toBe(status.state)
    expect(inspected.inspection?.candidates).toEqual([synthesized.state.insightCandidates[0]])
    const inspectText = reloaded.tool.output.render({}, inspected)[0]?.text ?? ''
    expect(inspectText).toContain('Exact durable Insight Candidate records')
    expect(inspectText).toContain('"claimIds": [')
    expect(inspectText).toContain('"assumptions": [')
    expect(inspectText).toContain('"rationale":')
    expect(inspectText).toContain('"wouldChangeMind":')
    expect(inspectText).toContain(candidates[0]?.text)

    await expect(reloaded.tool.execute({
      action: 'status', taskId: started.state.taskId, insightOffset: -1,
    }, { agent: replayAgent, signal })).rejects.toThrow(/insightOffset must be a nonnegative safe integer/)
    await expect(reloaded.tool.execute({
      action: 'status', taskId: started.state.taskId, insightOffset: 1.5,
    }, { agent: replayAgent, signal })).rejects.toThrow(/insightOffset must be a nonnegative safe integer/)
    await expect(reloaded.tool.execute({
      action: 'inspect', taskId: started.state.taskId, insightIds: [],
    }, { agent: replayAgent, signal })).rejects.toThrow(/at least one Insight Candidate/)
    await expect(reloaded.tool.execute({
      action: 'inspect', taskId: started.state.taskId, insightIds: ['I1', 'I1'],
    }, { agent: replayAgent, signal })).rejects.toThrow(/duplicate Insight Candidate IDs/)
    await expect(reloaded.tool.execute({
      action: 'inspect', taskId: started.state.taskId, insightIds: ['UNKNOWN'],
    }, { agent: replayAgent, signal })).rejects.toThrow(/unknown Insight Candidate UNKNOWN/)
    await expect(reloaded.tool.execute({
      action: 'inspect', taskId: started.state.taskId,
      insightIds: Array.from({ length: RavenPlugin.RAVEN_LIMITS.insightInspectionIds + 1 }, (_, index) => `I${index + 1}`),
    }, { agent: replayAgent, signal })).rejects.toThrow(/at most 8 Insight Candidates/)

    const exact = inspected.inspection?.candidates[0]
    if (exact === undefined) throw new Error('Expected inspected Candidate I1')
    const promoted = await reloaded.tool.execute({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'analyze', summary: 'Inspected Candidate promoted.',
      artifact: `${checkpoint.state.latestArtifact} ${exact.text}`,
      claims: [{
        claimId: 'A1', text: exact.text, kind: 'analysis', importance: 'material', disposition: 'qualified',
        sourceIds: [], insightId: exact.insightId, derivedFromClaimIds: exact.claimIds, assumptions: exact.assumptions,
      }],
    }, { agent: replayAgent, signal })
    const afterPromotion = await reloaded.tool.execute({
      action: 'status', taskId: started.state.taskId,
    }, { agent: replayAgent, signal })
    expect(promoted.state.claims.find(claim => claim.claimId === 'A1')?.insightId).toBe('I1')
    expect(afterPromotion.recall).toEqual({
      unpromotedInsightIds: ['I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9'],
      totalUnpromoted: 8,
      insightOffset: 0,
      nextInsightOffset: null,
    })
    const inspectedAgain = await reloaded.tool.execute({
      action: 'inspect', taskId: started.state.taskId, insightIds: ['I1'],
    }, { agent: replayAgent, signal })
    expect(inspectedAgain.inspection?.candidates[0]?.insightId).toBe('I1')
  })

  it('migrates a real schema-v1 web Task from session metadata and continues it', async () => {
    interface TestTool extends Record<string, unknown> {
      execute(args: unknown, exec: unknown): Promise<{ state: RavenPlugin.RavenTaskState; status: string }>
    }
    let tool: TestTool | undefined
    const fetch = async ({ url }: { url: string }) => ({
      url,
      statusCode: 200,
      body: { kind: 'text' as const, content: 'legacy exact excerpt' },
      truncated: false,
    })
    RavenPlugin.apply({
      tools: { register(definition: TestTool) { tool = definition; return vi.fn() } },
      systemPrompt: { section() { return vi.fn() } },
      inject() { return vi.fn() },
      get(name: string) { return name === 'web' ? { fetch } : undefined },
      on() { return vi.fn() },
    } as never, { sourceNetworkPolicy: 'unrestricted' })
    if (tool === undefined) throw new Error('Raven tool did not register')

    const taskId = 'rvn-123456789abc-1'
    const timestamp = '2026-08-16T16:00:00.000Z'
    const v1 = {
      schemaVersion: 1,
      taskId,
      ordinal: 1,
      outcome: 'research',
      request: 'Continue a legacy web research Task.',
      grounding: 'required',
      phase: 'active',
      revision: 1,
      steeringRevision: 0,
      steering: [],
      checkpoints: [],
      sources: [{
        sourceId: 'OLD1',
        url: 'HTTPS://EXAMPLE.TEST:443/legacy',
        title: 'Legacy Source',
        locator: 'Body',
        excerpt: 'legacy exact excerpt',
        role: 'primary',
        inspectedAt: timestamp,
        check: { status: 'reachable', checkedAt: timestamp, statusCode: 200, resolvedUrl: 'https://example.test/legacy' },
      }],
      claims: [{
        claimId: 'OLD-C1', text: 'Legacy evidence.', kind: 'external', importance: 'material',
        disposition: 'supported', sourceIds: ['OLD1'],
      }],
      limitations: [],
      latestArtifact: null,
      verification: null,
      finalArtifactSha256: null,
      startedAt: timestamp,
      updatedAt: timestamp,
    }
    const meta = { kind: 'dsh-raven-research/task-state', version: 1, state: v1 }
    const agent = { id: 'legacy-replay', session: { events: [{ type: 'tool/result', data: { meta } }] } }
    const signal = new AbortController().signal
    const restored = await tool.execute({ action: 'status', taskId }, { agent, signal })

    expect(restored.state.schemaVersion).toBe(RavenPlugin.RAVEN_SCHEMA_VERSION)
    expect(restored.state.sources[0]).toMatchObject({
      url: 'https://example.test/legacy',
      resource: { origin: 'web', uri: 'https://example.test/legacy' },
      representation: { format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'web_fetch' },
    })
    const checkpoint = await tool.execute({
      action: 'checkpoint', taskId, stage: 'verify', summary: 'Legacy evidence migrated.',
      artifact: 'Legacy evidence [@OLD1].',
    }, { agent, signal })
    expect(checkpoint.status).toBe('active')
    const completed = await tool.execute({
      action: 'complete', taskId, artifact: checkpoint.state.latestArtifact,
    }, { agent, signal })
    expect(completed.status).toBe('completed')
  })

  it('preserves prior Task identities when a later Task starts in the same session', async () => {
    interface TestValue {
      state: RavenPlugin.RavenTaskState
      status: string
    }
    interface TestTool extends Record<string, unknown> {
      execute(args: unknown, exec: unknown): Promise<TestValue>
      output: { presentationMeta(args: unknown, value: unknown): unknown }
    }
    const capture = () => {
      let tool: TestTool | undefined
      RavenPlugin.apply({
        tools: {
          register(definition: TestTool) {
            tool = definition
            return vi.fn()
          },
        },
        systemPrompt: { section() { return vi.fn() } },
        inject() { return vi.fn() },
        get() { return undefined },
        on() { return vi.fn() },
      } as never)
      if (tool === undefined) throw new Error('Raven tool did not register')
      return tool
    }

    const tool = capture()
    const signal = new AbortController().signal
    const events: unknown[] = []
    const agent = { id: 'multi-task-session', session: { events } }
    const run = async (args: unknown) => {
      const value = await tool.execute(args, { agent, signal })
      events.push({ type: 'tool/result', data: { meta: tool.output.presentationMeta(args, value) } })
      return value
    }

    const taskA = await run({
      action: 'start',
      outcome: 'learning',
      grounding: 'none',
      request: 'Teach topic A.',
    })
    const checkpointA = await run({
      action: 'checkpoint',
      taskId: taskA.state.taskId,
      stage: 'draft',
      summary: 'Topic A draft.',
      artifact: 'Topic A explanation.',
    })
    await run({ action: 'stop', taskId: taskA.state.taskId })

    const taskB = await run({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Write topic B.',
    })
    await run({
      action: 'checkpoint',
      taskId: taskB.state.taskId,
      stage: 'draft',
      summary: 'Topic B draft.',
      artifact: 'Topic B draft.',
    })
    await run({ action: 'stop', taskId: taskB.state.taskId })

    const resumedA = await run({ action: 'resume', taskId: taskA.state.taskId })
    expect(resumedA.state.taskId).toBe(taskA.state.taskId)
    expect(resumedA.state.checkpoints).toEqual(checkpointA.state.checkpoints)
    const inspectedB = await run({ action: 'status', taskId: taskB.state.taskId })
    expect(inspectedB.state.taskId).toBe(taskB.state.taskId)
    expect(inspectedB.state.phase).toBe('stopped')

    events.push({
      type: 'tool/result',
      data: { meta: tool.output.presentationMeta({}, taskA) },
    })
    events.push({
      type: 'tool/result',
      data: {
        meta: {
          kind: 'dsh-raven-research/task-state',
          version: 2,
          currentTaskId: 'rvn-dangling-999',
          state: inspectedB.state,
        },
      },
    })

    const reloaded = capture()
    const replayAgent = { id: 'multi-task-session', session: { events } }
    const restoredCurrent = await reloaded.execute({ action: 'status' }, { agent: replayAgent, signal })
    const restoredA = await reloaded.execute({ action: 'status', taskId: taskA.state.taskId }, { agent: replayAgent, signal })
    const restoredB = await reloaded.execute({ action: 'status', taskId: taskB.state.taskId }, { agent: replayAgent, signal })
    expect(restoredCurrent.state.taskId).toBe(taskA.state.taskId)
    expect(restoredA.state.taskId).toBe(taskA.state.taskId)
    expect(restoredA.state.checkpoints).toHaveLength(1)
    expect(restoredB.state.taskId).toBe(taskB.state.taskId)
    expect(restoredB.state.checkpoints).toHaveLength(1)
  })

  it('publishes durable Task state for a PTC mode sub-call that receives no result card', async () => {
    interface TestTool extends Record<string, unknown> {
      execute(args: unknown, exec: unknown): Promise<{
        state: RavenPlugin.RavenTaskState
        status: string
      }>
    }

    type DispatchLogListener = (
      dispatch: Record<string, unknown>,
      next: () => Promise<Array<Record<string, unknown>>>,
    ) => Promise<Array<Record<string, unknown>>>

    const capture = () => {
      let tool: TestTool | undefined
      let shapeLog: DispatchLogListener | undefined
      RavenPlugin.apply({
        tools: {
          register(definition: TestTool) {
            tool = definition
            return vi.fn()
          },
        },
        systemPrompt: { section() { return vi.fn() } },
        inject() { return vi.fn() },
        get() { return undefined },
        on(event: string, listener: unknown) {
          if (event === 'tools/ptc-dispatch-log') shapeLog = listener as DispatchLogListener
          return vi.fn()
        },
      } as never)
      if (tool === undefined || shapeLog === undefined) throw new Error('Raven did not register its PTC mode durability path')
      return { tool, shapeLog }
    }

    const { tool, shapeLog } = capture()
    const signal = new AbortController().signal
    const events: unknown[] = []
    const appended: unknown[] = []
    const agent = {
      id: 'ptc-mode-session',
      session: {
        events,
        append(type: string, data: unknown) {
          appended.push({ type, data: JSON.parse(JSON.stringify(data)) as unknown })
        },
      },
    }
    // The opaque token the Harness registry sets only for a nested dispatch.
    const parent = Symbol('run_code')
    const callId = 'root:code:1'

    const started = await tool.execute({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Write one short note.',
    }, { agent, signal })
    expect(appended).toHaveLength(0)

    await tool.execute({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A draft published from a program.',
      // A Task step whose Artifact closes an HTML comment must not corrupt the record.
      artifact: 'A draft written from a PTC mode program --> with a comment closer.',
    }, { agent, signal, parent, callId })
    // The record never rides a plugin-owned session event type: one would make the
    // whole persisted session unloadable on the Harness read path.
    expect(appended).toHaveLength(0)

    const rendered = [{ type: 'text', text: 'rendered sub-call content' }]
    const logged = await shapeLog(
      { agent, subCallId: callId, name: 'raven_task', isError: false, content: rendered },
      () => Promise.resolve(rendered),
    )
    expect(logged[0]).toEqual(rendered[0])
    expect(String(logged[1]?.text)).toContain('<!-- dsh-raven-research/task-state ')
    events.push({
      type: 'tool/code-dispatch',
      data: { name: 'raven_task', content: JSON.parse(JSON.stringify(logged)) as unknown },
    })

    const reloaded = capture()
    const restored = await reloaded.tool.execute({ action: 'status' }, {
      agent: { id: 'ptc-mode-session', session: { events } },
      signal,
    })
    expect(restored.state.taskId).toBe(started.state.taskId)
    expect(restored.state.checkpoints).toHaveLength(1)
    expect(restored.state.latestArtifact).toBe('A draft written from a PTC mode program --> with a comment closer.')

    // A log copy a spill policy replaced loses the step, never the session.
    const spilled = capture()
    const withoutRecord = await spilled.tool.execute({ action: 'status' }, {
      agent: {
        id: 'ptc-mode-session',
        session: {
          events: [{ type: 'tool/code-dispatch', data: { name: 'raven_task', content: [{ type: 'text', text: 'preview + locator' }] } }],
        },
      },
      signal,
    }).then(() => 'restored', (error: unknown) => (error as Error).message)
    expect(withoutRecord).toContain('No Raven Task exists in this session')

    const oversized = capture()
    const oversizedPayload = 'A'.repeat(Math.ceil((RavenPlugin.RAVEN_LIMITS.stateBytes + 4_096) * 4 / 3) + 100)
    const oversizedRecord = await oversized.tool.execute({ action: 'status' }, {
      agent: {
        id: 'ptc-mode-session',
        session: {
          events: [{
            type: 'tool/code-dispatch',
            data: {
              name: 'raven_task',
              content: [{
                type: 'text',
                text: `<!-- dsh-raven-research/task-state ${oversizedPayload} -->`,
              }],
            },
          }],
        },
      },
      signal,
    }).then(() => 'restored', (error: unknown) => (error as Error).message)
    expect(oversizedRecord).toContain('No Raven Task exists in this session')
  })

  it('keeps a nested sub-call working when the host exposes a read-only session view', async () => {
    interface TestTool extends Record<string, unknown> {
      execute(args: unknown, exec: unknown): Promise<{
        state: RavenPlugin.RavenTaskState
        status: string
      }>
    }

    let tool: TestTool | undefined
    RavenPlugin.apply({
      tools: {
        register(definition: TestTool) {
          tool = definition
          return vi.fn()
        },
      },
      systemPrompt: { section() { return vi.fn() } },
      inject() { return vi.fn() },
      get() { return undefined },
      on() { return vi.fn() },
    } as never)
    if (tool === undefined) throw new Error('Raven tool did not register')

    const started = await tool.execute({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Write one short note without a durable session view.',
    }, {
      agent: { id: 'read-only-session', session: { events: [] } },
      signal: new AbortController().signal,
      parent: Symbol('run_code'),
    })

    expect(started.state.phase).toBe('active')
  })

  it('adds a Task-aware recovery hint to a failed outcome and preserves every other one', async () => {
    interface TestTool extends Record<string, unknown> {
      execute(args: unknown, exec: unknown): Promise<{
        state: RavenPlugin.RavenTaskState
        status: string
      }>
      output: { presentationMeta(args: unknown, value: unknown): unknown }
      finalizeContent(exec: unknown, result: unknown): Array<{ type: string; text?: string }> | undefined
    }

    let tool: TestTool | undefined
    RavenPlugin.apply({
      tools: {
        register(definition: TestTool) {
          tool = definition
          return vi.fn()
        },
      },
      systemPrompt: { section() { return vi.fn() } },
      inject() { return vi.fn() },
      get() { return undefined },
      on() { return vi.fn() },
    } as never)
    if (tool === undefined) throw new Error('Raven tool did not register')

    const signal = new AbortController().signal
    const events: unknown[] = []
    const agent = { id: 'recovery-session', session: { events } }
    const started = await tool.execute({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Write one short note.',
    }, { agent, signal })
    events.push({ type: 'tool/result', data: { meta: tool.output.presentationMeta({}, started) } })

    const failure = { isError: true, content: [{ type: 'text', text: 'raven_task: invalid arguments' }] }
    const hinted = tool.finalizeContent({ agent, arguments: { action: 'not-an-action' } }, failure)
    expect(hinted?.[0]).toEqual(failure.content[0])
    expect(hinted?.[1]?.text).toContain('<raven_task_recovery>')
    expect(hinted?.[1]?.text).toContain(started.state.taskId)
    expect(hinted?.[1]?.text).toContain('instead of starting a replacement Task')

    // Success keeps the rendered content the output projection already produced.
    expect(tool.finalizeContent({ agent, arguments: {} }, {
      isError: false,
      content: [{ type: 'text', text: 'rendered' }],
    })).toBeUndefined()
    // Without an Agent there is no Task book, and without a Task there is nothing
    // the registry's own error text does not already say.
    expect(tool.finalizeContent({ arguments: {} }, failure)).toBeUndefined()
    expect(tool.finalizeContent({
      agent: { id: 'untouched-session', session: { events: [] } },
      arguments: {},
    }, failure)).toBeUndefined()
    // Totality: a hostile execution view degrades to preserving the content.
    expect(tool.finalizeContent({
      agent: { id: 'hostile-session', get session(): never { throw new Error('no session') } },
      arguments: {},
    }, failure)).toBeUndefined()
  })

  it('names the Task the failed call addressed rather than the current one', async () => {
    interface TestTool extends Record<string, unknown> {
      execute(args: unknown, exec: unknown): Promise<{
        state: RavenPlugin.RavenTaskState
        status: string
      }>
      finalizeContent(exec: unknown, result: unknown): Array<{ type: string; text?: string }> | undefined
    }

    let tool: TestTool | undefined
    RavenPlugin.apply({
      tools: {
        register(definition: TestTool) {
          tool = definition
          return vi.fn()
        },
      },
      systemPrompt: { section() { return vi.fn() } },
      inject() { return vi.fn() },
      get() { return undefined },
      on() { return vi.fn() },
    } as never)
    if (tool === undefined) throw new Error('Raven tool did not register')

    const signal = new AbortController().signal
    const agent = { id: 'two-task-session', session: { events: [] } }
    const first = await tool.execute({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Write note one.',
    }, { agent, signal })
    await tool.execute({ action: 'stop', taskId: first.state.taskId }, { agent, signal })
    const second = await tool.execute({
      action: 'start',
      outcome: 'learning',
      grounding: 'none',
      request: 'Teach one concept.',
    }, { agent, signal })

    const failure = { isError: true, content: [{ type: 'text', text: 'raven_task: invalid arguments' }] }
    const addressed = tool.finalizeContent({ agent, arguments: { taskId: first.state.taskId } }, failure)
    expect(addressed?.[1]?.text).toContain(first.state.taskId)
    expect(addressed?.[1]?.text).toContain('action=resume')
    const current = tool.finalizeContent({ agent, arguments: {} }, failure)
    expect(current?.[1]?.text).toContain(second.state.taskId)
  })

  it('renders Task export bytes with a fence longer than Artifact fences', async () => {
    interface TestTool extends Record<string, unknown> {
      execute(args: unknown, exec: unknown): Promise<{
        state: RavenPlugin.RavenTaskState
        status: string
        renderedArtifact?: string
        wiki?: unknown
      }>
      output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string }> }
    }
    let tool: TestTool | undefined
    RavenPlugin.apply({
      tools: { register(definition: TestTool) { tool = definition; return vi.fn() } },
      systemPrompt: { section() { return vi.fn() } },
      inject() { return vi.fn() },
      get() { return undefined },
      on() { return vi.fn() },
    } as never)
    if (tool === undefined) throw new Error('Raven tool did not register')
    const agent = { id: 'task-export-fence', session: { events: [] } }
    const signal = new AbortController().signal
    const artifact = '# Example\n\n```ts\nconst value = 1\n```'
    const started = await tool.execute({
      action: 'start', outcome: 'general-writing', grounding: 'none', structureMode: 'skip', request: 'Preserve code fences.',
    }, { agent, signal })
    const checkpoint = await tool.execute({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'draft', summary: 'Fenced example.', artifact,
    }, { agent, signal })
    const completed = await tool.execute({
      action: 'complete', taskId: checkpoint.state.taskId, artifact,
    }, { agent, signal })
    const exported = await tool.execute({
      action: 'export', taskId: completed.state.taskId, title: 'Fenced Example', tags: [], init: false,
    }, { agent, signal })
    const rendered = tool.output.render({}, exported)[0]?.text ?? ''

    expect(rendered).toContain('````markdown')
    expect(rendered).toContain('```ts\nconst value = 1\n```')
    expect(rendered).toContain('\n````')
    expect(rendered).toContain('Verification scope: final Artifact bytes')
  })
})
