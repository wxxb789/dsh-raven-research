import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runProcess } from './process.js'

const EXPECTED_VERSION = '0.1.1-rc.1'
const EXPECTED_COMMIT = '528c682e061696f5a160f363f236ecbf53cbd006'
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
  // `tool/code-dispatch` event the Code Mode bridge appends. Both halves are driven
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

  // ---------------------------------------------------------------------------
  // Code Mode durability, driven through the REAL bridge.
  //
  // The Harness feature whose UI alias is "PTC mode" is what puts Raven inside a
  // `run_code` program, and it is the one path where a Task step has no result
  // card to ride. Rather than fabricating both sides, this composes the official
  // `run_code` tool (tools `mode: 'code'`) over an in-process `CodeRuntime` fake —
  // the same role the Harness's own `code-mode.spec.ts` uses — and lets the REAL
  // bridge run the REAL `tools/code-dispatch-log` waterfall and append the REAL
  // `tool/code-dispatch` event. The fake stands in only for the sandboxed
  // execution backend (the published worker runtime needs a built `worker.cjs`
  // this source-loaded composition has no cheap way to produce); every line of
  // Code Mode logic Raven depends on is the Harness's own.
  const { CodeRuntime } = await import(source('packages/code-runtime/code-runtime/src/index.ts')) as {
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
  const codeCtx = new Context()
  try {
    await codeCtx.plugin(SystemPromptModule.default)
    await codeCtx.plugin(ToolsModuleNs.default, { mode: 'code' })
    await codeCtx.plugin(BridgeRuntime)
    await codeCtx.plugin(Raven)
    const bridgeEvents: Array<{ type: string; seq: number; time: number; data: unknown }> = []
    const bridgeAgent = {
      id: 'raven-dsh-code-mode',
      session: {
        header: { cwd: compositionRoot },
        events: [] as unknown[],
        append(type: string, data: unknown) {
          bridgeEvents.push({ type, seq: bridgeEvents.length, time: 0, data })
        },
      },
    }
    const runtime = codeCtx.codeRuntime as BridgeRuntime
    // The program a model would write: one `raven_task` call from inside `run_code`.
    runtime.behavior = async request => ({
      logs: [],
      value: await request.bindings[0]!.functions.raven_task!({
        action: 'start',
        outcome: 'research',
        request: 'Verify Code Mode durability through the real bridge.',
      }),
    })
    const ran = await codeCtx.tools.execute({
      callId: 'raven-dsh-code-mode-1',
      name: ToolsModuleNs.RUN_CODE_NAME,
      arguments: { code: '// driven by the gate runtime', description: 'Start a Raven Task from a program' },
      agent: bridgeAgent,
      signal,
    })
    assert.equal(ran.isError, false, 'the official run_code bridge must dispatch raven_task from inside a program')
    const settle = bridgeEvents.find(event => event.type === 'tool/code-dispatch')
    assert.ok(settle, 'the Code Mode bridge no longer appends tool/code-dispatch; Raven restores no Code Mode step from a reloaded session')
    const settleData = settle.data as { name?: string; subCallId?: string; content?: Array<{ type: string; text?: string }> }
    assert.equal(settleData.name, 'raven_task', 'the settle event no longer carries the dispatched tool name; readDispatchTaskState() keys on it')
    const logged = settleData.content ?? []
    assert.equal(logged.length, 2, 'the real tools/code-dispatch-log waterfall did not attach the Task record next to the rendered content')
    assert.ok(
      String(logged[1]?.text).startsWith('<!-- dsh-raven-research/task-state '),
      'the durable log copy no longer carries the Raven Task record',
    )
    const codeTaskId = /(rvn-[a-f0-9]{12}-\d+)/.exec(JSON.stringify(logged))?.[1]
    assert.ok(codeTaskId, 'the logged record must name the Task the program started')
    // A resumed session rebuilds that step from the REAL appended event alone.
    // The call carries a `parent` token because this composition is `mode: 'code'`:
    // there, only a transport sub-dispatch may execute a native tool name, and a
    // model-direct call is denied as UNKNOWN_TOOL before any policy runs — which is
    // exactly the shape a resumed Code Mode session replays anyway.
    const resumed = await codeCtx.tools.execute({
      callId: 'raven-dsh-code-mode-2',
      name: 'raven_task',
      arguments: { action: 'status' },
      agent: { id: 'raven-dsh-code-mode-resumed', session: { events: [settle] } },
      signal,
      parent: Symbol('raven-dsh-code-mode-resume'),
    })
    assert.equal(resumed.isError, false, 'a Code Mode Task step must survive a session reload')
    assert.ok(
      textOf(resumed as { content: Array<{ type: string; text?: string }> }).includes(codeTaskId),
      'the restored Task must be the one the program worked on',
    )
  } finally {
    await codeCtx.fiber.dispose()
  }

  // The official Code Mode contract Raven now INHERITS by type, asserted against
  // the checkout under test. `src/plugin.ts` imports `CodeDispatchEventData`,
  // `CodeDispatchLog`, and the augmented `SessionEventMap` key set, so a rename
  // already breaks the build — these keep the DECLARATIONS those imports resolve
  // to from being reshaped underneath a published copy that still typechecks.
  const dispatchTypes = await readFile(join(root, 'packages/core/tools/src/types.ts'), 'utf8')
  assert.match(
    dispatchTypes,
    /declare module '@deepseek-ai\/dsh-session\/types' \{[\s\S]*?interface SessionEventMap \{[\s\S]*?'tool\/code-dispatch': CodeDispatchEventData/,
    "'tool/code-dispatch' is no longer declared into SessionEventMap as CodeDispatchEventData; CODE_DISPATCH_EVENT in src/plugin.ts must be restated against the new key",
  )
  assert.match(
    dispatchTypes,
    /export interface CodeDispatchStartEventData \{[\s\S]*?\bsubCallId: CallId[\s\S]*?\bname: string/,
    'CodeDispatchStartEventData no longer carries subCallId and name; the Raven dispatch reader and log listener key on both',
  )
  assert.match(
    dispatchTypes,
    /export interface CodeDispatchEventData extends CodeDispatchStartEventData \{[\s\S]*?\bisError: boolean[\s\S]*?\bcontent: ContentBlock\[\]/,
    'CodeDispatchEventData no longer carries isError and content; readDispatchTaskState() in src/plugin.ts reads content off it',
  )
  const toolsIndex = await readFile(join(root, 'packages/core/tools/src/index.ts'), 'utf8')
  assert.match(
    toolsIndex,
    /'tools\/code-dispatch-log'\(this: Scoped<ToolRuntime>, dispatch: CodeDispatchLog, next: \(\) => Promise<ContentBlock\[\]>\): Promise<ContentBlock\[\]>/,
    'the tools/code-dispatch-log waterfall signature changed; the Raven listener in src/plugin.ts must be restated against the new payload',
  )
  assert.match(
    toolsIndex,
    /export interface CodeDispatchLog \{[\s\S]*?\bsubCallId: CallId[\s\S]*?\bname: string[\s\S]*?\bisError: boolean[\s\S]*?\bcontent: ContentBlock\[\]/,
    'CodeDispatchLog no longer carries subCallId, name, isError, and content; the Raven listener pairs its pending record by subCallId and appends to content',
  )
  assert.match(
    toolsIndex,
    /export \{ CodeRunFailedError, RUN_CODE_NAME \} from '\.\/code-mode\.ts'/,
    'RUN_CODE_NAME is no longer re-exported from @deepseek-ai/dsh-tools; this gate drives the official run_code tool by that name',
  )

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

  // The browser half's slot contract, checked against the Harness under test.
  //
  // `src/client/slot-contract.ts` restates an augmentation Raven cannot import,
  // and the published copy of the declaring package lags this checkout: at
  // 0.1.0-rc.6 the slot is `kind: 'list'`, here it is `kind: 'keyed'` with the
  // settings namespace as the key. A card registered under the wrong shape
  // compiles and then never renders, with nothing logged anywhere — so the drift
  // has to break this gate instead of the browser.
  const slotContract = await readFile(
    join(root, 'packages/client/ui-settings-plugins/src/client/slot-contract.ts'),
    'utf8',
  )
  assert.match(
    slotContract,
    /'settings\.plugin\.item':\s*\{\s*kind:\s*'keyed';\s*scope:\s*'root'/,
    'the settings.plugin.item slot is no longer a root-scoped keyed slot; src/client/slot-contract.ts must be restated',
  )
  assert.match(
    slotContract,
    /keyed by the settings namespace/,
    'the settings.plugin.item key is no longer the settings namespace; the card would register under a key the tab never dispatches',
  )

  // The card chrome the Harness renders for its own plugins, checked for the two
  // properties Raven's hand-drawn copy has to share with it. The tab renders
  // every card into one `<ul>`, so a root element that is not an `<li>` reads as
  // a different kind of object in that list, and neither the browser nor a test
  // would ever say so.
  const harnessCard = await readFile(
    join(root, 'packages/client/ui-settings-plugins/src/client/PluginCard.tsx'),
    'utf8',
  )
  assert.match(
    harnessCard,
    /<li className=\{clsx\(css\.card/,
    'the Harness plugin card is no longer rooted on an <li>; src/client/Card.tsx must be restated',
  )

  // The browser locale contract, likewise restated in `src/client/slot-contract.ts`.
  // Registration takes every shipped locale in ONE call, so a dictionary set that
  // is missing one is refused outright rather than falling back — and the card
  // would then render its own dictionary keys at a reader.
  const localeSettings = await readFile(join(root, 'packages/client/locale/src/locale-settings.ts'), 'utf8')
  assert.match(
    localeSettings,
    /export const LOCALE_IDS = \['zh', 'en'\] as const/,
    'the shipped locale set changed; RavenLocaleId in src/client/slot-contract.ts must be restated',
  )
  const localeRuntime = await readFile(join(root, 'packages/client/locale/src/client/index.ts'), 'utf8')
  assert.match(
    localeRuntime,
    /register<N extends keyof LocaleNamespaceMap & string>\(ns: N, dicts: Record<LocaleId, LocaleDictOf<N>>\)/,
    'the typed locale registration signature changed; RavenLocaleRuntime in src/client/slot-contract.ts must be restated',
  )

  // The settings schema service, likewise restated. This is the one that decides
  // whether a draft is acceptable, so a drift here would not break the card —
  // it would make it judge values by a contract the Host no longer honours.
  const schemaService = await readFile(join(root, 'packages/client/ui-settings/src/client/schema.ts'), 'utf8')
  for (const [member, signature] of [
    ['rehydrate', /rehydrate\(serialized: unknown\): SchemaNode/],
    ['validate', /validate\(schema: SchemaNode, draft: unknown\): string \| undefined/],
    ['nodeAtPath', /nodeAtPath\(root: SchemaNode, path: readonly string\[\]\): SchemaNode \| undefined/],
    ['hasPath', /hasPath\(value: unknown, path: readonly string\[\]\): boolean/],
  ] as const) {
    assert.match(
      schemaService,
      signature,
      `settingsSchema.${member} changed; RavenSettingsSchemaService in src/client/slot-contract.ts must be restated`,
    )
  }
  assert.match(
    schemaService,
    /super\(ctx, 'settingsSchema'\)/,
    'the settings schema service is no longer published as `settingsSchema`; the card injects that name',
  )

  // The card reads its own registered schema off the shared describe mirror,
  // because the per-namespace scope snapshot does not carry one.
  const scopeBinder = await readFile(join(root, 'packages/client/ui-settings/src/client/settings-scope.ts'), 'utf8')
  assert.match(
    scopeBinder,
    /describe\(\): SettingsDescribeFace/,
    'settingsScope.describe() is gone; the card has no other route to its namespace schema',
  )
  const namespaceWire = await readFile(join(root, 'packages/host/apiproxy/src/api/settings.schema.ts'), 'utf8')
  assert.match(
    namespaceWire,
    /settingsNamespaceViewSchema = z\.object\(\{[\s\S]*?\bschema: z\.unknown\(\)/,
    'settings.describe no longer carries a per-namespace schema envelope; the card could not derive its fields',
  )

  // What the envelope must still contain for the card to derive controls from
  // it: an object root whose properties carry union members as `const` nodes.
  // Asserted against the REAL Config, through the real serialize/rehydrate pair.
  const { default: Schemastery } = await import(source('vendor/schemastery/src/index.ts')) as {
    default: new (value: unknown) => { type: string; dict?: Record<string, { type: string; list?: { value?: unknown }[] }> }
  }
  const rehydrated = new Schemastery(JSON.parse(JSON.stringify(Raven.Config.toJSON())))
  assert.equal(rehydrated.type, 'object', 'the Raven Config no longer serializes as an object schema')
  assert.deepEqual(
    (rehydrated.dict?.proseLayout?.list ?? []).map(member => member.value),
    ['sentence-per-line', 'as-written'],
    'a union field no longer round-trips its const members; the card derives its choices from them',
  )

  console.log(`dsh compatibility: ${manifest.version}@${revision.slice(0, 12)}; clean real composition, prompt, web search discovery, web verification, tool execution, Code Mode state durability through the real run_code bridge, official Code Mode contract inheritance, failure-path recovery hinting, settings exposure, Profile Bundle composition, browser settings-card slot, chrome, and locale contracts, and disposal passed`)
} finally {
  await ctx.fiber.dispose()
  await rm(compositionRoot, { recursive: true, force: true })
}
