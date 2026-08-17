import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { apply } from '../../src/plugin.js'
import type { RavenTaskState } from '../../src/domain.js'

interface TestTool extends Record<string, unknown> {
  execute(args: unknown, exec: unknown): Promise<{
    status: string
    state: RavenTaskState
    issues: readonly string[]
    renderedArtifact?: string
  }>
}

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('Source provenance integration', () => {
  it('retrieves the Source body and rejects an excerpt that is not present before publishing', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<article><h1>Primary record</h1><p>Authoritative anchor &amp; exact wording.</p></article>')
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/record`

    let tool: TestTool | undefined
    apply({
      tools: {
        register(definition: TestTool) {
          tool = definition
          return () => undefined
        },
      },
      systemPrompt: { section() { return () => undefined } },
      get(name: string) {
        if (name !== 'web') return undefined
        return {
          async fetch(request: { url: string }, signal?: AbortSignal) {
            const response = await fetch(request.url, signal === undefined ? {} : { signal })
            return {
              url: response.url,
              statusCode: response.status,
              body: { kind: 'html' as const, content: await response.text() },
            }
          },
        }
      },
      on() { return () => undefined },
    } as never)
    if (tool === undefined) throw new Error('Raven tool did not register')
    const registeredTool = tool
    const signal = new AbortController().signal
    const agent = { id: 'provenance-session', session: { events: [] } }
    const run = (args: unknown) => registeredTool.execute(args, { agent, signal })

    const started = await run({
      action: 'start',
      outcome: 'research',
      request: 'Ground one claim in the local primary record.',
    })
    const invented = await run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A candidate with invented support.',
      artifact: 'The primary record supports this claim [@LOCAL1].',
      sources: [{
        sourceId: 'LOCAL1',
        url,
        title: 'Local primary record',
        locator: 'Primary record paragraph 1',
        excerpt: 'wording that does not occur in the source',
        role: 'primary',
      }],
      claims: [{
        claimId: 'LOCAL-C1',
        text: 'The primary record supports this claim.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['LOCAL1'],
      }],
    })
    expect(invented.status).toBe('needs-revision')
    expect(invented.state).toBe(started.state)
    expect(invented.issues.join(' ')).toContain('excerpt was not found')

    const grounded = await run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A candidate grounded in retrieved bytes.',
      artifact: 'The primary record contains exact wording [@LOCAL1].',
      sources: [{
        sourceId: 'LOCAL1',
        url,
        title: 'Local primary record',
        locator: 'Primary record paragraph 1',
        excerpt: 'Authoritative anchor & exact wording.',
        role: 'primary',
      }],
      claims: [{
        claimId: 'LOCAL-C1',
        text: 'The primary record contains exact wording.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['LOCAL1'],
      }],
    })
    expect(grounded.status).toBe('active')
    expect(grounded.state.sources[0]?.check.status).toBe('reachable')
    expect(grounded.renderedArtifact).toContain(`[Local primary record](${url})`)

    const completed = await run({
      action: 'complete',
      taskId: started.state.taskId,
      artifact: grounded.state.latestArtifact,
    })
    expect(completed.status).toBe('completed')
  })

  it('cancels a Checkpoint even when the web provider never settles', { timeout: 2_000 }, async () => {
    let tool: TestTool | undefined
    apply({
      tools: {
        register(definition: TestTool) {
          tool = definition
          return () => undefined
        },
      },
      systemPrompt: { section() { return () => undefined } },
      get(name: string) {
        return name === 'web'
          ? { fetch: () => new Promise<never>(() => undefined) }
          : undefined
      },
      on() { return () => undefined },
    } as never)
    if (tool === undefined) throw new Error('Raven tool did not register')
    const registeredTool = tool
    const controller = new AbortController()
    const agent = { id: 'cancel-session', session: { events: [] } }
    const started = await registeredTool.execute({
      action: 'start',
      outcome: 'research',
      request: 'Cancel a blocked provider.',
    }, { agent, signal: controller.signal })

    const pending = registeredTool.execute({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A blocked candidate.',
      artifact: 'Blocked source claim [@BLOCKED].',
      sources: [{
        sourceId: 'BLOCKED',
        url: 'https://example.test/never',
        title: 'Never-settling source',
        locator: 'Section 1',
        excerpt: 'never returned',
        role: 'primary',
      }],
      claims: [{
        claimId: 'BLOCKED-C1',
        text: 'Blocked source claim.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['BLOCKED'],
      }],
    }, { agent, signal: controller.signal })
    controller.abort(new Error('cancelled blocked provider'))

    await expect(pending).rejects.toThrow('cancelled blocked provider')
  })
})
