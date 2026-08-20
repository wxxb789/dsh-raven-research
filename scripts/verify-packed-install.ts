import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { runProcess } from './process.js'

const root = process.cwd()
const temporary = await mkdtemp(join(tmpdir(), 'dsh-raven-packed-consumer-'))
const staging = join(temporary, 'staging')
const packed = join(temporary, 'packed')
const consumer = join(temporary, 'consumer')
const isolatedStore = join(temporary, 'pnpm-store')
const isolatedHome = join(temporary, 'home')
const userConfig = join(isolatedHome, '.npmrc')
const expectedFiles = [
  'examples/agent-row.cordis.yml',
  'lib/index.d.ts',
  'lib/index.js',
  'LICENSE',
  'package.json',
  'README.md',
]

function isolatedPnpmEnv(): NodeJS.ProcessEnv {
  const inherited = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP'] as const
  const env: NodeJS.ProcessEnv = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    npm_config_userconfig: userConfig,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_cache: join(temporary, 'npm-cache'),
    npm_config_store_dir: isolatedStore,
    pnpm_config_store_dir: isolatedStore,
  }
  for (const key of inherited) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

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
}
// A Harness deployment supplies Raven's peers; the clean consumer models that by
// installing them at the versions this repository builds and tests against.
const peerSpecifiers = Object.keys(rootManifest.peerDependencies ?? {}).map((peer) => {
  const pinned = rootManifest.devDependencies?.[peer]
  if (pinned === undefined) throw new Error(`peer "${peer}" has no pinned devDependency to install`)
  return `${peer}@${pinned}`
})
try {
  for (const file of [
    '.npmignore',
    '.npmrc',
    'LICENSE',
    'README.md',
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
  await symlink(join(root, 'node_modules'), join(staging, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')

  const packedResult = await runProcess('pnpm', [
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

  const localTarball = join(consumer, 'raven.tgz')
  await cp(tarball, localTarball)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'raven-clean-consumer',
    private: true,
    type: 'module',
  }, null, 2))
  // The tarball itself installs offline with nothing auto-installed: Raven ships
  // no runtime dependency of its own.
  await runProcess('pnpm', [
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
    await runProcess('pnpm', [
      'add',
      ...peerSpecifiers,
      '--ignore-scripts',
      '--config.auto-install-peers=true',
      '--store-dir',
      isolatedStore,
    ], {
      cwd: consumer,
      timeoutMs: 180_000,
      env: isolatedPnpmEnv(),
    })
  }
  const consumerLock = await readFile(join(consumer, 'pnpm-lock.yaml'), 'utf8')
  assert.doesNotMatch(consumerLock, /[A-Za-z]:[\\/]/, 'consumer lockfile contains a Windows absolute path')
  assert.doesNotMatch(consumerLock, /(?:file|link):\//, 'consumer lockfile contains a POSIX absolute file/link path')
  assert.doesNotMatch(consumerLock, new RegExp(escapeRegExp(root), 'i'), 'consumer lockfile references the source repository')
  assert.doesNotMatch(consumerLock, new RegExp(escapeRegExp(temporary), 'i'), 'consumer lockfile references its machine-specific temp root')

  await writeFile(join(consumer, 'verify.mjs'), `
import assert from 'node:assert/strict'
import * as Raven from 'dsh-raven-research'
assert.equal('default' in Raven, false)
assert.equal(Raven.name, 'raven-research')
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
assert.deepEqual(Raven.Config({}), {
  sourceVerification: 'remote',
  sourceCheckTimeoutMs: 0,
  sourceDiscovery: 'seam',
  searchMaxQueries: 4,
  searchMaxResults: 8,
  searchTimeoutMs: 30000,
})
assert.deepEqual(Raven.SOURCE_DISCOVERY_MODES, ['seam', 'disabled'])
assert.equal(typeof Raven.renderLeads, 'function')
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
console.log('packed install: isolated staged prepack, exact files, isolated install, import, apply, settings defaults, discovery degradation, and tool execution passed')
`)
  await runProcess(process.execPath, ['verify.mjs'], {
    cwd: consumer,
    timeoutMs: 30_000,
    env: isolatedPnpmEnv(),
  })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
