import { createHash } from 'node:crypto'
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  decodeEvaluationScenario,
  EVALUATION_EXECUTION_TOOL_ALLOWLIST,
  normalizeEvaluationToolsSdk,
  type EvaluationUsage,
} from './evaluation.js'
import { runProcess } from './process.js'

export interface EvaluationDraftRoute {
  provider: string
  model: string
}

export type LiveEvaluationCondition = 'vanilla' | 'raven' | 'raven-single' | 'raven-multi'

export interface LiveEvaluationOptions {
  checkout: string
  scenarioId: string
  provider: string
  model: string
  reasoningEffort: string | null
  maxTokens: number
  outputRoot: string
  fixtureModel: boolean
  allowDirtyHarness: boolean
  allowDirtyRaven: boolean
  credentialsPath: string | null
  settingsPath: string | null
  order: 'vanilla-first' | 'raven-first'
  draftRoutes: EvaluationDraftRoute[]
}

interface PreparedArm {
  home: string
  output: string
  workspace: string
  configPath: string
  initialWorkspaceSha256: string
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function modelVisiblePath(source: { origin: string; uri: string; path: string }): string {
  if (source.origin !== 'local' && source.origin !== 'llm-wiki') return source.path
  try {
    const pathname = decodeURIComponent(new URL(source.uri).pathname).replaceAll('\\', '/')
    const marker = '/workspace/'
    if (pathname.startsWith(marker)) {
      const relativePath = pathname.slice(marker.length)
      if (relativePath !== '' && !relativePath.split('/').includes('..')) return relativePath
    }
  } catch {}
  return source.path
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

const SAFE_OUTPUT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Atomically reserve one immutable direct child of .tmp/evaluation. */
export async function safeEvaluationOutputPath(value: string): Promise<string> {
  const root = resolve('.tmp', 'evaluation')
  const candidate = resolve(value)
  const id = relative(root, candidate)
  if (!SAFE_OUTPUT_ID.test(id) || dirname(candidate) !== root) {
    throw new Error('evaluation --out must be exactly .tmp/evaluation/<safe-run-id>')
  }
  await mkdir(root, { recursive: true })
  const rootInfo = await lstat(root)
  if (rootInfo.isSymbolicLink()) throw new Error('evaluation output root .tmp/evaluation must not be a symlink')
  const realRoot = await realpath(root)
  const reserved = resolve(realRoot, id)
  try {
    await mkdir(reserved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`evaluation output already exists; choose a new immutable run id: ${id}`)
    }
    throw error
  }
  return reserved
}

export function hasControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
}

export async function treeDigest(root: string): Promise<string> {
  const entries: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error(`evaluation evidence must not contain symlinks: ${relative(root, path)}`)
      if (metadata.isDirectory()) await visit(path)
      else if (metadata.isFile()) {
        const relativePath = relative(root, path).replaceAll('\\', '/')
        if (hasControlCharacters(relativePath)) throw new Error(`evaluation evidence path contains control characters: ${relativePath}`)
        entries.push(`${relativePath}\0${digest(await readFile(path))}`)
      }
      else throw new Error(`evaluation evidence must contain only regular files and directories: ${relative(root, path)}`)
    }
  }
  await visit(root)
  return digest(entries.join('\n'))
}

const SENSITIVE_CREDENTIAL_KEY = /(?:api[_-]?key|token|secret|password|credential|private[_-]?key)/iu

function collectSensitiveLeaves(value: unknown, key: string, into: string[]): void {
  if (typeof value === 'string') {
    if (SENSITIVE_CREDENTIAL_KEY.test(key) && value.length >= 4) into.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveLeaves(item, key, into)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) {
      collectSensitiveLeaves(item, childKey, into)
    }
  }
}

function yamlCredentialValues(content: string): string[] {
  const lines = content.split(/\r?\n/u)
  const values: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)([A-Za-z0-9._/-]+):\s*(.*?)\s*$/u.exec(lines[index] ?? '')
    if (match === null || !SENSITIVE_CREDENTIAL_KEY.test(match[2] ?? '')) continue
    const scalar = match[3] ?? ''
    if (/^[|>][+-]?$/u.test(scalar)) {
      const indent = (match[1] ?? '').length
      const block: string[] = []
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? ''
        const nextIndent = /^\s*/u.exec(next)?.[0].length ?? 0
        if (next.trim() !== '' && nextIndent <= indent) break
        index += 1
        block.push(next.slice(Math.min(nextIndent, indent + 2)))
      }
      const joined = scalar.startsWith('>') ? block.join(' ').trim() : block.join('\n').trimEnd()
      if (joined.length >= 4) values.push(joined)
      continue
    }
    const unquoted = /^(?:"([\s\S]*)"|'([\s\S]*)')$/u.test(scalar)
      ? scalar.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2')
      : scalar.replace(/\s+#.*$/u, '').trimEnd()
    if (unquoted.length >= 4) values.push(unquoted)
  }
  return values
}

async function credentialValues(path: string | null): Promise<string[]> {
  if (path === null) return []
  const content = await readFile(path, 'utf8')
  const values: string[] = []
  try {
    collectSensitiveLeaves(JSON.parse(content), '', values)
  } catch {
    values.push(...yamlCredentialValues(content))
  }
  return [...new Set(values)]
}

export async function assertEvidenceContainsNoSecrets(root: string, credentialsPath: string | null): Promise<void> {
  const exactSecrets = await credentialValues(credentialsPath)
  const suspicious = /\b(?:sk-[A-Za-z0-9_-]{12,}|rft_[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,})\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,}/u
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error(`evaluation evidence secret scan rejects symlinks: ${relative(root, path)}`)
      if (metadata.isDirectory()) await visit(path)
      else if (metadata.isFile()) {
        const bytes = await readFile(path)
        const content = bytes.toString('utf8')
        if (bytes.includes(0) || content.includes('\uFFFD')) {
          throw new Error(`evaluation evidence secret scan rejects non-text files: ${relative(root, path).replaceAll('\\', '/')}`)
        }
        if (suspicious.test(content) || exactSecrets.some(secret => bytes.includes(Buffer.from(secret)))) {
          throw new Error(`evaluation evidence secret scan failed: ${relative(root, path).replaceAll('\\', '/')}`)
        }
      } else throw new Error(`evaluation evidence secret scan rejects special files: ${relative(root, path)}`)
    }
  }
  await visit(root)
}

function scrubbedChildEnv(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PNPM_HOME',
  ]
  return Object.fromEntries(allowed
    .map(key => [key, process.env[key]])
    .filter((entry): entry is [string, string] => entry[1] !== undefined))
}

async function git(checkout: string, args: string[]): Promise<string> {
  return (await runProcess('git', args, { cwd: checkout, timeoutMs: 20_000, capture: true })).stdout.trim()
}

async function evaluationPreflight(options: LiveEvaluationOptions): Promise<{
  harnessCommit: string
  harnessDirty: string
  ravenCommit: string
  ravenDirty: string
}> {
  const ravenRoot = resolve('.')
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
    dshRaven?: { harnessCommit?: unknown; harnessVersion?: unknown }
  }
  const target = JSON.parse(await readFile(resolve(options.checkout, 'package.json'), 'utf8')) as { version?: unknown }
  const expectedCommit = manifest.dshRaven?.harnessCommit
  const expectedVersion = manifest.dshRaven?.harnessVersion
  const harnessCommit = await git(options.checkout, ['rev-parse', 'HEAD'])
  if (harnessCommit !== expectedCommit || target.version !== expectedVersion) {
    throw new Error(`Harness checkout must match package.json pin ${String(expectedVersion)}@${String(expectedCommit)}`)
  }
  const harnessDirty = await git(options.checkout, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (harnessDirty !== '' && !options.allowDirtyHarness) {
    throw new Error(`Harness checkout is dirty; a paired baseline would not be reproducible:\n${harnessDirty}`)
  }
  if (harnessDirty !== '' && !options.fixtureModel) {
    throw new Error('--allow-dirty-harness is restricted to the keyless fixture-model smoke')
  }
  const ravenCommit = await git(ravenRoot, ['rev-parse', 'HEAD'])
  const ravenDirty = await git(ravenRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (ravenDirty !== '' && !options.fixtureModel && !options.allowDirtyRaven) {
    throw new Error(`Raven checkout is dirty; commit the evaluated bytes before a live baseline, or use --allow-dirty-raven for a non-promotable development run:\n${ravenDirty}`)
  }
  return { harnessCommit, harnessDirty, ravenCommit, ravenDirty }
}

async function scenario(options: LiveEvaluationOptions) {
  const path = resolve('evaluation', 'scenarios', `${options.scenarioId}.json`)
  const bytes = await readFile(path)
  const decoded = decodeEvaluationScenario(JSON.parse(bytes.toString('utf8')))
  if (decoded === undefined) throw new Error(`unknown or invalid evaluation scenario: ${options.scenarioId}`)
  return { path, bytes, value: decoded }
}

export async function evaluationBasePreset(base: string): Promise<string> {
  const strip = (value: string, startMarker: string, endMarker: string, replacement: string) => {
    const start = value.indexOf(startMarker)
    const end = value.indexOf(endMarker)
    if (start < 0 || end <= start) throw new Error(`pinned PTC preset marker changed: ${startMarker}`)
    return value.slice(0, start) + replacement + value.slice(end)
  }
  let content = await readFile(base, 'utf8')
  content = strip(
    content,
    '# ── shell ',
    '# ── background jobs ',
    '# Shell and filesystem tools come only from the restricted global evaluation surface.\n\n',
  )
  content = strip(
    content,
    '# ── background jobs ',
    '# ── compaction ',
    '# Background jobs, skills, goals, and planning are absent from both evaluation arms.\n\n',
  )
  content = strip(
    content,
    '# ── delegation and workflows ',
    '# ── remaining model-facing rows ',
    '# Delegation and workflow tools are absent from both evaluation arms.\n\n',
  )
  return strip(
    content,
    '- id: tool-ask-user',
    '# The `web` service',
    '# Interactive and task-list tools are absent from both evaluation arms.\n\n',
  )
}

async function writePreset(
  directory: string,
  base: string,
  raven: boolean,
  draftRoutes: readonly EvaluationDraftRoute[],
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'preset.yml'), [
    `name: Raven evaluation ${raven ? 'treatment' : 'vanilla'}`,
    'description: Generated paired-evaluation preset; do not edit.',
    '',
  ].join('\n'))
  const rows = [await evaluationBasePreset(base).then(value => value.trimEnd())]
  if (raven) {
    rows.push(
      '',
      '- id: raven-research',
      `  name: ${yamlString(pathToFileURL(resolve('lib', 'index.js')).href)}`,
      '  config:',
      '    role: agent',
      '    sourceNetworkPolicy: public-only',
      '    sourceCheckTimeoutMs: 20000',
      `    draftRoutes: ${JSON.stringify(draftRoutes.map(route => `${route.provider}/${route.model}`))}`,
    )
  }
  rows.push('')
  await writeFile(join(directory, 'agent.cordis.yml'), rows.join('\n'))
}

async function prepareArm(
  options: LiveEvaluationOptions,
  scenarioPath: string,
  rubricPath: string,
  frozenSourceRoot: string,
  scenarioValue: Awaited<ReturnType<typeof scenario>>['value'],
  condition: LiveEvaluationCondition,
): Promise<PreparedArm> {
  const output = resolve(options.outputRoot, condition)
  const raven = condition !== 'vanilla'
  const draftRoutes = condition === 'raven-single'
    ? options.draftRoutes.slice(0, 1)
    : condition === 'raven-multi' ? options.draftRoutes : []
  const runtimeRoot = resolve('.tmp', 'evaluation-runtime', basename(options.outputRoot), condition)
  const home = join(runtimeRoot, '.dsh')
  // Arms run serially against the same absolute cwd; the directory is reset from frozen bytes before each arm.
  const workspace = resolve(options.outputRoot, 'staging-workspace')
  const profile = join(home, 'profiles', 'evaluation')
  const inputWorkspace = join(output, 'input-workspace')
  await Promise.all([
    rm(output, { recursive: true, force: true }),
    rm(runtimeRoot, { recursive: true, force: true }),
    rm(workspace, { recursive: true, force: true }),
  ])
  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(output, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(inputWorkspace, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(output, 'service-calls.jsonl'), ''),
    copyFile(scenarioPath, join(output, 'scenario.json')),
    copyFile(rubricPath, join(output, 'rubric.md')),
  ])
  for (const source of scenarioValue.sources) {
    const frozenTarget = resolve(inputWorkspace, source.path)
    await mkdir(dirname(frozenTarget), { recursive: true })
    await copyFile(resolve(frozenSourceRoot, source.path), frozenTarget)
    if (source.origin === 'local' || source.origin === 'llm-wiki') {
      const workspaceTarget = resolve(workspace, modelVisiblePath(source))
      await mkdir(dirname(workspaceTarget), { recursive: true })
      await copyFile(frozenTarget, workspaceTarget)
    }
  }
  const sourceCatalog = scenarioValue.sources.map((source) => {
    const visiblePath = modelVisiblePath(source)
    return {
      id: source.id,
      title: source.title,
      origin: source.origin,
      uri: source.origin === 'local' || source.origin === 'llm-wiki'
        ? pathToFileURL(resolve(workspace, visiblePath)).href
        : source.uri,
      path: visiblePath,
      quality: source.quality,
      family: source.family,
      asOf: source.asOf,
    }
  })
  const catalogContent = JSON.stringify({
    notice: 'Synthetic controlled evidence for Raven evaluation; not real-world facts.',
    sources: sourceCatalog,
  }, null, 2) + '\n'
  const agentsContent = [
    '# Evaluation workspace',
    '',
    'This workspace contains synthetic controlled evidence, not real-world facts.',
    'Use SOURCE_CATALOG.json as the authority for each Source origin and URI. Local and llm-wiki fixtures are readable files; retrieve web and MCP Sources only through their catalogued tools.',
    'Do not look outside this workspace for scenario evidence. Do not infer access to assessor-only fact IDs.',
    '',
  ].join('\n')
  await Promise.all([
    writeFile(join(workspace, 'SOURCE_CATALOG.json'), catalogContent),
    writeFile(join(workspace, 'AGENTS.md'), agentsContent),
    writeFile(join(inputWorkspace, 'SOURCE_CATALOG.json'), catalogContent),
    writeFile(join(inputWorkspace, 'AGENTS.md'), agentsContent),
  ])
  await cp(workspace, join(output, 'model-workspace-initial'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-raven-evaluation',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }, null, 2) + '\n')
  const supportSources = scenarioValue.sources
    .filter(source => source.origin === 'web' || source.origin === 'mcp')
    .map(source => ({
      id: source.id,
      origin: source.origin,
      uri: source.uri,
      title: source.title,
      path: source.path,
      searchTerms: source.title.toLowerCase().split(/\W+/u).filter(Boolean),
    }))
  const patch = [
    ...(options.settingsPath === null
      ? []
      : [
          '- id: settings',
          '  config:',
          `    path: ${yamlString(options.settingsPath)}`,
          '    watch: false',
        ]),
    ...(options.credentialsPath === null
      ? []
      : [
          '- id: credentials',
          '  config:',
          `    path: ${yamlString(options.credentialsPath)}`,
          '    watch: false',
        ]),
    '- id: headless-runner',
    '  disabled: true',
    '- id: typert-loader',
    '  disabled: true',
    '- id: permission',
    '  config:',
    '    defaultPreset: evaluation-workspace',
    '    presets:',
    '      evaluation-workspace:',
    '        sandbox: workspace-write',
    '        approval: never',
    '- id: approval',
    '  config:',
    '    policy: never',
    '- id: system-prompt',
    '  config:',
    '    persona: >-',
    '      You are a research and writing agent. Follow the user request with the tools and evidence available in the current workspace. Every model call must remain on the declared provider/model allowlist.',
    '- id: web',
    '  config:',
    '    searchProvider: raven-eval',
    '    fetchProvider: raven-eval',
    '- id: tool-web',
    '  config:',
    '    fetch: true',
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: ${yamlString(join(home, 'sessions'))}`,
    '    compression: none',
    ...(options.fixtureModel ? ['- id: llm-deepseek', '  disabled: true'] : []),
    '- insert:',
    '    - id: subagent-model-selection-settings',
    "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    '    - id: agent-presets',
    "      name: '@deepseek-ai/dsh-agent-presets'",
    '      config:',
    `        default: eval-${condition}`,
    '    - id: evaluation-support',
    `      name: ${yamlString(pathToFileURL(resolve('scripts', 'evaluation-support.ts')).href)}`,
    `      config: ${JSON.stringify({
      sourceRoot: join(output, 'input-workspace'),
      sources: supportSources,
      ledgerPath: join(output, 'service-calls.jsonl'),
    })}`,
    ...(options.fixtureModel
      ? [
          '    - id: evaluation-fixture-llm',
          `      name: ${yamlString(pathToFileURL(resolve('scripts', 'evaluation-fixture-llm.mjs')).href)}`,
        ]
      : []),
    '    - id: evaluation-runner',
    `      name: ${yamlString(pathToFileURL(resolve('scripts', 'evaluation-runner-plugin.ts')).href)}`,
    '',
  ]
  await writeFile(join(profile, 'cordis.patch.yml'), patch.join('\n'))
  const base = resolve(options.checkout, 'packages', 'preset', 'agent-presets', 'presets', 'ptc', 'agent.cordis.yml')
  await writePreset(join(home, '.agent-presets', `eval-${condition}`), base, raven, draftRoutes)
  const configPath = join(runtimeRoot, 'runner-config.json')
  await writeFile(configPath, JSON.stringify({
    scenarioPath: join(output, 'scenario.json'),
    condition,
    presetId: `eval-${condition}`,
    outputRoot: output,
    workspace,
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    maxTokens: options.maxTokens,
    generation: 'process-1',
  }, null, 2) + '\n')
  const initialWorkspaceSha256 = await treeDigest(workspace)
  return { home, output, workspace, configPath, initialWorkspaceSha256 }
}

async function launchArm(options: LiveEvaluationOptions, arm: PreparedArm): Promise<void> {
  const loader = resolve('node_modules', 'tsx', 'dist', 'loader.mjs')
  const hooks = resolve('scripts', 'dsh-source-hooks.ts')
  const bin = resolve(options.checkout, 'apps', 'cli', 'src', 'bin.ts')
  for (let generation = 1; generation <= 3; generation += 1) {
    const config = JSON.parse(await readFile(arm.configPath, 'utf8')) as Record<string, unknown>
    config.generation = `process-${generation}`
    await writeFile(arm.configPath, JSON.stringify(config, null, 2) + '\n')
    await runProcess(process.execPath, [
      '--import', pathToFileURL(loader).href,
      '--import', pathToFileURL(hooks).href,
      bin,
      '--profile', 'evaluation',
      'run',
    ], {
      cwd: arm.workspace,
      timeoutMs: 15 * 60_000,
      capture: true,
      env: {
        ...scrubbedChildEnv(),
        DSH_CHECKOUT: resolve(options.checkout),
        DSH_HOME: arm.home,
        DSH_AGENTS_HOME: join(dirname(arm.home), '.agents'),
        DSH_PERMISSION_MODE: 'workspace-write',
        DSH_TELEMETRY_DISABLED: '1',
        DSH_TOOLS_MODE: 'ptc',
        RAVEN_EVAL_RUN_CONFIG: arm.configPath,
        TSX_TSCONFIG_PATH: resolve(options.checkout, 'tsconfig.json'),
        ...(options.fixtureModel ? { DEEPSEEK_API_KEY: '' } : {}),
      },
    })
    const progress = JSON.parse(await readFile(join(arm.output, 'progress.json'), 'utf8')) as { finished?: unknown }
    if (progress.finished === true) return
  }
  throw new Error('evaluation arm did not complete within three process generations')
}

async function jsonLines(path: string): Promise<{
  present: boolean
  records: Array<Record<string, unknown>>
}> {
  try {
    const content = await readFile(path, 'utf8')
    return {
      present: true,
      records: content.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, records: [] }
    throw error
  }
}

function usageSum(calls: Array<Record<string, unknown>>, field: string): number | null {
  let total = 0
  for (const call of calls) {
    const usage = typeof call.usage === 'object' && call.usage !== null
      ? call.usage as Record<string, unknown>
      : undefined
    const value = usage?.[field]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null
    total += value
    if (!Number.isSafeInteger(total)) return null
  }
  return total
}

async function observedUsage(
  arm: PreparedArm,
  options: LiveEvaluationOptions,
  condition: LiveEvaluationCondition,
): Promise<{
  usage: EvaluationUsage
  protocolFailures: { toolResults: number | null; ptcNested: number | null }
  modelRoutes: string[]
  modelRoutesValid: boolean
  ledgersComplete: boolean
}> {
  const [callLedger, eventLedger, serviceLedger, progress] = await Promise.all([
    jsonLines(resolve(arm.output, 'model-calls.jsonl')),
    jsonLines(resolve(arm.output, 'session.jsonl')),
    jsonLines(resolve(arm.output, 'service-calls.jsonl')),
    readFile(resolve(arm.output, 'progress.json'), 'utf8').then(value => JSON.parse(value) as {
      startedAt?: unknown
      completedAt?: unknown
      processGenerationIds?: unknown
    }),
  ])
  let toolCallCount = 0
  let ptcNestedCallCount = 0
  let toolResultFailureCount = 0
  let ptcNestedFailureCount = 0
  for (const record of eventLedger.records) {
    const event = typeof record.event === 'object' && record.event !== null
      ? record.event as Record<string, unknown>
      : undefined
    const type = event?.type
    if (type === 'tool/call') toolCallCount += 1
    if (type === 'tool/code-dispatch-start') ptcNestedCallCount += 1
    const data = typeof event?.data === 'object' && event.data !== null
      ? event.data as Record<string, unknown>
      : undefined
    if (type === 'tool/code-dispatch' && data?.isError === true) ptcNestedFailureCount += 1
    if (type === 'tool/result') {
      const message = typeof data?.message === 'object' && data.message !== null
        ? data.message as Record<string, unknown>
        : undefined
      const content = Array.isArray(message?.content) ? message.content : []
      if (content.some(item => typeof item === 'object' && item !== null
        && (item as Record<string, unknown>).type === 'tool-result'
        && (item as Record<string, unknown>).isError === true)) toolResultFailureCount += 1
    }
  }
  const startedAt = typeof progress.startedAt === 'string' ? Date.parse(progress.startedAt) : Number.NaN
  const completedAt = typeof progress.completedAt === 'string' ? Date.parse(progress.completedAt) : Number.NaN
  const mainRoute = { provider: options.provider, model: options.model }
  const allowedRoutes = [
    mainRoute,
    ...(condition === 'raven-single'
      ? options.draftRoutes.slice(0, 1)
      : condition === 'raven-multi' ? options.draftRoutes : []),
  ]
  const routeAllowed = (call: Record<string, unknown>) => typeof call.provider === 'string'
    && typeof call.model === 'string'
    && allowedRoutes.some(route => route.provider === call.provider && route.model === call.model)
  const modelRoutes = [...new Set(callLedger.records.flatMap((call) =>
    typeof call.provider === 'string' && typeof call.model === 'string'
      ? [JSON.stringify([call.provider, call.model])]
      : []))].sort()
  const generations = Array.isArray(progress.processGenerationIds)
    && progress.processGenerationIds.every(value => typeof value === 'string')
    ? progress.processGenerationIds as string[]
    : []
  const modelRoutesValid = callLedger.present && callLedger.records.length > 0 && generations.length > 0
    && callLedger.records.every(call => routeAllowed(call)
      && typeof call.generation === 'string' && generations.includes(call.generation))
    && generations.every(generation => callLedger.records.some(call => call.generation === generation
      && call.provider === mainRoute.provider && call.model === mainRoute.model))
  return {
    usage: {
      uncachedInputTokens: callLedger.present ? usageSum(callLedger.records, 'inputTokens') : null,
      cacheReadTokens: callLedger.present ? usageSum(callLedger.records, 'cacheReadTokens') : null,
      cacheWriteTokens: callLedger.present ? usageSum(callLedger.records, 'cacheWriteTokens') : null,
      outputTokens: callLedger.present ? usageSum(callLedger.records, 'outputTokens') : null,
      totalTokens: callLedger.present ? usageSum(callLedger.records, 'totalTokens') : null,
      reasoningTokens: callLedger.present ? usageSum(callLedger.records, 'reasoningTokens') : null,
      modelCalls: callLedger.present ? callLedger.records.length : null,
      toolCalls: eventLedger.present ? toolCallCount : null,
      ptcNestedCalls: eventLedger.present ? ptcNestedCallCount : null,
      searchCalls: serviceLedger.present ? serviceLedger.records.filter(call => call.kind === 'search').length : null,
      fetchCalls: serviceLedger.present ? serviceLedger.records.filter(call => call.kind === 'fetch').length : null,
      durationMs: Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
        ? completedAt - startedAt
        : null,
    },
    protocolFailures: {
      toolResults: eventLedger.present ? toolResultFailureCount : null,
      ptcNested: eventLedger.present ? ptcNestedFailureCount : null,
    },
    modelRoutes,
    modelRoutesValid,
    ledgersComplete: callLedger.present && eventLedger.present && serviceLedger.present,
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && path !== '..' && !isAbsolute(path))
}

async function toolAccessIsolated(arm: Pick<PreparedArm, 'output' | 'workspace'>): Promise<boolean> {
  const ledger = await jsonLines(resolve(arm.output, 'session.jsonl'))
  if (!ledger.present) return false
  const allowedNested = new Set<string>(EVALUATION_EXECUTION_TOOL_ALLOWLIST.filter(name => name !== 'run_code'))
  for (const record of ledger.records) {
    const event = typeof record.event === 'object' && record.event !== null
      ? record.event as Record<string, unknown>
      : undefined
    const data = typeof event?.data === 'object' && event.data !== null
      ? event.data as Record<string, unknown>
      : undefined
    if (event?.type === 'tool/call' && data?.name !== 'run_code') return false
    if (event?.type !== 'tool/code-dispatch-start') continue
    if (typeof data?.name !== 'string' || !allowedNested.has(data.name)) return false
    if (!['read', 'write', 'edit', 'glob', 'grep'].includes(data.name)) continue
    const args = typeof data.arguments === 'object' && data.arguments !== null
      ? data.arguments as Record<string, unknown>
      : undefined
    if (args === undefined) return false
    if (data.name === 'glob') {
      if (typeof args.pattern !== 'string' || isAbsolute(args.pattern)
        || args.pattern.replaceAll('\\', '/').split('/').includes('..')) return false
    }
    const pathValue = data.name === 'read' || data.name === 'write' || data.name === 'edit'
      ? args.file_path
      : args.path
    if (pathValue === undefined && (data.name === 'glob' || data.name === 'grep')) continue
    if (typeof pathValue !== 'string') return false
    let candidate: string
    try {
      candidate = pathValue.startsWith('file:') ? fileURLToPath(pathValue) : resolve(arm.workspace, pathValue)
    } catch {
      return false
    }
    if (!isWithin(arm.workspace, candidate)) return false
  }
  return true
}

async function promptParity(
  arms: Record<string, { path: string; processGenerationIds: string[] }>,
  outputRoot: string,
  leftCondition: LiveEvaluationCondition,
  rightCondition: LiveEvaluationCondition,
): Promise<{
  pass: boolean
  conditions: [LiveEvaluationCondition, LiveEvaluationCondition]
  commonPromptSha256: { left: string; right: string }
  topLevelToolSha256: { left: string; right: string }
  treatmentSections: string[]
}> {
  type PromptSnapshot = {
    sections?: Array<{ name?: unknown; text?: unknown }>
    contexts?: unknown
    tools?: unknown
    variables?: unknown
  }
  type ToolSnapshot = Array<{ name?: unknown } & Record<string, unknown>>
  const leftGenerations = arms[leftCondition]!.processGenerationIds
  const rightGenerations = arms[rightCondition]!.processGenerationIds
  const generationsMatch = JSON.stringify(leftGenerations) === JSON.stringify(rightGenerations)
  const readGeneration = async (condition: LiveEvaluationCondition, generation: string) => ({
    prompt: JSON.parse(await readFile(
      resolve(outputRoot, arms[condition]!.path, `prompt-${generation}.json`), 'utf8',
    )) as PromptSnapshot,
    schemas: JSON.parse(await readFile(
      resolve(outputRoot, arms[condition]!.path, `tool-schemas-${generation}.json`), 'utf8',
    )) as ToolSnapshot,
  })
  const [left, right] = await Promise.all([
    Promise.all(leftGenerations.map(generation => readGeneration(leftCondition, generation))),
    Promise.all(rightGenerations.map(generation => readGeneration(rightCondition, generation))),
  ])
  const treatmentStable = (items: typeof left, condition: LiveEvaluationCondition) => {
    const expected = condition === 'vanilla' ? 0 : 1
    const projections = items.map(item => ({
      sections: (item.prompt.sections ?? []).filter(section => section.name === 'tool:raven-task'),
      schemas: item.schemas.filter(tool => tool.name === 'raven_task' || tool.name === 'raven_workspace'),
    }))
    if (projections.some(item => item.sections.length !== expected || item.schemas.length !== expected * 2)) return false
    return projections.length > 0 && projections.every(item => JSON.stringify(item) === JSON.stringify(projections[0]))
  }
  const treatmentStableAcrossGenerations = treatmentStable(left, leftCondition) && treatmentStable(right, rightCondition)
    && (leftCondition === 'vanilla' || rightCondition === 'vanilla'
      || JSON.stringify(left.map(item => ({
        sections: (item.prompt.sections ?? []).filter(section => section.name === 'tool:raven-task'),
        schemas: item.schemas.filter(tool => tool.name === 'raven_task' || tool.name === 'raven_workspace'),
      }))) === JSON.stringify(right.map(item => ({
        sections: (item.prompt.sections ?? []).filter(section => section.name === 'tool:raven-task'),
        schemas: item.schemas.filter(tool => tool.name === 'raven_task' || tool.name === 'raven_workspace'),
      }))))
  const projectPrompt = (value: PromptSnapshot) => ({
    sections: (value.sections ?? [])
      .filter(section => section.name !== 'tool:raven-task')
      .map(section => section.name === 'tools:sdk' && typeof section.text === 'string'
        ? { ...section, text: normalizeEvaluationToolsSdk(section.text) }
        : section),
    contexts: value.contexts,
    tools: value.tools,
    variables: value.variables,
  })
  const projectSchemas = (value: ToolSnapshot) => value.filter(tool =>
    tool.name !== 'raven_task' && tool.name !== 'raven_workspace')
  const leftCommon = digest(JSON.stringify(left.map(item => projectPrompt(item.prompt))))
  const rightCommon = digest(JSON.stringify(right.map(item => projectPrompt(item.prompt))))
  const leftTools = digest(JSON.stringify(left.map(item => projectSchemas(item.schemas))))
  const rightTools = digest(JSON.stringify(right.map(item => projectSchemas(item.schemas))))
  const leftFirst = left[0]?.prompt
  const rightFirst = right[0]?.prompt
  if (leftFirst === undefined || rightFirst === undefined) throw new Error('prompt parity requires at least one process generation')
  const vanilla = leftCondition === 'vanilla' ? leftFirst : rightCondition === 'vanilla' ? rightFirst : undefined
  const treatment = vanilla === undefined ? rightFirst : vanilla === leftFirst ? rightFirst : leftFirst
  const baseline = vanilla ?? leftFirst
  const baselineNames = new Set((baseline.sections ?? []).map(section => section.name))
  const treatmentSections = (treatment.sections ?? [])
    .map(section => section.name)
    .filter((name): name is string => typeof name === 'string' && !baselineNames.has(name))
  const treatmentExpected = vanilla === undefined
    ? treatmentSections.length === 0
    : treatmentSections.length === 1 && treatmentSections[0] === 'tool:raven-task'
  return {
    pass: generationsMatch && treatmentStableAcrossGenerations
      && leftCommon === rightCommon && leftTools === rightTools && treatmentExpected,
    conditions: [leftCondition, rightCondition],
    commonPromptSha256: { left: leftCommon, right: rightCommon },
    topLevelToolSha256: { left: leftTools, right: rightTools },
    treatmentSections,
  }
}

async function observedArm(arm: PreparedArm): Promise<{
  terminalStatus: string | null
  sessionIds: string[]
  processGenerationIds: string[]
  artifactPath: string
  artifactSha256: string
  ravenTask: {
    taskId: string
    phase: string
    revision: number
    checkpoints: number
    draftRounds: number
    distinctDraftRoutes: number
    selectedStructure: boolean
    stopResumeSameTask: boolean
    taskCount: number
    sourceOrigins: string[]
  } | null
}> {
  const progress = JSON.parse(await readFile(resolve(arm.output, 'progress.json'), 'utf8')) as {
    terminalStatus?: unknown
    sessionIds?: unknown
    processGenerationIds?: unknown
  }
  if (!Array.isArray(progress.sessionIds) || !progress.sessionIds.every(value => typeof value === 'string')) {
    throw new Error('evaluation progress has invalid sessionIds')
  }
  if (!Array.isArray(progress.processGenerationIds)
    || !progress.processGenerationIds.every(value => typeof value === 'string')
    || progress.processGenerationIds.length === 0) {
    throw new Error('evaluation progress has invalid processGenerationIds')
  }
  const generation = progress.processGenerationIds.at(-1) as string
  const artifactPath = resolve(arm.output, `artifact-${generation}.md`)
  const stateFiles = (await readdir(arm.output)).filter(name => name.startsWith('raven-states-')).sort()
  const stateMetas = (await Promise.all(stateFiles.map(async name => JSON.parse(
    await readFile(resolve(arm.output, name), 'utf8'),
  ) as unknown[]))).flat()
  const latestMeta = stateMetas.at(-1)
  const latestState = typeof latestMeta === 'object' && latestMeta !== null
    && typeof (latestMeta as Record<string, unknown>).state === 'object'
    && (latestMeta as Record<string, unknown>).state !== null
    ? (latestMeta as Record<string, unknown>).state as Record<string, unknown>
    : undefined
  const stateRecords = stateMetas.flatMap((meta) => {
    if (typeof meta !== 'object' || meta === null) return []
    const state = (meta as Record<string, unknown>).state
    return typeof state === 'object' && state !== null ? [state as Record<string, unknown>] : []
  })
  const taskIds = new Set(stateRecords.flatMap(state => typeof state.taskId === 'string' ? [state.taskId] : []))
  const sourceOrigins = [...new Set(Array.isArray(latestState?.sources)
    ? latestState.sources.flatMap((source) => {
        if (typeof source !== 'object' || source === null) return []
        const resource = (source as Record<string, unknown>).resource
        if (typeof resource !== 'object' || resource === null) return []
        const origin = (resource as Record<string, unknown>).origin
        return typeof origin === 'string' ? [origin] : []
      })
    : [])].sort()
  const sessionLedger = await jsonLines(resolve(arm.output, 'session.jsonl'))
  const successfulTaskActions = sessionLedger.records.flatMap((record) => {
    const event = typeof record.event === 'object' && record.event !== null
      ? record.event as Record<string, unknown>
      : undefined
    const data = typeof event?.data === 'object' && event.data !== null
      ? event.data as Record<string, unknown>
      : undefined
    const args = typeof data?.arguments === 'object' && data.arguments !== null
      ? data.arguments as Record<string, unknown>
      : undefined
    if (event?.type !== 'tool/code-dispatch' || data?.name !== 'raven_task' || data.isError !== false
      || typeof args?.action !== 'string' || typeof event.seq !== 'number') return []
    const rendered = Array.isArray(data.content)
      ? data.content.flatMap((block) => typeof block === 'object' && block !== null
        && (block as Record<string, unknown>).type === 'text'
        && typeof (block as Record<string, unknown>).text === 'string'
        ? [(block as Record<string, unknown>).text as string]
        : []).join('\n')
      : ''
    return [{
      action: args.action,
      seq: event.seq,
      rendered,
      taskId: typeof args.taskId === 'string' ? args.taskId : null,
      generation: typeof record.generation === 'string' ? record.generation : null,
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
    }]
  })
  const currentTaskId = typeof latestState?.taskId === 'string' ? latestState.taskId : null
  const currentTaskActions = successfulTaskActions.filter(item => item.taskId === currentTaskId)
  const lastActionSeq = (action: string) => currentTaskActions
    .filter(item => item.action === action)
    .reduce((latest, item) => Math.max(latest, item.seq), -1)
  const completedAction = currentTaskActions.findLast(item => item.action === 'complete')
  const observedPhase = completedAction === undefined
    ? undefined
    : completedAction.rendered.includes('completed-with-limits') ? 'completed-with-limits' : 'completed'
  const observedCheckpoints = currentTaskActions.filter(item => item.action === 'checkpoint').length
  const observedSelection = lastActionSeq('select-structure') > lastActionSeq('steer')
  const stopped = currentTaskActions.findLast(item => item.action === 'stop')
  const resumed = currentTaskActions.findLast(item => item.action === 'resume')
  const completed = currentTaskActions.findLast(item => item.action === 'complete')
  const stopResumeSameTask = stopped !== undefined && resumed !== undefined && completed !== undefined
    && stopped.sessionId !== null && stopped.sessionId === resumed.sessionId && resumed.sessionId === completed.sessionId
    && stopped.generation !== null && resumed.generation !== null && completed.generation !== null
    && stopped.generation !== resumed.generation && resumed.generation === completed.generation
    && stopped.seq < resumed.seq && resumed.seq < completed.seq
  const draftRounds = latestState !== undefined && Array.isArray(latestState.drafts) ? latestState.drafts : []
  const distinctDraftRoutes = new Set(draftRounds.flatMap((round) => {
    if (typeof round !== 'object' || round === null || (round as Record<string, unknown>).path !== 'multi-model'
      || !Array.isArray((round as Record<string, unknown>).routes)) return []
    return ((round as Record<string, unknown>).routes as unknown[]).flatMap((route) => {
      if (typeof route !== 'object' || route === null) return []
      const value = route as Record<string, unknown>
      return value.status === 'drafted' && typeof value.provider === 'string' && typeof value.model === 'string'
        ? [JSON.stringify([value.provider, value.model])]
        : []
    })
  }))
  const ravenTask = latestState !== undefined
    && typeof latestState.taskId === 'string'
    && typeof latestState.phase === 'string'
    && Number.isSafeInteger(latestState.revision)
    && Array.isArray(latestState.checkpoints)
    ? {
        taskId: latestState.taskId,
        phase: observedPhase ?? latestState.phase,
        revision: latestState.revision as number,
        checkpoints: Math.max(latestState.checkpoints.length, observedCheckpoints),
        draftRounds: draftRounds.length,
        distinctDraftRoutes: distinctDraftRoutes.size,
        selectedStructure: latestState.selectedSkeleton !== null || observedSelection,
        stopResumeSameTask,
        taskCount: taskIds.size,
        sourceOrigins,
      }
    : null
  return {
    terminalStatus: typeof progress.terminalStatus === 'string' ? progress.terminalStatus : null,
    sessionIds: progress.sessionIds,
    processGenerationIds: progress.processGenerationIds,
    artifactPath: relative(arm.output, artifactPath).replaceAll('\\', '/'),
    artifactSha256: digest(await readFile(artifactPath)),
    ravenTask,
  }
}

export async function runLiveEvaluation(options: LiveEvaluationOptions): Promise<{ outcomeComplete: boolean; promotable: boolean }> {
  const outputRoot = await safeEvaluationOutputPath(options.outputRoot)
  const runId = basename(outputRoot)
  const executionStartedAt = new Date().toISOString()
  const safeOptions = { ...options, outputRoot }
  const preflight = await evaluationPreflight(safeOptions)
  const selected = await scenario(safeOptions)
  const rubricBytes = await readFile(resolve('evaluation', 'rubric.md'))
  const sourceBytes = await Promise.all(selected.value.sources.map(async source => {
    const bytes = await readFile(resolve('evaluation', source.path))
    if (digest(bytes) !== source.sha256) throw new Error(`Source digest changed before run freeze: ${source.id}`)
    return { path: source.path, bytes }
  }))
  const uniqueSourceBytes = [...new Map(sourceBytes.map(source => [source.path, source])).values()]
  const ablation = selected.value.kind === 'ablation'
  if (ablation && options.draftRoutes.length < 2) {
    throw new Error('multi-model ablation requires at least two --draft-route provider:model values')
  }
  if (!ablation && options.draftRoutes.length > 0) {
    throw new Error('--draft-route is reserved for the multi-model ablation; primary Raven comparison keeps draftRoutes empty')
  }
  await runProcess('pnpm', ['run', 'build'], { cwd: resolve('.'), timeoutMs: 120_000 })
  const frozenScenarioPath = resolve(outputRoot, 'scenario.json')
  const frozenRubricPath = resolve(outputRoot, 'rubric.md')
  const frozenSourceRoot = resolve(outputRoot, 'source-snapshot')
  await mkdir(frozenSourceRoot, { recursive: true })
  await Promise.all([
    writeFile(frozenScenarioPath, selected.bytes),
    writeFile(frozenRubricPath, rubricBytes),
    ...uniqueSourceBytes.map(async source => {
      const path = resolve(frozenSourceRoot, source.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, source.bytes)
    }),
  ])
  const arms: Record<string, {
    path: string
    modelVisibleWorkspace: string
    initialWorkspaceSha256: string
    finalWorkspaceSha256: string
    evidenceSha256: string
    usage: EvaluationUsage
    modelRoutes: string[]
    modelRoutesValid: boolean
    ledgersComplete: boolean
    terminalStatus: string | null
    sessionIds: string[]
    processGenerationIds: string[]
    artifactPath: string
    artifactSha256: string
    ravenTask: {
    taskId: string
    phase: string
    revision: number
    checkpoints: number
    draftRounds: number
    distinctDraftRoutes: number
    selectedStructure: boolean
    stopResumeSameTask: boolean
    taskCount: number
    sourceOrigins: string[]
  } | null
  }> = {}
  const order: readonly LiveEvaluationCondition[] = ablation
    ? options.order === 'raven-first' ? ['raven-multi', 'raven-single'] : ['raven-single', 'raven-multi']
    : options.order === 'raven-first' ? ['raven', 'vanilla'] : ['vanilla', 'raven']
  for (const condition of order) {
    const arm = await prepareArm(safeOptions, frozenScenarioPath, frozenRubricPath, frozenSourceRoot, selected.value, condition)
    try {
      await launchArm(safeOptions, arm)
      const finalWorkspace = resolve(arm.output, 'final-workspace')
      await cp(arm.workspace, finalWorkspace, { recursive: true })
      arms[condition] = {
        path: relative(outputRoot, arm.output).replaceAll('\\', '/'),
        modelVisibleWorkspace: arm.workspace,
        initialWorkspaceSha256: arm.initialWorkspaceSha256,
        finalWorkspaceSha256: await treeDigest(finalWorkspace),
        evidenceSha256: await treeDigest(arm.output),
        ...await observedUsage(arm, safeOptions, condition),
        ...await observedArm(arm),
      }
    } catch (error) {
      await writeFile(resolve(outputRoot, 'failure.json'), JSON.stringify({
        schemaVersion: 1,
        failedArm: condition,
        completedArms: Object.keys(arms),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }, null, 2) + '\n')
      await assertEvidenceContainsNoSecrets(outputRoot, options.credentialsPath)
      await writeFile(resolve(outputRoot, 'SAFE_PARTIAL_TO_UPLOAD'), 'Secret scan passed for incomplete diagnostic evidence.\n')
      throw error
    }
  }
  await rm(resolve(outputRoot, 'staging-workspace'), { recursive: true, force: true })
  const parity = await promptParity(arms, outputRoot, order[0]!, order[1]!)
  const toolAccessFloor = (await Promise.all(order.map(condition => toolAccessIsolated({
    output: resolve(outputRoot, arms[condition]!.path),
    workspace: resolve(outputRoot, 'staging-workspace'),
  })))).every(Boolean)
  const frozenInputParity = (await Promise.all(order.flatMap(condition => [
    readFile(resolve(outputRoot, arms[condition]!.path, 'scenario.json')).then(value => digest(value) === digest(selected.bytes)),
    readFile(resolve(outputRoot, arms[condition]!.path, 'rubric.md')).then(value => digest(value) === digest(rubricBytes)),
    ...selected.value.sources.map(source => readFile(
      resolve(outputRoot, arms[condition]!.path, 'input-workspace', source.path),
    ).then(value => digest(value) === source.sha256)),
  ]))).every(Boolean)
  const basePath = resolve(options.checkout, 'packages', 'preset', 'agent-presets', 'presets', 'ptc', 'agent.cordis.yml')
  const scenarioBytes = selected.bytes
  const sourceSnapshotSha256 = await treeDigest(frozenSourceRoot)
  const completedOutcomes = selected.value.expectations.allowedTerminalStatuses
  const canaryPass = (await Promise.all(order.map(async condition => readFile(
    resolve(outputRoot, arms[condition]!.path, arms[condition]!.artifactPath),
    'utf8',
  )))).every(artifact => selected.value.expectations.forbiddenArtifactQuotes.every(quote => !artifact.includes(quote)))
  const ravenConditions = order.filter(condition => condition !== 'vanilla')
  const mechanismFloor = ravenConditions.every((condition) => {
    const arm = arms[condition]
    return (arm?.ravenTask?.checkpoints ?? 0) >= selected.value.expectations.minimumCheckpoints
      && (!selected.value.expectations.requireStopResume
        || (arm?.processGenerationIds.length ?? 0) >= 2 && arm?.ravenTask?.stopResumeSameTask === true)
      && (!selected.value.expectations.requireKnowledgeReuse
        || (arm?.sessionIds.length ?? 0) >= 2
          && (arm?.ravenTask?.taskCount ?? 0) >= 2
          && arm?.ravenTask?.sourceOrigins.includes('llm-wiki') === true)
      && (!selected.value.expectations.requireStructureChoice || arm?.ravenTask?.selectedStructure === true)
  })
  const armsComplete = order.every((condition) => {
    const arm = arms[condition]
    const phase = arm?.ravenTask?.phase
    return arm?.ledgersComplete === true
      && arm.modelRoutesValid === true
      && arm.terminalStatus === 'completed'
      && (condition === 'vanilla'
        || ((phase === 'completed' || phase === 'completed-with-limits') && completedOutcomes.includes(phase)))
  })
  const ablationComplete = !ablation
    || (arms['raven-single']?.ravenTask?.distinctDraftRoutes ?? 0) <= 1
      && (arms['raven-multi']?.ravenTask?.distinctDraftRoutes ?? 0) >= 2
  const outcomeComplete = parity.pass && toolAccessFloor && frozenInputParity && canaryPass
    && mechanismFloor && armsComplete && ablationComplete
  const promotable = !options.fixtureModel && outcomeComplete
    && preflight.harnessDirty === '' && preflight.ravenDirty === ''
  await writeFile(resolve(outputRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    executionStartedAt,
    scenarioId: selected.value.id,
    scenarioKind: selected.value.kind,
    scenarioSha256: digest(scenarioBytes),
    rubricSha256: digest(rubricBytes),
    inputsSha256: digest(JSON.stringify(selected.value.turns)),
    sourceSnapshotSha256,
    basePreset: 'ptc',
    baseCompositionSha256: digest(await evaluationBasePreset(basePath)),
    parity,
    automatedFloor: { frozenInputParity, toolAccessFloor, canaryPass, mechanismFloor, armsComplete, ablationComplete },
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    maxTokens: options.maxTokens,
    draftRoutes: options.draftRoutes,
    order,
    fixtureModel: options.fixtureModel,
    credentialsSource: options.credentialsPath === null ? 'environment-or-none' : 'external-managed-file',
    settingsSha256: options.settingsPath === null ? null : digest(await readFile(options.settingsPath)),
    outcomeComplete,
    promotable,
    harnessCommit: preflight.harnessCommit,
    harnessDirty: preflight.harnessDirty !== '',
    ravenCommit: preflight.ravenCommit,
    ravenDirty: preflight.ravenDirty !== '',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    arms,
  }, null, 2) + '\n')
  await assertEvidenceContainsNoSecrets(outputRoot, options.credentialsPath)
  await writeFile(resolve(outputRoot, 'SAFE_TO_UPLOAD'), 'Secret scan passed; raw evidence still requires access control.\n')
  return { outcomeComplete, promotable }
}
