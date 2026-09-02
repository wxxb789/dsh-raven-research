import { randomUUID } from 'node:crypto'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { assertEvidenceContainsNoSecrets, evaluationBasePreset, treeDigest } from '../../scripts/live-evaluation.js'

const roots: string[] = []

async function temporaryRoot(label: string): Promise<string> {
  const root = resolve('.tmp', 'evaluation-security-tests', `${label}-${randomUUID()}`)
  roots.push(root)
  await mkdir(root, { recursive: true })
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('live evaluation evidence admission', () => {
  it('removes scoped host tools before the runtime allowlist is applied', async () => {
    const root = await temporaryRoot('preset')
    const preset = resolve(root, 'ptc.yml')
    await writeFile(preset, [
      '# ── shell ',
      "- id: tool-pwsh\n  name: '@deepseek-ai/dsh-tool-pwsh'",
      '# ── filesystem ',
      "- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'",
      '# ── background jobs ',
      "- id: tool-jobs\n  name: '@deepseek-ai/dsh-tool-jobs'",
      '# ── compaction ',
      '- id: compaction',
      '# ── delegation and workflows ',
      "- id: tool-subagent\n  name: '@deepseek-ai/dsh-tool-subagent'",
      '# ── remaining model-facing rows ',
      "- id: tool-ask-user\n  name: '@deepseek-ai/dsh-tool-ask-user'",
      '# The `web` service',
      "- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'",
      '- id: tool-presentation',
    ].join('\n'))

    const restricted = await evaluationBasePreset(preset)
    expect(restricted).not.toContain('tool-pwsh')
    expect(restricted).not.toContain('tool-fs')
    expect(restricted).not.toContain('tool-jobs')
    expect(restricted).not.toContain('tool-subagent')
    expect(restricted).not.toContain('tool-ask-user')
    expect(restricted).toContain('tool-web')
    expect(restricted).toContain('tool-presentation')
  })

  it('rejects symlinks from digests and upload scans', async () => {
    const root = await temporaryRoot('symlink')
    const target = await temporaryRoot('target')
    await writeFile(resolve(target, 'evidence.txt'), 'ordinary evidence\n')
    await symlink(target, resolve(root, 'linked'), 'junction')

    await expect(treeDigest(root)).rejects.toThrow('must not contain symlinks')
    await expect(assertEvidenceContainsNoSecrets(root, null)).rejects.toThrow('rejects symlinks')
  })

  it('finds a multiline YAML credential by exact bytes', async () => {
    const root = await temporaryRoot('multiline')
    const credentials = resolve(root, '..', `${randomUUID()}-credentials.yml`)
    roots.push(credentials)
    await writeFile(credentials, 'provider:\n  apiKey: |-\n    secret line one\n    secret line two\n')
    await writeFile(resolve(root, 'session.jsonl'), 'secret line one\nsecret line two\n')

    await expect(assertEvidenceContainsNoSecrets(root, credentials)).rejects.toThrow('secret scan failed')
  })

  it('finds an unquoted YAML credential before its inline comment', async () => {
    const root = await temporaryRoot('inline-comment')
    const credentials = resolve(root, '..', `${randomUUID()}-credentials.yml`)
    roots.push(credentials)
    await writeFile(credentials, 'provider:\n  apiKey: short-secret-value # managed credential\n')
    await writeFile(resolve(root, 'session.jsonl'), 'short-secret-value\n')

    await expect(assertEvidenceContainsNoSecrets(root, credentials)).rejects.toThrow('secret scan failed')
  })

  it('rejects unknown binary evidence before upload admission', async () => {
    const root = await temporaryRoot('binary')
    await writeFile(resolve(root, 'opaque.bin'), Buffer.from([1, 0, 2, 3]))

    await expect(assertEvidenceContainsNoSecrets(root, null)).rejects.toThrow('rejects non-text files')
  })
})
