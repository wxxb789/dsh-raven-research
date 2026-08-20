import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runProcess } from './process.js'

const EXPECTED_VERSION = '0.1.0-rc.8'
const EXPECTED_COMMIT = '141eb6fef83422698aef7a981029e843e8161534'
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
  SettingsFileModule,
  LoaderModule,
  IncludeModule,
  Raven,
] = await Promise.all([
  import(source('vendor/cordis/src/index.ts')),
  import(source('packages/core/system-prompt/src/index.ts')),
  import(source('packages/core/tools/src/index.ts')),
  import(source('packages/web/web/src/index.ts')),
  import(source('packages/settings/settings-file/src/index.ts')),
  import(source('vendor/loader/src/index.ts')),
  import(source('vendor/include/src/index.ts')),
  import(ravenUrl),
])
assert.equal('default' in Raven, false, 'Loader metadata must remain on named exports')

const compositionRoot = await mkdtemp(join(tmpdir(), 'dsh-raven-composition-'))
const configPath = join(compositionRoot, 'cordis.yml')
const settingsPath = join(compositionRoot, 'settings.yaml')
await writeFile(configPath, [
  '- id: system-prompt',
  "  name: 'test-system-prompt'",
  '- id: tools',
  "  name: 'test-tools'",
  '- id: web',
  "  name: 'test-web'",
  '- id: settings',
  "  name: 'test-settings-file'",
  '  config:',
  `    path: ${JSON.stringify(settingsPath)}`,
  '    watch: false',
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
    ['test-settings-file', SettingsFileModule.default],
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
  const searched: string[] = []
  ctx.web.registerSearchProvider({
    id: 'raven-smoke-search',
    available: () => true,
    async search(request: { query: string; maxResults?: number }) {
      searched.push(request.query)
      if (request.query === 'broken query') throw new Error('backend refused the query')
      return {
        sources: [
          { url: 'https://evidence.test/source', title: 'Harness smoke evidence' },
          { url: `https://evidence.test/${encodeURIComponent(request.query)}`, title: request.query },
        ],
        truncated: false,
      }
    },
  })

  const appended: Array<{ type: string; data: { kind?: string; state?: { taskId?: string } } }> = []
  const agent = {
    id: 'raven-dsh-smoke',
    session: {
      events: [],
      append(type: string, data: { kind?: string; state?: { taskId?: string } }) {
        appended.push({ type, data })
      },
    },
  }
  const signal = new AbortController().signal
  let call = 0
  const run = async (arguments_: Record<string, unknown>, parent?: symbol) => {
    const result = await ctx.tools.execute({
      callId: `raven-dsh-smoke-${++call}`,
      name: 'raven_task',
      arguments: arguments_,
      agent,
      signal,
      ...parent === undefined ? {} : { parent },
    })
    assert.equal(result.isError, false)
    return result
  }
  const attempt = async (arguments_: Record<string, unknown>) => ctx.tools.execute({
    callId: `raven-dsh-smoke-${++call}`,
    name: 'raven_task',
    arguments: arguments_,
    agent,
    signal,
  })
  const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content
    .map(block => block.type === 'text' ? block.text ?? '' : '')
    .join('')
  const execute = async (arguments_: Record<string, unknown>) => textOf(await run(arguments_))

  const started = await execute({
    action: 'start',
    outcome: 'research',
    request: 'Verify one source through the real Harness web seam.',
  })
  assert.match(started, /Started Raven Task/)
  const taskId = /Task: (rvn-[a-f0-9]{12}-1)/.exec(started)?.[1]
  assert.ok(taskId)
  // Discovery runs the real `ctx.web` search half: one batch, several angles, one
  // failing query recorded as a Limitation instead of losing the whole batch.
  const discovered = await execute({
    action: 'discover',
    taskId,
    queries: ['durable acknowledgement', 'write-ahead durability', 'broken query'],
  })
  assert.deepEqual(searched, ['durable acknowledgement', 'write-ahead durability', 'broken query'])
  assert.match(discovered, /Leads \(uninspected candidates, not Sources\)/)
  assert.match(discovered, /backend refused the query/)
  // One URL returned by two queries is one Lead that records both.
  assert.equal((discovered.match(/https:\/\/evidence\.test\/source/g) ?? []).length, 1)

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

  // Task state has two publication paths because the registry gives a nested
  // sub-call no result card: a direct call carries the record as result metadata,
  // and a Code Mode dispatch carries it on the durable copy of the sub-dispatch.
  const direct = await run({ action: 'status', taskId })
  assert.notEqual(direct.meta, undefined, 'a direct call must publish Task state as durable result metadata')
  assert.equal(appended.length, 0, 'a direct call must not duplicate the record its tool result already carries')
  const nestedCallId = 'raven-dsh-smoke-nested-' + String(++call)
  const nested = await ctx.tools.execute({
    callId: nestedCallId,
    name: 'raven_task',
    arguments: { action: 'status', taskId },
    agent,
    signal,
    parent: Symbol('raven-code-mode'),
  })
  assert.equal(nested.isError, false)
  assert.equal(nested.meta, undefined, 'the registry computes no presentation metadata for a nested sub-call')
  // The Harness persistence read path refuses a stored log carrying an event type
  // it does not know unless the writer marked it ignorable, and `Session.append`
  // gives a plugin no way to set that marker. Raven therefore appends no event of
  // its own: one Code Mode step must never make a whole session unloadable.
  assert.equal(appended.length, 0, 'Raven must not append a plugin-owned session event type')

  // The record rides the `tools/code-dispatch-log` waterfall instead, on the known
  // `tool/code-dispatch` event the Code Mode bridge appends.
  const settledContent = [{ type: 'text' as const, text: 'rendered sub-call content' }]
  const loggedContent = await ctx.waterfall(
    'tools/code-dispatch-log',
    { exec: { agent }, agent, subCallId: nestedCallId, name: 'raven_task', isError: false, content: settledContent },
    () => Promise.resolve(settledContent),
  ) as Array<{ type: string; text?: string }>
  assert.equal(loggedContent.length, 2, 'the durable log copy must carry the Task record next to the rendered content')
  assert.ok(String(loggedContent[1]?.text).startsWith('<!-- dsh-raven-research/task-state '))

  // A resumed session rebuilds that step from the known event alone.
  const resumed = await ctx.tools.execute({
    callId: 'raven-dsh-smoke-resume-' + String(++call),
    name: 'raven_task',
    arguments: { action: 'status' },
    agent: {
      id: 'raven-dsh-smoke-resumed',
      session: {
        events: [{
          type: 'tool/code-dispatch',
          seq: 0,
          time: 0,
          data: { name: 'raven_task', content: loggedContent },
        }],
      },
    },
    signal,
  })
  assert.equal(resumed.isError, false, 'a Code Mode Task step must survive a session reload')
  assert.ok(textOf(resumed).includes(taskId), 'the restored Task must be the one the program worked on')

  // An unknown action is rejected by argument validation, before `execute` and
  // outside `tools/post-execute`. The tool-owned content finalizer still runs, so
  // the rejection reaches the model naming the Task it must correct against.
  const rejected = await attempt({ action: 'not-an-action' })
  assert.equal(rejected.isError, true, 'an unknown action must be rejected before execution')
  const rejectedText = textOf(rejected)
  assert.match(rejectedText, /<raven_task_recovery>/)
  assert.ok(rejectedText.includes(taskId), 'the recovery hint must name the Task the caller has to correct against')

  // Registering is exposing: the Harness serves every namespace a live plugin
  // registered, with no allowlist for Raven to join.
  const namespaces: string[] = ctx.settings.describe().map((entry: { ns: string }) => entry.ns)
  assert.ok(
    namespaces.includes(Raven.RAVEN_SETTINGS_NAMESPACE),
    'Raven must reach a configuration surface through its own settings registration',
  )
  const described = ctx.settings.describe()
    .find((entry: { ns: string }) => entry.ns === Raven.RAVEN_SETTINGS_NAMESPACE) as {
      value: { sourceVerification?: string; sourceCheckTimeoutMs?: number }
    }
  assert.equal(described.value.sourceVerification, 'remote')
  assert.equal(described.value.sourceCheckTimeoutMs, 0)

  // A stored write reaches the running plugin: the next Source check is local,
  // so the evidence is reported unverifiable instead of silently trusted.
  await ctx.settings.update(Raven.RAVEN_SETTINGS_NAMESPACE, { sourceVerification: 'structural-only' })
  const offline = await execute({
    action: 'start',
    outcome: 'research',
    request: 'Verify the settings-driven verification policy.',
  })
  const offlineTaskId = /Task: (rvn-[a-f0-9]{12}-\d+)/.exec(offline)?.[1]
  assert.ok(offlineTaskId)
  const offlineCheckpoint = await execute({
    action: 'checkpoint',
    taskId: offlineTaskId,
    stage: 'draft',
    summary: 'A draft written without remote verification.',
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
  assert.match(offlineCheckpoint, /structural-only/)

  await ctx.loader.remove(includeId)
  assert.equal(ctx.get('tools'), undefined, 'removing the composition must dispose its tool registry and Raven registration')
  assert.equal(ctx.get('systemPrompt'), undefined, 'removing the composition must dispose Raven prompt contributions')
  assert.equal(ctx.get('web'), undefined, 'removing the composition must dispose the web verification seam')
  assert.equal(ctx.get('settings'), undefined, 'removing the composition must dispose the settings provider and Raven registration')

  // The Profile Bundle, through the Harness's own composer rather than a text
  // assertion: `dsh plugin add` appends this package to a profile's bundle list
  // and `loadProfile` feeds exactly this file to `loadOverlayPatches`, so a patch
  // that parses here is a patch the deployment will accept.
  const { composeEntries, loadOverlayPatches } = await import(source('packages/boot/app-boot/src/index.ts')) as {
    composeEntries(layers: readonly unknown[][]): Array<{ id?: string; name?: string }>
    loadOverlayPatches(binName: string, file: string): unknown[]
  }
  const ravenManifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { name: string; dsh?: { bundle?: { patch?: string } } }
  const declared = ravenManifest.dsh?.bundle?.patch
  assert.equal(declared, './cordis.patch.yml', 'the bundle manifest field the profile composer reads')
  const patchPath = new URL(`../${declared.replace('./', '')}`, import.meta.url)
  const entries = composeEntries([loadOverlayPatches('dsh', patchPath.pathname.replace(/^\/([A-Za-z]:)/, '$1')) as unknown[]])
  assert.deepEqual(
    entries.map(entry => ({ id: entry.id, name: entry.name })),
    [{ id: Raven.name, name: ravenManifest.name }],
    'the bundle patch must compose to exactly one row naming this package',
  )

  console.log(`dsh compatibility: ${manifest.version}@${revision.slice(0, 12)}; clean real composition, prompt, web search discovery, web verification, tool execution, Code Mode state durability, failure-path recovery hinting, settings exposure, Profile Bundle composition, and disposal passed`)
} finally {
  await ctx.fiber.dispose()
  await rm(compositionRoot, { recursive: true, force: true })
}
