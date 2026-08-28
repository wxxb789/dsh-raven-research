/**
 * Resolve identity-sensitive Cordis and System Prompt imports to Harness SOURCE.
 *
 * Cordis must be singular for service identity. System Prompt must be the target
 * build-time contract too, because Raven derives its section placement from the
 * target's exported sparse order table rather than a copied number.
 *
 * `verify-dsh.ts` deliberately loads the Harness from `src/`, because the point
 * of the gate is to check Raven against the checkout under test rather than
 * against whatever build happens to be lying next to it. Harness source files
 * import cordis by the bare specifier, and `vendor/cordis`'s `exports["."]`
 * points at `lib/index.js`, so without a hook one run holds TWO cordis modules:
 * the source copy `verify-dsh.ts` imports by path, and the built copy every
 * Harness source file resolves to. Service identity, `instanceof`, and the
 * fiber registry are all per-module, so that split makes the gate assert against
 * a composition no deployment ever runs.
 *
 * The loudest symptom is a hard failure rather than a subtle one: `FiberState`
 * is declared `export const enum` (`vendor/cordis/src/fiber.ts`), which
 * TypeScript erases at build, so `vendor/loader/src/index.ts` — which imports it
 * as a value — throws `does not provide an export named 'FiberState'` before any
 * assertion runs. Inside the Harness workspace the same import works because
 * everything there resolves to source.
 *
 * The hook is synchronous and in-thread (`registerHooks`, Node >= 22.15) so it
 * composes with the tsx loader registered ahead of it, which is what transpiles
 * both this file and the `.ts` it resolves to.
 * @module
 */

import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseConfigFileTextToJson } from 'typescript'

const checkout = process.env.DSH_CHECKOUT
if (checkout === undefined || checkout.trim().length === 0) {
  throw new Error('Set DSH_CHECKOUT to the DeepSeek Harness checkout under test.')
}

/** Runtime identities Raven must share with the source-loaded target composition. */
const CORDIS = '@deepseek-ai/cordis'
const SYSTEM_PROMPT = '@deepseek-ai/dsh-system-prompt'

/** Resolve Cordis through the checkout's own path map so package moves cannot fork it. */
const root = resolve(checkout)
const configFile = join(root, 'tsconfig.base.json')
const parsed = parseConfigFileTextToJson(configFile, readFileSync(configFile, 'utf8'))
const paths = (parsed.config as { compilerOptions?: { paths?: Record<string, unknown> } })
  .compilerOptions?.paths ?? {}
const sourceUrl = (packageName: string): string => {
  const candidates = paths[packageName]
  const mapped = Array.isArray(candidates) ? candidates[0] : undefined
  if (parsed.error !== undefined || typeof mapped !== 'string') {
    throw new Error(`Harness TypeScript path map has no source entry for ${packageName}`)
  }
  return pathToFileURL(join(root, mapped, 'index.ts')).href
}
const redirects = new Map([
  [CORDIS, sourceUrl(CORDIS)],
  [SYSTEM_PROMPT, sourceUrl(SYSTEM_PROMPT)],
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = redirects.get(specifier)
    return url === undefined ? nextResolve(specifier, context) : { url, shortCircuit: true }
  },
})
