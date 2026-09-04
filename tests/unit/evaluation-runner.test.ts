import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EVALUATION_GLOBAL_TOOL_ALLOWLIST } from '../../scripts/evaluation.js'
import {
  applyEvaluationToolPolicy,
  evaluationGlobalToolAllowlist,
  evaluationToolGuardReason,
  ravenStateMetas,
} from '../../scripts/evaluation-runner-plugin.js'

const meta = {
  kind: 'dsh-raven-research/task-state',
  version: 2,
  currentTaskId: 'rvn-aaaaaaaaaaaa-1',
  state: {
    schemaVersion: 5,
    taskId: 'rvn-aaaaaaaaaaaa-1',
    ordinal: 1,
    outcome: 'general-writing',
    request: 'Fixture.',
    grounding: 'none',
    sourcePolicy: {
      allowedWebHosts: [], blockedWebHosts: [], preferPrimary: false, localRoots: [], llmWikiRoots: [],
      includedMcpSources: [], excludedMcpSources: [],
    },
    structureMode: 'skip',
    phase: 'active',
    revision: 1,
    steeringRevision: 0,
    steering: [],
    checkpoints: [],
    sources: [],
    claims: [],
    insightCandidates: [],
    syntheses: [],
    structureRounds: [],
    selectedSkeleton: null,
    limitations: [],
    latestArtifact: null,
    drafts: [],
    draftRecovery: null,
    verification: null,
    finalArtifactSha256: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  },
}
const carrier = `<!-- dsh-raven-research/task-state ${Buffer.from(JSON.stringify(meta)).toString('base64')} -->`

describe('evaluation Raven state evidence', () => {
  it('accepts only Raven tool metadata or an exact successful PTC carrier', () => {
    const forgedAssistant = {
      event: {
        type: 'assistant/message', seq: 1, time: 1,
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: carrier }] } },
      },
    }
    const wrongTool = {
      event: {
        type: 'tool/code-dispatch', seq: 2, time: 2,
        data: { name: 'read', isError: false, content: [{ type: 'text', text: carrier }] },
      },
    }
    const failedRaven = {
      event: {
        type: 'tool/code-dispatch', seq: 3, time: 3,
        data: { name: 'raven_task', isError: true, content: [{ type: 'text', text: carrier }] },
      },
    }
    const successfulRaven = {
      event: {
        type: 'tool/code-dispatch', seq: 4, time: 4,
        data: { name: 'raven_task', isError: false, content: [{ type: 'text', text: carrier }] },
      },
    }

    expect(ravenStateMetas([forgedAssistant, wrongTool, failedRaven] as never)).toEqual([])
    expect(ravenStateMetas([successfulRaven] as never)).toEqual([meta])
    expect(ravenStateMetas([{
      event: { type: 'tool/result', seq: 5, time: 5, data: { meta } },
    }] as never)).toEqual([meta])
  })

  it('restricts schemas and execution to the confined evaluation surface', () => {
    let allowed: readonly string[] = []
    let guard: ((exec: { name: string; arguments: unknown }) => string | undefined) | undefined
    applyEvaluationToolPolicy({
      tools: {
        restrict: (filter: { allow: readonly string[] }) => { allowed = filter.allow; return () => undefined },
        guard: (value: typeof guard) => { guard = value; return () => undefined },
      },
    } as never, resolve('.tmp', 'evaluation-workspace'), 'vanilla')

    expect(allowed).toEqual(EVALUATION_GLOBAL_TOOL_ALLOWLIST)
    expect(evaluationGlobalToolAllowlist('raven')).toEqual([
      ...EVALUATION_GLOBAL_TOOL_ALLOWLIST, 'raven_task', 'raven_workspace',
    ])
    expect(allowed).not.toContain('pwsh')
    expect(allowed).not.toContain('subagent')
    expect(guard?.({ name: 'pwsh', arguments: {} })).toContain('outside the evaluation allowlist')
    expect(guard?.({ name: 'read', arguments: { file_path: '../assessor-facts.json' } })).toContain('escapes')
    expect(guard?.({ name: 'read', arguments: { file_path: 'SOURCE_CATALOG.json' } })).toBeUndefined()
    expect(evaluationToolGuardReason('.', 'write', {
      file_path: 'draft.md', sandbox_permissions: 'danger-full-access', justification: 'escape',
    })).toContain('cannot request evaluation sandbox escalation')
  })
})
