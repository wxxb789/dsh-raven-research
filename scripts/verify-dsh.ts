import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseConfigFileTextToJson } from 'typescript'

import { runProcess } from './process.js'

// The Harness pin has exactly ONE source of truth: `dshRaven` in this package's own
// package.json, which is what ships to a consumer and what the README documents. The
// second hardcoded copy this file used to carry was not a duplicate that might drift —
// it HAD drifted, and because both copies agreed with each other the gate reported a
// green pin while naming a checkout nobody could produce. Reading the manifest makes
// retargeting a one-line edit in the file the release actually publishes.
const ravenManifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  name: string
  devDependencies?: Record<string, string>
  dsh?: {
    bundle?: { patch?: string }
    client?: { external?: unknown }
  }
  dshRaven?: { harnessVersion?: unknown; harnessCommit?: unknown }
}
const EXPECTED_VERSION = ravenManifest.dshRaven?.harnessVersion
const EXPECTED_COMMIT = ravenManifest.dshRaven?.harnessCommit
if (typeof EXPECTED_VERSION !== 'string' || EXPECTED_VERSION.length === 0) {
  throw new TypeError('package.json is missing dshRaven.harnessVersion; the release gate has no pin to check against.')
}
if (typeof EXPECTED_COMMIT !== 'string' || !/^[a-f0-9]{40}$/.test(EXPECTED_COMMIT)) {
  throw new TypeError('package.json dshRaven.harnessCommit must be a full 40-character commit sha.')
}
const checkout = process.env.DSH_CHECKOUT
if (checkout === undefined || checkout.trim().length === 0) {
  throw new Error(
    'Set DSH_CHECKOUT to a DeepSeek Harness checkout at ' + EXPECTED_VERSION
    + ' (commit ' + EXPECTED_COMMIT + '). '
    + 'Example: DSH_CHECKOUT=/path/to/deepseek-harness pnpm run test:dsh',
  )
}
const root = resolve(checkout)
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown }
// Every mismatch below names BOTH values and the one file to edit, because an operator
// who hits this gate has two legitimate repairs — move the checkout, or move the pin —
// and a bare 'does not match' tells them neither which is which nor where to go.
assert.equal(
  manifest.version,
  EXPECTED_VERSION,
  'DeepSeek Harness version mismatch: package.json dshRaven.harnessVersion pins ' + EXPECTED_VERSION
  + ', but DSH_CHECKOUT=' + root + ' is ' + String(manifest.version) + '.'
  + ' Check out the pinned release in that repository, or retarget the pin in package.json'
  + ' (dshRaven.harnessVersion and dshRaven.harnessCommit together).',
)
const revision = (await runProcess('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  timeoutMs: 10_000,
  capture: true,
})).stdout.trim()
assert.equal(
  revision,
  EXPECTED_COMMIT,
  'DeepSeek Harness commit mismatch: package.json dshRaven.harnessCommit pins ' + EXPECTED_COMMIT
  + ', but DSH_CHECKOUT=' + root + ' is at ' + revision + '.'
  + ' Run `git -C ' + root + ' checkout ' + EXPECTED_COMMIT + '`, or retarget'
  + ' dshRaven.harnessCommit in package.json to ' + revision + '.',
)
const dirty = (await runProcess('git', ['status', '--porcelain=v1'], {
  cwd: root,
  timeoutMs: 10_000,
  capture: true,
})).stdout.trim()
assert.equal(
  dirty,
  '',
  'DeepSeek Harness compatibility checkout must be clean, but DSH_CHECKOUT=' + root
  + ' has uncommitted changes:\n' + dirty + '\n'
  + 'A dirty checkout is not the pinned commit, so a pass here would prove nothing.'
  + ' Commit, stash, or run `git -C ' + root + ' restore .` before rerunning.',
)

const targetConfigFile = join(root, 'tsconfig.base.json')
const parsedTargetConfig = parseConfigFileTextToJson(
  targetConfigFile,
  await readFile(targetConfigFile, 'utf8'),
)
if (parsedTargetConfig.error !== undefined) {
  throw new Error(`cannot parse Harness TypeScript path map at ${targetConfigFile}`)
}
const sourcePaths = (parsedTargetConfig.config as {
  compilerOptions?: { paths?: Record<string, unknown> }
}).compilerOptions?.paths ?? {}
const sourceDirectory = (packageName: string): string => {
  const candidates = sourcePaths[packageName]
  const mapped = Array.isArray(candidates) ? candidates[0] : undefined
  if (typeof mapped !== 'string') {
    throw new Error(`Harness TypeScript path map has no source entry for ${packageName}`)
  }
  return join(root, mapped)
}
const source = (packageName: string): string => pathToFileURL(
  join(sourceDirectory(packageName), 'index.ts'),
).href
const checkoutPackageManifest = async (packageName: string): Promise<{
  name?: string
  devDependencies?: Record<string, string>
}> => {
  let directory = sourceDirectory(packageName)
  while (true) {
    const parsed = await readFile(join(directory, 'package.json'), 'utf8')
      .then(text => JSON.parse(text) as { name?: string; devDependencies?: Record<string, string> })
      .catch(() => undefined)
    if (parsed?.name === packageName) return parsed
    const parent = dirname(directory)
    if (parent === directory || !parent.startsWith(root)) {
      throw new Error(`cannot locate package manifest for ${packageName}`)
    }
    directory = parent
  }
}
const major = (specifier: string): string | undefined => /(?:^|[^0-9])(\d+)\./.exec(specifier)?.[1]
const targetClientWeb = await checkoutPackageManifest('@deepseek-ai/dsh-client-web')
assert.equal(
  major(ravenManifest.devDependencies?.react ?? ''),
  major(targetClientWeb.devDependencies?.react ?? ''),
  'Raven React development major differs from the target shell package',
)
const targetPlatform = await import(pathToFileURL(
  join(sourceDirectory('@deepseek-ai/dsh-client-web'), 'platform.ts'),
).href) as {
  PLATFORM_MODULES: readonly string[]
  PRELOADED_CLIENT_EXTERNALS: readonly string[]
}
const declaredClientExternals = Array.isArray(ravenManifest.dsh?.client?.external)
  ? ravenManifest.dsh.client.external.filter((value): value is string => typeof value === 'string')
  : []
const targetClientModules = new Set([
  ...targetPlatform.PLATFORM_MODULES,
  ...targetPlatform.PRELOADED_CLIENT_EXTERNALS,
  ...declaredClientExternals,
])
const clientArtifact = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const clientRequests = [...clientArtifact.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)]
  .map(match => match[1])
  .filter((value): value is string => value !== undefined)
assert.ok(clientRequests.length > 0, 'Raven client artifact emits no module-table requests')
for (const specifier of clientRequests) {
  assert.ok(
    targetClientModules.has(specifier),
    `Raven client requires ${JSON.stringify(specifier)}, which the target module table cannot answer`,
  )
}
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
  import(source('@deepseek-ai/cordis')),
  import(source('@deepseek-ai/dsh-system-prompt')),
  import(source('@deepseek-ai/dsh-tools')),
  import(source('@deepseek-ai/dsh-web')),
  import(source('@deepseek-ai/dsh-settings-file')),
  import(source('@deepseek-ai/cordis-plugin-loader')),
  import(source('@deepseek-ai/cordis-plugin-include')),
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
  '  config:',
  "    sourceNetworkPolicy: 'unrestricted'",
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

  const ravenToolNames = ctx.tools.schemas().map((schema: { name: string }) => schema.name)
  assert.ok(ravenToolNames.includes('raven_task'))
  assert.ok(ravenToolNames.includes('raven_workspace'))
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
    assert.equal(
      result.isError,
      false,
      'raven_task ' + String(arguments_.action) + ' failed inside the real Harness composition: '
      + (result.content ?? []).map((block: { type: string; text?: string }) => block.type === 'text' ? block.text ?? '' : '').join(''),
    )
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
  const workspaceInitialized = await ctx.tools.execute({
    callId: `raven-dsh-smoke-${++call}`,
    name: 'raven_workspace',
    arguments: { action: 'initialize', files: [] },
    agent,
    signal,
  })
  assert.equal(workspaceInitialized.isError, false, 'raven_workspace initialize failed inside the real Harness composition')
  assert.match(textOf(workspaceInitialized), /wiki\/SCHEMA\.md/)
  assert.match(textOf(workspaceInitialized), /No files have been changed/)

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
  // and a PTC mode dispatch carries it on the durable copy of the sub-dispatch.
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
    parent: Symbol('raven-ptc-mode'),
  })
  assert.equal(nested.isError, false)
  assert.equal(nested.meta, undefined, 'the registry computes no presentation metadata for a nested sub-call')
  // The Harness persistence read path accepts only generated known event types,
  // and exposes no registration seam for plugin-owned names. Raven therefore
  // appends no event of its own: one PTC mode step must never make a whole session
  // unloadable.
  assert.equal(appended.length, 0, 'Raven must not append a plugin-owned session event type')

  // The record rides the `tools/ptc-dispatch-log` waterfall instead, on the known
  // `tool/code-dispatch` event the PTC mode bridge appends. Both halves are driven
  // by the REAL bridge below rather than fabricated here: a gate that hand-builds
  // the waterfall payload AND the settle event restates the same literals the
  // plugin does, so an official rename would pass it.

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
  const configDefaults = Raven.Config({}) as Record<string, unknown>
  assert.deepEqual(
    { sourceVerification: described.value.sourceVerification, sourceCheckTimeoutMs: described.value.sourceCheckTimeoutMs },
    { sourceVerification: configDefaults.sourceVerification, sourceCheckTimeoutMs: configDefaults.sourceCheckTimeoutMs },
    'the registered settings section must serve the Config schema\'s own defaults through the Harness settings surface',
  )

  // A stored write reaches the running plugin: the next Source check is local,
  // so the evidence is reported unverifiable instead of silently trusted.
  //
  // `grounding: optional` is required to observe that, and is not a weakening of the
  // check. Under `structural-only` the engine now refuses to START a grounding-required
  // Task at all — no Source could ever be confirmed, so the Task could never complete,
  // and refusing at `start` is better than accepting work that is doomed. That refusal
  // is a DIFFERENT property from the one this section exists to prove, which is that a
  // stored settings write reaches the running plugin and changes the next Source check.
  // A grounding-optional Task is the one shape that still reaches a Source check under
  // this policy, so it is what makes the write observable.
  await ctx.settings.update(Raven.RAVEN_SETTINGS_NAMESPACE, { sourceVerification: 'structural-only' })
  const offline = await execute({
    action: 'start',
    outcome: 'research',
    grounding: 'optional',
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

  // ---------------------------------------------------------------------------
  // PTC mode durability, driven through the REAL bridge.
  //
  // The Harness feature whose UI alias is "PTC mode" is what puts Raven inside a
  // `run_code` program, and it is the one path where a Task step has no result
  // card to ride. Rather than fabricating both sides, this composes the official
  // `run_code` tool (tools `mode: 'ptc'`) over an in-process `CodeRuntime` fake —
  // the same role the Harness's own `code-mode.spec.ts` uses — and lets the REAL
  // bridge run the REAL `tools/ptc-dispatch-log` waterfall and append the REAL
  // `tool/code-dispatch` event. The fake stands in only for the sandboxed
  // execution backend (the published worker runtime needs a built `worker.cjs`
  // this source-loaded composition has no cheap way to produce); every line of
  // PTC mode logic Raven depends on is the Harness's own.
  const { CodeRuntime } = await import(source('@deepseek-ai/dsh-code-runtime')) as {
    CodeRuntime: new (ctx: unknown) => { run(request: unknown): Promise<unknown> }
  }
  const ToolsModuleNs = ToolsModule as { default: unknown; RUN_CODE_NAME: string }
  class BridgeRuntime extends CodeRuntime {
    readonly language = 'typescript'
    readonly isolation = 'gate'
    behavior: (request: { bindings: Array<{ functions: Record<string, (a: unknown) => Promise<unknown>> }> }) => Promise<unknown>
      = () => Promise.resolve({ logs: [] })
    override run(request: unknown): Promise<unknown> {
      return this.behavior(request as { bindings: Array<{ functions: Record<string, (a: unknown) => Promise<unknown>> }> })
    }
  }
  const ptcCtx = new Context()
  try {
    await ptcCtx.plugin(SystemPromptModule.default)
    await ptcCtx.plugin(ToolsModuleNs.default, { mode: 'ptc' })
    await ptcCtx.plugin(BridgeRuntime)
    await ptcCtx.plugin(Raven)
    const firstPartyOrder = (SystemPromptModule as {
      FIRST_PARTY_SECTION_ORDER: { FILE_REFERENCE: number }
    }).FIRST_PARTY_SECTION_ORDER
    ptcCtx.systemPrompt.section({
      name: 'test:raven-upper-bound',
      order: firstPartyOrder.FILE_REFERENCE,
      text: 'upper bound sentinel',
    })
    const ptcPrompt = await ptcCtx.systemPrompt.assemble()
    const sectionNames = ptcPrompt.sections.map((section: { name: string }) => section.name)
    const ptcOnlyIndex = sectionNames.indexOf('tools:ptc-only')
    const ravenIndex = sectionNames.indexOf('tool:raven-task')
    const upperBoundIndex = sectionNames.indexOf('test:raven-upper-bound')
    assert.notEqual(ptcOnlyIndex, -1, 'the PTC composition omitted its direct-call rule')
    assert.notEqual(ravenIndex, -1, 'the PTC composition omitted Raven tool guidance')
    assert.notEqual(upperBoundIndex, -1, 'the prompt-order upper-bound sentinel is missing')
    assert.ok(
      ptcOnlyIndex < ravenIndex && ravenIndex < upperBoundIndex,
      'Raven tool guidance must stay between PTC-only and file-reference prompt order',
    )
    const bridgeEvents: Array<{ type: string; seq: number; time: number; data: unknown }> = []
    const bridgeAgent = {
      id: 'raven-dsh-ptc-mode',
      session: {
        header: { cwd: compositionRoot },
        events: [] as unknown[],
        append(type: string, data: unknown) {
          bridgeEvents.push({ type, seq: bridgeEvents.length, time: 0, data })
        },
      },
    }
    const runtime = ptcCtx.codeRuntime as BridgeRuntime
    // The program a model would write: one `raven_task` call from inside `run_code`.
    runtime.behavior = async request => ({
      logs: [],
      value: await request.bindings[0]!.functions.raven_task!({
        action: 'start',
        outcome: 'research',
        // This composition deliberately mounts no `web` capability — it exists to drive
        // the PTC mode bridge, not the verification seam — and the engine now refuses to
        // start a grounding-REQUIRED Task where no Source could ever be confirmed. What is
        // under test here is durability of a Task step taken from inside `run_code`, which
        // is independent of the evidence floor, so the Task is started at the floor this
        // composition can actually honour.
        grounding: 'optional',
        request: 'Verify PTC mode durability through the real bridge.',
      }),
    })
    const ran = await ptcCtx.tools.execute({
      callId: 'raven-dsh-ptc-mode-1',
      name: ToolsModuleNs.RUN_CODE_NAME,
      arguments: { code: '// driven by the gate runtime', description: 'Start a Raven Task from a program' },
      agent: bridgeAgent,
      signal,
    })
    assert.equal(ran.isError, false, 'the official run_code bridge must dispatch raven_task from inside a program')
    const settle = bridgeEvents.find(event => event.type === 'tool/code-dispatch')
    assert.ok(settle, 'the PTC mode bridge no longer appends tool/code-dispatch; Raven restores no PTC mode step from a reloaded session')
    const settleData = settle.data as {
      name?: string
      subCallId?: string
      isError?: boolean
      content?: Array<{ type: string; text?: string }>
    }
    assert.equal(settleData.name, 'raven_task', 'the settle event no longer carries the dispatched tool name; readDispatchTaskState() keys on it')
    assert.equal(typeof settleData.subCallId, 'string', 'the settle event no longer carries its PTC sub-call identity')
    assert.equal(settleData.isError, false, 'the successful PTC settle event must retain its failure marker')
    const logged = settleData.content ?? []
    assert.equal(logged.length, 2, 'the real tools/ptc-dispatch-log waterfall did not attach the Task record next to the rendered content')
    assert.ok(
      String(logged[1]?.text).startsWith('<!-- dsh-raven-research/task-state '),
      'the durable log copy no longer carries the Raven Task record',
    )
    const ptcTaskId = /(rvn-[a-f0-9]{12}-\d+)/.exec(JSON.stringify(logged))?.[1]
    assert.ok(ptcTaskId, 'the logged record must name the Task the program started')
    // A resumed session rebuilds that step from the REAL appended event alone.
    // The call carries a `parent` token because this composition is `mode: 'ptc'`:
    // there, only a transport sub-dispatch may execute a native tool name, and a
    // model-direct call is denied as UNKNOWN_TOOL before any policy runs — which is
    // exactly the shape a resumed PTC mode session replays anyway.
    const resumed = await ptcCtx.tools.execute({
      callId: 'raven-dsh-ptc-mode-2',
      name: 'raven_task',
      arguments: { action: 'status' },
      agent: { id: 'raven-dsh-ptc-mode-resumed', session: { events: [settle] } },
      signal,
      parent: Symbol('raven-dsh-ptc-mode-resume'),
    })
    assert.equal(resumed.isError, false, 'a PTC mode Task step must survive a session reload')
    assert.ok(
      textOf(resumed as { content: Array<{ type: string; text?: string }> }).includes(ptcTaskId),
      'the restored Task must be the one the program worked on',
    )
  } finally {
    await ptcCtx.fiber.dispose()
  }

  // The real PTC registry above proves the public event, waterfall, dispatch
  // fields, RUN_CODE_NAME export, prompt ordering, and durable replay together.
  // No source-layout or declaration-text regex is a second compatibility oracle.

  await ctx.loader.remove(includeId)
  assert.equal(ctx.get('tools'), undefined, 'removing the composition must dispose its tool registry and Raven registration')
  assert.equal(ctx.get('systemPrompt'), undefined, 'removing the composition must dispose Raven prompt contributions')
  assert.equal(ctx.get('web'), undefined, 'removing the composition must dispose the web verification seam')
  assert.equal(ctx.get('settings'), undefined, 'removing the composition must dispose the settings provider and Raven registration')

  // The OPT-IN overlay, through the Harness's own composer rather than a text
  // assertion. Two things are checked, and the first one is an ABSENCE.
  //
  // Raven declares NO `dsh.bundle.patch`, and that is the isolation guarantee:
  // declaring it is what makes `dsh plugin add` append this package to a
  // profile's bundle list, which would apply the overlay and give Raven a
  // host-plane row — a settings namespace on a global settings page, and the
  // client bundle the web app loads for any package a composition names. An
  // install must contribute nothing until a session picks the Raven mode.
  //
  // The overlay still ships, for a deployment that wants the settings card and
  // accepts losing isolation, so it must still compose to exactly one host row
  // when someone applies it deliberately.
  const { composeEntries, loadOverlayPatches } = await import(source('@deepseek-ai/dsh-app-boot')) as {
    composeEntries(layers: readonly unknown[][]): Array<{ id?: string; name?: string; config?: { role?: string } }>
    loadOverlayPatches(binName: string, file: string): unknown[]
  }
  assert.equal(
    ravenManifest.dsh?.bundle,
    undefined,
    'the manifest declares a bundle again; `dsh plugin add` would auto-apply the host row and break mode isolation',
  )
  const patchPath = new URL('../cordis.patch.yml', import.meta.url)
  const entries = composeEntries([loadOverlayPatches('dsh', patchPath.pathname.replace(/^\/([A-Za-z]:)/, '$1')) as unknown[]])
  assert.deepEqual(
    entries.map(entry => ({ id: entry.id, name: entry.name, role: entry.config?.role })),
    [{ id: Raven.name, name: ravenManifest.name, role: 'host' }],
    'the opt-in overlay must compose to exactly one row naming this package, in the host role only',
  )

  // What the envelope must still contain for the card to derive controls from
  // it: an object root whose properties carry union members as `const` nodes.
  // Asserted against the REAL Config, through the real serialize/rehydrate pair.
  const { default: Schemastery } = await import(source('@deepseek-ai/schemastery')) as {
    default: new (value: unknown) => { type: string; dict?: Record<string, { type: string; list?: { value?: unknown }[] }> }
  }
  const rehydrated = new Schemastery(JSON.parse(JSON.stringify(Raven.Config.toJSON())))
  assert.equal(rehydrated.type, 'object', 'the Raven Config no longer serializes as an object schema')
  assert.deepEqual(
    (rehydrated.dict?.proseLayout?.list ?? []).map(member => member.value),
    ['sentence-per-line', 'as-written'],
    'a union field no longer round-trips its const members; the card derives its choices from them',
  )

  const installerHome = await mkdtemp(join(tmpdir(), 'dsh-raven-installer-'))
  try {
    const installed = await runProcess(
      process.execPath,
      [fileURLToPath(new URL('../lib/install-preset.js', import.meta.url)), '--dry-run'],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        timeoutMs: 30_000,
        capture: true,
        env: { ...process.env, DSH_CHECKOUT: root, DSH_HOME: installerHome },
      },
    )
    assert.match(installed.stdout, /base preset "ptc" LIVE/, 'installer did not discover the target package-owned PTC preset')
    assert.match(installed.stdout, /would install/, 'installer dry-run did not reach composition')
  } finally {
    await rm(installerHome, { recursive: true, force: true })
  }

  // ── Raven is opt-in by MODE ────────────────────────────────────────────────
  //
  // The role split is only worth anything if it holds through the real preset
  // machinery, so this composes a second Harness: the tools registry, the
  // agent-presets plugin pointed at a preset root written here, and Raven's HOST
  // row. Then it asks the preset package for that preset's STANDING scope key —
  // which composes the preset's plugins without starting an agent, a session or a
  // turn — and reads the tool registry through that scope and through none.
  //
  // The preset is written here rather than read from `presets/` on purpose: what
  // is under test is the ROLE SPLIT reaching a real agent scope, and coupling this
  // assertion to the shipped file layout would make it fail for reasons that have
  // nothing to do with it. `tests/unit/bundle.test.ts` owns the shipped files.
  const PresetsModule = await import(source('@deepseek-ai/dsh-agent-presets')) as { default: unknown }
  const presetRoot = join(compositionRoot, 'preset-root')
  await mkdir(join(presetRoot, 'raven'), { recursive: true })
  await writeFile(join(presetRoot, 'raven', 'preset.yml'), 'name: Raven\ndescription: mode probe\n')
  await writeFile(join(presetRoot, 'raven', 'agent.cordis.yml'), [
    '- id: raven-research',
    `  name: ${JSON.stringify(ravenUrl)}`,
    '  config:',
    "    role: 'agent'",
    '',
  ].join('\n'))
  const modeRoot = await mkdtemp(join(tmpdir(), 'dsh-raven-mode-'))
  const modeConfigPath = join(modeRoot, 'cordis.yml')
  await writeFile(modeConfigPath, [
    '- id: tools',
    "  name: 'test-tools'",
    '- id: system-prompt',
    "  name: 'test-system-prompt'",
    '- id: presets',
    "  name: 'test-presets'",
    '  config:',
    "    default: 'raven'",
    '    includeShippedRoot: false',
    '    includeUserRoot: false',
    '    roots:',
    `      - path: ${JSON.stringify(presetRoot)}`,
    "        trust: 'user'",
    '- id: settings',
    "  name: 'test-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(join(modeRoot, 'settings.yaml'))}`,
    '    watch: false',
    '',
  ].join('\n'))
  const modeCtx = new Context()
  try {
    modeCtx.baseUrl = pathToFileURL(modeRoot).href + '/'
    await modeCtx.plugin(LoaderModule.default)
    modeCtx.loader.builtins.include = IncludeModule.default
    const modeModules = new Map<string, unknown>([
      ['test-tools', ToolsModule.default],
      ['test-system-prompt', SystemPromptModule.default],
      ['test-presets', PresetsModule.default],
      ['test-settings-file', SettingsFileModule.default],
      [ravenUrl, Raven],
    ])
    modeCtx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modeModules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modeModules.get(specifier)
      },
    }
    await modeCtx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(modeConfigPath).href } })
    await modeCtx.loader.await()

    const toolNames = (scope?: object): string[] =>
      modeCtx.tools.schemas(scope).map((schema: { name: string }) => schema.name)
    const globalToolNames = toolNames()
    for (const toolName of ['raven_task', 'raven_workspace']) {
      assert.equal(
        globalToolNames.includes(toolName),
        false,
        `${toolName} is registered outside the Raven preset; every other mode would carry a Raven tool it never asked for`,
      )
    }
    // Isolation is not only about the tool. A settings namespace is served
    // process-wide and the settings page is global, so a namespace registered by
    // a default install would show a Raven card to a user sitting in any other
    // mode. This composition is the DEFAULT install — package present, no row —
    // and it must therefore serve no Raven namespace at all.
    assert.equal(
      modeCtx.settings.describe().some((entry: { ns: string }) => entry.ns === 'raven-research'),
      false,
      'the raven-research settings namespace is served without a Raven row; a card would be visible in every mode',
    )
    const presetScope = await modeCtx.agentPresets.standingKeyFor('raven')
    const presetToolNames = toolNames(presetScope)
    for (const toolName of ['raven_task', 'raven_workspace']) {
      assert.ok(
        presetToolNames.includes(toolName),
        `the Raven preset composed no ${toolName}; selecting the mode would omit part of Raven's Task/Workspace contract`,
      )
    }
  } finally {
    await modeCtx.fiber.dispose()
    await rm(modeRoot, { recursive: true, force: true })
  }

  console.log(`dsh compatibility: ${manifest.version}@${revision.slice(0, 12)}; clean real composition, relative prompt order, web search and verification, tool execution, PTC durability and replay through the real run_code bridge, failure recovery, settings exposure, Profile Bundle composition, preset standing mount, React alignment, mode-scoped registration, and disposal passed`)
} finally {
  await ctx.fiber.dispose()
  await rm(compositionRoot, { recursive: true, force: true })
}
