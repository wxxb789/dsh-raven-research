import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * React alignment with the Harness browser shell.
 *
 * The card is not bundled with a React of its own: `react` and
 * `react/jsx-runtime` are seeded into the shell's module table, and the artifact
 * only asks for them. So the React this package develops and typechecks against
 * is a claim about a runtime it does not ship, and nothing in a normal build
 * checks that claim — the repository sets `strict-peer-dependencies=false`, so a
 * drift installs silently, typechecks against the wrong `@types/react`, and only
 * appears as a runtime error in the page.
 *
 * The range is not restated here. `@deepseek-ai/dsh-client-ui-settings` and
 * `@deepseek-ai/dsh-client-ui-settings-plugins` — the two official packages that
 * own the tab this card renders into — declare `react` as a peer dependency, and
 * that declaration is the Harness's own statement of what the shell provides.
 * Reading it means a Harness upgrade moves this assertion by itself.
 */

const require = createRequire(import.meta.url)

/** The published packages whose declared `react` peer range describes the shell. */
const AUTHORITIES = [
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
] as const

interface Manifest {
  readonly version?: string
  readonly devDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
}

function manifest(specifier: string): Manifest {
  return JSON.parse(readFileSync(require.resolve(`${specifier}/package.json`), 'utf8')) as Manifest
}

const own = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as Manifest

/** The leading numeric component of a version or of a `^`/`~` range. */
function major(spec: string): number {
  const found = /(\d+)\./.exec(spec)
  if (found?.[1] === undefined) throw new Error(`cannot read a major version out of ${spec}`)
  return Number(found[1])
}

describe('React alignment with the shell', () => {
  it('reads a react peer range from every authority', () => {
    // Without this the majors below would compare nothing against nothing.
    for (const specifier of AUTHORITIES) {
      expect(manifest(specifier).peerDependencies?.react).toMatch(/^\^\d+\./)
    }
  })

  it('agrees with itself about which React the shell provides', () => {
    const declared = AUTHORITIES.map(specifier => manifest(specifier).peerDependencies?.react ?? '')
    // Two packages naming different Reacts would make "the shell's React"
    // ambiguous, and this suite would be asserting against a coin flip.
    expect(new Set(declared.map(major)).size).toBe(1)
  })

  it('develops against the React major the shell provides', () => {
    const shell = major(manifest(AUTHORITIES[0]).peerDependencies?.react ?? '')
    // The declared devDependency, so a drift is caught by reading the manifest
    // and not only by whatever happens to be installed in this checkout.
    expect(major(own.devDependencies?.react ?? '')).toBe(shell)
    expect(major(manifest('react').version ?? '')).toBe(shell)
  })

  it('typechecks against the React major the shell provides', () => {
    // A card compiled against a newer `@types/react` accepts props and element
    // shapes the running React rejects, and the build stays green throughout.
    const shell = major(manifest(AUTHORITIES[0]).peerDependencies?.react ?? '')
    expect(major(own.devDependencies?.['@types/react'] ?? '')).toBe(shell)
    expect(major(manifest('@types/react').version ?? '')).toBe(shell)
  })

  it('ships no React of its own', () => {
    // React reaches the card through the shell module table. Declaring it as a
    // real dependency would install a second copy into a profile and invite a
    // bundler to inline it.
    expect(own.peerDependencies?.react).toBeUndefined()
    expect((own as { dependencies?: Record<string, string> }).dependencies?.react).toBeUndefined()
  })
})
