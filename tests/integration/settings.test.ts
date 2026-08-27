import { describe, expect, it } from 'vitest'

import { Config, RAVEN_SETTINGS_NAMESPACE } from '../../src/config.js'
import { apply } from '../../src/plugin.js'
import type { RavenTaskState } from '../../src/domain.js'

interface TestTool extends Record<string, unknown> {
  execute(args: unknown, exec: unknown): Promise<{
    status: string
    state: RavenTaskState
    issues: readonly string[]
  }>
}

interface Registration {
  ns: unknown
  schema: unknown
  options: { base?: unknown }
}

interface MountOptions {
  entry?: Record<string, unknown>
  /** Present when a settings service attaches; returns the resolved section. */
  resolved?: () => Record<string, unknown>
  fetch?: (request: { url: string }, signal?: AbortSignal) => Promise<unknown>
  /** A host-registered settings provider visible to a split agent-role mount. */
  settings?: unknown
}

function mount(options: MountOptions) {
  let tool: TestTool | undefined
  const injected: Array<readonly string[]> = []
  const registrations: Registration[] = []
  apply({
    tools: {
      register(definition: TestTool) {
        tool = definition
        return () => undefined
      },
    },
    systemPrompt: { section() { return () => undefined } },
    inject(dependencies: readonly string[], callback: (scoped: unknown) => void) {
      injected.push(dependencies)
      // No settings service in this deployment: the gate never opens.
      if (options.resolved === undefined) return () => undefined
      callback({
        settings: {
          register(ns: unknown, schema: unknown, registerOptions: { base?: unknown }) {
            registrations.push({ ns, schema, options: registerOptions })
            return {
              get: () => ({ sourceNetworkPolicy: 'unrestricted', ...options.resolved?.() }),
              watch: () => undefined,
            }
          },
        },
        effect: () => undefined,
      })
      return () => undefined
    },
    get(name: string) {
      if (name === 'settings') return options.settings
      if (name !== 'web' || options.fetch === undefined) return undefined
      return { fetch: options.fetch }
    },
    on() { return () => undefined },
  } as never, { sourceNetworkPolicy: 'unrestricted', ...options.entry } as never)
  if (tool === undefined) throw new Error('Raven tool did not register')
  return { tool, injected, registrations }
}

const SOURCE = {
  sourceId: 'S1',
  url: 'https://evidence.test/source',
  title: 'Settings evidence',
  locator: 'Durability',
  excerpt: 'durable before acknowledgement',
  role: 'primary',
}

const CLAIM = {
  claimId: 'C1',
  text: 'The source documents durable acknowledgement.',
  kind: 'external',
  importance: 'material',
  disposition: 'supported',
  sourceIds: ['S1'],
}

const reachable = async (request: { url: string }) => ({
  url: request.url,
  statusCode: 200,
  body: { kind: 'text' as const, content: 'durable before acknowledgement' },
  truncated: false,
})

async function checkpointOne(tool: TestTool, agentId: string) {
  const signal = new AbortController().signal
  const agent = { id: agentId, session: { events: [] } }
  const started = await tool.execute({
    action: 'start',
    outcome: 'research',
    request: 'Check one Source under deployment settings.',
  }, { agent, signal })
  const checkpoint = await tool.execute({
    action: 'checkpoint',
    taskId: started.state.taskId,
    stage: 'draft',
    summary: 'A source-grounded draft.',
    artifact: 'The source documents durable acknowledgement [@S1].',
    sources: [SOURCE],
    claims: [CLAIM],
  }, { agent, signal })
  return { agent, signal, started, checkpoint }
}

describe('Raven settings surface', () => {
  it('registers its own namespace with the composition entry as the base layer', () => {
    const { injected, registrations } = mount({
      entry: { sourceVerification: 'structural-only' },
      resolved: () => ({ sourceVerification: 'structural-only', sourceCheckTimeoutMs: 0 }),
    })

    expect(injected).toEqual([['settings']])
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.ns).toBe(RAVEN_SETTINGS_NAMESPACE)
    expect(registrations[0]?.schema).toBe(Config)
    expect(registrations[0]?.options.base).toEqual({
      sourceNetworkPolicy: 'unrestricted',
      sourceVerification: 'structural-only',
    })
  })

  it('keeps working on the composition entry when no settings service is composed', async () => {
    let fetches = 0
    const { tool, registrations } = mount({
      entry: { sourceVerification: 'structural-only' },
      fetch: async (request) => {
        fetches += 1
        return reachable(request)
      },
    })

    expect(registrations).toHaveLength(0)
    const { checkpoint } = await checkpointOne(tool, 'entry-only-session')
    expect(fetches).toBe(0)
    expect(checkpoint.issues.join(' ')).toContain('structural-only')
  })

  it('never lets a withheld check pass as confirmed evidence', async () => {
    let fetches = 0
    const { tool } = mount({
      resolved: () => ({ sourceVerification: 'structural-only' }),
      fetch: async (request) => {
        fetches += 1
        return reachable(request)
      },
    })

    // Withholding the network is a decision about reach, never a licence to
    // publish a Source nobody inspected: the Checkpoint is refused, with the
    // policy named so the reason is not mistaken for a broken link.
    const { checkpoint } = await checkpointOne(tool, 'structural-only-session')
    expect(fetches).toBe(0)
    expect(checkpoint.status).toBe('needs-revision')
    expect(checkpoint.issues.join(' ')).toContain('structural-only')
  })

  it('applies a committed settings change to the next Source check without a restart', async () => {
    let mode = 'remote'
    let fetches = 0
    const { tool } = mount({
      resolved: () => ({ sourceVerification: mode }),
      fetch: async (request) => {
        fetches += 1
        return reachable(request)
      },
    })

    const { agent, signal, started, checkpoint } = await checkpointOne(tool, 'live-change-session')
    expect(fetches).toBe(1)
    expect(checkpoint.state.sources[0]?.check.status).toBe('reachable')

    mode = 'structural-only'
    const later = await tool.execute({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'refine',
      summary: 'A refined draft under the new policy.',
      artifact: 'The source documents durable acknowledgement [@S1].',
    }, { agent, signal })

    expect(fetches).toBe(1)
    expect(later.state.sources[0]?.check.status).toBe('unavailable')
  })

  it('applies the host namespace user layer to a split agent-role mount', async () => {
    let fetches = 0
    const settings = {
      describe: () => [{
        ns: RAVEN_SETTINGS_NAMESPACE,
        user: { sourceVerification: 'structural-only' },
      }],
    }
    const { tool, registrations } = mount({
      entry: { role: 'agent', sourceVerification: 'remote' },
      settings,
      fetch: async (request) => {
        fetches += 1
        return reachable(request)
      },
    })

    expect(registrations).toHaveLength(0)
    const { checkpoint } = await checkpointOne(tool, 'split-settings-session')
    expect(fetches).toBe(0)
    expect(checkpoint.issues.join(' ')).toContain('structural-only')
  })

  it('turns a stalled Source check into a bounded failure at the configured deadline', async () => {
    const { tool } = mount({
      resolved: () => ({ sourceVerification: 'remote', sourceCheckTimeoutMs: 25 }),
      fetch: (_request, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
      }),
    })

    const { checkpoint } = await checkpointOne(tool, 'deadline-session')
    expect(checkpoint.status).toBe('needs-revision')
    expect(checkpoint.issues.join(' ')).toContain('exceeded the configured 25ms deadline')
  })
})
