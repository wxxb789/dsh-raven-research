import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { prepareEvaluationReview } from '../../scripts/evaluation-review.js'

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function arm(
  root: string,
  condition: 'vanilla' | 'raven',
  artifact: string,
  scenario: Buffer,
  rubric: Buffer,
  source: Buffer,
  generation = 'process-1',
): Promise<void> {
  const path = join(root, condition)
  await mkdir(join(path, 'input-workspace', 'fixtures', 'local'), { recursive: true })
  await Promise.all([
    writeFile(join(path, 'progress.json'), JSON.stringify({ processGenerationIds: [generation] }) + '\n'),
    writeFile(join(path, `artifact-${generation}.md`), artifact),
    writeFile(join(path, 'scenario.json'), scenario),
    writeFile(join(path, 'rubric.md'), rubric),
    writeFile(join(path, 'input-workspace', 'fixtures', 'local', 'operations-notes.md'), source),
  ])
}

describe('evaluation review packet', () => {
  it('keeps the deterministic A/B mapping outside the blinded packet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-review-'))
    const [scenario, rubric, source] = await Promise.all([
      readFile(new URL('../../evaluation/scenarios/general-writing.json', import.meta.url)),
      readFile(new URL('../../evaluation/rubric.md', import.meta.url)),
      readFile(new URL('../../evaluation/fixtures/local/operations-notes.md', import.meta.url)),
    ])
    await Promise.all([
      arm(root, 'vanilla', 'VANILLA ARTIFACT\n', scenario, rubric, source),
      arm(root, 'raven', 'RAVEN ARTIFACT\n', scenario, rubric, source),
    ])
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      scenarioId: 'general-writing',
      scenarioSha256: digest(scenario),
      rubricSha256: digest(rubric),
      order: ['vanilla', 'raven'],
      arms: {
        vanilla: { path: 'vanilla', artifactPath: 'artifact-process-1.md', artifactSha256: digest('VANILLA ARTIFACT\n') },
        raven: { path: 'raven', artifactPath: 'artifact-process-1.md', artifactSha256: digest('RAVEN ARTIFACT\n') },
      },
    }) + '\n')

    const packet = await prepareEvaluationReview(root, 'stable-seed')
    const firstManifest = await readFile(join(packet, 'manifest.json'), 'utf8')
    const firstA = await readFile(join(packet, 'A.md'), 'utf8')
    const firstUnblinding = await readFile(join(root, 'review', 'unblinding.json'), 'utf8')
    const binding = JSON.parse(await readFile(join(packet, 'binding.json'), 'utf8')) as { packetManifestSha256: string }
    const checklist = await readFile(join(packet, 'assessor-checklist.json'), 'utf8')
    const frozenScenario = await readFile(join(packet, 'scenario.json'), 'utf8')

    await expect(prepareEvaluationReview(root, 'stable-seed')).rejects
      .toThrow('review batch already exists and is immutable')

    expect(JSON.parse(firstManifest)).not.toHaveProperty('mapping')
    expect(firstManifest).toContain('"quality": "user-provided"')
    expect(firstManifest).toContain('"family": "user-notes"')
    expect(binding.packetManifestSha256).toBe(digest(firstManifest))
    expect(firstUnblinding).toMatch(/"A": "(?:vanilla|raven)"/)
    expect(JSON.parse(firstUnblinding)).toMatchObject({ binding })
    expect(['VANILLA ARTIFACT\n', 'RAVEN ARTIFACT\n']).toContain(firstA)
    expect(checklist).toContain('audience-engineering-directors')
    expect(checklist).toContain('reversal-condition')
    expect(checklist).not.toContain('v1-withdrawn')
    expect(frozenScenario).toContain('Use only the supplied implementation notes')
    expect(await readFile(join(packet, 'rubric.md'), 'utf8')).toContain('Do not infer which arm is Raven')
    expect(await readFile(join(root, 'review', 'lifecycle', 'LIFECYCLE_REVIEW.md'), 'utf8'))
      .toContain('require exact Session event sequence evidence')
    expect(await readFile(join(packet, 'A.md'), 'utf8')).toBe(firstA)
    expect(await readFile(join(root, 'review', 'unblinding.json'), 'utf8')).toBe(firstUnblinding)
  })

  it('rejects traversal-bearing process generation metadata before reading an artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-review-generation-'))
    const [scenario, rubric, source] = await Promise.all([
      readFile(new URL('../../evaluation/scenarios/general-writing.json', import.meta.url)),
      readFile(new URL('../../evaluation/rubric.md', import.meta.url)),
      readFile(new URL('../../evaluation/fixtures/local/operations-notes.md', import.meta.url)),
    ])
    await Promise.all([
      arm(root, 'vanilla', 'VANILLA ARTIFACT\n', scenario, rubric, source),
      arm(root, 'raven', 'RAVEN ARTIFACT\n', scenario, rubric, source),
    ])
    await writeFile(join(root, 'raven', 'progress.json'), JSON.stringify({
      processGenerationIds: ['../../assessor-facts'],
    }) + '\n')
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      scenarioId: 'general-writing',
      scenarioSha256: digest(scenario),
      rubricSha256: digest(rubric),
      order: ['vanilla', 'raven'],
      arms: {
        vanilla: { path: 'vanilla', artifactPath: 'artifact-process-1.md', artifactSha256: digest('VANILLA ARTIFACT\n') },
        raven: { path: 'raven', artifactPath: 'artifact-process-1.md', artifactSha256: digest('RAVEN ARTIFACT\n') },
      },
    }) + '\n')

    await expect(prepareEvaluationReview(root, 'stable-seed')).rejects
      .toThrow('run arm has an invalid process generation: raven')
    await expect(readFile(join(root, 'review', 'unblinding.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails before creating a packet when the assessor checklist is incomplete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-review-missing-fact-'))
    const evaluationRoot = await mkdtemp(join(tmpdir(), 'raven-review-catalog-'))
    const [scenario, rubric, source, rawCatalog] = await Promise.all([
      readFile(new URL('../../evaluation/scenarios/general-writing.json', import.meta.url)),
      readFile(new URL('../../evaluation/rubric.md', import.meta.url)),
      readFile(new URL('../../evaluation/fixtures/local/operations-notes.md', import.meta.url)),
      readFile(new URL('../../evaluation/assessor-facts.json', import.meta.url), 'utf8'),
    ])
    await Promise.all([
      arm(root, 'vanilla', 'VANILLA ARTIFACT\n', scenario, rubric, source),
      arm(root, 'raven', 'RAVEN ARTIFACT\n', scenario, rubric, source),
    ])
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      scenarioId: 'general-writing',
      scenarioSha256: digest(scenario),
      rubricSha256: digest(rubric),
      order: ['vanilla', 'raven'],
      arms: {
        vanilla: { path: 'vanilla', artifactPath: 'artifact-process-1.md', artifactSha256: digest('VANILLA ARTIFACT\n') },
        raven: { path: 'raven', artifactPath: 'artifact-process-1.md', artifactSha256: digest('RAVEN ARTIFACT\n') },
      },
    }) + '\n')
    const catalog = JSON.parse(rawCatalog) as { facts: Array<{ id: string }> }
    catalog.facts = catalog.facts.filter(fact => fact.id !== 'reversal-condition')
    await writeFile(join(evaluationRoot, 'assessor-facts.json'), JSON.stringify(catalog) + '\n')

    await expect(prepareEvaluationReview(root, 'stable-seed', evaluationRoot)).rejects
      .toThrow('scenario general-writing requires missing assessor fact: reversal-condition')
    await expect(readFile(join(root, 'review', 'unblinding.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
