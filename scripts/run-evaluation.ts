import { resolve } from 'node:path'

import { verifyEvaluationBaseline, verifyTrackedEvaluationBaselines, writeRawEvaluationArchive } from './evaluation-baseline.js'
import { checkEvaluationSuite } from './evaluation.js'
import { writeEvaluationReport } from './evaluation-report.js'
import { prepareEvaluationReview } from './evaluation-review.js'
import { runLiveEvaluation, type LiveEvaluationOptions } from './live-evaluation.js'

function usage(): string {
  return [
    'Raven evaluation suite',
    '',
    'Usage:',
    '  pnpm run eval -- check [evaluation-root]',
    '  pnpm run eval -- run --scenario <id> --out <path> [options]',
    '  pnpm run eval -- review --run <path> --seed <opaque-seed>',
    '  pnpm run eval -- report --run <path>',
    '  pnpm run eval -- archive --out <file> --run <run-root> [--run <run-root> ...]',
    '  pnpm run eval -- verify-baseline <manifest.json>',
    '  pnpm run eval -- verify-baselines --production',
    '',
    'Run options:',
    '  --checkout <path>          exact clean Harness checkout (or DSH_CHECKOUT)',
    '  --provider <id>            default: deepseek-official',
    '  --model <id>               default: deepseek-v4-flash',
    '  --reasoning-effort <id>    omitted means provider default',
    '  --max-tokens <n>           default: 8192',
    '  --order <arm-first>         vanilla-first (default) or raven-first',
    '  --credentials <path>        managed credentials read in place; never copied',
    '  --settings <path>           shared Harness settings read-only for both arms',
    '  --draft-route <p:m>         repeat at least twice for multi-model ablation',
    '  --fixture-model            keyless runner smoke; not product-quality evidence',
    '  --allow-dirty-harness      fixture-model smoke only; marks evidence non-promotable',
    '  --allow-dirty-raven        development live run only; marks evidence non-promotable',
    '',
    'check validates strict scenario manifests, assessor IDs, required coverage, and frozen fixture SHA-256 digests.',
    'run executes isolated ptc and ptc+Raven arms through the real Harness Agent/preset/session path.',
  ].join('\n')
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name)
  if (value === undefined || value.trim() === '') throw new Error(`run requires --${name}`)
  return value
}

function routeId(value: string, flag: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    throw new Error(`--${flag} contains unsafe or unsupported characters`)
  }
  return value
}

function runOptions(args: string[]): LiveEvaluationOptions {
  const values = new Map<string, string>()
  const draftRouteValues: string[] = []
  const switches = new Set<string>()
  const valueFlags = new Set([
    'scenario', 'out', 'checkout', 'provider', 'model', 'reasoning-effort', 'max-tokens', 'order',
    'credentials', 'settings', 'draft-route',
  ])
  const switchFlags = new Set(['fixture-model', 'allow-dirty-harness', 'allow-dirty-raven'])
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]
    if (raw === undefined || !raw.startsWith('--')) throw new Error(`unexpected run argument: ${String(raw)}`)
    const name = raw.slice(2)
    if (switchFlags.has(name)) {
      if (switches.has(name)) throw new Error(`duplicate run flag: --${name}`)
      switches.add(name)
      continue
    }
    if (!valueFlags.has(name)) throw new Error(`unknown run flag: --${name}`)
    if (values.has(name)) throw new Error(`duplicate run flag: --${name}`)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`)
    if (name === 'draft-route') draftRouteValues.push(value)
    else values.set(name, value)
    index += 1
  }
  const maxTokens = Number(values.get('max-tokens') ?? '8192')
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('--max-tokens must be a positive safe integer')
  const checkout = values.get('checkout') ?? process.env.DSH_CHECKOUT
  if (checkout === undefined || checkout.trim() === '') throw new Error('run requires --checkout or DSH_CHECKOUT')
  const order = values.get('order') ?? 'vanilla-first'
  if (order !== 'vanilla-first' && order !== 'raven-first') throw new Error('--order must be vanilla-first or raven-first')
  const draftRoutes = draftRouteValues.map((value) => {
    const separator = value.indexOf(':')
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error('--draft-route must use provider:model')
    }
    return {
      provider: routeId(value.slice(0, separator), 'draft-route provider'),
      model: routeId(value.slice(separator + 1), 'draft-route model'),
    }
  })
  if (new Set(draftRoutes.map(route => `${route.provider}\0${route.model}`)).size !== draftRoutes.length) {
    throw new Error('--draft-route values must be unique')
  }
  return {
    checkout: resolve(checkout),
    scenarioId: required(values, 'scenario'),
    provider: routeId(values.get('provider') ?? 'deepseek-official', 'provider'),
    model: routeId(values.get('model') ?? 'deepseek-v4-flash', 'model'),
    reasoningEffort: values.has('reasoning-effort')
      ? routeId(values.get('reasoning-effort') as string, 'reasoning-effort')
      : null,
    maxTokens,
    outputRoot: resolve(required(values, 'out')),
    fixtureModel: switches.has('fixture-model'),
    allowDirtyHarness: switches.has('allow-dirty-harness'),
    allowDirtyRaven: switches.has('allow-dirty-raven'),
    credentialsPath: values.has('credentials') ? resolve(values.get('credentials') as string) : null,
    settingsPath: values.has('settings') ? resolve(values.get('settings') as string) : null,
    order,
    draftRoutes,
  }
}

function reviewOptions(args: string[]): { run: string; seed: string } {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if ((flag !== '--run' && flag !== '--seed') || value === undefined || value.startsWith('--')) {
      throw new Error('review requires exactly --run <path> and --seed <opaque-seed>')
    }
    const name = flag.slice(2)
    if (values.has(name)) throw new Error(`duplicate review flag: ${flag}`)
    values.set(name, value)
  }
  return { run: resolve(required(values, 'run')), seed: required(values, 'seed') }
}

async function main(rawArgs: string[]): Promise<number> {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(usage() + '\n')
    return args.length === 0 ? 1 : 0
  }
  if (args[0] === 'check') {
    if (args.length > 2) throw new Error('check accepts only an optional evaluation root')
    const evaluationRoot = resolve(args[1] ?? 'evaluation')
    const [suite, baselines] = await Promise.all([
      checkEvaluationSuite(evaluationRoot),
      verifyTrackedEvaluationBaselines(evaluationRoot),
    ])
    const result = {
      ...suite,
      pass: suite.pass && baselines.pass,
      issues: [...suite.issues, ...baselines.issues],
      baselineManifests: baselines.manifests,
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return result.pass ? 0 : 1
  }
  if (args[0] === 'run') {
    const options = runOptions(args.slice(1))
    const result = await runLiveEvaluation(options)
    if (!result.outcomeComplete) {
      throw new Error('evaluation scenario did not reach its completion floor; evidence was preserved')
    }
    return 0
  }
  if (args[0] === 'review') {
    const options = reviewOptions(args.slice(1))
    process.stdout.write(await prepareEvaluationReview(options.run, options.seed) + '\n')
    return 0
  }
  if (args[0] === 'report') {
    if (args.length !== 3 || args[1] !== '--run' || args[2]?.startsWith('--')) {
      throw new Error('report requires exactly --run <path>')
    }
    const written = await writeEvaluationReport(resolve(args[2] as string))
    process.stdout.write(`${written.markdown}\n${written.json}\n`)
    return 0
  }
  if (args[0] === 'archive') {
    let output: string | undefined
    const runs: string[] = []
    for (let index = 1; index < args.length; index += 2) {
      const flag = args[index]
      const value = args[index + 1]
      if ((flag !== '--out' && flag !== '--run') || value === undefined || value.startsWith('--')) {
        throw new Error('archive requires --out <file> and one or more --run <run-root> values')
      }
      if (flag === '--out') {
        if (output !== undefined) throw new Error('archive accepts --out exactly once')
        output = resolve(value)
      } else runs.push(resolve(value))
    }
    if (output === undefined || runs.length === 0) throw new Error('archive requires --out and at least one --run')
    const sha256 = await writeRawEvaluationArchive(runs, output)
    process.stdout.write(JSON.stringify({ path: output, sha256, runs }, null, 2) + '\n')
    return 0
  }
  if (args[0] === 'verify-baselines') {
    if (args.length !== 2 || args[1] !== '--production') {
      throw new Error('verify-baselines requires exactly --production')
    }
    const result = await verifyTrackedEvaluationBaselines(resolve('evaluation'))
    const production = result.manifests.filter(manifest => manifest.pass && manifest.status === 'production')
    const output = {
      ...result,
      pass: result.pass && production.length === 1,
      issues: [
        ...result.issues,
        ...(production.length === 1 ? [] : [`release requires exactly one verified production baseline; found ${production.length}`]),
      ],
    }
    process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    return output.pass ? 0 : 1
  }
  if (args[0] === 'verify-baseline') {
    if (args.length !== 2) throw new Error('verify-baseline requires one manifest path')
    const result = await verifyEvaluationBaseline(resolve(args[1] as string))
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return result.pass ? 0 : 1
  }
  throw new Error(`unknown evaluation command: ${args[0]}`)
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`)
  process.exitCode = 2
}
