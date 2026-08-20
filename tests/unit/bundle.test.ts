import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { name as pluginName } from '../../src/plugin.js'

function repoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
}

const manifest = JSON.parse(repoFile('package.json')) as {
  name: string
  files: string[]
  exports: Record<string, unknown>
  dsh?: { bundle?: { patch?: string } }
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
}
const patch = repoFile('cordis.patch.yml')

describe('Profile Bundle declaration', () => {
  it('declares the one manifest field the profile composer reads', () => {
    // `loadProfile` reads exactly `dsh.bundle.patch`, joins it to the package
    // directory, and parses that YAML. There is nothing else to a bundle.
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('ships the patch in the published tarball', () => {
    // A manifest field pointing at a file `files` omits produces a bundle that
    // resolves in the repository and fails on every install.
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
