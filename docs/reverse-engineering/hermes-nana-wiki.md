# Hermes Nana Research Wiki: Evidence-Integrity Lessons for Raven

## Scope and method

This is a read-only audit of `C:\Users\lhan\AppData\Local\hermes\profiles\nana\skills\research\nana-research-wiki` against Raven's session-scoped contract in `docs/design/architecture.md` and `CONTEXT.md`. Nothing under the Hermes directory was modified.

The corpus contains 93 files. I read `SKILL.md` first, then prioritized contract/invariant/verification/failure-recovery and provenance/knowledge-hygiene references. This is not an argument for adding a wiki, persistent knowledge base, vector store, external ledger, worker bureaucracy, or Nana's repository lifecycle to Raven.

### Files read in full

- `SKILL.md`
- `references/artifact-only-breadth-shard-execution.md`
- `references/artifact-only-breadth-independent-verification.md`
- `references/bounded-candidate-packet-execution.md`
- `references/candidate-packet-source-status-accounting-verification.md`
- `references/claim-narrowing-verification-active-semantics.md`
- `references/deep-dive-compound-anchor-repair.md`
- `references/fact-check-protocol.md`
- `references/integrated-task-exact-byte-all-of-verification.md`
- `references/provisional-packet-full-reverification-example.md`
- `references/recursive-attribution-remap-and-id-collision.md`
- `references/same-source-identity-closure-before-integrated-review.md`
- `references/temporal-eligibility-integrated-population-repair.md`

I also searched all Markdown reference files for provenance, contradiction, confidence, independence/family, drift, staleness/supersession, and byte/hash terminology before selecting the files above.

## Executive assessment

Nana's highest-value transferable idea is not its repository machinery. It is a small set of semantic invariants:

1. provenance must terminate at an inspected source identity and literal passage;
2. support, challenge, and unresolved contradiction must remain explicit data;
3. evidence ceilings and dispositions must prevent provisional material from becoming accepted merely through reuse;
4. source identity must be separated from host/representation and from epistemic independence;
5. current verification must reopen sources and distinguish present drift from an earlier persisted misstatement;
6. stale evidence and negative findings need explicit supersession rather than deletion or silent retention;
7. success must be checked against final bytes, not inferred from a worker, tool, or script's message.

Raven already implements much of this. The most material gaps are contradiction structure, explicit support ceilings/contested-state handling, and stronger source-origin/family semantics.

## Transferable findings

### 1. Preserve a complete Claim → Source → exact passage chain

**Verdict: KEEP, with a small tightening.**

Nana treats search results as leads, requires opening the original body, and stores canonical URL, exact anchor, and locator (`references/artifact-only-breadth-shard-execution.md:12-14`). It further requires every material clause of a compound claim to be carried by the stored anchor; a broader live page does not cure an incomplete persisted quote (`references/deep-dive-compound-anchor-repair.md:11-20`). Verification must map each reopened source to every row it supports and separately test literal-anchor completeness and current-source semantic support (`references/candidate-packet-source-status-accounting-verification.md:7-10`). Recursive ID verification prevents nested contradiction or negative-evidence references from silently resolving to the wrong canonical source (`references/recursive-attribution-remap-and-id-collision.md:5-31`).

**Raven application:** retain Raven's stable Source ID, canonical URL, locator, bounded verbatim excerpt, Claim source IDs, generated Claim trace, unknown-ID rejection, and source reopening. Tighten semantic guidance/tests so each external Claim is atomic enough that every material clause is supported by its linked excerpts. If a claim requires two non-contiguous passages, represent them as two Sources or add an explicitly bounded multi-excerpt model later; do not concatenate passages into a false quotation. Verify every machine-readable Claim/Source reference, not only rendered citations.

This fits Raven's current Source-before-Claim design and does not require Nana's ledger, wiki, or raw archive.

### 2. Represent contradictions as first-class unresolved relationships

**Verdict: CHANGE.**

Nana requires candidate rows to carry contradiction/negative evidence and includes contradiction sections in the artifact (`references/bounded-candidate-packet-execution.md:21-24`, `:26-36`). Its integrated verifier requires each contradiction to preserve both evidence sides (or an explicitly missing side), affected scope, disposition, and semantic consequence rather than silently selecting a winner (`references/integrated-task-exact-byte-all-of-verification.md:65-80`). Stale contradiction/negative rows receive a current-population disposition such as `SUPERSEDED`, narrower ceiling, still-bounded, or process-history-only (`references/temporal-eligibility-integrated-population-repair.md:18-28`).

**Raven application:** Raven's current `Limitation` can disclose an unresolved contradiction, but it does not preserve the two Claim/Source sides structurally. Add the leanest possible session-state representation: either a `Contradiction` record referencing Claim IDs, or a typed Limitation payload with `claimIds`, `sourceIds`, `disposition`, and concise consequence. Allowed outcomes should include unresolved, narrowed, source-stale, and superseded. Completion may proceed with an explicit contradiction Limitation only when the Artifact is correspondingly qualified; no side may silently become `supported` solely because it appears in the final prose.

Do not import Nana's slot graph, acceptance packets, or multi-review lifecycle.

### 3. Prevent low-support or contested content from hardening into fact

**Verdict: CHANGE.**

Nana explicitly labels single-family material `SINGLE-SOURCE`, prohibits downstream fact consumption, and keeps contested/self-report material outside accepted-fact denominators (`references/artifact-only-breadth-shard-execution.md:14-17`). It separates source/claim ceilings from maturity and effect: proposal, pilot, deployment, use, output, and outcome are not interchangeable (`references/bounded-candidate-packet-execution.md:21-22`, `:38-44`). Packet acceptance and task acceptance are independent; honest provisional closure does not authorize promotion (`references/candidate-packet-source-status-accounting-verification.md:40-50`). A repaired packet is still kept deferred when provenance/accounting is unprovable (`:27-38`).

**Raven application:** keep `supported | qualified | deferred | rejected` and external-vs-analysis distinctions, but make hardening rules executable:

- a `qualified` Claim must retain its qualification in the Artifact;
- a `deferred` or `rejected` Claim must not render as accepted support;
- unsupported analysis must not masquerade as externally verified fact;
- an external Claim backed only by self-report, a single origin family, historical evidence, or contested sources should default to `qualified` unless its text is explicitly attributed and bounded;
- completion should fail or downgrade to `completed-with-limits` when the final Artifact exceeds the Claim's recorded ceiling.

Raven should not add a universal numeric confidence score. Nana's useful lesson is categorical evidence ceilings and visible dispositions; numeric confidence would invite false precision and increase state complexity.

### 4. Detect source drift by reopening, but distinguish drift from persisted error

**Verdict: KEEP.**

Nana hashes the worker capture and verifier capture where available; identical captures plus divergent artifact wording indicate persisted misstatement, not later source drift (`references/artifact-only-breadth-independent-verification.md:34-47`). A current browser reopen verifies the live body but does not retroactively prove worker-time capture or byte identity (`references/candidate-packet-source-status-accounting-verification.md:7-10`, `:18-24`). Re-hashing inputs before and after semantic review detects concurrent mutation (`references/artifact-only-breadth-independent-verification.md:5-12`).

**Raven application:** Raven's completion-time URL reopen and excerpt match is the correct lean mechanism. Preserve `inspectedAt`, `asOf`, and source-check observations. On mismatch, distinguish at least:

- unavailable/retrieval failure;
- resolved-identity or host drift;
- excerpt mismatch (content drift or wrong original capture);
- reachable and excerpt-matched.

Do not claim historical byte identity from a current reopen. If Raven does not retain the original full body—and it deliberately should not—report the bounded fact: the recorded excerpt no longer matches the current body. Existing behavior that defers Claims whose usable support disappears is sound.

### 5. Model originating record separately from host and representation

**Verdict: CHANGE.**

Nana deduplicates syndicated copies into one source family: a second host carrying the same originating article is a fallback URL, not corroboration (`references/artifact-only-breadth-shard-execution.md:16-17`). Hosting is not ownership; a regulator-hosted page credited to another publisher does not become regulator-independent evidence (`references/deep-dive-compound-anchor-repair.md:22-24`). A product page and PDF of the same report are one source identity, while representations and tool opens are counted separately (`references/same-source-identity-closure-before-integrated-review.md:5-14`; `references/integrated-task-exact-byte-all-of-verification.md:99-111`). Institutional lineage is conservative: multiple reports or subordinate outlets may remain one epistemic family (`references/candidate-packet-source-status-accounting-verification.md:7-16`).

**Raven application:** Raven already has optional `sourceFamily`; make its intended semantics explicit and test it:

- family identifies the originating record or epistemic lineage, not merely the current host;
- mirrors, syndication, translations, print/AMP pages, and HTML/PDF representations of one record are not independent support;
- multiple Source IDs may exist when locators/excerpts differ, but Claim support should count unique usable families when independence matters;
- lack of a family value must not be interpreted as proof of independence.

Avoid a canonical global family map or persistent deduplication service. The main agent supplies a bounded session-local family label; Raven enforces conservative counting only where a Claim or completion policy explicitly relies on independence.

### 6. Preserve stale and superseded records, but remove their current semantic authority

**Verdict: CHANGE.**

Nana does not delete stale rows. It preserves iteration history while assigning a current disposition and replacement/narrowing consequence (`references/temporal-eligibility-integrated-population-repair.md:18-28`). Out-of-period sources can remain lineage-only while losing every load-bearing role (`:9-16`). When a later iteration opens a source that was previously unavailable, the old retrieval failure must be explicitly superseded instead of continuing as current negative evidence (`references/integrated-task-exact-byte-all-of-verification.md:78-84`, `:123-131`). Claim narrowing retains removed clauses as provenance while excluding them from active semantics (`references/claim-narrowing-verification-active-semantics.md:5-22`).

**Raven application:** preserve immutable Checkpoints and Steering Revisions as historical truth, but make current authority explicit:

- a fresh source check supersedes the prior check for completion policy without erasing it from audit history;
- a narrowed/deferred/rejected Claim should retain its prior identity/history but only its current disposition may affect the latest Artifact;
- Limitations should carry current vs superseded status, or be regenerated deterministically so stale limitations cannot survive as present facts;
- `asOf` should be enforced semantically for claims that assert current status; access time alone cannot refresh an old proposition.

Do not add Nana's append-only repository repair receipts. Raven's monotonic Task revision, immutable Checkpoints, Claim dispositions, and latest verification receipt are sufficient if their active-vs-historical semantics are explicit.

### 7. Verify actual final bytes, not claims of successful execution

**Verdict: KEEP; DROP the runtime-specific ceremony.**

The Nana skill itself states that worker/scheduler completion is not evidence and requires checking the real artifact and owning gate (`SKILL.md:31-42`). Its references repeatedly require reopening final files, parsing them, and hashing only after the last write (`references/bounded-candidate-packet-execution.md:21-24`, `:46-57`, `:78-87`). Independent verification binds pre-read hashes and requires the same hashes at close (`references/artifact-only-breadth-independent-verification.md:5-12`). A verifier must test artifact behavior rather than print a success marker; later mutation invalidates prior hashes (`references/artifact-only-breadth-shard-execution.md:28-34`, `:70-79`). The integrated audit likewise recomputes every bound hash and byte count before and after review (`references/integrated-task-exact-byte-all-of-verification.md:5-15`).

**Raven application:** Raven's completion rule is exactly right: hash the candidate Artifact bytes and require equality with the latest post-steer Checkpoint fingerprint. Keep source re-verification in the same completion operation and reject any completion based on worker/tool termination. Add tests proving that newline, Unicode normalization, citation rendering, or one-character edits fail exact-byte completion unless first checkpointed.

**Drop:** Nana's OS-temp verifier naming, terminal metadata registration, self-deletion, repository diff gates, commit-bound manifests, and independent-review packet ceremony (`references/artifact-only-breadth-shard-execution.md:28-68`; `references/artifact-only-breadth-independent-verification.md:78-86`). These solve Nana/Hermes repository acceptance and runtime-observability constraints, not Raven's in-process domain problem. Raven needs deterministic engine tests and exact byte comparison, not an external verifier ledger.

## General lessons versus Nana-specific bureaucracy

### Keep as general evidence-integrity rules

- Search/snippet/model output is a lead until the original is inspected.
- Canonical source identity, origin/family, representation, and host are distinct concepts.
- A Claim should be atomic and proposition-completely supported by its linked excerpts.
- Contradictions and negative evidence remain explicit and traceable.
- Claim disposition and evidence ceiling govern what may enter the final Artifact.
- Reopen sources at checkpoint/completion and report bounded drift observations honestly.
- Preserve historical provenance while explicitly superseding stale semantic authority.
- Reopen and hash final bytes after the final mutation; completion messages are not verification.

### Drop as Nana-repository-specific bureaucracy

- Wiki/raw directory structures and knowledge-page taxonomy.
- NRS/R-round IDs, packet launches, shards, leases, role-slot/all-of matrices, study registers, and acceptance manifests.
- Retrieval budget ledgers, backend-slot accounting, worker attempt logs, and cross-iteration accounting.
- Persistent source-family maps and accepted-fact promotion authorities.
- Git checkpoints, commit authorship rules, worktree-recovery receipts, hash DAGs, readiness transactions, and immutable prelaunch packets.
- OS-temp verifier ceremony and runtime-specific `verification_evidence` registration.
- Multi-agent independent-review fan-out as a mandatory mechanism.
- A durable archive of full source bodies or a persistent knowledge store.

These mechanisms may be justified inside Nana's long-lived repository, but importing them would contradict Raven's one-Task, same-session, compact-state design.

## Recommended Raven deltas, in priority order

1. **Add structured contradiction linkage** using Claim/Source IDs and explicit unresolved/narrowed/superseded dispositions.
2. **Define executable evidence ceilings** for `qualified`, self-report, historical, contested, and family-limited support; ensure final prose cannot exceed them.
3. **Specify `sourceFamily` as origin/lineage**, not host, and never infer independence from missing family metadata.
4. **Make active-vs-historical semantics explicit** for verification checks, Limitations, and narrowed/deferred Claims.
5. **Extend acceptance tests** for proposition-complete excerpts, same-origin mirrors, stale source mismatch, stale negative-evidence supersession, and exact-byte completion after steering.

## Files not read in full

The following 80 files were inventoried and keyword-searched where applicable but not read exhaustively because the corpus was too large and the prioritized files above already covered the requested evidence-integrity dimensions:

- `references/acyclic-readiness-evidence-and-installer-cloning.md`
- `references/adversarial-plan-review-2026-06-10.md`
- `references/artifact-fact-review-workflow.md`
- `references/artifact-length-constraint-protocol.md`
- `references/artifact-only-deep-dive-pilot-execution.md`
- `references/artifacts-naming-and-structure.md`
- `references/binary-to-md-normalization-2026-06-08.md`
- `references/breadth-persisted-byte-semantic-and-pdf-repair.md`
- `references/breadth-shard-verifier-repair.md`
- `references/browser-first-bounded-replacement-execution.md`
- `references/browser-pdf-readonly-anchor-verification.md`
- `references/chinese-commit-message-hygiene.md`
- `references/cid-font-multicolumn-extraction-2026-06-16.md`
- `references/concurrent-contract-migration-and-head-bound-validation.md`
- `references/consume-round-execution-2026-06-11.md`
- `references/contract-data-rights-candidate-packet.md`
- `references/controller-free-recovery-method-and-readiness.md`
- `references/controller-free-recovery-method-transition-and-readiness.md`
- `references/corrected-chronology-final-method-profile-closure-review.md`
- `references/cron-monitor-hygiene.md`
- `references/cross-iteration-all-of-and-reviewer-shape.md`
- `references/cross-iteration-role-reconciliation.md`
- `references/deep-dive-pilot-targeted-repair.md`
- `references/deterministic-prelaunch-readiness-transactions.md`
- `references/deterministic-readiness-transaction-and-closure-recheck.md`
- `references/dirty-tree-commit-hygiene-2026-06-18.md`
- `references/dual-model-comparison-2026-06-08.md`
- `references/external-search-capability-boundary.md`
- `references/extraction-fidelity-verification-2026-07-06.md`
- `references/fact-check-fanout-vs-r34-audit-2026-06-11.md`
- `references/fetch-cache-md-only-walkthrough.md`
- `references/final-current-independence-digital-twin-outcome-gap-closure.md`
- `references/final-gap-return-integration-and-serial-review.md`
- `references/final-immutable-acceptance-audit-accounting-and-authority.md`
- `references/fresh-breadth-reverify-after-shared-control-repair.md`
- `references/fresh-complete-review-driven-integrated-candidate-repair.md`
- `references/governance-receipt-content-binding-review.md`
- `references/immutable-high-impact-prelaunch-packet-review.md`
- `references/immutable-method-profile-closure-review.md`
- `references/instruction-stack-audit-and-change-control.md`
- `references/late-async-result-triage.md`
- `references/lint-false-positive-hygiene-2026-06-22.md`
- `references/lint-report-newline-hygiene-windows-2026-06-22.md`
- `references/material-envelope-readiness-and-relaunch-closure.md`
- `references/method-disposition-semantic-audit.md`
- `references/method-profile-migration-chain-and-finalization.md`
- `references/method-profile-transition-chain-final-byte-closure.md`
- `references/monitor-cron-audit-2026-06-17.md`
- `references/monitor-cron-governance-2026-06-09.md`
- `references/offline-breadth-helper-verification.md`
- `references/os-temp-ad-hoc-validator-execution.md`
- `references/plan-lifecycle-schema-2026-06-08.md`
- `references/r-round-candidate-ranking-and-scaleout.md`
- `references/r-round-plan-only-vs-launch.md`
- `references/r-round-plan-revision-vs-execution.md`
- `references/r-round-shard-verdict-page.md`
- `references/r-round-supplement-and-retry.md`
- `references/r14-cache-triage-walkthrough.md`
- `references/r18-execution-deltas-2026-06-12.md`
- `references/r19-plan-authoring-2026-06-12.md`
- `references/r20-counter-unmanned-source-pattern.md`
- `references/r20-shard-verdict-execution.md`
- `references/reorg-2026-06-07-topics-first.md`
- `references/repo-native-methodology-migration.md`
- `references/repo-native-research-lifecycle-adversarial-review.md`
- `references/research-line-amnesia-2026-06-10.md`
- `references/research-target-introduction-2026-06-10.md`
- `references/resume-hung-round-2026-06-09.md`
- `references/route-transition-accounting-verification.md`
- `references/staged-exact-patch-stack-audit.md`
- `references/successor-envelope-review-installation.md`
- `references/task-gate-authority-transition-and-jsonl-closure.md`
- `references/temporal-eligibility-and-recursive-integration-hygiene.md`
- `references/terminal-task-cap-and-no-partial-stop.md`
- `references/untracked-artifact-review-factcheck.md`
- `references/whole-base-lint-apply-maintenance.md`
- `references/workdir-recovered-breadth-verification.md`
- `scripts/pdf_md_noise_filter.py`
- `scripts/pymupdf_text_extract.py`
- `scripts/verify_extraction_fidelity.py`
