import { describe, expect, it } from 'vitest'

import { ACTION_FIELDS, createRavenEngine } from '../../src/engine.js'
import { apply } from '../../src/plugin.js'
import { RAVEN_LIMITS, type SourceVerifier } from '../../src/domain.js'

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

  it('describes exactly four origins, Markdown provenance, and Task Source Policy', () => {
    const properties = toolParameters().properties as unknown as Record<string, Record<string, unknown>>
    const sources = properties.sources
    const source = sources?.items as Record<string, unknown>
    const sourceProperties = source.properties as Record<string, Record<string, unknown>>
    const resource = sourceProperties.resource
    const resourceProperties = resource?.properties as Record<string, Record<string, unknown>>
    const representation = sourceProperties.representation
    const alternatives = representation?.oneOf as Array<Record<string, unknown>>
    const markdown = alternatives.find(item => item.type === 'object')
    const markdownProperties = markdown?.properties as Record<string, Record<string, unknown>>
    const sourcePolicy = properties.sourcePolicy
    const policyProperties = sourcePolicy?.properties as Record<string, unknown>

    expect(source.required).toEqual(['sourceId', 'title', 'locator', 'excerpt'])
    expect(source.oneOf).toEqual([
      { required: ['url'], not: { anyOf: [{ required: ['resource'] }, { required: ['representation'] }] } },
      { required: ['resource', 'representation'] },
    ])
    expect(resource?.required).toEqual(['origin', 'uri'])
    expect(resourceProperties.origin?.enum).toEqual(['web', 'local', 'llm-wiki', 'mcp'])
    expect(markdown?.required).toEqual(['format', 'derivation', 'coverage', 'producedBy'])
    expect(markdownProperties.format?.enum).toEqual(['markdown'])
    expect(markdownProperties.derivation?.enum).toEqual(['original', 'converted'])
    expect(markdownProperties.coverage?.enum).toEqual(['full', 'segment', 'unknown'])
    expect(markdownProperties.inspectionCallId?.description).toContain('Prior successful ordinary Harness tool call')
    expect(Object.keys(policyProperties)).toEqual([
      'allowedWebHosts', 'blockedWebHosts', 'preferPrimary', 'localRoots', 'llmWikiRoots',
      'includedMcpSources', 'excludedMcpSources',
    ])
  })

  it('exposes first-class bounded Insight Candidates and explicit synthesis purposes', () => {
    const properties = toolParameters().properties as unknown as Record<string, Record<string, unknown>>
    const insights = properties.insights
    const item = insights?.items as Record<string, unknown>
    const insightProperties = item?.properties as Record<string, Record<string, unknown>>

    expect(properties.action?.enum).toContain('synthesize')
    expect(properties.action?.enum).toContain('inspect')
    expect(ACTION_FIELDS.status).toEqual(['action', 'taskId', 'insightOffset'])
    expect(ACTION_FIELDS.inspect).toEqual(['action', 'taskId', 'insightIds'])
    expect(properties.insightOffset).toMatchObject({ type: 'integer', minimum: 0 })
    expect(properties.insightOffset?.description).toContain(String(RAVEN_LIMITS.insightInspectionIds))
    expect(properties.insightIds?.description).toContain(`1-${RAVEN_LIMITS.insightInspectionIds}`)
    expect(properties.insightIds?.description).toContain('no implicit inspect-all')
    expect(properties.purpose?.enum).toEqual(['summary', 'explanation', 'synthesis'])
    expect(item.required).toEqual([
      'insightId', 'text', 'kind', 'pattern', 'claimIds', 'assumptions', 'rationale',
      'wouldChangeMind', 'confidence',
    ])
    expect(insightProperties.kind?.enum).toEqual([
      'interpretation', 'connection', 'explanation', 'hypothesis', 'reframing', 'implication', 'thesis',
    ])
    expect(insightProperties.pattern?.enum).toContain('alternative-causal-mechanism')
    expect(insightProperties.pattern?.enum).toContain('cross-domain-analogy')
    expect(insightProperties.wouldChangeMind?.description).toContain('reverse or materially weaken')
  })

  it('exposes Structure Studio candidates, battle criteria, steering modes, and explicit selection', () => {
    const properties = toolParameters().properties as unknown as Record<string, Record<string, unknown>>
    const candidates = properties.candidates
    const candidate = candidates?.items as Record<string, unknown>
    const candidateProperties = candidate?.properties as Record<string, Record<string, unknown>>
    const skeleton = candidateProperties.skeleton
    const skeletonProperties = skeleton?.properties as Record<string, Record<string, unknown>>
    const sections = skeletonProperties.sections
    const section = sections?.items as Record<string, unknown>
    const battle = properties.battle
    const battleEntry = battle?.items as Record<string, unknown>
    const recommendation = properties.recommendation
    if (skeleton === undefined || recommendation === undefined) {
      throw new Error('expected Structure Studio schemas')
    }

    expect(properties.action?.enum).toContain('structure')
    expect(properties.action?.enum).toContain('select-structure')
    expect(ACTION_FIELDS.structure).toEqual(['action', 'taskId', 'candidates', 'battle', 'recommendation'])
    expect(ACTION_FIELDS['select-structure']).toEqual([
      'action', 'taskId', 'chosenBy', 'candidateIds', 'hybrid', 'rationale',
    ])
    expect(properties.structureMode?.enum).toEqual(['collaborative', 'autonomous', 'skip'])
    expect(properties.structureMode?.description).toContain('action=start or action=steer')
    expect(candidate.required).toEqual(['candidateId', 'label', 'skeleton'])
    expect(skeleton.required).toEqual([
      'frame', 'thesis', 'centralQuestion', 'reasoningFlow', 'sections',
      'unresolvedWeaknesses', 'readerTakeaway',
    ])
    expect(section.required).toEqual([
      'sectionId', 'title', 'purpose', 'claimIds', 'insightIds', 'evidenceNeeds', 'counterarguments',
    ])
    expect(battleEntry.required).toEqual([
      'candidateId', 'explainsBetter', 'failsToExplain', 'conventionalWisdom', 'evidenceRequired',
      'assumptions', 'nonObviousInsights', 'mergeableElements',
    ])
    const recommendationChoices = recommendation.oneOf as Array<{
      readonly required: string[]
      readonly properties: Record<string, { readonly const?: string; readonly description?: string }>
    }>
    expect(recommendationChoices).toHaveLength(2)
    expect(recommendationChoices.map(choice => choice.properties.kind?.const)).toEqual(['candidate', 'hybrid'])
    expect(recommendationChoices[0]?.required).toEqual(['kind', 'candidateIds', 'rationale'])
    expect(recommendationChoices[0]?.properties.candidateIds?.description).toContain('Exactly one')
    expect(recommendationChoices[1]?.properties.candidateIds?.description)
      .toContain(`One to ${RAVEN_LIMITS.skeletonCandidates}`)
    expect(properties.chosenBy?.enum).toEqual(['user', 'raven'])
    expect(properties.hybrid).toMatchObject({ type: 'object' })
    expect(properties.candidateIds?.description).toContain('action=select-structure')
  })

  it('keeps legacy migration Source IDs out of tool and engine input', async () => {
    const properties = toolParameters().properties as unknown as Record<string, Record<string, unknown>>
    const claim = properties.claims?.items as Record<string, unknown>
    const claimProperties = claim.properties as Record<string, unknown>
    expect(claimProperties).not.toHaveProperty('legacySourceIds')

    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start', outcome: 'learning', grounding: 'none', request: 'Reject codec-only Claim fields.',
    }, { sessionId: 'session-legacy-source-ids', signal })
    await expect(engine.dispatch(started.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'draft', summary: 'Invalid compatibility input.',
      artifact: 'A new analysis Claim.',
      claims: [{
        claimId: 'A1', text: 'A new analysis Claim.', kind: 'analysis', importance: 'context',
        disposition: 'supported', sourceIds: [], legacySourceIds: ['S1'],
      }],
    }, { sessionId: 'session-legacy-source-ids', signal })).rejects.toThrow(/unknown field\(s\): legacySourceIds/)
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
