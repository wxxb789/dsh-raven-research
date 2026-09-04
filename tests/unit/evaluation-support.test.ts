import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { apply } from '../../scripts/evaluation-support.js'

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>): Promise<string>
}

describe('evaluation fixture provider', () => {
  it('serves the same frozen web and MCP bytes without network access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-eval-provider-'))
    await mkdir(join(root, 'sources'))
    await Promise.all([
      writeFile(join(root, 'sources', 'web.md'), '# Web record\n\nFrozen web evidence.\n'),
      writeFile(join(root, 'sources', 'mcp.md'), '# MCP record\n\nFrozen MCP evidence.\n'),
    ])
    let searchProvider: { search(request: { query: string }): Promise<unknown> } | undefined
    let fetchProvider: { fetch(request: { url: string }): Promise<unknown> } | undefined
    let mcpTool: RegisteredTool | undefined
    const ctx = {
      web: {
        registerSearchProvider(provider: typeof searchProvider) { searchProvider = provider },
        registerFetchProvider(provider: typeof fetchProvider) { fetchProvider = provider },
      },
      tools: {
        register(tool: RegisteredTool) { mcpTool = tool },
      },
    }

    const ledgerPath = join(root, 'calls.jsonl')
    apply(ctx as never, {
      sourceRoot: root,
      ledgerPath,
      sources: [
        {
          id: 'web-record', origin: 'web', uri: 'https://example.com/raven-eval/web-record',
          title: 'Web record', path: 'sources/web.md', searchTerms: ['retention', 'implementation risk'],
        },
        {
          id: 'mcp-record', origin: 'mcp', uri: 'mcp://raven_eval/mcp-record',
          title: 'MCP record', path: 'sources/mcp.md', searchTerms: [],
        },
      ],
    })

    expect(await fetchProvider?.fetch({ url: 'https://example.com/raven-eval/web-record' })).toMatchObject({
      statusCode: 200,
      body: { kind: 'text', content: '# Web record\n\nFrozen web evidence.\n' },
      truncated: false,
    })
    expect(await searchProvider?.search({ query: 'retention requirements' })).toEqual({
      sources: [{ url: 'https://example.com/raven-eval/web-record', title: 'Web record' }],
      truncated: false,
    })
    expect(mcpTool?.name).toBe('mcp__raven_eval__read_resource')
    expect(await mcpTool?.execute({ uri: 'mcp://raven_eval/mcp-record' })).toBe('# MCP record\n\nFrozen MCP evidence.\n')
    const calls = (await readFile(ledgerPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string })
    expect(calls.map(call => call.kind)).toEqual(['fetch', 'search', 'mcp'])
  })

  it('fails closed on unknown resources and paths outside the fixture root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-eval-provider-'))
    const ctx = {
      web: { registerSearchProvider: vi.fn(), registerFetchProvider: vi.fn() },
      tools: { register: vi.fn() },
    }

    expect(() => apply(ctx as never, {
      sourceRoot: root,
      sources: [{
        id: 'escape', origin: 'web', uri: 'https://example.com/raven-eval/escape',
        title: 'Escape', path: '../secret.md', searchTerms: [],
      }],
    })).toThrow(/escapes sourceRoot/)
  })
})
