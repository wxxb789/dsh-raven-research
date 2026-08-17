# Reverse Engineering the Hermes `nana` Research Profile for Raven

## Scope and method

This report treats `C:/Users/lhan/AppData/Local/hermes/profiles/nana/` as the primary source. The profile was inspected read-only; no source-profile file was modified. Findings distinguish between:

- **Normative behavior**: persona, user authority, skills, and configured gates.
- **Runtime mechanisms**: persistence schemas, plugins/hooks, scheduler state, and UI behavior.
- **Historical residue**: backups, caches, and compatibility stubs. These are evidence of evolution, not automatically current authority.

Line citations use exact profile paths. SQLite evidence uses structured locations because databases have no stable source lines.

## Executive assessment

Hermes Nana is best understood as an **evidence-first research operating system**, not merely a prompt. Its strongest design is a layered contract: a thin identity prompt establishes epistemic defaults; user memory defines authority and preferences; repository contracts own project methodology; skills route into those contracts; and runtime persistence records sessions, worker/delegation state, and verification evidence as inputs for recovery. The system also exposes user steering through interruption, progress heartbeats, explicit material-scope boundaries, and phase-aware continuation.

For Raven, the core should be retained but simplified. The highest-value mechanisms are: claim-to-source traceability, primary-source preference, explicit uncertainty classes, progressive artifact-first execution, bounded retries with route changes, user-visible progress, and confirmation only for material or irreversible changes. The largest sources of complexity and latency are: large procedural skills, costly verification fan-out when applied beyond authoritative/reference outputs, universally fine-grained plans, and an over-specified monitor protocol for ordinary research.

## 1. Prompt and authority architecture

### 1.1 Thin research identity and epistemic contract — **Keep**

The live `SOUL.md` defines Nana as a research/evidence-audit/writing collaborator and frames the mission as converting sources into auditable claims without converting uncertainty into false confidence. It requires a request to become a goal, scope, evidence boundary, artifact, acceptance conditions, and verification method; it grants autonomy inside an approved reversible scope and reserves scope/evidence/publication/external-side-effect expansion for approval. It also requires work to continue until the artifact and checks exist or a real blocker is demonstrated. Evidence is source-first, claims are typed (fact, reported claim, inference, judgment, controversy, unknown), and all material facts must be traceable to inspected evidence. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/SOUL.md`, lines 5-22.]

**User-visible value:** concise answers remain auditable; the agent does not repeatedly ask the user to manage routine research; uncertainty is explicit rather than rhetorically hidden.

**Complexity/latency:** low. These are compact global invariants and prevent downstream rework.

**Raven recommendation:** preserve this as a short system-level contract. Add a small machine-readable execution envelope (`goal`, `scope`, `evidence floor`, `artifact`, `acceptance checks`) rather than expanding prose.

### 1.2 Main-agent ownership of synthesis — **Keep**

Nana explicitly reserves research judgment, synthesis, and final verification to the main agent; workers are limited to separable evidence questions or bounded mechanical work and their outputs are claims to inspect, not authority. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/SOUL.md`, lines 24-28.]

**Value:** avoids “consensus by subagent” and preserves one accountable final author.

**Cost:** modest integration latency, but materially lowers hallucination and inconsistency risk.

**Raven recommendation:** retain and show the provenance of worker findings separately from main-agent acceptance.

### 1.3 Profile-to-repository authority migration — **Keep**

The user contract says project methodology belongs in the project repository (`AGENTS.md`, focused contracts, method files), while the profile should retain identity, user authority, environment facts, and thin triggers. New methods should become repository authority before profile pointers are updated; legacy compatibility may only retire after consumer cutover and verification. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/memories/USER.md`, line 25.]

The live legacy R-round skill is consequently a routing stub: it tells the agent to read the repository contracts and exact live plan, forbids deriving launch authority from profile text, and explicitly grants no lifecycle or execution authority. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/r-round-plan-lifecycle/SKILL.md`, lines 14-26.]

**Value:** one current source of truth, project-specific versioning, and safer migration.

**Cost:** additional reads at task start.

**Raven recommendation:** adopt “thin profile, thick project contract.” Cache contract digests for speed, but re-read when the digest changes or before consequential actions.

### 1.4 User preference memory as authority — **Change**

`USER.md` mixes stable preferences with operating authority: language (line 1), material-ambiguity handling (line 5), naming/environment rules (line 7), Git identity (line 9), launch semantics (lines 13 and 41), standing approvals (lines 17, 21, and 29), progress preferences (lines 23 and 37), memory isolation (lines 11 and 25), and project-method ownership (line 25). [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/memories/USER.md`, exact lines listed above.]

This is useful, but project-specific and time-varying authority can coexist with stable preferences. Line 41 introduces an NRS-specific exception to the line-13 R-round/two-key rule by removing a repeated launch phrase while retaining separate material-scope approval. [Source: same file, lines 13 and 41.]

**Value:** personalized autonomous behavior and durable steering.

**Cost/risk:** contradictory or superseded rules can accumulate; evaluating prose authority each turn costs tokens and may produce inconsistent gates.

**Raven recommendation:** split memory into typed records: `preference`, `standing_authority`, `project_pointer`, `environment_fact`, each with scope, effective date, supersedes link, and expiry/review state. Do not treat free-form memory text as an execution token.

## 2. Progressive execution and user steering

### 2.1 Artifact-first, phase-separated research — **Keep**

The deep-research workflow separates parallel discovery, optional merge/outline, main-agent writing, and post-write fact checking. Its prescribed worker contract requires bounded structured YAML and forbids writing or synthesizing; it recommends withholding the file toolset, while the caller performs final writing. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/deep-research-crew/SKILL.md`, lines 27-81.]

For reference or educational output intended to be authoritative, a later phase extracts atomic claims, fans out verification, applies corrections, and writes a verification report. [Source: same file, lines 99-117.]

**Value:** visible intermediate products, lower context exhaustion risk, focused worker roles, and recoverable progress.

**Cost:** fan-out and merge overhead; unnecessary for small tasks. The skill itself provides size-based thresholds and says not to fan out trivial current facts. [Source: same file, lines 17-25.]

**Raven recommendation:** keep an adaptive pipeline: direct execution for small jobs; discovery→synthesis for multi-source jobs; verification only for material claims or authoritative deliverables. Surface each phase and accepted artifacts in the UI.

### 2.2 Persistent standing-goal continuation — **Keep**

The user contract prefers continuous concrete progress through intermediate review/checkpoints once a standing goal is approved, stopping only on completion or real permission/evidence blockage; heartbeats do not replace work and should not require repeated `continue`. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/memories/USER.md`, line 37.]

A persisted interrupted-turn record contains a concrete standing goal, explicit instruction to take the next step, and stop conditions for completion or user-required blockage. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/desktop/interrupted_turns.json`, structured locations `/20260812_014629_cc87ae/prompt`, `/attempts`, and `/started_at`.]

**Value:** long research survives UI/process interruption and does not stall at every checkpoint.

**Cost:** autonomous continuation can surprise users if scope is ambiguous.

**Raven recommendation:** keep persisted goals with explicit `phase`, `scope_digest`, `last_verified_artifact`, and `next_action`; re-arm only when the goal and scope still match. Never interpret continuation as material scope expansion.

### 2.3 Busy-input interruption and progress telemetry — **Keep**

The UI is configured for `busy_input_mode: interrupt`, interim assistant messages, all background-process notifications, detailed busy acknowledgments, long-running notifications, and all tool progress. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/config.yaml`, lines 304, 327, and 343-347.]

The user asks for periodic concise heartbeats containing completed work, current work, next step, and blocker. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/memories/USER.md`, line 23.]

**Value:** the user can steer during execution and understands whether latency reflects productive work or blockage.

**Cost:** message noise and extra rendering.

**Raven recommendation:** retain but coalesce into event-driven heartbeats: phase transition, material finding, retry-route change, blocker, and elapsed-time threshold. Provide an interrupt/steer channel that queues a scope change rather than silently merging it into current worker contexts.

### 2.4 Universal micro-planning — **Change**

The generic plan skill prohibits execution, saves a plan artifact, and recommends 2–5 minute tasks with full code, exact commands, and a commit after every task. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/software-development/plan/SKILL.md`, lines 14-58, 86-95, 227-233, and 284-290.]

**Value:** strong handoff for implementation work.

**Cost:** extreme planning latency and verbosity for research; frequent-commit prescriptions are not universally appropriate.

**Raven recommendation:** use only when the user explicitly requests a plan or when a high-impact operation needs reviewable steps. Research execution should use a compact phase plan and evidence ledger, not code-level microtasks.

## 3. Citations and traceability

### 3.1 Retrieval-time source ledger — **Keep**

The grounded-citations skill uses a profile-aware ledger that owns URL→citation-number mapping. It requires agents to register sources at retrieval time rather than reconstructing them from prose; URL normalization preserves stable IDs within a ledger. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/grounded-citations/SKILL.md`, lines 15-25, 47-70, and 87-97.]

Drafts cite while writing, source lists are mechanically rendered, and verification fails unknown IDs and ledger disagreement; it can also fail inadequate coverage when `--min-coverage` is set. [Source: same file, lines 99-127.]

**Value:** prevents invented URLs, stale source blocks, and attribution loss during editing.

**Cost:** ledger operations add small overhead.

**Raven recommendation:** make citation ledgering a built-in artifact service, not an optional procedural skill. Store source identity, retrieval timestamp, locator, content hash, and claim links.

### 3.2 Verbatim evidence anchors and explicit unverified claims — **Keep with refinement**

High-stakes mode attaches quotations that must match fetched evidence under the script's declared normalization (whitespace, case, and Markdown markup are normalized); unverifiable model-knowledge claims are marked `[unverified]`; the evidence gate can fail a draft whose cited sources lack attached quotes. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/grounded-citations/SKILL.md`, lines 129-181.]

**Value:** exposes the full claim→source→anchor chain and sharply limits quotation fabrication.

**Cost:** substantial extraction and review latency if imposed on every sentence.

**Raven recommendation:** require anchors for load-bearing facts, figures, quotations, disputed claims, and current-status claims. For lower-risk context, use source-level citation without verbatim anchors. Replace prose `[unverified]` with typed claim status in the ledger and optionally render it.

### 3.3 Cross-source verdict vocabulary — **Keep**

The fact-check skill requires authoritative evidence independent of the document under test and uses a consistent verdict vocabulary: `CONFIRMED`, `PARTIALLY-CONFIRMED`, `CONTRADICTED`, `UNVERIFIABLE — LIKELY FABRICATED`, and `OUTDATED / RESTRUCTURED`. It distinguishes absence from contradiction, asks reviewers to name canonical sources searched when absence is evidence, and calls for a second independent source for disputed facts. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/cross-source-fact-check/SKILL.md`, lines 13-45 and 76-82; `.../grounded-citations/SKILL.md`, lines 163-166.]

Its persisted-ledger audit checks literal fidelity, compound support, downstream consistency, and status ceilings. [Source: same file, lines 48-59.]

**Value:** scannable, non-binary findings and explicit correction of embellished specifics.

**Cost:** claim atomization and independent-source search can be expensive.

**Raven recommendation:** retain typed verdicts, but separate `not found` from `likely fabricated` unless search coverage meets a declared canonical-source threshold.

### 3.4 Final-artifact verification — **Keep**

Nana requires inspection of original sources and the exact final artifact after the last substantive change, including reporting retrieval limits and unresolved inference. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/SOUL.md`, line 26.]

The runtime also enables `file_mutation_verifier` and `verify_on_stop: auto`. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/config.yaml`, lines 106-108 and 313-319.]

A dedicated SQLite schema defines tables capable of recording verification events (`command`, canonical command, kind, scope, status, exit code, output summary) and per-session/root state (`last_event_id`, edit time, changed paths). [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/verification_evidence.db`, structured locations `verification_events` and `verification_state` table definitions in `sqlite_master`.]

**Value:** “tool succeeded” is not mistaken for “deliverable is correct.”

**Cost:** final verification adds predictable latency.

**Raven recommendation:** retain a concise verification receipt and bind it to artifact content hash so later edits invalidate stale verification.

## 4. Failure handling and recovery

### 4.1 Warning-only loop guardrails — **Change**

The runtime warns after two exact failures, three same-tool failures, or two idempotent no-progress attempts, while hard stops are disabled even though higher thresholds are configured. API retries are limited to three. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/config.yaml`, lines 53-67 and 167-177.]

**Value:** early diagnosis prompt without prematurely stopping creative recovery.

**Risk/cost:** with hard stops disabled, invariant failure loops remain possible and expensive.

**Raven recommendation:** enforce route-sensitive budgets: after repeated invariant failure, require an explicit method change; after all legal routes are exhausted, stop with a blocker receipt. Allow user override, not silent infinite retries.

### 4.2 Bounded per-cause retry ladder — **Keep**

Per monitor and per failure cause, the monitor workflow allows `initial + resume once + respawn once + switch method once`, then `BLOCKED`; deterministic blockers can stop immediately. It preserves successful fetches and items rather than rerunning an entire batch. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/nana-research-monitor/SKILL.md`, lines 197-206.]

**Value:** retries add new evidence or a new route, while completed work survives partial failure.

**Cost:** the four-stage protocol is too heavy for every tool call.

**Raven recommendation:** keep the principle and use smaller defaults: retry once for transient errors, switch route once, then block. Use the full ladder only for long-running shard workflows.

### 4.3 Business status separated from scheduler status — **Keep**

The monitor skill defines pre-agent-only `NOT_DUE`, terminal item outcomes `NO_CHANGE`, `UPDATED`, and `BLOCKED`, plus batch-only `PARTIAL`; it explicitly says scheduler completion, exit code 0, or worker “done” is not business success. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/nana-research-monitor/SKILL.md`, lines 33-47.]

The cron registry shows one hourly agent-backed coordinator with a pre-run script, scoped skills/toolsets, working directory, completion count, and configuration field `last_status: "ok"` for its scheduler run. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/cron/jobs.json`, lines 2-50.]

**Value:** prevents false success and makes partial failure actionable.

**Cost:** more state transitions and receipts.

**Raven recommendation:** make this distinction fundamental: `runtime_state` and `business_outcome` should be separate fields in every long-running run.

### 4.4 Candidate-first write and clean-tree fail-closed policy — **Keep for durable/high-impact writes; Change for routine reports**

Within the Nana research-monitor workflow, live repository writes require clean-tree and lease checks, per-monitor isolation, candidate generation in scratch, disposable-surface validation, application of the same validated patch, live revalidation, explicit-path staging, atomic commit, and no push. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/nana-research-monitor/SKILL.md`, lines 82-110 and 152-180.]

**Value:** excellent protection against concurrent edits, stale patches, and unverified automation.

**Cost:** high I/O and validation latency; disproportionate for a user-requested standalone report file.

**Raven recommendation:** use risk tiers. For a single owned report, write incrementally and verify content. For shared repositories or autonomous monitors, use the full candidate/lease/clean-tree protocol.

### 4.5 Recovery from persisted artifacts, not dead worker RAM — **Keep**

Hermes defines SQLite persistence for sessions (including parent-child relationships, model usage, end reason, CWD, Git and compression/activity metadata), messages (including tool-call and compacted fields), and async delegations (state, event/result JSON, delivery attempts, owner identity, and task JSON). [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/state.db`, structured locations `sessions`, `messages`, `async_delegations`, and `session_model_usage` table definitions in `sqlite_master`.]

**Value:** durable state and artifacts provide inputs for reconstructing work rather than pretending a dead worker is still live.

**Cost:** the inspected `state.db` is 1,697,562,624 bytes (~1.70 GB decimal / ~1.58 GiB), creating retention and privacy burden.

**Raven recommendation:** retain durable execution records but separate compact resumable state from bulky transcripts/tool payloads; use retention and content-addressed artifact references.

## 5. Confirmation and authority gates

### 5.1 Material-scope gate, not routine-step gate — **Keep**

Nana operates autonomously inside approved reversible scope. Material ambiguity about the research question, evidence floor, audience, or deliverable triggers a question; expansion of the research question, evidence class, durable output, publication boundary, or external side effects separately requires the applicable approval. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/SOUL.md`, lines 11-14; `C:/Users/lhan/AppData/Local/hermes/profiles/nana/memories/USER.md`, line 5.]

Persistent high-impact changes use `design → exact diff → explicit approval`; a named standing exception is bounded and does not generalize. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/memories/USER.md`, line 21.]

**Value:** minimal user interruption while retaining control over consequential changes.

**Cost:** requires accurate risk/scope classification.

**Raven recommendation:** implement a typed confirmation matrix: material scope, durable authority/config/memory changes, external publication, destructive mutation, and new side effects require confirmation; reversible research steps do not.

### 5.2 Plan/review versus launch separation — **Keep, but avoid duplicate confirmation**

The user contract says plan/review/`ready-for-launch` does not itself execute, and `continue` only advances the approved phase rather than authorizing material scope change. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/memories/USER.md`, line 13.]

The later user rule removes repeated “magic phrase” launch confirmation for NRS after approved scope reaches readiness, while preserving separate material-scope approval. [Source: same file, lines 39-41.]

**Value:** phase clarity without confirmation fatigue.

**Cost:** stale or contradictory launch rules if modeled as prose.

**Raven recommendation:** model readiness and authority as state: approval binds to `scope_digest`; execution may auto-start only when the digest and readiness checks match. Any material delta invalidates readiness and requires fresh approval.

### 5.3 Runtime smart approval and destructive confirmations — **Keep with transparency**

Hermes is configured with smart approvals, a 600-second timeout, cron denial, MCP reload confirmation, destructive slash confirmation, no automatic hook acceptance, and a narrow command allowlist containing script execution via `-e`/`-c` and `execute_code`. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/config.yaml`, lines 562-571.]

Delegation auto-approval is disabled. [Source: same file, lines 430-443.]

**Value:** high-risk tool or configuration changes remain user-controlled.

**Cost:** approval-model inference can be opaque and delayed.

**Raven recommendation:** keep deterministic gates for clearly destructive/external actions and show the exact action, affected scope, reversibility, and reason. Avoid model-mediated approvals for low-risk local reads.

## 6. Skills, tools, hooks, and routing

### 6.1 Curated skill surface and disable pilot — **Keep**

The config disables 51 skills, while a pilot artifact records baseline counts, metrics, observation sources, and a manual-only post-pilot decision; this report interprets the mechanism as deliberate surface curation rather than evidence that each disabled skill was intrinsically irrelevant. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/config.yaml`, lines 447-506; `C:/Users/lhan/AppData/Local/hermes/profiles/nana/pilots/disabled-skills-2026-08-03.json`, structured locations `disabled_skills`, `metrics`, `observation_sources`, and `post_pilot`, lines 1-85.]

**Value:** lowers tool-selection entropy, prompt load, and accidental cross-domain behavior.

**Cost:** occasional missing-capability friction.

**Raven recommendation:** expose a small research-default tool surface, then capability-discover on demand. Track actual misses and latency before promoting skills into the default set.

### 6.2 Lazy browser lifecycle hook — **Keep**

The Camofox plugin registers `pre_tool_call` and session-end hooks; the session-end handler is currently a no-op. On the first `browser_*` call it checks health, starts the bridge if needed, avoids restarting a healthy process, and swallows startup failure so the browser tool reports its native error. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/plugins/camofox-lifecycle/plugin.yaml`, lines 1-7; `.../camofox-lifecycle/__init__.py`, lines 64-112.]

On Windows, it binds the bridge to a Job Object with kill-on-close and registers process-level `atexit` cleanup; the profile isolation manifest reserves port 9378 and forbids affecting the default-profile bridge on 9377. [Source: `.../camofox-lifecycle/__init__.py`, lines 115-171 and 215-249, 308-339; `.../camofox-lifecycle/isolation-manifest.json`, structured fields `expected_port`, `default_port`, and `invariant`, lines 1-10.]

**Value:** the plugin's design notes estimate that lazy start avoids roughly 300 MB of browser cost when unused, while lifecycle binding prevents orphan processes and cross-profile interference. [Source: `.../camofox-lifecycle/__init__.py`, lines 11-30.]

**Cost:** the first call may block for up to the configured 70-second health wait; after timeout the bridge may still be initializing. [Source: `.../camofox-lifecycle/__init__.py`, lines 47-55 and 294-305.]

**Raven recommendation:** retain lazy lifecycle ownership; add visible “starting browser” progress and optional predictive warm-up when an approved plan clearly requires browsing.

### 6.3 Multi-route retrieval with legal bounded fallback — **Keep**

Grounded-citations documents web search, extraction, browser, and terminal as possible configured retrieval routes; it does not itself guarantee route availability. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/grounded-citations/SKILL.md`, lines 47-54.]

The fact-check skill explicitly falls back from browser to command-line retrieval and archives, while preserving the distinction between blocked retrieval and evidence. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/cross-source-fact-check/SKILL.md`, lines 68-74.]

The profile blocks Yandex and disallows private URLs by default. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/config.yaml`, lines 132-151 and 572-584.]

**Value:** resilient research without silently lowering evidence quality.

**Cost:** route switching and normalization overhead.

**Raven recommendation:** retain a retrieval strategy graph with source-quality floors and logged route transitions; a failed primary-source retrieval must remain a blocker or caveat, not be silently replaced by a snippet.

### 6.4 Tool output, compression, and large-context configuration — **Change**

The profile uses a 1.05M-context default model, high reasoning effort, up to 1,000 turns, 50 tool calls per code-execution run, output truncation limits, and conversation compression beginning at 50% with a 20% target. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/config.yaml`, lines 1-48 (model/context), 53 and 106 (turns/reasoning), 162-166 (tool output), 178-186 (compression), and 589-592 (code execution).]

**Value:** supports long research and protects recent context.

**Cost:** encourages very long sessions and large persistence; compression can obscure provenance if artifacts are not authoritative.

**Raven recommendation:** use artifacts and structured ledgers as primary memory, not ever-growing conversational context. Cap active context by phase and reload exact evidence/artifacts as needed.

### 6.5 Memory hooks and semantic recall — **Change**

The Nowledge manifest declares prefetch, post-LLM, memory-write, pre-compression, and session-end hooks. Its fallback `post_llm_call` path syncs the supplied user and assistant turn per session when the full provider collector is unavailable. Presence of the manifest proves the integration exists, not that the general plugin loader currently mounts it; the live `plugins.enabled` list names only `camofox-lifecycle`, although memory-provider discovery may use a separate path. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/plugins/nowledge-mem/plugin.yaml`, lines 1-10; `.../nowledge-mem/__init__.py`, lines 18-52 and 65-98; `.../config.yaml`, lines 685-688.]

The live memory config uses agent identity `nana`, the default shared space, and disables Working Memory injection. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/nowledge-mem.json`, lines 1-6.]

The skill-outcome extractor is intentionally conservative: it only recognizes structured `find_skills` results, not free-form assistant prose. [Source: `.../nowledge-mem/skill_outcome.py`, lines 1-7 and 70-95, 125-139.]

**Value:** cross-session recall and reduced false memory creation.

**Risk/cost:** syncing turn text and optional conversation-history data can retain sensitive or noisy data; a shared default space raises contamination risk even with Working Memory disabled.

**Raven recommendation:** write memory only from explicit typed outcomes/decisions, with project and agent namespace, retention policy, and user-visible provenance. Preserve the structured-only extraction principle.

## 7. Persistence and artifacts

### 7.1 Layered durable state — **Change**

The profile schemas provide persistence for:

- Session/message/tool history and model usage in `state.db` (`sessions`, `messages`, `session_model_usage`).
- Async worker state and delivery attempts in `state.db.async_delegations`.
- Full-text and trigram indexes in `state.db.messages_fts*`.
- Verification history in `verification_evidence.db.verification_events` and per-root state in `verification_state`.
- Scheduler runs in `cron/executions.db.executions`, whose statuses are restricted to `claimed`, `running`, `completed`, `failed`, or `unknown`.
- A human-readable job registry in `cron/jobs.json`.

[Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/state.db`, structured table definitions in `sqlite_master`; `.../verification_evidence.db`, structured table definitions; `.../cron/executions.db`, structured table `executions`; `.../cron/jobs.json`, lines 1-54.]

**Value:** recovery, auditability, asynchronous delivery, and operational observability.

**Cost:** storage, privacy, index maintenance, and schema complexity.

**Raven recommendation:** keep four explicit stores: execution state, evidence/artifacts, user/project memory, and telemetry. Give each independent retention and export/delete controls.

### 7.2 Artifact placement and mechanical acceptance checks — **Keep**

The user contract defines exact character-count semantics (line 15), a bounded standing approval for repository lint maintenance (line 17), commit-versus-push authority (line 29), and repository-relative canonical paths in `MATERIALS.md` (line 31). [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/memories/USER.md`, lines 15, 17, 29, and 31.]

The deep-research workflow says the final report must be reread and size/end-state verified, and claimed evidence counts must be mechanically checked. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/deep-research-crew/SKILL.md`, lines 127-132.]

**Value:** deliverables are durable and acceptance is measurable rather than asserted.

**Cost:** low; mechanical checks are cheap.

**Raven recommendation:** every substantial research run should have a named artifact directory, manifest, evidence ledger, and final verification receipt.

### 7.3 Checkpoints disabled despite resumability need — **Change**

File checkpoints are disabled, although snapshot limits and pruning settings are configured. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/config.yaml`, lines 153-161.]

**Value of current state:** avoids snapshot storage and accidental capture of large/sensitive files.

**Risk:** long artifact edits rely on Git, app-level state, or ad hoc recovery.

**Raven recommendation:** use selective logical checkpoints rather than whole-file snapshots: persist goal envelope, accepted evidence IDs, artifact hashes, unresolved claims, failed routes, and next action.

## 8. What Raven should build

### Keep

1. **Thin epistemic contract** with source-first research, typed uncertainty, material-claim traceability, and final-artifact verification.
2. **Progressive execution** selected by task size: direct, phased discovery/synthesis, then targeted verification.
3. **User steering during execution** through interrupts and event-driven heartbeats.
4. **Scope-digest confirmation gates** for material expansion, durable authority/config/memory changes, destructive/external actions, and publication.
5. **Built-in evidence ledger** linking claim, source, locator/anchor, retrieval metadata, content hash, status, and verifier.
6. **Business outcomes distinct from runtime states**, including partial and actionable blocked outcomes.
7. **Bounded retries that require route change**, while preserving successful shards and artifacts.
8. **Artifact-first persistence** with content-hash-bound verification receipts.
9. **Main-agent accountability** for synthesis and acceptance of worker findings.
10. **Lazy, scoped tool lifecycle** for expensive browser/runtime dependencies.

### Change

1. Replace free-form authority memory with typed, scoped, superseding records.
2. Move generic citation and verification mechanics into platform services; leave skills as routing/domain overlays.
3. Apply candidate-first/lease-heavy protocols by risk tier, not to every report.
4. Replace warning-only loop controls with enforceable method-change and stop-loss rules.
5. Use selective logical checkpoints and bounded context reloads rather than huge transcript dependence.
6. Make progress messages event-driven and coalesced.
7. Require verbatim anchors for load-bearing/high-risk claims, not every low-risk contextual sentence.
8. Namespace semantic memory by project/agent and persist only explicit outcomes.

### Drop

1. Universal 2–5 minute micro-plans and commit-per-task behavior outside explicit implementation planning.
2. Duplicated project methodology in profile-local mega-skills once repository-native contracts exist.
3. Repeated launch “magic phrases” when an approved scope digest and readiness state already authorize execution.
4. Unlimited invariant retries, whole-batch reruns after isolated failures, and context growth as a substitute for durable artifacts.

### Preserve explicit prohibitions

Nana already prohibits treating scheduler completion, tool exit 0, or worker “done” as business success, and it rejects fabricated controller authority. Raven should preserve these prohibitions rather than misclassifying them as mechanisms currently in use. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/nana-research-monitor/SKILL.md`, lines 33-47; `C:/Users/lhan/AppData/Local/hermes/profiles/nana/memories/USER.md`, line 35.]

## 9. Proposed Raven control loop

1. **Frame:** derive goal, scope, evidence floor, artifact, checks, and risk tier; ask only if a material dimension is unresolved.
2. **Authorize:** bind approval/standing authority to a scope digest and phase.
3. **Plan proportionately:** direct execution for small work; phased plan for broad work.
4. **Retrieve and ledger:** register sources at retrieval time; preserve failures and cutoff.
5. **Progress:** emit coalesced heartbeat on phase changes, route changes, major findings, or blockers; accept user interrupts.
6. **Synthesize:** main agent writes from accepted evidence, preserving contradiction and claim status.
7. **Verify:** mechanically check artifact constraints and selectively verify load-bearing claims against anchors/independent sources.
8. **Persist:** store artifact hashes, evidence graph, verification receipt, unresolved claims, and next action.
9. **Conclude:** report business outcome (`COMPLETE`, `PARTIAL`, `BLOCKED`, or domain-specific `NO_CHANGE`) separately from runtime completion.

This preserves Nana's user-visible rigor and steerability while eliminating the most expensive procedural duplication.

## 10. Evidence limitations

This was a static, read-only profile audit. Configuration and hook manifests establish configured intent and implementation structure, not production reliability or actual mount order. Plugins, cron jobs, browser/network routes, citation scripts, and recovery flows were not executed. Sensitive `auth.json`, full session/request dumps, and private history were deliberately not inspected. The audit did not measure prompt assembly, token cost, skill hit rate, citation coverage, memory-write success, or browser cold-start distribution. In particular, a present Nowledge manifest does not prove current general-plugin mounting, and a scheduler definition does not prove runtime/database consistency. [Source: `C:/Users/lhan/AppData/Local/hermes/profiles/nana/config.yaml`, lines 685-688; `.../plugins/nowledge-mem/plugin.yaml`, lines 1-10; `.../cron/jobs.json`, lines 1-54.]