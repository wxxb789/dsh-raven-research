import { describe, expect, it, vi } from 'vitest'

import { apply } from '../../src/plugin.js'
import type { RavenTaskState } from '../../src/domain.js'

interface ToolValue {
  readonly kind: 'raven-task-result'
  readonly status: string
  readonly state: RavenTaskState
  readonly issues: readonly string[]
  readonly renderedArtifact?: string
}

interface CapturedTool {
  readonly parameters: Record<string, unknown>
  execute(args: unknown, exec: unknown): Promise<ToolValue>
}

function createHarness(web?: {
  fetch(request: { url: string }, signal?: AbortSignal): Promise<{
    url: string
    statusCode: number
    body: { kind: 'html' | 'text'; content: string }
  }>
}) {
  let tool: CapturedTool | undefined
  const sections: Array<Record<string, unknown>> = []
  const ctx = {
    tools: {
      register(definition: CapturedTool) {
        tool = definition
        return () => undefined
      },
    },
    systemPrompt: {
      section(definition: Record<string, unknown>) {
        sections.push(definition)
        return () => undefined
      },
    },
    get(name: string) {
      return name === 'web' ? web : undefined
    },
    on() {
      return () => undefined
    },
  }
  apply(ctx as never)
  if (tool === undefined) throw new Error('Raven tool did not register')
  const registeredTool = tool
  const agent = { id: 'acceptance-session', session: { events: [] } }
  const signal = new AbortController().signal
  return {
    sections,
    tool: registeredTool,
    run: (args: unknown) => registeredTool.execute(args, { agent, signal }),
  }
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
    expect(draft.state).toBe(started.state)
    expect(draft.state.phase).toBe('active')
    expect(draft.issues.join(' ')).toContain('S404')
    expect(draft.issues.join(' ')).toContain('HTTP 404')
  })

  it('has no confirmation action between normal research stages', () => {
    const raven = createHarness()
    const properties = raven.tool.parameters.properties as Record<string, unknown>
    const action = properties.action as { enum: string[] }

    expect(action.enum).toEqual(['start', 'checkpoint', 'steer', 'complete', 'status', 'stop', 'resume'])
    expect(action.enum).not.toContain('confirm')
    expect(action.enum).not.toContain('approve')
    expect(String(raven.sections[0]?.text)).toContain('Do not ask for approval between')
  })
})
