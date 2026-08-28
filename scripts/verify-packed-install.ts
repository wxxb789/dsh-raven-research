import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runProcess } from './process.js'

const root = process.cwd()
// Invoke the already-running pnpm CLI directly. The PATH shim is a package-manager
// manager: under this gate's intentionally empty HOME it tries to download @pnpm/exe
// before packing, even when every manage-package-manager flag is false. npm_execpath
// points at the CLI that launched this script, so using Node on that file preserves the
// exact tool version without a registry-dependent bootstrap.
const inheritedPnpm = process.env.npm_execpath
const pnpmCommand = inheritedPnpm?.match(/\.[cm]?js$/) === null || inheritedPnpm === undefined
  ? 'pnpm'
  : process.execPath
const pnpmPrefix = [
  ...(pnpmCommand === process.execPath ? [inheritedPnpm as string] : []),
  // pnpm 11 defaults a packageManager version mismatch to "download"; this is
  // the documented bypass for a gate that must exercise the current CLI offline.
  '--pm-on-fail=ignore',
]
const temporary = await mkdtemp(join(tmpdir(), 'dsh-raven-packed-consumer-'))
const staging = join(temporary, 'staging')
const packed = join(temporary, 'packed')
const consumer = join(temporary, 'consumer')
const suppliedStore = process.env.RAVEN_PACK_STORE_DIR?.trim()
if (suppliedStore !== undefined && suppliedStore.length > 0 && !isAbsolute(suppliedStore)) {
  throw new Error('RAVEN_PACK_STORE_DIR must be an absolute path')
}
// CI uses a fresh store and the registry. A mirrored/offline workstation may point at
// a pre-populated content-addressable store without linking the consumer to this repo.
const isolatedStore = suppliedStore === undefined || suppliedStore.length === 0
  ? join(temporary, 'pnpm-store')
  : suppliedStore
const suppliedCache = process.env.RAVEN_PACK_CACHE_DIR?.trim()
if (suppliedCache !== undefined && suppliedCache.length > 0 && !isAbsolute(suppliedCache)) {
  throw new Error('RAVEN_PACK_CACHE_DIR must be an absolute path')
}
const pnpmCache = suppliedCache === undefined || suppliedCache.length === 0
  ? join(temporary, 'npm-cache')
  : suppliedCache
const isolatedHome = join(temporary, 'home')
const userConfig = join(isolatedHome, '.npmrc')
const expectedFiles = [
  'cordis.patch.yml',
  'examples/agent-row.cordis.yml',
  'lib/client.js',
  'lib/client.js.map',
  'lib/index.d.ts',
  'lib/index.js',
  // The `dsh-raven-install-preset` bin, and the preset it installs. The bin is
  // built rather than run through tsx: an installed consumer has no TypeScript
  // loader. The two preset files ARE the mode, so a tarball missing them ships
  // an installer with nothing to install.
  'lib/install-preset.js',
  'LICENSE',
  // The roster entry, and Raven's row as a FRAGMENT the installer appends to a
  // base preset's own text. Not a whole composition: a preset's
  // `agent.cordis.yml` is the entire agent — persona, tools, shell — so shipping
  // one would either boot an agent with no persona or carry a copy of someone
  // else's composition that drifts silently. Both files are needed at install
  // time, so a tarball missing either ships an installer that cannot run.
  'presets/raven/agent.cordis.yml',
  'presets/raven/preset.yml',
  'package.json',
  'README.md',
  'README.zh.md',
]

function isolatedPnpmEnv(): NodeJS.ProcessEnv {
  const inherited = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP'] as const
  const env: NodeJS.ProcessEnv = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    npm_config_userconfig: userConfig,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_cache: pnpmCache,
    npm_config_cache_dir: pnpmCache,
    pnpm_config_cache_dir: pnpmCache,
    npm_config_store_dir: isolatedStore,
    pnpm_config_store_dir: isolatedStore,
    ...(process.env.RAVEN_PACK_OFFLINE === '1'
      ? { npm_config_offline: 'true', NPM_CONFIG_OFFLINE: 'true' }
      : {}),
    // Never let the isolated run self-provision a package manager. `packageManager`
    // pins pnpm, the isolated HOME has no previously downloaded copy, and pnpm
    // therefore fetches `pnpm` from whatever registry the injected user config
    // names — which on a mirrored network answers 401 for it and fails a gate that
    // has nothing to do with package management. The repository .npmrc and the
    // `--config` flag both say the same thing, but only this env var survives
    // RAVEN_PACK_USERCONFIG replacing the user layer, which is the whole point of
    // that hook: the gate must not depend on what the injected config happens to say.
    npm_config_manage_package_manager_versions: 'false',
    NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
    // And never let it check whether a newer pnpm exists. The update notifier
    // keeps its "last checked" stamp in the user's home, so an isolated HOME is
    // always overdue and every run asks the registry for the `pnpm` package —
    // which on a mirror that does not serve it answers 401 and fails the gate
    // before a single byte of Raven is packed. The gate tests a tarball, not the
    // freshness of the tool that builds it.
    npm_config_update_notifier: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  }
  for (const key of inherited) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

/*
 * Residual barrier, recorded because it costs an hour to rediscover.
 *
 * An isolated HOME makes pnpm's packageManager mismatch handler try to download
 * `@pnpm/exe` before packing. `manage-package-manager-versions=false` is not enough
 * in pnpm 11.22; the CLI's documented `--pm-on-fail=ignore` switch is. Every child
 * invocation uses that switch and the inherited `npm_execpath`, so the gate tests
 * the exact already-running pnpm without a registry-dependent bootstrap. Registry
 * access remains intentional only for installing the packed consumer's peers.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

await mkdir(staging, { recursive: true })
await mkdir(packed, { recursive: true })
await mkdir(consumer, { recursive: true })
await mkdir(isolatedHome, { recursive: true })
// The consumer install reaches a registry for Raven's peers. RAVEN_PACK_USERCONFIG
// lets a deployment behind a mirror supply its own credentials without either
// storing them here or inheriting the developer's whole npm configuration.
const inheritedUserConfig = process.env.RAVEN_PACK_USERCONFIG
if (inheritedUserConfig !== undefined && inheritedUserConfig.trim().length > 0) {
  await cp(inheritedUserConfig, userConfig)
} else {
  await writeFile(userConfig, [
    'registry=https://registry.npmjs.org/',
    'manage-package-manager-versions=false',
    'package-manager-strict=false',
    '',
  ].join('\n'))
}
const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: { client?: unknown }
}
// A Harness deployment supplies Raven's peers; the clean consumer models that by
// installing them at the versions this repository builds and tests against.
const peerSpecifiers = Object.keys(rootManifest.peerDependencies ?? {}).map((peer) => {
  const pinned = rootManifest.devDependencies?.[peer]
  if (pinned === undefined) throw new Error(`peer "${peer}" has no pinned devDependency to install`)
  return `${peer}@${pinned}`
})
// These are peers of the Harness packages rather than Raven. Pinning them explicitly
// keeps ^0.1.0-rc.6 from floating to a later prerelease in a fresh consumer. The
// direct dsh-agent pin is the one source of truth for the Harness package RC.
const harnessRuntimeVersion = rootManifest.devDependencies?.['@deepseek-ai/dsh-agent']
if (harnessRuntimeVersion === undefined) throw new Error('dsh-agent has no pinned devDependency')
for (const peer of [
  'dsh-attachment',
  'dsh-brand',
  'dsh-code-runtime',
  'dsh-invariants',
  'dsh-scope',
  'dsh-timeout',
  'dsh-typert-protocol',
  'dsh-user-approval',
]) {
  peerSpecifiers.push(`@deepseek-ai/${peer}@${harnessRuntimeVersion}`)
}
try {
  for (const file of [
    '.npmignore',
    '.npmrc',
    'cordis.patch.yml',
    'LICENSE',
    'README.md',
    'README.zh.md',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'tsdown.config.ts',
  ]) {
    await cp(join(root, file), join(staging, file))
  }
  await cp(join(root, 'src'), join(staging, 'src'), { recursive: true })
  await cp(join(root, 'examples'), join(staging, 'examples'), { recursive: true })
  await cp(join(root, 'presets'), join(staging, 'presets'), { recursive: true })
  await cp(join(root, 'scripts'), join(staging, 'scripts'), { recursive: true })
  await symlink(join(root, 'node_modules'), join(staging, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')

  const packedResult = await runProcess(pnpmCommand, [...pnpmPrefix,
    '--config.manage-package-manager-versions=false',
    'pack',
    '--pack-destination',
    packed,
    '--json',
  ], {
    cwd: staging,
    timeoutMs: 120_000,
    capture: true,
    env: isolatedPnpmEnv(),
  }).catch((error: unknown) => {
    // Name this failure, because its own error message points somewhere else.
    // pnpm provisions the package manager pinned by `packageManager` into the
    // isolated HOME and asks the registry for `@pnpm/exe` (or, for the update
    // check, for `pnpm`). A registry that does not serve those answers 401, and
    // the gate then reports an authorization failure for a step that has nothing
    // to do with Raven, packaging, or credentials for Raven's own dependencies.
    const detail = error instanceof Error ? error.message : String(error)
    if (!/@pnpm(%2F|\/)exe|registry\/pnpm: Unauthorized|Unauthorized - 401/.test(detail)) throw error
    throw new Error(
      'pnpm could not provision its own package manager inside the isolated HOME this gate uses,'
      + ' so packing never started. This is an environment limitation, not a defect in the tarball:'
      + ' the registry in use does not serve the package manager pinned by "packageManager".'
      + ' CI resolves from the public registry and runs this gate on every push. To check the packed'
      + ' contents from here, run `pnpm pack` in the repository and compare the printed file list'
      + ' against expectedFiles in this script. Underlying error: ' + detail,
      { cause: error },
    )
  })
  const start = packedResult.stdout.indexOf('{')
  const end = packedResult.stdout.lastIndexOf('}')
  assert.notEqual(start, -1, 'pnpm pack --json returned no JSON object')
  assert.notEqual(end, -1, 'pnpm pack --json returned no JSON object')
  const manifest = JSON.parse(packedResult.stdout.slice(start, end + 1)) as {
    filename?: unknown
    files?: Array<{ path?: unknown }>
  }
  const files = (manifest.files ?? [])
    .map(entry => entry.path)
    .filter((path): path is string => typeof path === 'string')
    .toSorted()
  assert.deepEqual(files, expectedFiles.toSorted(), 'publishable files differ from the exact allowlist')
  if (typeof manifest.filename !== 'string') throw new Error('pnpm pack returned no tarball filename')
  const tarball = isAbsolute(manifest.filename) ? manifest.filename : join(packed, manifest.filename)
  const builtFiles = await Promise.all([
    readFile(join(staging, 'lib', 'index.js'), 'utf8'),
    readFile(join(staging, 'lib', 'index.d.ts'), 'utf8'),
  ])
  assert.ok(builtFiles.every(file => file.length > 0), 'prepack did not build runtime and declaration outputs in staging')
  // The schema defaults the CONSUMER must see, taken from the source build rather
  // than written out by hand. A hand-maintained expectation is repaired by editing
  // it until it matches, which is how the duplicated Harness pin in verify-dsh.ts
  // drifted while both of its copies agreed with each other. Read from staging's own
  // `lib`, so the comparison is genuinely packed-against-source and a packaging skew
  // that changed a default would fail here with no literal to update.
  const sourceBuild = await import(pathToFileURL(join(staging, 'lib', 'index.js')).href) as {
    Config: (value: Record<string, unknown>) => Record<string, unknown>
  }
  const sourceDefaults = sourceBuild.Config({})
  assert.ok(
    Object.keys(sourceDefaults).length > 0,
    'the source build produced no settings defaults to compare the packed build against',
  )

  const localTarball = join(consumer, 'raven.tgz')
  await cp(tarball, localTarball)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'raven-clean-consumer',
    private: true,
    type: 'module',
  }, null, 2))
  // The tarball itself installs offline with nothing auto-installed: Raven ships
  // no runtime dependency of its own.
  await runProcess(pnpmCommand, [...pnpmPrefix,
    'add',
    './raven.tgz',
    '--offline',
    '--ignore-scripts',
    '--config.auto-install-peers=false',
    '--trust-lockfile',
    '--store-dir',
    isolatedStore,
  ], {
    cwd: consumer,
    timeoutMs: 120_000,
    env: isolatedPnpmEnv(),
  })
  // Then the deployment supplies the peers. Auto-install carries their own peers
  // (Cordis and its invariants), which is what a Harness deployment already has;
  // this install re-links the tree, so it has to run after the tarball, not before.
  if (peerSpecifiers.length > 0) {
    await runProcess(pnpmCommand, [...pnpmPrefix,
      'add',
      ...peerSpecifiers,
      ...(process.env.RAVEN_PACK_OFFLINE === '1' ? ['--offline'] : []),
      '--ignore-scripts',
      '--config.auto-install-peers=true',
      '--config.resolution-mode=lowest-direct',
      '--store-dir',
      isolatedStore,
    ], {
      cwd: consumer,
      timeoutMs: 180_000,
      env: isolatedPnpmEnv(),
    })
  }
  const consumerLock = await readFile(join(consumer, 'pnpm-lock.yaml'), 'utf8')
  // Require a token boundary before the drive letter so `https:/` is not
  // misclassified as drive `s:` when a registry records explicit tarball URLs.
  assert.doesNotMatch(consumerLock, /(?:^|[\s"'(])[A-Za-z]:[\\/]/m, 'consumer lockfile contains a Windows absolute path')
  const absoluteFileLink = /(?:file|link):(?:[A-Za-z]:)?[\\/]/i
  assert.match('file:C:\\vendor\\pkg', absoluteFileLink)
  assert.match('link:D:/cache/pkg', absoluteFileLink)
  assert.doesNotMatch('https://registry.npmjs.org/pkg.tgz', absoluteFileLink)
  assert.doesNotMatch(consumerLock, absoluteFileLink, 'consumer lockfile contains an absolute file/link path')
  assert.doesNotMatch(consumerLock, new RegExp(escapeRegExp(root), 'i'), 'consumer lockfile references the source repository')
  assert.doesNotMatch(consumerLock, new RegExp(escapeRegExp(temporary), 'i'), 'consumer lockfile references its machine-specific temp root')

  const packedBaseRoot = join(temporary, 'packed-base')
  const packedBase = join(packedBaseRoot, 'ptc')
  const packedInstallerHome = join(temporary, 'installer-home')
  await mkdir(packedBase, { recursive: true })
  await writeFile(join(packedBase, 'agent.cordis.yml'), '- id: persona\n  name: packed-test-persona\n')
  const packedInstaller = await runProcess(pnpmCommand, [
    ...pnpmPrefix, 'exec', 'dsh-raven-install-preset',
    '--base-root', packedBaseRoot, '--dry-run',
  ], {
    cwd: consumer,
    timeoutMs: 30_000,
    capture: true,
    env: { ...isolatedPnpmEnv(), DSH_CHECKOUT: '', DSH_HOME: packedInstallerHome },
  })
  assert.match(packedInstaller.stdout, /would install/, 'packed installer did not compose the supplied PTC base')

  await writeFile(join(consumer, 'verify.mjs'), `
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as Raven from 'dsh-raven-research'
assert.equal('default' in Raven, false)
assert.equal(Raven.name, 'raven-research')

// Isolation survives packing, and its guarantee is an ABSENCE, so the packed
// manifest is asserted NOT to declare a bundle. Declaring one is what makes
// 'dsh plugin add' append this package to a profile's bundles, which would apply
// the overlay below and give Raven a host-plane row: a settings namespace on a
// global settings page, plus the client bundle the web app loads for any package
// the composition names in a row. An installed consumer must contribute nothing
// until a session picks the Raven mode.
const require_ = createRequire(import.meta.url)
const installed = require_.resolve('dsh-raven-research/package.json')
const manifest = JSON.parse(readFileSync(installed, 'utf8'))
assert.equal(
  manifest.dsh?.bundle,
  undefined,
  'the packed manifest declares a bundle, which auto-applies the host row and breaks mode isolation',
)
// The overlay itself still ships: it is how a deployment that WANTS the settings
// card opts in, by pasting its row into the profile's own patch or booting with
// an explicit --patch. Unreachable-from-an-install is the failure this guards.
const patch = readFileSync(new URL('./cordis.patch.yml', new URL('file://' + installed.replaceAll('\\\\', '/'))), 'utf8')
assert.match(patch, /- insert:/)
assert.match(patch, /name: dsh-raven-research/)

// The browser half survives packing too: the manifest field the module scan
// matches on, and the artifact the ./client subpath points at. A platform other
// than 'web' would fail silently in the page, so it is asserted here instead.
assert.deepEqual(
  manifest.dsh?.client,
  ${JSON.stringify(rootManifest.dsh?.client)},
  'the packed client declaration differs from the source manifest',
)
assert.equal(manifest.exports['./client'], './lib/client.js')
const client = readFileSync(require_.resolve('dsh-raven-research/client'), 'utf8')
// Executed rather than string-matched: the bundler is free to reformat the
// banner, and only running it proves the artifact registers what it claims.
let registered
new Function('window', client)({ __ModuleLoader__: { load: (entry) => { registered = entry } } })
assert.equal(registered?.id, 'dsh-raven-research', 'the packed browser artifact must register under the package name')
assert.equal(typeof registered?.factory, 'function')

const tools = []
const sections = []
const injected = []
Raven.apply({
  tools: { register(value) { tools.push(value); return () => undefined } },
  systemPrompt: { section(value) { sections.push(value); return () => undefined } },
  inject(dependencies) { injected.push(dependencies); return () => undefined },
  get() { return undefined },
  on() { return () => undefined },
})
assert.equal(tools.length, 1)
assert.equal(tools[0].name, 'raven_task')
assert.equal(sections.length, 1)
assert.deepEqual(injected, [['settings']])
assert.equal(Raven.RAVEN_SETTINGS_NAMESPACE, 'raven-research')
// The expectation is the SOURCE build's own defaults, injected by the gate rather
// than restated here. Raven on this side is the PACKED tarball, so this compares
// packed against source and needs no hand-maintained copy to drift from.
assert.deepEqual(
  Raven.Config({}),
  ${JSON.stringify(sourceDefaults)},
  'the packed build resolves different settings defaults than the source build',
)
assert.deepEqual(Raven.SOURCE_DISCOVERY_MODES, ['seam', 'disabled'])
assert.equal(typeof Raven.renderLeads, 'function')
assert.equal(typeof Raven.renderVariants, 'function')
assert.equal(
  Raven.layoutProse('One holds. Another does not.', { layout: 'sentence-per-line', format: 'markdown' }),
  'One holds.\\nAnother does not.',
)
const agent = { id: 'packed-session', session: { events: [] } }
const signal = new AbortController().signal
const value = await tools[0].execute(
  { action: 'start', outcome: 'learning', grounding: 'none', request: 'Teach one concept.' },
  { agent, signal },
)
assert.equal(value.status, 'active')
// A deployment with no web capability must report discovery as unavailable rather
// than as an empty search the agent could read as "nothing exists".
const found = await tools[0].execute(
  { action: 'discover', taskId: value.state.taskId, queries: ['one angle', 'another angle'] },
  { agent, signal },
)
assert.match(found.leads.unavailable, /web search capability is not composed/)
assert.equal(found.state.limitations.length, 1)
// Likewise for drafting: no configured route must say so, never quietly draft.
const drafted = await tools[0].execute(
  { action: 'draft', taskId: value.state.taskId, instruction: 'Draft the opening.' },
  { agent, signal },
)
assert.match(drafted.variants.unavailable, /no Draft Variant route is configured/)
// The stored Artifact carries the Prose Layout the deployment configured.
const checkpoint = await tools[0].execute(
  {
    action: 'checkpoint',
    taskId: value.state.taskId,
    stage: 'draft',
    summary: 'A first useful explanation.',
    artifact: 'A concept holds. A second sentence explains it.',
  },
  { agent, signal },
)
assert.equal(checkpoint.state.latestArtifact, 'A concept holds.\\nA second sentence explains it.')
assert.equal(checkpoint.state.checkpoints[0].proseLayout, 'sentence-per-line')
console.log('packed install: isolated staged prepack, exact files, bundle manifest and patch, clean external install, import, apply, settings defaults, discovery and drafting degradation, prose layout, and tool execution passed')
`)
  await runProcess(process.execPath, ['verify.mjs'], {
    cwd: consumer,
    timeoutMs: 30_000,
    env: isolatedPnpmEnv(),
  })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
