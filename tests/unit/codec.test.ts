import { describe, expect, it } from 'vitest'

import { decodeRavenTaskState } from '../../src/codec.js'
import { createRavenEngine } from '../../src/engine.js'
import type { SourceVerifier } from '../../src/domain.js'

const now = () => '2026-08-16T16:00:00.000Z'
const sourceVerifier: SourceVerifier = { verify: async () => [] }

async function validState() {
  const engine = createRavenEngine({ now, sourceVerifier })
  return (await engine.dispatch(null, {
    action: 'start',
    outcome: 'learning',
    grounding: 'none',
    request: 'Create a replayable Task.',
  }, {
    sessionId: 'codec-session',
    signal: new AbortController().signal,
  })).state
}

describe('Raven Task snapshot codec', () => {
  it('round-trips a complete schema-v1 state through JSON', async () => {
    const state = await validState()
    const roundTrip: unknown = JSON.parse(JSON.stringify(state))
    expect(decodeRavenTaskState(roundTrip)).toEqual(state)
  })

  it('rejects an unknown schema version', async () => {
    const state = await validState()
    expect(decodeRavenTaskState({ ...state, schemaVersion: 99 })).toBeUndefined()
  })

  it('rejects unknown root and nested fields instead of retaining them', async () => {
    const state = await validState()
    expect(decodeRavenTaskState({ ...state, unexpected: true })).toBeUndefined()
    expect(decodeRavenTaskState({
      ...state,
      revision: 2,
      steeringRevision: 1,
      steering: [{
        revision: 1,
        correction: 'A valid correction.',
        createdAt: now(),
        unexpected: true,
      }],
    })).toBeUndefined()
  })

  it('rejects malformed nested records rather than trusting top-level shape', async () => {
    const state = await validState()
    expect(decodeRavenTaskState({
      ...state,
      sources: [{ sourceId: 'BROKEN' }],
    })).toBeUndefined()
  })
})
