# Raven Keep / Change / Drop Assessment

## Purpose

This assessment is the implementation gate for Raven v1. It combines the detailed
Hermes profile audit, the `nana-research` repository audit, and the current
DeepSeek Harness integration audit. The companion reports are:

- [`hermes-profile.md`](./hermes-profile.md)
- [`nana-research.md`](./nana-research.md)
- [`deepseek-harness-integration.md`](./deepseek-harness-integration.md)

The source systems were inspected before Raven architecture or code was created.
The goal is not to port Nana. It is to preserve mechanisms that visibly improve
trust, progress, steerability, or recovery, while removing ceremony whose latency
or maintenance burden exceeds its value.

## Evidence baseline

The assessment relies on four kinds of primary evidence:

1. **Live Hermes profile contracts and configuration.** The compact identity and
   epistemic rules are in
   `C:/Users/lhan/AppData/Local/hermes/profiles/nana/SOUL.md:5-28`; the live UI is
   configured for busy-input interruption and interim/progress notifications in
   `config.yaml:304,327,343-347`.
2. **Concrete Hermes procedures.** The retrieval-time citation ledger is defined
   in `skills/research/grounded-citations/SKILL.md:15-25,87-127`; the phased
   research crew is in
   `skills/research/deep-research-crew/SKILL.md:27-81,99-117`.
3. **Repository contracts, tests, and artifacts.** Nana's evidence invariants are
   in `docs/agent-contract/research-system/evidence-and-lineage.md:11-26,62-110`;
   partial-failure and bounded-retry behavior is in
   `docs/agent-contract/research-system/iteration-and-orchestration.md:116-143`;
   executable lease behavior is covered by
   `tests/harness/test_research_execution_lease.py:65-167`.
4. **Current Harness source.** Native tool registration is defined in
   `packages/core/tools/src/index.ts:211-269,1031-1061`; durable tool-private
   replay metadata is defined in
   `packages/core/session/src/types.ts:281-297` and used by
   `packages/web/tool-web/src/search.ts:88-103,126-169`; scoped prompt sections
   are defined in `packages/core/system-prompt/src/index.ts:337-454`; the shipped
   preset's host/agent-plane rules are documented in
   `apps/cli/config/agent-presets/standard/agent.cordis.yml:1-18,76-98,157-183`.

The audits deliberately did not inspect secrets or full private transcripts.
Static configuration establishes intended behavior, not production reliability.
Where available, contract claims were checked against tests or actual artifacts.

## Keep

### 1. A short epistemic contract

**Evidence.** Nana's live identity requires source-first work, explicit separation
of fact/report/inference/judgment/controversy/unknown, traceability for material
facts, and continued autonomous work until an artifact and its checks exist
(`SOUL.md:11-28`).

**Reason to keep.** These rules prevent polished prose from laundering uncertainty
and cost little prompt space.

**Raven decision.** Ship one concise Harness prompt section. Keep global
invariants there; put task state in typed data rather than expanding the prompt
into another methodology manual.

### 2. Retrieval-time source identity and claim traceability

**Evidence.** Hermes registers URLs when they are retrieved, assigns stable IDs,
mechanically renders source lists, and rejects unknown IDs
(`grounded-citations/SKILL.md:15-25,69-70,87-127`). Nana goes further: a URL is not
an inspected source, and material claims carry source identity, an anchor and
locator, evidence role, source-family information, ceiling, contradiction state,
and lineage (`evidence-and-lineage.md:11-26,28-80`).

**Reason to keep.** This directly addresses fabricated citations, stale source
lists, and unsupported status inflation.

**Raven decision.** Make `Source` and `Claim` first-class records. Artifacts cite
source IDs, and Raven mechanically resolves those IDs to the recorded URL. A
material external claim cannot be accepted with an unknown or empty source set.
The first release requires a locator and excerpt for every registered source;
it records source-family and evidence-role metadata when known without forcing
Nana's full row schema on routine work.

### 3. Early artifacts and user steering

**Evidence.** Hermes exposes interruption and progress while work is active
(`config.yaml:304,327,343-347`), and the user contract expects continued concrete
progress without repeated `continue` messages (`memories/USER.md:23,37`). The
research-paper skill explicitly says to draft first and ask with the draft
(`skills/research/research-paper-writing/SKILL.md:62-88`).

**Reason to keep.** A visible outline, draft, or finding gives the user something
to correct before the system spends the full research budget.

**Raven decision.** A Raven task emits user-visible `Checkpoint` artifacts while
it remains active. The first useful checkpoint precedes exhaustive collection or
final verification. A `Steering Revision` updates the same Raven task identity;
it does not create a replacement workflow. Pause, stop, resume, and correction
preserve prior checkpoints and evidence.

### 4. Main-agent synthesis with optional internal topology

**Evidence.** Nana assigns research judgment, synthesis, integration, and final
acceptance to the main agent; workers only handle separable evidence questions,
and worker output is a claim rather than authority (`SOUL.md:24-28`;
`CLAUDE.md:49-54`; `iteration-and-orchestration.md:69-75`).

**Reason to keep.** It prevents worker consensus or scheduler completion from
becoming truth.

**Raven decision.** The user contract exposes exactly one Raven task. The agent
may use Harness subagents or workflows internally, but worker/shard topology is
not part of Raven's public interface and cannot accept claims or complete the
task.

### 5. Bounded retry and partial-result semantics

**Evidence.** Nana preserves passing work, excludes failed dependencies, resumes
useful partial work once, respawns once, switches method once, and then defers or
blocks (`iteration-and-orchestration.md:116-143`).

**Reason to keep.** It avoids both infinite loops and all-or-nothing failure.

**Raven decision.** Record source/tool/coverage failures in the same task. Failed
sources cannot support accepted claims, but independent findings and artifacts
remain usable. Verification returns actionable issues or a limited completion
rather than throwing away the run.

### 6. Exact final-artifact and source-reference checks

**Evidence.** Nana requires checking original sources and the exact final artifact
after the last substantive edit (`SOUL.md:24-28`). The reusable anchor verifier
exists because repeated one-off scripts reintroduced encoding, composite-anchor,
user-agent, and throttling defects (`Q:/repos/nana-research/.harness/README.md:87-109,182-192`).

**Reason to keep.** Tool success and file existence do not prove that the delivered
artifact is correct.

**Raven decision.** Completion validates citation IDs, source URLs, material-claim
links, steering revision, and the final artifact bytes supplied to the tool.
When Harness exposes the optional `web` capability, Raven reopens recorded URLs;
unavailable verification degrades explicitly rather than manufacturing success.

### 7. Session-native durable logical checkpoints

**Evidence.** Harness sessions are append-only and persistence is already a
platform concern (`packages/core/session/src/index.ts:1-6`). A tool can attach
lossless JSON presentation metadata to `tool/result` for exact replay
(`packages/core/session/src/types.ts:281-297`); the web tool uses this for faithful
source cards (`packages/web/tool-web/src/search.ts:88-103`).

**Reason to keep.** Raven can resume compact task state without adding a parallel
session database or storing full pages in prompts.

**Raven decision.** Persist the latest compact Raven task state in the official
`tool/result.meta` seam and reconstruct it on session resume. Store summaries,
source/claim records, checkpoint identities, and the latest artifact—not fetched
page bodies or another transcript store.

## Change

### 1. Phased research becomes progressive rather than batch-then-reveal

**Evidence.** `deep-research-crew` usefully separates discovery, merge, writing,
and verification, but its default sequence has discovery workers return structured
findings before the caller writes the report
(`deep-research-crew/SKILL.md:27-81`). Its verification phase starts only after
the draft (`:99-117`).

**Problem.** The separation protects context, but it can reproduce a
"finish discovery before showing anything" experience.

**Raven redesign.** Keep separable phases internally, but publish an initial
outline/findings/draft checkpoint as soon as the first credible source set exists.
Then continue discovery, verification, and refinement against the visible artifact.
Normal phase transitions never require approval.

### 2. Nana's lifecycle becomes one Raven task state

**Evidence.** NRS persists
`draft → review → ready-for-launch → running → verification → closeout → archived`
plus side states (`research-system/README.md:48-65`). Legacy R-rounds and NRS also
have incompatible launch semantics (`plans/README.md:65-83` versus
`research-system/README.md:91-95`).

**Problem.** The distinctions are useful internally, but duplicate lifecycle
systems and exact launch phrases are migration sediment.

**Raven redesign.** One task has `active`, `paused`, `stopped`, `completed`, and
`completed-with-limits` public phases. Checkpoints carry work stages such as
`discover`, `read`, `analyze`, `draft`, `verify`, and `refine`; those stages are
observations, not user gates. Material scope or external/destructive side effects
remain Harness/user authority questions, outside normal research progression.

### 3. Full evidence ledgers become a normalized lean core

**Evidence.** Nana's real ledger applies the model but repeats many source fields
per row (`artifacts/proj-modern-tech-us-military-asset-management/research/ledgers/A01.jsonl:1-7`).

**Problem.** Repetition increases token, storage, and migration cost.

**Raven redesign.** Store normalized `Source` records and compact `Claim.sourceIds`
edges. Keep locator, excerpt, role, family, check state, disposition, and failures.
Defer a separate edge table and exhaustive audit schema until a second real
consumer or Audit mode justifies it.

### 4. Verification becomes risk-adaptive

**Evidence.** Nana separates closure, claim acceptance, study acceptance, writing,
and publication, and requires fresh verification for high-risk facts
(`verification-and-acceptance.md:11-24,26-63`). Historical dual-model review found
real issues but recorded 119–193 second passes and an HTTP failure
(`wiki/workflows/r17-plan-adversarial-review-2026-06-10/README.md:21-30,34-80`).

**Problem.** Universal independent review imposes disproportionate latency on
ordinary writing and learning tasks.

**Raven redesign.** The v1 default always runs deterministic citation and source
checks. It asks the main agent to inspect load-bearing evidence and uses optional
independent agents only for high-consequence, disputed, or broad synthesis.
A future Audit profile can deepen the same records; it must not be a second system.

### 5. Scope control becomes a concise diff, not preflight paperwork

**Evidence.** Nana correctly distinguishes bounded query/tool adaptation from
material changes to questions, evidence classes, outputs, write surfaces, or caps
(`scope-and-authorization.md:81-105`). However the live NRS pilot reached revision
18 and remained blocked before any iteration or evidence row because readiness
bound stale prose and a changed legacy baseline
(`studies/active/NRS-2026-001-nrs-cutover-reproducibility-pilot/study.md:1-21,77-105`;
its iteration and evidence JSONL files each contain only their initial empty line).

**Problem.** Launch-critical exact-byte roots can consume all effort before useful
work begins.

**Raven redesign.** The direct user request is the initial scope authority. Raven
asks only when an unresolved decision changes the public outcome, evidence floor,
audience, deliverable, or significant side effect. Mid-task corrections are
ordinary steering when they remain within that contract. Raven does not hash
incidental prose or require a readiness ceremony before reversible research.

### 6. Packaging becomes one deep package, not a premature package family

**Evidence.** Harness supports separate service/provider/tool packages, but does
not require maximal fragmentation (`packages/subagent/subagent/src/index.ts:1-15`).
User presets are standing mounts shared by sessions, so mutable state must be
session-keyed (`packages/preset/agent-presets/src/index.ts:1-20`). A preset row
that publishes a service must be isolated
(`apps/cli/config/agent-presets/standard/agent.cordis.yml:1-18`).

**Problem.** Raven v1 has one consumer and one implementation. Publishing a
`ctx.raven` service plus core/plugin/storage packages would create hypothetical
seams and composition burden before anything varies.

**Raven redesign.** Ship one ESM package. Its external interface is one Cordis
plugin that contributes one prompt section and one model tool. Pure task logic is
an internal module and remains testable through that interface. The plugin
publishes no process service, so its user-preset row needs no isolate realm.
Split only when a second adapter or consumer makes a seam real.

## Drop

### 1. Routine stage approvals and magic launch phrases

Drop confirmations between discover, read, analyze, draft, verify, and refine.
Drop parser-friendly launch phrases. Nana's own NRS contract removed the second
launch phrase after readiness (`research-system/README.md:91-95`). Keep approval
only for material scope/cost changes, destructive operations, publication,
sensitive data, or external side effects.

### 2. Universal micro-plans and fixed stage paperwork

The generic Hermes plan workflow's 2–5 minute tasks and commit-per-task guidance
is useful for explicit implementation planning, not ordinary research
(`skills/software-development/plan/SKILL.md:14-58,227-233`). Raven uses a compact
current task state and visible checkpoints instead.

### 3. Dual lifecycle compatibility and migration snapshot forests

Raven has no legacy R/NRS objects to preserve. Do not import compatibility schemas,
magic command parsing, exact legacy baseline hashes, or migration-only receipts.
The historical lesson becomes a small regression test, not permanent runtime
architecture.

### 4. A global research execution lease

Nana's one lease correctly protects a shared mutable vault but serializes unrelated
work (`test_research_execution_lease.py:65-100`). Raven v1 owns no shared research
database or autonomous repository writer. Harness already owns session/tool
lifecycle; file writes use its existing filesystem and sandbox policies.

### 5. A new scheduler, agent framework, vector store, model host, or GUI

Harness already supplies goals, sessions, persistence, tools, subagents, workflows,
cancellation, and lifecycle. None of the four Raven outcomes requires a custom
model host, general autonomous-agent framework, unrelated knowledge base, or
browser UI in v1.

### 6. Full-page bodies in task state

Keep only source identity, locator, bounded excerpt, role/family metadata, and
verification status. Full retrieved bodies remain in the owning Harness tool
result or an explicitly requested artifact. This avoids duplicating Hermes's
large transcript/persistence burden.

## Raven v1 mechanism traceability

| Raven mechanism | Evidence preserved | Simplification |
|---|---|---|
| One `raven_task` model tool | Harness native tool seam; Nana stable task/claim/source identities | One action interface instead of public workflow topology or CRUD tools |
| Compact prompt section | Nana `SOUL.md` epistemic contract | No profile-scale methodology prompt |
| Visible checkpoint artifact | Hermes interruption/progress and draft-first behavior | Artifact appears before exhaustive research; no stage approval |
| Steering revision on same task ID | Hermes busy-input steering and persisted continuation | No restart or replacement study |
| Source/claim ledger with citation tokens | `grounded-citations` stable IDs and NRS lineage | Normalized records; no repeated full row schema |
| Optional remote source reopening | Nana final-source checks; Harness optional `ctx.web` | Failure becomes a limitation unless it contaminates an accepted claim |
| Tool-result metadata checkpoint | Harness append-only session and replay metadata | No Raven session database in v1 |
| Main-agent completion decision | Nana non-transitive acceptance | Independent agents optional and hidden from public contract |
| Bounded failures and completion-with-limits | Nana partial-failure semantics | No monitor-specific receipt protocol |
| User-preset Cordis row | Harness supported agent-plane extension | No Harness fork or shipped-preset edit |

## Implementation gate

Raven v1 may proceed with these constraints:

1. **Public seam:** one Raven task, represented to the model by one
   `raven_task` tool. Actions are internal lifecycle operations, not separate user
   tasks.
2. **Four outcomes:** `research`, `general-writing`, `academic-writing`, and
   `learning` are values of the same task interface.
3. **Progressive default:** at least one useful checkpoint is emitted before
   exhaustive research or final verification on substantial tasks.
4. **No routine confirmation:** stage changes are autonomous. Only a real public
   contract or side-effect boundary can require the user.
5. **Traceability:** only registered source IDs can render external citations;
   material external claims must link to locator/excerpt evidence whose bounded
   excerpt is matched against the retrieved Source body before publication.
6. **Graceful degradation:** failed sources and tools remain visible and cannot
   support accepted claims, but independent work survives.
7. **Harness reuse:** use scoped prompt/tools, session replay metadata, optional
   web verification, and existing goals/subagents/workflows. Do not rebuild them.
8. **Lean packaging:** one dependency-light ESM Cordis package, no provided
   service, no client half, no custom storage, and no GUI.
9. **Compatibility target:** DeepSeek Harness `0.1.0-rc.5`, Node
   `^22.19.0 || >=24`, tested against checkout commit
   `47f943859bef60e4160492346772ded9b24f765a`.
10. **Test seams:** the Cordis load seam, the single Raven task action seam, and
    source verification/completion disposition. These are the seams already
    fixed by the requested public contract and therefore the acceptance suite's
    agreed test surfaces.

## Known v1 limits

- URL reachability and literal identity checks do not prove semantic entailment;
  the prompt keeps main-agent source inspection and claim judgment mandatory.
- Tool-result metadata gives same-session durability. Cross-session knowledge,
  spaced repetition, or a reusable corpus would require a separately justified
  storage module and is intentionally excluded.
- The plugin can make progress visible through tool results and chat, but v1 adds
  no custom client UI.
- The intended Harness version is an RC. Raven pins and tests that exact family
  rather than claiming an unproven stable compatibility range.
