/**
 * Resolve the Harness's own bare `@deepseek-ai/cordis` to Harness SOURCE.
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

import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const checkout = process.env.DSH_CHECKOUT
if (checkout === undefined || checkout.trim().length === 0) {
  throw new Error('Set DSH_CHECKOUT to the DeepSeek Harness checkout under test.')
}

/** The one specifier redirected. Everything else resolves normally. */
const CORDIS = '@deepseek-ai/cordis'

/** The same module `verify-dsh.ts` imports by path, so the run holds exactly one. */
const cordisSource = pathToFileURL(join(resolve(checkout), 'vendor/cordis/src/index.ts')).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== CORDIS) return nextResolve(specifier, context)
    return { url: cordisSource, shortCircuit: true }
  },
})
