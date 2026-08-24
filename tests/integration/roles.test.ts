import { describe, expect, it, vi } from 'vitest'

import { Config, RAVEN_SETTINGS_NAMESPACE } from '../../src/config.js'
import * as RavenPlugin from '../../src/index.js'

const signal = new AbortController().signal

interface RoleTool extends Record<string, unknown> {
  execute(args: unknown, exec: unknown): Promise<{ state: RavenPlugin.RavenTaskState; status: string }>
}

type DispatchLogListener = (
  dispatch: Record<string, unknown>,
  next: () => Promise<Array<Record<string, unknown>>>,
) => Promise<Array<Record<string, unknown>>>

interface Registration {
  ns: unknown
  schema: unknown
  options: { base?: unknown }
}

interface Mount {
  tools: Array<Record<string, unknown>>
  sections: Array<Record<string, unknown>>
  events: string[]
  registrations: Registration[]
  warnings: string[]
  release: () => void
  tool?: RoleTool
  shapeLog?: DispatchLogListener
}

/**
 * One Raven mount, observed through exactly the seams the existing integration
 * tests use: `tools.register`, `systemPrompt.section`, `ctx.on`, the settings
 * gate opened through `ctx.inject`, and `ctx.logger` for the double-mount warning.
 * `effect` is captured so a test can release a mount and keep the process-wide
 * per-role mount count honest for the next case.
 */
function mount(entry?: Record<string, unknown>): Mount {
  const state: Mount = {
    tools: [],
    sections: [],
    events: [],
    registrations: [],
    warnings: [],
    release: () => undefined,
  }
  RavenPlugin.apply({
    tools: {
      register(definition: RoleTool) {
        state.tools.push(definition as Record<string, unknown>)
        state.tool = definition
        return vi.fn()
      },
    },
    systemPrompt: {
      section(definition: Record<string, unknown>) {
        state.sections.push(definition)
        return vi.fn()
      },
    },
    inject(_dependencies: readonly string[], callback: (scoped: unknown) => void) {
      callback({
        settings: {
          register(ns: unknown, schema: unknown, options: { base?: unknown }) {
            state.registrations.push({ ns, schema, options })
            return { get: () => entry ?? {}, watch: () => undefined }
          },
        },
        effect: () => undefined,
      })
      return vi.fn()
    },
    get() { return undefined },
    on(event: string, listener: unknown) {
      state.events.push(event)
      if (event === 'tools/code-dispatch-log') state.shapeLog = listener as DispatchLogListener
      return vi.fn()
    },
    logger(_label: string) {
      return { warn: (text: string) => { state.warnings.push(text) } }
    },
    effect(callback: () => () => void) {
      state.release = callback()
      return vi.fn()
    },
  } as never, entry as never)
  return state
}

/** The observable registration shape of a mount, for identity comparisons. */
function shape(target: Mount) {
  return {
    tools: target.tools.map(definition => definition.name),
    sections: target.sections.map(definition => definition.name),
    events: target.events,
    namespaces: target.registrations.length,
  }
}

describe('Raven mount roles', () => {
  it('registers only the settings namespace for a host row', () => {
    const host = mount({ role: 'host' })
    try {
      expect(host.registrations).toHaveLength(1)
      expect(host.registrations[0]?.ns).toBe(RAVEN_SETTINGS_NAMESPACE)
      expect(host.registrations[0]?.schema).toBe(Config)
      // No agent surface at all: no tool, no prompt section, no listener.
      expect(host.tools).toHaveLength(0)
      expect(host.sections).toHaveLength(0)
      expect(host.events).toEqual([])
    } finally {
      host.release()
    }
  })

  it('registers only the agent surface for an agent row', () => {
    const agent = mount({ role: 'agent' })
    try {
      expect(agent.tools.map(definition => definition.name)).toEqual(['raven_task'])
      expect(agent.sections).toEqual([expect.objectContaining({ name: 'tool:raven-task', order: 116 })])
      expect(agent.events).toEqual(['tools/code-dispatch-log', 'agent/pre-step'])
      // The settings namespace belongs to the long-lived host plane, never to a
      // preset row that exists only while one session is alive.
      expect(agent.registrations).toHaveLength(0)
    } finally {
      agent.release()
    }
  })

  it('treats an omitted role, an explicit "both", and today\'s behaviour as one shape', () => {
    const omitted = mount()
    const both = mount({ role: 'both' })
    try {
      expect(shape(omitted)).toEqual(shape(both))
      expect(shape(both)).toEqual({
        tools: ['raven_task'],
        sections: ['tool:raven-task'],
        events: ['tools/code-dispatch-log', 'agent/pre-step'],
        namespaces: 1,
      })
    } finally {
      omitted.release()
      both.release()
    }
  })

  it('accepts a host row beside an agent row without a double-mount warning', () => {
    const host = mount({ role: 'host' })
    const agent = mount({ role: 'agent' })
    try {
      // Exactly one of each surface across the pair: the split is complete and
      // registers nothing twice.
      expect(host.tools.length + agent.tools.length).toBe(1)
      expect(host.registrations.length + agent.registrations.length).toBe(1)
      expect(host.sections.length + agent.sections.length).toBe(1)
      expect([...host.warnings, ...agent.warnings].filter(text => text.includes('is mounted'))).toEqual([])
    } finally {
      host.release()
      agent.release()
    }
  })

  it('warns and names the role when the SAME role is mounted twice', () => {
    const firstAgent = mount({ role: 'agent' })
    const secondAgent = mount({ role: 'agent' })
    try {
      // An agent-role mount emits no deployment-capability advice at all: that is
      // host-plane information, so every warning it can produce is a mount warning.
      expect(firstAgent.warnings).toEqual([])
      const agentWarning = secondAgent.warnings.join(' ')
      expect(agentWarning).toContain('role "agent"')
      expect(agentWarning).toContain('2 times')
      expect(agentWarning).toContain('raven_task tool is registered')
    } finally {
      firstAgent.release()
      secondAgent.release()
    }

    const firstHost = mount({ role: 'host' })
    const secondHost = mount({ role: 'host' })
    try {
      expect(firstHost.warnings.filter(text => text.includes('is mounted'))).toEqual([])
      const hostWarning = secondHost.warnings.filter(text => text.includes('is mounted')).join(' ')
      expect(hostWarning).toContain('role "host"')
      expect(hostWarning).toContain('settings namespace')
      // The agent-only half of the message has no business in a host collision.
      expect(hostWarning).not.toContain('raven_task tool is registered')
    } finally {
      firstHost.release()
      secondHost.release()
    }
  })

  it('keeps the Code Mode durability seam on an agent-role mount', async () => {
    // Event admission extends UP the scope chain, so a listener registered inside an
    // agent scope receives the sub-dispatches of its OWN agent. The durability seam
    // therefore does not need the host plane, and this walks the same listener path
    // the plugin integration tests use.
    const agent = mount({ role: 'agent' })
    try {
      const tool = agent.tool
      const shapeLog = agent.shapeLog
      if (tool === undefined || shapeLog === undefined) {
        throw new Error('an agent-role mount did not register its Code Mode durability path')
      }

      const events: unknown[] = []
      const session = { id: 'agent-role-session', session: { events } }
      const parent = Symbol('run_code')
      const callId = 'root:code:1'

      const started = await tool.execute({
        action: 'start',
        outcome: 'general-writing',
        grounding: 'none',
        request: 'Write one note from an agent-role mount.',
      }, { agent: session, signal })
      await tool.execute({
        action: 'checkpoint',
        taskId: started.state.taskId,
        stage: 'draft',
        summary: 'A draft published from a program.',
        artifact: 'A draft written under an agent-role mount.',
      }, { agent: session, signal, parent, callId })

      const rendered = [{ type: 'text', text: 'rendered sub-call content' }]
      const logged = await shapeLog(
        { agent: session, subCallId: callId, name: 'raven_task', isError: false, content: rendered },
        () => Promise.resolve(rendered),
      )
      expect(logged[0]).toEqual(rendered[0])
      expect(String(logged[1]?.text)).toContain('<!-- dsh-raven-research/task-state ')

      events.push({
        type: 'tool/code-dispatch',
        data: { name: 'raven_task', content: JSON.parse(JSON.stringify(logged)) as unknown },
      })

      // A SECOND agent-role mount is a separate plugin instance with its own
      // in-memory Task book, and recovers the Task from the durable log alone.
      const reloaded = mount({ role: 'agent' })
      try {
        const restored = await (reloaded.tool as RoleTool).execute({ action: 'status' }, {
          agent: { id: 'agent-role-session', session: { events } },
          signal,
        })
        expect(restored.state.taskId).toBe(started.state.taskId)
        expect(restored.state.latestArtifact).toBe('A draft written under an agent-role mount.')
      } finally {
        reloaded.release()
      }
    } finally {
      agent.release()
    }
  })
})
