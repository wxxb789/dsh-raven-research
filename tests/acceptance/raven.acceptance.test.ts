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

const structureInsightText = 'Short evaluation windows may make visible activity crowd out delayed outcomes.'
const structureInsight = {
  insightId: 'I1',
  text: structureInsightText,
  kind: 'explanation',
  pattern: 'incentive-mismatch',
  claimIds: ['C1'],
  assumptions: ['Evaluation decisions privilege outcomes visible inside the review window.'],
  rationale: 'The mechanism connects the observed activity reward to a later outcome deficit.',
  wouldChangeMind: 'Evidence that evaluation decisions consistently use delayed outcome measures.',
  confidence: 'medium',
}
const structureAnalysisClaim = {
  claimId: 'A1',
  text: structureInsightText,
  kind: 'analysis',
  importance: 'material',
  disposition: 'qualified',
  sourceIds: [],
  insightId: 'I1',
  derivedFromClaimIds: ['C1'],
  assumptions: structureInsight.assumptions,
}

const acceptanceSkeleton = (overrides: Record<string, unknown> = {}) => ({
  frame: 'Incentive timing explains why visible activity crowds out delayed outcomes.',
  thesis: 'The apparent execution problem is primarily an incentive-horizon problem.',
  centralQuestion: 'Why do capable teams optimize for activity instead of delayed outcomes?',
  reasoningFlow: ['Establish the recurring gap.', 'Explain the timing mechanism.', 'Derive the intervention.'],
  sections: [{
    sectionId: 'mechanism',
    title: 'The operating mechanism',
    purpose: 'Connect review timing to the behavior it rewards.',
    claimIds: ['C1', 'A1'],
    insightIds: ['I1'],
    evidenceNeeds: ['Longitudinal evidence separating short activity from delayed outcomes.'],
    counterarguments: [{
      text: 'Measurement cost may explain the pattern without an incentive mechanism.',
      claimIds: ['C1', 'A1'],
      insightIds: ['I1'],
    }],
  }],
  unresolvedWeaknesses: ['The interaction with measurement cost remains unresolved.'],
  readerTakeaway: 'Change the evaluation horizon before demanding different behavior.',
  ...overrides,
})

const acceptanceCandidates = () => [{
  candidateId: 'SK1',
  label: 'Incentive horizon',
  skeleton: acceptanceSkeleton(),
}, {
  candidateId: 'SK2',
  label: 'Measurement bottleneck',
  skeleton: acceptanceSkeleton({
    frame: 'Measurement infrastructure explains why delayed outcomes disappear from decisions.',
    thesis: 'The apparent execution problem is primarily an observability-cost problem.',
    centralQuestion: 'What becomes rational when long-horizon outcomes are expensive to observe?',
    reasoningFlow: ['Map cheap measures.', 'Explain attention allocation.', 'Derive the observability intervention.'],
    sections: [{
      sectionId: 'measurement',
      title: 'The observability bottleneck',
      purpose: 'Show how measurement cost narrows what decision makers can reward.',
      claimIds: ['C1', 'A1'],
      insightIds: ['I1'],
      evidenceNeeds: ['Cost and latency data for delayed-outcome measurement.'],
      counterarguments: [{
        text: 'Decision makers may ignore delayed measures even when those measures are cheap.',
        claimIds: ['C1', 'A1'],
        insightIds: ['I1'],
      }],
    }],
    unresolvedWeaknesses: ['Measurement cost is not quantified in the current record.'],
    readerTakeaway: 'Build observability before treating behavior as an incentive failure.',
  }),
}]

const acceptanceBattle = (items = acceptanceCandidates()) => items.map((candidate, index) => ({
  candidateId: candidate.candidateId,
  explainsBetter: [`Explains causal mechanism ${index + 1}.`],
  failsToExplain: [`Leaves boundary ${index + 1} unresolved.`],
  conventionalWisdom: [`Risks repeating prescription ${index + 1}.`],
  evidenceRequired: [`Needs discriminating evidence ${index + 1}.`],
  assumptions: [`Depends on assumption ${index + 1}.`],
  nonObviousInsights: [`Surfaces implication ${index + 1}.`],
  mergeableElements: [`Contributes a section to a stronger hybrid.`],
}))

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

  it('turns evidence into inspectable competing Insight Candidates with defensible analysis lineage', async () => {
    const fetch = vi.fn(async ({ url }: { url: string }) => ({
      url,
      statusCode: 200,
      body: { kind: 'text' as const, content: 'Exact evidence excerpt for S1. Exact evidence excerpt for S2.' },
    }))
    const raven = createHarness({ fetch })
    const started = await raven.run({
      action: 'start', outcome: 'research', request: 'Explain what follows from two timing constraints.',
    })
    const evidence = await raven.run({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'read',
      summary: 'Two source observations before interpretation.',
      artifact: 'The first record reports delayed settlement [@S1]. The second reports short review windows [@S2].',
      sources: [source('S1', 'delayed-settlement'), source('S2', 'short-review')],
      claims: [
        claim('C1', 'S1', 'The first record reports delayed settlement.'),
        claim('C2', 'S2', 'The second record reports short review windows.'),
      ],
    })
    const debt = await raven.run({
      action: 'synthesize', taskId: started.state.taskId, scope: 'Interpretation section',
      purpose: 'synthesis', claimIds: ['C1', 'C2'], insights: [],
    })
    expect(debt.state.syntheses.at(-1)).toMatchObject({ summaryDebt: 'high' })
    expect(debt.issues.join(' ')).toContain('summary debt')

    const insightText = 'Short review windows may reward visible activity before delayed outcomes can be observed.'
    const assumption = 'Reviewers optimize decisions around outcomes visible inside the review window.'
    const synthesized = await raven.run({
      action: 'synthesize', taskId: started.state.taskId, scope: 'Interpretation section',
      purpose: 'synthesis', claimIds: ['C1', 'C2'], insights: [
        {
          insightId: 'I1', text: insightText, kind: 'explanation', pattern: 'incentive-mismatch',
          claimIds: ['C1', 'C2'], assumptions: [assumption], confidence: 'medium',
          rationale: 'The timing mismatch supplies a mechanism connecting the two observations.',
          wouldChangeMind: 'Evidence that reviews routinely use outcomes collected after settlement.',
          competesWith: ['I2'],
        },
        {
          insightId: 'I2',
          text: 'The same timing pattern may reflect measurement cost rather than strategic incentives.',
          kind: 'hypothesis', pattern: 'alternative-causal-mechanism', claimIds: ['C1', 'C2'],
          assumptions: ['Long-horizon outcomes are materially more expensive to measure.'], confidence: 'low',
          rationale: 'Measurement cost explains the observations without assuming strategic behavior.',
          wouldChangeMind: 'Evidence that long-horizon outcomes are cheap, collected, and deliberately ignored.',
          competesWith: ['I1'],
        },
      ],
    })
    expect(synthesized.state.insightCandidates.map(item => item.insightId)).toEqual(['I1', 'I2'])
    expect(synthesized.state.syntheses.at(-1)).toMatchObject({ summaryDebt: 'none' })

    await expect(raven.run({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'analyze', summary: 'Invalid fact promotion.',
      artifact: 'Short review windows reward visible activity [@S1].',
      claims: [{
        claimId: 'BAD', text: insightText, kind: 'external', importance: 'material', disposition: 'supported',
        sourceIds: ['S1'], insightId: 'I1', derivedFromClaimIds: ['C1', 'C2'], assumptions: [assumption],
      }],
    })).rejects.toThrow(/cannot be promoted as external fact/)

    const analyzed = await raven.run({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'analyze',
      summary: 'One interpretation adopted with lineage while its alternative remains visible.',
      artifact: `The records report delayed settlement [@S1] and short review windows [@S2]. ${insightText}`,
      claims: [{
        claimId: 'A1', text: insightText, kind: 'analysis', importance: 'material', disposition: 'qualified',
        sourceIds: [], insightId: 'I1', derivedFromClaimIds: ['C1', 'C2'], assumptions: [assumption],
      }],
    })

    expect(analyzed.renderedArtifact).toContain('**C1** (source says)')
    expect(analyzed.renderedArtifact).toContain('## Analysis lineage')
    expect(analyzed.renderedArtifact).toContain('Raven inference from C1, C2')
    expect(analyzed.renderedArtifact).toContain('alternative I2 remains a candidate')
    expect(analyzed.state.claims.find(item => item.claimId === 'A1')).toMatchObject({
      kind: 'analysis', insightId: 'I1', derivedFromClaimIds: ['C1', 'C2'], assumptions: [assumption],
    })
    expect(evidence.state.insightCandidates).toEqual([])
    const prompt = String(raven.sections.find(section => section.name === 'tool:raven-task')?.text)
    expect(prompt).toContain('Epistemic layers')
    expect(prompt).toContain('Raven infers Y from A, B, and C')
    expect(prompt).toContain('alternative causal mechanisms')
    expect(prompt).toContain('Summary debt')
    expect(prompt).toContain('Structure Studio')
    expect(prompt).toContain('collaboration, not an approval gate')
    expect(prompt).toContain('conditional <raven_structure_studio> instructions')
    expect(prompt).not.toContain('Battle the Candidates before involving the user')
    expect(prompt).toContain('Do not force action=synthesize onto trivial writing')
    expect(prompt).toContain('one selected section at a time')
    expect(prompt).toContain('conditional <raven_drafting> instructions')
    expect(prompt).toContain('candidate material, never evidence or corroboration')
  })

  it('selects or hybridizes evidence-linked argument architectures before prose while preserving autonomous and skip paths', async () => {
    const fetch = vi.fn(async ({ url }: { url: string }) => ({
      url,
      statusCode: 200,
      body: { kind: 'text' as const, content: 'Exact evidence excerpt for S1.' },
    }))
    const collaborative = createHarness({ fetch })
    const started = await collaborative.run({
      action: 'start', outcome: 'general-writing', grounding: 'optional', structureMode: 'collaborative',
      request: 'Write a long-form argument about why organizations reward visible activity.',
    })
    await collaborative.run({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'analyze',
      summary: 'Evidence the argument architectures must explain.',
      artifact: 'Observed incentives reward visible short-term activity [@S1].',
      sources: [source('S1', 'structure-studio')],
      claims: [claim('C1', 'S1', 'Observed incentives reward visible short-term activity.')],
    })
    await collaborative.run({
      action: 'synthesize', taskId: started.state.taskId, scope: 'Argument mechanism',
      purpose: 'synthesis', claimIds: ['C1'], insights: [structureInsight],
    })
    await collaborative.run({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'analyze',
      summary: 'Promoted one defensible insight before structural exploration.',
      artifact: `Observed incentives reward visible short-term activity [@S1]. ${structureInsightText}`,
      claims: [structureAnalysisClaim],
    })
    await expect(collaborative.run({
      action: 'draft', taskId: started.state.taskId, instruction: 'Draft the opening.',
    })).rejects.toThrow(/selected argument architecture/)

    const collaborativeCandidates = acceptanceCandidates()
    const structured = await collaborative.run({
      action: 'structure', taskId: started.state.taskId,
      candidates: collaborativeCandidates, battle: acceptanceBattle(collaborativeCandidates),
      recommendation: {
        kind: 'hybrid', candidateIds: ['SK1', 'SK2'],
        rationale: 'Use incentive timing as the mechanism and measurement cost as its boundary condition.',
      },
    })
    expect(new Set(structured.state.structureRounds[0]?.candidates.map(item => item.skeleton.frame)).size).toBe(2)
    expect(new Set(structured.state.structureRounds[0]?.candidates.map(item => item.skeleton.thesis)).size).toBe(2)
    expect(structured.state.structureRounds[0]?.battle).toHaveLength(2)

    const hybrid = acceptanceSkeleton({
      frame: 'Incentive timing and observability cost reinforce one operating system.',
      thesis: 'Activity bias persists when short review windows and costly outcome measurement reinforce each other.',
      reasoningFlow: ['Establish the timing gap.', 'Add measurement cost as its boundary.', 'Derive the joint intervention.'],
      readerTakeaway: 'Change evaluation timing and outcome observability together.',
    })
    const selected = await collaborative.run({
      action: 'select-structure', taskId: started.state.taskId, chosenBy: 'user',
      candidateIds: ['SK1', 'SK2'], hybrid,
      rationale: 'The user combined the strongest mechanism with its most important boundary condition.',
    })
    expect(selected.state.selectedSkeleton).toMatchObject({
      kind: 'hybrid', chosenBy: 'user', candidateIds: ['SK1', 'SK2'],
      skeleton: {
        thesis: hybrid.thesis,
        sections: [{
          claimIds: ['C1', 'A1'],
          insightIds: ['I1'],
          evidenceNeeds: [expect.stringContaining('Longitudinal evidence')],
          counterarguments: [{ text: expect.stringContaining('Measurement cost') }],
        }],
      },
    })
    const drafted = await collaborative.run({
      action: 'checkpoint', taskId: started.state.taskId, stage: 'draft',
      summary: 'Prose constrained by the selected hybrid architecture.',
      artifact: 'Observed incentives reward visible short-term activity [@S1].',
    })
    expect(drafted.status).toBe('active')
    const redirected = await collaborative.run({
      action: 'steer', taskId: started.state.taskId,
      correction: 'Redirect the argument to a skeptical board audience.', structureMode: 'collaborative',
    })
    expect(redirected.state.selectedSkeleton).toBeNull()

    const autonomous = createHarness()
    const delegated = await autonomous.run({
      action: 'start', outcome: 'general-writing', grounding: 'none', structureMode: 'autonomous',
      request: 'Choose the strongest architecture yourself for a long-form essay.',
    })
    const premise = await autonomous.run({
      action: 'checkpoint', taskId: delegated.state.taskId, stage: 'analyze',
      summary: 'A context Claim for autonomous structure.', artifact: 'Visible activity dominates operating attention.',
      claims: [{
        claimId: 'C1', text: 'Visible activity dominates operating attention.', kind: 'analysis',
        importance: 'context', disposition: 'supported', sourceIds: [],
      }],
    })
    await autonomous.run({
      action: 'synthesize', taskId: delegated.state.taskId, scope: 'Autonomous mechanism',
      purpose: 'synthesis', claimIds: ['C1'], insights: [structureInsight],
    })
    const promoted = await autonomous.run({
      action: 'checkpoint', taskId: delegated.state.taskId, stage: 'analyze',
      summary: 'Promoted one insight for autonomous structure.',
      artifact: `Visible activity dominates operating attention. ${structureInsightText}`,
      claims: [structureAnalysisClaim],
    })
    const autonomousCandidates = acceptanceCandidates()
    const autoStructured = await autonomous.run({
      action: 'structure', taskId: delegated.state.taskId,
      candidates: autonomousCandidates, battle: acceptanceBattle(autonomousCandidates),
      recommendation: { kind: 'candidate', candidateIds: ['SK1'], rationale: 'It explains the mechanism most directly.' },
    })
    expect(autoStructured.state.taskId).toBe(premise.state.taskId)
    expect(autoStructured.state.taskId).toBe(promoted.state.taskId)
    const autoSelected = await autonomous.run({
      action: 'select-structure', taskId: delegated.state.taskId, chosenBy: 'raven',
      candidateIds: ['SK1'], rationale: 'Raven selected the strongest explanatory architecture.',
    })
    expect(autoSelected.state.selectedSkeleton).toMatchObject({ kind: 'candidate', chosenBy: 'raven' })

    const lightweight = createHarness()
    const skipped = await lightweight.run({
      action: 'start', outcome: 'general-writing', grounding: 'none', structureMode: 'skip',
      request: 'Rewrite this two-sentence release note.',
    })
    const quickDraft = await lightweight.run({
      action: 'checkpoint', taskId: skipped.state.taskId, stage: 'draft',
      summary: 'Lightweight rewrite.', artifact: 'The release rolls out tomorrow.',
    })
    expect(quickDraft.state.structureRounds).toEqual([])
    expect(quickDraft.state.selectedSkeleton).toBeNull()
  })

  it('supports general writing without forcing external evidence', async () => {
    const raven = createHarness()
    const started = await raven.run({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Summarize the supplied release note for engineering managers.',
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
    expect(completed.state.insightCandidates).toEqual([])
    expect(completed.state.syntheses).toEqual([])
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

    expect(action.enum).toEqual([
      'start', 'discover', 'synthesize', 'structure', 'select-structure', 'draft', 'checkpoint', 'steer',
      'complete', 'status', 'inspect', 'stop', 'resume', 'export',
    ])
    expect(action.enum).not.toContain('confirm')
    expect(action.enum).not.toContain('approve')
    expect(String(raven.sections[0]?.text)).toContain('Do not ask for approval between')
    expect(String(raven.sections[0]?.text)).toContain('internal orchestration')
    expect(String(raven.sections[0]?.text)).toContain('Users speak naturally')
  })
})
