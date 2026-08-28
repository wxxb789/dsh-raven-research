import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

interface Manifest {
  readonly version?: string
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly dsh?: { readonly client?: { readonly external?: readonly string[] } }
}

function installedManifest(specifier: string): Manifest {
  return JSON.parse(readFileSync(require.resolve(`${specifier}/package.json`), 'utf8')) as Manifest
}

const own = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as Manifest

function major(spec: string): number {
  const found = /(\d+)\./.exec(spec)
  if (found?.[1] === undefined) throw new Error(`cannot read a major version out of ${spec}`)
  return Number(found[1])
}

describe('React alignment with the shell', () => {
  it('leaves baseline shell modules implicit in the client manifest', () => {
    expect(own.dsh?.client?.external).toBeUndefined()
  })

  it('develops and typechecks against one React major', () => {
    const implementation = major(own.devDependencies?.react ?? '')
    expect(major(installedManifest('react').version ?? '')).toBe(implementation)
    expect(major(own.devDependencies?.['@types/react'] ?? '')).toBe(implementation)
    expect(major(installedManifest('@types/react').version ?? '')).toBe(implementation)
  })

  it('ships no React copy of its own', () => {
    expect(own.peerDependencies?.react).toBeUndefined()
    expect(own.dependencies?.react).toBeUndefined()
  })
})
