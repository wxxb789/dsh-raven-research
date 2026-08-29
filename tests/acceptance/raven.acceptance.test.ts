import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { apply } from '../../src/plugin.js'
import type { RavenConfig } from '../../src/config.js'
import { SOURCE_ORIGINS, type RavenTaskState } from '../../src/domain.js'
import type { RavenWorkspaceFile, RavenWorkspaceResult } from '../../src/workspace.js'

interface ToolValue {
  readonly kind: 'raven-task-result'
  readonly status: string
  readonly state: RavenTaskState
  readonly issues: readonly string[]
  readonly renderedArtifact?: string
}

interface CapturedTool<T = unknown> {
  readonly name: string
  readonly parameters: Record<string, unknown>
  execute(args: unknown, exec: unknown): Promise<T>
}

interface PreStepDecision {
  readonly kind: 'enter' | 'reject'
  readonly messages: readonly { readonly content: readonly { readonly type: string; readonly text?: string }[] }[]
}

type PreStep = (event: { agent: unknown }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>

function createHarness(web?: {
  fetch(request: { url: string }, signal?: AbortSignal): Promise<{
    url: string
    statusCode: number
    body: { kind: 'html' | 'text'; content: string }
  }>
}, config: RavenConfig = {}, options: { readonly agentId?: string } = {}) {
  const tools = new Map<string, CapturedTool>()
  let preStep: PreStep | undefined
  const sections: Array<Record<string, unknown>> = []
  const ctx = {
    tools: {
      register(definition: CapturedTool) {
        tools.set(definition.name, definition)
        return () => undefined
      },
    },
    systemPrompt: {
      section(definition: Record<string, unknown>) {
        sections.push(definition)
        return () => undefined
      },
    },
    inject() {
      return () => undefined
    },
    get(name: string) {
      return name === 'web' ? web : undefined
    },
    on(event: string, listener: unknown) {
      if (event === 'agent/pre-step') preStep = listener as PreStep
      return () => undefined
    },
  }
  apply(ctx as never, { sourceNetworkPolicy: 'unrestricted', ...config })
  const registeredTool = tools.get('raven_task') as CapturedTool<ToolValue> | undefined
  const workspaceTool = tools.get('raven_workspace') as CapturedTool<RavenWorkspaceResult> | undefined
  if (registeredTool === undefined || workspaceTool === undefined) throw new Error('Raven tools did not register')
  const agent = { id: options.agentId ?? 'acceptance-session', session: { events: [] as unknown[] } }
  const signal = new AbortController().signal
  return {
    sections,
    tool: registeredTool,
    recordInspection: (inspection: { callId: string; name: string; arguments: unknown; text: string; meta?: unknown }) => {
      agent.session.events.push(
        { type: 'tool/call', data: { callId: inspection.callId, name: inspection.name, arguments: JSON.stringify(inspection.arguments) } },
        {
          type: 'tool/result',
          data: {
            message: {
              source: { callId: inspection.callId },
              content: [{
                type: 'tool-result',
                toolCallId: inspection.callId,
                content: [{ type: 'text', text: inspection.text }],
              }],
            },
            ...(inspection.meta === undefined ? {} : { meta: inspection.meta }),
          },
        },
      )
    },
    clearInspections: () => { agent.session.events.length = 0 },
    run: (args: unknown) => registeredTool.execute(args, { agent, signal }),
    runWorkspace: (args: unknown) => workspaceTool.execute(args, { agent, signal }),
    context: async () => {
      if (preStep === undefined) throw new Error('Raven pre-step hook did not register')
      const decision = await preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))
      return decision.messages.flatMap(message => message.content)
        .filter(part => part.type === 'text')
        .map(part => part.text ?? '')
        .join('\n')
    },
  }
}

function applyWorkspacePlan(files: Map<string, string>, result: RavenWorkspaceResult): void {
  for (const page of result.pages) {
    const precondition = result.preconditions.find(item => item.path === page.path)
    if (precondition === undefined) throw new Error(`missing precondition for ${page.path}`)
    const current = files.get(page.path)
    const observed = current === undefined
      ? 'absent'
      : `sha256:${createHash('sha256').update(current).digest('hex')}`
    if (observed !== precondition.expected) throw new Error(`stale plan for ${page.path}`)
    files.set(page.path, page.content)
  }
  if (result.logEntry !== undefined) {
    const marker = /<!-- raven-workspace-op:[a-f0-9]+ -->/.exec(result.logEntry)?.[0]
    const log = files.get('wiki/log.md') ?? ''
    if (marker === undefined || !log.includes(marker)) files.set('wiki/log.md', log + result.logEntry)
  }
}

function workspaceFiles(files: ReadonlyMap<string, string>): RavenWorkspaceFile[] {
  return Array.from(files, ([path, content]) => ({ path, content }))
}

const source = (sourceId: string, suffix: string) => ({
  sourceId,
  url: `https://evidence.test/${suffix}`,
  title: `Primary evidence ${sourceId}`,
  locator: `Section ${sourceId}`,
  excerpt: `Exact evidence excerpt for ${sourceId}`,
  role: 'primary',
  sourceFamily: `family-${sourceId}`,
})

const claim = (claimId: string, sourceId: string, text: string) => ({
  claimId,
  text,
  kind: 'external',
  importance: 'material',
  disposition: 'supported',
  sourceIds: [sourceId],
})

describe('Raven end-to-end acceptance', () => {
  it('progressively researches, exposes an early Artifact, accepts correction, and refines the same Task', async () => {
    const fetch = vi.fn(async ({ url }: { url: string }) => ({
      url,
      statusCode: 200,
      body: {
        kind: 'text' as const,
        content: 'Exact evidence excerpt for S1. Exact evidence excerpt for S2.',
      },
    }))
    const raven = createHarness({ fetch })

    const started = await raven.run({
      action: 'start',
      outcome: 'research',
      request: 'Compare two documented durability approaches and recommend one.',
    })
    const early = await raven.run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'analyze',
      summary: 'Early useful finding from the first primary source; research continues.',
      artifact: 'Approach A acknowledges only durable appends [@S1]. The comparison remains provisional.',
      sources: [source('S1', 'approach-a')],
      claims: [claim('C1', 'S1', 'Approach A acknowledges only durable appends.')],
    })

    expect(early.status).toBe('active')
    expect(early.state.verification).toBeNull()
    expect(early.state.sources).toHaveLength(1)
    expect(early.renderedArtifact).toContain('Approach A acknowledges only durable appends')
    expect(fetch).toHaveBeenCalledTimes(1)

    const broader = await raven.run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A comparative draft after the second independent source.',
      artifact: 'Approach A acknowledges durable appends [@S1]. Approach B documents asynchronous acknowledgement [@S2].',
      sources: [source('S2', 'approach-b')],
      claims: [claim('C2', 'S2', 'Approach B documents asynchronous acknowledgement.')],
    })
    const steered = await raven.run({
      action: 'steer',
      taskId: started.state.taskId,
      correction: 'Keep the same Task, but prioritize crash recovery over throughput.',
    })
    const refined = await raven.run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'refine',
      summary: 'The same comparison revised around the user correction.',
      artifact: 'For crash recovery, Approach A has the stronger documented guarantee [@S1]; Approach B remains asynchronous [@S2].',
    })
    const completed = await raven.run({
      action: 'complete',
      taskId: started.state.taskId,
      artifact: 'For crash recovery, Approach A has the stronger documented guarantee [@S1]; Approach B remains asynchronous [@S2].',
    })

    expect(broader.state.taskId).toBe(started.state.taskId)
    expect(steered.state.taskId).toBe(started.state.taskId)
    expect(refined.state.taskId).toBe(started.state.taskId)
    expect(completed.state.taskId).toBe(started.state.taskId)
    expect(refined.state.steeringRevision).toBe(1)
    expect(refined.state.checkpoints.at(-1)?.steeringRevision).toBe(1)
    expect(completed.status).toBe('completed')
    expect(completed.state.checkpoints).toHaveLength(4)
    expect(fetch).toHaveBeenCalledTimes(7)
  })

  it('supports general writing without forcing external evidence', async () => {
    const raven = createHarness()
    const started = await raven.run({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Rewrite the supplied release note for engineering managers.',
    })
    const draft = await raven.run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A concise manager-facing draft.',
      artifact: 'We will roll out the supplied change in two controlled steps.',
    })
    const completed = await raven.run({
      action: 'complete',
      taskId: started.state.taskId,
      artifact: 'We will roll out the supplied change in two controlled steps.',
    })

    expect(draft.renderedArtifact).toContain('controlled steps')
    expect(completed.status).toBe('completed')
    expect(completed.state.outcome).toBe('general-writing')
  })

  it('supports academic writing with traceable real Source identities', async () => {
    const fetch = vi.fn(async ({ url }: { url: string }) => ({
      url,
      statusCode: 200,
      body: { kind: 'html' as const, content: '<p>Exact evidence excerpt for P1.</p>' },
    }))
    const raven = createHarness({ fetch })
    const started = await raven.run({
      action: 'start',
      outcome: 'academic-writing',
      request: 'Draft a literature paragraph from an inspected paper.',
    })
    const draft = await raven.run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A source-grounded academic paragraph.',
      artifact: 'The paper distinguishes durable from asynchronous acknowledgement [@P1].',
      sources: [source('P1', 'paper-one')],
      claims: [claim('PC1', 'P1', 'The paper distinguishes durable from asynchronous acknowledgement.')],
    })
    const completed = await raven.run({
      action: 'complete',
      taskId: started.state.taskId,
      artifact: 'The paper distinguishes durable from asynchronous acknowledgement [@P1].',
    })

    expect(draft.renderedArtifact).toContain('[Primary evidence P1](https://evidence.test/paper-one)')
    expect(completed.status).toBe('completed')
    expect(completed.state.claims[0]?.sourceIds).toEqual(['P1'])
  })

  it('grounds the same Claim and citation model across exactly four Source origins', async () => {
    const excerpt = 'Canonical Markdown carries the grounded statement.'
    const cases = [
      {
        origin: 'web',
        policy: { allowedWebHosts: ['evidence.test'] },
        source: source('WEB1', 'web-page'),
      },
      {
        origin: 'local',
        policy: { localRoots: ['file:///Q:/workspace/docs'] },
        source: {
          sourceId: 'LOCAL1', title: 'Local Markdown', locator: 'Statement', excerpt, role: 'user-provided',
          resource: { origin: 'local', uri: 'file:///Q:/workspace/docs/source.md', mediaType: 'text/markdown' },
          representation: { format: 'markdown', derivation: 'original', coverage: 'segment', producedBy: 'read', inspectionCallId: 'inspect-local', markdown: '# Local\n\n' + excerpt },
        },
        inspection: {
          callId: 'inspect-local', name: 'read', arguments: { file_path: 'file:///Q:/workspace/docs/source.md' }, text: '',
          meta: { offset: 2, totalLines: 4, path: fileURLToPath('file:///Q:/workspace/docs/source.md'), lines: [
            { number: 2, text: '# Local' }, { number: 3, text: '' }, { number: 4, text: excerpt },
          ] },
        },
      },
      {
        origin: 'llm-wiki',
        policy: { llmWikiRoots: ['file:///Q:/workspace/wiki'] },
        source: {
          sourceId: 'WIKI1', title: 'Wiki page', locator: 'Finding', excerpt, role: 'secondary',
          resource: { origin: 'llm-wiki', uri: 'file:///Q:/workspace/wiki/queries/finding.md', mediaType: 'text/markdown', sourceName: 'project-wiki' },
          representation: { format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read', inspectionCallId: 'inspect-wiki', markdown: '# Finding\n\n' + excerpt },
        },
        inspection: {
          callId: 'inspect-wiki', name: 'read', arguments: { file_path: 'file:///Q:/workspace/wiki/queries/finding.md' }, text: '',
          meta: { offset: 1, totalLines: 3, path: fileURLToPath('file:///Q:/workspace/wiki/queries/finding.md'), lines: [
            { number: 1, text: '# Finding' }, { number: 2, text: '' }, { number: 3, text: excerpt },
          ] },
        },
      },
      {
        origin: 'mcp',
        policy: { includedMcpSources: ['docs'] },
        source: {
          sourceId: 'MCP1', title: 'MCP resource', locator: 'resource body', excerpt, role: 'primary',
          resource: { origin: 'mcp', uri: 'mcp://docs/finding', mediaType: 'application/json', sourceName: 'docs' },
          representation: { format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'mcp__docs__read_resource', inspectionCallId: 'inspect-mcp', markdown: '# MCP finding\n\n' + excerpt },
        },
        inspection: {
          callId: 'inspect-mcp', name: 'mcp__docs__read_resource', arguments: { uri: 'mcp://docs/finding' },
          text: '# MCP finding\n\n' + excerpt,
        },
      },
    ] as const
    expect(cases.map(item => item.origin)).toEqual(SOURCE_ORIGINS)

    for (const item of cases) {
      const fetch = vi.fn(async ({ url }: { url: string }) => ({
        url,
        statusCode: 200,
        body: { kind: 'text' as const, content: item.origin === 'web' ? 'Exact evidence excerpt for WEB1.' : excerpt },
      }))
      const raven = createHarness(item.origin === 'web' ? { fetch } : undefined)
      const started = await raven.run({
        action: 'start', outcome: 'research', request: 'Ground one statement from ' + item.origin + '.',
        sourcePolicy: item.policy,
      })
      if ('inspection' in item) raven.recordInspection(item.inspection)
      const sourceId = item.source.sourceId
      const claimText = 'The source provides a grounded statement.'
      const checkpoint = await raven.run({
        action: 'checkpoint', taskId: started.state.taskId, stage: 'read',
        summary: 'Grounded ' + item.origin + ' evidence.',
        artifact: claimText + ' [@' + sourceId + '].',
        sources: [item.source],
        claims: [claim('C-' + sourceId, sourceId, claimText)],
      })
      if (item.origin !== 'web') raven.clearInspections()
      const completed = await raven.run({
        action: 'complete', taskId: started.state.taskId, artifact: checkpoint.state.latestArtifact,
      })

      expect(checkpoint.status, item.origin).toBe('active')
      expect(completed.status, item.origin).toBe('completed')
      expect(completed.state.sources[0]?.resource.origin).toBe(item.origin)
      expect(completed.state.sources[0]?.check.status).toBe('reachable')
      if (item.origin !== 'web') expect(completed.state.sources[0]?.inspectionSha256).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(completed.renderedArtifact).toContain('## Claim trace')
    }
  })

  it('refuses forged Markdown and missing MCP inspection receipts', async () => {
    const cases = [
      {
        expected: 'failed',
        policy: { localRoots: ['file:///Q:/workspace/docs'] },
        source: {
          sourceId: 'FORGED1', title: 'Forged local representation', locator: 'Claim', excerpt: 'fabricated statement',
          resource: { origin: 'local', uri: 'file:///Q:/workspace/docs/real.md', mediaType: 'text/markdown' },
          representation: {
            format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read', inspectionCallId: 'inspect-real',
            markdown: '# Forged\n\nfabricated statement',
          },
        },
        inspection: {
          callId: 'inspect-real', name: 'read', arguments: { file_path: 'file:///Q:/workspace/docs/real.md' }, text: '',
          meta: { offset: 1, totalLines: 3, path: fileURLToPath('file:///Q:/workspace/docs/real.md'), lines: [
            { number: 1, text: '# Real' }, { number: 2, text: '' }, { number: 3, text: 'different statement' },
          ] },
        },
      },
      {
        expected: 'unavailable',
        policy: { includedMcpSources: ['docs'] },
        source: {
          sourceId: 'MISSING1', title: 'Missing MCP receipt', locator: 'resource', excerpt: 'claimed statement',
          resource: { origin: 'mcp', uri: 'mcp://docs/missing', sourceName: 'docs', mediaType: 'text/plain' },
          representation: {
            format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'mcp__docs__read_resource',
            inspectionCallId: 'missing-call', markdown: 'claimed statement',
          },
        },
      },
    ] as const

    for (const item of cases) {
      const raven = createHarness()
      const started = await raven.run({
        action: 'start', outcome: 'research', request: 'Reject unattested non-web evidence.', sourcePolicy: item.policy,
      })
      if ('inspection' in item) raven.recordInspection(item.inspection)
      const result = await raven.run({
        action: 'checkpoint', taskId: started.state.taskId, stage: 'read', summary: 'Untrusted representation.',
        artifact: 'The source claims a statement [@' + item.source.sourceId + '].',
        sources: [item.source],
        claims: [claim('C-' + item.source.sourceId, item.source.sourceId, 'The source claims a statement.')],
      })
      expect(result.status).toBe('needs-revision')
      expect(result.state.checkpoints).toHaveLength(0)
      expect(result.state.sources[0]?.check.status).toBe(item.expected)
      expect(result.state.claims[0]?.disposition).toBe('deferred')
      expect(result.state.limitations.some(limit => limit.sourceId === item.source.sourceId)).toBe(true)
    }
  })

  it('defers a Claim when a local resource has no readable Markdown representation', async () => {
    const raven = createHarness()
    const started = await raven.run({
      action: 'start', outcome: 'research', request: 'Use an unsupported local document.',
      sourcePolicy: { localRoots: ['file:///Q:/workspace/docs'] },
    })
    const result = await raven.run({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'read',
      summary: 'Unsupported local document.',
      artifact: 'The document appears to state a result [@PDF1].',
      sources: [{
        sourceId: 'PDF1', title: 'Unreadable PDF', locator: 'Page 3', excerpt: 'unverified PDF excerpt',
        resource: { origin: 'local', uri: 'file:///Q:/workspace/docs/report.pdf', mediaType: 'application/pdf' },
        representation: null,
      }],
      claims: [claim('PDF-C1', 'PDF1', 'The document appears to state a result.')],
    })

    expect(result.status).toBe('needs-revision')
    expect(result.state.checkpoints).toHaveLength(0)
    expect(result.state.sources[0]?.check).toMatchObject({ status: 'unavailable', detail: expect.stringContaining('no normalized Markdown') })
    expect(result.state.claims[0]?.disposition).toBe('deferred')
    expect(result.state.limitations.some(item => item.sourceId === 'PDF1')).toBe(true)
  })

  it('supports learning through an early explanation and a refined self-check', async () => {
    const raven = createHarness()
    const started = await raven.run({
      action: 'start',
      outcome: 'learning',
      grounding: 'none',
      request: 'Teach closures with examples and a self-check.',
    })
    const explanation = await raven.run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'An immediately usable mental model.',
      artifact: 'A closure is a function together with access to the lexical environment where it was created.',
    })
    const practice = await raven.run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'refine',
      summary: 'Worked examples and active recall.',
      artifact: 'Mental model: a function carries its lexical environment. Self-check: what value does the captured counter retain?',
    })
    const completed = await raven.run({
      action: 'complete',
      taskId: started.state.taskId,
      artifact: practice.state.latestArtifact,
    })

    expect(explanation.status).toBe('active')
    expect(practice.state.checkpoints).toHaveLength(2)
    expect(completed.status).toBe('completed')
    expect(completed.state.outcome).toBe('learning')
  })

  it('rejects fabricated or unregistered external links in a final Artifact', async () => {
    const raven = createHarness()
    const started = await raven.run({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Write a short sourced note.',
    })
    const draft = await raven.run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A draft awaiting citation validation.',
      artifact: 'A short note without an external link.',
    })
    const rejected = await raven.run({
      action: 'complete',
      taskId: started.state.taskId,
      artifact: 'A claim with an invented link: https://fabricated.invalid/source',
    })

    expect(rejected.status).toBe('needs-revision')
    expect(rejected.state).toBe(draft.state)
    expect(rejected.issues.join(' ')).toContain('unregistered external URL')
  })

  it('does not publish or complete an externally grounded Artifact while its cited Source is known broken', async () => {
    const fetch = vi.fn(async ({ url }: { url: string }) => ({
      url,
      statusCode: 404,
      body: { kind: 'text' as const, content: 'missing' },
    }))
    const raven = createHarness({ fetch })
    const started = await raven.run({
      action: 'start',
      outcome: 'research',
      request: 'Report one externally grounded fact.',
    })
    const draft = await raven.run({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A candidate fact with a recorded Source.',
      artifact: 'The documented fact appears here [@S404].',
      sources: [source('S404', 'missing-page')],
      claims: [claim('C404', 'S404', 'The documented fact appears here.')],
    })
    expect(draft.status).toBe('needs-revision')
    // A2: the Checkpoint is withheld, but the submitted evidence is retained with
    // its failed check so the agent repairs the named Source instead of resending
    // the whole contribution.
    expect(draft.state.checkpoints).toHaveLength(0)
    expect(draft.state.latestArtifact).toBeNull()
    expect(draft.state.sources.map(item => item.sourceId)).toEqual(['S404'])
    expect(draft.state.sources[0]?.check.status).toBe('failed')
    // The Claim whose only support broke is deferred, not left asserted.
    expect(draft.state.claims[0]?.disposition).toBe('deferred')
    expect(draft.state.phase).toBe('active')
    expect(draft.issues.join(' ')).toContain('S404')
    expect(draft.issues.join(' ')).toContain('HTTP 404')
  })

  it('offers contextual guidance in auto and stays silent in off without changing the workflow', async () => {
    const auto = createHarness()
    const initialContext = await auto.context()
    expect(initialContext.match(/<raven_guidance>/g)).toHaveLength(1)
    expect(initialContext).toContain('at most one brief')
    expect(initialContext).toContain('Do not repeat a capability')
    expect(initialContext).not.toContain('action=')

    const autoStarted = await auto.run({
      action: 'start',
      outcome: 'learning',
      grounding: 'none',
      request: 'Teach closures progressively.',
    })
    const activeContext = await auto.context()
    expect(activeContext).toContain('<raven_task_context>')
    expect(activeContext).toContain(autoStarted.state.taskId)
    expect(activeContext.match(/<raven_guidance>/g)).toHaveLength(1)
    expect(activeContext).toContain('sources')
    expect(activeContext).toContain('pausing')

    const autoDraft = await auto.run({
      action: 'checkpoint',
      taskId: autoStarted.state.taskId,
      stage: 'draft',
      summary: 'A useful explanation.',
      artifact: 'A closure carries the lexical environment where it was created.',
    })
    await auto.run({ action: 'stop', taskId: autoStarted.state.taskId })
    const autoStoppedContext = await auto.context()
    expect(autoStoppedContext.match(/<raven_guidance>/g)).toHaveLength(1)
    expect(autoStoppedContext).toContain('paused and preserved')
    expect(autoStoppedContext).not.toContain('During active work')
    await auto.run({ action: 'resume', taskId: autoStarted.state.taskId })
    await auto.run({
      action: 'complete',
      taskId: autoStarted.state.taskId,
      artifact: autoDraft.state.latestArtifact,
    })
    const autoCompletedContext = await auto.context()
    expect(autoCompletedContext.match(/<raven_guidance>/g)).toHaveLength(1)
    expect(autoCompletedContext).toContain('current result is complete')
    expect(autoCompletedContext).not.toContain('<raven_task_context>')
    expect(autoCompletedContext).not.toContain('During active work')

    const off = createHarness(undefined, { guidance: 'off' })
    expect(await off.context()).not.toContain('<raven_guidance>')
    const offStarted = await off.run({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Draft a short release note.',
    })
    const offDraft = await off.run({
      action: 'checkpoint',
      taskId: offStarted.state.taskId,
      stage: 'draft',
      summary: 'A useful first draft.',
      artifact: 'The release will roll out in two controlled steps.',
    })
    const offStopped = await off.run({ action: 'stop', taskId: offStarted.state.taskId })
    const stoppedContext = await off.context()
    expect(stoppedContext).toContain('<raven_task_context>')
    expect(stoppedContext).not.toContain('<raven_guidance>')
    const offResumed = await off.run({ action: 'resume', taskId: offStarted.state.taskId })
    const offCompleted = await off.run({
      action: 'complete',
      taskId: offStarted.state.taskId,
      artifact: offDraft.state.latestArtifact,
    })
    expect(offStopped.status).toBe('stopped')
    expect(offResumed.state.taskId).toBe(offStarted.state.taskId)
    expect(offCompleted.status).toBe('completed')
  })

  it('compounds a Markdown Workspace and reuses it in a later independent Task', async () => {
    const first = createHarness(undefined, {}, { agentId: 'workspace-task-a' })
    const files = new Map<string, string>()
    const initialized = await first.runWorkspace({ action: 'initialize', files: [] })
    applyWorkspacePlan(files, initialized)

    const notesUri = 'file:///Q:/workspace/material/notes.md'
    const briefUri = 'file:///Q:/workspace/material/brief.pdf'
    const notesMarkdown = '# Notes\n\nOriginal Markdown survives adoption.\n'
    const briefMarkdown = '# Brief\n\nThe Source layer produced this normalized Markdown.\n'
    first.recordInspection({
      callId: 'workspace-read-notes', name: 'read', arguments: { file_path: notesUri }, text: '',
      meta: {
        offset: 1,
        totalLines: 4,
        path: fileURLToPath(notesUri),
        lines: notesMarkdown.split('\n').map((text, index) => ({ number: index + 1, text })),
      },
    })
    first.recordInspection({
      callId: 'workspace-convert-brief', name: 'document_to_markdown', arguments: { file_path: briefUri },
      text: briefMarkdown,
    })
    const adopted = await first.runWorkspace({
      action: 'adopt', kind: 'folder', files: workspaceFiles(files),
      documents: [
        {
          title: 'Original notes',
          resource: { origin: 'local', uri: notesUri, mediaType: 'text/markdown' },
          representation: {
            format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read',
            inspectionCallId: 'workspace-read-notes', markdown: notesMarkdown,
          },
        },
        {
          title: 'Converted brief',
          resource: { origin: 'local', uri: briefUri, mediaType: 'application/pdf' },
          representation: {
            format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'document_to_markdown',
            inspectionCallId: 'workspace-convert-brief', markdown: briefMarkdown,
          },
        },
      ],
    })
    expect(adopted.status).toBe('ready')
    applyWorkspacePlan(files, adopted)
    const originalRaw = [...files].filter(([path]) => path.startsWith('wiki/raw/documents/'))
    expect(originalRaw).toHaveLength(2)
    expect(files.has('notes.md')).toBe(false)
    expect(files.has('brief.pdf')).toBe(false)

    const started = await first.run({
      action: 'start', outcome: 'general-writing', grounding: 'none', request: 'Explain durable workspaces.',
    })
    const checkpoint = await first.run({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'draft', summary: 'Reusable Workspace concept.',
      artifact: 'Durable workspaces preserve useful context across bounded tasks.',
    })
    const completed = await first.run({
      action: 'complete', taskId: started.state.taskId, artifact: checkpoint.state.latestArtifact,
    })
    const revisionBeforeGrow = completed.state.revision
    const grown = await first.runWorkspace({
      action: 'grow', files: workspaceFiles(files),
      taskId: completed.state.taskId, pageType: 'concept', title: 'Durable Workspace', tags: ['research'],
    })
    applyWorkspacePlan(files, grown)
    const afterGrow = await first.run({ action: 'status', taskId: completed.state.taskId })
    expect(afterGrow.state.revision).toBe(revisionBeforeGrow)
    expect([...files].filter(([path]) => path.startsWith('wiki/raw/documents/'))).toEqual(originalRaw)

    const maintained = await first.runWorkspace({
      action: 'maintain', files: workspaceFiles(files), complete: true,
    })
    applyWorkspacePlan(files, maintained)
    const healthy = await first.runWorkspace({
      action: 'health', files: workspaceFiles(files), complete: true,
    })
    expect(healthy.health?.status).toBe('healthy')

    const later = createHarness(undefined, {}, { agentId: 'workspace-task-b' })
    const reused = await later.runWorkspace({
      action: 'reuse', files: workspaceFiles(files),
      query: 'durable workspace context', freshness: 'durable', maxResults: 5,
    })
    expect(reused.candidates?.[0]).toMatchObject({
      path: 'wiki/concepts/durable-workspace.md', knowledgeStatus: 'stored', requiresFreshVerification: false,
    })

    const conceptPath = 'wiki/concepts/durable-workspace.md'
    const concept = files.get(conceptPath)
    if (concept === undefined) throw new Error('missing compounded concept')
    const conceptUri = 'file:///Q:/workspace/wiki/concepts/durable-workspace.md'
    const conceptLines = concept.split('\n')
    later.recordInspection({
      callId: 'reuse-workspace-concept', name: 'read', arguments: { file_path: conceptUri }, text: '',
      meta: {
        offset: 1,
        totalLines: conceptLines.length,
        path: fileURLToPath(conceptUri),
        lines: conceptLines.map((text, index) => ({ number: index + 1, text })),
      },
    })
    const laterTask = await later.run({
      action: 'start', outcome: 'research', request: 'Reuse prior Workspace knowledge.',
      sourcePolicy: { llmWikiRoots: ['file:///Q:/workspace/wiki'] },
    })
    const claimText = 'A durable Workspace can preserve useful context across bounded Tasks.'
    const laterCheckpoint = await later.run({
      action: 'checkpoint', taskId: laterTask.state.taskId, stage: 'read', summary: 'Reused stored knowledge.',
      artifact: `${claimText} [@WIKI-STORED].`,
      sources: [{
        sourceId: 'WIKI-STORED', title: 'Durable Workspace', locator: 'Raven update',
        excerpt: 'Durable workspaces preserve useful context across bounded tasks.', role: 'secondary',
        resource: { origin: 'llm-wiki', uri: conceptUri, mediaType: 'text/markdown', sourceName: 'raven-workspace' },
        representation: {
          format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read',
          inspectionCallId: 'reuse-workspace-concept', markdown: concept,
        },
      }],
      claims: [claim('WIKI-CLAIM', 'WIKI-STORED', claimText)],
    })
    const laterCompleted = await later.run({
      action: 'complete', taskId: laterTask.state.taskId, artifact: laterCheckpoint.state.latestArtifact,
    })

    expect(laterTask.state.taskId).not.toBe(started.state.taskId)
    expect(laterCompleted.status).toBe('completed')
    expect(laterCompleted.state.sources[0]?.resource.origin).toBe('llm-wiki')
    expect(laterCompleted.state.sources[0]?.check.status).toBe('reachable')
  })

  it('exposes plain Workspace discovery to the agent before substantial research', () => {
    const raven = createHarness()
    const prompt = String(raven.sections.find(section => section.name === 'tool:raven-task')?.text)

    expect(prompt).toContain('Before starting substantial research from zero')
    expect(prompt).toContain('wiki/index.md')
    expect(prompt).toContain('current Harness workspace')
    expect(prompt).toContain('read it when present')
    expect(prompt).toContain('rather than persisting it in Task state')
    expect(prompt).toContain('No Workspace is required')
  })

  it('has no confirmation action between normal research stages', () => {
    const raven = createHarness()
    const properties = raven.tool.parameters.properties as Record<string, unknown>
    const action = properties.action as { enum: string[] }

    expect(action.enum).toEqual(['start', 'discover', 'draft', 'checkpoint', 'steer', 'complete', 'status', 'stop', 'resume', 'export'])
    expect(action.enum).not.toContain('confirm')
    expect(action.enum).not.toContain('approve')
    expect(String(raven.sections[0]?.text)).toContain('Do not ask for approval between')
    expect(String(raven.sections[0]?.text)).toContain('internal orchestration')
    expect(String(raven.sections[0]?.text)).toContain('Users speak naturally')
  })
})
