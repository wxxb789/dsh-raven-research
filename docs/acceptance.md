# Raven v1 Acceptance Evidence

## Test surfaces

The requested public contract fixes five test seams:

1. **Cordis load seam** — named exports, prompt/tool registration, real Loader
   unwrapping, execution through `ctx.tools`, and disposal.
2. **Raven Task interface** — one Task across Outcomes, Checkpoints, Steering
   Revisions, stop/resume, replay, and Completion.
3. **SourceVerifier seam** — deterministic and Harness-web observations feeding the
   same source/claim/completion policy.
4. **DraftGenerator seam** — a deterministic drafter and the real `ctx.llm` adapter
   feeding the same candidate policy, where a variant can never become evidence.
5. **Composition and browser artifact** — the Bundle patch composed through the
   Harness's own composer, and the built browser bundle evaluated as the shell
   evaluates it.

Tests assert canonical state and dispositions rather than model prose or one internal
agent topology.

## Completion criteria matrix

| Criterion | Evidence |
|---|---|
| Clean install, load, and run against intended Harness | `pnpm test:pack` creates an external staging project with no `lib/`, links only the pinned toolchain, exercises real `prepack` without mutating the repository build, enforces the exact tarball allowlist, and installs it with an isolated pnpm home/store in a second external consumer before import/apply/execute; `pnpm test:dsh` requires the exact clean Harness commit, loads a real `cordis.yml` through Loader + Include, executes start/checkpoint/complete through the real tool registry and `ctx.web` seam, and removes the composition to verify disposal. |
| Build, lint, typecheck, and tests pass | `pnpm check` runs Oxlint with warnings denied, strict TypeScript, the tsdown Host and browser builds, and 140 Vitest tests. The build runs before the tests because the browser half is a build artifact and one suite verifies that artifact rather than its source. |
| Durable output as a valid llm-wiki | `tests/unit/wiki.test.ts` exports a completed Task as llm-wiki bytes: an artifact page with frontmatter, sources, and contested marking; one immutable `raw/` page per Source whose `sha256` covers exactly its own body; an appendable log entry; and SCHEMA/index/log seeds only under `init`. Raven emits bytes and never writes files, so the repository stays readable by the llm-wiki skill and Obsidian. |
| Evidence-backed Keep / Change / Drop assessment | `docs/reverse-engineering/assessment.md` synthesizes the Hermes profile, nana-research, Harness, and skill-corpus reports — `hermes-research-skills.md` (all 258 files across 18 research skills), `hermes-r-round-references.md`, and `hermes-nana-wiki.md` — and maps preserved mechanisms to source files and line ranges. |
| Four first-class Outcomes | `tests/acceptance/raven.acceptance.test.ts` has end-to-end scenarios for `research`, `general-writing`, `academic-writing`, and `learning` through the same tool and Task state. |
| Progressive research and mid-run correction | The first acceptance scenario verifies one initial Source and publishes an active early Artifact before the second Source, broader collection, and final Completion verification; it then continues research, applies `steer`, emits a revised Checkpoint, and completes with the original Task ID. |
| No mandatory normal-stage confirmation | At the executable Raven interface, the acceptance suite verifies there is no `confirm` or `approve` action and the real DSH composition advances start/checkpoint/complete without an approval call; the prompt explicitly forbids approval requests between normal stages. |
| No fabricated citations or broken references | Unit/acceptance tests require registered Source IDs for material external Claims, mechanically render Source URLs plus a Claim↔Source trace, reject unknown raw URLs and cross-host resolved identities, and refuse grounded Checkpoints or Completion when a URL is broken or its recorded excerpt is absent. A loopback integration test retrieves real HTTP bytes, rejects invented support, accepts a matching HTML-normalized excerpt, and completes only the exact checkpointed Artifact. |
| Partial failures degrade gracefully | The engine first observes a real verifier failure for one dependent Source, automatically defers Claims that lose all usable support, and records a Limitation; a revised Checkpoint preserves the independently verified Claim and can complete as `completed-with-limits`. A separate test ensures zero valid grounded work remains active rather than being mislabeled graceful Completion. |
| Installable without editing a composition | `package.json` declares `dsh.bundle.patch`, so `dsh plugin add` appends the package to a profile's bundle list. `tests/unit/bundle.test.ts` asserts the manifest field, its presence in the published file set, the row identity, and that no Harness package is a runtime dependency. `pnpm test:dsh` then composes `cordis.patch.yml` through the Harness's OWN `loadOverlayPatches` and `composeEntries` and asserts the result is exactly one row naming this package. |
| Configurable from the Web GUI | The browser half registers one card into the keyed `settings.plugin.item` slot under key `raven-research`. `tests/unit/card-state.test.ts` covers the form model — per-field validation, override detection from key presence rather than value comparison, all-or-nothing save planning, and memory-mode read-only. `tests/integration/client-bundle.test.ts` evaluates the built `lib/client.js` in a VM with a fake shell and asserts it registers one entry under the package name, requires only shell-answerable specifiers, carries no Host-only code, and materializes to a plugin registering under the namespace key. `pnpm test:dsh` asserts the targeted slot contract against the Harness checkout under test. |
| Writing edited a line at a time | `tests/unit/prose.test.ts` (22) covers sentence splitting for Latin and CJK, abbreviations, initials, decimals, inline code, link destinations, and every protected Markdown structure, plus idempotence. `tests/integration/drafting.test.ts` covers the stored bytes, the reflow report, Completion of either line shape, and the layout-change diagnosis. |
| Multi-model drafting that cannot become evidence | `tests/integration/drafting.test.ts` asserts a Draft Variant never reaches the evidence floor: adopting variant wording verbatim still leaves a grounding-required Completion refused until a recorded Source excerpt supports it. It also covers route-subset selection, refusal of an unconfigured route, survival of a failed route, and bounded provenance that retains no variant text. |

## Vitest inventory

- `tests/unit/engine.test.ts`
  - strict action/nested-record unknown-field rejection;
  - Task start/status and default grounding;
  - refusal to disable the evidence floor on evidence-defined Outcomes;
  - preserved contradiction links with contested rendering and dangling-link rejection;
  - immutable Source identity and evidence anchors;
  - preserved version identity for mutable scholarly URLs;
  - single-family and undeclared-family independence annotation in the Claim trace;
  - Source/Claim capture, bounded state, escaped Markdown rendering, and generated Claim trace;
  - same-Task Steering Revision;
  - verified excerpts before grounded Checkpoint publication;
  - exact final Artifact equality with the latest Checkpoint;
  - strict verifier response identity/protocol validation;
  - cancellation of a never-settling verifier at the engine seam;
  - zero-valid-work Completion rejection;
  - automatic Claim deferral after dependency failure;
  - dependency-aware partial failure;
  - stop/resume preservation.
- `tests/unit/wiki.test.ts`
  - llm-wiki artifact page with frontmatter, sources, and contested marking;
  - immutable `raw/` page whose `sha256` covers exactly its own body;
  - appendable log entry that never rewrites `wiki/log.md`;
  - SCHEMA/index/log seeds only under `init`;
  - confidence reported from Task phase and recorded limits.
- `tests/unit/codec.test.ts`
  - complete JSON round-trip;
  - unknown-version and unknown-field rejection;
  - malformed nested-record rejection.
- `tests/unit/prose.test.ts`
  - Latin and CJK sentence splitting, with CJK requiring no trailing whitespace;
  - abbreviations, initials, decimals, inline code spans, and link destinations never split;
  - closing quotes and footnote markers kept with the sentence they close;
  - fenced code, tables, headings, thematic breaks, link definitions, math blocks, and
    YAML frontmatter copied through untouched;
  - list-item and blockquote continuation prefixes preserved;
  - authored hard line breaks preserved rather than reflowed across;
  - idempotence for both Markdown and plain formats;
  - the layout report distinguishing a reflow from a no-op.
- `tests/unit/card-state.test.ts`
  - the field set matching the Host schema exactly;
  - choice, natural, and route parsing, with naturals refusing everything `Number()` accepts;
  - override derived from key presence in the user layer, including an override equal to
    the composition default;
  - a non-object user layer treated as no overrides;
  - a staged invalid edit shown without being lost;
  - an unstaged field staying live while another is edited;
  - read-only rendering in memory mode and where the Host refuses writes;
  - all-or-nothing save planning.
- `tests/unit/bundle.test.ts`
  - the one manifest field the profile composer reads;
  - the patch shipped in the published file set and exported;
  - one inserted row naming this package and this plugin id;
  - no Harness package as a runtime dependency.
- `tests/unit/process.test.ts`
  - bounded child-process deadline;
  - cancellation reason preservation while the process tree settles.
- `tests/integration/plugin.test.ts`
  - named Cordis exports, bounded schema annotations, and one prompt/tool/listener registration;
  - compact Task reconstruction from durable `tool/result.meta` after plugin reload;
  - preservation and replay of multiple historical Task identities in one Session;
  - a Code Mode step recorded on the known `tool/code-dispatch` event and NO plugin-owned
    session event type, an Artifact carrying `-->` surviving the record, and a replaced
    (spilled) log copy losing that step without failing the session.
- `tests/integration/discovery.test.ts`
  - one batch of complementary queries issued through the `ctx.web` search half;
  - the batch bound applied before deduplication, and an empty batch refused;
  - a failing query recorded as a `tool` Limitation while its siblings keep their Leads;
  - one URL returned by several queries folded into one Lead recording both;
  - per-query deadlines, withheld discovery, an uncomposed search provider, and caller
    cancellation reported as cancellation rather than as a per-query failure.
- `tests/integration/agent-team.test.ts`
  - one Task shared across an Agent Team, and a teammate's competing `start` refused;
  - each member's own durable records merged into the shared Task book;
  - the teammate-only pre-step instruction;
  - single-agent behaviour where no Team capability is composed or its probe throws.
- `tests/integration/drafting.test.ts`
  - `provider/model` split on the FIRST slash so a namespaced model id survives;
  - every configured route drafted, each variant laid out one sentence per line;
  - a requested subset honoured and an unconfigured route refused with the configured set named;
  - drafting reported unavailable rather than quietly using the session model;
  - surviving variants kept when one route fails;
  - bounded route provenance persisted and replayed, retaining no variant text;
  - a Draft Variant never reaching the evidence floor;
  - stored Artifact bytes, the reflow report, and the recorded Checkpoint layout;
  - Completion accepting either line shape the caller resends;
  - a Prose Layout change named as the cause of a byte mismatch;
  - the layout disabled storing exactly what was submitted;
  - a fenced code block in an Artifact left untouched.
- `tests/integration/client-bundle.test.ts`
  - the `dsh.client` platform declaration and the `./client` export the module scan requires;
  - exactly one registered entry, under the PACKAGE name;
  - only shell-answerable specifiers required;
  - no Node built-in and no Host-only code inlined;
  - the materialized factory registering the card under key `raven-research`.
- `tests/integration/source-provenance.test.ts`
  - real loopback HTTP retrieval;
  - truncated retrieval reported as unverifiable rather than as fabrication;
  - inline-markup and CJK anchor matching with preserved block boundaries;
  - nearest-passage repair diagnostics on excerpt drift;
  - invented excerpt rejection before publication;
  - HTML/entity-normalized verbatim excerpt matching and exact Completion;
  - cancellation of a provider Promise that ignores `AbortSignal`.
- `tests/acceptance/raven.acceptance.test.ts`
  - progressive Research with later evidence and steering;
  - General Writing;
  - Academic Writing;
  - Learning;
  - fabricated/unregistered URL rejection;
  - known-broken cited Source rejection;
  - absence of normal-stage confirmation actions (discovery included).

## Release gate

```powershell
$env:DSH_CHECKOUT = 'Q:\repos\deepseek-harness'
# Only where the default public registry is unreachable: point the clean-consumer
# install at a reachable mirror without inheriting the developer's whole npm config.
$env:RAVEN_PACK_USERCONFIG = "$HOME\.config\.npmrc"
pnpm check:release
```

This command runs the repository gate, the packed clean-consumer install, and the
real Harness compatibility smoke test.

`pnpm test:pack` reaches a registry on purpose: Raven declares its Harness packages as
peer dependencies, and the clean consumer proves a real deployment can resolve them.
An unreachable registry therefore fails that gate rather than silently skipping it.

Where the feed is an authenticated mirror whose token expires, refresh the credential
before the gate rather than treating the fetch failure as a Raven defect. On a machine
whose shell provides an `aznpm`-style refresh helper, that helper rewrites the user
`.npmrc` and the mirrored config `RAVEN_PACK_USERCONFIG` points at. A shell started
without the user profile must load it before the helper is callable.
