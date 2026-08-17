# Raven v1: One-Entry-Point Interface

## Recommendation in one sentence

Ship one deep **Module**, `RavenTask`, behind one model-facing **Interface** entry point, `raven_task(command)`, mounted through one host Cordis plugin; make checkpoints, steering, evidence, verification, recovery, and optional orchestration hidden behavior rather than additional public concepts.

The public abstraction is always one **Raven Task**. `research`, `general-writing`, `academic-writing`, and `learning` are outcome values, not different tools or workflow types.

---

## 1. Exact Interface

### 1.1 The single entry point

```ts
type RavenTaskCommand =
  | {
      op: "advance"
      taskId?: string
      outcome?: "research" | "general-writing" | "academic-writing" | "learning"
      request?: string
      steer?: string
    }
  | {
      op: "stop"
      taskId: string
    }

raven_task(command: RavenTaskCommand): RavenTaskView
```

This is the complete external **Interface**. The type is illustrative; the Harness tool schema is the executable contract.

`advance` deliberately collapses start, continue, resume, inspect, checkpoint, verify, and complete into one intent: advance one Raven Task as far as currently useful and authorized.

- If `taskId` is absent, `advance` creates a task. `outcome` and `request` are then required.
- If `taskId` is present, `advance` continues that task.
- If `steer` is present with `taskId`, it creates a same-task Steering Revision before further work.
- If the current artifact, status, or evidence view is all that can usefully be returned, `advance` is also the read operation; there is no public `get` entry point.
- `stop` is the only separate operation because it expresses user authority, not workflow mechanics. It is idempotent and preserves all Checkpoints, Sources, Claims, and Limitations.

### 1.2 Returned view

```ts
type RavenTaskView = {
  taskId: string
  outcome: "research" | "general-writing" | "academic-writing" | "learning"
  phase: "active" | "paused" | "stopped" | "completed" | "completed-with-limits"
  revision: number
  checkpoint: {
    id: string
    sequence: number
    stage: "frame" | "discover" | "analyze" | "draft" | "verify" | "refine"
    artifact: string
  }
  trace: {
    sources: Array<{
      id: string
      title: string
      locator: string
      status: "inspected" | "failed" | "unavailable"
    }>
    claims: Array<{
      id: string
      text: string
      disposition: "supported" | "qualified" | "deferred" | "rejected" | "analysis"
      sourceIds: string[]
    }>
  }
  limitations: Array<{
    code: string
    message: string
    affects: string[]
  }>
  next: "advance" | "steer" | "stop" | "none"
}
```

The view is a bounded projection, not the internal state dump. `artifact` may contain the useful deliverable directly or a stable artifact reference when Harness output limits require it. Source bodies, worker transcripts, orchestration topology, retry records, and prompt packets never cross this **Seam**.

### 1.3 Invariants

1. **One identity.** A user request creates exactly one Raven Task identity. Research, drafting, learning aids, verification, and revisions never create public child tasks.
2. **One outcome value.** All four Outcomes use the same Interface and state model. Outcome changes defaults and checks, not task identity.
3. **Monotonic revision.** `revision` starts at `0`. Every accepted `steer` increments it exactly once. Prior Checkpoints and evidence remain addressable and are never rewritten.
4. **Monotonic checkpoint sequence.** Every emitted Checkpoint has an increasing `sequence`. A Checkpoint is independently useful and immutable; refinement creates another Checkpoint.
5. **Progressive usefulness.** A substantial active task emits a useful Checkpoint before exhaustive collection or final verification. Internal stages do not become user gates.
6. **Steering is same-task.** Steering Revision applies before newly scheduled work, invalidates stale derived assertions where necessary, and preserves reusable evidence. It does not silently discard completed work.
7. **Registered-source rule.** Only an inspected Source may have status `inspected`; search results, snippets, remembered citations, and worker mentions remain leads until inspected.
8. **Citation rule.** Artifact citation tokens resolve mechanically to registered Source IDs. Unknown IDs are invalid.
9. **Material-claim rule.** A material external Claim cannot be `supported` with an empty `sourceIds` list. Each supporting Source has a locator and bounded excerpt internally. Raven analysis is explicitly `analysis` and may have no Source.
10. **Failure isolation.** A failed or unavailable Source cannot support a Claim. Its failure becomes a Limitation without invalidating independent Sources, Claims, or artifact sections.
11. **Main-agent authority.** Tool success, subagent completion, workflow completion, model agreement, or process exit is not Completion. The main Raven execution owns synthesis and disposition.
12. **Exact-candidate verification.** Completion checks the exact candidate artifact after the latest substantive revision, including citation resolution, Claim links, and Steering Revision application.
13. **No routine approval.** Frame, discover, read, analyze, draft, verify, refine, retry, and route switching proceed without confirmation. Only Harness-governed material scope/cost expansion, sensitive data, publication, destructive mutation, or external side effects may pause for authority.
14. **Honest terminal state.** `completed` requires all required checks. `completed-with-limits` requires a useful artifact plus explicit unresolved Limitations. Runtime termination alone is never a terminal business result.
15. **Idempotent stop.** Repeated `stop` returns the same stopped task state. A later `advance` resumes the same task unless Harness goal authority requires explicit re-arming.
16. **Session locality.** Raven v1 state is scoped by Harness session and task ID. No cross-session corpus or hidden global mutable research store is implied.

### 1.4 Ordering

For a new task, one `advance` follows this logical order:

```text
validate command
→ allocate task identity
→ frame outcome/request and material ambiguities
→ persist revision 0
→ perform bounded useful work
→ register inspected Sources before accepting their Claims
→ synthesize an Artifact
→ emit and persist Checkpoint 1
→ continue deeper work when the turn/runtime permits
→ verify the exact candidate
→ return active, completed, or completed-with-limits view
```

For steering:

```text
load latest task state
→ compare taskId and expected latest revision internally
→ append Steering Revision
→ cancel or ignore stale pending work
→ preserve compatible evidence and prior Checkpoints
→ re-evaluate affected Claims and Artifact sections
→ emit a new Checkpoint
→ verify only the new exact candidate before Completion
```

For partial failure:

```text
record failure cause and affected dependency
→ preserve successful independent work
→ retry transient route once
→ switch legal method once when useful
→ mark affected Claims deferred/rejected if still unsupported
→ emit a useful Checkpoint with Limitations
→ complete-with-limits when acceptance remains possible; otherwise remain active/paused
```

Internal work may be parallel, but state publication is serialized per task. A result computed from revision `n` cannot overwrite state after revision `n+1`; it may only contribute evidence if it remains compatible with the new revision.

### 1.5 Error modes

Tool-level errors are reserved for invalid use of the Interface:

| Error | Condition | Effect |
|---|---|---|
| `INVALID_COMMAND` | Missing required new-task fields, unsupported outcome/op, or malformed values | No state change |
| `TASK_NOT_FOUND` | `taskId` is unknown in the current session | No replacement task is created |
| `TASK_CONFLICT` | Concurrent commit loses the internal revision comparison | Return latest view and safe retry guidance; never overwrite newer steering |
| `TASK_CORRUPT` | Persisted metadata fails schema/version validation | Fail closed; expose recovery limitation and preserve raw session history |
| `CAPABILITY_REQUIRED` | A requested essential side effect is absent or denied and no meaningful artifact can be produced | Task remains preserved and paused/stopped with the missing capability named |

Operational failures are data, not thrown task failures:

- retrieval timeout, blocked URL, unavailable optional `web`, subagent failure, cancellation of one shard, failed verification route, and incomplete coverage become `limitations`;
- unsupported Claims are downgraded or excluded;
- unaffected artifact content remains available;
- `completed-with-limits` is preferred over all-or-nothing failure when the artifact is still useful.

---

## 2. Usage examples

### 2.1 Research

```json
{
  "op": "advance",
  "outcome": "research",
  "request": "Compare the strongest primary-source evidence for and against policy X since 2022. Produce a concise decision memo."
}
```

Representative result:

```json
{
  "taskId": "rav_01J...",
  "outcome": "research",
  "phase": "active",
  "revision": 0,
  "checkpoint": {
    "id": "cp_01",
    "sequence": 1,
    "stage": "analyze",
    "artifact": "Decision memo v1: ..."
  },
  "trace": {
    "sources": [
      {"id": "S1", "title": "Official report", "locator": "§3.2", "status": "inspected"}
    ],
    "claims": [
      {"id": "C1", "text": "...", "disposition": "qualified", "sourceIds": ["S1"]}
    ]
  },
  "limitations": [
    {"code": "SOURCE_UNAVAILABLE", "message": "One archived dataset could not be reopened.", "affects": ["C4"]}
  ],
  "next": "advance"
}
```

The caller invokes `advance` again only when another model turn is needed. Raven does not ask approval between discovery, drafting, and verification.

### 2.2 Same-task Steering Revision

```json
{
  "op": "advance",
  "taskId": "rav_01J...",
  "steer": "Keep the same memo, but prioritize implementation evidence over announced intent and cut the executive summary to 150 words."
}
```

Raven appends revision `1`, retains reusable Sources and Checkpoints, downgrades Claims supported only by intent evidence, and emits a new Checkpoint. It does not create “research task 2” or “writing task 1.”

### 2.3 General writing

```json
{
  "op": "advance",
  "outcome": "general-writing",
  "request": "Write an 800-word launch essay for a technical audience using the notes in this session. Mark any externally checkable claims that still need sources."
}
```

The same Module may produce an outline Checkpoint, then a draft Checkpoint, and finish with either `completed` or `completed-with-limits`. The user does not learn a separate writing Interface.

### 2.4 Academic writing

```json
{
  "op": "advance",
  "outcome": "academic-writing",
  "request": "Develop the literature-review section from the inspected papers, preserve disagreements, and use author-year citations."
}
```

Academic defaults deepen verification and citation rendering behind the same Interface. They do not expose bibliography CRUD, claim-ledger CRUD, or verifier topology.

### 2.5 Learning

```json
{
  "op": "advance",
  "outcome": "learning",
  "request": "Teach me the central limit theorem from intuition to a worked example, then give me a short self-check."
}
```

A Checkpoint can be a concept map or initial explanation. Later steering can say “use less notation” or “add a proof sketch” against the same task.

### 2.6 Stop and resume

```json
{"op": "stop", "taskId": "rav_01J..."}
```

Later:

```json
{"op": "advance", "taskId": "rav_01J..."}
```

The second call resumes from the compact persisted task state and prior Checkpoints; it does not reconstruct authority from worker memory.

---

## 3. Hidden implementation

The public Module is deep because the one-entry-point Interface hides the following implementation:

1. **Command normalizer** — validates the discriminated command, resolves “new versus existing,” and converts outcome defaults into a compact execution envelope.
2. **Task reducer** — pure revisioned state transitions for task phase, Steering Revisions, Checkpoints, Sources, Claims, Limitations, attempts, and completion disposition.
3. **Outcome policy** — chooses defaults for artifact shape, evidence floor, tone, and verification risk without branching into four public Modules.
4. **Planner** — selects direct execution, single-agent phased work, or bounded fan-out based on task size and risk.
5. **Source registry** — canonicalizes inspected source identity, assigns stable IDs, stores locator/excerpt/family/role/check status, and distinguishes leads from Sources.
6. **Claim ledger** — atomizes load-bearing Claims, links Sources, enforces ceilings and dispositions, retains contradictions, and renders citations mechanically.
7. **Artifact engine** — maintains immutable Checkpoints and artifact lineage; it never mutates an old Checkpoint in place.
8. **Steering reconciler** — applies Steering Revision diffs, detects stale work, preserves compatible evidence, and computes affected Claims and artifact sections.
9. **Failure controller** — performs bounded retry and route switching, propagates dependency failures, and converts exhausted routes into Limitations.
10. **Verification engine** — always performs deterministic identity/link/final-candidate checks and adds risk-adaptive semantic or independent review.
11. **Completion judge** — separates runtime state from business outcome and chooses `completed`, `completed-with-limits`, or continued work.
12. **Session projector** — writes a compact, lossless Raven snapshot into official tool-result metadata and reconstructs the latest valid snapshot on replay.
13. **Prompt contributor** — installs a concise epistemic contract: source-first work, typed uncertainty, main-agent synthesis, progressive Checkpoints, and no routine gates.
14. **Harness coordinator** — consumes optional web, subagent, and goal capabilities without making their topology public.

Implementation state should be normalized but compact:

```text
Task
├── revisions[]
├── checkpoints[]
├── sources{}
├── claims{}
├── limitations[]
├── currentArtifact
├── runtimeState
└── businessOutcome
```

Do not persist full fetched pages, recursive Harness objects, worker transcripts, or a second session log. Store only owned JSON: compact summaries, stable identities, bounded excerpts, hashes when needed, and the latest artifact/reference.

The package should be one dependency-light ESM host Cordis plugin with pure internal Modules. It contributes exactly:

- one `raven_task` model tool;
- one short ordered `systemPrompt` section;
- optional compact replay metadata on the tool result.

It provides no `ctx.raven` process service, no client half, no custom GUI, no custom scheduler, and no Raven database in v1. Splitting core/plugin packages or publishing a service would create hypothetical Seams while Raven has one consumer and one implementation.

---

## 4. Dependency Adapters

Adapters are private to Raven's implementation. Their interfaces are narrow enough to fake in tests but are not public Raven entry points.

### 4.1 Required Harness Adapters

#### `ToolsAdapter`

**Seam:** `@deepseek-ai/dsh-tools` tool registration and execution context.

Responsibilities:

- register the one `raven_task` tool with canonical input/output schemas;
- honor `exec.signal` cancellation;
- emit bounded model-facing output plus lossless Raven metadata;
- unregister through the Cordis fiber disposer.

This is the external Cordis load **Seam** and the model-facing Interface **Seam**.

#### `PromptAdapter`

**Seam:** `ctx.systemPrompt`.

Responsibilities:

- register one concise, ordered static section;
- avoid injecting entire task ledgers or source bodies;
- dispose registration with the plugin fiber.

The tool result supplies immediate task context, so a dynamic prompt provider is unnecessary until a demonstrated resume case requires one.

#### `SessionReplayAdapter`

**Seam:** official session/tool-result metadata.

Responsibilities:

- attach schema-versioned, lossless JSON Raven state to each successful tool result;
- scan/reduce same-session Raven metadata to the latest valid revision;
- reject corrupt or future-incompatible state without mutating session history.

Prefer this seam over a new session projection dependency in v1. Add a projection only if a second live consumer needs state independent of Raven tool execution.

### 4.2 Optional Capability Adapters

#### `WebAdapter`

**Seam:** optional Harness web capability discovered with `ctx.get(...)`.

Responsibilities:

- search or reopen URLs through the configured web capability;
- return owned fields only: URL, title, locator, bounded excerpt, retrieval/check status;
- never promote a search result to an inspected Source;
- translate absence or failure into typed retrieval results, not exceptions that discard the task.

Without it, Raven can use already inspected session materials and must expose remote-verification limits.

#### `SubagentAdapter`

**Seam:** existing subagent capability, optional via `ctx.get(...)`.

Responsibilities:

- dispatch only separable evidence or critique questions;
- use bounded structured results;
- propagate cancellation;
- treat every worker result as an unaccepted Claim candidate;
- keep worker identities and topology out of `RavenTaskView`.

No custom orchestration Adapter is justified for v1. If broad model-authored fan-out later proves necessary, a `WorkflowAdapter` may satisfy the same private work-dispatch interface; that second Adapter would make the Seam real.

#### `GoalAdapter`

**Seam:** existing goal tools/events or goal-domain contract, when mounted.

Responsibilities:

- map one long-running Raven Task to one Harness goal;
- store task ID and compact next action in the goal objective/context;
- respect Harness pause/resume/re-arm semantics;
- never equate goal-loop termination with Raven Completion.

Raven remains useful without goal support in one turn; lack of a goal limits autonomous continuation rather than changing the public Interface.

### 4.3 Intentionally absent Adapters

- **No storage Adapter:** same-session metadata is enough for v1; one implementation with no second consumer does not justify a storage Seam.
- **No client Adapter:** Checkpoints render through ordinary tool/chat presentation; no custom GUI requirement exists.
- **No model-host Adapter:** Harness owns model routing.
- **No scheduler Adapter:** Harness goals, subagents, workflows, and cancellation already provide the needed mechanisms.
- **No publication Adapter:** publication is an external side effect and should remain an explicit Harness/user-authority action outside routine Raven progression.

All Harness imports must use public package exports available in packed `0.1.0-rc.5` artifacts, never checkout `src/*` paths or workspace aliases. Pin and test the RC family and Node `^22.19.0 || >=24`.

---

## 5. Depth and Locality tradeoffs

### 5.1 Why this Module is deep

One command exercises framing, progressive execution, evidence capture, citation rendering, revision reconciliation, retry, verification, persistence, and completion. The caller learns one noun, one entry point, two operations, and five public phases. That is high **Leverage** per unit of Interface.

The deletion test is strong: deleting `RavenTask` would force callers to recreate lifecycle state, outcome routing, source registration, Claim discipline, Checkpoint versioning, Steering Revision reconciliation, partial-failure policy, and completion checks. The complexity does not vanish; it spills into prompts and call sites. The Module earns its depth.

### 5.2 Locality gained

- Citation validity is fixed once in the source/Claim implementation, not in four outcome workflows.
- Steering race handling is fixed once in the task reducer.
- Partial-failure semantics are fixed once in the failure controller.
- Completion semantics are fixed once across research, writing, academic writing, and learning.
- Harness RC compatibility is concentrated in small Adapters rather than spread through domain logic.
- Tests exercise the same one-entry-point Seam as callers, with private fake Adapters for web, subagents, goals, and session metadata.

This **Locality** also makes AI navigation easier: public behavior is specified in one Interface contract; capability-specific changes live beside their Adapter.

### 5.3 Costs of radical minimalism

1. **The command is semantically dense.** `advance` means start, continue, steer-and-continue, or return the best current view. The discriminated fields and invariants must remain strict to avoid a “bag of optional fields.”
2. **No independent query entry point.** Reading current state uses `advance`, which may perform work. This is intentional for model use but unsuitable for a future passive GUI inspector. A second `raven_view(taskId)` entry point should be added only when that real consumer exists.
3. **Task views can grow.** Source and Claim lists must be bounded or summarized, with stable IDs retained. Returning every internal row would make the Interface shallow.
4. **Outcome-specific richness stays implicit.** Academic writing may need stricter citation style and learning may need pedagogy state. Those remain outcome policy inside the Module; exposing separate tools would trade away Leverage prematurely.
5. **One package couples release cadence.** Pure task logic and Harness integration ship together. This favors v1 Locality and clean consumption over independent reuse. Split when a second non-Harness consumer exists, not in anticipation of one.
6. **Tool-result metadata is same-session durability.** It does not provide cross-session corpora, spaced repetition, or shared projects. Adding those would require a justified storage Module and a real storage Seam.
7. **RC Adapter risk remains.** DeepSeek Harness `0.1.0-rc.5` contracts may change. Concentrating them in Adapters limits blast radius but does not remove version risk.

### 5.4 Rejected alternatives

#### Multiple outcome tools

`raven_research`, `raven_write`, `raven_academic`, and `raven_learn` would duplicate lifecycle, steering, evidence, and failure behavior. This is a shallow family: users must choose topology before Raven has framed the task, and fixes lose Locality.

#### Public CRUD over tasks, Sources, Claims, and Checkpoints

`createTask`, `addSource`, `addClaim`, `emitCheckpoint`, `verify`, and `complete` merely expose the implementation sequence. Callers would have to preserve Raven's invariants themselves. That is low Depth and low Leverage.

#### Public `ctx.raven` service plus a thin tool

With one consumer, a process service would be a hypothetical Seam. The thin tool would pass through rather than absorb complexity. Keep pure internal Modules for tests; publish a service only when a second runtime consumer exists.

#### One giant free-form prompt with no tool state

This minimizes the type surface but not the real Interface: callers would need to know magic phrases, hidden ordering, and recovery conventions. It also loses executable invariants, traceability, and replay Locality.

#### Custom GUI, scheduler, or database

These duplicate Harness mechanisms without increasing Raven's user abstraction. They add external Interfaces and migration obligations before a concrete second consumer exists.

---

## 6. Final recommendation

Implement the one-entry-point design exactly as follows:

1. Ship one external ESM host Cordis package compatible with DeepSeek Harness `0.1.0-rc.5` and Node `^22.19.0 || >=24`.
2. Register one model tool, `raven_task`, with only `advance` and `stop` operations.
3. Keep one Raven Task identity across all four Outcomes and every Steering Revision.
4. Emit immutable, useful Checkpoints progressively; never make stage transitions approval gates.
5. Normalize Source and Claim records internally and expose a bounded trace projection in each result.
6. Treat retrieval, tool, and worker failures as typed Limitations; preserve independent work and allow `completed-with-limits`.
7. Persist compact schema-versioned task state in official tool-result metadata; do not add Raven storage in v1.
8. Add one concise `systemPrompt` section and consume optional web, subagent, and goal capabilities through private Adapters.
9. Keep synthesis and Completion in the main Raven execution; worker or scheduler status is never authority.
10. Test through three agreed Seams: Cordis load/unload, the single `raven_task` Interface, and source-verification/completion disposition.

This design is radically minimal without being merely small. Its Depth comes from hiding the entire evidence-aware progressive execution system behind one durable user abstraction. Its Leverage is that every Outcome receives the same steering, traceability, recovery, and completion guarantees. Its Locality is that the invariants live once, while DeepSeek Harness dependencies remain confined to narrow Adapters.