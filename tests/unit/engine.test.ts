import { describe, expect, it, vi } from 'vitest'

import { createRavenEngine, renderArtifact } from '../../src/engine.js'
import {
  isRetryableRavenError,
  RavenError,
  RAVEN_LIMITS,
  RavenTypeError,
  type SourceCheckRequest,
  type SourceVerifier,
} from '../../src/domain.js'

const signal = new AbortController().signal
const now = () => '2026-08-16T16:00:00.000Z'
const sourceVerifier: SourceVerifier = {
  verify: async sources => sources.map(source => ({
    sourceId: source.sourceId,
    status: 'reachable',
    checkedAt: now(),
    statusCode: 200,
    resolvedUrl: source.url,
  })),
}

describe('Raven task engine', () => {
  it('rejects unknown action and nested evidence fields at the runtime boundary', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    await expect(engine.dispatch(null, {
      action: 'dance',
      unexpected: true,
    }, { sessionId: 'session-unknown-action', signal })).rejects.toThrow('Unsupported Raven action: dance')
    await expect(engine.dispatch(null, {
      action: 'start',
      outcome: 'learning',
      grounding: 'none',
      request: 'Reject an unknown root key.',
      unexpected: true,
    }, { sessionId: 'session-unknown-root', signal })).rejects.toThrow('unknown field')

    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Reject an unknown Source key.',
    }, { sessionId: 'session-unknown-source', signal })
    await expect(engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Unknown Source field.',
      artifact: 'Unknown field claim [@UNKNOWN1].',
      sources: [{
        sourceId: 'UNKNOWN1',
        url: 'https://example.test/unknown',
        title: 'Unknown source',
        locator: 'Section 1',
        excerpt: 'unknown field excerpt',
        role: 'primary',
        unexpected: true,
      }],
      claims: [{
        claimId: 'UNKNOWN-C1',
        text: 'Unknown field claim.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['UNKNOWN1'],
      }],
    }, { sessionId: 'session-unknown-source', signal })).rejects.toThrow('unknown field')
  })

  it('lets a refused Source be repaired under its own ID, and never a confirmed one', async () => {
    // The verifier refuses the first excerpt and accepts the repaired one, which
    // is the loop the mismatch guidance actually asks the agent to run.
    const seen: string[] = []
    const verifier: SourceVerifier = {
      verify: async (sources: readonly SourceCheckRequest[]) => sources.map((source) => {
        seen.push(source.excerpt)
        return source.excerpt === 'the passage as it truly reads'
          ? { sourceId: source.sourceId, status: 'reachable' as const, checkedAt: now(), statusCode: 200, resolvedUrl: source.url }
          : {
              sourceId: source.sourceId,
              status: 'failed' as const,
              checkedAt: now(),
              statusCode: 200,
              resolvedUrl: source.url,
              detail: 'recorded excerpt diverges from the retrieved source',
            }
      }),
    }
    const engine = createRavenEngine({ now, sourceVerifier: verifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Repair a mistyped excerpt.',
    }, { sessionId: 'session-repair', signal })
    const source = (excerpt: string) => ({
      sourceId: 'REPAIR1',
      url: 'https://example.test/repair',
      title: 'Repairable source',
      locator: 'Section 2',
      excerpt,
      role: 'primary' as const,
    })
    const claims = [{
      claimId: 'REPAIR-C1',
      text: 'The passage says what the excerpt claims.',
      kind: 'external' as const,
      importance: 'material' as const,
      disposition: 'supported' as const,
      sourceIds: ['REPAIR1'],
    }]
    const refused = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'verify',
      summary: 'Mistyped excerpt.',
      artifact: 'The passage says what the excerpt claims [@REPAIR1].',
      sources: [source('the passge as it truly reads')],
      claims,
    }, { sessionId: 'session-repair', signal })
    expect(refused.status).toBe('needs-revision')
    // A2 keeps the refused Source in state; without the repair exemption that
    // retention is what makes the URL permanently uncitable.
    expect(refused.state.sources.map(entry => entry.sourceId)).toStrictEqual(['REPAIR1'])
    expect(refused.state.sources[0]?.check.status).toBe('failed')

    const repaired = await engine.dispatch(refused.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'verify',
      summary: 'Repaired excerpt.',
      artifact: 'The passage says what the excerpt claims [@REPAIR1].',
      sources: [source('the passage as it truly reads')],
      claims,
    }, { sessionId: 'session-repair', signal })
    expect(repaired.status).toBe('active')
    expect(repaired.state.sources[0]?.excerpt).toBe('the passage as it truly reads')
    expect(repaired.state.sources[0]?.check.status).toBe('reachable')
    expect(seen).toContain('the passge as it truly reads')

    // The same rewrite against a CONFIRMED Source is substitution, not repair.
    await expect(engine.dispatch(repaired.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'verify',
      summary: 'Swap confirmed evidence.',
      artifact: 'The passage says what the excerpt claims [@REPAIR1].',
      sources: [source('something else entirely')],
      claims,
    }, { sessionId: 'session-repair', signal })).rejects.toThrow('cannot be rewritten while its check is reachable')
  })

  it('starts and reads one Raven Task through the task engine seam', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })

    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Compare two event stores using primary sources.',
    }, { sessionId: 'session-1', signal })

    expect(started.status).toBe('active')
    expect(started.state.outcome).toBe('research')
    expect(started.state.grounding).toBe('required')
    expect(started.state.revision).toBe(1)
    expect(started.state.taskId).toMatch(/^rvn-[a-f0-9]{12}-1$/)

    const inspected = await engine.dispatch(started.state, {
      action: 'status',
      taskId: started.state.taskId,
    }, { sessionId: 'session-1', signal })

    expect(inspected.status).toBe('active')
    expect(inspected.state).toBe(started.state)
  })

  it('publishes a grounded Checkpoint with mechanically rendered citations', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Explain the durability guarantee.',
    }, { sessionId: 'session-2', signal })

    const checkpoint = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'analyze',
      summary: 'An early finding while broader comparison continues.',
      artifact: 'The store acknowledges only durable appends [@S1].',
      sources: [{
        sourceId: 'S1',
        url: 'https://example.test/store',
        title: 'Primary store documentation',
        locator: 'Durability > Commits',
        excerpt: 'append resolves after the record is durable',
        role: 'primary',
        sourceFamily: 'store-docs',
      }],
      claims: [{
        claimId: 'C1',
        text: 'The store acknowledges only durable appends.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['S1'],
      }],
    }, { sessionId: 'session-2', signal })

    expect(checkpoint.status).toBe('active')
    expect(checkpoint.state.revision).toBe(2)
    expect(checkpoint.state.checkpoints).toHaveLength(1)
    expect(checkpoint.state.sources).toHaveLength(1)
    expect(checkpoint.state.claims).toHaveLength(1)
    expect(checkpoint.renderedArtifact).toContain('[Primary store documentation](https://example.test/store)')
    expect(checkpoint.renderedArtifact).toContain('## Sources')
    expect(checkpoint.renderedArtifact).toContain('## Claim trace')
    expect(checkpoint.renderedArtifact).toContain('**C1**')
  })

  it('lets an existing external Claim move from context to material without changing kind or text', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start', outcome: 'research', request: 'Reassess Claim importance as evidence develops.',
    }, { sessionId: 'session-importance', signal })
    const source = {
      sourceId: 'IMPORTANCE1',
      url: 'https://example.test/importance',
      title: 'Importance source',
      locator: 'Section 1',
      excerpt: 'the same proposition becomes material later',
      role: 'primary',
    }
    const contextual = await engine.dispatch(started.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'read', summary: 'Context recorded.',
      artifact: 'A contextual observation.',
      sources: [source],
      claims: [{
        claimId: 'IMPORTANCE-C1', text: 'The proposition becomes material later.', kind: 'external',
        importance: 'context', disposition: 'supported', sourceIds: ['IMPORTANCE1'],
      }],
    }, { sessionId: 'session-importance', signal })
    const material = await engine.dispatch(contextual.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'analyze', summary: 'Importance reassessed.',
      artifact: 'The proposition becomes material later [@IMPORTANCE1].',
      claims: [{
        claimId: 'IMPORTANCE-C1', text: 'The proposition becomes material later.', kind: 'external',
        importance: 'material', disposition: 'supported', sourceIds: ['IMPORTANCE1'],
      }],
    }, { sessionId: 'session-importance', signal })

    expect(material.status).toBe('active')
    expect(material.state.claims[0]).toMatchObject({
      claimId: 'IMPORTANCE-C1', kind: 'external', importance: 'material',
    })
  })

  it('applies a Steering Revision to the same Task without discarding Checkpoints', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      request: 'Draft an announcement.',
    }, { sessionId: 'session-3', signal })
    const firstDraft = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'First useful draft.',
      artifact: 'The first draft for engineering managers.',
    }, { sessionId: 'session-3', signal })

    const steered = await engine.dispatch(firstDraft.state, {
      action: 'steer',
      taskId: started.state.taskId,
      correction: 'Keep the Task, but make the tone direct and add a rollout date placeholder.',
    }, { sessionId: 'session-3', signal })

    expect(steered.state.taskId).toBe(started.state.taskId)
    expect(steered.state.revision).toBe(3)
    expect(steered.state.steeringRevision).toBe(1)
    expect(steered.state.steering).toEqual([{
      revision: 1,
      correction: 'Keep the Task, but make the tone direct and add a rollout date placeholder.',
      createdAt: now(),
    }])
    expect(steered.state.checkpoints).toEqual(firstDraft.state.checkpoints)
  })

  it('completes against the exact final Artifact after reopening its Sources', async () => {
    const verifier: SourceVerifier = {
      verify: vi.fn(async (sources: readonly SourceCheckRequest[]) => sources.map(source => ({
        sourceId: source.sourceId,
        status: 'reachable' as const,
        checkedAt: now(),
        statusCode: 200,
        resolvedUrl: source.url,
      }))),
    }
    const engine = createRavenEngine({ now, sourceVerifier: verifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'academic-writing',
      request: 'Draft a source-grounded literature paragraph.',
    }, { sessionId: 'session-4', signal })
    const draft = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A citable draft paragraph.',
      artifact: 'The literature reports a durable append guarantee [@P1].',
      sources: [{
        sourceId: 'P1',
        url: 'https://example.test/paper',
        title: 'Paper One',
        locator: 'p. 4',
        excerpt: 'append resolves after the record is durable',
        role: 'primary',
      }],
      claims: [{
        claimId: 'AC1',
        text: 'The literature reports a durable append guarantee.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['P1'],
      }],
    }, { sessionId: 'session-4', signal })

    const completed = await engine.dispatch(draft.state, {
      action: 'complete',
      taskId: started.state.taskId,
      artifact: 'The literature reports a durable append guarantee [@P1].',
    }, { sessionId: 'session-4', signal })

    expect(verifier.verify).toHaveBeenCalledTimes(2)
    expect(completed.status).toBe('completed')
    expect(completed.state.phase).toBe('completed')
    expect(completed.state.verification).toMatchObject({
      mode: 'remote',
      checked: 1,
      reachable: 1,
      failed: 0,
      unavailable: 0,
    })
    expect(completed.state.finalArtifactSha256).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(completed.renderedArtifact).toContain('[Paper One](https://example.test/paper)')
  })

  it('states the exact verification boundary when an Artifact contains an undeclared assertion', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start', outcome: 'research', request: 'Verify the declared fact without overstating runtime scope.',
    }, { sessionId: 'verification-scope', signal })
    const artifact = 'Grounded fact [@S1]. Unsupported invented fact with no Claim.'
    const checkpoint = await engine.dispatch(started.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'verify', summary: 'One declared Claim.', artifact,
      sources: [{
        sourceId: 'S1', url: 'https://example.test/declared', title: 'Declared source',
        locator: 'Finding', excerpt: 'append resolves after the record is durable', role: 'primary',
      }],
      claims: [{
        claimId: 'C1', text: 'Grounded fact.', kind: 'external', importance: 'material',
        disposition: 'supported', sourceIds: ['S1'],
      }],
    }, { sessionId: 'verification-scope', signal })
    const status = await engine.dispatch(checkpoint.state, {
      action: 'status', taskId: started.state.taskId,
    }, { sessionId: 'verification-scope', signal })
    const completed = await engine.dispatch(checkpoint.state, {
      action: 'complete', taskId: started.state.taskId, artifact,
    }, { sessionId: 'verification-scope', signal })

    expect(checkpoint.verificationScope).toEqual({
      artifactFingerprint: 'verified',
      registeredArtifactReferences: 'checked',
      undeclaredAssertions: 'not-assessed',
      semanticEntailment: 'not-assessed',
    })
    expect(status.verificationScope).toEqual(checkpoint.verificationScope)
    expect(completed.status).toBe('completed')
    expect(completed.verificationScope).toEqual(checkpoint.verificationScope)
    expect(completed.message).toContain('did not assess undeclared assertions or semantic entailment')
    expect(completed.message).not.toContain('Completed Raven Task with a verified Artifact')
    expect(completed.state.checkpoints.at(-1)?.summary).toBe('Verified registered Claim references and final Artifact bytes.')
    expect(completed.renderedArtifact).toContain('Unsupported invented fact with no Claim.')
    expect(completed.renderedArtifact?.match(/\*\*C1\*\*/g)).toHaveLength(1)
  })

  it('preserves independent work and completes with explicit limits after a partial source failure', async () => {
    const verifier: SourceVerifier = {
      verify: async (sources) => sources.map(source => source.sourceId === 'B1'
        ? {
            sourceId: source.sourceId,
            status: 'failed' as const,
            checkedAt: now(),
            statusCode: 503,
            resolvedUrl: source.url,
            detail: 'HTTP 503',
          }
        : {
            sourceId: source.sourceId,
            status: 'reachable' as const,
            checkedAt: now(),
            statusCode: 200,
            resolvedUrl: source.url,
          }),
    }
    const engine = createRavenEngine({ now, sourceVerifier: verifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Compare two vendors even if one source is unavailable.',
    }, { sessionId: 'session-5', signal })
    const failedAttempt = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'analyze',
      summary: 'An attempted comparison before the source failure was isolated.',
      artifact: 'Vendor A documents durable acknowledgement [@A1]. Vendor B claims equivalent semantics [@B1].',
      sources: [
        {
          sourceId: 'A1',
          url: 'https://example.test/vendor-a',
          title: 'Vendor A documentation',
          locator: 'Durability',
          excerpt: 'durable before acknowledgement',
          role: 'primary',
        },
        {
          sourceId: 'B1',
          url: 'https://example.test/vendor-b',
          title: 'Vendor B documentation',
          locator: 'Unavailable page',
          excerpt: 'previously retained excerpt',
          role: 'primary',
        },
      ],
      claims: [
        {
          claimId: 'A-C1',
          text: 'Vendor A documents durable acknowledgement.',
          kind: 'external',
          importance: 'material',
          disposition: 'supported',
          sourceIds: ['A1'],
        },
        {
          claimId: 'B-C1',
          text: 'Vendor B has equivalent semantics.',
          kind: 'external',
          importance: 'material',
          disposition: 'supported',
          sourceIds: ['B1'],
        },
      ],
    }, { sessionId: 'session-5', signal })
    expect(failedAttempt.status).toBe('needs-revision')
    // A2: the refused Checkpoint retains the whole submitted contribution. It used
    // to return the PRIOR state, so one unfetchable Source discarded every Source,
    // Claim, Limitation, and Artifact byte in the call.
    expect(failedAttempt.state).not.toBe(started.state)
    expect(failedAttempt.state.revision).toBe(started.state.revision + 1)
    expect(failedAttempt.state.sources.map(source => source.sourceId)).toEqual(['A1', 'B1'])
    expect(failedAttempt.state.claims.map(claim => claim.claimId)).toEqual(['A-C1', 'B-C1'])
    // The Artifact is withheld: an unpublished Artifact has no Checkpoint to hash against.
    expect(failedAttempt.state.checkpoints).toHaveLength(0)
    expect(failedAttempt.state.latestArtifact).toBeNull()
    expect(failedAttempt.issues.join(' ')).toContain('B1')

    const partial = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'analyze',
      summary: 'Useful findings from the accessible vendor while preserving the gap.',
      artifact: 'Vendor A documents durable acknowledgement [@A1]. Vendor B remains unresolved.',
      sources: [
        {
          sourceId: 'A1',
          url: 'https://example.test/vendor-a',
          title: 'Vendor A documentation',
          locator: 'Durability',
          excerpt: 'durable before acknowledgement',
          role: 'primary',
        },
        {
          sourceId: 'B1',
          url: 'https://example.test/vendor-b',
          title: 'Vendor B documentation',
          locator: 'Unavailable page',
          excerpt: 'previously retained excerpt',
          role: 'primary',
        },
      ],
      claims: [
        {
          claimId: 'A-C1',
          text: 'Vendor A documents durable acknowledgement.',
          kind: 'external',
          importance: 'material',
          disposition: 'supported',
          sourceIds: ['A1'],
        },
        {
          claimId: 'B-C1',
          text: 'Vendor B has equivalent semantics.',
          kind: 'external',
          importance: 'material',
          disposition: 'deferred',
          sourceIds: ['B1'],
        },
      ],
      failures: [{
        kind: 'source',
        sourceId: 'B1',
        detail: 'Vendor B returned HTTP 503 after the bounded fallback.',
      }],
    }, { sessionId: 'session-5', signal })

    const completed = await engine.dispatch(partial.state, {
      action: 'complete',
      taskId: started.state.taskId,
      artifact: 'Vendor A documents durable acknowledgement [@A1]. Vendor B remains unresolved.',
    }, { sessionId: 'session-5', signal })

    expect(completed.status).toBe('completed-with-limits')
    expect(completed.state.phase).toBe('completed-with-limits')
    expect(completed.state.limitations).toHaveLength(1)
    expect(completed.verificationScope).toMatchObject({
      registeredArtifactReferences: 'checked',
      undeclaredAssertions: 'not-assessed',
      semanticEntailment: 'not-assessed',
    })
    expect(completed.state.verification).toMatchObject({ checked: 1, reachable: 1, unavailable: 0 })
    expect(completed.state.claims.find(claim => claim.claimId === 'A-C1')?.disposition).toBe('supported')
    expect(completed.state.claims.find(claim => claim.claimId === 'B-C1')?.disposition).toBe('deferred')
    expect(completed.renderedArtifact).toContain('Vendor A documentation')
  })

  it('does not label zero valid grounded work completed-with-limits', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Research a topic despite an unavailable corpus.',
    }, { sessionId: 'session-zero-grounding', signal })
    const empty = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'No valid evidence was retrieved.',
      artifact: 'No externally grounded finding is available.',
      failures: [{ kind: 'coverage', detail: 'The entire source corpus was unavailable.' }],
    }, { sessionId: 'session-zero-grounding', signal })
    const rejected = await engine.dispatch(empty.state, {
      action: 'complete',
      taskId: started.state.taskId,
      artifact: empty.state.latestArtifact,
    }, { sessionId: 'session-zero-grounding', signal })

    expect(rejected.status).toBe('needs-revision')
    expect(rejected.state).toBe(empty.state)
    expect(rejected.issues.join(' ')).toContain('at least one verified material external Claim')
  })

  it('automatically defers Claims whose only Source fails re-verification', async () => {
    let calls = 0
    const verifier: SourceVerifier = {
      verify: async sources => sources.map(source => ++calls === 1
        ? {
            sourceId: source.sourceId,
            status: 'reachable' as const,
            checkedAt: now(),
            statusCode: 200,
            resolvedUrl: source.url,
          }
        : {
            sourceId: source.sourceId,
            status: 'failed' as const,
            checkedAt: now(),
            statusCode: 503,
            resolvedUrl: source.url,
            detail: 'HTTP 503 during final verification',
          }),
    }
    const engine = createRavenEngine({ now, sourceVerifier: verifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Track a Source that later becomes unavailable.',
    }, { sessionId: 'session-propagation', signal })
    const checkpoint = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Initially verified finding.',
      artifact: 'The Source initially supports this finding [@VOLATILE].',
      sources: [{
        sourceId: 'VOLATILE',
        url: 'https://example.test/volatile',
        title: 'Volatile source',
        locator: 'Section 1',
        excerpt: 'initially available excerpt',
        role: 'primary',
      }],
      claims: [{
        claimId: 'VOLATILE-C1',
        text: 'The Source initially supports this finding.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['VOLATILE'],
      }],
    }, { sessionId: 'session-propagation', signal })
    const rejected = await engine.dispatch(checkpoint.state, {
      action: 'complete',
      taskId: started.state.taskId,
      artifact: checkpoint.state.latestArtifact,
    }, { sessionId: 'session-propagation', signal })

    expect(rejected.status).toBe('needs-revision')
    expect(rejected.state.sources[0]?.check.status).toBe('failed')
    expect(rejected.state.claims[0]?.disposition).toBe('deferred')
    expect(rejected.state.limitations.some(item => item.sourceId === 'VOLATILE')).toBe(true)
  })

  it('does not publish a grounded Checkpoint when the recorded excerpt cannot be verified', async () => {
    const verifier: SourceVerifier = {
      verify: async sources => sources.map(source => ({
        sourceId: source.sourceId,
        status: 'failed',
        checkedAt: now(),
        statusCode: 200,
        resolvedUrl: source.url,
        detail: 'recorded excerpt was not found in the retrieved source',
      })),
    }
    const engine = createRavenEngine({ now, sourceVerifier: verifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Ground one claim in retrieved evidence.',
    }, { sessionId: 'session-unmatched', signal })

    const rejected = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A candidate grounded claim.',
      artifact: 'A candidate external claim [@BAD1].',
      sources: [{
        sourceId: 'BAD1',
        url: 'https://example.test/source',
        title: 'Retrieved source',
        locator: 'Section 1',
        excerpt: 'fabricated wording that is absent',
        role: 'primary',
      }],
      claims: [{
        claimId: 'BAD-C1',
        text: 'A candidate external claim.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['BAD1'],
      }],
    }, { sessionId: 'session-unmatched', signal })

    expect(rejected.status).toBe('needs-revision')
    // A2: independently submitted evidence survives the refusal; only the
    // Checkpoint is withheld.
    expect(rejected.state.sources.map(source => source.sourceId)).toEqual(['BAD1'])
    expect(rejected.state.claims.map(claim => claim.claimId)).toEqual(['BAD-C1'])
    expect(rejected.state.checkpoints).toHaveLength(0)
    expect(rejected.issues.join(' ')).toContain('BAD1')
    expect(rejected.issues.join(' ')).toContain('excerpt')
  })

  it.each([
    ['duplicate IDs', [
      { sourceId: 'PROTO1', status: 'reachable', checkedAt: now(), statusCode: 200, resolvedUrl: 'https://example.test/protocol' },
      { sourceId: 'PROTO1', status: 'reachable', checkedAt: now(), statusCode: 200, resolvedUrl: 'https://example.test/protocol' },
    ]],
    ['unknown ID', [{ sourceId: 'OTHER', status: 'reachable', checkedAt: now(), statusCode: 200 }]],
    ['missing ID', []],
    ['cross-host redirect', [{
      sourceId: 'PROTO1',
      status: 'reachable',
      checkedAt: now(),
      statusCode: 200,
      resolvedUrl: 'https://other.test/protocol',
    }]],
    ['malformed status', [{ sourceId: 'PROTO1', status: 'invented', checkedAt: now() }]],
  ])('conservatively rejects a SourceVerifier protocol violation: %s', async (_label, response) => {
    const verifier: SourceVerifier = { verify: async () => response as never }
    const engine = createRavenEngine({ now, sourceVerifier: verifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Verify one adapter response.',
    }, { sessionId: `session-protocol-${_label}`, signal })
    const rejected = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A candidate adapter response.',
      artifact: 'Protocol-bound claim [@PROTO1].',
      sources: [{
        sourceId: 'PROTO1',
        url: 'https://example.test/protocol',
        title: 'Protocol source',
        locator: 'Section 1',
        excerpt: 'protocol excerpt',
        role: 'primary',
      }],
      claims: [{
        claimId: 'PROTO-C1',
        text: 'Protocol-bound claim.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['PROTO1'],
      }],
    }, { sessionId: `session-protocol-${_label}`, signal })

    expect(rejected.status).toBe('needs-revision')
    // The protocol violation still blocks publication, but it no longer costs the
    // submitted evidence: the Source is retained carrying its unavailable check.
    expect(rejected.state.checkpoints).toHaveLength(0)
    expect(rejected.state.sources).toHaveLength(1)
    expect(rejected.state.sources[0]?.check.status).toBe('unavailable')
    expect(rejected.issues.join(' ')).toContain('protocol')
  })

  it('cancels a never-settling SourceVerifier at the engine seam', { timeout: 2_000 }, async () => {
    const verifier: SourceVerifier = {
      verify: () => new Promise<never>(() => undefined),
    }
    const engine = createRavenEngine({ now, sourceVerifier: verifier })
    const controller = new AbortController()
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Cancel a stuck verifier.',
    }, { sessionId: 'session-engine-cancel', signal: controller.signal })
    const pending = engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A stuck verifier candidate.',
      artifact: 'Stuck verifier claim [@STUCK].',
      sources: [{
        sourceId: 'STUCK',
        url: 'https://example.test/stuck',
        title: 'Stuck source',
        locator: 'Section 1',
        excerpt: 'stuck excerpt',
        role: 'primary',
      }],
      claims: [{
        claimId: 'STUCK-C1',
        text: 'Stuck verifier claim.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['STUCK'],
      }],
    }, { sessionId: 'session-engine-cancel', signal: controller.signal })
    controller.abort(new Error('cancelled engine verifier'))

    await expect(pending).rejects.toThrow('cancelled engine verifier')
  })

  it('requires the exact final Artifact to be the latest post-steer Checkpoint bytes', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Draft one paragraph.',
    }, { sessionId: 'session-exact-final', signal })
    const draft = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'The candidate final paragraph.',
      artifact: 'The checkpointed final paragraph.',
    }, { sessionId: 'session-exact-final', signal })

    const rejected = await engine.dispatch(draft.state, {
      action: 'complete',
      taskId: started.state.taskId,
      artifact: 'A different, uncheckpointed final paragraph.',
    }, { sessionId: 'session-exact-final', signal })

    expect(rejected.status).toBe('needs-revision')
    expect(rejected.state).toBe(draft.state)
    expect(rejected.issues.join(' ')).toContain('exact latest Checkpoint')
  })

  it('preserves source disagreement instead of silently resolving it', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Report a genuine disagreement between two records.',
    }, { sessionId: 'session-contested', signal })

    const source = (sourceId: string, suffix: string) => ({
      sourceId,
      url: `https://${suffix}.test/record`,
      title: `Record ${sourceId}`,
      locator: 'Body',
      excerpt: `figure recorded by ${sourceId}`,
      role: 'primary',
      sourceFamily: `family-${sourceId}`,
    })

    const published = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'analyze',
      summary: 'Two authorities disagree.',
      artifact: 'The registry reports 120 units [@D1]. The ministry reports 95 units [@D2].',
      sources: [source('D1', 'registry'), source('D2', 'ministry')],
      claims: [
        {
          claimId: 'DIS-C1',
          text: 'The registry reports 120 units.',
          kind: 'external',
          importance: 'material',
          disposition: 'qualified',
          sourceIds: ['D1'],
          contradicts: ['DIS-C2'],
        },
        {
          claimId: 'DIS-C2',
          text: 'The ministry reports 95 units.',
          kind: 'external',
          importance: 'material',
          disposition: 'qualified',
          sourceIds: ['D2'],
          contradicts: ['DIS-C1'],
        },
      ],
    }, { sessionId: 'session-contested', signal })

    expect(published.status).toBe('active')
    expect(published.renderedArtifact).toContain('contested')
    expect(published.renderedArtifact).toContain('DIS-C2')
    expect(published.state.claims[0]?.contradicts).toEqual(['DIS-C2'])
  })

  it('rejects a contradiction that names an unknown or self-referential Claim', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Reject dangling contradiction links.',
    }, { sessionId: 'session-contested-bad', signal })

    const attempt = (contradicts: string[]) => engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Dangling contradiction.',
      artifact: 'An analysis Claim.',
      claims: [{
        claimId: 'BAD-C1',
        text: 'An analysis Claim.',
        kind: 'analysis',
        importance: 'context',
        disposition: 'supported',
        sourceIds: [],
        contradicts,
      }],
    }, { sessionId: 'session-contested-bad', signal })

    await expect(attempt(['NOT-A-CLAIM'])).rejects.toThrow('unknown Claim')
    await expect(attempt(['BAD-C1'])).rejects.toThrow('itself')
  })

  it('refuses to disable the evidence floor on evidence-defined Outcomes', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    for (const outcome of ['research', 'academic-writing']) {
      await expect(engine.dispatch(null, {
        action: 'start',
        outcome,
        grounding: 'none',
        request: 'Silently drop the evidence floor.',
      }, { sessionId: `session-floor-${outcome}`, signal })).rejects.toThrow('cannot disable its evidence floor')
    }

    // `optional` stays available: such a Task may be mostly analysis with some external Claims.
    const optional = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      grounding: 'optional',
      request: 'Mostly analysis with some external Claims.',
    }, { sessionId: 'session-floor-optional', signal })
    expect(optional.state.grounding).toBe('optional')

    // Outcomes that are not defined by external evidence keep the full range.
    const ungrounded = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Draft a personal note.',
    }, { sessionId: 'session-floor-writing', signal })
    expect(ungrounded.state.grounding).toBe('none')
  })

  it('preserves version identity of mutable scholarly Source URLs', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'academic-writing',
      request: 'Cite an exact preprint version.',
    }, { sessionId: 'session-version', signal })
    const published = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Versioned preprint citation.',
      artifact: 'The preprint reports the result [@ARXIV1].',
      sources: [{
        sourceId: 'ARXIV1',
        url: 'https://arxiv.org/abs/2401.12345v2',
        title: 'Preprint, version 2',
        locator: 'Abstract',
        excerpt: 'we report the result',
        role: 'primary',
      }],
      claims: [{
        claimId: 'ARXIV-C1',
        text: 'The preprint reports the result.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['ARXIV1'],
      }],
    }, { sessionId: 'session-version', signal })

    expect(published.status).toBe('active')
    expect(published.state.sources[0]?.url).toBe('https://arxiv.org/abs/2401.12345v2')
    expect(published.renderedArtifact).toContain('2401.12345v2')
  })

  it('marks a Claim whose Sources share one family as non-independent in the Claim trace', () => {
    const reachable = {
      status: 'reachable' as const,
      checkedAt: now(),
      statusCode: 200,
    }
    const wire = (sourceId: string, suffix: string, sourceFamily?: string) => ({
      sourceId,
      url: `https://outlet-${suffix}.test/story`,
      resource: { origin: 'web' as const, uri: `https://outlet-${suffix}.test/story` },
      representation: { format: 'markdown' as const, derivation: 'converted' as const, coverage: 'unknown' as const, producedBy: 'web_fetch' },
      title: `Outlet ${suffix}`,
      locator: 'Body',
      excerpt: 'the agency reported the figure',
      role: 'secondary' as const,
      inspectedAt: now(),
      check: { ...reachable, resolvedUrl: `https://outlet-${suffix}.test/story` },
      ...(sourceFamily === undefined ? {} : { sourceFamily }),
    })
    const claim = (claimId: string, sourceIds: string[]) => ({
      claimId,
      text: 'The figure is confirmed.',
      kind: 'external' as const,
      importance: 'material' as const,
      disposition: 'supported' as const,
      sourceIds,
    })

    // Three outlets republishing one originating record are one epistemic family.
    const republished = renderArtifact(
      'The figure is confirmed [@W1][@W2][@W3].',
      [wire('W1', 'a', 'wire-2026-07-02'), wire('W2', 'b', 'wire-2026-07-02'), wire('W3', 'c', 'wire-2026-07-02')],
      [claim('WIRE-C1', ['W1', 'W2', 'W3'])],
    )
    expect(republished).toContain('single Source family')
    expect(republished).toContain('not independent corroboration')

    // Undeclared families cannot be assumed independent.
    const undeclared = renderArtifact(
      'The figure is confirmed [@U1][@U2].',
      [wire('U1', 'd'), wire('U2', 'e')],
      [claim('UNDECLARED-C1', ['U1', 'U2'])],
    )
    expect(undeclared).toContain('independence unverified')

    // Genuinely distinct families carry no warning.
    const independent = renderArtifact(
      'The figure is confirmed [@I1][@I2].',
      [wire('I1', 'f', 'registry-filing'), wire('I2', 'g', 'field-survey')],
      [claim('INDEPENDENT-C1', ['I1', 'I2'])],
    )
    expect(independent).not.toContain('single Source family')
    expect(independent).not.toContain('independence unverified')
  })

  it('escapes Source and Claim trace Markdown supplied by evidence records', () => {
    const rendered = renderArtifact('Claim [@ESC1].', [{
      sourceId: 'ESC1',
      url: 'https://example.test/escape',
      resource: { origin: 'web', uri: 'https://example.test/escape' },
      representation: { format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'web_fetch' },
      title: '<img src=x> [unsafe]',
      locator: '> injected blockquote',
      excerpt: 'safe excerpt',
      role: 'primary',
      inspectedAt: now(),
      check: {
        status: 'reachable',
        checkedAt: now(),
        statusCode: 200,
        resolvedUrl: 'https://example.test/escape',
      },
    }], [{
      claimId: 'ESC-C1',
      text: '<script>alert(1)</script> *bold*',
      kind: 'external',
      importance: 'material',
      disposition: 'supported',
      sourceIds: ['ESC1'],
    }])

    expect(rendered).not.toContain('<script>')
    expect(rendered).not.toContain('<img')
    expect(rendered).toContain('&lt;script&gt;')
    expect(rendered).toContain('\\*bold\\*')
    expect(rendered).toContain('&gt; injected blockquote')
  })

  it('does not silently rewrite a stable Source ID or its evidence anchor', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Preserve Source identity.',
    }, { sessionId: 'session-source-identity', signal })
    const first = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Original evidence anchor.',
      artifact: 'Stable identity claim [@STABLE1].',
      sources: [{
        sourceId: 'STABLE1',
        url: 'https://example.test/stable',
        title: 'Stable source',
        locator: 'Section 1',
        excerpt: 'original exact excerpt',
        role: 'primary',
      }],
      claims: [{
        claimId: 'STABLE-C1',
        text: 'Stable identity claim.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['STABLE1'],
      }],
    }, { sessionId: 'session-source-identity', signal })

    await expect(engine.dispatch(first.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'refine',
      summary: 'Attempted silent evidence rewrite.',
      artifact: 'Stable identity claim [@STABLE1].',
      sources: [{
        sourceId: 'STABLE1',
        url: 'https://example.test/stable',
        title: 'Stable source',
        locator: 'Section 1',
        excerpt: 'different replacement excerpt',
        role: 'primary',
      }],
    }, { sessionId: 'session-source-identity', signal })).rejects.toThrow('cannot be rewritten')
  })

  it('enforces bounded persistent Artifact state', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Bound one Artifact.',
    }, { sessionId: 'session-bounds', signal })

    await expect(engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'Oversized Artifact.',
      artifact: 'x'.repeat(RAVEN_LIMITS.artifactChars + 1),
    }, { sessionId: 'session-bounds', signal })).rejects.toThrow(`artifact must be at most ${RAVEN_LIMITS.artifactChars} characters`)
  })

  it('stops and resumes the same Task without losing its Artifact', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'learning',
      request: 'Teach event sourcing with a worked example.',
    }, { sessionId: 'session-6', signal })
    const guide = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A usable first lesson.',
      artifact: 'Event sourcing stores state changes as an ordered event history.',
    }, { sessionId: 'session-6', signal })

    const stopped = await engine.dispatch(guide.state, {
      action: 'stop',
      taskId: started.state.taskId,
      reason: 'The user asked to stop for now.',
    }, { sessionId: 'session-6', signal })
    expect(stopped.status).toBe('stopped')
    expect(stopped.state.phase).toBe('stopped')
    expect(stopped.state.latestArtifact).toBe(guide.state.latestArtifact)

    const idempotent = await engine.dispatch(stopped.state, {
      action: 'stop',
      taskId: started.state.taskId,
    }, { sessionId: 'session-6', signal })
    expect(idempotent.state).toBe(stopped.state)

    const resumed = await engine.dispatch(stopped.state, {
      action: 'resume',
      taskId: started.state.taskId,
    }, { sessionId: 'session-6', signal })
    expect(resumed.status).toBe('active')
    expect(resumed.state.taskId).toBe(started.state.taskId)
    expect(resumed.state.phase).toBe('active')
    expect(resumed.state.checkpoints).toEqual(guide.state.checkpoints)
  })

  // ---- Cap boundaries (A16) and the fixes that made them survivable ----

  async function taskAtCheckpointCap(sessionId: string, count: number) {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Fill the Checkpoint list.',
    }, { sessionId, signal })
    let state = started.state
    for (let index = 0; index < count; index += 1) {
      const result = await engine.dispatch(state, {
        action: 'checkpoint',
        taskId: state.taskId,
        stage: 'draft',
        summary: `Checkpoint ${index + 1}.`,
        artifact: `Revision number ${index + 1} of the paragraph.`,
      }, { sessionId, signal })
      expect(result.status).toBe('active')
      state = result.state
    }
    return { engine, state }
  }

  it('mints Checkpoint ids that two concurrent writers cannot collide on', async () => {
    const { state } = await taskAtCheckpointCap('session-cp-id', 2)
    // A4: a per-Task-ordinal id gave two Agent Team members racing from the same
    // loaded state the identical id. The revision is monotonic per accepted write.
    expect(state.checkpoints.map(item => item.checkpointId))
      .toEqual([`${state.taskId}-cp-r2`, `${state.taskId}-cp-r3`])
    expect(new Set(state.checkpoints.map(item => item.checkpointId)).size).toBe(2)
  })

  it('stays inside the Checkpoint cap and still completes instead of deadlocking', async () => {
    // A3: checkpoint used to throw at the cap and complete used to refuse for want
    // of a slot, so a Task that reached 128 Checkpoints could never finish.
    const { engine, state } = await taskAtCheckpointCap('session-cp-cap', RAVEN_LIMITS.checkpoints)
    expect(state.checkpoints).toHaveLength(RAVEN_LIMITS.checkpoints - 1)

    const overCap = await engine.dispatch(state, {
      action: 'checkpoint',
      taskId: state.taskId,
      stage: 'refine',
      summary: 'One Checkpoint past the cap.',
      artifact: 'The paragraph past the cap.',
    }, { sessionId: 'session-cp-cap', signal })

    expect(overCap.status).toBe('active')
    expect(overCap.state.checkpoints.length).toBeLessThanOrEqual(RAVEN_LIMITS.checkpoints)
    // The trim is visible, never silent.
    expect(overCap.issues.join(' ')).toContain('trimmed')
    // The first Checkpoint is preserved; the oldest trimmable one is the second.
    expect(overCap.state.checkpoints[0]?.summary).toBe('Checkpoint 1.')
    // Ordinals stay strictly increasing across the trim, as draft rounds already do.
    const ordinals = overCap.state.checkpoints.map(item => item.ordinal)
    expect(ordinals).toEqual([...ordinals].sort((left, right) => left - right))
    expect(new Set(ordinals).size).toBe(ordinals.length)

    const completed = await engine.dispatch(overCap.state, {
      action: 'complete',
      taskId: state.taskId,
      artifact: overCap.state.latestArtifact,
    }, { sessionId: 'session-cp-cap', signal })
    expect(completed.status).toMatch(/^completed/)
    expect(completed.state.checkpoints.length).toBeLessThanOrEqual(RAVEN_LIMITS.checkpoints)
  })

  it('refuses a Task snapshot whose aggregate serialized size exceeds the durable budget', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Keep the durable Task state bounded as a whole.',
    }, { sessionId: 'session-state-bytes', signal })
    const sources = Array.from({ length: 60 }, (_value, index) => ({
      sourceId: `BIG${index}`,
      url: `https://example.test/big-${index}`,
      title: `Large Source ${index}`,
      locator: 'Body',
      excerpt: 'x'.repeat(RAVEN_LIMITS.sourceExcerptChars),
      role: 'secondary',
    }))

    await expect(engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'analyze',
      summary: 'A contribution whose individual fields are legal but aggregate state is not.',
      artifact: 'A bounded Artifact.',
      sources,
    }, { sessionId: 'session-state-bytes', signal })).rejects.toThrow(
      `durable snapshot budget of ${RAVEN_LIMITS.stateBytes - RAVEN_LIMITS.stateCompletionReserveBytes}`,
    )
    expect(started.state.sources).toEqual([])
    expect(started.state.revision).toBe(1)
  })

  it('reserves aggregate state headroom so a large accepted Task can still complete', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Keep enough snapshot headroom for Completion.',
    }, { sessionId: 'session-state-reserve', signal })
    const checkpoint = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A large but admissible Task.',
      artifact: 'A final paragraph.',
      sources: Array.from({ length: 43 }, (_value, index) => ({
        sourceId: `RESERVE${index}`,
        url: `https://example.test/reserve-${index}`,
        title: `Reserve Source ${index}`,
        locator: 'Body',
        excerpt: 'x'.repeat(RAVEN_LIMITS.sourceExcerptChars),
        role: 'secondary',
      })),
    }, { sessionId: 'session-state-reserve', signal })

    const completed = await engine.dispatch(checkpoint.state, {
      action: 'complete',
      taskId: checkpoint.state.taskId,
      artifact: checkpoint.state.latestArtifact,
    }, { sessionId: 'session-state-reserve', signal })
    expect(completed.status).toMatch(/^completed/)
  })

  it('accepts Sources and Claims at their caps and refuses only the excess', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Fill the Source and Claim lists.',
    }, { sessionId: 'session-caps', signal })

    const sources = Array.from({ length: RAVEN_LIMITS.sources }, (_value, index) => ({
      sourceId: `S${index}`,
      url: `https://example.test/source-${index}`,
      title: `Source ${index}`,
      locator: 'Section 1',
      excerpt: `excerpt ${index}`,
      role: 'primary',
    }))
    const claims = Array.from({ length: RAVEN_LIMITS.claims }, (_value, index) => ({
      claimId: `C${index}`,
      text: `Claim ${index}.`,
      kind: 'analysis',
      importance: 'context',
      disposition: 'supported',
      sourceIds: [],
    }))

    const atCap = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'analyze',
      summary: 'Exactly at both caps.',
      artifact: 'A paragraph carrying evidence at both caps.',
      sources,
      claims,
    }, { sessionId: 'session-caps', signal })
    expect(atCap.status).toBe('active')
    expect(atCap.state.sources).toHaveLength(RAVEN_LIMITS.sources)
    expect(atCap.state.claims).toHaveLength(RAVEN_LIMITS.claims)

    await expect(engine.dispatch(atCap.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'analyze',
      summary: 'One Source past the cap.',
      artifact: 'A paragraph one Source past the cap.',
      sources: [{
        sourceId: 'OVER',
        url: 'https://example.test/over',
        title: 'One too many',
        locator: 'Section 1',
        excerpt: 'over the cap',
        role: 'primary',
      }],
    }, { sessionId: 'session-caps', signal })).rejects.toThrow('at most 256 Sources')

    await expect(engine.dispatch(atCap.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'analyze',
      summary: 'One Claim past the cap.',
      artifact: 'A paragraph one Claim past the cap.',
      claims: [{
        claimId: 'OVER',
        text: 'One Claim too many.',
        kind: 'analysis',
        importance: 'context',
        disposition: 'supported',
        sourceIds: [],
      }],
    }, { sessionId: 'session-caps', signal })).rejects.toThrow('at most 512 Claims')

    // The refused calls cost the caller nothing: the accepted state is untouched.
    expect(atCap.state.sources).toHaveLength(RAVEN_LIMITS.sources)
    expect(atCap.state.checkpoints).toHaveLength(1)
  })

  it('drops only the Limitations that do not fit and says so', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Fill the Limitation list.',
    }, { sessionId: 'session-limit-cap', signal })

    // Genuinely distinct subjects, not the same sentence with a changing number:
    // the A11 fold deliberately collapses details that differ only in digits.
    const alphabet = 'abcdefghijklmnopqrstuvwxyz'
    const word = (index: number) => `${alphabet[index % 26] ?? 'a'}${alphabet[Math.floor(index / 26) % 26] ?? 'a'}`
      .repeat(4)
    const failures = Array.from({ length: RAVEN_LIMITS.limitations }, (_value, index) => ({
      kind: 'coverage',
      detail: `No record of the ${word(index)} subject was found where one would exist.`,
    }))
    expect(new Set(failures.map(item => item.detail)).size).toBe(RAVEN_LIMITS.limitations)
    const atCap = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'analyze',
      summary: 'Exactly at the Limitation cap.',
      artifact: 'A paragraph recording every coverage gap.',
      failures,
    }, { sessionId: 'session-limit-cap', signal })
    expect(atCap.status).toBe('active')
    expect(atCap.state.limitations).toHaveLength(RAVEN_LIMITS.limitations)

    // A5/A2: over the cap, the Checkpoint still publishes. The dropped Limitation
    // is reported rather than thrown, because throwing here used to discard the
    // Sources, Claims, and Artifact submitted in the same call.
    const overCap = await engine.dispatch(atCap.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'refine',
      summary: 'One Limitation past the cap.',
      artifact: 'A paragraph published despite a full Limitation list.',
      failures: [{ kind: 'tool', detail: 'A wholly unrelated tool failure worth recording.' }],
    }, { sessionId: 'session-limit-cap', signal })
    expect(overCap.status).toBe('active')
    expect(overCap.state.checkpoints).toHaveLength(2)
    expect(overCap.state.limitations).toHaveLength(RAVEN_LIMITS.limitations)
    expect(overCap.issues.join(' ')).toContain('could not be recorded')
  })

  it('folds near-identical Limitation details instead of accumulating them', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Record repeated verifier noise.',
    }, { sessionId: 'session-limit-fold', signal })

    // A11: exact-detail comparison never folded these, so a flaky host filled the
    // Limitation list with one fact reported with different timestamps and codes.
    const published = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'verify',
      summary: 'Repeated verifier noise.',
      artifact: 'A paragraph about a flaky host.',
      failures: [
        { kind: 'tool', detail: 'Fetch failed: HTTP 503 after 1200ms at 2026-08-16T16:00:00Z' },
        { kind: 'tool', detail: 'Fetch failed: HTTP 504 after 1900ms at 2026-08-16T16:05:00Z' },
        { kind: 'tool', detail: 'Fetch failed: HTTP 503 after 3100ms at 2026-08-16T16:10:00Z' },
        { kind: 'coverage', detail: 'A genuinely different failure worth its own record.' },
      ],
    }, { sessionId: 'session-limit-fold', signal })

    expect(published.state.limitations).toHaveLength(2)
    // The retained record keeps the FIRST detail verbatim: this is a dedupe, not
    // a summarization.
    expect(published.state.limitations[0]?.detail).toContain('HTTP 503 after 1200ms')

    // A10: identity is a monotonic counter over everything the Task ever recorded,
    // never the array index. Three tool failures were submitted and two folded away,
    // so a positional id would renumber the coverage Limitation to 'coverage-2' and
    // disagree with the codec the moment a later append interleaves kinds.
    expect(published.state.limitations.map(item => item.limitationId)).toEqual(['tool-1', 'coverage-2'])
    const later = await engine.dispatch(published.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'verify',
      summary: 'A further, unrelated failure.',
      artifact: 'A paragraph about a second unrelated failure.',
      failures: [{ kind: 'tool', detail: 'A completely unrelated subsystem refused the request.' }],
    }, { sessionId: 'session-limit-fold', signal })
    // The new id continues the counter (tool-3); a positional scheme would emit
    // 'tool-3' only by coincidence here, so assert the whole ordering stays stable
    // AND that every id remains unique, which is what the codec actually requires.
    const ids = later.state.limitations.map(item => item.limitationId)
    expect(ids).toEqual(['tool-1', 'coverage-2', 'tool-3'])
    expect(new Set(ids).size).toBe(ids.length)

    // The case where a positional id and the counter actually diverge: submit a
    // batch in which an EARLIER addition folds away, so the array grows by less
    // than the number of additions. A positional scheme numbers from the resulting
    // length and reuses 'tool-3'; the counter keeps going. A reused id is what the
    // codec rejects, taking the whole Task with it on replay.
    const folded = await engine.dispatch(later.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'verify',
      summary: 'A batch whose first entry folds into an existing record.',
      artifact: 'A paragraph about a folded batch.',
      failures: [
        // Folds into tool-1 (digits and punctuation are normalized away).
        { kind: 'tool', detail: 'Fetch failed: HTTP 507 after 4200ms at 2026-08-16T17:00:00Z' },
        { kind: 'coverage', detail: 'A distinct coverage gap in an unrelated area of the record.' },
      ],
    }, { sessionId: 'session-limit-fold', signal })
    const foldedIds = folded.state.limitations.map(item => item.limitationId)
    expect(folded.state.limitations).toHaveLength(4)
    expect(foldedIds).toEqual(['tool-1', 'coverage-2', 'tool-3', 'coverage-4'])
    expect(new Set(foldedIds).size).toBe(foldedIds.length)
  })

  it('does not treat a quoted code block or link definition as an unregistered URL', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Quote a config snippet inside a research Artifact.',
    }, { sessionId: 'session-code-urls', signal })

    // A6: the scanner used to read the WHOLE Artifact, so quoting a config file
    // refused the Checkpoint even though nobody had asserted an external source.
    // The protected regions are the ones the Prose Layout already refuses to
    // reflow, plus inline code spans.
    const artifact = [
      '---',
      'endpoint: https://frontmatter.example/api',
      '---',
      '',
      '# Configuration',
      '',
      'The snippet below is quoted, not asserted.',
      '',
      '```yaml',
      'upstream: https://fenced.example/api',
      '```',
      '',
      'Inline, the value is `https://inline.example/api` in the sample.',
      '',
      '[ref]: https://reference.example/doc',
    ].join('\n')

    const published = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A snippet-bearing draft.',
      artifact,
    }, { sessionId: 'session-code-urls', signal })
    expect(published.status).toBe('active')

    // A bare prose URL outside every protected region is still refused.
    await expect(engine.dispatch(published.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'A draft asserting a bare link.',
      artifact: 'The claim rests on https://prose.example/page which was never registered.',
    }, { sessionId: 'session-code-urls', signal })).rejects.toThrow('unregistered external URL')
  })

  it('rejects unregistered raw links for every supported Source origin', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Validate raw links across supported Source origins.',
    }, { sessionId: 'session-source-links', signal })

    for (const rawUrl of [
      'file:///workspace/docs/unregistered.md',
      'llm-wiki://docs/unregistered',
      'mcp://trusted/unregistered',
    ]) {
      await expect(engine.dispatch(started.state, {
        action: 'checkpoint',
        taskId: started.state.taskId,
        stage: 'draft',
        summary: 'A draft containing an unregistered raw Source link.',
        artifact: `The claim rests on ${rawUrl} which was never registered.`,
      }, { sessionId: 'session-source-links', signal })).rejects.toThrow('unregistered external URL')
    }
  })

  it('lets a registered Source authorize its own fragment and trailing slash', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Cite the exact anchor the excerpt came from.',
    }, { sessionId: 'session-fragment', signal })

    // A6: citing the precise anchor is the more honest form and used to be refused.
    // A fragment points inside the SAME retrieved document, so it is authorized.
    const published = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'read',
      summary: 'A fragment-precise citation.',
      artifact: 'The record states the figure [@F1]. See https://example.test/report#findings and https://example.test/report/ as well.',
      sources: [{
        sourceId: 'F1',
        url: 'https://example.test/report',
        title: 'The report',
        locator: 'Findings',
        excerpt: 'the figure as recorded',
        role: 'primary',
      }],
      claims: [{
        claimId: 'F-C1',
        text: 'The record states the figure.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['F1'],
      }],
    }, { sessionId: 'session-fragment', signal })
    expect(published.status).toBe('active')

    // A different PATH retrieves a different document and is still refused.
    await expect(engine.dispatch(published.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'read',
      summary: 'A sibling path.',
      artifact: 'The record states the figure [@F1]. See also https://example.test/report-two.',
    }, { sessionId: 'session-fragment', signal })).rejects.toThrow('unregistered external URL')
  })

  it('names the accepted values in every enum rejection', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    // A9: "stage is invalid" named neither what it received nor what it would
    // take, so the only repair available to a caller was to guess an enum member.
    await expect(engine.dispatch(null, {
      action: 'start',
      outcome: 'archaeology',
      request: 'Reject an unknown Outcome.',
    }, { sessionId: 'session-enum', signal }))
      .rejects.toThrow(/outcome must be one of: research, general-writing, academic-writing, learning\. Received: "archaeology"/)

    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'general-writing',
      grounding: 'none',
      request: 'Reject an unknown stage.',
    }, { sessionId: 'session-enum', signal })
    await expect(engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'pondering',
      summary: 'An unknown stage.',
      artifact: 'A paragraph.',
    }, { sessionId: 'session-enum', signal }))
      .rejects.toThrow(/stage must be one of: discover, read, analyze, draft, verify, refine/)

    // The same rule reaches nested evidence enums, not only the action fields.
    await expect(engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'draft',
      summary: 'An unknown Claim kind.',
      artifact: 'A paragraph.',
      claims: [{
        claimId: 'ENUM-C1',
        text: 'A Claim with an unknown kind.',
        kind: 'hearsay',
        importance: 'material',
        disposition: 'supported',
        sourceIds: [],
      }],
    }, { sessionId: 'session-enum', signal }))
      .rejects.toThrow(/claim\.kind must be one of: external, analysis/)
  })

  it('classifies engine failures without changing their human sentence', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    // A8: every failure was an untyped prose string, so a caller could not tell a
    // terminal request defect from a retryable dependency outage.
    const error = await engine.dispatch(null, { action: 'dance' }, { sessionId: 'session-codes', signal })
      .then(() => undefined, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(RavenTypeError)
    // Still a TypeError by prototype, so existing instanceof guards keep working.
    expect(error).toBeInstanceOf(TypeError)
    expect((error as RavenTypeError).code).toBe('unsupported-action')
    expect((error as RavenTypeError).category).toBe('invalid-request')
    expect((error as RavenTypeError).retryable).toBe(false)
    // The human sentence is unchanged, which is what keeps plugin.ts working.
    expect((error as Error).message).toBe('Unsupported Raven action: dance')

    const missing = await engine.dispatch(null, { action: 'status' }, { sessionId: 'session-codes', signal })
      .then(() => undefined, (reason: unknown) => reason)
    expect(missing).toBeInstanceOf(RavenError)
    expect((missing as RavenError).code).toBe('task-not-found')
    expect((missing as RavenError).category).toBe('not-found')
    expect((missing as Error).message).toBe('No Raven Task exists in this session')

    // Only an unavailable dependency is worth retrying unchanged.
    expect(isRetryableRavenError('unavailable')).toBe(true)
    expect(isRetryableRavenError('invalid-request')).toBe(false)
    expect(isRetryableRavenError('conflict')).toBe(false)
    expect(isRetryableRavenError('capacity')).toBe(false)
    expect(isRetryableRavenError('not-found')).toBe(false)
  })

  it('preserves the actionable tail of a long verifier detail', async () => {
    // A15: compactError truncated to a flat 300 characters, which cut the
    // verifier's nearest-passage repair guidance mid-quotation. A truncated
    // quotation is worse than none: it invites weakening a correct excerpt until
    // it matches the visible prefix, which is the opposite of the repair intended.
    const head = 'The recorded excerpt diverges from the retrieved source. '
    const filler = 'x'.repeat(1_200)
    const tail = ' NEAREST PASSAGE: "the figure as it actually reads in the record".'
    // compactError formats THROWN failures, not the verifier's own `detail` field
    // (which is bounded separately). The path under test is therefore a verifier
    // that throws: the adapter's message is what gets compacted into the issue.
    const verifier: SourceVerifier = {
      verify: async () => {
        throw new Error(head + filler + tail)
      },
    }
    const engine = createRavenEngine({ now, sourceVerifier: verifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Report a long verifier detail.',
    }, { sessionId: 'session-compact', signal })
    const refused = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'verify',
      summary: 'A Source whose check reports a long detail.',
      artifact: 'The record states the figure [@LONG1].',
      sources: [{
        sourceId: 'LONG1',
        url: 'https://example.test/long',
        title: 'A long-detail source',
        locator: 'Section 1',
        excerpt: 'the figure as recorded',
        role: 'primary',
      }],
    }, { sessionId: 'session-compact', signal })

    const reported = refused.issues.join(' ')
    // Both ends survive: the diagnosis AND the passage the agent must repair from.
    expect(reported).toContain('diverges from the retrieved source')
    expect(reported).toContain('the figure as it actually reads in the record')
  })

  it('escapes an ampersand in a Source title exactly once', async () => {
    // A12: HTML-escaping first and backslash-escaping second composed, so the
    // entity's own semicolon was escaped too and "&" rendered as "&amp\\;".
    const rendered = renderArtifact('The record [@AMP1].', [{
      sourceId: 'AMP1',
      url: 'https://example.test/ampersand',
      resource: { origin: 'web', uri: 'https://example.test/ampersand' },
      representation: { format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'web_fetch' },
      title: 'Ways & Means Committee',
      locator: 'Section 1 & 2',
      excerpt: 'excerpt',
      role: 'primary',
      inspectedAt: now(),
      check: {
        status: 'reachable',
        checkedAt: now(),
        statusCode: 200,
        resolvedUrl: 'https://example.test/ampersand',
      },
    }])
    expect(rendered).toContain('Ways &amp; Means Committee')
    // The precise defect: escaping HTML first let the entity's own '&' be re-escaped
    // by the later pass, producing '&amp;amp;'. Assert the doubled entity is absent,
    // because '&amp;' alone survives the buggy order too and would pass vacuously.
    expect(rendered).not.toContain('&amp;amp;')
    expect(rendered).not.toContain('&amp\\;')
    // Exactly one entity per source ampersand, in the title and in the Sources list.
    expect(rendered.match(/&amp;/g)).toHaveLength(3)
    // The Sources list renders the locator through the same escape.
    expect(rendered).toContain('Section 1 &amp; 2')
  })

  it('preserves original local Markdown and verifies it through the unified Source seam', async () => {
    let received: readonly SourceCheckRequest[] = []
    const verifier: SourceVerifier = {
      verify: async (sources) => {
        received = sources
        return sources.map(source => ({ sourceId: source.sourceId, status: 'reachable' as const, checkedAt: now() }))
      },
    }
    const engine = createRavenEngine({ now, sourceVerifier: verifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Use one local Markdown source.',
      sourcePolicy: { localRoots: ['file:///workspace/docs'] },
    }, { sessionId: 'session-local-markdown', signal })
    const markdown = '# Guide\n\nKeep **Markdown** unchanged.'
    const checkpoint = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'read',
      summary: 'Grounded in a local Markdown file.',
      artifact: 'The guide requires Markdown preservation [@LOCAL1].',
      sources: [{
        sourceId: 'LOCAL1',
        title: 'Local guide',
        locator: 'Keep Markdown',
        excerpt: 'Keep **Markdown** unchanged.',
        role: 'user-provided',
        resource: { origin: 'local', uri: 'file:///workspace/docs/guide.md', mediaType: 'text/markdown' },
        representation: { format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'read', inspectionCallId: 'inspect-local', markdown },
      }],
      claims: [{
        claimId: 'LOCAL-C1',
        text: 'The guide requires Markdown preservation.',
        kind: 'external',
        importance: 'material',
        disposition: 'supported',
        sourceIds: ['LOCAL1'],
      }],
    }, { sessionId: 'session-local-markdown', signal })

    expect(checkpoint.status).toBe('active')
    expect(checkpoint.state.schemaVersion).toBe(5)
    expect(checkpoint.state.sources[0]?.representation?.markdown).toBe(markdown)
    expect(received[0]?.resource).toEqual({ origin: 'local', uri: 'file:///workspace/docs/guide.md', mediaType: 'text/markdown' })
    expect(checkpoint.renderedArtifact).toContain('local; original full Markdown by read')
  })

  it('steers Source Policy on the same Task and immediately defers newly excluded support', async () => {
    const engine = createRavenEngine({ now, sourceVerifier })
    const started = await engine.dispatch(null, {
      action: 'start',
      outcome: 'research',
      request: 'Use only the requested site.',
      sourcePolicy: { allowedWebHosts: ['EXAMPLE.TEST'], preferPrimary: true },
    }, { sessionId: 'session-policy-steer', signal })
    expect(started.state.sourcePolicy.allowedWebHosts).toEqual(['example.test'])
    expect(started.state.sourcePolicy.preferPrimary).toBe(true)

    const checkpoint = await engine.dispatch(started.state, {
      action: 'checkpoint',
      taskId: started.state.taskId,
      stage: 'read',
      summary: 'Allowed evidence.',
      artifact: 'The allowed record states the result [@POLICY1].',
      sources: [{
        sourceId: 'POLICY1',
        url: 'https://sub.example.test/record',
        title: 'Allowed record',
        locator: 'Result',
        excerpt: 'the result',
        role: 'primary',
      }],
      claims: [{
        claimId: 'POLICY-C1', text: 'The allowed record states the result.', kind: 'external',
        importance: 'material', disposition: 'supported', sourceIds: ['POLICY1'],
      }],
    }, { sessionId: 'session-policy-steer', signal })
    const steered = await engine.dispatch(checkpoint.state, {
      action: 'steer',
      taskId: started.state.taskId,
      correction: 'Block that site and keep the Task.',
      sourcePolicy: { allowedWebHosts: [], blockedWebHosts: ['example.test'] },
    }, { sessionId: 'session-policy-steer', signal })

    expect(steered.state.taskId).toBe(started.state.taskId)
    expect(steered.state.sources[0]?.check).toMatchObject({ status: 'unavailable', detail: expect.stringContaining('Task Source Policy') })
    expect(steered.state.claims[0]).toMatchObject({ disposition: 'deferred', deferredFrom: 'supported' })
    expect(steered.state.limitations.some(item => item.sourceId === 'POLICY1')).toBe(true)
    expect(steered.state.steering[0]?.sourcePolicy?.blockedWebHosts).toEqual(['example.test'])

    const relaxed = await engine.dispatch(steered.state, {
      action: 'steer',
      taskId: started.state.taskId,
      correction: 'Allow the site again.',
      sourcePolicy: { blockedWebHosts: [] },
    }, { sessionId: 'session-policy-steer', signal })
    expect(relaxed.state.sources[0]?.check.status).toBe('unchecked')
    expect(relaxed.state.claims[0]).toMatchObject({ disposition: 'deferred', deferredFrom: 'supported' })

    const reverified = await engine.dispatch(relaxed.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'verify',
      summary: 'Allowed evidence reverified.',
      artifact: 'The allowed record states the result [@POLICY1].',
    }, { sessionId: 'session-policy-steer', signal })
    expect(reverified.state.sources[0]?.check.status).toBe('reachable')
    expect(reverified.state.claims[0]?.disposition).toBe('supported')
    expect(reverified.state.claims[0]?.deferredFrom).toBeUndefined()
    expect(reverified.state.limitations.some(item => item.sourceId === 'POLICY1')).toBe(false)

    const completed = await engine.dispatch(reverified.state, {
      action: 'complete', taskId: started.state.taskId, artifact: reverified.state.latestArtifact,
    }, { sessionId: 'session-policy-steer', signal })
    expect(completed.status).toBe('completed')
  })

  it('keeps policy-excluded MCP material out of the verifier and records the limitation', async () => {
    const verify = vi.fn(async (sources: readonly SourceCheckRequest[]) => sources.map(source => ({
      sourceId: source.sourceId, status: 'reachable' as const, checkedAt: now(),
    })))
    const engine = createRavenEngine({ now, sourceVerifier: { verify } })
    const started = await engine.dispatch(null, {
      action: 'start', outcome: 'research', request: 'Use one MCP source.',
      sourcePolicy: { includedMcpSources: ['trusted'], excludedMcpSources: ['blocked'] },
    }, { sessionId: 'session-mcp-policy', signal })
    const result = await engine.dispatch(started.state, {
      action: 'checkpoint', taskId: started.state.taskId, stage: 'read', summary: 'Excluded MCP material.',
      artifact: 'The MCP page states the result [@MCP1].',
      sources: [{
        sourceId: 'MCP1', title: 'MCP page', locator: 'resource body', excerpt: 'states the result',
        resource: { origin: 'mcp', uri: 'mcp://blocked/page', sourceName: 'blocked', mediaType: 'text/plain' },
        representation: { format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'mcp__blocked__read', inspectionCallId: 'inspect-mcp', markdown: 'The page states the result.' },
      }],
      claims: [{
        claimId: 'MCP-C1', text: 'The MCP page states the result.', kind: 'external', importance: 'material',
        disposition: 'supported', sourceIds: ['MCP1'],
      }],
    }, { sessionId: 'session-mcp-policy', signal })

    expect(result.status).toBe('needs-revision')
    expect(verify).toHaveBeenCalledWith([], signal, expect.objectContaining({ sessionId: 'session-mcp-policy' }))
    expect(result.state.sources[0]?.check.status).toBe('unavailable')
    expect(result.state.claims[0]?.disposition).toBe('deferred')
    expect(result.state.limitations[0]?.detail).toContain('Source Policy')
  })
})
