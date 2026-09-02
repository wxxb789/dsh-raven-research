import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  it('resolves a hidden inspectionCallId from a successful PTC read receipt', async () => {
    let tool: TestTool | undefined
    apply({
      tools: { register(definition: TestTool) { tool = definition; return () => undefined } },
      systemPrompt: { section() { return () => undefined } },
      inject() { return () => undefined },
      get() { return undefined },
      on() { return () => undefined },
    } as never, { sourceNetworkPolicy: 'unrestricted' })
    if (tool === undefined) throw new Error('Raven tool did not register')
    const events: unknown[] = []
    const agent = { id: 'ptc-inspection-session', session: { events } }
    const signal = new AbortController().signal
    const run = (args: unknown) => tool!.execute(args, { agent, signal })
    const sourcePath = resolve('ptc-fixture', 'note.md')
    const sourceUri = pathToFileURL(sourcePath).href
    const started = await run({
      action: 'start', outcome: 'research', request: 'Use a local Source inspected from PTC.',
      sourcePolicy: { localRoots: [pathToFileURL(dirname(sourcePath)).href] },
    })
    const subCallId = 'ptc-read:code:1'
    events.push({
      type: 'tool/code-dispatch-start',
      data: { subCallId, name: 'read', arguments: { file_path: 'note.md' } },
    }, {
      type: 'tool/code-dispatch',
      data: {
        subCallId, name: 'read', arguments: { file_path: 'note.md' }, isError: false,
        content: [{
          type: 'text',
          text: `<path>${sourcePath}</path>\n<type>file</type>\n<content>\n5: # Note\n6: \n7: Exact local evidence.\n\n(Output capped. Showing lines 5-7. Use offset=8 to continue.)\n</content>`,
        }],
      },
    })
    const artifact = 'The note provides local evidence [@LOCAL1].'
    const checkpoint = await run({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'read', summary: 'PTC local evidence.', artifact,
      sources: [{
        sourceId: 'LOCAL1', title: 'Local note', locator: 'line 7', excerpt: 'Exact local evidence.', role: 'user-provided',
        resource: { origin: 'local', uri: sourceUri },
        representation: {
          format: 'markdown', derivation: 'original', coverage: 'segment', producedBy: 'read',
          markdown: '# Note\n\nExact local evidence.',
        },
      }],
      claims: [{
        claimId: 'LOCAL-C1', text: 'The note provides local evidence.', kind: 'external', importance: 'material',
        disposition: 'supported', sourceIds: ['LOCAL1'],
      }],
    })

    expect(checkpoint.status).toBe('active')
    expect(checkpoint.state.sources[0]?.check.status).toBe('reachable')
    expect(checkpoint.state.sources[0]?.resource.mediaType).toBe('text/markdown')
    expect(checkpoint.state.sources[0]?.representation?.inspectionCallId).toBe(subCallId)
    expect(checkpoint.state.sources[0]?.representation?.markdown).toBe('# Note\n\nExact local evidence.')
    expect(checkpoint.state.sources[0]?.inspectionSha256).toMatch(/^sha256:[a-f0-9]{64}$/)

    const invalidCallId = 'ptc-read:code:2'
    events.push({
      type: 'tool/code-dispatch-start',
      data: { subCallId: invalidCallId, name: 'read', arguments: { file_path: 'note.md' } },
    }, {
      type: 'tool/code-dispatch',
      data: {
        subCallId: invalidCallId, name: 'read', arguments: { file_path: 'note.md' }, isError: false,
        content: [{
          type: 'text',
          text: `<path>${sourcePath}</path>\n<type>file</type>\n<content>\n5: # Note\n6: \n7: Invalid range.\n\n(Showing lines 5-7 of 6. Use offset=8 to continue.)\n</content>`,
        }],
      },
    })
    await expect(run({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'read', summary: 'Refuse malformed receipt.',
      artifact: 'The malformed window must not verify [@LOCAL2].',
      sources: [{
        sourceId: 'LOCAL2', title: 'Malformed local note', locator: 'line 7', excerpt: 'Invalid range.', role: 'user-provided',
        resource: { origin: 'local', uri: sourceUri, mediaType: 'text/markdown' },
        representation: {
          format: 'markdown', derivation: 'original', coverage: 'segment', producedBy: 'read', markdown: '# Note\n\nInvalid range.',
        },
      }],
      claims: [{
        claimId: 'LOCAL-C2', text: 'The malformed window must not verify.', kind: 'external', importance: 'material',
        disposition: 'supported', sourceIds: ['LOCAL2'],
      }],
    })).rejects.toThrow('must name its Harness inspectionCallId')
  })

  it('attests full Markdown from an exact PTC MCP read_resource receipt', async () => {
    let tool: TestTool | undefined
    apply({
      tools: { register(definition: TestTool) { tool = definition; return () => undefined } },
      systemPrompt: { section() { return () => undefined } },
      inject() { return () => undefined },
      get() { return undefined },
      on() { return () => undefined },
    } as never, { sourceNetworkPolicy: 'unrestricted' })
    if (tool === undefined) throw new Error('Raven tool did not register')
    const markdown = '# Audit\n\nEight organizations missed the recovery target.\n'
    const subCallId = 'ptc-mcp:code:1'
    const events: unknown[] = [{
      type: 'tool/code-dispatch-start',
      data: {
        subCallId,
        name: 'mcp__raven_eval__read_resource',
        arguments: { uri: 'mcp://raven_eval/audit' },
      },
    }, {
      type: 'tool/code-dispatch',
      data: {
        subCallId,
        name: 'mcp__raven_eval__read_resource',
        arguments: { uri: 'mcp://raven_eval/audit' },
        isError: false,
        content: [{ type: 'text', text: markdown }],
      },
    }]
    const agent = { id: 'ptc-mcp-session', session: { events } }
    const signal = new AbortController().signal
    const run = (args: unknown) => tool!.execute(args, { agent, signal })
    const started = await run({
      action: 'start', outcome: 'research', request: 'Use the MCP audit.',
      sourcePolicy: { includedMcpSources: ['raven_eval'] },
    })
    const checkpoint = await run({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'read', summary: 'MCP audit.',
      artifact: 'Eight organizations missed the target [@AUDIT].',
      sources: [{
        sourceId: 'AUDIT', title: 'Audit', locator: 'finding',
        excerpt: 'Eight organizations missed the recovery target.', role: 'primary',
        resource: {
          origin: 'MCP', uri: 'mcp://raven_eval/audit', sourceName: 'raven_eval', mediaType: 'text/markdown',
        },
        representation: {
          format: 'markdown', derivation: 'original', coverage: 'full',
          producedBy: 'mcp__raven_eval__read_resource', markdown: markdown.trimEnd(),
        },
      }],
      claims: [{
        claimId: 'AUDIT-C1', text: 'Eight organizations missed the target.', kind: 'external',
        importance: 'material', disposition: 'supported', sourceIds: ['AUDIT'],
      }],
    })

    expect(checkpoint.status).toBe('active')
    expect(checkpoint.state.sources[0]?.resource.origin).toBe('mcp')
    expect(checkpoint.state.sources[0]?.representation?.inspectionCallId).toBe(subCallId)
    expect(checkpoint.state.sources[0]?.representation?.markdown).toBe(markdown)
  })

  it('resolves omitted PTC inspection IDs for Workspace documents too', async () => {
    const registered = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>()
    apply({
      tools: { register(definition: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }) { registered.set(definition.name, definition); return () => undefined } },
      systemPrompt: { section() { return () => undefined } },
      inject() { return () => undefined },
      get() { return undefined },
      on() { return () => undefined },
    } as never, { sourceNetworkPolicy: 'unrestricted' })
    const workspace = registered.get('raven_workspace')
    if (workspace === undefined) throw new Error('Raven Workspace tool did not register')
    const subCallId = 'ptc-workspace-read:code:1'
    const documentPath = resolve('ptc-fixture', 'document.md')
    const documentUri = pathToFileURL(documentPath).href
    const events = [{
      type: 'tool/code-dispatch-start',
      data: { subCallId, name: 'read', arguments: { file_path: 'document.md' } },
    }, {
      type: 'tool/code-dispatch',
      data: {
        subCallId, name: 'read', arguments: { file_path: 'document.md' }, isError: false,
        content: [{
          type: 'text',
          text: `<path>${documentPath}</path>\n<type>file</type>\n<content>\n1: # Document\n2: \n3: Durable workspace evidence.\n\n(End of file - total 3 lines)\n</content>`,
        }],
      },
    }]
    const result = await workspace.execute({
      action: 'adopt', kind: 'folder', files: [], documents: [{
        title: 'Document',
        resource: { origin: 'local', uri: documentUri, mediaType: 'text/markdown' },
        representation: {
          format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read',
          markdown: '# Document\n\nDurable workspace evidence.',
        },
      }],
    }, { agent: { id: 'workspace-ptc', session: { events } }, signal: new AbortController().signal }) as {
      status: string
      pages: Array<{ content: string }>
    }

    expect(result.status).toBe('ready')
    expect(result.pages.some(page => page.content.includes(`inspection_call_id: "${subCallId}"`))).toBe(true)
  })

  it('treats a truncated retrieval as unverifiable rather than as a fabricated quotation', async () => {
    let tool: TestTool | undefined
    apply({
      tools: {
        register(definition: TestTool) {
          tool = definition
          return () => undefined
        },
      },
      systemPrompt: { section() { return () => undefined } },
      inject() { return () => undefined },
      get(name: string) {
        if (name !== 'web') return undefined
        return {
          // The Harness contract exposes `truncated`; the tail of the document never arrived.
          async fetch(request: { url: string }) {
            return {
              url: request.url,
              statusCode: 200,
              body: { kind: 'text' as const, content: 'The opening section only.' },
              truncated: true,
            }
          },
        }
      },
      on() { return () => undefined },
    } as never, { sourceNetworkPolicy: 'unrestricted' })
    if (tool === undefined) throw new Error('Raven tool did not register')
    const registeredTool = tool
    const signal = new AbortController().signal
    const agent = { id: 'truncated-session', session: { events: [] } }
    const run = (args: unknown) => registeredTool.execute(args, { agent, signal })

    const started = await run({
      action: 'start',
      outcome: 'research',
      request: 'Cite a passage beyond the truncation point.',
    })
    const attempt = await run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Passage from the unretrieved tail.',
      artifact: 'The concluding section states the result [@TRUNC1].',
      sources: [{
        sourceId: 'TRUNC1',
        url: 'https://example.test/long-document',
        title: 'Long document',
        locator: 'Concluding section',
        excerpt: 'the concluding section states the result',
        role: 'primary',
      }],
      claims: [{
        claimId: 'TRUNC-C1',
        text: 'The concluding section states the result.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['TRUNC1'],
      }],
    })

    // Still blocked, because it genuinely could not be verified...
    expect(attempt.status).toBe('needs-revision')
    const issues = attempt.issues.join(' ')
    expect(issues).toContain('truncated')
    // ...but never accused of fabrication, which is an evidence defect, not a retrieval limit.
    expect(issues).not.toContain('fabricated')
  })

  it('matches excerpts across inline markup and preserves block boundaries', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end([
        '<article>',
        '<p>The <em>pre</em><strong>cise</strong> figure is 50<sup>th</sup> percentile.</p>',
        '<p>研究<span>表明</span>该机制有效。</p>',
        '<p>第一条 前段结束。</p><p>第二条 后段开始。</p>',
        '</article>',
      ].join(''))
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/inline`

    let tool: TestTool | undefined
    apply({
      tools: {
        register(definition: TestTool) {
          tool = definition
          return () => undefined
        },
      },
      systemPrompt: { section() { return () => undefined } },
      inject() { return () => undefined },
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
    } as never, { sourceNetworkPolicy: 'unrestricted' })
    if (tool === undefined) throw new Error('Raven tool did not register')
    const registeredTool = tool
    const signal = new AbortController().signal
    const agent = { id: 'inline-session', session: { events: [] } }
    const run = (args: unknown) => registeredTool.execute(args, { agent, signal })

    const started = await run({
      action: 'start',
      outcome: 'research',
      request: 'Match excerpts that inline markup splits.',
    })

    const source = (sourceId: string, path: string, excerpt: string) => ({
      sourceId,
      url: `${url}/${path}`,
      title: 'Inline markup record',
      locator: 'Body',
      excerpt,
      role: 'primary',
    })
    const claim = (claimId: string, sourceId: string) => ({
      claimId,
      text: `Inline markup does not break anchor ${sourceId}.`,
      kind: 'external',
      importance: 'material',
      disposition: 'supported',
      sourceIds: [sourceId],
    })

    const published = await run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Anchors that inline markup splits.',
      artifact: [
        'A tag splitting a Latin word must not inject a false space [@INLINE1].',
        'CJK has no word spaces, so any inline span would break a naive extractor [@INLINE2].',
        'Adjacent block elements must still produce a separator [@INLINE3].',
      ].join(' '),
      sources: [
        source('INLINE1', 'latin', 'The precise figure is 50th percentile.'),
        source('INLINE2', 'cjk', '研究表明该机制有效。'),
        source('INLINE3', 'blocks', '前段结束。 第二条'),
      ],
      claims: [claim('INLINE-C1', 'INLINE1'), claim('INLINE-C2', 'INLINE2'), claim('INLINE-C3', 'INLINE3')],
    })

    expect(published.issues).toEqual([])
    expect(published.status).toBe('active')
    expect(published.state.sources.map(item => item.check.status)).toEqual(['reachable', 'reachable', 'reachable'])
  })

  it('reports the nearest source passage when a recorded excerpt drifts', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<p>The system acknowledges the write before returning</p>')
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/drift`

    let tool: TestTool | undefined
    apply({
      tools: {
        register(definition: TestTool) {
          tool = definition
          return () => undefined
        },
      },
      systemPrompt: { section() { return () => undefined } },
      inject() { return () => undefined },
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
    } as never, { sourceNetworkPolicy: 'unrestricted' })
    if (tool === undefined) throw new Error('Raven tool did not register')
    const registeredTool = tool
    const signal = new AbortController().signal
    const agent = { id: 'drift-session', session: { events: [] } }
    const run = (args: unknown) => registeredTool.execute(args, { agent, signal })

    const started = await run({
      action: 'start',
      outcome: 'research',
      request: 'Repair a drifted anchor.',
    })

    // Model-added terminal punctuation is a repairable anchor defect, not a fabrication.
    const drifted = await run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Anchor with added punctuation.',
      artifact: 'The write is durable before acknowledgement [@DRIFT1].',
      sources: [{
        sourceId: 'DRIFT1',
        url,
        title: 'Drift record',
        locator: 'Body',
        excerpt: 'The system acknowledges the write before returning.',
        role: 'primary',
      }],
      claims: [{
        claimId: 'DRIFT-C1',
        text: 'The write is durable before acknowledgement.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['DRIFT1'],
      }],
    })

    expect(drifted.status).toBe('needs-revision')
    const issues = drifted.issues.join(' ')
    expect(issues).toContain('DRIFT1')
    expect(issues).toContain('nearest retrieved passage')
    expect(issues).toContain('acknowledges the write before returning')
  })

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
      inject() { return () => undefined },
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
    } as never, { sourceNetworkPolicy: 'unrestricted' })
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
    // The refusal publishes nothing: no Checkpoint, no Artifact. It no longer
    // discards the evidence submitted alongside it — the recorded Source and its
    // failed check survive so the agent can repair the anchor against what Raven
    // actually retrieved, rather than resubmitting blind.
    expect(invented.state.checkpoints).toEqual([])
    expect(invented.state.latestArtifact).toBeNull()
    expect(invented.state.sources[0]?.check.status).toBe('failed')
    expect(invented.issues.join(' ')).toContain('diverges from the retrieved source')

    // The grounded path is proved on a FRESH Task rather than by repairing this
    // one. Repairing in place is currently impossible: the refused Source is now
    // retained, an existing Source ID may not have its excerpt rewritten behind it,
    // and its URL may not be re-registered under a new ID — so a mistyped excerpt
    // makes that URL uncitable for the rest of the Task. That interaction belongs to
    // the engine's evidence rules, and this file does not encode a repair contract
    // that is still being decided.
    await run({ action: 'stop', taskId: started.state.taskId })
    const secondTask = await run({
      action: 'start',
      outcome: 'research',
      request: 'Ground one claim in the local primary record, correctly this time.',
    })
    const grounded = await run({
      action: 'checkpoint',
      taskId: secondTask.state.taskId,
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
      taskId: secondTask.state.taskId,
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
      inject() { return () => undefined },
      get(name: string) {
        return name === 'web'
          ? { fetch: () => new Promise<never>(() => undefined) }
          : undefined
      },
      on() { return () => undefined },
    } as never, { sourceNetworkPolicy: 'unrestricted' })
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