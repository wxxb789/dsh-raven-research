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

    RavenPlugin.apply(ctx)

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
    expect(listeners.map(listener => listener.event)).toEqual(['agent/pre-step'])
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
})
