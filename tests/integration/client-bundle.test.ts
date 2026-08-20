import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const PACKAGE_NAME = 'dsh-raven-research'

/**
 * Specifiers the browser shell seeds into its module table. Anything else the
 * artifact asks for is a guaranteed runtime throw, and the loader raises it at
 * materialization — long after the page decided the plugin loaded fine.
 */
const SHELL_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

const artifactPath = fileURLToPath(new URL('../../lib/client.js', import.meta.url))
let artifact: string
try {
  artifact = readFileSync(artifactPath, 'utf8')
} catch {
  throw new Error(
    `lib/client.js is missing. The browser half is a build artifact, so this suite runs after \`pnpm run build\`.`,
  )
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; files: string[]; exports: Record<string, unknown>; dsh?: Record<string, unknown> }

interface LoadedEntry {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/** Evaluate the artifact the way the browser shell does: it only registers a factory. */
function loadArtifact(): LoadedEntry {
  const loaded: LoadedEntry[] = []
  runInNewContext(artifact, {
    window: { __ModuleLoader__: { load: (entry: LoadedEntry) => { loaded.push(entry) } } },
  })
  const entry = loaded[0]
  if (loaded.length !== 1 || entry === undefined) {
    throw new Error(`the artifact registered ${loaded.length} entries; exactly one is expected`)
  }
  return entry
}

describe('browser half manifest', () => {
  it('declares the web platform, which is what the module scan matches on', () => {
    // Anything but 'web' caches a never-expiring "not a client row" verdict, so
    // the plugin simply does not appear, with no error anywhere.
    expect(manifest.dsh?.client).toEqual({ platform: 'web' })
  })

  it('exports the ./client subpath the scan requires and ships the file', () => {
    // A dsh.client declaration with no ./client export throws loudly at boot.
    expect(manifest.exports['./client']).toBe('./lib/client.js')
    expect(manifest.files).toContain('lib')
  })
})

describe('browser half artifact', () => {
  it('registers exactly one entry under the PACKAGE name', () => {
    // The shell keys its boot entry on the package name, not on the Cordis
    // plugin name this module exports.
    expect(loadArtifact().id).toBe(PACKAGE_NAME)
    expect(manifest.name).toBe(PACKAGE_NAME)
  })

  it('runs no module body until the factory is materialized', () => {
    // Evaluating the script must only register. A side effect at script scope
    // would run before the shell has a module table to answer with.
    let materialized = false
    runInNewContext(artifact, {
      window: {
        __ModuleLoader__: {
          load: () => { materialized = true },
        },
      },
    })
    expect(materialized).toBe(true)
  })

  it('asks only for specifiers the shell module table can answer', () => {
    const asked = new Set<string>()
    for (const match of artifact.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      const specifier = match[1]
      if (specifier !== undefined) asked.add(specifier)
    }
    expect(asked.size).toBeGreaterThan(0)
    for (const specifier of asked) expect(SHELL_MODULES).toContain(specifier)
  })

  it('pulls in no Node built-in and no Host-only code', () => {
    // Substring matching would flag this repository's own prose, so the assertion
    // is on what the artifact DOES: what it requires, and whether Host-only
    // symbols were inlined through an import chain the card does not need.
    expect(artifact).not.toMatch(/require\(\s*["']node:/)
    expect(artifact).not.toContain('createRavenEngine')
    expect(artifact).not.toContain('ACTION_FIELDS')
    expect(artifact).not.toContain('RAVEN_PROMPT')
    expect(artifact).not.toContain('settingsNamespace')
  })

  it('materializes to a Cordis plugin that registers the card under the namespace key', () => {
    const stub = (specifier: string): unknown => {
      if (specifier === '@deepseek-ai/dsh-client-runtime/client') {
        // The one shell module the card actually calls into. A bare {} here
        // would only prove the artifact never used it.
        return {
          createSnapshotStore: (initial: unknown) => {
            let state = initial
            return {
              getSnapshot: () => state,
              subscribe: () => () => undefined,
              set: (next: unknown) => { state = next },
              update: () => undefined,
            }
          },
        }
      }
      if (SHELL_MODULES.has(specifier)) return {}
      throw new Error(`unexpected specifier ${specifier}`)
    }
    const module = loadArtifact().factory(stub)
    expect(module.name).toBe('raven-research/client')
    expect(module.inject).toEqual(['slots', 'settingsScope'])
    expect(module.RAVEN_NAMESPACE).toBe('raven-research')

    const registered: Array<Record<string, unknown>> = []
    const bound: Array<Record<string, unknown>> = []
    const scope = {
      getSnapshot: () => ({ status: 'loading', value: undefined, user: {}, writable: false, mode: 'host' }),
      subscribe: () => () => undefined,
      set: async () => undefined,
      unset: async () => undefined,
    }
    const ctx = {
      effect: () => undefined,
      settingsScope: { bind: (spec: Record<string, unknown>) => { bound.push(spec); return scope } },
      slots: {
        inject: (_name: string, body: () => Iterator<unknown>) => {
          const iterator = body()
          while (iterator.next().done !== true) { /* drain the registration generator */ }
        },
        register: (options: Record<string, unknown>) => {
          registered.push(options)
          return () => undefined
        },
      },
    }
    ;(module.apply as (ctx: unknown) => void)(ctx)

    expect(bound).toEqual([{ namespace: 'raven-research' }])
    expect(registered).toHaveLength(1)
    // The tab pairs a served namespace with a card registered under the same
    // key. A mismatch drops the card silently.
    expect(registered[0]?.name).toBe('settings.plugin.item')
    expect(registered[0]?.key).toBe('raven-research')
    expect(typeof registered[0]?.inject).toBe('function')
  })
})
