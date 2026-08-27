import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { decodeRavenTaskState, RAVEN_SCHEMA_VERSION } from '../../src/codec.js'
import { createRavenEngine } from '../../src/engine.js'
import { RAVEN_LIMITS, type RavenTaskState, type SourceVerifier } from '../../src/domain.js'
import { sourceInspectionSha256 } from '../../src/source.js'

const now = () => '2026-08-16T16:00:00.000Z'
const sourceVerifier: SourceVerifier = { verify: async () => [] }
const reachableVerifier: SourceVerifier = {
  verify: async sources => sources.map(source => ({
    sourceId: source.sourceId,
    status: 'reachable' as const,
    checkedAt: now(),
    statusCode: 200,
    resolvedUrl: source.url,
  })),
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

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
    expect(decodeRavenTaskState(roundTrip)).toEqual({ ...state, schemaVersion: 2, sourcePolicy: {
      allowedWebHosts: [], blockedWebHosts: [], preferPrimary: false, localRoots: [], llmWikiRoots: [],
      includedMcpSources: [], excludedMcpSources: [],
    } })
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

  it('rejects a null Source check without throwing', async () => {
    const state = await validState()
    expect(decodeRavenTaskState({
      ...state,
      schemaVersion: 2,
      sources: [{
        sourceId: 'LOCAL',
        url: 'file:///workspace/source.md',
        resource: { origin: 'local', uri: 'file:///workspace/source.md' },
        representation: null,
        title: 'A Source',
        locator: 'Section 1',
        excerpt: 'an excerpt',
        role: 'primary',
        inspectedAt: now(),
        check: null,
      }],
    })).toBeUndefined()
  })

  /**
   * A1: the engine must never emit a state the codec rejects.
   *
   * The reproduced defect: the engine verified only MATERIAL external Claims, so
   * an external Claim with importance=context kept its Source at
   * `{status:'unchecked'}`; the codec then rejected the ENTIRE snapshot and
   * plugin.ts's replay silently skipped it, losing the whole Task. This drives a
   * real Task through every action that mutates state, with the exact shapes that
   * used to break it — context Claims, deferred Claims, contradicts links, and
   * every Limitation kind — and feeds each emitted state straight into the codec.
   */
  it('emits no state the codec rejects, across every mutating action', async () => {
    const engine = createRavenEngine({ now, sourceVerifier: reachableVerifier })
    const signal = new AbortController().signal
    const sessionId = 'codec-roundtrip'
    const emitted: RavenTaskState[] = []
    const dispatch = async (input: Record<string, unknown>, previous: RavenTaskState | null) => {
      const result = await engine.dispatch(previous, input, { sessionId, signal })
      emitted.push(result.state)
      return result
    }

    const started = await dispatch({
      action: 'start',
      outcome: 'research',
      request: 'Drive the codec through every emitted shape.',
    }, null)
    const taskId = started.state.taskId

    const checkpoint = await dispatch({
      action: 'checkpoint',
      taskId,
      stage: 'analyze',
      summary: 'Context Claims, deferrals, contradictions, and every Limitation kind.',
      artifact: 'The primary record states the figure [@S1]. A second record disagrees [@S2].',
      sources: [
        {
          sourceId: 'S1',
          url: 'https://example.test/one',
          title: 'Record one',
          locator: 'Table 1',
          excerpt: 'the figure recorded by record one',
          role: 'primary',
          sourceFamily: 'record-one',
          asOf: '2026-08-16',
        },
        {
          sourceId: 'S2',
          url: 'https://example.test/two',
          title: 'Record two',
          locator: 'Table 2',
          excerpt: 'the figure recorded by record two',
          role: 'primary',
          sourceFamily: 'record-two',
        },
        {
          // Cited by NOTHING in the Artifact and supported only by a CONTEXT Claim.
          // This is the Source the material-only rule skipped: nothing else selects
          // it for verification, so it stayed `unchecked` and the codec rejected the
          // whole snapshot. If A1 regresses, only this Source exposes it.
          sourceId: 'S3',
          url: 'https://example.test/three',
          title: 'Record three',
          locator: 'Appendix',
          excerpt: 'the background note recorded by record three',
          role: 'secondary',
          sourceFamily: 'record-three',
        },
      ],
      claims: [
        {
          claimId: 'M1',
          text: 'The primary record states the figure.',
          kind: 'external',
          importance: 'material',
          disposition: 'supported',
          sourceIds: ['S1'],
          contradicts: ['M2'],
        },
        {
          claimId: 'M2',
          text: 'A second record disagrees.',
          kind: 'external',
          importance: 'material',
          disposition: 'qualified',
          sourceIds: ['S2'],
          contradicts: ['M1'],
        },
        // The exact shape that used to make the whole snapshot undecodable.
        {
          claimId: 'CTX1',
          text: 'A context Claim whose Source was never verified.',
          kind: 'external',
          importance: 'context',
          disposition: 'supported',
          sourceIds: ['S3'],
        },
        {
          claimId: 'D1',
          text: 'A Claim deferred for want of corroboration.',
          kind: 'external',
          importance: 'material',
          disposition: 'deferred',
          sourceIds: [],
        },
        {
          claimId: 'A1',
          text: 'An analysis Claim carries no Source.',
          kind: 'analysis',
          importance: 'context',
          disposition: 'supported',
          sourceIds: [],
        },
      ],
      failures: [
        { kind: 'source', detail: 'One recorded Source could not be reopened.', sourceId: 'S2' },
        { kind: 'tool', detail: 'One discovery query timed out.' },
        { kind: 'coverage', detail: 'No record of the 2019 figure was found where one would exist.' },
      ],
    }, started.state)
    expect(checkpoint.status).toBe('active')

    const steered = await dispatch({
      action: 'steer',
      taskId,
      correction: 'Lead with the disagreement rather than with the figure.',
    }, checkpoint.state)

    const revised = await dispatch({
      action: 'checkpoint',
      taskId,
      stage: 'refine',
      summary: 'Revised after the correction.',
      artifact: 'Two records disagree about the figure [@S1] [@S2].',
    }, steered.state)

    const completed = await dispatch({
      action: 'complete',
      taskId,
      artifact: revised.state.latestArtifact,
    }, revised.state)
    expect(completed.status).toMatch(/^completed/)

    expect(emitted.length).toBeGreaterThan(4)
    for (const state of emitted) {
      const replayed: unknown = JSON.parse(JSON.stringify(state))
      // Not just "defined": the codec must return the SAME Task, not a shell.
      expect(decodeRavenTaskState(replayed)).toEqual({ ...state, schemaVersion: 2, sourcePolicy: {
        allowedWebHosts: [], blockedWebHosts: [], preferPrimary: false, localRoots: [], llmWikiRoots: [],
        includedMcpSources: [], excludedMcpSources: [],
      }, sources: state.sources.map(source => ({
        ...source,
        resource: { origin: 'web', uri: source.url },
        representation: { format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'web_fetch' },
      })) })
    }
  })

  it('defers one unsupportable Claim instead of dropping the whole Task', async () => {
    const state = await validState()
    const withClaim = {
      ...state,
      claims: [{
        claimId: 'ORPHAN',
        text: 'A Claim whose Source is no longer reachable.',
        kind: 'external',
        importance: 'context',
        disposition: 'supported',
        sourceIds: [],
      }],
    }
    const decoded = decodeRavenTaskState(withClaim)
    // A1 resilience: one unusable Claim must never cost the Task.
    expect(decoded).toBeDefined()
    expect(decoded?.claims[0]?.disposition).toBe('deferred')
    expect(decoded?.taskId).toBe(state.taskId)
  })

  it('rejects a malformed Claim rather than repairing it', async () => {
    const state = await validState()
    // A corrupt record is not a stale one; only the disposition is repairable.
    expect(decodeRavenTaskState({ ...state, claims: [{ claimId: 'BAD' }] })).toBeUndefined()
  })

  it('accepts non-positional Checkpoint and Limitation identities', async () => {
    const state = await validState()
    // A4/A10: identity is derived from the revision and from a monotonic counter,
    // never from the array index, so a trimmed Checkpoint list and an interleaved
    // Limitation ordering both stay decodable.
    const decoded = decodeRavenTaskState({
      ...state,
      revision: 9,
      latestArtifact: 'A stored Artifact.',
      checkpoints: [
        {
          checkpointId: `${state.taskId}-cp-r2`,
          ordinal: 4,
          stage: 'draft',
          summary: 'A surviving earlier Checkpoint.',
          artifactSha256: sha256('An earlier Artifact.'),
          artifactChars: 'An earlier Artifact.'.length,
          steeringRevision: 0,
          createdAt: now(),
          proseLayout: 'sentence-per-line',
        },
        {
          checkpointId: `${state.taskId}-cp-r9`,
          ordinal: 17,
          stage: 'refine',
          summary: 'The latest Checkpoint.',
          artifactSha256: sha256('A stored Artifact.'),
          artifactChars: 'A stored Artifact.'.length,
          steeringRevision: 0,
          createdAt: now(),
          proseLayout: 'sentence-per-line',
        },
      ],
      limitations: [
        { limitationId: 'tool-1', kind: 'tool', detail: 'A tool failure.', createdAt: now() },
        { limitationId: 'coverage-2', kind: 'coverage', detail: 'A coverage gap.', createdAt: now() },
        { limitationId: 'tool-3', kind: 'tool', detail: 'A later tool failure.', createdAt: now() },
      ],
    })
    expect(decoded).toBeDefined()
    expect(decoded?.checkpoints.map(item => item.ordinal)).toEqual([4, 17])
    expect(decoded?.limitations).toHaveLength(3)
  })

  it('rejects a Checkpoint id belonging to another Task and a non-increasing ordinal', async () => {
    const state = await validState()
    const base = {
      ordinal: 1,
      stage: 'draft' as const,
      summary: 'A Checkpoint.',
      artifactSha256: sha256('A stored Artifact.'),
      artifactChars: 'A stored Artifact.'.length,
      steeringRevision: 0,
      createdAt: now(),
    }
    expect(decodeRavenTaskState({
      ...state,
      latestArtifact: 'A stored Artifact.',
      checkpoints: [{ ...base, checkpointId: 'rvn-000000000000-1-cp-r2' }],
    })).toBeUndefined()
    expect(decodeRavenTaskState({
      ...state,
      latestArtifact: 'A stored Artifact.',
      checkpoints: [
        { ...base, checkpointId: `${state.taskId}-cp-r2`, ordinal: 3 },
        { ...base, checkpointId: `${state.taskId}-cp-r3`, ordinal: 3 },
      ],
    })).toBeUndefined()
  })

  it('migrates schema-v1 web sources without losing provenance', async () => {
    const state = await validState()
    const v1 = {
      ...state,
      schemaVersion: 1,
      sources: [{
        sourceId: 'S1',
        url: 'HTTPS://EXAMPLE.TEST:443/source',
        title: 'A Source',
        locator: 'Section 1',
        excerpt: 'an excerpt',
        role: 'primary',
        inspectedAt: now(),
        check: { status: 'reachable', checkedAt: now(), statusCode: 200, resolvedUrl: 'https://example.test/source' },
      }],
    }
    const decoded = decodeRavenTaskState(v1)
    expect(RAVEN_SCHEMA_VERSION).toBe(2)
    expect(decoded?.schemaVersion).toBe(2)
    expect(decoded?.sourcePolicy).toEqual({
      allowedWebHosts: [], blockedWebHosts: [], preferPrimary: false, localRoots: [], llmWikiRoots: [],
      includedMcpSources: [], excludedMcpSources: [],
    })
    expect(decoded?.sources[0]).toMatchObject({
      url: 'https://example.test/source',
      resource: { origin: 'web', uri: 'https://example.test/source' },
      representation: { format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'web_fetch' },
      check: { status: 'reachable', statusCode: 200 },
    })
  })

  it('accepts local original Markdown and a non-web unavailable source with no representation', async () => {
    const state = await validState()
    const base = { ...state, schemaVersion: 2, sourcePolicy: {
      allowedWebHosts: [], blockedWebHosts: [], preferPrimary: true, localRoots: ['file:///workspace'],
      llmWikiRoots: [], includedMcpSources: ['docs'], excludedMcpSources: [],
    } }
    const decoded = decodeRavenTaskState({ ...base, sources: [
      {
        sourceId: 'LOCAL', url: 'file:///workspace/readme.md', title: 'Readme', locator: 'Intro', excerpt: 'Hello',
        role: 'user-provided', inspectedAt: now(), resource: { origin: 'local', uri: 'file:///workspace/readme.md', mediaType: 'text/markdown' },
        representation: { format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'local_read', inspectionCallId: 'inspect-local', markdown: '# Hello' },
        inspectionSha256: sourceInspectionSha256(
          { origin: 'local', uri: 'file:///workspace/readme.md', mediaType: 'text/markdown' },
          { format: 'markdown', derivation: 'original', coverage: 'full', producedBy: 'local_read', inspectionCallId: 'inspect-local', markdown: '# Hello' },
        ),
        check: { status: 'reachable', checkedAt: now() },
      },
      {
        sourceId: 'MCP', url: 'mcp://docs/item', title: 'MCP item', locator: 'resource', excerpt: 'Unavailable',
        role: 'secondary', inspectedAt: now(), resource: { origin: 'mcp', uri: 'mcp://docs/item', sourceName: 'docs' },
        representation: null, check: { status: 'unavailable', checkedAt: now(), detail: 'Tool unavailable' },
      },
    ] })
    expect(decoded?.sources).toHaveLength(2)
  })

  it('rejects invalid origins, identity mismatches, and corrupt source policies', async () => {
    const state = await validState()
    const source = {
      sourceId: 'S1', url: 'file:///workspace/a.md', title: 'A Source', locator: 'Section 1', excerpt: 'text',
      role: 'primary', inspectedAt: now(), resource: { origin: 'local', uri: 'file:///workspace/a.md' },
      representation: null, check: { status: 'unavailable', checkedAt: now(), detail: 'Unreadable' },
    }
    const policy = { allowedWebHosts: [], blockedWebHosts: [], preferPrimary: false, localRoots: [], llmWikiRoots: [], includedMcpSources: [], excludedMcpSources: [] }
    expect(decodeRavenTaskState({ ...state, schemaVersion: 2, sourcePolicy: policy, sources: [{ ...source, resource: { origin: 'git', uri: source.url } }] })).toBeUndefined()
    expect(decodeRavenTaskState({ ...state, schemaVersion: 2, sourcePolicy: policy, sources: [{ ...source, resource: { origin: 'local', uri: 'file:///workspace/b.md' } }] })).toBeUndefined()
    expect(decodeRavenTaskState({ ...state, schemaVersion: 2, sourcePolicy: { ...policy, localRoots: ['file:///workspace', 'file:///workspace'] }, sources: [] })).toBeUndefined()
    expect(decodeRavenTaskState({ ...state, schemaVersion: 2, sourcePolicy: { ...policy, allowedWebHosts: ['example.test'], blockedWebHosts: ['example.test'] }, sources: [] })).toBeUndefined()
    expect(decodeRavenTaskState({ ...state, schemaVersion: 2, sourcePolicy: { ...policy, allowedWebHosts: ['HTTPS://EXAMPLE.TEST/path'] }, sources: [] })).toBeUndefined()
    expect(decodeRavenTaskState({ ...state, schemaVersion: 2, sourcePolicy: { ...policy, localRoots: ['file:///workspace/../secret'] }, sources: [] })).toBeUndefined()
    expect(decodeRavenTaskState({ ...state, schemaVersion: 2, sourcePolicy: policy, sources: [
      source,
      { ...source, sourceId: 'S2', resource: { origin: 'llm-wiki', uri: source.url, sourceName: 'wiki' } },
    ] })).toBeUndefined()
  })

  it('keeps migration bounded to known older schemas', async () => {
    const state = await validState()
    expect(decodeRavenTaskState({ ...state, schemaVersion: 0 })).toBeUndefined()
    expect(decodeRavenTaskState({ ...state, schemaVersion: 3 })).toBeUndefined()
    expect(decodeRavenTaskState({ ...state, schemaVersion: 'one' })).toBeUndefined()
  })
  // rather than one unreadable snapshot.

  it('protects counter identity: rejects a negative, fractional, or non-finite ordinal', async () => {
    const state = await validState()
    // `ordinal` also participates in the taskId pattern, so a corrupt value here
    // would otherwise let a snapshot claim an identity no Task ever minted.
    for (const ordinal of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
      expect(decodeRavenTaskState({ ...state, ordinal })).toBeUndefined()
    }
  })

  it('protects monotonic revision: rejects a zero, negative, or fractional revision', async () => {
    const state = await validState()
    // Replay keeps the HIGHEST revision per Task, so a fractional or negative
    // revision would silently win or lose a race against a real write.
    for (const revision of [0, -3, 2.5, Number.NaN, '2', null]) {
      expect(decodeRavenTaskState({ ...state, revision })).toBeUndefined()
    }
  })

  it('protects temporal fields: rejects a timestamp that is not a parseable instant', async () => {
    const state = await validState()
    expect(decodeRavenTaskState({ ...state, startedAt: 'not-a-timestamp' })).toBeUndefined()
    expect(decodeRavenTaskState({ ...state, updatedAt: '2026-13-45T99:99:99Z' })).toBeUndefined()
    // A number is not a timestamp here even though Date.parse would coerce one.
    expect(decodeRavenTaskState({ ...state, updatedAt: 1_760_000_000_000 })).toBeUndefined()
    expect(decodeRavenTaskState({ ...state, updatedAt: '' })).toBeUndefined()
  })

  it('protects Source URL identity: rejects any scheme that is not http(s), and credentials', async () => {
    const state = await validState()
    const withUrl = (url: unknown) => ({
      ...state,
      sources: [{
        sourceId: 'S1',
        url,
        title: 'A Source',
        locator: 'Section 1',
        excerpt: 'an excerpt',
        role: 'primary',
        inspectedAt: now(),
        check: { status: 'unchecked' },
      }],
    })
    // A stored snapshot is an untrusted input: a non-http scheme reaching the
    // verifier or a rendered Artifact link is a capability, not a citation.
    for (const url of [
      'ftp://example.test/a',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>',
      '/just/a/path',
      'https://user:secret@example.test/a',
      '',
      null,
    ]) {
      expect(decodeRavenTaskState(withUrl(url))).toBeUndefined()
    }
  })

  it('protects Source uniqueness: rejects a duplicated Source ID or URL', async () => {
    const state = await validState()
    const source = (sourceId: string, url: string) => ({
      sourceId,
      url,
      title: 'A Source',
      locator: 'Section 1',
      excerpt: 'an excerpt',
      role: 'primary',
      inspectedAt: now(),
      check: { status: 'unchecked' },
    })
    // Two records under one ID make the Claim→Source trace ambiguous, which is
    // exactly the provenance the codec exists to keep honest.
    expect(decodeRavenTaskState({
      ...state,
      sources: [source('S1', 'https://example.test/a'), source('S1', 'https://example.test/b')],
    })).toBeUndefined()
    expect(decodeRavenTaskState({
      ...state,
      sources: [source('S1', 'https://example.test/a'), source('S2', 'https://example.test/a')],
    })).toBeUndefined()
  })

  it('protects contradiction links: rejects a contradicts entry naming no Claim in the Task', async () => {
    const state = await validState()
    const claim = (extra: Record<string, unknown>) => ({
      ...state,
      claims: [{
        claimId: 'C1',
        text: 'An analysis Claim.',
        kind: 'analysis',
        importance: 'context',
        disposition: 'supported',
        sourceIds: [],
        ...extra,
      }],
    })
    // A dangling link would render as "contested with <nothing>", quietly
    // downgrading a Claim the reader is told is disputed.
    expect(decodeRavenTaskState(claim({ contradicts: ['GHOST'] }))).toBeUndefined()
    // Self-contradiction is never a real disagreement.
    expect(decodeRavenTaskState(claim({ contradicts: ['C1'] }))).toBeUndefined()
    expect(decodeRavenTaskState(claim({ contradicts: ['C1', 'C1'] }))).toBeUndefined()
  })

  it('protects Limitation identity by shape and uniqueness, NOT by array position', async () => {
    const state = await validState()
    const limitation = (limitationId: string, kind: string) => ({
      limitationId,
      kind,
      detail: 'A recorded failure.',
      createdAt: now(),
    })
    // A10 deliberately made identity non-positional: requiring
    // `${kind}-${index + 1}` made a legally constructed ordering undecodable the
    // moment two kinds interleaved, and dropped the whole Task on replay. So a
    // position-mismatched id is now CORRECT to accept — that is the fix, not a
    // regression — and what must still be rejected is a malformed or colliding id.
    const accepted = decodeRavenTaskState({
      ...state,
      limitations: [limitation('tool-1', 'tool'), limitation('coverage-7', 'coverage')],
    })
    expect(accepted).toBeDefined()
    expect(accepted?.limitations.map(item => item.limitationId)).toEqual(['tool-1', 'coverage-7'])

    // The id must belong to its own kind, carry a numeric ordinal, and be unique.
    expect(decodeRavenTaskState({
      ...state,
      limitations: [limitation('source-2', 'coverage')],
    })).toBeUndefined()
    expect(decodeRavenTaskState({
      ...state,
      limitations: [limitation('tool-abc', 'tool')],
    })).toBeUndefined()
    expect(decodeRavenTaskState({
      ...state,
      limitations: [limitation('tool-1', 'tool'), limitation('tool-1', 'tool')],
    })).toBeUndefined()
  })

  it('protects Limitation evidence links: rejects a sourceId naming no registered Source', async () => {
    const state = await validState()
    expect(decodeRavenTaskState({
      ...state,
      limitations: [{
        limitationId: 'source-1',
        kind: 'source',
        detail: 'A Source failed verification.',
        sourceId: 'GHOST',
        createdAt: now(),
      }],
    })).toBeUndefined()
  })

  it('protects collection ceilings: accepts Sources and Claims at the cap and rejects one past it', async () => {
    const state = await validState()
    const sources = (count: number) => Array.from({ length: count }, (_value, index) => ({
      sourceId: `S${index}`,
      url: `https://example.test/source-${index}`,
      resource: { origin: 'web', uri: `https://example.test/source-${index}` },
      representation: { format: 'markdown', derivation: 'converted', coverage: 'unknown', producedBy: 'web_fetch' },
      title: 'A Source',
      locator: 'Section 1',
      excerpt: 'an excerpt',
      role: 'primary',
      inspectedAt: now(),
      check: { status: 'unchecked' },
    }))
    const claims = (count: number) => Array.from({ length: count }, (_value, index) => ({
      claimId: `C${index}`,
      text: 'An analysis Claim.',
      kind: 'analysis',
      importance: 'context',
      disposition: 'supported',
      sourceIds: [],
    }))

    // At the cap the snapshot is legal: the engine can emit exactly this, so the
    // codec refusing it would be the A1 data-loss bug in a different collection.
    expect(decodeRavenTaskState({ ...state, sources: sources(RAVEN_LIMITS.sources) })).toBeDefined()
    expect(decodeRavenTaskState({ ...state, claims: claims(RAVEN_LIMITS.claims) })).toBeDefined()
    // One past the cap is rejected on length alone — these same generators are
    // accepted one element smaller, so nothing else in the fixture is the cause.
    expect(decodeRavenTaskState({ ...state, sources: sources(RAVEN_LIMITS.sources - 1) })).toBeDefined()
    expect(decodeRavenTaskState({ ...state, claims: claims(RAVEN_LIMITS.claims - 1) })).toBeDefined()
    expect(decodeRavenTaskState({ ...state, sources: sources(RAVEN_LIMITS.sources + 1) })).toBeUndefined()
    expect(decodeRavenTaskState({ ...state, claims: claims(RAVEN_LIMITS.claims + 1) })).toBeUndefined()
  })

  it('decides rather than throwing on every corrupted shape', async () => {
    const state = await validState()
    // plugin.ts's replay calls this inside a loop over session events. A throw
    // there takes down the whole session instead of skipping one bad snapshot,
    // so totality is the property that makes the rejections above safe to rely on.
    const corruptions: unknown[] = [
      undefined,
      null,
      42,
      'a string',
      [],
      {},
      { ...state, sources: 'not-an-array' },
      { ...state, claims: [null] },
      { ...state, limitations: [42] },
      { ...state, checkpoints: [{ checkpointId: null }] },
      { ...state, steering: [{ revision: 'one' }] },
      { ...state, verification: { mode: 'invented' } },
      { ...state, drafts: [{ ordinal: -1 }] },
      { ...state, latestArtifact: 12 },
      { ...state, taskId: 'not-a-raven-id' },
    ]
    for (const corrupted of corruptions) {
      expect(() => decodeRavenTaskState(corrupted)).not.toThrow()
      expect(decodeRavenTaskState(corrupted)).toBeUndefined()
    }
  })
})
