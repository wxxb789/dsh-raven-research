# Reverse-engineering `nana-research` for Raven

## Scope and method

This report treats `Q:\repos\nana-research` as primary-source evidence. It inspects the repository kernel, focused contracts, executable helpers, tests, live study records, archived workflow records, and real evidence ledgers. It does **not** treat repository prose as proof that a mechanism works: where possible, prose is paired with tests or actual artifacts. Citations use repository-relative paths and exact line ranges.

**Decision vocabulary**

- **Keep** — preserve the mechanism substantially as-is because user-visible trust or recoverability justifies its cost.
- **Change** — retain the intent but simplify or alter the mechanism for Raven.
- **Drop** — do not carry the mechanism into Raven's default architecture; the complexity or latency exceeds its user-visible value.

## Executive assessment

Nana is best understood as an **evidence-centered, filesystem-native research operating system**, not merely a prompt collection. Its architecture separates source truth, derived knowledge, writing deliverables, process control, deterministic tools, and scratch state; assigns one canonical owner to each; and uses append-only identities, evidence ledgers, independent verification, and explicit lifecycle gates to prevent workers or files from becoming accepted truth by accident (`CLAUDE.md:38-47`; `docs/agent-contract/ownership-and-layout.md:19-37`, `162-181`).

Its strongest ideas are intentional and valuable for Raven: primary-source anchoring, claim ceilings, source-family independence, explicit uncertainty, non-transitive acceptance, main-thread synthesis, isolated workers with exclusive paths, bounded retry, immutable artifact versions, and deterministic validators (`docs/agent-contract/research-system/evidence-and-lineage.md:11-26`, `82-110`; `docs/agent-contract/research-system/verification-and-acceptance.md:11-24`; `docs/agent-contract/fanout-and-verification.md:56-75`, `158-183`).

Its largest weakness is **control-plane overgrowth**. Nana encodes related invariants repeatedly across a kernel, directory READMEs, lifecycle documents, focused modules, method packs, templates, migration contracts, JSON receipts, hashes, snapshots, leases, and validators. The live pilot illustrates the consequence: revision 18 is blocked before execution because stale lifecycle prose and a changed legacy baseline invalidate exact-byte readiness; no iteration or evidence row was ever allocated (`studies/active/NRS-2026-001-nrs-cutover-reproducibility-pilot/study.md:1-21`, `77-105`; `studies/active/NRS-2026-001-nrs-cutover-reproducibility-pilot/control/iteration-record.jsonl:1-1`; `studies/active/NRS-2026-001-nrs-cutover-reproducibility-pilot/control/evidence-ledger.jsonl:1-1`). Raven should keep Nana's epistemic discipline while replacing most document-level bureaucracy with a smaller typed state model and risk-adaptive UI.

## 1. Architecture and ownership

### 1.1 Repository layers

Nana defines distinct durable layers:

| Layer | Nana mechanism | Raven decision | User-visible value vs cost |
|---|---|---|---|
| Source truth | `raw/` preserves originals and provenance; sources are not rewritten for narrative convenience (`CLAUDE.md:38-47`; `README.md:163-181`). | **Keep** | Users can reopen what a claim came from. Storage and ingest cost are modest relative to trust value. |
| Knowledge | `wiki/` holds reusable source/entity/concept/claim/query/synthesis knowledge, while precise or disputed claims must reopen originals (`README.md:9-18`; `docs/agent-contract/ownership-and-layout.md:86-110`). | **Change** | Keep a compiled index and reusable synthesis, but make it generated/searchable rather than requiring many hand-managed Markdown page types. |
| Deliverables | `artifacts/` contains immutable versioned writing outputs; a substantive revision creates a new file (`docs/agent-contract/artifact-writing-and-closeout.md:44-63`). | **Keep** | Visible version history and rollback directly help users; low latency cost. |
| Process control | Legacy `plans/` and new `studies/` persist lifecycle state, scope, reviews, registers, manifests, and closeout (`CLAUDE.md:42-47`; `studies/README.md:5-16`). | **Change** | Persist state, but use one Raven run/study object rather than parallel legacy and NRS control planes. |
| Reusable automation | `.harness/` holds committed deterministic helpers only after repeated/generalizable need (`.harness/README.md:182-210`). | **Keep** | Deterministic checks reduce repeated model work and latency. Preserve the extraction principle, not Nana-specific script sprawl. |
| Scratch | `temp/` is disposable and cannot be the only home of durable evidence (`studies/README.md:14-16`; `docs/agent-contract/ownership-and-layout.md:195-212`). | **Keep** | Prevents loss and accidental promotion with little complexity. |

The layout is explicitly based on **purpose and ownership, not producing tool**, and promotion means moving an inspected artifact to its canonical layer (`docs/agent-contract/ownership-and-layout.md:162-181`). This is intentional deep architecture rather than cosmetic organization.

### 1.2 Authority model and progressive disclosure

The authority chain is current user decision → repository kernel → focused contract → area/source/style/object contract → historical records (`CLAUDE.md:24-32`; `README.md:22-38`). The kernel directs agents to load only the focused references needed for the task (`CLAUDE.md:79-90`).

**Decision: Change.** Raven should keep a short precedence chain and progressive disclosure, but compile it into one machine-readable policy registry plus concise task packets. Nana's rule appears in multiple summaries, increasing the chance of drift. User-visible value is predictable behavior; the cost is prompt length and contradictory copies.

## 2. Prompts and agent instructions

Nana's “prompts” are primarily repository contracts and frozen worker packets rather than ad hoc chat templates. Before dispatch, the main thread must inject a context bundle containing scope, existing entities/concepts/sources, naming rules, exact write paths, evidence rules, acceptance criteria, verification lenses, stop conditions, iteration identity, and fingerprints (`docs/agent-contract/fanout-and-verification.md:28-44`). The NRS task packet repeats study, envelope, source eligibility, roles, ceilings, inventories, exact writes, budgets, dependencies, retry rules, and hashes (`docs/agent-contract/research-system/iteration-and-orchestration.md:63-75`).

The worker completion contract is “write first”: chat is not the deliverable; the worker must persist and reopen artifacts and ledgers, after which the orchestrator repeats the checks (`docs/agent-contract/fanout-and-verification.md:72-103`; `docs/agent-contract/research-system/iteration-and-orchestration.md:69-75`).

**Decision: Keep, with templating.** Raven should generate role-specific packets from typed fields rather than paste a giant shared bundle. The user-visible value is fewer hallucinated paths, duplicated entities, and scope leaks. The complexity is justified for multi-agent runs, but not for bounded single-agent questions.

The human README also supplies simple conversational patterns for ingest, comparison, synthesis, and lint (`README.md:185-207`).

**Decision: Drop as architecture.** Keep these as UI examples/onboarding, not executable workflow authority; they are useful documentation but should not determine behavior.

## 3. Workflow and state machines

### 3.1 Query versus coordinated study

Nana intentionally avoids creating a study for every question. Bounded, read-only, non-persistent queries remain ordinary Query operations; NRS is reserved for persistent multi-source synthesis, controlled promotion, dependencies, long iteration, independent acceptance, or high-impact governance (`docs/agent-contract/research-system/README.md:5-17`).

**Decision: Keep.** Raven needs a visible “quick answer” versus “audited research” mode, selected automatically by risk with user override. This avoids burdening every answer with NRS latency.

### 3.2 NRS lifecycle

The canonical path is `draft → review → ready-for-launch → running → verification → closeout → archived`, with `blocked`, `paused`, `abandoned`, and `superseded` side states and tightly limited repair loops (`docs/agent-contract/research-system/README.md:48-65`; `studies/README.md:104-116`). Iterations are bounded work units inside `running`, not states or acceptance (`docs/agent-contract/research-system/README.md:97-103`).

**Decision: Change.** Preserve the semantic distinctions, but Raven should expose a smaller user model: `scoping → researching → verifying → delivered`, with `paused/blocked/cancelled`; internal substates can retain readiness and closeout. The Nana state chart is defensible, but the number of persisted transition artifacts increases latency and user confusion.

### 3.3 Scope Envelope and material deltas

Every study freezes questions, actors, periods, domains, evidence classes, outputs, write surfaces, caps, claim ceilings, acceptance and stop tests. Adaptation within those bounds is allowed; a material delta stops dispatch, quarantines output, preserves the old envelope, creates a new version, and returns to review (`docs/agent-contract/research-system/README.md:77-95`; `docs/agent-contract/research-system/iteration-and-orchestration.md:11-25`).

**Decision: Keep the invariant; Change the implementation.** Raven should store one versioned scope object and display a human-readable diff when scope expands. It should not require users to understand `E1/E2` or a collection of separate control files. Value: prevents surprise research and cost expansion. Cost: a small confirmation pause only on real deltas.

### 3.4 Launch and confirmation semantics

Nana contains two incompatible launch models. Legacy R-rounds require both `ready-for-launch` and the exact phrase `launch research R<N>` (`plans/README.md:65-83`). Active NRS explicitly removed the launch phrase: after exact readiness is installed, it automatically attempts an exclusive lease and runs without asking again (`docs/agent-contract/research-system/README.md:91-95`; `studies/README.md:139-149`). High-impact semantic, schema, publication, destructive, profile/config, and material-scope changes still require explicit approval (`CLAUDE.md:63-74`). Pause/resume requires clear user intent, while blockers and material deltas cannot be cleared by an ambiguous `continue` (`docs/agent-contract/research-system/recovery-closeout-and-legacy.md:34-42`).

**Decision: Change.** Raven should use one confirmation policy:

1. bounded read-only research starts immediately;
2. first clearly scoped durable run starts immediately when the user's request already authorizes it;
3. confirm only material scope/cost/output changes, destructive actions, publication/external side effects, or sensitive data use;
4. resume from an explicit user pause requires user intent but no magic phrase.

Exact command phrases should be **Drop**. They add ceremony without improving understanding; Nana's own NRS evolution removed them.

### 3.5 Exclusive execution lease

NRS and legacy R share one atomic filesystem lease. Tests show one winner under concurrent acquisition, cross-system exclusion, hash-identical acquisition records, holder-only release, and fail-closed behavior on terminal objects (`tests/harness/test_research_execution_lease.py:65-100`, `102-153`).

**Decision: Change.** Keep idempotent run ownership and atomic acquisition, but scope leases per Raven workspace/project or shared write surface rather than globally permitting only one research object. Global serialization protects Nana's mutable filesystem, but it unnecessarily blocks independent user work and raises latency.

## 4. Agent topology and orchestration

Nana's topology is intentionally asymmetric:

- the **main agent** owns research judgment, synthesis, integration, and final verification;
- isolated research workers handle independent evidence questions;
- fresh independent verifiers inspect persisted bytes rather than worker reasoning;
- concurrent writers must have exclusive, non-overlapping paths;
- shared indexes, synthesis, conflict resolution, and promotion remain serialized (`CLAUDE.md:49-54`; `docs/agent-contract/fanout-and-verification.md:16-18`, `56-70`; `docs/agent-contract/research-system/iteration-and-orchestration.md:69-75`).

The required fan-out shape is `prepare → isolated researchers → persisted artifacts/ledgers → isolated adversarial verification → main-thread acceptance → integration` (`docs/agent-contract/fanout-and-verification.md:7-18`).

**Decision: Keep.** This is a strong Raven topology. User-visible value is robust parallelism without consensus masquerading as truth. Complexity is acceptable for coordinated runs; Raven should skip separate verifier agents for low-risk claims and use deterministic checks plus targeted review instead.

Nana sometimes uses model-family diversity as a challenge tool. An actual R15 record fed the same evidence packet to two models to make differences attributable to reasoning rather than unequal retrieval (`wiki/workflows/r15-darpa-dual-model-2026-06-08/README.md:16-21`, `43-47`). R17 adversarial passes caught common-mode retrieval risk, category errors, presentism, and re-grounded a plan in existing repository knowledge, but also incurred 119–193 second passes and an HTTP failure at higher effort (`wiki/workflows/r17-plan-adversarial-review-2026-06-10/README.md:21-30`, `34-54`, `56-80`).

**Decision: Change.** Use second-model review selectively for plan risk, disputed synthesis, or high-consequence conclusions, not by default. The visible quality gains are real, but the recorded latency is material.

## 5. Evidence, citation, and truth validation

### 5.1 Claim ledger

Nana states that a bibliography is not a ledger and a URL is not an inspected source. Material propositions receive stable claim IDs and rows containing source identity, anchor/locator, family independence, evidence role, current state, ceiling, contradictions, and lineage (`docs/agent-contract/research-system/evidence-and-lineage.md:11-26`, `28-43`, `45-60`). Compound claims must split when one anchor supports only part (`docs/agent-contract/research-system/evidence-and-lineage.md:43-43`).

**Decision: Keep.** This should be central to Raven. The UI can hide row-level machinery until users expand “Evidence,” but every substantive output should be traceable.

### 5.2 Anchors are necessary but not sufficient

Anchor verification separates source retrieval, literal presence, locator resolution, clause-level semantic support, source-role permission, and current/version validity (`docs/agent-contract/research-system/evidence-and-lineage.md:62-80`). Nana's reusable `verify_anchors.py` reopens ledger rows and handles CJK encoding, composite anchors, user-agent blocks, throttling, and conservative normalization (`.harness/README.md:87-109`).

**Decision: Keep.** Raven should combine deterministic anchor reopening with model-assisted entailment checks. Literal matching alone must never produce a green semantic verdict.

### 5.3 Source-family independence and claim ceilings

Mirrors, translations, syndication, common briefings/data/events, and downstream reporting without added observation count as one family; model agreement has zero evidentiary independence (`docs/agent-contract/research-system/evidence-and-lineage.md:82-94`). Status ladders distinguish intent, contract, prototype, test, deployment, implementation, and measured effect; evidence cannot support wording above its observed state (`docs/agent-contract/research-system/evidence-and-lineage.md:95-110`).

**Decision: Keep.** These are high-value safeguards against citation laundering and status inflation. Raven should render them as concise badges such as “official intent,” “vendor self-report,” “deployed,” and “independently measured.”

### 5.4 Current facts, negative evidence, and contradictions

Volatile facts require `as_of`, version/supersession checks, and fresh main-thread inspection before final use (`docs/agent-contract/research-system/evidence-and-lineage.md:112-125`). Non-hits only support absence within a named corpus; contradictions are retained rather than averaged away (`docs/agent-contract/research-system/evidence-and-lineage.md:127-131`).

**Decision: Keep.** User-visible value is honest freshness and uncertainty. Automate timestamping and corpus descriptions to minimize authoring latency.

### 5.5 Actual ledger evidence

The real A01 ledger demonstrates the model in practice: official policy rows distinguish documentary requirements from implementation/outcome claims; current pages carry `as_of`; vendor/office descriptions are capped as self-report; every row remains `PROVISIONAL` pending fresh verification and main-thread acceptance (`artifacts/proj-modern-tech-us-military-asset-management/research/ledgers/A01.jsonl:1-7`).

This supports that the ledger is not purely aspirational, although it also shows schema heaviness: seven rows carry dozens of repeated fields. **Change:** Raven should normalize source metadata and family data into shared records, keeping claim rows compact.

## 6. Verification and acceptance

Nana treats acceptance levels as separate and non-transitive: iteration closure, task/phase acceptance, study acceptance, source/wiki promotion, writing acceptance, and publication are distinct (`docs/agent-contract/research-system/verification-and-acceptance.md:11-24`). Verifiers use fresh contexts, read persisted bytes, are read-only by default, and rerun after substantive changes (`docs/agent-contract/research-system/verification-and-acceptance.md:26-42`, `96-111`). Mandatory lenses include raw fidelity, consistency, fabrication, identity/independence, ceiling/status, current state, contradictions, scope/dependency, privacy, and final bytes (`docs/agent-contract/research-system/verification-and-acceptance.md:44-48`). High-risk facts—quotes, precise numbers, identities, status transitions, disputed/causal claims, vendor capability, current facts—receive 100% direct inspection (`docs/agent-contract/research-system/verification-and-acceptance.md:50-63`).

**Decision: Keep, risk-adaptively.** Raven should retain non-transitive gates and direct inspection rules, but offer three verification profiles:

- **Fast:** deterministic citation/path checks and targeted semantic review;
- **Standard:** independent verification of load-bearing claims;
- **Audit:** full claim census, lineage, and final-byte manifest.

Nana's universal lens list is excellent as a checklist but too expensive as a mandatory workflow for ordinary answers.

Final acceptance remains a main-thread responsibility; verifier booleans, worker completion, and parser success cannot accept output (`docs/agent-contract/research-system/verification-and-acceptance.md:113-119`; `docs/agent-contract/fanout-and-verification.md:185-202`).

**Decision: Keep.** It prevents authority laundering through automated statuses.

## 7. Failure behavior and recovery

Nana's retry ladder is bounded: resume useful partial work once, respawn in a fresh context once, switch method once, then defer/block; deterministic blockers may skip directly to method switch or deferral (`docs/agent-contract/fanout-and-verification.md:158-167`; `docs/agent-contract/research-system/iteration-and-orchestration.md:116-127`). Partial failures preserve passing artifacts, explicitly exclude failed claims, inspect dependencies, and allow partial acceptance only when conclusions are separable (`docs/agent-contract/fanout-and-verification.md:169-183`; `docs/agent-contract/research-system/iteration-and-orchestration.md:129-143`).

**Decision: Keep.** This is simple, observable, and protects both latency and cost. Raven should surface retries and the final blocker in plain language rather than expose internal packet IDs by default.

Recovery reconstructs the last valid state from durable bytes, classifying outputs as durable, stale, partial-unverified, not-started, externally blocked, or quarantined; later labels are merely claims until artifacts and hashes reconcile (`docs/agent-contract/research-system/recovery-closeout-and-legacy.md:9-32`). Unauthorized starts stop workers, preserve an incident, quarantine output, restore the last valid state, and prohibit promotion until normal readiness (`docs/agent-contract/research-system/recovery-closeout-and-legacy.md:44-55`).

**Decision: Keep the semantics; Change the receipt burden.** Raven should persist a compact event log and artifact status table, not multiple bespoke incident documents unless audit mode is selected.

## 8. Artifact lifecycle and writing

Nana preserves every substantive writing version, records lineage, and reserves `final.md` for accepted—not merely latest—content (`docs/agent-contract/artifact-writing-and-closeout.md:44-63`). Writing contracts capture audience, purpose, style, formats, length, source set, and closeout checks before drafting (`docs/agent-contract/artifact-writing-and-closeout.md:14-36`). Research acceptance does not automatically authorize drafting, final labeling, publication, or new evidence collection (`docs/agent-contract/artifact-writing-and-closeout.md:38-42`). Final verification runs against the exact candidate-final file after substantive edits (`docs/agent-contract/artifact-writing-and-closeout.md:150-173`).

**Decision: Keep.** Raven should expose immutable versions and status labels (`draft`, `verified`, `accepted`, `published`) in a single artifact timeline.

Nana's specific “Notepad total Unicode-character count” as final length authority is domain-specific (`docs/agent-contract/artifact-writing-and-closeout.md:99-112`).

**Decision: Drop.** Raven should support configurable count metrics per deliverable rather than hard-code one editor's display semantics.

Archive is staged: route accepted outputs to owners, preserve reviews/negative results/incidents, update indexes, clean scratch only after manifest accounting, run checks, then set `archived` (`docs/agent-contract/research-system/recovery-closeout-and-legacy.md:87-101`). Archived studies are immutable except attributed addenda; new research gets a linked new ID (`docs/agent-contract/research-system/recovery-closeout-and-legacy.md:103-120`).

**Decision: Keep.** The user-visible value is reproducibility and safe correction without rewriting history.

## 9. Tests and executable enforcement

Nana's tests are strongest around lifecycle plumbing:

- lease races and cross-system exclusivity (`tests/harness/test_research_execution_lease.py:65-100`);
- fail-closed release and identity validation (`tests/harness/test_research_execution_lease.py:102-167`);
- readiness record identity/hash matching and canonical path enforcement (`tests/harness/test_research_execution_lease.py:168-211`);
- minimal study fixtures, automatic readiness start, hash mismatch, date validation, dependency closure, `as_of`, prelaunch artifacts, review manifests, and stale readiness bindings (`tests/harness/test_research_system_validate.py:221-316`, `345-390`).

The validator explicitly remains structural and cannot repair, transition, accept, or promote a study (`.harness/README.md:111-120`).

**Decision: Keep.** Raven should make transition invariants, idempotency, stale binding, path ownership, and evidence schema executable. **Change:** invest proportionally more in end-to-end research quality fixtures and fewer migration-specific exact-byte cases. The Nana test file's 1,331 lines and extensive migration compatibility checks signal a maintenance-heavy control plane (`tests/harness/test_research_system_validate.py:1-500`; file continues to line 1331).

## 10. Packaging and integration patterns

Nana is packaged as:

1. a repository kernel at `AGENTS.md → CLAUDE.md`;
2. focused contracts under `docs/agent-contract/`;
3. method packs for discovery, breadth, deep dive, claim verification, comparative synthesis, extraction, handoff, and maintenance;
4. typed-ish templates and JSON/JSONL control artifacts;
5. standalone Python helpers and unit tests;
6. profile-local skills acting only as routers into repository-owned authority (`CLAUDE.md:55-61`, `79-90`; `docs/agent-contract/research-system/README.md:19-32`).

The deep-dive method pack is a concrete example: it defines trigger/non-trigger, frozen inputs, retrieval and evidence lanes, atomic rows, dossier output, direct reopening, verification, pilot scale-out, failure handling, and authority boundaries (`docs/agent-contract/research-system/method-packs/deep-dive.md:1-25`, `27-54`, `66-97`). Comparative synthesis similarly consumes only accepted inputs, builds a case-by-axis matrix, preserves pool walls and non-isomorphism, tests alternatives, and produces bounded results rather than publication prose (`docs/agent-contract/research-system/method-packs/comparative-synthesis.md:20-44`, `46-89`).

**Decision: Change.** Raven should package these as composable runtime capabilities with typed inputs/outputs and generated prompts, while preserving readable Markdown documentation. Do not make prose documents the sole executable state machine.

The “add a helper only after 2+ repeated rounds; prefer single-shot scripts and common dependencies” rule is excellent (`.harness/README.md:194-205`).

**Decision: Keep.** It resists premature framework building.

## 11. Actual examples and what they reveal

### Example A — dual-model evidence-shared comparison

R15 used one model to collect 15 primary sources and create a baseline, then gave the identical packet to a second model. The second model changed weighting, merged themes, introduced a sustainment framing, and warned against over-attribution (`wiki/workflows/r15-darpa-dual-model-2026-06-08/README.md:16-41`). This is evidence that model diversity can add value **when retrieval is controlled**.

**Raven lesson: Keep selectively.** Offer “challenge this analysis” as an explicit step, not automatic duplicate research.

### Example B — adversarial plan review

R17's independent review detected a common-mode retrieval bottleneck and redefined success around adjudicated promotions rather than fetched documents; later passes caught category errors and repository “research-line amnesia” (`wiki/workflows/r17-plan-adversarial-review-2026-06-10/README.md:21-30`, `34-53`, `56-74`).

**Raven lesson: Keep.** Plan challenge is valuable before expensive fan-out. **Change:** cap it to a short structured critique unless risk warrants deeper review.

### Example C — live NRS pilot blocked before work

The live pilot has a detailed scope, 19 probe cases, exact output ownership, frozen method profile, and multiple review passes, but remains `blocked` before launch because stale prose and a legitimately changed legacy baseline invalidate exact readiness; `opened` is null and both ledgers are empty (`studies/active/NRS-2026-001-nrs-cutover-reproducibility-pilot/study.md:24-58`, `77-105`; `studies/active/NRS-2026-001-nrs-cutover-reproducibility-pilot/control/iteration-record.jsonl:1-1`; `studies/active/NRS-2026-001-nrs-cutover-reproducibility-pilot/control/evidence-ledger.jsonl:1-1`).

**Raven lesson: Change aggressively.** Hash evidence artifacts and code versions, but do not make incidental prose bytes or unrelated legacy baselines part of the launch-critical root unless they can change semantics. This is the clearest example of accidental complexity creating user-visible zero progress.

### Example D — historical scope violation became policy

A historical case records a worker writing beyond its exclusive path and a post-closeout “supplement” mutating archived research. The current contract extracts only the invariant: quarantine out-of-scope bytes, do not retroactively authorize them, and create new linked work for material post-archive research (`docs/agent-contract/research-system/cases/r20-supplement-and-scope-violation.md:23-46`, `50-60`).

**Raven lesson: Keep.** Turn incident lessons into regression tests and concise policy, not ever-growing historical procedure.

## 12. Intentional design versus accidental complexity

### Appears intentional

1. **Epistemic separation:** fact/report/inference/judgment/controversy/unknown must remain distinguishable (`CLAUDE.md:11-20`).
2. **Purpose-owned storage layers:** source, knowledge, writing, control, code, and scratch are deliberately distinct (`docs/agent-contract/ownership-and-layout.md:19-37`, `162-181`).
3. **Human retains high-impact judgment:** users choose sources and arbitrate contradictions; agents handle routine maintenance within bounds (`README.md:16-18`; `docs/agent-contract/ownership-and-layout.md:37-37`).
4. **Parallelism only for independent questions:** main-thread judgment and integration remain serial (`CLAUDE.md:49-54`).
5. **Evidence ceilings and independence:** prevent source laundering and status inflation (`docs/agent-contract/research-system/evidence-and-lineage.md:82-110`).
6. **Non-transitive gates:** prevents a worker status, parser, or research acceptance from becoming publication authority (`docs/agent-contract/research-system/verification-and-acceptance.md:11-24`).
7. **Bounded recovery and preserved negative results:** controls cost and avoids fabricated completeness (`docs/agent-contract/fanout-and-verification.md:158-183`).
8. **Immutable version and archive provenance:** supports rollback and later audit (`docs/agent-contract/artifact-writing-and-closeout.md:44-63`; `docs/agent-contract/research-system/recovery-closeout-and-legacy.md:103-120`).

### Appears accumulated or accidental

1. **Dual lifecycle systems.** Legacy R and NRS coexist with incompatible launch semantics and a compatibility layer (`plans/README.md:1-7`, `74-83`; `docs/agent-contract/research-system/README.md:111-115`). This is migration sediment, not a target architecture.
2. **Repeated authority/non-authority prose.** Almost every module restates what it does not authorize. This arose defensively from prior scope failures, but duplicates policy and consumes context.
3. **Exact-byte closure over broad dependency graphs.** Hashing semantic inputs is intentional; binding incidental prose and legacy baselines can halt valid work, as the pilot demonstrates (`studies/active/NRS-2026-001-nrs-cutover-reproducibility-pilot/study.md:77-105`).
4. **Receipt and snapshot explosion.** The live study contains many pass snapshots and control artifacts while no research iteration exists; this shifts effort from research to proving readiness.
5. **Global single execution lease.** It is a simple response to shared-write risk, but serializes unrelated work (`tests/harness/test_research_execution_lease.py:65-85`).
6. **Schema duplication per evidence row.** Real ledgers repeat source metadata, organization, dates, family, and status in each row (`artifacts/proj-modern-tech-us-military-asset-management/research/ledgers/A01.jsonl:1-7`).
7. **Migration-heavy tests.** Extensive checks around removed fields, compatibility schemas, cutover receipts, and legacy invariance are necessary during migration but should not define Raven's permanent core (`tests/harness/test_research_system_validate.py:225-237`, `345-440`).
8. **Domain-specific acceptance rules in general writing architecture.** The Notepad character-count rule is an example (`docs/agent-contract/artifact-writing-and-closeout.md:99-112`).

## 13. Consolidated Keep / Change / Drop recommendations

### Keep

- Purpose-owned artifact layers and explicit promotion.
- Immutable source originals and versioned deliverables.
- Stable study/run, claim, source, and iteration identities.
- Claim-to-source ledgers with anchors, locators, family independence, roles, ceilings, contradictions, and `as_of`.
- Fresh-context verifier inspecting persisted artifacts, not hidden reasoning.
- Main-thread acceptance and synthesis.
- Exclusive write ownership for concurrent workers.
- Bounded retry: resume once, respawn once, switch once, then defer.
- Partial-result semantics and dependency-aware exclusion.
- Explicit scope boundaries and versioned material-delta diffs.
- Deterministic validation for paths, schemas, hashes, citations, and state transitions.
- Immutable archive with attributed addenda/new linked runs.

### Change

- Replace multiple prose state machines with one typed Raven state model.
- Keep internal readiness/closeout substates but show users a simpler lifecycle.
- Generate compact role-specific prompts from a single scope/policy object.
- Normalize evidence storage into source records + claim-source edges rather than repeating all fields.
- Make verification risk-adaptive instead of universally maximal.
- Scope leases to affected workspaces/write surfaces rather than one global research lease.
- Hash semantic inputs and artifacts, not every incidental instruction/prose dependency.
- Use dual-model review only for high-risk planning or disputed conclusions.
- Convert method packs into typed runtime capabilities with Markdown documentation.
- Use one event log plus compact receipts by default; reserve full audit bundles for Audit mode.

### Drop

- Exact magic launch phrases.
- Parallel legacy/new lifecycle systems in the Raven target design.
- User-visible `E1/E2`, receipt, hash, and allocator jargon unless Audit details are expanded.
- Duplicate restatement of non-authority boundaries in every module.
- Global single-study execution serialization.
- Notepad-specific length authority as a general rule.
- Automatic second-model duplication for routine research.
- Migration-only compatibility schemas and snapshot forests after Raven stabilizes.

## 14. Proposed Raven shape

A Raven implementation informed by Nana should have six core objects:

1. **ResearchRun** — objective, risk tier, scope version, state, budgets, owner, and user gates.
2. **Task** — isolated question, dependencies, exclusive writes, attempt budget, and status.
3. **Source** — canonical identity, provenance, family, retained content/version, and access state.
4. **Claim** — atomic proposition, disposition, ceiling, uncertainty, contradictions, and accepted level.
5. **EvidenceEdge** — claim ↔ source anchor/locator, role, independence, `as_of`, verifier status.
6. **ArtifactVersion** — immutable bytes, lineage, verification state, audience/style contract, and publication status.

The default user journey should be:

```text
ask → Raven scopes and states evidence/latency plan → research tasks run
→ claims and sources appear with live coverage → targeted independent verification
→ main synthesis → deliver artifact + evidence drawer + gaps/failed routes
```

A material scope/cost/publication/destructive change pauses with a concise diff. Everything else proceeds autonomously inside the user's request. Audit mode expands the same objects into manifests and receipts; it should not require an entirely different research system.

## Bottom line

Nana's durable contribution is not its exact NRS paperwork. It is the principle that **research completion is an evidence- and acceptance-backed state, not a worker message, file existence, citation list, model consensus, or polished prose** (`docs/agent-contract/fanout-and-verification.md:72-125`, `185-216`; `docs/agent-contract/research-system/verification-and-acceptance.md:11-24`). Raven should preserve that principle and the mechanisms closest to it, while removing migration sediment, duplicate contracts, broad exact-byte launch roots, and default audit-level ceremony. That combination retains user trust and recoverability while materially reducing latency and cognitive load.
