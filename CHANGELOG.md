# Changelog

All notable changes to `dsh-raven-research` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
DeepSeek Harness it targets is itself a prerelease, a Harness pin change is treated as a
breaking change even when the Raven API is untouched: the package claims only the exact
tested compatibility family.

## [Unreleased]

### DeepSeek Harness 0.1.2-alpha.1 migration

#### Changed

- Retargeted the exact Harness compatibility pin to `0.1.2-alpha.1` at
  `cd5ef8148158c3a752a658978873241fdf8e2bbc`.
- Migrated Code Mode integrations to PTC while preserving the durable
  `tool/code-dispatch` session record used to read existing histories.
- Removed Raven's direct dependency on the deleted `dsh-client-runtime`; the
  client now consumes Cordis and the official slot observable face directly.
- Moved Raven prompt guidance after the target's PTC-only rule using the
  exported sparse order table rather than a copied numeric order.
- Changed the default inherited base preset from `code` to `ptc`, and discover
  shipped preset roots through `dsh-agent-presets` package manifests rather
  than a fixed Harness source-tree path.
- Made client bare-import handling generic, then validate emitted requests against the
  target module table; bundle identity and source resolution consume manifest/path-map
  authorities instead of duplicated lists.

The alpha Service Definition packages are not yet available from the configured
registry, so the published compile pins remain at `0.1.0-rc.6`; the exact target
source/runtime contract is covered by `test:dsh`. See the primary-source report
under `docs/reverse-engineering/deepseek-harness-v0.1.2-alpha.1-migration.md`.

### Progressive main-agent experience

#### Added

- `guidance: auto | off`, defaulting to `auto`. Auto gives the main agent one compact,
  context-sensitive policy for useful capability hints while suppressing tutorials,
  repetition, protocol details, and approval gates. Off removes optional hints without
  changing Task continuity, steering, stop/resume, verification, Completion, or export.
- Acceptance coverage for guidance before and during a Task, complete suppression in
  `off`, and the same progressive workflow through checkpoint, stop, resume, and Completion.

#### Changed

- The system prompt now explicitly keeps `raven_task` actions, Task ids, phases, revisions,
  and lifecycle vocabulary inside the main-agent protocol. Users interact in ordinary
  language; the README action table is an integrator reference, not a user workflow.
- Product and architecture docs now distinguish prompt-directed cadence from engine
  guarantees, detected-Team ownership from fallback single-Agent books, persisted snapshots
  from best-effort nested PTC mode logs, Task stopping from execution cancellation, and
  default mode isolation from the explicit global host-settings opt-in.
- Omitted legacy network-policy and Source-timeout settings retain their prior unrestricted/no-deadline
  behavior, while newly generated Raven presets explicitly choose `public-only` and 20 seconds.
- Continuing detected-Team books are no longer LRU eviction candidates; ordinary Agent and terminal-only
  Team books remain bounded, and the resident target becomes soft only when every excess book carries a
  continuing Team Task.
- `test:pack` now invokes the already-running pnpm CLI with version switching disabled, pins the transitive
  Harness peer graph to the same RC as the direct peers, and supports an explicit pre-populated store/cache
  for offline clean-consumer verification.

### Raven is now a selectable mode

`RavenConfig` gains `role: 'host' | 'agent' | 'both'`, and Raven ships as an agent
preset so it can be chosen as a **mode** in the new-session UI. Raven is now
ISOLATED to that mode: the package contributes nothing — no tool, no prompt
section, no settings card — until a session is started in Raven mode. See
[ADR 0006](./docs/adr/0006-raven-as-a-mode.md).

#### Added

- **The Raven mode, inheriting your deployment's own `code` preset LIVE.**
  `presets/raven/preset.yml` ships the roster entry; the composition is GENERATED. A
  preset's `agent.cordis.yml` is the whole agent — persona, tools, shell, compaction —
  so a one-row preset would boot an agent with no persona or shell, and a shipped copy
  of a Harness composition would drift silently inside this package. So the installed
  composition is a ~2 KB file of TWO TOP-LEVEL SIBLING ROWS: one `cordis:include` row
  whose `path` is the base composition, and Raven's own row beside it at the same
  level. The include reads that file at MOUNT time, so **a Harness upgrade changes what
  Raven mode inherits on the next session** — nothing to re-sync, no copy to go stale.
- **`dsh-raven-install-preset`, a shipped bin.** Writes
  `$DSH_HOME/.agent-presets/raven` (`$DSH_HOME` defaults to `~/.dsh`), the user preset
  root `@deepseek-ai/dsh-agent-presets` already scans. It resolves a base preset
  (`--base <id>`, default `code`) from `$DSH_HOME/.agent-presets`, each `--base-root`,
  then `$DSH_CHECKOUT`'s shipped presets, and **fails naming every location it tried**
  when it finds none. Idempotent in both modes, refuses to overwrite a differing copy
  without `--force`, and supports `--dry-run`. It deliberately is not a bundle patch of
  the `agent-presets` row: a patch replaces a row's whole config by id, so it would
  restate that row's `default` and `roots` as a silently overriding copy.
- **The installer never touches the Harness.** Raven is a plugin OF a deployment, not a
  co-owner of it: every write lands inside `$DSH_HOME/.agent-presets/raven`, and no file
  outside it is written, moved, renamed, or has an attribute changed — not one bit of a
  file mode. The installer contains no permission change and offers no flag that performs
  one. Its complete flag set is `--force`, `--dry-run`, `--snapshot`, `--base <id>` and
  `--base-root <dir>`.
- **The destructive-write hazard is REAL, and the sibling shape is the guard.**
  `Include` rebases its child tree onto the directory of the file it included, so a row
  inserted through the include's `patches` list resolves `dsh-raven-research` from inside
  the Harness install, where it is not installed. The include fails to apply and the
  failing tree is written back as `[]`. Nothing suppresses that write: a nested include is
  instantiated from the plain `Include`, not the `PresetTree` subclass whose `write()` is
  a no-op. **This truncated a real file** — a deployment's shipped `code` preset went from
  13605 bytes to 3. A side-by-side run over a copy of that base reproduced it exactly: the
  patched shape left a 3-byte base; the sibling shape mounted and left the base at 13605
  bytes, with host-only tools `[]`, roster `["raven"]` and a 1981-byte installed file. The
  guard is emitting a shape that RESOLVES, not a permission bit on a file this package does
  not own.
- **Detection as well, for a base something else wrote.** The generated
  header records the base file's `sha256`, and every later run compares it. A base that
  merely moved on is reported as **expected after a Harness upgrade, with nothing to do**
  because live inheritance already picked it up — and the run still exits zero as up to
  date, since the digest is detection state rather than installed identity. A base whose
  content now contains Raven's own row is a **warning** naming the file and telling the
  operator to restore it from their Harness install, because this installer cannot have
  written it. Detection costs nothing and touches nothing.
- **The include `path` is written as a `file://` URL.** The include resolves it with
  `new URL(path, ctx.baseUrl)` then `fileURLToPath`, and a bare Windows absolute path is
  not relative-resolved at all — in `Q:\…` the `Q:` parses as a URL *scheme*, so
  `fileURLToPath` rejects it with `ERR_INVALID_URL_SCHEME`. Covered by tests on
  Windows-shaped paths, including one containing spaces.
- **`--snapshot`, the fallback for a deployment that would rather not depend on a file
  outside this package.**
  Composes a copy at install time: the base's own text, verbatim so its comments
  survive, followed by exactly one `role: agent` row, under a generated header recording
  the base id, its source path, and a `sha256` digest of its bytes. `--snapshot --force`
  is its re-sync path. This is the previous default, demoted.
- **`role` in `RavenConfig`,** defaulting to `both`, so an existing out-of-tree row that
  names no role keeps working unchanged.
- **Raven's configuration in the preset row.** The row the installer inserts carries its
  own `config:` block — the same fields the settings card edited — so a deployment
  configures Raven where the mode is defined, in a file scoped to exactly the mode that
  mounts it. The shipped fragment lists every field; compatibility-sensitive network
  settings are explicit at safer new-install values, while legacy omission retains the
  compatibility defaults and remaining fields stay commented. With the
  card opted into, those values become the base layer `settings.yaml` overrides, exactly
  as before.

#### Changed

- **The bundled `cordis.patch.yml` host row now carries `role: host`,** registering only
  the settings namespace and the mount-time capability warning. The namespace is the one
  thing that genuinely needs a process-wide mount: served only inside a preset, its card
  would appear and vanish with a session using that preset.
- **`examples/agent-row.cordis.yml` now carries `role: agent`.** With the roles split,
  mounting both planes no longer registers `raven_task` twice.

#### Behaviour to know about

- **`raven_task` now exists only in Raven mode.** Other modes no longer see it; that is
  the point of the change, but it is a behaviour change for anyone relying on the tool
  being globally present.
- **There is no settings card by default, and that is the isolation trade.** A settings
  page is a GLOBAL surface: a card served from the host plane is visible from every mode,
  which is exactly what isolation forbids, and a card served from inside the preset would
  appear and vanish with a session. The two cannot both be had, so isolation was chosen
  and Raven's settings are edited in the preset row instead of in the UI. A deployment
  that would rather have the card mounts the host row itself as an explicit opt-in and
  accepts that Raven becomes visible from every mode's Settings. The mount-time
  capability warning rode that row and is gone by default with it.
- **A successfully detected Agent Team shares one in-memory Task book inside the Raven preset's standing mount.**
  The Harness mounts a preset once and every session joins it; Raven keys that shared
  instance by Agent or detected Team identity. Missing membership degrades to an independent
  Agent book, and persisted member histories fold into a rebuilt Team book as members are observed.
- **The mode now depends on a file OUTSIDE this package.** The installed composition
  names an absolute path into your `config/agent-presets`, so moving or deleting that
  base preset breaks the mode at mount time, where a copy would merely have gone stale.
  Nothing about that file is modified to make this work — it is read, never written.
- **Only `--snapshot` installs can go stale.** A Harness upgrade does not reach a
  snapshot copy, so `dsh-raven-install-preset --snapshot --force` remains its re-sync
  path. A default (live) install needs no re-sync at all.

### Evidence-integrity and durability hardening

This entry **does** change model-facing behaviour. Every item was reproduced before it
was fixed — most by executing the module rather than by reading it, and three against a
live Raven Task in a running deployment.

#### Fixed — durability

- **A Task could become permanently unrecoverable while the tool still reported it
  active.** The engine verified only *material* external Claims, so an external *context*
  Claim kept an unchecked Source; the codec then demanded a reachable Source for every
  external supported or qualified Claim and rejected the **entire snapshot**, which
  session replay silently skipped. The engine now verifies every external supported or
  qualified Claim regardless of importance, and the codec downgrades one unsupportable
  Claim to `deferred` instead of dropping the Task.
- **A failed Source check at `checkpoint` discarded the whole submitted contribution** —
  Sources, Claims, Limitations and Artifact alike. The refusal now retains the parsed
  evidence with its check results, so a dead link costs the check rather than the batch.
- **A refused Source can be repaired under its own ID.** With evidence retained, a
  `failed` or `unavailable` Source may be resubmitted with a corrected excerpt and
  returns to unchecked for re-verification, while a `reachable` one stays immutable.
  Without this, one mistyped excerpt made that URL permanently uncitable for the rest of
  the Task — the opposite of what Raven's own repair guidance instructs.
- **The 128-Checkpoint cap was a terminal deadlock**: `checkpoint` threw at the cap and
  `complete` still needed a slot. Checkpoints now trim like draft rounds, the first is
  always preserved, Completion always has a slot, and a trim is reported, not silent.
- **Concurrent Agent Team checkpoints lost a contribution and minted colliding Checkpoint
  ids.** Ids derive from the Task revision, and the book write is a compare-and-set: the
  losing call fails with its recovery action instead of overwriting a teammate's evidence.
- **Concurrent Team starts now derive Task identity from the Team book key.** Two members
  racing from an empty book mint the same Task id, so the existing first-write CAS admits
  exactly one instead of leaving two active Tasks in one Team book.
- **Durable Task snapshots have a 1,000,000-byte aggregate JSON budget.** Independent
  field caps can no longer multiply into a multi-megabyte snapshot, and results that do
  not advance Task revision persist only a compact pointer rather than the same state.
- **Limitation identity no longer depends on array position**, which had made legally
  constructed orderings undecodable, and `propagateSourceChecks` no longer throws at the
  Limitation cap on the completion path.

#### Fixed — evidence integrity

- **An unreadable page is no longer accused of fabrication.** A PDF, a script-only shell,
  or a near-empty extraction reports `unavailable` with extraction guidance; `failed` is
  reserved for prose Raven actually read that does not contain the excerpt.
- **HTTP conditions are classified rather than collapsed.** 404 and 410 remain evidence
  defects; 401, 403 and 407 report `unavailable`; 408, 425, 429 and 5xx report
  `unavailable` and retryable. One bounded retry with backoff covers transient conditions
  only, and a per-host throttle keeps Raven from earning the 429 it would then classify.
- **Source identity now treats HTTP→HTTPS as a one-way upgrade.** Same-host default-port
  upgrades pass, while HTTPS→HTTP downgrade, cross-host changes, and non-default port
  drift are refused.
- **Source fetches default to a public-network pre-flight filter.** Local/private targets
  and DNS names with any non-public answer are reported unavailable before delegation;
  the documented DNS-rebinding residual still requires provider-level network confinement.
- **Excerpt comparison no longer rejects legitimate quotations.** Both sides normalize to
  NFC, typographic quotes and dashes fold to ASCII, zero-width characters and soft hyphens
  are dropped, and the HTML entity table grew from six entries to about fifty. Case,
  accents and letters are deliberately never folded: a false accept is the dangerous
  direction.
- **Wiki export marks an unverified Source as unverified** instead of merely omitting its
  verification block, so an unchecked excerpt cannot harden into wiki fact.
- **Artifact citation validation skips fenced code, inline code, frontmatter and
  link-reference definitions**, and a registered URL now authorizes its own fragment and
  trailing slash.

#### Fixed — deployment safety

- **A grounded Task now fails at `start`, not after the research spend.** With no fetch
  provider composed, `research` and `academic-writing` are refused with the missing
  capability named and both escapes offered, and the mount warns through the logger.
  `sourceVerification: structural-only` still refuses at the Checkpoint instead, because
  that is a deployment's own documented choice rather than an absent capability. The
  pre-flight now also matches the Harness's configured, missing, unavailable, and
  ambiguous provider-selection rules.
- **The split host settings card now configures the agent-role runtime.** The agent mount
  reads the host namespace's raw user layer per call and applies it over its own preset
  entry, preserving mode-specific base values and the mount-time role.
- **Every settings-reachable number now has an upper bound**, discovery fan-out is
  bounded, the whole verification pass carries a budget, and `sourceCheckTimeoutMs`
  is explicitly 20 seconds in shipped Raven presets while omitted legacy configuration remains unbounded.
- **A malformed `draftRoutes` entry is refused by the schema** and skipped entries are
  reported, so an all-typo list no longer reads as an empty one.
- **Credential-bearing Lead URLs are redacted**, default ports no longer read as host
  drift, a double mount is detected and warned, and the settings card stops publishing
  once disposed.

#### Added — tests

- A codec round-trip property test that drives the real engine and feeds every emitted
  state back through `decodeRavenTaskState`, plus decode-rejection tests mutation-tested
  against nine disabled codec checks.
- Cap boundary tests for Sources, Claims, Checkpoints and Limitations.
- 25 retrieval tests covering the check taxonomy, the retry, and ten normalization cases,
  each verified red without the fix.
- The settings card and its controller are now rendered and driven in tests rather than
  covered only through their pure state projection.

### Release-readiness hardening

This entry covers the first pass that made the repository releasable rather than merely
correct. Nothing in **this** entry changed model-facing behaviour: `raven_task`, its actions, the Task engine,
and the settings namespace are all untouched.

#### Changed

- **The Harness pin now has one source of truth.** `dshRaven.harnessVersion` and
  `dshRaven.harnessCommit` in `package.json` are the only copy;
  `scripts/verify-dsh.ts` reads them instead of restating them. The two copies had
  already drifted apart from the reachable checkout, and because they agreed with each
  other the release gate reported a healthy pin while naming a commit nobody could
  produce.
- **The pin was retargeted to DeepSeek Harness `0.1.1-rc.2`**
  (`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`), from `0.1.1-rc.1`
  (`528c682e061696f5a160f363f236ecbf53cbd006`), so `pnpm run test:dsh` can actually
  be run against a checkout that exists.
- **`scripts/verify-dsh.ts` failure messages are now operator-actionable.** A version,
  commit, or dirty-tree mismatch names both observed values, the checkout path, and the
  two legitimate repairs (move the checkout, or retarget the pin) instead of asserting
  that something "does not match".

#### Added

- **`test:pack` runs in CI** as its own job. Previously CI ran only `check`, so the two
  gates that would have caught the pin drift — `test:pack` and `test:dsh` — never ran
  anywhere automatic.
- **A release workflow** (`.github/workflows/release.yml`): tag-driven, running the full
  gate, publishing to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements),
  and refusing to publish when the tag disagrees with `package.json`, when the Harness
  pin is absent or malformed, or when the gate leaves the working tree dirty. Manual runs
  default to a dry run.
- **Dependabot configuration** (`.github/dependabot.yml`) scoped so it can never bump the
  pinned `@deepseek-ai/*` packages: an automated bump there would move the compiled seam
  without touching `dshRaven`, leaving the pin claiming a compatibility that no longer
  held while every gate stayed green.
- **`SECURITY.md`** and **`CONTRIBUTING.md`**, including the documented local release
  procedure for `test:dsh` — the one gate that cannot run in CI because it needs a
  Harness checkout at the pinned commit.
- **This changelog.**
- **Operational documentation in `README.md` and `README.zh.md`**: prerequisites (a
  composed `web` capability is required for `research` and `academic-writing`, and
  discovery additionally needs the search provider's credential), what a draft round and
  verification actually cost, what data leaves the machine, the per-Task caps and what
  happens at each, and a troubleshooting table of the refusals a user will actually hit.
- **Rationale for the wildcard `peerDependencies`** where they are declared and in the
  README, together with what the `dshRaven` pin metadata is for.

#### Notes

- The `@deepseek-ai/*` **devDependency** versions (`0.1.0-rc.6`) were deliberately NOT
  changed. Those are the published Service Definition packages, which legitimately lag
  the Harness release; the pin above targets the Harness itself. See the README section
  on the pin for why the two numbers differ and why that is not drift.

[Unreleased]: https://github.com/wxxb789/dsh-raven-research/compare/main...HEAD
