import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runProcess } from './process.js'

const checkout = process.env.DSH_CHECKOUT
if (checkout === undefined || checkout.trim().length === 0) {
  throw new Error('Set DSH_CHECKOUT to the DeepSeek Harness checkout under test.')
}
const loader = resolve('node_modules/tsx/dist/loader.mjs')
// Registered after tsx, so tsx transpiles it and the source it redirects to.
// Without it the Harness source under test resolves cordis to `vendor/cordis`'s
// BUILD while this gate imports its SOURCE, and the run holds two cordis
// modules; see `dsh-source-hooks.ts`.
const hooks = resolve('scripts/dsh-source-hooks.ts')
const test = resolve('scripts/verify-dsh.ts')
await runProcess(process.execPath, [
  '--import',
  pathToFileURL(loader).href,
  '--import',
  pathToFileURL(hooks).href,
  '--eval',
  `import(${JSON.stringify(pathToFileURL(test).href)})`,
], {
  cwd: process.cwd(),
  timeoutMs: 120_000,
  env: {
    ...process.env,
    DSH_CHECKOUT: resolve(checkout),
    TSX_TSCONFIG_PATH: resolve(checkout, 'tsconfig.json'),
  },
})
