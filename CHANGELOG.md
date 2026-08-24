# Changelog

All notable changes to `dsh-raven-research` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
DeepSeek Harness it targets is itself an RC, a Harness pin change is treated as a
breaking change even when the Raven API is untouched: the package claims only the exact
tested compatibility family.

## [Unreleased]

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
  that is a deployment's own documented choice rather than an absent capability.
- **Every settings-reachable number now has an upper bound**, discovery fan-out is
  bounded, the whole verification pass carries a budget, and `sourceCheckTimeoutMs`
  defaults to 20 seconds instead of no deadline at all.
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
