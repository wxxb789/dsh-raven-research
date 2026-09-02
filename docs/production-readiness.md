<!-- Generated 2026-08-23 from Raven Task rvn-5303a5d90dbb-1 (completed-with-limits). Detailed per-area audits: .tmp/audit/{engine,plugin,tests,release,docs}.md -->

# Raven (dsh-raven-research) — Production Readiness Assessment

> [!IMPORTANT]
> This is a historical audit record. Its opening verdict and findings describe the
> pre-fix build assessed on 2026-08-23; they are not the current product state. Read
> [Fix status](#fix-status) for the disposition of every finding, and re-run the release
> gates for the current checkout before making a deployment decision.

## Historical verdict for the assessed pre-fix build

At the time of this audit, Raven was ready for **supervised use** as a research and writing discipline layer and was **not ready for unattended production** as a source-grounded research system.
The obstacle was not code quality: the gate was green, the architecture was unusually disciplined, and there was not a single TODO or stub in `src/`.
The obstacle was that three load-bearing promises — Task replay, rejected-Checkpoint preservation, and truthful Source checks — were broken in reachable ordinary use and were reproduced live rather than inferred.
The assessed deployment also registered no usable web provider, so no Source could be verified and no grounded Task could complete there at that time. The finding dispositions below, not this historical paragraph, describe the current repository.

## Evidence base

The full gate was executed on this machine: `pnpm run check` (lint, typecheck, build, 167 tests in 19 files) passes green in about 4.5 seconds.
Raven is already installed in the live profile at `~/.dsh/profiles/web` as `dsh-raven-research-0.1.0.tgz`, composed through `dsh.profile.bundles`, so every finding below concerns the deployment actually in use.
This assessment is itself a Raven Task: `start`, `discover`, `checkpoint`, `status`, and a real Source verification were exercised live, and the resulting Task state was replayed through the real codec.
Three parallel audits covered the engine, the plugin seam, the tests, the release surface, and the documentation; the two deep audits reproduced their findings by executing the modules rather than by reading them.

## What is genuinely good

The verification model is sound where it is implemented: the verifier protocol response is validated strictly, so a forged verifier result cannot fabricate support, and no configuration field can lower the evidence floor for research or academic writing.
Failure reporting is honest rather than cosmetic — a discovery batch whose provider had no credential returned zero Leads, two named Limitations, and an explicit statement that a query that could not run is not evidence that nothing exists.
The advertised per-action field sets are rendered from the same allow-list the engine enforces, so the tool description cannot drift from the validator.
Prose Layout idempotence holds across every structural case tested, and Source records are immutable once registered.
The plugin makes zero direct network calls: all egress passes through the Harness `web` and `llm` seams, each structurally probed, so an offline deployment degrades to named unavailability instead of throwing.

## Blocking defects

**B1.
A Task can become permanently unrecoverable while the tool still reports it active — reproduced on this Task.** The engine verifies only *material* external Claims, so an external *context* Claim keeps an `unchecked` Source; the codec then requires a reachable Source for *every* external supported or qualified Claim and returns `undefined` for the entire snapshot, which session replay silently skips.
Decoding this assessment's own live Task state returned `false`; removing the single context Claim made the identical state decode `true`.
The Task was therefore already unrecoverable across a restart, no warning was issued, and the tool answered `status: active` throughout.
This is durable data loss from documented ordinary use, and the fix is small: align the codec with the engine's material-only rule, or drop the offending Claim instead of the whole snapshot.

**B2.
A failed Source check at Checkpoint discards the entire submitted contribution — reproduced on this Task.** The needs-revision path rebuilds from the *prior* state rather than from the parsed submission, so one unverifiable Source throws away every Source, Claim, Limitation, and Artifact byte in that call.
Submitting the refined nine-kilobyte Artifact of this very assessment returned `needs-revision` and stored nothing: the Checkpoint count stayed at one and the Artifact was lost, purely because a single cited Source could not be re-fetched.
The pre-fix architecture document promised the opposite — accepted work would survive rejection — so this was a contract violation in the assessed build, not a missing feature.

**B3.
The 128-Checkpoint cap is a terminal deadlock.** Checkpoint throws at the cap and Completion appends a final Checkpoint of its own, so a Task that reaches the cap can neither checkpoint nor complete, with no trimming, compaction, or escape.
The prompt mandates a Checkpoint per substantive edit, which is exactly the cadence that drives a long Task into it.

**B4.
Concurrent Team checkpoints lose updates and mint colliding identifiers.** The Team book is shared across agents but the write is unconditional last-writer-wins with no compare-and-set, and the previous state is read before an await-heavy verification.
Two members checkpointing concurrently both produced revision 2, one was silently discarded, and both minted the same Checkpoint id; equal revisions collide in replay too, so a restart does not repair it.

**B5.
The Source check taxonomy accuses honest work of fabrication.** Only a body the fetcher marked truncated is reported `unavailable`; every other unmatched body is `failed`, and the agent is told to treat a `failed` check as a possible fabricated quotation rather than an anchor repair.
A PDF, an SPA shell, or a paywalled page is complete but has no extractable prose, so precisely the primary sources research depends on most take the accusation branch, and the prompt then pushes the agent to weaken a correct quotation.
Any non-2xx/3xx response collapses the same way with an opaque `HTTP <code>` detail, so a transient 429 permanently defers good Claims — while the verifier loops every Source sequentially with no throttle and no retry, which is the shape that earns a 429.

**B6.
The retrieval prerequisites are undeclared, and none of them are met in this deployment.** Without a composed `web` fetch provider every Source is `unavailable`, a grounded Checkpoint is refused, and Completion is refused, while research and academic writing default to grounding `required` and cannot be lowered.
A live verification attempt in this profile returned `no usable web provider is registered`, and both live discovery queries failed with `DeepSeek search has no API key for DEEPSEEK_API_KEY`, so neither half of the retrieval seam is usable here.
Nothing in the bundle, the settings schema, or the install documentation names those dependencies, so the failure surfaces only at the first Checkpoint or Completion, after the research spend is already paid.

## Serious but not blocking

Excerpt normalization decodes HTML entities and collapses whitespace, but performs no Unicode NFC pass and no quote or dash folding, so curly quotes, en-dashes, NFD accents, soft hyphens, and zero-width characters false-reject legitimate excerpts.
That failure is especially costly because the mismatch report then shows a "nearest retrieved passage" that looks identical to the recorded one, and the agent is asked to repair something invisible.
The per-Source deadline defaults to 0 — no deadline — over a sequential loop, while every sibling timeout has a real default (search 30s, draft 120s).
Nothing retries on the retrieval path, and Checkpoint and Completion both re-verify, so a flaky origin makes Task outcomes non-deterministic.
`searchMaxQueries`, `searchMaxResults`, and `draftMaxTokens` are bounded below but not above and are editable from the browser settings card, which makes an unbounded concurrent fan-out reachable from the UI.
Errors are untyped prose strings, so terminal and retryable failures are indistinguishable to the caller, and a 300-character truncation can cut the verifier's own repair guidance mid-quotation.
Artifact URL validation scans the whole document without skipping fenced code, inline code, or frontmatter, so a research Artifact that quotes a configuration snippet containing a URL is refused.
Wiki export omits the verification frontmatter for an unchecked Source instead of declaring it unverified, so an unverified excerpt can reach the wiki looking like a verified one.
There is no `schemaVersion` migration path, so the first version bump drops every stored Task.

## Release engineering

Three Harness versions are in play at once: the manifest declares compatibility with `0.1.1-rc.2`, every Harness devDependency resolves to `0.1.0-rc.6` in the lockfile, and the Harness checkout on this machine is `0.1.1-rc.2`.
The compatibility gate asserts an exact version *and* an exact commit *and* a clean worktree, so `pnpm run test:dsh` cannot pass against the Harness actually installed here.
CI runs only `check`; `test:pack` and `test:dsh` are defined but never run, which is why the drift above survived a green pipeline.
There is no release workflow, no CHANGELOG, no publish dry-run, no provenance, and no dependency-update automation, so every publish is a manual local act.
All nine peer dependencies are `"*"`, which is right for sharing one cordis instance and gives no protection at all when a pre-1.0 RC changes a seam.

## Test coverage

The suite is fast because it is fully mocked, and no test exercises a real network path, so B5 and the normalization defects are invisible to it by construction.
Nothing tests the caps at their boundary, concurrent Team checkpoints, export idempotence, a cross-host redirect rejection, or a codec round-trip of an engine-produced state — which is exactly the seam B1 falls through.
The settings card is tested only through its pure state projection; the React component and its controller are never rendered.

## What to do, in order

**P0, before any unattended use.** Align the codec with the engine so no reachable state can be emitted that the codec rejects, and add a round-trip property test that feeds engine output straight back through `decodeRavenTaskState`.
Carry the parsed Sources, Claims, and Limitations into the needs-revision state so a failed check costs the check, not the contribution.
Make the Checkpoint cap survivable by trimming the oldest Checkpoint the way draft rounds already shift, and always reserve a slot for Completion.
Add a compare-and-set on `state.revision` before the book write, and derive Checkpoint ids from the revision rather than from a per-agent ordinal.

**P0 for this deployment specifically.** Compose a web fetch provider in the running profile and supply the search credential, or accept that every research and academic-writing Task will refuse to complete here.
Until then, Raven is usable in this profile only for general writing and learning Outcomes, where the evidence floor does not demand verified Sources.

**P1, before calling the research path production.** Rebuild the check taxonomy: reserve `failed` for a body that was retrieved and genuinely contradicts the excerpt, and map 401, 403, 408, 429, 5xx, and non-extractable bodies to `unavailable`.
Add one bounded retry with backoff, give `sourceCheckTimeoutMs` a real default, and throttle the sequential verification loop per host.
Normalize excerpts to NFC and fold quotes, dashes, and zero-width characters on both sides of the comparison.
Probe the `web` capability at composition time and refuse at `action=start` with a named prerequisite instead of failing at Completion.
Document the credential prerequisites, the multiplied cost of multi-route drafting, the data egress verification performs, and the on-disk footprint of export.

**P2, before publishing.** Reconcile the Harness pin, then run `check:release` in CI against the pinned checkout, and add a release workflow with a publish dry-run and provenance.
Put upper bounds on every settings-reachable numeric field.
Add the missing tests: cap boundaries, concurrent Team checkpoints, export idempotence, cross-host redirect, and at least one non-mocked retrieval test against a stable public page.
Give errors a typed code so a caller can distinguish terminal from retryable.

## Exit criteria

Raven is production-ready for research and writing when every state the engine can emit round-trips through the codec, when a failed check costs only that check, when a long Task can always complete, when a Team cannot lose a member's contribution, when an unreachable page is never reported as a possible fabrication, and when the deployment's retrieval prerequisites are checked at start rather than discovered at Completion.

## Limitations of this assessment

No Source could be verified at all, because this deployment registers no usable web provider; the one registered Source is therefore recorded as deferred rather than supported, and no finding here rests on verified external evidence.
Lead discovery could not be exercised, because the deployment's search provider has no credential.
The registry this repository pins in `.npmrc` — `registry.npmjs.org` — fails its TLS handshake from this machine, while the user-level Azure mirror resolves and installs normally, so the publication status of the Harness packages could not be checked against the public registry.
The packed-install gate is therefore runnable here after all, by passing the working user configuration through `RAVEN_PACK_USERCONFIG`, which the script already supports.
`pnpm run test:dsh` was retargeted onto the checkout available here and now passes, so the compatibility gate is evidence rather than an untested claim.
## Appendix — how each blocking defect was established

| ID | Method | Anchor |
| --- | --- | --- |
| B1 | Live Task state replayed through `decodeRavenTaskState`: `false` with the context Claim, `true` without it | `src/codec.ts:243-246` vs `src/engine.ts:456` |
| B2 | Live Checkpoint submission refused; Checkpoint count stayed at 1 and the Artifact was discarded | `src/engine.ts:1231-1243` |
| B3 | Read: checkpoint throws at the cap, complete refuses for want of a slot | `src/engine.ts:1200-1201`, `src/engine.ts:1305-1306` |
| B4 | Executed by audit: two concurrent members both produced revision 2, one discarded, ids collided | `src/plugin.ts:243`, `src/plugin.ts:953` |
| B5 | Read: only a truncated body maps to `unavailable`; every other miss is `failed` | `src/plugin.ts:689-708`, `src/plugin.ts:606` |
| B6 | Live verification returned "no usable web provider is registered"; both discovery queries failed on a missing key | `src/plugin.ts:666`, `src/engine.ts:1226`, `src/engine.ts:1332` |

The audit that produced B1–B4 reproduced them by executing the real modules under `tsx`, not by reading them; B5, B6, and the normalization findings were confirmed directly against the source and against this deployment.
---

# Findings Register

Every finding below was established by reading the code, by executing the module, or by running the tool live in the deployment.
The Method column says which.
Findings that an audit reported but that turned out to be fabricated are listed at the end and were not acted on.

## A — Task state machine (`engine.ts`, `codec.ts`, `domain.ts`, `wiki.ts`)

| ID | Sev | Finding | Anchor | Method |
| --- | --- | --- | --- | --- |
| A1 | CRITICAL | Engine emits states the codec rejects; a context-importance external Claim keeps an unchecked Source, the codec then rejects the whole snapshot, and replay silently drops the Task | `engine.ts:456` vs `codec.ts:243-246` | Live Task state replayed: `false`, `true` without the Claim |
| A2 | CRITICAL | A failed Source check at Checkpoint discards the entire submitted contribution — Sources, Claims, Limitations and Artifact | `engine.ts:1231-1243` | Live: a 13k Artifact and 7 Claims discarded by one unfetchable Source |
| A3 | CRITICAL | The 128-Checkpoint cap is terminal: checkpoint throws at the cap and complete needs a slot, so the Task can never finish | `engine.ts:1200-1201`, `engine.ts:1305-1306` | Read + executed |
| A4 | MAJOR | Checkpoint ids are per-Task ordinals, so concurrent Team members mint identical ids | `engine.ts` checkpoint minting | Executed: both members produced `-cp-1` |
| A5 | MAJOR | `propagateSourceChecks` throws mid-mutation at the Limitation cap on the completion failure path, losing the Claim deferrals computed in the same pass | `engine.ts:399-401`, `engine.ts:1357` | Read |
| A6 | MAJOR | Artifact citation validation scans the whole document for URLs without skipping code fences, inline code, frontmatter or link-reference definitions, and matches href-exactly so a fragment is unauthorized | `engine.ts:430`, `engine.ts:438` | Read; `prose.ts:239-269` already protects those regions |
| A7 | MAJOR | Wiki export omits the verification frontmatter for an unchecked Source instead of declaring it unverified, so an unverified excerpt reads as verified capture | `wiki.ts:92` | Read |
| A8 | MAJOR | Errors are untyped prose strings; terminal and retryable failures are indistinguishable to a caller | `engine.ts:194`, `engine.ts:278`, `engine.ts:570` | Read |
| A9 | MAJOR | `member()` produces the only unactionable error in the codebase and never names the accepted values | `engine.ts:170` | Read |
| A10 | MINOR | `limitationId` is positional on the engine side and positionally validated on the codec side, so legal orderings become undecodable — another silent path into A1 | `engine.ts:369` vs `codec.ts:262` | Read |
| A11 | MINOR | Duplicate-Limitation suppression is O(n²) and detail-exact, so near-identical verifier details accumulate toward the cap | `engine.ts:364` | Read |
| A12 | MINOR | `markdownText` HTML-escapes then backslash-escapes, rendering `&` as `&amp\;` | `engine.ts:744-750` | Read |
| A13 | MINOR | `slug()` truncates to 80 chars, so two similarly titled Sources collide on one raw page and the second overwrites the first | `wiki.ts:29-38`, `wiki.ts:218` | Read |
| A14 | MINOR | `schemaVersion` rejection is total, so the first schema bump drops every stored Task | `codec.ts:104` | Read |
| A15 | MINOR | `compactError` truncates to 300 chars, cutting the verifier's nearest-passage repair guidance mid-quotation | `engine.ts:485` vs `plugin.ts:608-613` | Read |
| A16 | MAJOR | Sources, Claims and Limitations caps are hard throws with no eviction and no partial accept; combined with A2 an over-cap batch also loses the Artifact | `engine.ts:277`, `engine.ts:340`, `engine.ts:376` | Executed |

## B — Retrieval seam and configuration (`plugin.ts`, `config.ts`, `url.ts`, `prompt.ts`)

| ID | Sev | Finding | Anchor | Method |
| --- | --- | --- | --- | --- |
| B1 | CRITICAL | Grounded Outcomes are uncompletable without a composed `web` fetch provider, and the dependency is declared nowhere — the failure arrives after the research spend | `plugin.ts:666`, `engine.ts:1226`, `engine.ts:1332` | Live: "no usable web provider is registered" |
| B2 | CRITICAL | A body that cannot be text-extracted (PDF, SPA shell, paywall) is labelled `failed`, and the agent is told to treat `failed` as a possible fabricated quotation | `plugin.ts:689-692`, `plugin.ts:606` | Read |
| B3 | CRITICAL | Every non-2xx/3xx response collapses to `failed` with an opaque `HTTP <code>`, permanently deferring good Claims on a transient 429 | `plugin.ts:678`, `plugin.ts:700`, `engine.ts:382` | Read |
| B4 | MAJOR | No retry anywhere on the retrieval path, while Checkpoint and Completion both re-verify, so a flaky origin makes outcomes non-deterministic | `plugin.ts:677` | Read |
| B5 | MAJOR | `sourceCheckTimeoutMs` defaults to 0 — no deadline — over a sequential loop, while every sibling timeout has a real default | `config.ts:59`, `plugin.ts:669` | Read |
| B6 | MAJOR | `searchMaxQueries`, `searchMaxResults` and `draftMaxTokens` are bounded below but not above and are editable from the settings card, over a fully concurrent fan-out | `config.ts:73-94`, `plugin.ts:406` | Read |
| B7 | MAJOR | Excerpt comparison performs no NFC normalization and no quote, dash or zero-width folding, so legitimate excerpts false-reject and the repair hint shows a passage that looks identical | `plugin.ts:549-551`, `plugin.ts:685` | Executed: curly quotes, en-dash, NFD, soft hyphen, zero-width all fail |
| B8 | MAJOR | The Team book write is unconditional last-writer-wins with no compare-and-set, and the prior state is read before an await-heavy verification | `plugin.ts:243`, `plugin.ts:953` | Executed: one member's Sources and Claims silently lost |
| B9 | MAJOR | A malformed `draftRoutes` entry is silently skipped, so an all-typo list is indistinguishable from an intentionally empty one | `plugin.ts:1063`, `config.ts:114` | Read |
| B10 | MAJOR | A credential-bearing Lead URL is stored and rendered raw, with the parse failure swallowed — Sources reject credentials, Leads do not | `plugin.ts:357`, `plugin.ts:295` vs `url.ts:17-19` | Read |
| B16 | MAJOR | The per-`apply()` Task book map is keyed per agent or team and never evicted, so a long-lived host process retains every session's full Task state, including Artifacts up to 100k characters | `plugin.ts:1029`, `plugin.ts:243-255` | Read |
| B17 | MINOR | `RavenCardController.dispose()` removes its subscriptions but does not fence an in-flight `commit()`, so a save that settles after disposal still calls `publish()` on a store nobody owns | `client/controller.ts:138-154`, `client/controller.ts:205-207` | Read |
| B11 | MINOR | Default and explicit ports are different identities, so a redirect that adds `:443` is rejected as host drift | `url.ts:3` | Read |
| B12 | MINOR | The HTML entity table covers six entities, so `&mdash;`, `&rsquo;`, `&hellip;` and friends pass through undecoded; the numeric branch can throw a RangeError reported as an unavailable Source | `plugin.ts:529-536`, `plugin.ts:540` | Read |
| B13 | MINOR | Discovery fans every query out concurrently with no throttle, and 429 Limitations dedupe by exact detail so they accumulate to the cap | `plugin.ts:406`, `engine.ts:945-946` | Read |
| B14 | MINOR | The documented double-mount hazard is undetectable at runtime: two mounts produce two tools and two independent Task books | `cordis.patch.yml:25`, `plugin.ts:1029` | Read |
| B15 | MINOR | `status` reports an absent Task id and a stale one with identical text | `engine.ts:910-912` | Read |

## C — Release engineering and documentation

| ID | Sev | Finding | Anchor | Method |
| --- | --- | --- | --- | --- |
| C1 | CRITICAL | The Harness pin is duplicated and inconsistent: manifest `0.1.1-rc.2`, a second hardcoded copy in the gate, lockfile `0.1.0-rc.6`, local checkout `0.1.1-rc.2` | `package.json:116`, `scripts/verify-dsh.ts:9-10` | Read + checked the local checkout |
| C2 | MAJOR | CI runs only `check`; `test:pack` and `test:dsh` are defined but never run, which is how C1 survived a green pipeline | `.github/workflows/ci.yml:36-46` vs `package.json:77-78` | Read |
| C3 | MAJOR | No release workflow, CHANGELOG, publish dry-run, provenance, or dependency automation; every publish is a manual local act | repository root | Read |
| C4 | MAJOR | No documentation of the operational prerequisites, the cost of a draft round, the data that leaves the machine, the on-disk footprint of export, the per-Task caps, or the refusals a user will hit | `README.md` | Read |
| C7 | MINOR | `.npmrc` pins `registry=https://registry.npmjs.org/`, overriding any user or corporate mirror; on this machine that pin fails its TLS handshake while the user-level mirror installs the same packages in seconds, and the lockfile's integrity hashes already make the pin redundant | `.npmrc:1` | Executed: pinned registry fails, mirror succeeds |
| C6 | MINOR | No CODEOWNERS and no issue templates, so a report arrives with no reproduction fields and no owner | `.github/` | Read |
| C5 | MINOR | All nine peer dependencies are `"*"`, correct for sharing one cordis instance but silent when a pre-1.0 RC changes a seam | `package.json:80-90` | Read |

## D — Test coverage

| ID | Sev | Finding | Method |
| --- | --- | --- | --- |
| D1 | MAJOR | No codec round-trip test feeds engine output back through `decodeRavenTaskState` — exactly the seam A1 falls through | Read |
| D2 | MAJOR | No cap-boundary tests for Sources, Claims, Checkpoints or Limitations | Read |
| D3 | MAJOR | No concurrent Team checkpoint test; the Team tests run strictly sequentially | Read |
| D4 | MAJOR | No test exercises a real network path, so the whole check taxonomy and every normalization defect are invisible by construction | Read |
| D5 | MINOR | No export-idempotence test: a second export is never compared byte for byte | Read |
| D6 | MINOR | No cross-host redirect rejection test, though the acceptance criteria require the behaviour | Read |
| D7 | MINOR | The settings card is tested only through its pure state projection; the React component and its controller are never rendered | Read |
| D8 | MINOR | No test covers plugin disposal: the listeners registered by `apply()` and the Task book they close over are never asserted to be released | Read |
| D9 | MINOR | Drafting tests cover one failing route among several, never the case where every configured route fails | Read |
| D10 | MINOR | The codec is tested only on well-formed input; no test feeds it a corrupted snapshot | Read |

## Checked and found sound

The verifier protocol validation is strict enough that a forged verifier response cannot fabricate support.
No configuration field can lower the evidence floor for research or academic writing.
Prose Layout idempotence holds across every structural case tested, and Source records are immutable once registered.
Per-query discovery failure isolation, absent-provider reporting, draft partial-failure handling, and the deployment-owned draft route universe all behave as their ADRs require.
The advertised per-action field sets are derived from the same allow-list the engine enforces, so the tool description cannot drift from the validator.
The browser card's controller was read against the installed `SettingsScope` contract: staging every edit until Save, refusing a partial write when any draft is unacceptable, and judging a save by reading the Host back rather than by the absence of an exception are all correct, and the sequential write loop is compatible with the scope's documented rule that only the latest settlement may publish.
There are no TODO, FIXME, or stub markers anywhere in `src/`.

## Fix status

Every finding below was fixed in this repository unless the row says otherwise.
"Verified" names the evidence that the fix works, not the fact that someone said it did.

| ID | Status | Evidence |
| --- | --- | --- |
| A1 | Fixed | The engine now verifies every external supported or qualified Claim, and the codec defers a single unsupportable Claim instead of rejecting the snapshot. A round-trip property test drives the real engine and feeds every emitted state back through `decodeRavenTaskState`; the test was strengthened after it was found to pass vacuously. |
| A2 | Fixed | A refused Checkpoint now returns the parsed Sources, Claims and Limitations with their check results. |
| A3 | Fixed | Checkpoints trim like draft rounds, the first is preserved, Completion keeps a reserved slot. Verified by publishing 148 Checkpoints without deadlock and completing at the cap. |
| A4 | Fixed | Checkpoint ids derive from the Task revision and carry an `r` marker so an id minted by an ordinal-era build cannot collide with one minted from a revision. |
| A5 | Fixed | `propagateSourceChecks` is total; the three divergent cap policies were unified and a drop is reported. |
| A6 | Fixed | Fenced code, inline code, frontmatter and link-reference definitions are excluded from the URL scan; a fragment and a trailing slash are authorized. |
| A7 | Fixed | An unchecked Source exports an explicit `verification: unverified` marker. |
| A8 | Fixed | `RavenError`/`RavenTypeError` carry a code, a category and a retryable flag; the human sentence is byte-identical and `instanceof TypeError` still holds. |
| A9 | Fixed | Enum rejections name the accepted values and the received one. |
| A10 | Fixed, narrower than first reported | Limitation identity is a monotonic counter and the codec validates shape and uniqueness rather than position. The audit implied any interleaving broke decoding; the measured scope is narrower — the two only diverge after a cap drop. Recorded in the code rather than dramatized with a contrived test. |
| A11 | Fixed, with a corrected rationale | Near-identical Limitation details fold. The digit-stripping step the original fix advertised is dead code: the character-class pass that follows already removes digits. The comment now says so. |
| A12 | **Withdrawn — the reported defect does not exist** | The claim was that HTML-escaping before Markdown-escaping renders `&` as `&amp\;`. It does not: `;` is not in the escaped class, so neither pass can re-escape the other's output. Both orders were tested across realistic inputs with zero diverging cases. No behaviour was changed and the comment records the false alarm instead of a fictional fix. |
| A13 | Fixed and hardened again | Raw page identities now bind Task plus canonical resource/inspection identity, artifact paths bind Task plus Artifact digest, and one-off exports carry absent preconditions plus an idempotent log marker. Tests cover same-Task idempotence and cross-Task title/Source-ID collisions. |
| A14 | Fixed | A migration table and loop exist; a newer-than-current schema is still refused, deliberately. |
| A15 | Fixed | `compactError` keeps a head and a tail with the middle elided, so repair guidance survives. |
| A16 | Fixed | Cap boundary tests at, below and above every cap, asserting the refusal costs the accepted state nothing. |
| B1 | Fixed | The mount warns, and `action=start` refuses a grounding-required Outcome when no fetch provider is composed, naming the capability and both escapes. `structural-only` deliberately still refuses at the Checkpoint. |
| B2 | Fixed | A PDF, a script-only shell and a near-empty extraction report `unavailable` with extraction guidance; `failed` is reserved for prose that was actually read. |
| B3 | Fixed | 404 and 410 stay evidence defects; 401/403/407 and 408/425/429/5xx report `unavailable`. |
| B4 | Fixed | One bounded retry with backoff for transient conditions only, honouring the abort signal and the deadline. |
| B5 | Fixed | Shipped Raven presets explicitly set `sourceCheckTimeoutMs` to 20s while omitted legacy configuration stays at 0; the whole pass carries a budget, and a per-host throttle applies. |
| B6 | Fixed | Every settings-reachable numeric has a ceiling and discovery fan-out is bounded. |
| B7 | Fixed | NFC, typographic folding and zero-width stripping on both sides; the entity table grew from six entries to about fifty; case, accents and letters are never folded. |
| B8 | Fixed | The book write is a compare-and-set; the losing call fails with its recovery action. |
| B9 | Fixed | The schema refuses a malformed route in its own words and skipped entries are reported. |
| B10 | Fixed | Lead URLs are redacted and unparseable ones dropped. |
| B11 | Fixed | Default ports fold per scheme; a non-default port still differs. |
| B12 | Fixed | The entity table covers the entities real prose uses and a code point above the Unicode range can no longer throw. |
| B13 | Fixed | Discovery concurrency is bounded. |
| B14 | Fixed | A double mount is detected and warned. |
| B15 | Fixed | Enum and lookup failures name what they received. |
| B16 | Fixed | Ordinary Agent books and terminal-only Team books use an LRU target of 64; the current book is exempt, and evicted Agent books re-fold from their session log. Continuing detected-Team books are also exempt because one-member-at-a-time reconstruction can fork an active or stopped Team Task, so the resident target becomes soft only when every excess candidate is a continuing Team book. Tests prove ordinary eviction/re-fold and >64-Team continuity separately. |
| B17 | Fixed | The card controller sets a disposal fence before releasing its subscriptions, and a save settling after disposal no longer publishes. |
| C1 | Fixed | The pin has one machine-readable source, the gate reads it, and the pin was retargeted to the checkout that exists. `pnpm run test:dsh` passes against it. |
| C2 | Fixed and hardened again | `test:pack` runs as its own CI job. Release CI checks out the exact immutable Harness pin, runs `test:dsh`, and smoke-tests paired preset composition plus process resume before publish can start. |
| C3 | Fixed | Tag-driven release workflow with provenance, a dirty-tree refusal, dependabot scoped away from the pinned packages, CHANGELOG, SECURITY and CONTRIBUTING. |
| C4 | Fixed | Both READMEs carry prerequisites, cost, data handling, limits and troubleshooting, with every error string verified verbatim against source. |
| C5 | Fixed | The intent of the wildcard peers is documented where they are declared and in the README. |
| C6 | Fixed | CODEOWNERS and issue templates that ask for the four facts that actually decide a Raven report. |
| C7 | Fixed | The redundant registry pin was removed from `.npmrc`, which had made the repository uninstallable behind a mirror. |
| D1 | Fixed | Codec round-trip property test through the real engine. |
| D2 | Fixed | Cap boundary tests for Sources, Claims, Checkpoints and Limitations. |
| D3 | Fixed | Concurrent Team checkpoint test asserting the loser recovers rather than the contribution vanishing. |
| D4 | Fixed | 27 retrieval tests covering the taxonomy, the retry and ten normalization cases, each verified red without the fix. |
| D5 | Fixed and hardened again | Same-Task export is byte-identical with one stable log marker; cross-Task export paths cannot collide when titles and Task-local Source IDs repeat. |
| D6 | Fixed | Cross-host redirect rejection, plus default-port acceptance and non-default-port rejection. |
| D7 | Fixed | The card is rendered and the controller driven: 16 tests over the element tree, the write path, the read-back and disposal. |
| D8 | Fixed | Disposal releases both subscriptions and stops publishing. |
| D9 | Fixed | A round where every route fails now reports its own unavailability instead of "0 Draft Variant(s)", which read as an empty success. |
| D10 | Fixed | Codec decode-rejection tests, mutation-tested against nine disabled checks. |

Three findings were corrected during the work rather than defended: A12 was withdrawn as a misdiagnosis, A11's stated mechanism was wrong even though its fix works, and A10's scope was narrower than the audit implied.
Two tests were found to pass vacuously and were strengthened before they were counted.

## Reinstall verification

The fixed build was uninstalled from and reinstalled into the live profile at `~/.dsh/profiles/web`, and the reinstall was verified rather than assumed.

| Evidence | Before | After |
| --- | --- | --- |
| Profile dependency and `dsh.profile.bundles` row | present | removed by `dsh plugin --profile web remove`, then restored by `add` |
| Installed `lib/index.js` | `61F96033…`, 137678 bytes | `928B7043…`, 188061 bytes |
| Installed `dshRaven.harnessVersion` | `0.1.1-rc.1` | `0.1.1-rc.2` at commit `b150a551…` |
| Installed artifacts vs the repository's own build | — | `lib/index.js` and `lib/client.js` hash byte-identical to the freshly built files |

The running web process predates this work, so it still holds the previously loaded code: a Harness restart is what moves the reinstalled bytes into a live session, and that decision belongs to whoever owns the process.

## Reported but false — not acted on

One audit reported that `src/config.ts:34` defaults `draftRoutes` to a list of model names, that `cordis.patch.yml` mounts the plugin on the preset plane, and that the README documents a `dsh profile plugin add` command that does not exist.
All three were checked against the files and are fabrications: the default is `[]`, the patch inserts a host-plane row, and the README documents `dsh plugin --profile <name> add`, which matches the Harness documentation.
They are recorded here so that a later reader does not resurrect them.