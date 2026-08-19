import { describe, expect, it } from 'vitest'

import { ACTION_FIELDS, createRavenEngine } from '../../src/engine.js'
import { apply } from '../../src/plugin.js'
import type { SourceVerifier } from '../../src/domain.js'

interface ParameterSchema {
  properties: Record<string, { enum?: string[]; description?: string }>
}

function toolParameters(): ParameterSchema {
  let parameters: ParameterSchema | undefined
  apply({
    tools: {
      register(definition: { parameters: ParameterSchema }) {
        parameters = definition.parameters
        return () => undefined
      },
    },
    systemPrompt: { section() { return () => undefined } },
    inject() { return () => undefined },
    get() { return undefined },
    on() { return () => undefined },
  } as never)
  if (parameters === undefined) throw new Error('expected a registered raven_task definition')
  return parameters
}

const signal = new AbortController().signal
const now = () => '2026-08-16T16:00:00.000Z'
const sourceVerifier: SourceVerifier = { verify: async () => [] }

describe('raven_task action field contract', () => {
  it('advertises exactly the actions the runtime accepts', () => {
    expect(toolParameters().properties.action?.enum).toEqual(Object.keys(ACTION_FIELDS))
  })

  it('declares every field the runtime accepts, and accepts every field it declares', () => {
    const declared = new Set(Object.keys(toolParameters().properties))
    const accepted = new Set(Object.values(ACTION_FIELDS).flat())
    for (const field of accepted) expect(declared).toContain(field)
    for (const field of declared) expect(accepted).toContain(field)
  })

  it('tells the caller which action owns each field', () => {
    const properties = toolParameters().properties
    // The flat schema lists every action's fields side by side, so a field that
    // does not name its action invites one action's field to be sent to another.
    for (const [field, schema] of Object.entries(properties)) {
      if (field === 'action') continue
      expect(schema.description ?? '', `${field} must name its action`)
        .toMatch(field === 'taskId' ? /action/ : /action=/)
    }
    expect(properties.action?.description ?? '').toContain('complete(taskId, artifact)')
  })

  it('names the accepted fields when it rejects one belonging to another action', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    await expect(engine.dispatch(null, {
      action: 'start',
      outcome: 'learning',
      request: 'Reject a checkpoint field sent to start.',
      grounding: 'none',
      stage: 'discover',
    }, { sessionId: 'session-cross-action', signal })).rejects.toThrow(
      /unknown field\(s\): stage\. Accepted field\(s\): action, outcome, request, grounding/,
    )
  })
})
