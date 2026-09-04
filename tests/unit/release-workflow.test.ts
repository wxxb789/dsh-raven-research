import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const contributing = readFileSync(new URL('../../CONTRIBUTING.md', import.meta.url), 'utf8')
const gitignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8')

describe('release workflow compatibility gate', () => {
  it('runs deterministic evaluation integrity in pull-request CI', () => {
    expect(ci).toContain('name: Validate evaluation inputs')
    expect(ci).toContain('run: pnpm run eval -- check')
  })

  it('checks the exact pinned Harness before npm publish', () => {
    expect(workflow).toContain('compatibility:')
    expect(workflow).toContain('repository: deepseek-ai/deepseek-harness')
    expect(workflow).toContain('ref: ${{ steps.harness-pin.outputs.commit }}')
    expect(workflow).toContain('path: .harness-under-test')
    expect(workflow).toContain('pnpm --dir .harness-under-test install --frozen-lockfile')
    expect(workflow).toContain('DSH_CHECKOUT: ${{ github.workspace }}/.harness-under-test')
    expect(workflow).toContain('run: pnpm run test:dsh')
    expect(workflow).toContain('Smoke paired presets and process resume')
    expect(workflow).toContain('--scenario steering-checkpoint')
    expect(workflow).toContain('--fixture-model')
    expect(workflow).toMatch(/publish:[\s\S]*needs: \[gate, compatibility\]/)
    expect(workflow).not.toContain('pnpm run eval -- verify-baselines --production')
    expect(workflow).toContain('RAVEN_PACK_OUTPUT: ${{ github.workspace }}/.release/raven.tgz')
    expect(workflow).toContain('name: raven-release-tarball')
    expect(workflow).toContain('sha256sum --check raven.tgz.sha256')
    expect(workflow).toContain('npm publish raven.tgz --provenance --access public')
    expect(workflow).not.toContain('pnpm publish')
    expect(workflow).toContain("if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')")
  })

  it('keeps benchmark evidence private while preserving release ordering', () => {
    const release = contributing.slice(contributing.indexOf('## Releasing'))
    const finalized = release.indexOf('Finalize the release code, documentation, `package.json` version')
    const privateEvaluation = release.indexOf('Run the private evaluation suite')
    const gate = release.indexOf('pnpm run check:release')
    const tag = release.indexOf('Tag that same commit')

    expect(finalized).toBeGreaterThanOrEqual(0)
    expect(finalized).toBeLessThan(privateEvaluation)
    expect(privateEvaluation).toBeLessThan(gate)
    expect(gate).toBeLessThan(tag)
    expect(release).toContain('must remain private')
    expect(release).toContain('do not commit or upload')
    expect(gitignore).toContain('evaluation/results/')
    expect(gitignore).toContain('evaluation/baselines/production-*/')
    expect(existsSync(new URL('../../.github/workflows/evaluation.yml', import.meta.url))).toBe(false)
  })
})
