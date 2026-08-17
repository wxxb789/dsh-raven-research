import { describe, expect, it, vi } from 'vitest'

import { createRavenEngine, renderArtifact } from '../../src/engine.js'
import { RAVEN_LIMITS, type SourceCheckRequest, type SourceVerifier } from '../../src/domain.js'

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
    expect(failedAttempt.state).toBe(started.state)
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
    expect(rejected.state).toBe(started.state)
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
    expect(rejected.state).toBe(started.state)
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
})
