import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runProcess } from './process.js'

const EXPECTED_VERSION = '0.1.0-rc.5'
const EXPECTED_COMMIT = '47f943859bef60e4160492346772ded9b24f765a'
const checkout = process.env.DSH_CHECKOUT
if (checkout === undefined || checkout.trim().length === 0) {
  throw new Error('Set DSH_CHECKOUT to the DeepSeek Harness checkout under test.')
}
const root = resolve(checkout)
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown }
assert.equal(manifest.version, EXPECTED_VERSION, `Raven v1 requires DeepSeek Harness ${EXPECTED_VERSION}`)
const revision = (await runProcess('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  timeoutMs: 10_000,
  capture: true,
})).stdout.trim()
assert.equal(revision, EXPECTED_COMMIT, 'DeepSeek Harness checkout commit does not match Raven compatibility metadata')
const dirty = (await runProcess('git', ['status', '--porcelain=v1'], {
  cwd: root,
  timeoutMs: 10_000,
  capture: true,
})).stdout.trim()
assert.equal(dirty, '', 'DeepSeek Harness compatibility checkout must be clean')

const source = (path: string) => pathToFileURL(join(root, path)).href
const ravenUrl = new URL('../lib/index.js', import.meta.url).href
const [
  { Context },
  SystemPromptModule,
  ToolsModule,
  WebModule,
  LoaderModule,
  IncludeModule,
  Raven,
] = await Promise.all([
  import(source('vendor/cordis/src/index.ts')),
  import(source('packages/core/system-prompt/src/index.ts')),
  import(source('packages/core/tools/src/index.ts')),
  import(source('packages/web/web/src/index.ts')),
  import(source('vendor/loader/src/index.ts')),
  import(source('vendor/include/src/index.ts')),
  import(ravenUrl),
])
assert.equal('default' in Raven, false, 'Loader metadata must remain on named exports')

const compositionRoot = await mkdtemp(join(tmpdir(), 'dsh-raven-composition-'))
const configPath = join(compositionRoot, 'cordis.yml')
await writeFile(configPath, [
  '- id: system-prompt',
  "  name: 'test-system-prompt'",
  '- id: tools',
  "  name: 'test-tools'",
  '- id: web',
  "  name: 'test-web'",
  '- id: raven',
  "  name: 'test-raven'",
  '',
].join('\n'))

const ctx = new Context()
try {
  ctx.baseUrl = pathToFileURL(compositionRoot).href + '/'
  await ctx.plugin(LoaderModule.default)
  ctx.loader.builtins.include = IncludeModule.default
  const modules = new Map<string, unknown>([
    ['test-system-prompt', SystemPromptModule.default],
    ['test-tools', ToolsModule.default],
    ['test-web', WebModule.default],
    ['test-raven', Raven],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  }
  const includeId = await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()

  assert.ok(ctx.tools.schemas().some((schema: { name: string }) => schema.name === 'raven_task'))
  const assembly = await ctx.systemPrompt.assemble()
  assert.ok(assembly.sections.some((section: { name: string }) => section.name === 'tool:raven-task'))
  ctx.web.registerFetchProvider({
    id: 'raven-smoke-fetch',
    available: () => true,
    async fetch(request: { url: string }) {
      return {
        url: request.url,
        statusCode: 200,
        body: { kind: 'text' as const, content: 'durable before acknowledgement' },
        truncated: false,
      }
    },
  })

  const agent = { id: 'raven-dsh-smoke', session: { events: [] } }
  const signal = new AbortController().signal
  let call = 0
  const execute = async (arguments_: Record<string, unknown>) => {
    const result = await ctx.tools.execute({
      callId: `raven-dsh-smoke-${++call}`,
      name: 'raven_task',
      arguments: arguments_,
      agent,
      signal,
    })
    assert.equal(result.isError, false)
    return result.content
      .map((block: { type: string; text?: string }) => block.type === 'text' ? block.text ?? '' : '')
      .join('')
  }

  const started = await execute({
    action: 'start',
    outcome: 'research',
    request: 'Verify one source through the real Harness web seam.',
  })
  assert.match(started, /Started Raven Task/)
  const taskId = /Task: (rvn-[a-f0-9]{12}-1)/.exec(started)?.[1]
  assert.ok(taskId)
  const checkpoint = await execute({
    action: 'checkpoint',
    taskId,
    stage: 'draft',
    summary: 'A source-grounded draft.',
    artifact: 'The source documents durable acknowledgement [@S1].',
    sources: [{
      sourceId: 'S1',
      url: 'https://evidence.test/source',
      title: 'Harness smoke evidence',
      locator: 'Durability',
      excerpt: 'durable before acknowledgement',
      role: 'primary',
    }],
    claims: [{
      claimId: 'C1',
      text: 'The source documents durable acknowledgement.',
      kind: 'external',
      importance: 'material',
      disposition: 'supported',
      sourceIds: ['S1'],
    }],
  })
  assert.match(checkpoint, /Harness smoke evidence/)
  const completed = await execute({
    action: 'complete',
    taskId,
    artifact: 'The source documents durable acknowledgement [@S1].',
  })
  assert.match(completed, /Completed Raven Task/)
  assert.match(completed, /Harness smoke evidence/)

  await ctx.loader.remove(includeId)
  assert.equal(ctx.get('tools'), undefined, 'removing the composition must dispose its tool registry and Raven registration')
  assert.equal(ctx.get('systemPrompt'), undefined, 'removing the composition must dispose Raven prompt contributions')
  assert.equal(ctx.get('web'), undefined, 'removing the composition must dispose the web verification seam')
  console.log(`dsh compatibility: ${manifest.version}@${revision.slice(0, 12)}; clean real composition, prompt, web verification, tool execution, and disposal passed`)
} finally {
  await ctx.fiber.dispose()
  await rm(compositionRoot, { recursive: true, force: true })
}
