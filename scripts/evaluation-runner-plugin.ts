import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

import { decodeRavenTaskState } from '../src/codec.js'
import {
  decodeEvaluationScenario,
  EVALUATION_EXECUTION_TOOL_ALLOWLIST,
  EVALUATION_GLOBAL_TOOL_ALLOWLIST,
  type EvaluationScenario,
} from './evaluation.js'

export const name = 'raven-evaluation-runner'
export const inject = ['agents', 'sessions', 'agentPresets', 'llm', 'tools', 'systemPrompt'] as const

interface RunnerConfig {
  scenarioPath: string
  condition: 'vanilla' | 'raven' | 'raven-single' | 'raven-multi'
  presetId: string
  outputRoot: string
  workspace: string
  provider: string
  model: string
  reasoningEffort: string | null
  maxTokens: number
  generation: string
}

const evaluationExecutionTools = new Set<string>(EVALUATION_EXECUTION_TOOL_ALLOWLIST)
const evaluationFileTools = new Set(['read', 'write', 'edit', 'glob', 'grep'])

function pathIsWithin(workspace: string, value: string): boolean {
  try {
    const raw = value.startsWith('file:') ? fileURLToPath(value) : value
    const path = isAbsolute(raw) ? raw : resolve(workspace, raw)
    const fromRoot = relative(resolve(workspace), path)
    return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      && !isAbsolute(fromRoot))
  } catch {
    return false
  }
}

/** Deny every tool or file path outside the exact evaluation surface before execution. */
export function evaluationToolGuardReason(workspace: string, name: string, argsValue: unknown): string | undefined {
  if (!evaluationExecutionTools.has(name)) return `tool ${name} is outside the evaluation allowlist`
  if (!evaluationFileTools.has(name)) return undefined
  const args = typeof argsValue === 'object' && argsValue !== null ? argsValue as Record<string, unknown> : undefined
  if (args === undefined) return `${name} arguments are invalid`
  if (args.sandbox_permissions !== undefined || args.justification !== undefined) {
    return `${name} cannot request evaluation sandbox escalation`
  }
  if (name === 'glob') {
    const pattern = args.pattern
    if (typeof pattern !== 'string' || isAbsolute(pattern)
      || pattern.replaceAll('\\', '/').split('/').includes('..')) {
      return 'glob pattern escapes the evaluation workspace'
    }
  }
  const value = name === 'read' || name === 'write' || name === 'edit' ? args.file_path : args.path
  if (value === undefined && (name === 'glob' || name === 'grep')) return undefined
  return typeof value === 'string' && pathIsWithin(workspace, value)
    ? undefined
    : `${name} path escapes the evaluation workspace`
}

/** Exact inherited tool schemas visible to one evaluation condition. */
export function evaluationGlobalToolAllowlist(condition: RunnerConfig['condition']): string[] {
  return [
    ...EVALUATION_GLOBAL_TOOL_ALLOWLIST,
    ...(condition === 'vanilla' ? [] : ['raven_task', 'raven_workspace']),
  ]
}

/** Restrict inherited schemas and install the matching pre-execution guard for one evaluation agent. */
export function applyEvaluationToolPolicy(ctx: Context, workspace: string, condition: RunnerConfig['condition']): void {
  ctx.tools.restrict({ allow: evaluationGlobalToolAllowlist(condition) })
  ctx.tools.guard((exec: ToolExecution) => evaluationToolGuardReason(workspace, exec.name, exec.arguments))
}

interface Progress {
  schemaVersion: 1
  nextTurnIndex: number
  currentSessionId: string
  sessionIds: string[]
  processGenerationIds: string[]
  startedAt: string
  completedAt: string | null
  finished: boolean
  terminalStatus: 'completed' | 'failed' | 'cancelled' | null
  terminalReason: unknown
}

interface ModelCall {
  generation: string
  provider: string
  model: string
  startedAt: string
  completedAt: string
  durationMs: number
  usage: unknown
  error?: string
}

function configPath(): string {
  const value = process.env.RAVEN_EVAL_RUN_CONFIG
  if (value === undefined || value.trim() === '') throw new Error('RAVEN_EVAL_RUN_CONFIG must name the runner config JSON')
  return resolve(value)
}

async function readConfig(): Promise<RunnerConfig> {
  const value = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<RunnerConfig>
  if (!['vanilla', 'raven', 'raven-single', 'raven-multi'].includes(value.condition ?? '')) {
    throw new Error('evaluation condition is unsupported')
  }
  for (const field of ['scenarioPath', 'presetId', 'outputRoot', 'workspace', 'provider', 'model', 'generation'] as const) {
    if (typeof value[field] !== 'string' || value[field]?.trim() === '') throw new Error(`evaluation runner config has invalid ${field}`)
  }
  if (value.reasoningEffort !== null && typeof value.reasoningEffort !== 'string') throw new Error('invalid reasoningEffort')
  if (!Number.isSafeInteger(value.maxTokens) || (value.maxTokens ?? 0) < 1) throw new Error('invalid maxTokens')
  return value as RunnerConfig
}

async function readScenario(path: string): Promise<EvaluationScenario> {
  const scenario = decodeEvaluationScenario(JSON.parse(await readFile(resolve(path), 'utf8')))
  if (scenario === undefined) throw new Error(`scenario violates evaluation schema v1: ${path}`)
  return scenario
}

async function readProgress(path: string): Promise<Progress | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Progress
    if (value.schemaVersion !== 1 || !Array.isArray(value.sessionIds) || !Array.isArray(value.processGenerationIds)) {
      throw new Error('progress schema mismatch')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistantText(events: readonly SessionEvent[]): string {
  const event = events.findLast(item => item.type === 'assistant/message')
  if (event?.type !== 'assistant/message') return ''
  return event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function latestTurnReason(events: readonly SessionEvent[]): unknown {
  const event = events.findLast(item => item.type === 'turn/end')
  return event?.type === 'turn/end' ? event.data.reason : undefined
}

function terminalStatus(reason: unknown): 'completed' | 'failed' | 'cancelled' {
  if (typeof reason === 'object' && reason !== null) {
    const kind = (reason as Record<string, unknown>).kind
    if (kind === 'completed') return 'completed'
    if (kind === 'aborted') return 'cancelled'
  }
  return 'failed'
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function validatedRavenMeta(value: unknown): unknown | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const meta = value as Record<string, unknown>
  if (meta.kind !== 'dsh-raven-research/task-state' || meta.version !== 2
    || typeof meta.currentTaskId !== 'string') return undefined
  const state = decodeRavenTaskState(meta.state)
  return state === undefined || state.taskId !== meta.currentTaskId ? undefined : { ...meta, state }
}

export function ravenStateMetas(events: ReadonlyArray<{ event: SessionEvent }>): unknown[] {
  const found: unknown[] = []
  const pattern = /<!-- dsh-raven-research\/task-state ([A-Za-z0-9+/=]+) -->/gu
  for (const { event } of events) {
    if (event.type === 'tool/result') {
      const meta = event.data.meta
      const validated = validatedRavenMeta(meta)
      if (validated !== undefined) found.push(validated)
      continue
    }
    if (event.type !== 'tool/code-dispatch' || event.data.name !== 'raven_task' || event.data.isError) continue
    const rendered = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    for (const match of rendered.matchAll(pattern)) {
      try {
        const parsed = JSON.parse(Buffer.from(match[1] as string, 'base64').toString('utf8')) as unknown
        const validated = validatedRavenMeta(parsed)
        if (validated !== undefined) found.push(validated)
      } catch {}
    }
  }
  return found
}

async function run(ctx: Context): Promise<boolean> {
  await ctx.get('loader')?.await()
  const config = await readConfig()
  const scenario = await readScenario(config.scenarioPath)
  const outputRoot = resolve(config.outputRoot)
  const progressPath = resolve(outputRoot, 'progress.json')
  await mkdir(outputRoot, { recursive: true })
  const previous = await readProgress(progressPath)
  if (previous === undefined) {
    await Promise.all([
      writeFile(resolve(outputRoot, 'session.jsonl'), ''),
      writeFile(resolve(outputRoot, 'model-calls.jsonl'), ''),
    ])
  }
  const runStartedAt = previous?.startedAt ?? new Date().toISOString()
  const processGenerationIds = [...(previous?.processGenerationIds ?? [])]
  if (!processGenerationIds.includes(config.generation)) processGenerationIds.push(config.generation)
  const liveEvents: Array<{ sessionId: string; event: SessionEvent }> = []
  const modelCalls: ModelCall[] = []
  let eventWrites = Promise.resolve()
  const ownedSessions = new Set(previous?.sessionIds ?? [])
  const offEvents = ctx.on('session/event', (session, event) => {
    if (!ownedSessions.has(session.id)) return
    liveEvents.push({ sessionId: session.id, event })
    const line = JSON.stringify({ generation: config.generation, sessionId: session.id, event }) + '\n'
    eventWrites = eventWrites.then(() => appendFile(resolve(outputRoot, 'session.jsonl'), line))
  })
  const offModels = ctx.on('llm/stream', async function* (options, next) {
    const started = Date.now()
    let usage: unknown
    let failure: string | undefined
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage
        yield chunk
      }
    } catch (error) {
      failure = errorText(error)
      throw error
    } finally {
      const completed = Date.now()
      const call: ModelCall = {
        generation: config.generation,
        provider: options.provider,
        model: options.model,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date(completed).toISOString(),
        durationMs: completed - started,
        usage: usage ?? null,
        ...(failure === undefined ? {} : { error: failure }),
      }
      modelCalls.push(call)
      await appendFile(resolve(outputRoot, 'model-calls.jsonl'), JSON.stringify(call) + '\n')
    }
  })
  const agentOptions = {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === null ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }),
    maxTokens: config.maxTokens,
  }
  const setup = async (agentCtx: Context): Promise<void> => {
    await ctx.agentPresets.mount(agentCtx, config.presetId)
    applyEvaluationToolPolicy(agentCtx, config.workspace, config.condition)
  }
  const create = async (sessionId: string): Promise<AgentHandle> => {
    ownedSessions.add(sessionId)
    return ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: resolve(config.workspace), agentPreset: config.presetId },
      agentOptions,
      setup,
    })
  }
  const resume = async (sessionId: string): Promise<AgentHandle> => {
    ownedSessions.add(sessionId)
    return ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions, setup })
  }

  let nextTurnIndex = previous?.nextTurnIndex ?? 0
  let currentSessionId = previous?.currentSessionId
    ?? `raven-eval-${scenario.id}-${config.condition}-task-1`
  const sessionIds = [...(previous?.sessionIds ?? [])]
  if (!sessionIds.includes(currentSessionId)) sessionIds.push(currentSessionId)
  let handle = previous === undefined ? await create(currentSessionId) : await resume(currentSessionId)
  let finalReason: unknown
  let failed = false
  try {
    while (nextTurnIndex < scenario.turns.length) {
      const turn = scenario.turns[nextTurnIndex] as EvaluationScenario['turns'][number]
      if (turn.trigger === 'after-checkpoint') {
        const checkpointVisible = config.condition !== 'vanilla'
          ? ravenStateMetas(liveEvents).some((meta) => {
              const state = typeof meta === 'object' && meta !== null
                ? (meta as Record<string, unknown>).state
                : undefined
              return typeof state === 'object' && state !== null
                && Array.isArray((state as Record<string, unknown>).checkpoints)
                && ((state as Record<string, unknown>).checkpoints as unknown[]).length > 0
            })
          : handle.agent.session.events.some(event => event.type === 'assistant/message')
        if (!checkpointVisible) throw new Error(`turn ${turn.id} requires an observed prior checkpoint`)
      }
      if (turn.trigger === 'after-process-restart' && processGenerationIds.length < 2) break
      if (turn.trigger === 'after-process-restart' && config.condition !== 'vanilla') {
        const restoredStates = ravenStateMetas(handle.agent.session.events.map(event => ({ event })))
        const state = restoredStates.at(-1)
        const restored = typeof state === 'object' && state !== null
          ? (state as Record<string, unknown>).state
          : undefined
        if (typeof restored !== 'object' || restored === null
          || (restored as Record<string, unknown>).phase !== 'stopped') {
          throw new Error(`turn ${turn.id} requires a persisted stopped Raven Task after process restart`)
        }
      }
      if (turn.trigger === 'new-session') {
        await ctx.sessions.flush(handle.agent.session)
        await handle.dispose()
        currentSessionId = `raven-eval-${scenario.id}-${config.condition}-task-${sessionIds.length + 1}`
        sessionIds.push(currentSessionId)
        handle = await create(currentSessionId)
      }
      const pendingSteer = scenario.turns[nextTurnIndex + 1]
      const steerAfterCheckpoint = pendingSteer?.delivery === 'steer'
        && pendingSteer.trigger === 'after-checkpoint'
      let resolveCheckpoint: (() => void) | undefined
      let checkpointSeen = false
      const checkpoint = new Promise<void>((resolve) => { resolveCheckpoint = resolve })
      const offCheckpoint = steerAfterCheckpoint
        ? ctx.on('session/event', (session, event) => {
            if (session.id !== currentSessionId || checkpointSeen) return
            const record = event as unknown as Record<string, unknown>
            const data = typeof record.data === 'object' && record.data !== null
              ? record.data as Record<string, unknown>
              : undefined
            const args = typeof data?.arguments === 'object' && data.arguments !== null
              ? data.arguments as Record<string, unknown>
              : undefined
            const ravenCheckpoint = config.condition !== 'vanilla'
              && record.type === 'tool/code-dispatch'
              && data?.name === 'raven_task'
              && data.isError === false
              && args?.action === 'checkpoint'
            const vanillaCheckpoint = config.condition === 'vanilla' && record.type === 'assistant/message'
            if (ravenCheckpoint || vanillaCheckpoint) {
              checkpointSeen = true
              resolveCheckpoint?.()
            }
          })
        : () => undefined
      if (turn.delivery === 'steer') handle.agent.steer(message(turn.content))
      else handle.agent.followup(message(turn.content))
      const idle = handle.agent.whenIdle()
      const triggered = steerAfterCheckpoint
        ? await Promise.race([checkpoint.then(() => true), idle.then(() => false)])
        : false
      offCheckpoint()
      if (triggered) {
        handle.agent.steer(message(pendingSteer!.content))
        await handle.agent.whenIdle()
        nextTurnIndex += 2
      } else {
        await idle
        nextTurnIndex += 1
        if (steerAfterCheckpoint) throw new Error(`turn ${pendingSteer!.id} requires a new checkpoint during the prior turn`)
      }
      await ctx.sessions.flush(handle.agent.session)
      finalReason = latestTurnReason(handle.agent.session.events)
      if (terminalStatus(finalReason) !== 'completed') {
        failed = true
        break
      }
    }
    const finished = failed || nextTurnIndex >= scenario.turns.length
    await writeFile(resolve(outputRoot, `artifact-${config.generation}.md`), assistantText(handle.agent.session.events))
    const progress: Progress = {
      schemaVersion: 1,
      nextTurnIndex,
      currentSessionId,
      sessionIds,
      processGenerationIds,
      startedAt: runStartedAt,
      completedAt: finished ? new Date().toISOString() : null,
      finished,
      terminalStatus: finished ? terminalStatus(finalReason) : null,
      terminalReason: finished ? finalReason ?? null : null,
    }
    await writeFile(progressPath, JSON.stringify(progress, null, 2) + '\n')
    await eventWrites
    const ravenStates = ravenStateMetas(liveEvents)
    if (ravenStates.length > 0) {
      await writeFile(resolve(outputRoot, `raven-states-${config.generation}.json`), JSON.stringify(ravenStates, null, 2) + '\n')
    }
    const toolSchemas = ctx.tools.schemas(handle.agent)
    await writeFile(resolve(outputRoot, `tool-schemas-${config.generation}.json`), JSON.stringify(toolSchemas, null, 2) + '\n')
    const assembled = await ctx.systemPrompt.assemble({ agent: handle.agent, scope: handle.agent })
    await writeFile(resolve(outputRoot, `prompt-${config.generation}.json`), JSON.stringify(assembled, null, 2) + '\n')
    return finished
  } finally {
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    offModels()
    offEvents()
    await eventWrites
  }
}

export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('raven evaluation runner requires the dsh appExit host value')
  void run(ctx).then(
    completed => exit(completed ? 0 : 0),
    async (error: unknown) => {
      const path = process.env.RAVEN_EVAL_RUN_CONFIG
      if (path !== undefined) {
        try {
          const config = JSON.parse(await readFile(path, 'utf8')) as { outputRoot?: unknown }
          if (typeof config.outputRoot === 'string') {
            await mkdir(resolve(config.outputRoot), { recursive: true })
            await writeFile(resolve(config.outputRoot, 'runner-error.txt'), errorText(error) + '\n')
          }
        } catch {}
      }
      process.stderr.write(`raven evaluation runner: ${errorText(error)}\n`)
      exit(1)
    },
  )
}
