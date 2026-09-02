import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { writeEvaluationReport } from '../../scripts/evaluation-report.js'

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

const usage = {
  uncachedInputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  outputTokens: 10,
  totalTokens: 20,
  reasoningTokens: null,
  modelCalls: 1,
  toolCalls: 0,
  ptcNestedCalls: 0,
  searchCalls: 0,
  fetchCalls: 0,
  durationMs: 100,
}

describe('evaluation factual report', () => {
  it('separates validity, completion, usage, and missing review without scoring a winner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-report-'))
    await Promise.all([
      mkdir(join(root, 'vanilla'), { recursive: true }),
      mkdir(join(root, 'raven'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(root, 'vanilla', 'artifact.md'), 'Vanilla artifact.\n'),
      writeFile(join(root, 'raven', 'artifact.md'), 'Raven artifact.\n'),
    ])
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      scenarioId: 'general-writing',
      scenarioKind: 'primary',
      scenarioSha256: `sha256:${'a'.repeat(64)}`,
      inputsSha256: `sha256:${'b'.repeat(64)}`,
      sourceSnapshotSha256: `sha256:${'c'.repeat(64)}`,
      baseCompositionSha256: `sha256:${'d'.repeat(64)}`,
      parity: { pass: true },
      provider: 'test',
      model: 'same-model',
      reasoningEffort: null,
      maxTokens: 1000,
      order: ['vanilla', 'raven'],
      fixtureModel: false,
      outcomeComplete: false,
      promotable: false,
      harnessCommit: 'harness',
      harnessDirty: false,
      ravenCommit: 'raven',
      ravenDirty: true,
      arms: {
        vanilla: {
          path: 'vanilla', initialWorkspaceSha256: 'same', terminalStatus: 'completed',
          artifactPath: 'artifact.md', artifactSha256: digest('Vanilla artifact.\n'), ravenTask: null, usage,
        },
        raven: {
          path: 'raven', initialWorkspaceSha256: 'same', terminalStatus: 'completed',
          artifactPath: 'artifact.md', artifactSha256: digest('Raven artifact.\n'),
          ravenTask: { taskId: 'rvn-1', phase: 'active', revision: 2, checkpoints: 1 },
          usage: { ...usage, outputTokens: 25, totalTokens: 40, modelCalls: 2 },
        },
      },
    }) + '\n')

    const written = await writeEvaluationReport(root)
    const json = JSON.parse(await readFile(written.json, 'utf8')) as Record<string, unknown>
    const markdown = await readFile(written.markdown, 'utf8')

    expect(json).not.toHaveProperty('score')
    expect(json).not.toHaveProperty('winner')
    expect(json).toMatchObject({
      validity: { methodologyValid: false, artifactIntegrity: true, promotable: false },
      outcomes: { scenarioFloorPassed: false },
      review: { status: 'required', attached: false },
      usage: { rightMinusLeft: { outputTokens: 15, totalTokens: 20, modelCalls: 1 } },
    })
    expect(markdown).toContain('no weighted score or automatic winner')
    expect(markdown).toContain('reviews.jsonl is not attached')
  })
})
