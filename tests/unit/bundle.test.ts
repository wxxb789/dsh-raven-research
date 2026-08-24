import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { name as pluginName } from '../../src/plugin.js'

function repoPath(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url))
}

function repoFile(relative: string): string {
  return readFileSync(repoPath(relative), 'utf8')
}

const manifest = JSON.parse(repoFile('package.json')) as {
  name: string
  files: string[]
  exports: Record<string, unknown>
  bin?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
}
const patch = repoFile('cordis.patch.yml')

interface PluginRow {
  readonly id?: string
  readonly name?: string
  readonly config: Record<string, string>
  readonly keys: readonly string[]
}

/**
 * Read the `key: value` pairs out of one of this repository's own composition
 * files, keeping each row's `config` block separate from the row itself.
 *
 * Deliberately not a YAML library. These four files are small, hand-written,
 * and owned by this repository, and the registry this package builds against
 * serves no typed YAML parser — a dependency added only to read them would be
 * more supply chain than the assertions are worth. What this must NOT do is
 * match raw text, because these files explain `agent-presets` and `isolate` in
 * their own comments and a substring search would match the explanation.
 * @param source - the composition file's text.
 * @returns one entry per `- id:` row, in file order.
 */
function readRows(source: string): PluginRow[] {
  const rows: PluginRow[] = []
  let current: { id?: string, name?: string, config: Record<string, string>, keys: string[] } | undefined
  // Indent of the `config:` key whose block is being read; deeper lines belong
  // to it, and the first line at or above it ends the block.
  let configIndent: number | undefined
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '')
    const text = line.trim()
    if (text.length === 0 || text.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const started = text.startsWith('- ')
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(started ? text.slice(2) : text)
    if (match === null) continue
    const key = match[1] ?? ''
    // Strip one layer of YAML quoting: `name: '@deepseek-ai/dsh-persona'` and
    // `name: dsh-legion` must compare equal to the same package name.
    const value = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
    if (started && key === 'id') {
      current = { config: {}, keys: [] }
      rows.push(current as unknown as PluginRow)
      configIndent = undefined
    }
    if (current === undefined) continue
    if (configIndent !== undefined && indent <= configIndent) configIndent = undefined
    if (key === 'config') {
      configIndent = indent
      continue
    }
    if (configIndent !== undefined) {
      current.config[key] = value
      continue
    }
    current.keys.push(key)
    if (key === 'id') current.id = value
    if (key === 'name') current.name = value
  }
  return rows
}

/** The bundle patch's inserted rows, parsed rather than string-matched. */
function insertedRows(): PluginRow[] {
  return readRows(patch)
}

describe('Opt-in host overlay', () => {
  it('declares NO bundle, because declaring one would break the isolation', () => {
    // This absence is the guarantee, so it is asserted rather than assumed.
    // `dsh plugin add` appends a package to `dsh.profile.bundles` precisely
    // BECAUSE its manifest declares `dsh.bundle.patch`; that would apply the
    // overlay below and give Raven a host-plane row. A host row registers the
    // settings namespace, and a settings page is global — a user in any other
    // mode would see a Raven card — and it decides the browser half too, since
    // the web app loads a package's client bundle only for a package the
    // composition names in a row.
    expect(manifest.dsh?.bundle).toBeUndefined()
  })

  it('still ships the overlay, because opting in must not require a checkout', () => {
    // The file is how a deployment that WANTS the settings card gets it: paste
    // its row into the profile's own patch, or boot with `--patch`. A shipped
    // file nobody applies is the whole design; a missing one would make the
    // opt-in path unreachable from an install.
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
  })

  it('inserts one row that names this package and this plugin id', () => {
    expect(patch).toContain('- insert:')
    expect(patch).toContain(`name: ${manifest.name}`)
    // The row id is the plugin's own name so an operator reading a composition
    // dump, a patch override, or an inventory row sees one identity.
    expect(patch).toContain(`- id: ${pluginName}`)
  })

  it('mounts the host ROLE, and only that', () => {
    // The bundle row exists for one thing a preset cannot keep alive: the
    // `raven-research` settings namespace, which is served only while something
    // serves it. Everything model-facing moved to the `raven` preset, so a host
    // row that still declared `both` would put `raven_task` back in the global
    // layer and give every mode a research tool it did not ask for.
    const rows = insertedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.config.role).toBe('host')
  })

  it('does not patch the agent-presets row to add a preset root', () => {
    // A patch can only replace a row's whole config by id, so naming
    // `agent-presets` here would restate its `default` and `roots` as a second
    // copy that silently overrides the base. The installer writes into
    // `$DSH_HOME/.agent-presets`, which that row already scans itself.
    //
    // Asserted on the PARSED rows: the reason above is written in this file's
    // comments, so a raw-text search would match the explanation and fail.
    for (const row of insertedRows()) {
      expect(row.id).not.toBe('agent-presets')
      expect(row.name ?? '').not.toContain('agent-presets')
    }
  })

  it('names no Harness package as a runtime dependency', () => {
    // A profile installs plugins with autoInstallPeers: false so peers fall
    // through to the running installation's single cordis instance. A Harness
    // package listed under `dependencies` would install a second copy whose
    // services the Harness cannot resolve.
    for (const specifier of Object.keys(manifest.dependencies ?? {})) {
      expect(specifier.startsWith('@deepseek-ai/')).toBe(false)
    }
    expect(Object.keys(manifest.peerDependencies ?? {})).toContain('@deepseek-ai/cordis')
  })
})

describe('Raven mode preset', () => {
  // A mode IS an agent preset directory that `@deepseek-ai/dsh-agent-presets`
  // discovers in `$DSH_HOME/.agent-presets`. This package ships only the roster
  // metadata: the COMPOSITION is generated at install time from the deployment's
  // own base preset, because a preset's `agent.cordis.yml` is the whole agent —
  // persona, tools, shell, compaction — and shipping a copy of someone else's
  // would put a 13 KB file here that drifts silently when they change it.
  /** The roster keys `preset.yml` publishes, ignoring its comment block. */
  const metadata = new Map(
    repoFile('presets/raven/preset.yml')
      .split(/\r?\n/)
      .map(line => /^([A-Za-z][\w-]*):\s*(.+)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => [match[1], match[2]] as const),
  )

  it('publishes a roster entry a person can choose between', () => {
    expect(metadata.get('name')?.length).toBeGreaterThan(0)
    expect(metadata.get('description')?.length).toBeGreaterThan(0)
    // Declared `order` is how the SHIPPED set reads by capability; an authored
    // preset claiming a slot in it would sort itself among presets it did not
    // ship with. Authored presets stay alphabetical.
    expect(metadata.has('order')).toBe(false)
  })

  it('ships Raven\'s row as a FRAGMENT, never a whole composition', () => {
    // The guard against regrowing the mistake this design corrects. What ships
    // is the row the installer appends to a base preset's text — so it must
    // carry Raven's row and must NOT carry a persona, a shell, or an include
    // pretending to be a whole agent.
    const fragment = repoFile('presets/raven/agent.cordis.yml')
    const rows = readRows(fragment)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe(manifest.name)
    expect(rows[0]?.config.role).toBe('agent')
    // Says so in its own text, because the file is reachable on disk and the
    // next reader must not mount it as a preset.
    expect(fragment).toContain('must not be mounted alone')
    expect(manifest.bin?.['dsh-raven-install-preset']).toBe('lib/install-preset.js')
  })

  it('publishes both preset files, because the installer has nothing without them', () => {
    // The failure this guards was observed, not imagined: with the row file
    // absent from the working tree, `files` still named it, and a `files` entry
    // matching nothing contributes nothing and says nothing — so `pnpm pack`
    // produced a tarball carrying the installer and no row for it to append.
    // Asserting the manifest alone would not have caught it, so this reads the
    // files off disk through the same paths the manifest publishes.
    for (const path of ['presets/raven/preset.yml', 'presets/raven/agent.cordis.yml']) {
      expect(manifest.files).toContain(path)
      expect(repoFile(path).length).toBeGreaterThan(0)
    }
  })
})

