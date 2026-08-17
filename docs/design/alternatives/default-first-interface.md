# Raven v1 Default-First Interface

## Design target

The most common caller is the model already handling a user request in a DeepSeek Harness session. It should not have to construct a workflow, select stages, manage workers, or learn evidence-ledger mechanics. Raven v1 therefore exposes one deep **Module** at one model-tool **Seam**: `raven_task`.

The default path is deliberately trivial:

```json
{"request":"Explain why database indexes speed up reads and when they hurt writes."}
```

Raven infers the Outcome and useful defaults, creates one Raven Task, emits a progressive visible Artifact, advances stages autonomously, verifies what the selected Outcome requires, and returns either Completion or Completion with explicit Limitations. Everything beyond `request` exists for correction, continuation, or an uncommon explicit constraint.

This design supersedes a public family of research, writing, learning, source, claim, stage, and lifecycle tools. Those would expose implementation topology and produce a shallow Module. One action-shaped Interface puts that complexity behind Raven and gives the caller greater **Leverage**.

## 1. Exact Interface

### 1.1 Model-facing Interface

```ts
type RavenTaskInput =
  | {
      request: string
      outcome?: "research" | "general-writing" | "academic-writing" | "learning"
      constraints?: {
        audience?: string
        deliverable?: string
        evidenceFloor?: "none" | "trace-external-claims" | "academic"
        scope?: string
      }
    }
  | {
      taskId: string
      revision: string
    }

raven_task(input: RavenTaskInput): RavenTaskResult
```

This type notation specifies the Interface; the shipped implementation uses the Harness tool schema rather than requiring callers to write TypeScript.

The two input variants have intentionally different jobs:

- `request` starts exactly one Raven Task. `outcome` and `constraints` are optional hints, not launch paperwork.
- `taskId + revision` applies a Steering Revision to that same Raven Task. A revision is ordinary user intent in natural language, not a patch document or replacement Task specification.

There are no public `continue`, `advance`, `verify`, `complete`, `add_source`, `add_claim`, `checkpoint`, `pause`, or worker-management methods. Normal continuation and stage movement are autonomous. Harness remains responsible for cancellation and session lifecycle. If a paused or stopped state is exposed later, it should be an uncommon lifecycle extension of this same Interface, not a second workflow Interface.

### 1.2 Result

```ts
type RavenTaskResult = {
  taskId: string
  outcome: "research" | "general-writing" | "academic-writing" | "learning"
  phase: "active" | "completed" | "completed-with-limits"
  stage: "discover" | "read" | "analyze" | "draft" | "verify" | "refine"
  artifact: {
    checkpointId: string
    version: number
    kind:
      | "findings"
      | "outline"
      | "draft"
      | "explanation"
      | "study-guide"
      | "final"
    content: string
    isFinal: boolean
  }
  sources: Array<{
    sourceId: string
    title?: string
    location: string
    locator: string
    excerpt: string
    status: "inspected" | "unavailable" | "failed-verification"
  }>
  claims: Array<{
    claimId: string
    text: string
    kind: "external" | "analysis"
    disposition: "supported" | "qualified" | "deferred" | "rejected"
    sourceIds: string[]
  }>
  limitations: Array<{
    code: string
    message: string
    affectsClaimIds?: string[]
  }>
  steering: {
    appliedRevision: number
  }
  next: "working-autonomously" | "done"
}
```

The canonical JSON is the replay and test surface. Presentation may render a concise card or model-facing summary, but must preserve the same identities and dispositions. `artifact.content` is always useful content, not a progress slogan. On a substantial active Task, it is a Checkpoint; on Completion, it is the exact final Artifact that was verified.

The caller may use a returned active result immediately, show it to the user, or invoke another tool. Raven does not require the caller to echo `continue`: `next: "working-autonomously"` means the Task owns its remaining normal progression. A later Raven result for the same `taskId` replaces the visible current projection while preserving prior Checkpoints in session history.

### 1.3 Defaults

Given only `request`, Raven determines:

1. **Outcome** from the requested deliverable and user intent.
2. **Audience** from the request or current conversation; otherwise a general informed reader.
3. **Evidence floor**:
   - Research: `trace-external-claims`.
   - General Writing: `trace-external-claims` when external claims are introduced; otherwise `none`.
   - Academic Writing: `academic`.
   - Learning: `trace-external-claims` for factual teaching material; otherwise `none`.
4. **Artifact kind** from Outcome and request.
5. **Internal stages, tool choices, retry budget, and optional worker topology** without caller configuration.

Raven asks a question only if an unresolved choice materially changes the public Outcome, evidence floor, audience, deliverable, scope, cost/authority, or external side effect. It does not ask permission between ordinary stages.

### 1.4 Invariants

1. **One identity.** A start call creates one `taskId`. All Checkpoints, Sources, Claims, Verification results, Limitations, and Steering Revisions belong to that Task.
2. **Revision, not restart.** A Steering Revision requires an existing `taskId`, increments `steering.appliedRevision`, preserves prior evidence and Checkpoints, and changes future work on the same Task.
3. **Visible useful progress.** Every substantial Task emits at least one non-final, useful Artifact before exhaustive collection or final Verification. A trivial Task may complete in one result only when an intermediate Checkpoint would add no steering value.
4. **Monotonic versions.** `artifact.version` and the applied Steering Revision never decrease. Checkpoint identities are immutable.
5. **Autonomous progression.** `discover`, `read`, `analyze`, `draft`, `verify`, and `refine` are observations, never caller gates. Stage regression is allowed internally after new evidence or steering, but does not create a new Task.
6. **Inspected-source rule.** A URL, search result, remembered citation, or worker report is not a Source until Raven has actually inspected it and recorded stable location, locator, and bounded excerpt.
7. **External-claim rule.** A material Claim with `kind: "external"` may be `supported` only when every cited ID resolves to a recorded inspected Source and the locator/excerpt supports the Claim. An empty or unknown source set cannot support it.
8. **Analysis distinction.** Raven analysis may have no Source, but must be labeled `kind: "analysis"`; it cannot masquerade as externally grounded fact.
9. **Mechanical citation identity.** Artifact citations resolve from stable `sourceId` records; the model cannot invent the rendered location independently.
10. **Failure isolation.** An unavailable or failed Source cannot support an accepted Claim. Independent Claims, Sources, and Artifact content remain usable.
11. **Exact-final Verification.** Completion checks the exact final Artifact after its last substantive edit, including citation IDs, source records, material Claim links, and incorporation of the latest Steering Revision.
12. **Honest Completion.** `completed` means required checks passed. `completed-with-limits` means the Artifact remains useful but named Limitations narrow its claims or coverage. Tool or worker termination is never Completion.
13. **One synthesizing authority.** Internal workers contribute candidate findings. They cannot accept Claims, decide Completion, or create public Tasks.
14. **Compact persistence.** Session replay metadata contains compact Task state, latest Artifact, Source/Claim records, Checkpoint identities, Limitations, and revision counters—not fetched page bodies or a duplicate transcript.
15. **No hidden public side effects.** Research-stage transitions require no approval, but publication, destructive writes, sensitive-data access, material scope/cost expansion, or other external effects remain governed by Harness and user authority.

### 1.5 Ordering

For a new Task, the externally observable order is:

1. Validate and normalize the request.
2. Infer or accept Outcome and constraints.
3. Allocate `taskId` and revision `0` before performing optional work.
4. Begin autonomous work and register Sources only at inspection time.
5. Emit the first useful Artifact Checkpoint as soon as there is enough substance to steer; do not wait for exhaustive discovery or final Verification.
6. Continue discovery, reading, analysis, drafting, and risk-adaptive Verification against the visible Artifact.
7. Apply any Steering Revision to the same Task, increment the revision, invalidate affected conclusions where necessary, and continue autonomously.
8. Verify source references and the exact final Artifact after the latest substantive edit.
9. Finish as `completed` or `completed-with-limits` and set `next: "done"`.

A Steering Revision is rejected if it races with a newer revision rather than being silently applied to stale state. The implementation may serialize same-Task transitions, but must not globally serialize unrelated Tasks.

### 1.6 Error modes

Tool invocation errors are reserved for cases where no honest Task result can be returned:

| Error | Meaning | Caller response |
|---|---|---|
| `INVALID_INPUT` | Empty request, both input variants supplied, malformed ID, or schema violation. | Correct the call; no Task is created. |
| `TASK_NOT_FOUND` | The `taskId` is absent from available same-session state. | Do not invent a replacement identity; tell the user the Task cannot be resumed here. |
| `REVISION_CONFLICT` | The revision targeted stale Task state or conflicts with a newer Steering Revision. | Read/use the latest Task result and reapply only still-relevant intent. |
| `UNSUPPORTED_SIDE_EFFECT` | The request requires an external/destructive action outside Raven's Interface. | Route through the appropriate Harness authority/tool; Raven may preserve a draft or plan. |
| `INTERNAL_STATE_CORRUPT` | Persisted Task state violates identities or monotonicity invariants. | Stop mutation, preserve diagnostic context, and do not claim Completion. |

Operational problems are normally data, not thrown failures:

- retrieval unavailable;
- one Source fails to open or reopen;
- optional web Verification is absent;
- subagent/workflow provider is absent;
- a worker times out;
- coverage is incomplete;
- evidence conflicts;
- an external Claim cannot be supported.

Raven records these as Source status, Claim disposition, and/or Limitation, changes method with bounded retries, and continues independent work. It returns `completed-with-limits` when the requested Artifact is still useful. It remains active or stops without Completion only when the missing capability makes the requested Outcome itself impossible.

## 2. Usage examples

### 2.1 Default research path

Caller:

```json
{"request":"Compare SQLite and PostgreSQL for a local-first desktop application. Recommend a default and cite the material tradeoffs."}
```

Raven infers `research`, starts one Task, and first returns a useful findings or outline Checkpoint with inspected Sources. It then continues autonomously through deeper comparison and Verification. The caller supplies no stage list, source schema, or `continue` call.

### 2.2 General Writing without unnecessary research ceremony

Caller:

```json
{"request":"Rewrite this release note for busy engineering managers: [text]"}
```

Raven infers `general-writing`. If the supplied text is the only basis and Raven introduces no external facts, the evidence floor is `none`; the Task can produce a draft Checkpoint and refined final Artifact without web retrieval. The same Source/Claim machinery remains available but does not burden the caller.

### 2.3 Academic Writing with explicit constraint only where valuable

Caller:

```json
{
  "request":"Draft a 2,000-word literature review on retrieval-augmented generation evaluation.",
  "outcome":"academic-writing",
  "constraints":{
    "audience":"graduate machine-learning seminar",
    "deliverable":"literature review with a reference list",
    "scope":"peer-reviewed work through 2025"
  }
}
```

The Interface is unchanged. The Outcome selects a stricter internal policy: broader evidence coverage, academic citation rendering, explicit disagreement, and higher Verification effort. It does not select a separate academic workflow tool.

### 2.4 Learning Outcome

Caller:

```json
{"request":"Teach me closures in JavaScript using one mental model, two worked examples, and a short self-check quiz."}
```

Raven infers `learning` and emits an explanation or study-guide Checkpoint. Later stages test coherence, factual accuracy, sequencing, and whether examples match the mental model. The Artifact shape and Task identity are the same as for Research.

### 2.5 Same-Task Steering Revision

Initial call:

```json
{"request":"Explain event sourcing to backend engineers, with examples."}
```

After receiving `taskId: "rvn_01..."`, the user says the examples should use banking rather than e-commerce. The caller invokes:

```json
{
  "taskId":"rvn_01...",
  "revision":"Use banking examples, emphasize auditability, and keep the existing explanation of replay costs."
}
```

Raven preserves the original Checkpoint and evidence, increments the revision, changes only affected Artifact sections and Verification obligations, and completes the same Task.

### 2.6 Graceful degradation

Caller:

```json
{"request":"Summarize the current positions of three vendors on passkey portability and identify disagreements."}
```

If one vendor page is unreachable, Raven does not discard two inspected positions or elevate a search snippet into evidence. It records the failed Source attempt, qualifies or defers affected Claims, names the coverage gap, and returns a useful Artifact as `completed-with-limits` when the remaining result satisfies the narrowed claim.

## 3. How the four Outcomes share one Interface

The four Outcomes are policy values inside one Raven Task Module, not four public Modules. They share:

- the same start and revision calls;
- one Task identity;
- the same progressive Artifact envelope and Checkpoint versioning;
- the same autonomous stage vocabulary;
- the same Source, Claim, Evidence Link, Verification, and Limitation semantics;
- the same Completion dispositions;
- the same session replay format and same-task steering rules.

Only hidden policy varies:

| Outcome | Typical first Checkpoint | Hidden emphasis | Completion emphasis |
|---|---|---|---|
| Research | findings or outline | source discovery, comparison, synthesis | material external Claims are traceable and appropriately qualified |
| General Writing | outline or draft | audience, structure, voice, transformation | deliverable quality; external Claims traced only when used |
| Academic Writing | thesis/outline or draft section | scholarly evidence, attribution, counterposition, citation style | stricter evidence floor and exact reference consistency |
| Learning | explanation or study guide | sequencing, examples, misconceptions, retrieval/self-check | conceptual coherence, factual grounding, and usable practice |

This is genuine Depth: callers learn one Interface while Raven supplies four useful behaviors. Splitting Outcomes into separate tools would duplicate lifecycle and evidence concepts, force the model to coordinate them, and make cross-Outcome evolution—for example research that becomes a teaching Artifact—a replacement workflow instead of a Steering Revision.

## 4. Hidden implementation

Raven ships as one dependency-light ESM Cordis package. The external Cordis Module contributes:

1. one compact epistemic prompt section;
2. one `raven_task` model tool;
3. canonical tool presentation and replay metadata;
4. fiber-owned cleanup for every registration.

It publishes no process-wide `ctx.raven` service in v1 and has no client half, custom GUI, session database, scheduler, vector store, or model host.

Behind the model-tool Seam, a pure task engine owns:

- input normalization and Outcome inference;
- Task identity and revision compare-and-set logic;
- a reducer for Task, Checkpoint, Source, Claim, Limitation, and Completion state;
- outcome-specific policy tables;
- autonomous transition selection;
- early-Checkpoint heuristics;
- retrieval-time Source registration;
- Claim support and citation-token validation;
- bounded retry, method switching, and failure isolation;
- risk-adaptive Verification;
- exact-final-Artifact checks;
- compact metadata serialization and same-session reconstruction.

Internal seams are permitted for deterministic tests, but they are not caller configuration. Examples include a pure reducer, source registrar, verifier, and outcome policy selector. Tests should primarily cross the same `raven_task` Seam as the model and assert canonical results. Focused pure tests may exercise internal seams where failures need precise locality.

The execution loop is conceptually:

```text
normalize → create/revise task → choose next useful action
          → inspect/capture evidence when needed
          → synthesize/update artifact
          → emit checkpoint
          → continue autonomously
          → verify exact final artifact
          → complete or complete-with-limits
```

This is not a fixed public pipeline. Steering or new evidence may return the hidden implementation from refine to discover, or from verify to draft, while preserving Task identity and monotonic Checkpoint versions.

Session durability uses official `tool/result.meta` as the persistence Seam. Raven stores a versioned, lossless compact projection sufficient to resume the current Task in the same session. Full fetched bodies remain owned by the Harness tool result that retrieved them.

## 5. Dependency Adapters

Adapters sit at internal seams only where behavior actually varies or Harness capability is optional.

### 5.1 Required Adapters

- **Tool Registry Adapter** — registers `raven_task` through the public Harness tools Interface, validates canonical input/output, supplies cancellation, and unregisters on fiber disposal.
- **Prompt Registry Adapter** — contributes the concise epistemic contract through the scoped system-prompt Interface and removes it on disposal.
- **Tool Result Metadata Adapter** — serializes and reconstructs versioned compact Task state using official replay metadata.

These are real Adapters because production Harness implementations and deterministic test implementations both occupy each Seam.

### 5.2 Optional capability Adapters

- **Retrieval Adapter** — uses available Harness web/search/browser tools to inspect external material. When absent, Raven can still perform non-retrieval writing and learning, or complete evidence-dependent work with explicit Limitations when enough inspected evidence already exists.
- **Source Reopen Adapter** — reopens recorded locations for final reference checks when the optional web capability exists. Absence downgrades Verification explicitly; it never fabricates reachability.
- **Subagent Adapter** — delegates bounded separable evidence questions when a subagent provider exists. Without it, the main agent proceeds serially.
- **Workflow Adapter** — used only when model-authored fan-out materially helps a broad Task and the capability exists. Raven does not depend on it for normal progression.
- **Clock/ID Adapter** — deterministic test implementation and production monotonic identity/time implementation. These values support ordering but do not become caller concerns.

Optional capabilities are obtained dynamically and treated as absent when not composed. Raven must not read them as mandatory context properties without an appropriate declared dependency.

### 5.3 Deliberately absent seams

- No public Raven service: there is one consumer and one implementation.
- No storage Adapter: v1 needs same-session compact replay, not cross-session Raven state.
- No Outcome Adapter family: policy variation is internal data, not four substitutable implementations.
- No custom scheduler Adapter: Harness already owns goals, tools, subagents, workflows, cancellation, and lifecycle.
- No browser UI Adapter: visible progress is delivered through tool results and chat.

A second real consumer or implementation can justify extracting a seam later. Until then, these would be hypothetical seams and would reduce Locality.

## 6. Depth, Leverage, and Locality tradeoffs

### 6.1 Why the Interface is deep

The caller learns two call shapes and one result envelope. Behind that small Interface, Raven provides Outcome inference, Task lifecycle, progressive Checkpoints, evidence traceability, autonomous transitions, Steering Revisions, bounded recovery, risk-adaptive Verification, exact-final checks, and replay. Deleting Raven would force those rules back into every model prompt and caller, which passes the deletion test: the Module earns its Depth.

The single call also creates Leverage across all four Outcomes. Improvements to revision handling, Source identity, or graceful degradation benefit every caller and every Outcome without changing their invocation.

### 6.2 Locality gains

- Evidence acceptance rules live in one verifier rather than in prompts for four tools.
- Stage movement and retry policy live in one task engine rather than in caller loops.
- Task identity and replay live in one reducer/projection rather than in ad hoc chat conventions.
- Exact-final checks apply once to the Artifact envelope rather than being reimplemented per deliverable.
- Optional dependency behavior is concentrated in Adapters, so provider absence has one tested disposition.

This Locality lets maintainers fix a citation or revision bug once and makes the model-facing Interface stable even as implementation policy improves.

### 6.3 Costs and risks

- The result envelope is richer than the minimal input. That richness is justified because visible Artifact, evidence traceability, Limitations, and revision identity are user-facing invariants, not implementation trivia. Presentation should summarize it; canonical metadata preserves it.
- Outcome inference can be wrong. The optional `outcome` field and same-task Steering Revision correct it without requiring preflight questions or a replacement Task.
- One tool executor can become a large implementation. Internal pure Modules preserve code Locality and testability without leaking their seams publicly.
- Autonomous continuation may outlive a single synchronous tool turn. The Adapter must map intermediate Checkpoints and final results onto supported Harness execution/session semantics without promising background execution the runtime cannot provide. The invariant is no caller-authored stage protocol, not a bespoke scheduler.
- Same-session metadata does not supply cross-session knowledge or spaced repetition. Adding storage now would lower Depth by expanding configuration and failure modes before a second consumer exists.
- The Integration Report initially suggested a service and several tools/packages, but the later implementation assessment supplies the tighter v1 gate: one ESM package, one tool, no provided service. This design follows that default-first gate while retaining internal pure Modules.

## 7. Recommendation

Adopt the single `raven_task` Interface exactly as specified, with the one-field start call as the default and `taskId + revision` as the only model-facing continuation operation in v1.

Implement it as one host-only ESM Cordis package containing a thin registration layer and a deep pure task engine. Register one compact prompt section and one model tool; persist compact replay state in tool-result metadata; treat web reopening, subagents, and workflows as optional Adapters; and expose no service, client UI, storage domain, worker topology, or stage controls.

Make acceptance tests cross three already-real Seams:

1. Cordis load/unload and registration cleanup;
2. the `raven_task` action Interface, including one-field default invocation and same-task Steering Revision;
3. Source Verification and Completion disposition, including partial failure and exact-final-Artifact checks.

This shape makes the common user/model path trivial without weakening Raven's contract. It preserves one Raven Task, progressive visible Artifact, same-task Steering Revision, traceable external Claims, autonomous transitions, and graceful degradation while maximizing Depth, caller Leverage, and maintenance Locality.
