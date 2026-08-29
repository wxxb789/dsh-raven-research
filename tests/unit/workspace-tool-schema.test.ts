import { describe, expect, it } from 'vitest'

import { SOURCE_ORIGINS } from '../../src/domain.js'
import { apply } from '../../src/plugin.js'
import { WORKSPACE_ACTION_FIELDS } from '../../src/workspace.js'

interface ParameterSchema {
  properties: Record<string, Record<string, unknown>>
}

interface CapturedTool {
  name: string
  description: string
  parameters: ParameterSchema
  output: {
    render(args: unknown, value: unknown): Array<{ type: string; text: string }>
  }
}

function tools(): Map<string, CapturedTool> {
  const registered = new Map<string, CapturedTool>()
  apply({
    tools: {
      register(definition: CapturedTool) {
        registered.set(definition.name, definition)
        return () => undefined
      },
    },
    systemPrompt: { section() { return () => undefined } },
    inject() { return () => undefined },
    get() { return undefined },
    on() { return () => undefined },
  } as never)
  return registered
}

describe('raven_workspace tool contract', () => {
  it('registers a lifecycle separate from raven_task with an exact action-field contract', () => {
    const registered = tools()
    expect([...registered.keys()].sort()).toEqual(['raven_task', 'raven_workspace'])

    const workspace = registered.get('raven_workspace')
    if (workspace === undefined) throw new Error('expected raven_workspace')
    expect(workspace.description).toContain('separate from Raven Task lifecycle')
    expect(workspace.parameters.properties.action?.enum).toEqual(Object.keys(WORKSPACE_ACTION_FIELDS))

    const declared = new Set(Object.keys(workspace.parameters.properties))
    const accepted = new Set(Object.values(WORKSPACE_ACTION_FIELDS).flat())
    expect(declared).toEqual(accepted)
    for (const [field, schema] of Object.entries(workspace.parameters.properties)) {
      if (field === 'action') continue
      expect(schema.description ?? '', `${field} must name its action ownership`).toMatch(/action=/)
    }

    const complete = workspace.parameters.properties.complete
    const completeActions = Object.entries(WORKSPACE_ACTION_FIELDS)
      .filter(([, fields]) => fields.some(field => field === 'complete'))
      .map(([action]) => action)
      .sort()
    expect(completeActions).toEqual(['health', 'maintain'])
    expect(complete).toMatchObject({ type: 'boolean' })
    expect(complete?.description).toContain('action=health or action=maintain')
    expect(complete?.description).toContain('true only after the agent inspected the complete Workspace Markdown snapshot')
  })

  it('reuses Source normalization provenance for adopted documents and describes conditional writes', () => {
    const workspace = tools().get('raven_workspace')
    if (workspace === undefined) throw new Error('expected raven_workspace')
    const documents = workspace.parameters.properties.documents
    if (documents === undefined) throw new Error('expected documents schema')
    const document = documents.items as Record<string, unknown>
    const documentProperties = document.properties as Record<string, Record<string, unknown>>
    const resource = documentProperties.resource
    const representation = documentProperties.representation
    if (resource === undefined || representation === undefined) throw new Error('expected document provenance schemas')
    const representationAlternatives = representation.oneOf as Array<Record<string, unknown>>
    const markdown = representationAlternatives.find(item => item.type === 'object')
    const markdownProperties = markdown?.properties as Record<string, Record<string, unknown>>

    expect(resource.properties).toEqual(expect.objectContaining({
      origin: expect.objectContaining({ enum: SOURCE_ORIGINS.filter(origin => origin !== 'web') }),
      uri: expect.any(Object),
    }))
    expect(markdown?.required).toEqual(['format', 'derivation', 'coverage', 'producedBy', 'inspectionCallId', 'markdown'])
    expect(markdownProperties.inspectionCallId?.description).toContain('ordinary Harness tool call')

    const rendered = workspace.output.render({}, {
      status: 'ready', action: 'maintain', message: 'Prepared.', issues: [],
      pages: [{ path: 'wiki/index.md', content: '# Index\n' }],
      preconditions: [{ path: 'wiki/index.md', expected: 'sha256:abc' }],
      logEntry: '<!-- raven-workspace-op:abc -->\n',
    }).map(block => block.text).join('\n')
    expect(rendered).toContain('No files have been changed')
    expect(rendered).toContain('sha256:abc')
    expect(rendered).toContain('append only if its operation marker is absent')
  })
})
