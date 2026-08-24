#!/usr/bin/env node
/**
 * Install the Raven agent preset into the user's preset root, making "Raven"
 * selectable as a MODE in the new-session UI.
 *
 * A mode is an agent preset directory — `preset.yml` plus `agent.cordis.yml` —
 * discovered by `@deepseek-ai/dsh-agent-presets`. That plugin scans its configured
 * roots and then, unless `includeUserRoot` is false, the harness-home user root
 * `$DSH_HOME/.agent-presets`. So installing a mode is exactly writing a directory
 * there.
 *
 * THIS INSTALLER NEVER TOUCHES THE HARNESS. Raven is a plugin OF a deployment, not
 * a co-owner of it. Every write this process makes lands inside
 * `$DSH_HOME/.agent-presets/raven` — no file outside that directory is written,
 * moved, renamed, or has an attribute changed, not even a permission bit. The
 * deployment's own presets are read and never modified.
 *
 * DEFAULT — LIVE INHERITANCE. The installed composition is a small file with TWO
 * top-level rows: a `cordis:include` whose `path` is the deployment's own base
 * preset composition, and Raven's row beside it. The include reads that file at
 * MOUNT time, so the mode inherits the base LIVE: a Harness upgrade that changes
 * the base preset changes this mode at the next mount, with nothing to re-sync and
 * no copy to go stale.
 *
 * Raven's row is a SIBLING of the include and must never move into the include's
 * `patches` list, because that difference destroys files. `Include` rebases its
 * child tree onto the directory of the file it included, so a patched-in row
 * resolves `dsh-raven-research` from inside the Harness install — where it is not
 * installed — the include fails to apply, and the failing tree is written back as
 * `[]`. A nested include is instantiated from the plain `Include`, not the
 * `PresetTree` subclass whose `write()` is a no-op, so nothing suppresses that
 * write.
 *
 * This is not a hypothesis. During development a deployment's shipped `code`
 * preset was found truncated from 13605 bytes to 3, and a side-by-side run over a
 * copy of that same base reproduced it exactly: the patched shape failed to mount
 * and left a 3-byte base, the sibling shape mounted and left the base at 13605.
 * An earlier test had appeared to clear the patched shape, and it was invalid —
 * the base it used was itself `[]`, so a truncating write produced a file
 * identical to the one it started with.
 *
 * What follows from that: a shape that can FAIL to apply is a shape that can
 * truncate someone else's file, so the guard is emitting a shape that resolves,
 * not asking for a permission bit on a file this package does not own. The
 * generated header still records the base's `sha256`, and every later run compares
 * it — separating an ordinary upgrade, which live inheritance has already picked
 * up and which needs no action, from a base whose content now contains Raven's own
 * row, which is reported as a warning naming the file and telling the operator to
 * restore it from their Harness install. Detection costs nothing and touches
 * nothing.
 *
 * SNAPSHOT — the fallback, `--snapshot`, for a deployment that would rather not
 * depend on a file outside this package. Composes a copy at install time: the base
 * composition's text verbatim followed by Raven's row, under the same digest
 * header, with `--force` as the re-sync path. Text, deliberately: parsing and
 * re-serialising the base would destroy the comments that are most of what a
 * Harness preset teaches. It pays the staleness the default avoids.
 *
 * Deliberately NOT a bundle patch, in either mode. A bundle can only replace a
 * row's whole config by id, so patching the `agent-presets` row would mean
 * restating its `default` and `roots` — a second copy that silently overrides the
 * base. This repository spent a day removing exactly that failure from its
 * Harness pin.
 *
 * Usage: `dsh-raven-install-preset [--base <id>] [--base-root <dir>]... [--snapshot] [--force] [--dry-run]`
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Preset id, and therefore the directory name under the user preset root. */
const PRESET_ID = 'raven'
/** The user preset root's name below the harness home, fixed by the Harness. */
const USER_PRESET_DIR = '.agent-presets'
/** The composition file every agent preset directory carries. */
const COMPOSITION_FILE = 'agent.cordis.yml'
/** The roster-metadata file every agent preset directory carries. */
const METADATA_FILE = 'preset.yml'
/** Default base preset id: Raven's prompt and Code Mode seam assume `run_code`. */
const DEFAULT_BASE = 'code'
/** The id of Raven's own row, and what identifies it inside another file. */
const ROW_ID = 'raven-research'
/** The plugin name Raven's row mounts. */
const ROW_NAME = 'dsh-raven-research'

/**
 * Print an error in this installer's voice and stop.
 * @param messages - message lines, each prefixed with `raven:`.
 * @returns never; the process exits with status 1.
 */
function fail(...messages: readonly string[]): never {
  for (const line of messages) console.error(`raven: ${line}`)
  process.exit(1)
}

/**
 * Resolve the harness home the same way the Harness does: `$DSH_HOME` when set
 * and non-blank, otherwise `~/.dsh`. An explicit deployment override lives in
 * that deployment's own config and is not visible from here.
 * @returns absolute harness home path.
 */
function harnessHome(): string {
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured)
  return join(homedir(), '.dsh')
}

/**
 * Locate the preset fragment this package ships.
 *
 * Resolved from this module rather than from `process.cwd()` so the installer
 * works identically run from a checkout and from `node_modules/.bin`.
 * @returns absolute path of the shipped `presets/raven` directory.
 */
function shippedPreset(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // Built to `lib/` and run from source `scripts/` both sit one level below the
  // package root, so one parent hop is correct for either.
  return join(here, '..', 'presets', PRESET_ID)
}

/**
 * Read the command line into the options this installer understands.
 *
 * `--base-root` repeats because a deployment may keep several preset roots and
 * an operator should not have to guess which one carries the base.
 * @param argv - arguments after the node executable and this script.
 * @returns the parsed options.
 */
export function parseArguments(argv: readonly string[]): {
  base: string
  baseRoots: string[]
  force: boolean
  dryRun: boolean
  snapshot: boolean
} {
  let base = DEFAULT_BASE
  const baseRoots: string[] = []
  let force = false
  let dryRun = false
  let snapshot = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--force') force = true
    else if (argument === '--dry-run') dryRun = true
    else if (argument === '--snapshot') snapshot = true
    else if (argument === '--base') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail('--base needs a preset id, e.g. --base code')
      base = value
      index += 1
    } else if (argument === '--base-root') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail('--base-root needs a directory')
      baseRoots.push(resolve(value))
      index += 1
    }
  }
  return { base, baseRoots, force, dryRun, snapshot }
}

/**
 * Content digest of a directory's files, keyed by relative path.
 *
 * Identity is the file set plus the bytes, so an installed copy is "unmodified"
 * only when it matches what this installer would write again. Timestamps are not
 * consulted: writing rewrites them, and comparing them would call every install
 * user-modified.
 * @param dir - directory to digest.
 * @returns hex digest, or undefined when the directory does not exist.
 */
async function digestDirectory(dir: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(dir, { recursive: true })
  } catch {
    return undefined
  }
  const hash = createHash('sha256')
  for (const entry of entries.toSorted()) {
    const target = join(dir, entry)
    if (!(await stat(target)).isFile()) continue
    const name = entry.replaceAll('\\', '/')
    hash.update(name)
    hash.update('\u0000')
    // The composition is normalised exactly as digestComposed normalises it, so
    // the two are comparable: a recorded base digest is detection state and not
    // installed identity. Every other file is hashed as raw bytes.
    hash.update(
      name === COMPOSITION_FILE
        ? Buffer.from(withoutBaseDigest(await readFile(target, 'utf8')))
        : await readFile(target),
    )
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

/**
 * Digest of one file's bytes, used to record and re-check the base.
 * @param bytes - the text to digest.
 * @returns hex digest.
 */
export function digestText(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Every directory a base preset id could live in, in resolution order: the user
 * preset root, then each `--base-root`, then the checkout's shipped preset
 * directory when `$DSH_CHECKOUT` names one.
 * @param base - the base preset id.
 * @param baseRoots - directories given with `--base-root`, in order.
 * @param root - the user preset root.
 * @returns candidate directories, in the order they are tried.
 */
export function baseCandidates(base: string, baseRoots: readonly string[], root: string): string[] {
  const candidates = [join(root, base), ...baseRoots.map(dir => join(dir, base))]
  const checkout = process.env.DSH_CHECKOUT
  if (checkout !== undefined && checkout.trim().length > 0) {
    candidates.push(join(resolve(checkout), 'apps', 'cli', 'config', 'agent-presets', base))
  }
  return candidates
}

/**
 * Find the base preset's composition, or fail naming every place tried.
 *
 * Never invents a composition: an absent base is an operator-fixable condition —
 * the deployment's `config/agent-presets` is somewhere this process cannot guess
 * — and writing a made-up agent instead would be worse than stopping.
 * @param base - the base preset id.
 * @param baseRoots - directories given with `--base-root`, in order.
 * @param root - the user preset root.
 * @returns the base directory, its composition path, and its text.
 */
async function resolveBase(
  base: string,
  baseRoots: readonly string[],
  root: string,
): Promise<{ dir: string, file: string, text: string }> {
  const candidates = baseCandidates(base, baseRoots, root)
  for (const dir of candidates) {
    const file = join(dir, COMPOSITION_FILE)
    try {
      return { dir, file, text: await readFile(file, 'utf8') }
    } catch {
      continue
    }
  }
  fail(...baseNotFound(base, candidates))
}

/**
 * The message printed when no candidate directory carries the base preset.
 *
 * Names every location tried, in order, because the operator is the only one
 * who knows where this deployment keeps `config/agent-presets`.
 * @param base - the base preset id that was not found.
 * @param candidates - the directories tried, in order.
 * @returns the message lines.
 */
export function baseNotFound(base: string, candidates: readonly string[]): string[] {
  return [
    `base preset "${base}" not found. A mode's composition is the WHOLE agent, so Raven`,
    'inherits one the deployment already has.',
    'Tried, in order:',
    ...candidates.map(dir => `  ${join(dir, COMPOSITION_FILE)}`),
    "Pass --base-root <dir> pointing at your deployment's config/agent-presets directory",
    '(or set DSH_CHECKOUT to a Harness checkout), and --base <id> to pick a different base.',
  ]
}

/**
 * The `path` an include row can actually resolve.
 *
 * The include resolves its `path` with `new URL(path, ctx.baseUrl)` and then
 * `fileURLToPath`. A bare Windows absolute path is not relative-resolved at all:
 * `Q:` parses as a URL SCHEME, so `new URL('Q:\\x\\y.yml', base)` yields
 * `q:\x\y.yml` and `fileURLToPath` rejects it with `ERR_INVALID_URL_SCHEME`. A
 * `file://` URL is both absolute and a legal input to both halves of that pair,
 * on every platform.
 * @param file - absolute path of the base composition.
 * @returns the value to write as the include's `path`.
 */
export function includePath(file: string): string {
  return pathToFileURL(file).href
}

/**
 * Raven's row as an object, the single thing this package contributes to the
 * base composition in either mode.
 * @returns the row.
 */
export function ravenRow(): Record<string, unknown> {
  return { id: ROW_ID, name: ROW_NAME, config: { role: 'agent' } }
}

/**
 * Serialise Raven's row as a TOP-LEVEL row of this preset, beside the include.
 *
 * Not an entry in the include's `patches` list, and the difference is destructive.
 * `Include` rebases its child tree onto the directory of the file it included, so a
 * patched-in row resolves `dsh-raven-research` from inside the Harness install rather
 * than from the profile that installed it, the include fails to apply, and the failing
 * tree is written back as `[]`. That is not a hypothetical: a 13605-byte shipped `code`
 * preset was found truncated to 3 bytes during development, and a side-by-side run
 * reproduced it — the patched shape failed and truncated its base, the sibling shape
 * mounted and left a real 13605-byte base intact.
 * @param row - the row object.
 * @returns the YAML lines, starting the top-level sequence item.
 */
function siblingRow(row: Record<string, unknown>): string[] {
  const lines: string[] = []
  let first = true
  for (const [key, value] of Object.entries(row)) {
    // The first key carries the sequence dash that starts this top-level row.
    const lead = first ? '- ' : '  '
    first = false
    if (value !== null && typeof value === 'object') {
      lines.push(`${lead}${key}:`)
      for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`    ${innerKey}: ${String(innerValue)}`)
      }
    } else {
      lines.push(`${lead}${key}: ${String(value)}`)
    }
  }
  return lines
}

/**
 * The live-inheritance `agent.cordis.yml`: a header explaining what it is, then one
 * `cordis:include` row mounting the base composition with Raven's row patched in.
 *
 * `patches` is the include's own documented patch semantics — an `insert` adds a row
 * to the included composition in memory without touching the file — so nothing
 * here is a copy of the base and nothing here goes stale.
 * @param base - the base preset id.
 * @param file - absolute path of the base composition being included.
 * @param baseText - the base composition's text, digested for later comparison.
 * @param row - Raven's row, as the object the patch inserts.
 * @returns the file to write.
 */
export function composeLive(
  base: string,
  file: string,
  baseText: string,
  row: Record<string, unknown>,
): string {
  return [
    '# GENERATED by dsh-raven-install-preset. Re-running it replaces this file.',
    '#',
    `# base preset: ${base}`,
    `# base source: ${file.replaceAll('\\', '/')}`,
    `# base digest: sha256:${digestText(baseText)}`,
    '#',
    '# This is NOT a snapshot. The cordis:include row below reads that base composition',
    '# at MOUNT time, so this mode inherits the base LIVE: a Harness upgrade that changes',
    '# the base preset changes this mode on the next mount, with nothing to re-sync.',
    '#',
    "# Raven's row is a SIBLING of that include, never an entry in its `patches` list,",
    '# and that is not a style choice. `Include` rebases its child tree onto the directory',
    '# of the file it included, so a patched-in row resolves `dsh-raven-research` from',
    '# inside your Harness install, where it is not installed, and the include fails to',
    '# apply. A failing include is then written back as `[]` — which is how a 13605-byte',
    '# shipped `code` preset became 3 bytes during development of this feature. A sibling',
    '# row stays in this preset tree, where bare names resolve from the profile that',
    '# installed the package, and a real base survives the mount intact.',
    '#',
    '# The digest above is recorded for DETECTION, not for re-syncing: re-running this',
    '# installer compares it and tells you whether the base merely moved on with a Harness',
    '# upgrade (which live inheritance already picked up) or whether it now contains',
    "# Raven's own row, which would mean something wrote a patched composition back into",
    '# your Harness install and it should be restored from there.',
    '#',
    '# The path is a file:// URL on purpose. The include resolves it with',
    '# new URL(path, baseUrl) then fileURLToPath, and a bare Windows path like',
    '# Q:\\... parses as a URL scheme and fails with ERR_INVALID_URL_SCHEME.',
    '',
    '- id: inherited-code',
    '  name: cordis:include',
    '  config:',
    `    path: ${includePath(file)}`,
    ...siblingRow(row),
    '',
  ].join('\n')
}

/**
 * The snapshot `agent.cordis.yml`: a generated header, the base composition's text
 * verbatim, then Raven's row.
 *
 * Concatenation, not a parse: the base's comments are most of what it teaches,
 * and re-serialising it would throw them away.
 * @param base - the base preset id.
 * @param file - absolute path the base text was read from.
 * @param baseText - the base composition's text, used unparsed.
 * @param rowText - Raven's own row.
 * @returns the file to write.
 */
export function compose(base: string, file: string, baseText: string, rowText: string): string {
  const header = [
    '# GENERATED by dsh-raven-install-preset --snapshot. Re-running it replaces this file.',
    '#',
    `# base preset: ${base}`,
    `# base source: ${file.replaceAll('\\', '/')}`,
    `# base digest: sha256:${digestText(baseText)}`,
    '#',
    "# Everything above Raven's row is that base preset's own text, verbatim. This",
    '# is a SNAPSHOT and does not track the base: when the base preset changes,',
    '# re-run `dsh-raven-install-preset --snapshot --force` to re-sync. Editing this',
    '# file makes the installer refuse to replace it until you pass --force.',
    '#',
    '# The DEFAULT install mode inherits the base LIVE instead, with no copy to go',
    '# stale; this snapshot exists for a deployment that would rather not depend on',
    '# a file outside this package.',
    '',
    '',
  ].join('\n')
  const body = baseText.endsWith('\n') ? baseText : `${baseText}\n`
  return `${header}${body}\n${rowText}`
}

/**
 * The composition with its recorded base digest blanked.
 *
 * That digest is DETECTION state, not installed identity. Under live inheritance
 * an upgraded base is expected and has already been inherited, so it must not
 * make an otherwise-identical install look modified and demand `--force`.
 * Normalising both sides of the comparison keeps "nothing needs doing" true in
 * the one case that matters, while the digest itself is still refreshed on disk.
 * @param text - an installed or composed `agent.cordis.yml`.
 * @returns the text with the digest line blanked.
 */
export function withoutBaseDigest(text: string): string {
  return text.replace(/^# base digest: sha256:[0-9a-f]{64}$/m, '# base digest: -')
}

/**
 * The base digest recorded in an installed composition, in either mode.
 * @param text - an installed `agent.cordis.yml`.
 * @returns the recorded hex digest, or undefined.
 */
export function recordedBaseDigest(text: string): string | undefined {
  return /^# base digest: sha256:([0-9a-f]{64})$/m.exec(text)?.[1]
}

/**
 * Whether a base composition's text contains Raven's own row.
 *
 * This is the signature of the one failure detection exists for: a patched
 * composition — base rows plus Raven's row — written back over the deployment's
 * own preset. A base that merely moved on with an upgrade does not contain it.
 * @param baseText - the base composition's current text.
 * @returns true when the base appears to carry Raven's row.
 */
export function baseCarriesRavenRow(baseText: string): boolean {
  return new RegExp(`^\\s*(?:-\\s*)?(?:id:\\s*${ROW_ID}|name:\\s*${ROW_NAME})\\s*$`, 'm').test(baseText)
}

/**
 * What a re-run should say about a base whose digest no longer matches.
 *
 * Two distinct conditions, because they call for opposite reactions. An ordinary
 * upgrade is EXPECTED and needs no action — live inheritance has already picked
 * it up. A base carrying Raven's row means something wrote a patched composition
 * into the Harness install, and only the operator can put that right.
 * @param file - the base composition path.
 * @param baseText - the base composition's current text.
 * @param live - whether the install inherits live rather than snapshotting.
 * @returns the message lines, and whether they are a warning.
 */
export function baseChanged(
  file: string,
  baseText: string,
  live: boolean,
): { warning: boolean, lines: string[] } {
  if (baseCarriesRavenRow(baseText)) {
    return {
      warning: true,
      lines: [
        `WARNING: the base composition now contains Raven's own row: ${file}`,
        'This installer never writes that file, so something else wrote a PATCHED composition',
        '— the base rows plus Raven\'s row — back over your Harness install.',
        'Restore that file from your Harness installation or checkout. Raven does not need it',
        'modified: the mode inherits the base by including it, and inserts its row in memory.',
      ],
    }
  }
  return {
    warning: false,
    lines: live
      ? [
          `base preset changed since this mode was installed: ${file}`,
          'That is expected after a Harness upgrade, and nothing needs doing: this mode',
          'inherits the base LIVE, so it already picked the change up.',
        ]
      : [
          `base preset changed since this snapshot was taken: ${file}`,
          'This mode is a --snapshot copy, so it did NOT pick the change up.',
          'Re-run with --snapshot --force to re-sync.',
        ],
  }
}

/**
 * The installed `preset.yml`: the shipped roster entry with the base it inherits
 * named in its description, so a person picking the mode — and an operator
 * reading the directory — can see what it was built on.
 * @param metadata - the shipped `preset.yml` text.
 * @param base - the base preset id.
 * @returns the file to write.
 */
export function composeMetadata(metadata: string, base: string): string {
  const suffix = `（组合自 ${base} 基础 preset）`
  return metadata.replace(/^description:.*$/m, line => (line.endsWith(suffix) ? line : `${line}${suffix}`))
}

/**
 * Digest what a run would write, in the same shape `digestDirectory` reads, so
 * "already up to date" compares the composed result rather than the shipped
 * fragment.
 * @param composition - the composed `agent.cordis.yml` text.
 * @param metadata - the composed `preset.yml` text.
 * @returns hex digest of the composed preset directory.
 */
export function digestComposed(composition: string, metadata: string): string {
  const hash = createHash('sha256')
  composition = withoutBaseDigest(composition)
  for (const [entry, text] of [
    [COMPOSITION_FILE, composition],
    [METADATA_FILE, metadata],
  ] as const) {
    hash.update(entry)
    hash.update('\u0000')
    hash.update(Buffer.from(text))
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

/**
 * The one line that tells an operator which relationship this install has with
 * the base: live inheritance, or a snapshot that can go stale.
 * @param snapshot - whether this run wrote a snapshot.
 * @param base - the base preset id.
 * @param file - the base composition path.
 * @returns the log line.
 */
export function describeSource(snapshot: boolean, base: string, file: string): string {
  return snapshot
    ? `raven: SNAPSHOT composed from base preset "${base}" at ${file} (re-sync with --snapshot --force)`
    : `raven: inheriting base preset "${base}" LIVE from ${file} (a Harness upgrade updates this mode)`
}

/**
 * Run the installer against the current process arguments and environment.
 * @returns nothing; every path either logs and returns or exits non-zero.
 */
async function main(): Promise<void> {
  const { base, baseRoots, force, dryRun, snapshot } = parseArguments(process.argv.slice(2))
  const source = shippedPreset()
  const root = join(harnessHome(), USER_PRESET_DIR)
  const destination = join(root, PRESET_ID)

  const fragment = await Promise.all([
    readFile(join(source, COMPOSITION_FILE), 'utf8'),
    readFile(join(source, METADATA_FILE), 'utf8'),
  ]).catch(() =>
    fail(
      `shipped preset fragment not found at ${source}`,
      'this installer must run from an installed package or a built checkout.',
    ),
  )

  const resolved = await resolveBase(base, baseRoots, root)

  const composition = snapshot
    ? compose(base, resolved.file, resolved.text, fragment[0])
    : composeLive(base, resolved.file, resolved.text, ravenRow())
  const metadata = composeMetadata(fragment[1], base)
  const installed = await digestDirectory(destination)

  // Detection, not prevention. Reads the previous install and the base; writes
  // and changes nothing outside this package's own preset directory.
  //
  // A base carrying Raven's own row is damage whatever the digest says, so it is
  // checked UNCONDITIONALLY — on a first install too, and even once a previous
  // run has refreshed the recorded digest past the tampering. Gating it on a
  // digest mismatch made the warning depend on the order runs happened in, which
  // is exactly when an operator would fail to be told.
  if (baseCarriesRavenRow(resolved.text)) {
    for (const line of baseChanged(resolved.file, resolved.text, true).lines) {
      console.error(`raven: ${line}`)
    }
  } else if (installed !== undefined) {
    const previous = await readFile(join(destination, COMPOSITION_FILE), 'utf8').catch(() => '')
    const recorded = recordedBaseDigest(previous)
    if (recorded !== undefined && recorded !== digestText(resolved.text)) {
      // Described against what THIS run installs, not what the previous install
      // was: a --snapshot run that told the operator the change was already
      // inherited LIVE would be advising them about a mode it is replacing.
      for (const line of baseChanged(resolved.file, resolved.text, !snapshot).lines) {
        console.log(`raven: ${line}`)
      }
    }
  }

  if (installed !== undefined && installed === digestComposed(composition, metadata)) {
    // Idempotent: the common re-run after an upgrade that changed nothing. The
    // installed file may still carry a stale base digest — identity ignores that
    // line on purpose — so refresh it in place, silently, keeping detection
    // accurate on the NEXT run without reporting the same upgrade forever.
    const current = await readFile(join(destination, COMPOSITION_FILE), 'utf8').catch(() => '')
    if (!dryRun && current !== '' && current !== composition) {
      await writeFile(join(destination, COMPOSITION_FILE), composition).catch(() => undefined)
    }
    console.log(`raven: preset already up to date at ${destination}`)
    console.log(describeSource(snapshot, base, resolved.file))
    return
  }

  if (installed !== undefined && !force) {
    console.error(`raven: ${destination} already exists and differs from what this run would write.`)
    console.error('raven: refusing to overwrite a modified copy. Re-run with --force to replace it.')
    process.exit(1)
  }

  if (dryRun) {
    console.log(`raven: would ${installed === undefined ? 'install' : 'replace'} the preset at ${destination}`)
    console.log(describeSource(snapshot, base, resolved.file))
    return
  }

  try {
    await mkdir(root, { recursive: true })
    // Replace rather than merge: a stale file left from an older version would
    // otherwise survive into a preset that no longer declares it.
    if (installed !== undefined) await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    await Promise.all([
      writeFile(join(destination, COMPOSITION_FILE), composition),
      writeFile(join(destination, METADATA_FILE), metadata),
    ])
  } catch (error) {
    fail(`failed to install the preset at ${destination}`, error instanceof Error ? error.message : String(error))
  }

  console.log(`raven: ${installed === undefined ? 'installed' : 'replaced'} the preset at ${destination}`)
  console.log(describeSource(snapshot, base, resolved.file))
  console.log('raven: select "Raven" as the mode when starting a new session.')
  console.log('raven: configure Raven in the `config:` block of that file\'s raven-research row.')
  console.log('raven: Raven is isolated to this mode; no other mode sees it, and there is no settings card')
  console.log('raven: unless you opt into the host row, which is global. See the Install section of the README.')
}

// Only the bin runs the installer. A test importing the pure helpers above must
// not install anything as a side effect of the import, so the entry point is
// compared against the module: `process.argv[1]` is this file when the bin runs
// it and something else when a test imports it.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
