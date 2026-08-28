import { describe, expect, it, vi } from 'vitest'

import * as RavenPlugin from '../../src/index.js'

describe('Raven Cordis plugin', () => {
  it('registers one scoped tool and one concise prompt section with named exports', () => {
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

    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('raven_task')
    const parameters = tools[0]?.parameters as { properties: Record<string, { description?: string }> }
    expect(parameters.properties.artifact?.description).toContain(String(RavenPlugin.RAVEN_LIMITS.artifactChars))
    expect(parameters.properties.sources?.description).toContain(String(RavenPlugin.RAVEN_LIMITS.sources))
    const sourceItems = (parameters.properties.sources as unknown as {
      items: { properties: Record<string, { description?: string }> }
    }).items
    const claimItems = (parameters.properties.claims as unknown as {
      items: { properties: Record<string, { description?: string }> }
    }).items
    const failureItems = (parameters.properties.failures as unknown as {
      items: { properties: Record<string, { description?: string }> }
    }).items
    expect(sourceItems.properties.excerpt?.description).toContain(String(RavenPlugin.RAVEN_LIMITS.sourceExcerptChars))
    expect(claimItems.properties.text?.description).toContain(String(RavenPlugin.RAVEN_LIMITS.claimTextChars))
    expect(failureItems.properties.detail?.description).toContain(String(RavenPlugin.RAVEN_LIMITS.limitationDetailChars))
    expect(sections).toEqual([
      expect.objectContaining({ name: 'tool:raven-task', order: 116 }),
    ])
    expect(String(sections[0]?.text)).toContain('one continuing Raven Task')
    expect(listeners.map(listener => listener.event)).toEqual(['tools/code-dispatch-log', 'agent/pre-step'])
    expect(parameters.properties.queries?.description).toContain('Leads, never Sources')
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

    expect(restored.state.schemaVersion).toBe(2)
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

  it('publishes durable Task state for a Code Mode sub-call that receives no result card', async () => {
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
          if (event === 'tools/code-dispatch-log') shapeLog = listener as DispatchLogListener
          return vi.fn()
        },
      } as never)
      if (tool === undefined || shapeLog === undefined) throw new Error('Raven did not register its Code Mode durability path')
      return { tool, shapeLog }
    }

    const { tool, shapeLog } = capture()
    const signal = new AbortController().signal
    const events: unknown[] = []
    const appended: unknown[] = []
    const agent = {
      id: 'code-mode-session',
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
      artifact: 'A draft written from a Code Mode program --> with a comment closer.',
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
      agent: { id: 'code-mode-session', session: { events } },
      signal,
    })
    expect(restored.state.taskId).toBe(started.state.taskId)
    expect(restored.state.checkpoints).toHaveLength(1)
    expect(restored.state.latestArtifact).toBe('A draft written from a Code Mode program --> with a comment closer.')

    // A log copy a spill policy replaced loses the step, never the session.
    const spilled = capture()
    const withoutRecord = await spilled.tool.execute({ action: 'status' }, {
      agent: {
        id: 'code-mode-session',
        session: {
          events: [{ type: 'tool/code-dispatch', data: { name: 'raven_task', content: [{ type: 'text', text: 'preview + locator' }] } }],
        },
      },
      signal,
    }).then(() => 'restored', (error: unknown) => (error as Error).message)
    expect(withoutRecord).toContain('No Raven Task exists in this session')
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
})
