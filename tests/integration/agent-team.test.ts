import { describe, expect, it, vi } from 'vitest'

import * as RavenPlugin from '../../src/index.js'

const signal = new AbortController().signal

interface TeamTool extends Record<string, unknown> {
  execute(args: unknown, exec: unknown): Promise<RavenPlugin.RavenDispatchResult>
  output: { presentationMeta(args: unknown, value: unknown): unknown }
}

type PreStep = (
  input: { agent: unknown },
  next: () => Promise<{ kind: string; messages?: unknown[] }>,
) => Promise<{ kind: string; messages?: Array<{ content: Array<{ text: string }> }> }>

/**
 * The experimental `ctx.agentTeams` capability, mirrored structurally. Raven never
 * imports the Harness Team package: it is private, unpublished, and carries no
 * stability promise, so duck typing is the only contract an external plugin has.
 */
function teamService(roster: Record<string, { id: string; role: 'lead' | 'teammate'; name: string }>) {
  return {
    tryMembership(agent: unknown) {
      return roster[(agent as { id: string }).id]
    },
  }
}

function harness(agentTeams: unknown) {
  let tool: TeamTool | undefined
  let preStep: PreStep | undefined
  RavenPlugin.apply({
    tools: {
      register(definition: TeamTool) {
        tool = definition
        return vi.fn()
      },
    },
    systemPrompt: { section() { return vi.fn() } },
    inject() { return vi.fn() },
    get(service: string) { return service === 'agentTeams' ? agentTeams : undefined },
    on(event: string, listener: unknown) {
      if (event === 'agent/pre-step') preStep = listener as PreStep
      return vi.fn()
    },
  } as never)
  if (tool === undefined || preStep === undefined) throw new Error('Raven did not register its Team-aware surface')
  return { tool, preStep }
}

describe('Raven inside an Agent Team', () => {
  it('shares one Task across the Team and refuses a competing one', async () => {
    // Both rows carry the SAME Team id: the Harness resolves it as the Lead's own
    // session id, which is what makes the Team one Raven Task rather than two.
    const { tool, preStep } = harness(teamService({
      'lead-session': { id: 'lead-session', role: 'lead', name: 'lead' },
      'mate-session': { id: 'lead-session', role: 'teammate', name: 'reader' },
    }))
    const lead = { id: 'lead-session', session: { events: [] as unknown[] } }
    const teammate = { id: 'mate-session', session: { events: [] as unknown[] } }

    const started = await tool.execute({
      action: 'start',
      outcome: 'research',
      request: 'One question the whole Team works on.',
    }, { agent: lead, signal })

    // The teammate reads the Lead's Task without any record in its own session log.
    const seen = await tool.execute({ action: 'status' }, { agent: teammate, signal })
    expect(seen.state.taskId).toBe(started.state.taskId)

    await expect(tool.execute({
      action: 'start',
      outcome: 'research',
      request: 'A competing Task the Team never asked for.',
    }, { agent: teammate, signal })).rejects.toThrow(`Raven Task ${started.state.taskId} is already active`)

    // A teammate's Checkpoint lands on the Team's Task, and the Lead sees it.
    await tool.execute({
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A draft a teammate contributed.',
      artifact: 'A draft the whole Team owns.',
    }, { agent: teammate, signal })
    const fromLead = await tool.execute({ action: 'status' }, { agent: lead, signal })
    expect(fromLead.state.latestArtifact).toBe('A draft the whole Team owns.')

    const decision = await preStep({ agent: teammate }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    const injected = decision.messages?.[0]?.content[0]?.text ?? ''
    expect(injected).toContain('Agent Team member "reader"')
    expect(injected).toContain('never start a competing Task')

    // The Lead is told to continue its Task, without the teammate-only instruction.
    const leadDecision = await preStep({ agent: lead }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    expect(leadDecision.messages?.[0]?.content[0]?.text ?? '').not.toContain('Agent Team member')
  })

  it('merges each member\'s own durable records into the shared Task book', async () => {
    const roster = {
      'lead-session': { id: 'lead-session', role: 'lead' as const, name: 'lead' },
      'mate-session': { id: 'lead-session', role: 'teammate' as const, name: 'reader' },
    }
    const first = harness(teamService(roster))
    const leadEvents: unknown[] = []
    const lead = { id: 'lead-session', session: { events: leadEvents } }
    const started = await first.tool.execute({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'A Task recorded in the Lead session only.',
    }, { agent: lead, signal })
    leadEvents.push({ type: 'tool/result', data: { meta: first.tool.output.presentationMeta({}, started) } })

    // A fresh process: the teammate is seen FIRST and contributes nothing durable,
    // so the shared book must still pick the Task up when the Lead is folded in.
    const reloaded = harness(teamService(roster))
    const teammate = { id: 'mate-session', session: { events: [] as unknown[] } }
    await expect(reloaded.tool.execute({ action: 'status' }, { agent: teammate, signal }))
      .rejects.toThrow('No Raven Task exists in this session')
    const afterLead = await reloaded.tool.execute({ action: 'status' }, { agent: lead, signal })
    expect(afterLead.state.taskId).toBe(started.state.taskId)
    const teammateSees = await reloaded.tool.execute({ action: 'status' }, { agent: teammate, signal })
    expect(teammateSees.state.taskId).toBe(started.state.taskId)
  })

  it('keeps working where no Team capability is composed, and where it throws', async () => {
    const withoutTeams = harness(undefined)
    const agent = { id: 'solo-session', session: { events: [] as unknown[] } }
    const solo = await withoutTeams.tool.execute({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'No Team is composed here.',
    }, { agent, signal })
    expect(solo.state.phase).toBe('active')

    // An experimental service must never be able to fail a Task step.
    const hostile = harness({ tryMembership() { throw new Error('experimental capability exploded') } })
    const other = { id: 'hostile-team-session', session: { events: [] as unknown[] } }
    const stillWorks = await hostile.tool.execute({
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'The Team probe throws here.',
    }, { agent: other, signal })
    expect(stillWorks.state.phase).toBe('active')
  })
})
