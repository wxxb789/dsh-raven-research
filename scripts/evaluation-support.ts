import { appendFile, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-web'

export const name = 'raven-evaluation-support'
export const inject = ['web', 'tools'] as const

export interface EvaluationFixtureSource {
  id: string
  origin: 'web' | 'mcp'
  uri: string
  title: string
  path: string
  searchTerms: string[]
}

export interface Config {
  sourceRoot: string
  sources: EvaluationFixtureSource[]
  /** Optional JSONL call ledger owned by the evaluation runner. */
  ledgerPath?: string
}

function sourcePath(root: string, path: string): string {
  const absoluteRoot = resolve(root)
  const full = resolve(absoluteRoot, path)
  const fromRoot = relative(absoluteRoot, full)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`evaluation fixture path escapes sourceRoot: ${path}`)
  }
  return full
}

function validate(config: Config): Map<string, EvaluationFixtureSource & { fullPath: string }> {
  if (typeof config?.sourceRoot !== 'string' || config.sourceRoot.trim() === '') {
    throw new TypeError('evaluation support sourceRoot must be a non-empty path')
  }
  if (!Array.isArray(config.sources)) throw new TypeError('evaluation support sources must be an array')
  const byUri = new Map<string, EvaluationFixtureSource & { fullPath: string }>()
  for (const source of config.sources) {
    if (source.origin !== 'web' && source.origin !== 'mcp') {
      throw new TypeError(`evaluation fixture ${String(source.id)} has unsupported origin ${String(source.origin)}`)
    }
    for (const field of ['id', 'uri', 'title', 'path'] as const) {
      if (typeof source[field] !== 'string' || source[field].trim() === '') {
        throw new TypeError(`evaluation fixture source ${String(source.id)} has invalid ${field}`)
      }
    }
    if (!Array.isArray(source.searchTerms) || source.searchTerms.some(term => typeof term !== 'string')) {
      throw new TypeError(`evaluation fixture source ${source.id} has invalid searchTerms`)
    }
    if (byUri.has(source.uri)) throw new Error(`duplicate evaluation fixture URI: ${source.uri}`)
    byUri.set(source.uri, { ...source, fullPath: sourcePath(config.sourceRoot, source.path) })
  }
  return byUri
}

export function apply(ctx: Context, config: Config): void {
  const byUri = validate(config)
  const webSources = [...byUri.values()].filter(source => source.origin === 'web')
  if (config.ledgerPath !== undefined && (typeof config.ledgerPath !== 'string' || config.ledgerPath.trim() === '')) {
    throw new TypeError('evaluation support ledgerPath must be a non-empty path when supplied')
  }
  let ledger = Promise.resolve()
  const record = async (kind: 'search' | 'fetch' | 'mcp', subject: string, started: number): Promise<void> => {
    if (config.ledgerPath === undefined) return
    const completed = Date.now()
    const line = JSON.stringify({
      kind,
      subject,
      startedAt: new Date(started).toISOString(),
      completedAt: new Date(completed).toISOString(),
      durationMs: completed - started,
    }) + '\n'
    ledger = ledger.then(() => appendFile(config.ledgerPath as string, line))
    await ledger
  }

  ctx.web.registerSearchProvider({
    id: 'raven-eval',
    available: () => true,
    async search(request) {
      const started = Date.now()
      const query = request.query.toLowerCase()
      const result = {
        sources: webSources
          .filter(source => source.searchTerms.some(term => query.includes(term.toLowerCase())))
          .map(source => ({ url: source.uri, title: source.title })),
        truncated: false,
      }
      await record('search', request.query, started)
      return result
    },
  })
  ctx.web.registerFetchProvider({
    id: 'raven-eval',
    available: () => true,
    async fetch(request) {
      const started = Date.now()
      const source = byUri.get(request.url)
      const result = source?.origin !== 'web'
        ? {
            url: request.url,
            statusCode: 404,
            body: { kind: 'text' as const, content: 'Unknown Raven evaluation fixture.' },
            truncated: false,
          }
        : {
            url: request.url,
            statusCode: 200,
            body: { kind: 'text' as const, content: await readFile(source.fullPath, 'utf8') },
            truncated: false,
          }
      await record('fetch', request.url, started)
      return result
    },
  })
  ctx.tools.register({
    name: 'mcp__raven_eval__read_resource',
    description: 'Read one frozen MCP resource from the Raven evaluation corpus.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['uri'],
      properties: { uri: { type: 'string', description: 'Exact mcp://raven_eval resource URI.' } },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value) }],
    },
    async execute(args) {
      const started = Date.now()
      const input = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
      if (typeof input.uri !== 'string') throw new TypeError('uri must be a string')
      const source = byUri.get(input.uri)
      if (source?.origin !== 'mcp') throw new Error(`unknown Raven evaluation MCP resource: ${input.uri}`)
      const result = await readFile(source.fullPath, 'utf8')
      await record('mcp', input.uri, started)
      return result
    },
  })
}
