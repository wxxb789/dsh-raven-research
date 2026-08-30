# Raven v1 Acceptance Evidence

## Test surfaces

The requested public contract fixes eight test seams:

1. **Cordis load seam** — named exports, prompt/tool registration, real Loader
   unwrapping, execution through `ctx.tools`, and disposal.
2. **Raven Task interface** — one active continuing Task per owning Agent or detected
   Team book across Checkpoints, Steering Revisions, stop/resume, replay, and Completion;
   stopped and completed Task history remains addressable.
3. **SourceVerifier seam** — deterministic adapters, Harness-web observations, and owning-session file/MCP inspection receipts feeding the same source/claim/completion policy.
4. **DraftGenerator seam** — a deterministic drafter and the real `ctx.llm` adapter
   feeding the same candidate policy, where a variant can never become evidence.
5. **Synthesis contract** — durable Insight Candidates, Summary Debt, explicit promotion,
   competing interpretations, and analysis-to-Claim-to-Source lineage through the same Task state.
6. **Structure Studio contract** — materially distinct evidence-linked Skeleton Candidates,
   complete private comparative Battles, compact user alternatives, collaborative or delegated
   selection and hybridization, draft gating, Steering invalidation, and lightweight bypass.
7. **Raven Workspace interface** — pure Markdown snapshot planning for initialization,
   adoption, normalization-backed ingest, Task contribution, maintenance, health, and
   lexical reuse, with conditional writes and a lifecycle separate from Task state.
8. **Composition and browser artifact** — the Bundle patch composed through the
   Harness's own composer, and the built browser bundle evaluated as the shell
   evaluates it.

Tests assert canonical state and dispositions rather than model prose or one internal
agent topology.

## Completion criteria matrix

| Criterion | Evidence |
|---|---|
| Clean install, load, and run against intended Harness | `pnpm test:pack` creates an external staging project with no `lib/`, links only the pinned toolchain, exercises real `prepack` without mutating the repository build, enforces the exact tarball allowlist, and installs it with an isolated pnpm home plus a fresh store by default (or an explicit pre-populated offline store/cache) in a second external consumer before import/apply/execute; `pnpm test:dsh` requires the exact clean Harness commit, loads a real `cordis.yml` through Loader + Include, executes start/checkpoint/complete through the real tool registry and `ctx.web` seam, and removes the composition to verify disposal. |
| Build, lint, typecheck, and tests pass | `pnpm check` runs Oxlint with warnings denied, strict TypeScript, the tsdown Host and browser builds, and the full Vitest inventory below. The build runs before the tests because the browser half is a build artifact and one suite verifies that artifact rather than its source. |
| Durable output as a valid llm-wiki | `tests/unit/wiki.test.ts` exports a completed Task as llm-wiki bytes: an artifact page with frontmatter, sources, and contested marking; one immutable `raw/` page per Source whose `sha256` covers exactly its own body and remains stable across later projection times; an appendable log entry; and SCHEMA/index/log seeds only under `init`. Raven emits bytes and never writes files, so the repository stays readable by the llm-wiki skill and Obsidian. |
| Durable compounding Raven Workspace | `tests/unit/workspace.test.ts` covers fresh initialization, byte-preserving existing-wiki adoption, mixed-document folder adoption through Source normalization, time-stable idempotent ingest, immutable `supersedes` revisions, repeated growth of all four llm-wiki page types, conservative confidence and contradiction history, deterministic index regeneration, health codes, path confinement, conditional hashes, and lexical freshness labels. `tests/acceptance/raven.acceptance.test.ts` drives both registered tools end to end: it initializes and adopts material, completes and grows Task A without changing its revision, maintains a healthy wiki, mounts a fresh Raven instance, reuses the persisted Markdown in independent Task B as an attested `llm-wiki` Source, and completes it. No Workspace is required by the existing Task scenarios. |
| Evidence-backed Keep / Change / Drop assessment | `docs/reverse-engineering/assessment.md` synthesizes the Hermes profile, nana-research, Harness, and skill-corpus reports — `hermes-research-skills.md` (all 258 files across 18 research skills), `hermes-r-round-references.md`, and `hermes-nana-wiki.md` — and maps preserved mechanisms to source files and line ranges. |
| Four first-class Outcomes | `tests/acceptance/raven.acceptance.test.ts` has end-to-end scenarios for `research`, `general-writing`, `academic-writing`, and `learning` through the same tool and Task state. |
| Progressive research and mid-run correction | The first acceptance scenario verifies one initial Source and publishes an active early Artifact before the second Source, broader collection, and final Completion verification; it then continues research, applies `steer`, emits a revised Checkpoint, and completes with the original Task ID. |
| Natural main-agent use with contextual guidance | `tests/acceptance/raven.acceptance.test.ts` exercises `guidance: auto` before a Task and across active, stopped, and completed states, asserts the injected policy instructs the main agent to keep actions and identifiers internal, limits hints to one relevant capability, and forbids repetition/tutorial/approval behavior. The same scenario mounts `guidance: off`, proves no guidance block is injected before or during the Task, and still runs checkpoint → stop → resume → Completion on the same Task. `tests/unit/config.test.ts` proves the default and rejects values outside `auto | off`; `tests/unit/card-state.test.ts` proves the policy is editable through the schema-derived settings card. |
| No mandatory normal-stage confirmation | At the executable Raven interface, the acceptance suite verifies there is no `confirm` or `approve` action and the real DSH composition advances start/checkpoint/complete without an approval call; the prompt explicitly forbids approval requests between normal stages. |
| No fabricated citations or broken references | Unit/acceptance tests require registered Source IDs for material external Claims and mechanically render a Claim↔Source↔Original Resource trace. Web retains real HTTP retrieval, redirect identity, and excerpt checks. Non-web acceptance correlates `inspectionCallId` with successful `tool/call`/`tool/result`, validates producer, resolved file identity or MCP namespace, exact Markdown, and full/segment/unknown coverage; forged Markdown and missing receipts refuse publication and defer Claims. Persisted `inspectionSha256` permits later Completion without losing the original attestation. |
| Partial failures degrade gracefully | The engine first observes a real verifier failure for one dependent Source, automatically defers Claims that lose all usable support, and records a Limitation; a revised Checkpoint preserves the independently verified Claim and can complete as `completed-with-limits`. A separate test ensures zero valid grounded work remains active rather than being mislabeled graceful Completion. |
| Installable as an isolated mode | `package.json` deliberately declares no `dsh.bundle`: installing the dependency activates no global row. The shipped `dsh-raven-install-preset` bin writes the user-owned Raven mode, inheriting a base preset live and adding exactly one `role: agent` row. `tests/unit/bundle.test.ts` asserts the manifest absence and shipped preset assets; `tests/unit/install-preset.test.ts` covers live/snapshot installation and non-destructive base handling. `pnpm test:dsh` proves the default install contributes no global tool/namespace, while the opt-in `cordis.patch.yml` composes to exactly one `role: host` row. |
| Configurable from the Web GUI | The browser half registers one card into the keyed `settings.plugin.item` slot under key `raven-research`, drawn as a disclosure card with the same geometry and design tokens as the cards the Harness ships, grouped into evidence, discovery, prose, drafting, and other user preferences such as guidance, with bilingual copy. The card states no validation rules of its own: fields, control kinds, accepted values, and bounds come from the schema the Host registered, read off `settingsScope.describe()` and rehydrated through the Harness's own `settingsSchema` service, so a refused draft reports the schema's own words. `tests/unit/card-state.test.ts` drives the form model through the REAL `Config` schema and a stand-in mirroring the Harness service — field derivation and declaration order, choices derived from union consts, schema-owned refusal of negative/fractional/non-numeric drafts, the one route-shape rule the schema cannot express, override detection from key presence rather than value comparison, staged clears that only write when the user layer carries the key, drafts restating the stored value counting as no edit, all-or-nothing save planning, dictionary coverage for every schema field, and memory-mode read-only. `tests/integration/client-bundle.test.ts` evaluates the built `lib/client.js` in a VM with a fake shell and asserts it registers one entry under the package name, requires only shell-answerable specifiers, carries no Host-only code, binds its scope and the describe mirror, registers both shipped locales in one call, carries its own stylesheet, and materializes to a plugin registering under the namespace key with its locale namespace declared. `pnpm test:dsh` asserts the slot contract, the Harness card chrome, the locale registration signature, the four `settingsSchema` method signatures, the describe face, and the per-namespace schema envelope against the Harness checkout under test. The card renders into host chrome it cannot see, so two structural rules are asserted rather than eyeballed: `tests/unit/styles.test.ts` requires every selector in the shipped stylesheet to be scoped to the card and the card root to establish a containing block, because an escaped absolutely positioned descendant lands in the settings dialog instead and scrolls its header and navigation permanently out of view on the first click; `tests/unit/react-alignment.test.ts` requires the developed and typechecked React major to equal the one the official settings-UI packages declare as their `react` peer, because the shell supplies React through its module table and a drift installs silently, typechecks green, and fails only in the page. |
| Writing edited a line at a time | `tests/unit/prose.test.ts` covers sentence splitting for Latin and CJK, abbreviations, initials, decimals, inline code, link destinations, and every protected Markdown structure, plus idempotence. `tests/integration/drafting.test.ts` covers the stored bytes, the reflow report, Completion of either line shape, and the layout-change diagnosis. |
| Multi-model drafting that cannot become evidence | `tests/integration/drafting.test.ts` asserts a Draft Variant never reaches the evidence floor: adopting variant wording verbatim still leaves a grounding-required Completion refused until a recorded Source excerpt supports it. It also covers route-subset selection, refusal of an unconfigured route, survival of a failed route, and bounded provenance that retains no variant text. |
| Inspectable synthesis and defensible analysis | `tests/integration/synthesis.test.ts`, `tests/integration/plugin.test.ts`, and `tests/acceptance/raven.acceptance.test.ts` distinguish Source testimony, Insight Candidates, and promoted Raven inference; treat cross-round competition as undirected; retain and replay candidate lineage; expose bounded Candidate IDs through status/context and exact selected records through inspect; track Summary Debt per synthesis scope across unrelated summaries; reject deferred/rejected-to-accepted unlineaged analysis; and preserve deferred promoted lineage through recovery and multi-hop restoration. Existing General Writing and Learning scenarios still complete without a synthesis step. |
| Intentional pre-writing argument architecture | `tests/integration/structure-studio.test.ts` and `tests/acceptance/raven.acceptance.test.ts` prove materially distinct frames and theses, one complete private battle per Candidate, compact rendering that omits tournament detail, collaborative user selection and hybridization, delegated Raven selection, Steering invalidation, replay-safe selected state, bounded always-on selection digest plus current-round/exact-selection status recall, delimiter-safe selected Skeleton injection into bounded drafting context, section-level external Claim/analysis Claim/Insight/counterargument/evidence-gap linkage, pre-selection draft refusal, post-reselection Checkpoint enforcement, history and selection headroom bounds, and direct `skip` completion for lightweight writing. Prompt assertions cover natural discussion, rejection, combination, redirection, delegation, and explicit skipping without an approval action. |

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
  - confidence reported from Task phase and recorded limits;
  - immutable raw bytes stable across projection dates.
- `tests/unit/workspace.test.ts`
  - fresh initialize and byte-preserving existing llm-wiki adoption;
  - mixed-folder adoption and later ingest through the Source normalization seam;
  - immutable content-addressed revisions, idempotency, and conditional write hashes;
  - repeated Task growth across query, concept, entity, and comparison pages;
  - provenance, confidence, contradiction and body history retention;
  - derived index regeneration, deterministic health codes, and lexical freshness labels;
  - unsafe-path, unavailable-normalization, and slug-collision failure paths.
- `tests/unit/workspace-tool-schema.test.ts`
  - separate `raven_workspace` registration;
  - exact schema/runtime action fields and shared Source provenance schema;
  - conditional-write and append-marker rendering.
- `tests/unit/codec.test.ts`
  - complete JSON round-trip;
  - unknown-version and unknown-field rejection;
  - schema-v1-v3 migration onto the schema-v4 compatibility path;
  - early rejection of structurally bounded snapshots above the aggregate byte budget;
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
  - bounded abbreviation lookbehind on a long unbroken dot-dense token;
  - the layout report distinguishing a reflow from a no-op.
- `tests/unit/url.test.ts`
  - one-way HTTP→HTTPS identity upgrade, default-port equivalence, and downgrade/host/port rejection;
  - Source credential rejection and Lead credential redaction.
- `tests/unit/network-policy.test.ts`
  - private, loopback, metadata, mapped IPv4/IPv6, NAT64, and 6to4 address refusal;
  - all-DNS-answers-must-be-public behavior and DNS failure containment.
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
  - the deliberate absence of `dsh.bundle`, which keeps installation inert outside Raven mode;
  - the opt-in host patch plus both shipped preset assets in the published file set;
  - exactly one agent-role row and no Harness package as a runtime dependency.
- `tests/unit/process.test.ts`
  - bounded child-process deadline;
  - cancellation reason preservation while the process tree settles.
- `tests/integration/plugin.test.ts`
  - named Cordis exports, bounded schema annotations, and one prompt/tool/listener registration;
  - compact Task reconstruction from durable `tool/result.meta` after plugin reload;
  - bounded unpromoted Candidate IDs in replayed status and active context, exact selected inspect output, and later promotion from the inspected record;
  - preservation and replay of multiple historical Task identities in one Session;
  - a PTC mode step recorded on the known `tool/code-dispatch` event and NO plugin-owned
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
  - one active Task shared across a successfully detected Agent Team, and a teammate's competing `start` refused;
  - each observed member's own durable records folded into the shared Task book, including the documented post-restart case where another member's history is not present until that member is observed;
  - the teammate-only pre-step instruction;
  - a continuing Team book retained under pressure from more than 64 distinct Team books, while ordinary Agent eviction remains bounded elsewhere;
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
- `tests/integration/structure-studio.test.ts`
  - materially different frames and theses plus rejection of punctuation/case duplicates and lexical near-copies;
  - complete per-Candidate battle validation and compact rendering that omits internal tournament categories;
  - collaborative user hybridization with selected external Claim, analysis Claim, Insight, counterargument-specific lineage, and evidence-gap links;
  - selected architecture replay through durable state, a delimiter-safe bounded context digest, current-round status recovery, and exact selected status recall;
  - bounded Draft Variant context constrained by the selected thesis, reasoning flow, sections, evidence needs, and counterarguments;
  - post-reselection Checkpoint enforcement, aggregate replay and exact-selection headroom bounds, and bounded Structure Round history;
  - delegated Raven selection, Steering invalidation with stale-round recovery, pre-selection draft/verify/refine refusal, and lightweight `skip` Completion.
- `tests/integration/synthesis.test.ts`
  - multi-Claim Insight Candidate derivation with assumptions, rationale, confidence, and reversal evidence;
  - cross-round one-way competition projected as an undirected alternative after earlier-Candidate promotion;
  - explicit candidate-to-analysis promotion and rendered analysis lineage;
  - Source testimony, candidate interpretation, and accepted Raven inference rendered as distinct authorities;
  - per-scope Summary Debt surviving an unrelated summary and clearing only after a debt-free synthesis pass over the same scope;
  - external-fact promotion refusal plus deferred/rejected-to-accepted unlineaged analysis refusal;
  - verifier-failure recovery through revised Checkpoint and completed-with-limits, plus multi-hop premise deferral/restoration.
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
  - end-to-end Source testimony → multi-Claim Insight Candidates → promoted analysis lineage;
  - competing causal interpretations, Summary Debt detection, and unsupported external-fact promotion refusal;
  - evidence-linked Structure Studio Candidates, private battle, user hybridization, delegated Raven selection, Steering invalidation, pre-writing gating, and lightweight skip;
  - prompt policy that reserves synthesis and Structure Studio for work that benefits rather than summaries, trivial writing, or ordinary teaching;
  - one grounded Claim/Source/citation contract exercised across exactly web, local, llm-wiki, and MCP origins;
  - Original Markdown preservation and converted Markdown provenance;
  - unreadable or unsupported local material becoming unavailable, a deferred Claim, and a retained Limitation;
  - fabricated/unregistered URL rejection;
  - known-broken cited Source rejection;
  - contextual guidance in `auto` before and during a Task;
  - complete guidance suppression in `off` while checkpoint/stop/resume/Completion remain usable;
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
An unreachable registry therefore fails that gate rather than silently skipping it. A workstation that already holds the exact pinned graph can exercise the same clean consumer without network access:

```powershell
$env:RAVEN_PACK_USERCONFIG = "$HOME\.npmrc"
$env:RAVEN_PACK_STORE_DIR = "Q:\.pnpm-store\v11"
$env:RAVEN_PACK_CACHE_DIR = "$HOME\AppData\Local\pnpm-cache"
$env:RAVEN_PACK_OFFLINE = "1"
pnpm test:pack
```

The store and metadata cache must already contain every pinned package. The consumer still uses its own directory and isolated HOME; no package is linked from this repository.

Where the feed is an authenticated mirror whose token expires, refresh the credential
before the gate rather than treating the fetch failure as a Raven defect. On a machine
whose shell provides an `aznpm`-style refresh helper, that helper rewrites the user
`.npmrc` and the mirrored config `RAVEN_PACK_USERCONFIG` points at. A shell started
without the user profile must load it before the helper is callable.
