import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  baseCandidates,
  baseCarriesRavenRow,
  baseChanged,
  baseNotFound,
  compose,
  composeLive,
  composeMetadata,
  describeSource,
  digestComposed,
  digestText,
  includePath,
  parseArguments,
  ravenRow,
  recordedBaseDigest,
} from '../../scripts/install-preset.js'

const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

/**
 * An absolute path on the platform the test is RUNNING on.
 *
 * Drive-letter fixtures like `Q:/checkout` are absolute on Windows and merely
 * relative on Linux, where `resolve()` then prefixes the working directory —
 * which is how a suite written on Windows passed locally and failed in CI with
 * `/home/runner/work/…/Q:/checkout/…`. The behaviour under test is base
 * RESOLUTION, not drive letters, so each fixture gets a root its own platform
 * agrees is absolute.
 * @param drive - the Windows drive letter this fixture used.
 * @param parts - path segments below it.
 * @returns an absolute path.
 */
function absolute(drive: string, ...parts: string[]): string {
  return process.platform === 'win32'
    ? join(`${drive}:\\`, ...parts)
    : join('/', drive.toLowerCase(), ...parts)
}
// The BUILT bin, which is what `dsh-raven-install-preset` runs. Spawning the
// TypeScript source through tsx instead would pay a compile per run, and several
// runs of that is slower than the work under test.
const installer = join(repoRoot, 'lib', 'install-preset.js')

/**
 * Run the installer as the bin does, with an isolated harness home.
 * @param argv - installer arguments.
 * @param env - environment overrides for this run.
 * @returns the exit code and the two streams.
 */
async function install(
  argv: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number, stdout: string, stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [installer, ...argv], {
      cwd: repoRoot,
      env: { ...process.env, DSH_CHECKOUT: '', ...env },
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number, stdout?: string, stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

/**
 * A minimal base preset directory, standing in for a deployment's own. Never the
 * real Harness checkout: this package is a PLUGIN of a deployment and its tests
 * write only into directories they created.
 * @param root - directory to create the preset under.
 * @param id - the base preset id.
 * @returns the base composition's text, as written.
 */
async function writeBase(root: string, id: string): Promise<string> {
  const text = [
    `# The '${id}' preset. A comment a YAML round-trip would destroy.`,
    '- id: persona',
    '  name: base-persona',
    '',
  ].join('\n')
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, 'agent.cordis.yml'), text)
  return text
}

/**
 * Read the generated live composition the way its CONTRACT reads: the include
 * row's path, and the patch list as `applyEntryPatches` destructures it.
 *
 * Hand-written rather than pulled from a YAML dependency this package does not
 * otherwise need. The file under test is one row this installer emits itself, so
 * the reader only has to understand that shape — and it reads the patch KEY,
 * which is the thing that decides whether the include takes its insert branch or
 * warns and skips the patch.
 * @param text - the generated `agent.cordis.yml`.
 * @returns the row ids, names, include path, patch keys and inserted rows.
 */
function readLive(text: string): {
  ids: string[]
  names: string[]
  path: string | undefined
  patchKeys: string[]
  inserted: Record<string, string>[]
} {
  const lines = text.split('\n').filter(line => !line.trimStart().startsWith('#'))
  const ids = lines.filter(line => line.startsWith('- id: ')).map(line => line.slice(6))
  const names = lines.filter(line => /^ {2}name: /.test(line)).map(line => line.slice(8))
  const path = lines.find(line => line.startsWith('    path: '))?.slice(10)
  // A patch-list item is '      - <key>:'; only 'insert' takes the insert branch.
  const patchKeys = lines
    .filter(line => /^ {6}- \\w+:$/.test(line))
    .map(line => line.trim().slice(2).replace(':', ''))
  const inserted: Record<string, string>[] = []
  for (const line of lines) {
    const start = /^ {10}- id: (.+)$/.exec(line)?.[1]
    if (start !== undefined) {
      inserted.push({ id: start })
      continue
    }
    const entry = inserted.at(-1)
    if (entry === undefined) continue
    const name = /^ {12}name: (.+)$/.exec(line)?.[1]
    const role = /^ {14}role: (.+)$/.exec(line)?.[1]
    if (name !== undefined) entry.name = name
    if (role !== undefined) entry.role = role
  }
  return { ids, names, path, patchKeys, inserted }
}

describe('installer arguments', () => {
  it('defaults the base to code, because Raven assumes run_code', () => {
    // The Code Mode durability seam records a Task step taken from inside a
    // `run_code` program. Under a base presenting no Code Mode it has nothing
    // to record, so `code` is the base this package is written against.
    expect(parseArguments([])).toEqual({
      base: 'code',
      baseRoots: [],
      force: false,
      dryRun: false,
      snapshot: false,
    })
  })

  it('reads --base, repeatable --base-root, --force, --dry-run and --snapshot', () => {
    const parsed = parseArguments([
      '--base', 'standard',
      '--base-root', 'a',
      '--base-root', 'b',
      '--force',
      '--dry-run',
      '--snapshot',
    ])
    expect(parsed.base).toBe('standard')
    expect(parsed.baseRoots).toHaveLength(2)
    expect(parsed.force).toBe(true)
    expect(parsed.dryRun).toBe(true)
    expect(parsed.snapshot).toBe(true)
  })

  it('has no flag that would modify anything outside this package', () => {
    // Raven is a PLUGIN of a deployment. --protect-base once set the read-only
    // bit on the deployment's own preset file; it was removed, and no argument
    // may quietly reintroduce a write to the Harness.
    const parsed = parseArguments(['--protect-base']) as Record<string, unknown>
    expect(parsed.protectBase).toBeUndefined()
    expect(Object.keys(parsed).toSorted()).toEqual(['base', 'baseRoots', 'dryRun', 'force', 'snapshot'])
  })
})

describe('base resolution', () => {
  it('looks in the user preset root, then each --base-root, then the checkout', () => {
    process.env.DSH_CHECKOUT = absolute('Q', 'checkout')
    try {
      const candidates = baseCandidates('code', [absolute('X', 'roots')], absolute('Y', '.agent-presets'))
      expect(candidates).toHaveLength(3)
      expect(candidates[0]).toBe(join(absolute('Y', '.agent-presets'), 'code'))
      expect(candidates[1]).toBe(join(absolute('X', 'roots'), 'code'))
      expect(candidates[2]).toBe(join(absolute('Q', 'checkout'), 'apps', 'cli', 'config', 'agent-presets', 'code'))
    } finally {
      delete process.env.DSH_CHECKOUT
    }
  })

  it('omits the checkout candidate when DSH_CHECKOUT is unset', () => {
    delete process.env.DSH_CHECKOUT
    expect(baseCandidates('code', [], absolute('Y', '.agent-presets'))).toHaveLength(1)
  })

  it('names every location tried when nothing carries the base', () => {
    const message = baseNotFound('code', [absolute('A', 'code'), absolute('B', 'code')]).join('\n')
    // The operator is the only one who knows where this deployment keeps its
    // presets, so the failure has to be actionable rather than merely true.
    expect(message).toContain('base preset "code" not found')
    expect(message).toContain(join(absolute('A', 'code'), 'agent.cordis.yml'))
    expect(message).toContain(join(absolute('B', 'code'), 'agent.cordis.yml'))
    expect(message).toContain('--base-root')
    expect(message).toContain('config/agent-presets')
  })
})

describe('include path', () => {
  it('is a file:// URL, because a bare Windows path parses as a URL scheme', () => {
    // The include resolves `path` with new URL(path, baseUrl) then fileURLToPath.
    // 'Q:\\x\\y.yml' is not relative-resolved: 'Q:' IS the scheme, so the result is
    // 'q:\\x\\y.yml' and fileURLToPath throws ERR_INVALID_URL_SCHEME.
    const windows = join('Q:', 'presets', 'code', 'agent.cordis.yml')
    expect(includePath(windows)).toBe(pathToFileURL(windows).href)
    expect(includePath(windows).startsWith('file:///')).toBe(true)
  })

  it('survives the include\'s own resolution', () => {
    const file = absolute('Q', 'presets', 'code', 'agent.cordis.yml')
    const baseUrl = pathToFileURL(absolute('Q', 'home', '.agent-presets', 'raven', 'agent.cordis.yml')).href
    // What the include does, in the order it does it.
    expect(fileURLToPath(new URL(includePath(file), baseUrl))).toBe(file)
  })

  // Windows only, because the failure IS the drive letter: `Q:` is a valid URL
  // scheme, so `new URL` hands `fileURLToPath` a `q:` URL instead of resolving
  // the path relative to the base. On POSIX the same string is an ordinary
  // relative path and there is nothing to assert.
  it.skipIf(process.platform !== 'win32')('rejects a bare drive-letter path', () => {
    const windows = join('Q:', 'presets', 'code', 'agent.cordis.yml')
    const baseUrl = pathToFileURL(join('Q:', 'home', '.agent-presets', 'raven', 'agent.cordis.yml')).href
    expect(() => fileURLToPath(new URL(windows, baseUrl))).toThrow(/scheme/i)
  })

  it('round-trips a path containing spaces', () => {
    const spaced = absolute('Q', 'my presets', 'code', 'agent.cordis.yml')
    const baseUrl = pathToFileURL(absolute('Q', 'home', 'raven', 'agent.cordis.yml')).href
    expect(fileURLToPath(new URL(includePath(spaced), baseUrl))).toBe(spaced)
  })
})

describe('live composition', () => {
  const file = join('C:', 'presets', 'code', 'agent.cordis.yml')
  const baseText = ['# a base comment', '- id: persona', '  name: base-persona', ''].join('\n')
  const live = composeLive('code', file, baseText, ravenRow())

  it('mounts the include and Raven as SIBLING rows, in that order', () => {
    const parsed = readLive(live)
    // Order matters for reading and for prompt assembly: the base first, Raven
    // after it, which is also what the snapshot mode produces.
    expect(parsed.ids).toEqual(['inherited-code', 'raven-research'])
    expect(parsed.names).toEqual(['cordis:include', 'dsh-raven-research'])
    expect(parsed.path).toBe(pathToFileURL(file).href)
  })

  it('puts Raven in NO patch list, because a patched-in row truncates the base', () => {
    const parsed = readLive(live)
    // `Include` rebases its child tree onto the included file's directory, so a
    // row inserted through `patches` resolves `dsh-raven-research` from inside the
    // Harness install, fails to apply, and the failing tree is written back as
    // `[]`. Reproduced side by side over a copy of a real 13605-byte base: the
    // patched shape left 3 bytes, this shape left 13605.
    expect(parsed.patchKeys).toEqual([])
    expect(live).not.toContain('patches:')
  })

  it('copies no base text, but records the base digest for DETECTION', () => {
    expect(live).not.toContain('- id: persona')
    expect(live).not.toContain('# a base comment')
    // Recorded so a later run can tell an upgrade from a base that was written
    // into — not so anything can be re-synced; the include reads it live.
    expect(recordedBaseDigest(live)).toBe(digestText(baseText))
    expect(live).toContain('NOT a snapshot')
  })

  it('records no read-only claim, because this installer touches nothing', () => {
    expect(live).not.toContain('read-only')
    expect(live).not.toContain('protect-base')
  })

  it('describes the relationship differently in each mode', () => {
    expect(describeSource(false, 'code', file)).toContain('LIVE')
    expect(describeSource(true, 'code', file)).toContain('SNAPSHOT')
  })
})

describe('base-change detection', () => {
  const file = join('C:', 'presets', 'code', 'agent.cordis.yml')

  it('recognises a base that carries Raven\'s row, and an ordinary one', () => {
    expect(baseCarriesRavenRow('- id: persona\n  name: base-persona\n')).toBe(false)
    expect(baseCarriesRavenRow('- id: persona\n- id: raven-research\n')).toBe(true)
    expect(baseCarriesRavenRow('- id: persona\n  name: dsh-raven-research\n')).toBe(true)
    // A mention in prose is not a row.
    expect(baseCarriesRavenRow('# see dsh-raven-research for details\n')).toBe(false)
  })

  it('ships secure bounded Source defaults in every newly generated Raven row', () => {
    expect(ravenRow()).toMatchObject({
      config: {
        sourceNetworkPolicy: 'public-only',
        sourceCheckTimeoutMs: 20_000,
      },
    })
  })

  it('reports an ordinary upgrade as expected and needing nothing, under live', () => {
    const report = baseChanged(file, '- id: persona\n- id: extra\n', true)
    expect(report.warning).toBe(false)
    const message = report.lines.join('\n')
    expect(message).toContain('expected after a Harness upgrade')
    expect(message).toContain('nothing needs doing')
    expect(message).toContain('inherits the base LIVE')
  })

  it('tells a snapshot install it did NOT pick the change up', () => {
    const report = baseChanged(file, '- id: persona\n- id: extra\n', false)
    expect(report.warning).toBe(false)
    expect(report.lines.join('\n')).toContain('--snapshot --force')
  })

  it('warns, naming the file, when the base now contains Raven\'s row', () => {
    const report = baseChanged(file, '- id: persona\n- id: raven-research\n', true)
    expect(report.warning).toBe(true)
    const message = report.lines.join('\n')
    expect(message).toContain(file)
    expect(message).toContain('never writes that file')
    expect(message).toContain('Restore that file from your Harness')
  })
})

describe('snapshot composition', () => {
  const baseText = ['# a base comment', '- id: persona', '  name: base-persona', ''].join('\n')
  const rowText = ['- id: raven-research', '  name: dsh-raven-research', '  config:', '    role: agent', ''].join('\n')
  const composed = compose('code', join('C:', 'presets', 'code', 'agent.cordis.yml'), baseText, rowText)

  it('keeps the base text verbatim, comments included', () => {
    // Concatenation, not a parse: re-serialising the base would throw away the
    // comments that are most of what a Harness preset teaches.
    expect(composed).toContain('# a base comment')
    expect(composed).toContain('- id: persona')
  })

  it("appends Raven's row after the base rows", () => {
    expect(composed.indexOf('- id: raven-research')).toBeGreaterThan(composed.indexOf('- id: persona'))
    expect(composed).toContain('role: agent')
  })

  it('mounts no cordis:include row, because it took a copy instead', () => {
    expect(composed.match(/^ {2}name: cordis:include$/gm)).toBeNull()
  })

  it('records the base id, its source path and a digest of its bytes', () => {
    expect(composed).toContain('# base preset: code')
    expect(composed).toContain('# base source: C:/presets/code/agent.cordis.yml')
    expect(recordedBaseDigest(composed)).toBe(digestText(baseText))
  })

  it('names the base in the installed roster description, on that line', () => {
    const metadata = composeMetadata('name: Raven\ndescription: 深度研究。\n', 'code')
    // The suffix lands on the description LINE, not merely somewhere in the file.
    expect(metadata).toContain('description: 深度研究。（组合自 code 基础 preset）')
    expect(metadata).toContain('name: Raven')
    // Idempotent: a second pass must not append the suffix twice.
    expect(composeMetadata(metadata, 'code')).toBe(metadata)
  })

  it('digests the COMPOSED result, so a changed base is not up to date', () => {
    const other = compose('code', 'x', `${baseText}# changed\n`, rowText)
    expect(digestComposed(composed, 'm')).not.toBe(digestComposed(other, 'm'))
  })
})

describe('installer end to end', () => {
  it('fails, naming every location tried, when no base is found', async () => {
    const home = await mkdtemp(join(tmpdir(), 'raven-home-'))
    const result = await install([], { DSH_HOME: home })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('base preset "code" not found')
    expect(result.stderr).toContain(join(home, '.agent-presets', 'code', 'agent.cordis.yml'))
    expect(result.stderr).toContain('--base-root')
  })

  it('installs a live include over a WRITABLE base, and leaves it untouched', async () => {
    const home = await mkdtemp(join(tmpdir(), 'raven-home-'))
    const roots = await mkdtemp(join(tmpdir(), 'raven-base-'))
    const baseText = await writeBase(roots, 'code')
    const base = join(roots, 'code', 'agent.cordis.yml')
    const before = await stat(base)
    const installed = join(home, '.agent-presets', 'raven', 'agent.cordis.yml')

    const first = await install(['--base-root', roots], { DSH_HOME: home })
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('LIVE')

    // The deployment's own file is untouched: same bytes, same mode. This
    // installer is a plugin's installer and writes nothing outside its preset.
    expect(await readFile(base, 'utf8')).toBe(baseText)
    const after = await stat(base)
    expect(after.mode).toBe(before.mode)
    expect(after.size).toBe(before.size)

    const parsed = readLive(await readFile(installed, 'utf8'))
    expect(parsed.names).toEqual(['cordis:include', 'dsh-raven-research'])
    expect(parsed.path).toBe(pathToFileURL(base).href)
    // No patch list at all: a row inserted through `patches` resolves from the
    // included file's directory, fails, and the failing tree truncates that file.
    expect(parsed.patchKeys).toEqual([])

    // Idempotent: the common re-run after an upgrade that changed nothing.
    const second = await install(['--base-root', roots], { DSH_HOME: home })
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('already up to date')
  }, 30000)

  it('reports a changed base as expected, and keeps the mode up to date', async () => {
    const home = await mkdtemp(join(tmpdir(), 'raven-home-'))
    const roots = await mkdtemp(join(tmpdir(), 'raven-base-'))
    await writeBase(roots, 'code')
    const base = join(roots, 'code', 'agent.cordis.yml')
    await install(['--base-root', roots], { DSH_HOME: home })

    // A Harness upgrade: the base moved on. Live inheritance already has it, so
    // the mode is STILL up to date and the report is informational.
    await writeFile(base, '- id: persona\n  name: base-persona\n- id: extra\n  name: extra-row\n')
    const upgraded = await install(['--base-root', roots], { DSH_HOME: home })
    expect(upgraded.code).toBe(0)
    expect(upgraded.stdout).toContain('expected after a Harness upgrade')
    expect(upgraded.stdout).toContain('nothing needs doing')
    expect(upgraded.stdout).toContain('already up to date')
    expect(upgraded.stderr).toBe('')
  }, 30000)

  it('warns when the base has been written into with Raven\'s row', async () => {
    const home = await mkdtemp(join(tmpdir(), 'raven-home-'))
    const roots = await mkdtemp(join(tmpdir(), 'raven-base-'))
    await writeBase(roots, 'code')
    const base = join(roots, 'code', 'agent.cordis.yml')
    await install(['--base-root', roots], { DSH_HOME: home })

    // The failure detection exists for: a PATCHED composition written back over
    // the deployment's preset. This installer cannot cause it and says so.
    await writeFile(base, '- id: persona\n  name: base-persona\n- id: raven-research\n  name: dsh-raven-research\n')
    const damaged = await install(['--base-root', roots], { DSH_HOME: home })
    expect(damaged.stderr).toContain('WARNING')
    expect(damaged.stderr).toContain(base)
    expect(damaged.stderr).toContain('never writes that file')
    expect(damaged.stderr).toContain('Restore that file from your Harness')
  }, 30000)

  it('warns on a FIRST install against an already-damaged base', async () => {
    const home = await mkdtemp(join(tmpdir(), 'raven-home-'))
    const roots = await mkdtemp(join(tmpdir(), 'raven-base-'))
    const baseText = await writeBase(roots, 'code')
    const base = join(roots, 'code', 'agent.cordis.yml')
    // Damage that predates any install: there is no recorded digest to compare
    // against, so a check gated on a digest MISMATCH would stay silent here —
    // which is exactly the run where an operator most needs to be told.
    await writeFile(base, `${baseText}- id: raven-research\n  name: dsh-raven-research\n`)

    const first = await install(['--base-root', roots], { DSH_HOME: home })
    expect(first.code).toBe(0)
    expect(first.stderr).toContain('WARNING')
    expect(first.stderr).toContain(base)
    expect(first.stderr).toContain('never writes that file')

    // And it keeps warning once the digest has been recorded and refreshed: a
    // damaged base is damage on every run, not once.
    const second = await install(['--base-root', roots], { DSH_HOME: home })
    expect(second.stderr).toContain('WARNING')
  }, 30000)

  it('composes a copy under --snapshot, and --force re-syncs it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'raven-home-'))
    const roots = await mkdtemp(join(tmpdir(), 'raven-base-'))
    const baseText = await writeBase(roots, 'code')
    const installed = join(home, '.agent-presets', 'raven', 'agent.cordis.yml')

    const first = await install(['--base-root', roots, '--snapshot'], { DSH_HOME: home })
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('SNAPSHOT')
    const text = await readFile(installed, 'utf8')
    expect(text).toContain(baseText.trimEnd())
    expect(text).toContain('- id: raven-research')
    expect(text).toContain('role: agent')
    expect(text.match(/^ {2}name: cordis:include$/gm)).toBeNull()

    const second = await install(['--base-root', roots, '--snapshot'], { DSH_HOME: home })
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('already up to date')

    // A base that moved on: the snapshot did NOT pick it up, and says so.
    await writeFile(join(roots, 'code', 'agent.cordis.yml'), `${baseText}# a new base row\n`)
    const stale = await install(['--base-root', roots, '--snapshot'], { DSH_HOME: home })
    expect(stale.code).not.toBe(0)
    expect(stale.stdout + stale.stderr).toContain('did NOT pick the change up')
    expect(stale.stderr).toContain('--force')

    const forced = await install(['--base-root', roots, '--snapshot', '--force'], { DSH_HOME: home })
    expect(forced.code).toBe(0)
    expect(await readFile(installed, 'utf8')).toContain('# a new base row')
  }, 30000)

  it('changes nothing under --dry-run, in either mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'raven-home-'))
    const roots = await mkdtemp(join(tmpdir(), 'raven-base-'))
    const baseText = await writeBase(roots, 'code')
    const base = join(roots, 'code', 'agent.cordis.yml')

    const live = await install(['--base-root', roots, '--dry-run'], { DSH_HOME: home })
    expect(live.code).toBe(0)
    expect(live.stdout).toContain('would install')
    await expect(stat(join(home, '.agent-presets', 'raven'))).rejects.toThrow()
    expect(await readFile(base, 'utf8')).toBe(baseText)

    const snapshot = await install(['--base-root', roots, '--snapshot', '--dry-run'], { DSH_HOME: home })
    expect(snapshot.code).toBe(0)
    expect(snapshot.stdout).toContain('would install')
    await expect(stat(join(home, '.agent-presets', 'raven'))).rejects.toThrow()
  }, 30000)
})
