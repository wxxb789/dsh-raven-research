# Raven v1 Ports-and-Adapters Interface

## Design intent

Raven v1 should be one deep **Module** whose public **Interface** is one model tool, `raven_task`. The caller sees one continuing Raven Task; the **Implementation** owns autonomous stages, progressive Checkpoints, Steering Revisions, evidence traceability, verification, bounded recovery, and partial-failure disposition.

The design uses ports-and-adapters selectively. A **Seam** is real only where at least two **Adapters** exist or near-term variation is demonstrated. Harness `tools`, `systemPrompt`, and `session` are current platform dependencies, not Raven-owned adapter families. Web source verification and deterministic verification fakes do have two concrete Adapters and therefore justify one internal Seam. Subagents, goals, and workflows remain optional implementation capabilities rather than public Interfaces or mandatory seams.

## Dependency classification

| Dependency or capability | Classification | Raven treatment |
|---|---|---|
| Harness `tools` | Current required dependency | Direct integration in the Cordis plugin; no Raven abstraction over the registry. |
| Harness `systemPrompt` | Current required dependency | Direct scoped prompt registration; no pass-through port. |
| Harness `session` / tool-result metadata | Current required dependency | Direct use for same-session reconstruction and replay; no Raven session repository. |
| Web source reopening | Demonstrated variation | Internal `SourceVerifier` Seam with real Harness-web and deterministic fake Adapters. |
| Deterministic citation/state verification | Core policy, not infrastructure | Hidden pure Implementation called directly; fake inputs enter through `SourceVerifier`. |
| Subagents | Optional current capability | Look up dynamically and use only for separable evidence work; absence does not change the public Interface. |
| Goals | Optional current capability | May support long continuation, but Raven's Task state remains authoritative for Raven semantics. |
| Workflows | Optional current capability | May provide model-authored fan-out; never exposed as Raven stages or task identity. |
| Storage domain | Hypothetical v1 variation | No Seam and no dependency. Same-session state uses official Harness replay metadata. |
| Custom scheduler, model host, GUI | Non-requirement | Excluded. |

## 1. Exact public Interface

### 1.1 One tool, one Raven Task

```ts
type RavenOutcome =
  | "research"
  | "general-writing"
  | "academic-writing"
  | "learning";

type RavenTaskAction =
  | {
      action: "start";
      outcome: RavenOutcome;
      request: string;
      audience?: string;
      deliverable?: string;
      evidenceFloor?: "none" | "source-backed" | "academic";
    }
  | {
      action: "continue";
      taskId: string;
    }
  | {
      action: "steer";
      taskId: string;
      revision: string;
    }
  | {
      action: "pause";
      taskId: string;
    }
  | {
      action: "resume";
      taskId: string;
    }
  | {
      action: "stop";
      taskId: string;
    };

type RavenTaskPhase =
  | "active"
  | "paused"
  | "stopped"
  | "completed"
  | "completed-with-limits";

type RavenStage =
  | "discover"
  | "read"
  | "analyze"
  | "draft"
  | "verify"
  | "refine";

interface RavenTaskResult {
  taskId: string;
  phase: RavenTaskPhase;
  stage: RavenStage;
  revision: number;
  checkpoint: RavenCheckpoint;
  limitations: RavenLimitation[];
  next: "continue-autonomously" | "await-steering" | "resume" | "none";
}

interface RavenCheckpoint {
  checkpointId: string;
  ordinal: number;
  kind: "outline" | "findings" | "draft" | "explanation" | "study-guide" | "final";
  artifact: string;
  sourceReferences: Array<{ sourceId: string; url: string }>;
  claimSummary: Array<{
    claimId: string;
    disposition: "supported" | "qualified" | "deferred" | "rejected" | "analysis";
    sourceIds: string[];
  }>;
  appliedRevision: number;
  createdAt: string;
}

interface RavenLimitation {
  code:
    | "SOURCE_UNAVAILABLE"
    | "SOURCE_UNVERIFIED"
    | "TOOL_FAILED"
    | "COVERAGE_INCOMPLETE"
    | "CONTRADICTION_UNRESOLVED"
    | "OPTIONAL_CAPABILITY_UNAVAILABLE"
    | "SCOPE_DECISION_REQUIRED";
  message: string;
  affectsClaimIds: string[];
  recoverable: boolean;
}
```

The actual Harness tool schema should be a discriminated union equivalent to `RavenTaskAction`. Its canonical result should be lossless JSON equivalent to `RavenTaskResult`; model rendering may abbreviate records but must not alter their meaning.

`continue` is primarily an internal continuation action available to the model/runtime. Users should not have to type “continue” between normal stages. The same action allows resumable execution when a tool turn or budget ends before Completion.

### 1.2 Interface invariants

1. **Single identity.** `start` creates exactly one `taskId`. Research, drafting, verification, steering, pause, resume, and Completion retain that identity.
2. **One active Raven Task per agent/session in v1.** Starting another while one is `active` or `paused` returns `ACTIVE_TASK_EXISTS`; it does not replace or fork the Task.
3. **Outcome stability.** `outcome` is fixed after `start`. A Steering Revision may change emphasis, scope, audience, or deliverable only when still meaningfully the same requested Outcome; otherwise Raven asks for a new Task rather than silently mutating identity.
4. **Monotonic revisions.** `revision` begins at `0`. Each accepted `steer` increments it by exactly one and records the user text. Prior revisions remain preserved.
5. **Monotonic Checkpoints.** `ordinal` strictly increases within a Task. A Checkpoint is immutable once emitted; later work emits another Checkpoint rather than rewriting history.
6. **Progressive usefulness.** A substantial Task emits at least one useful non-final Checkpoint before exhaustive collection or final verification. Small Tasks may complete in one Checkpoint when an intermediate artifact would add no steering value.
7. **Applied steering.** Every newly emitted Checkpoint records the latest accepted `appliedRevision`. Completion is forbidden if the final Checkpoint does not apply the latest revision.
8. **Stages are observations.** `discover`, `read`, `analyze`, `draft`, `verify`, and `refine` are autonomous internal progress labels, not approval gates and not separate Tasks.
9. **Inspected-source rule.** A URL, search result, remembered citation, or worker report is not a `Source` until Raven has inspected material at a stable identity and captured a locator plus bounded excerpt.
10. **Citation identity.** An external citation in an Artifact may reference only a registered `sourceId`; rendering resolves its URL mechanically from the Source record.
11. **Material-claim evidence.** A material external Claim cannot be `supported` or `qualified` with an empty source set, an unknown `sourceId`, or only a failed Source. Raven-authored inference or judgment is marked `analysis`, not disguised as external fact.
12. **Evidence preservation.** Steering and refinement may supersede Claims in the current Artifact but never delete prior Sources, Evidence Links, Checkpoints, failures, or revision history.
13. **Non-transitive authority.** Subagent and workflow output is input to main-agent judgment. Worker agreement, workflow completion, or tool success cannot accept a Claim or complete a Task.
14. **Exact-final verification.** Completion checks the exact final Artifact bytes after the last substantive edit, all rendered source IDs, registered URLs, material Claim links, and latest Steering Revision.
15. **Partial survival.** A failed Source, tool, worker, or optional capability invalidates only dependent Claims/work. Independent accepted Claims and useful Artifact content survive.
16. **Bounded recovery.** For one failing operation class, Raven may retry once, change method once, and then record a Limitation or require a material scope decision. It must not loop indefinitely.
17. **Terminal meaning.** `completed` means required checks passed without unresolved material limitations. `completed-with-limits` means the Artifact is useful and checks ran, but visible Limitations narrow its claims. Tool termination alone never means Completion.
18. **Lifecycle preservation.** `pause`, `stop`, and `resume` preserve Task history. `resume` continues a paused or stopped Task; it does not create a new identity.
19. **Session locality.** v1 reconstructs the latest compact Task state from Harness session/tool-result metadata. It does not promise cross-session or cross-agent recovery.
20. **JSON ownership.** Persisted and returned state is detached, lossless JSON containing summaries and bounded excerpts, never live Harness objects or full fetched pages.

### 1.3 Ordering constraints

For a substantial `start`:

1. Validate the request and determine whether a material unresolved decision requires user input.
2. Allocate the Task identity and persist compact initial state.
3. Discover leads, inspect at least the credible material needed for an early Artifact, and register Sources only upon inspection.
4. Analyze the available evidence and emit the first useful Checkpoint.
5. Continue autonomously through further discovery, reading, analysis, drafting, verification, and refinement; stage order may overlap or repeat where evidence requires it.
6. Apply any Steering Revision before the next emitted Checkpoint and before accepting final Claims.
7. Run deterministic checks against the exact candidate final Artifact.
8. Reopen recorded URLs through `SourceVerifier` where configured; convert unavailable checks to scoped Limitations unless affected Claims lack sufficient remaining support.
9. If verification changes the Artifact, run exact-final deterministic checks again.
10. Emit a final Checkpoint, then choose `completed` or `completed-with-limits`.

Lifecycle ordering:

- `pause` is valid only for `active`; repeated `pause` is idempotent.
- `resume` is valid for `paused` or `stopped`; it restores `active` while preserving stage, revision, and evidence.
- `stop` is valid for `active` or `paused`; repeated `stop` is idempotent.
- `steer` is valid for `active`, `paused`, or `stopped`. When not active, it records the revision and applies it after `resume`.
- `continue` is valid only for `active`. It advances the same Task and may emit zero or more internal progress observations but returns one latest Checkpoint.
- Terminal Tasks reject lifecycle mutation. A materially new request starts a new Task.

### 1.4 Error modes

Tool-level errors are reserved for malformed commands or violated identity/concurrency contracts. Research and verification failures are normally data in `limitations`, not thrown errors.

| Error code | Condition | State effect |
|---|---|---|
| `INVALID_ACTION` | Input does not match an action schema. | No state created or changed. |
| `TASK_NOT_FOUND` | `taskId` is absent from reconstructable same-session state. | No state changed. |
| `ACTIVE_TASK_EXISTS` | `start` is called while another Task is active or paused. | Existing Task remains unchanged. |
| `INVALID_PHASE_TRANSITION` | Action is illegal for current public phase. | No state changed. |
| `TASK_TERMINAL` | A terminal Task receives `continue`, `steer`, `pause`, `resume`, or `stop`. | No state changed. |
| `STATE_CONFLICT` | Reconstructed revision/checkpoint ordering is inconsistent or stale. | Refuse mutation; expose a recoverable internal-state Limitation or diagnostic. |
| `SCOPE_DECISION_REQUIRED` | Continuing would materially change outcome, evidence floor, audience, deliverable, cost cap, or side effects. | Preserve Task as paused/active without pretending progress; ask one concrete question. |
| `HARNESS_DEPENDENCY_UNAVAILABLE` | A required current dependency (`tools`, `systemPrompt`, or required session facility) is absent at plugin activation. | Cordis activation waits/fails; no partially registered Raven Interface. |
| `INTERNAL_INVARIANT_VIOLATION` | Hidden Implementation would emit invalid evidence, ordering, or Completion state. | Do not emit invalid Checkpoint; preserve last valid compact state and return a diagnostic failure. |

Failures such as HTTP errors, source disappearance, subagent failure, workflow failure, goal absence, cancellation after partial work, or verifier timeout become typed Limitations. They only prevent Completion when they contaminate a required Claim, leave the requested Artifact unusable, or prevent mandatory exact-final checks.

## 2. Usage examples

### Research Task with progressive Checkpoint

```json
{
  "action": "start",
  "outcome": "research",
  "request": "Compare the documented durability semantics of two event stores.",
  "evidenceFloor": "source-backed"
}
```

```json
{
  "taskId": "rav_01J...",
  "phase": "active",
  "stage": "analyze",
  "revision": 0,
  "checkpoint": {
    "checkpointId": "cp_01J...",
    "ordinal": 1,
    "kind": "findings",
    "artifact": "Initial comparison with two inspected primary sources...",
    "sourceReferences": [
      { "sourceId": "src_1", "url": "https://example.org/a" },
      { "sourceId": "src_2", "url": "https://example.org/b" }
    ],
    "claimSummary": [
      { "claimId": "clm_1", "disposition": "supported", "sourceIds": ["src_1"] },
      { "claimId": "clm_2", "disposition": "qualified", "sourceIds": ["src_2"] }
    ],
    "appliedRevision": 0,
    "createdAt": "2026-06-18T12:00:00Z"
  },
  "limitations": [],
  "next": "continue-autonomously"
}
```

The agent continues without asking for stage approval.

### Steering the same Task

```json
{
  "action": "steer",
  "taskId": "rav_01J...",
  "revision": "Focus the final comparison on crash recovery and remove pricing."
}
```

The result retains `taskId`, increments `revision` to `1`, preserves earlier Checkpoints and Sources, and emits a later Checkpoint with `appliedRevision: 1`. Pricing Claims may become deferred or omitted from the current Artifact but remain traceable in history.

### Completion with a partial source failure

```json
{
  "taskId": "rav_01J...",
  "phase": "completed-with-limits",
  "stage": "verify",
  "revision": 1,
  "checkpoint": {
    "checkpointId": "cp_final",
    "ordinal": 3,
    "kind": "final",
    "artifact": "Final comparison...",
    "sourceReferences": [
      { "sourceId": "src_1", "url": "https://example.org/a" }
    ],
    "claimSummary": [
      { "claimId": "clm_1", "disposition": "supported", "sourceIds": ["src_1"] },
      { "claimId": "clm_2", "disposition": "deferred", "sourceIds": ["src_2"] }
    ],
    "appliedRevision": 1,
    "createdAt": "2026-06-18T12:08:00Z"
  },
  "limitations": [
    {
      "code": "SOURCE_UNAVAILABLE",
      "message": "The second vendor page could not be reopened; its dependent claim was deferred.",
      "affectsClaimIds": ["clm_2"],
      "recoverable": true
    }
  ],
  "next": "none"
}
```

The independent crash-recovery comparison survives; the unavailable page does not support an accepted Claim.

### Writing Task without artificial research ceremony

```json
{
  "action": "start",
  "outcome": "general-writing",
  "request": "Rewrite this announcement for a technical audience: ...",
  "audience": "software engineers",
  "evidenceFloor": "none"
}
```

For a short transformation, Raven may return one verified final Checkpoint. It still maintains Task identity and revision semantics, but does not invent Sources or force a discovery stage.

### Pause, steer, and resume

```json
{ "action": "pause", "taskId": "rav_01J..." }
```

```json
{
  "action": "steer",
  "taskId": "rav_01J...",
  "revision": "Use an undergraduate audience and add a glossary."
}
```

```json
{ "action": "resume", "taskId": "rav_01J..." }
```

The next Checkpoint applies the new revision and retains all prior evidence.

## 3. Hidden Implementation

The public Interface deliberately hides the following Raven machinery inside one package:

```text
Raven Cordis plugin
├── direct Harness registrations
│   ├── tools: register raven_task
│   ├── systemPrompt: concise epistemic contract
│   └── session/tool-result metadata: compact reconstruction
└── Raven Task Module
    ├── action dispatcher and phase transition policy
    ├── immutable task reducer
    ├── stage planner and bounded recovery policy
    ├── Source registry and identity normalization
    ├── Claim classification and evidence validation
    ├── Checkpoint builder and citation renderer
    ├── Steering Revision application
    ├── exact-artifact deterministic verifier
    ├── completion/limitation disposition
    ├── internal SourceVerifier Seam
    └── optional orchestration collaborators
```

Recommended hidden records include:

- `TaskState`: identity, outcome, public phase, observed stage, revision counter, compact scope, latest Artifact, Checkpoint identities, retry counters, and Limitations.
- `SourceRecord`: stable `sourceId`, canonical URL or identity, title when known, locator, bounded excerpt, role/family metadata when known, inspection timestamp, and check status.
- `ClaimRecord`: `claimId`, text or compact proposition, kind (`external` or `analysis`), disposition, `sourceIds`, contradiction state, and Artifact locations where used.
- `SteeringRevisionRecord`: monotonic revision, user text, acceptance timestamp, and applied Checkpoint ordinal.
- `VerificationReport`: deterministic issues, SourceVerifier outcomes, affected Claims, exact Artifact digest held only for the operation if needed, and proposed Completion disposition.

These are Implementation details, not additional public tools. In particular, do not expose source CRUD, claim CRUD, stage transitions, worker topology, verifier calls, or completion acceptance as separate model tools. Deleting the Raven Task Module would force evidence rules, retry behavior, revision application, checkpoint ordering, and completion checks into every caller; that deletion test shows the Module earns its **Depth**.

State transitions should be pure where possible: reduce an action plus owned records into a proposed next state, validate all invariants, then return the canonical result and replay metadata. External operations occur around that reducer and return small owned values. This gives tests the same `raven_task` Interface used by production while allowing focused hidden tests for high-risk pure policies.

The prompt section should contain only stable epistemic rules: inspect before citing, distinguish external evidence from analysis, preserve uncertainty, keep working autonomously, expose useful Checkpoints, and verify the exact final Artifact. Dynamic Task data belongs in tool results/session reconstruction, not an expanding prompt manual.

## 4. Dependency Adapters and Seam placement

### 4.1 Real internal Seam: `SourceVerifier`

Near-term variation is explicit: production can reopen Sources through an optional Harness web capability, while tests need deterministic reachability and identity outcomes.

```ts
interface SourceVerifier {
  verify(requests: readonly SourceVerificationRequest[], signal: AbortSignal):
    Promise<readonly SourceVerificationResult[]>;
}

interface SourceVerificationRequest {
  sourceId: string;
  url: string;
  expectedLocator: string;
  expectedExcerpt: string;
}

type SourceVerificationResult =
  | { sourceId: string; status: "verified"; resolvedUrl: string }
  | {
      sourceId: string;
      status: "unavailable" | "moved" | "content-mismatch" | "timeout";
      detail: string;
    };
```

Adapters:

1. **HarnessWebSourceVerifier Adapter** — uses the available Harness web source-opening capability, applies cooperative cancellation/timeouts, and returns small owned records rather than page bodies.
2. **DeterministicSourceVerifier Adapter** — maps input identities to predefined outcomes for unit and integration tests; it models success, redirects, timeouts, unavailable pages, and mismatched excerpts without network access.

The Seam does not decide whether a Claim remains acceptable. That policy stays in the Raven Task Module, preserving **Locality** for evidence and Completion rules. The Adapter only reports observations.

### 4.2 Current Harness dependencies: direct, not wrapped

The Cordis plugin should declare required `tools` and `systemPrompt` dependencies according to the pinned Harness contract and directly register the tool and prompt disposers. It should use the supported session/tool-result metadata mechanism directly for replay. Creating `ToolRegistryPort`, `PromptPort`, or `SessionRepositoryPort` would merely mirror one current Adapter and reduce **Depth** through pass-through Interfaces.

The Cordis load location is still an acceptance-test Seam because Raven can be loaded or omitted through composition, but it does not require a Raven-owned abstraction. Lifecycle cleanup remains fiber-owned.

### 4.3 Optional collaborators: capability checks, not public ports

- **Subagents:** if present, the Implementation may delegate bounded, separable evidence questions. Results re-enter as untrusted candidate Claims. Absence records no Limitation unless the Task explicitly required independent review and no equivalent method exists.
- **Workflows:** if present and justified by broad fan-out, Raven may run one and must dispose its holder. Workflow topology and status remain hidden.
- **Goals:** if present, they may continue long work across autonomous rounds. Goal state never replaces Raven Task phase, revision, or Completion semantics.

These can initially be small private capability-specific collaborators around `ctx.get(...)`, not formal Raven-wide Seams. Introduce a stable Interface only after a second Adapter is implemented—for example, both direct bounded subagent execution and workflow fan-out satisfying the same demonstrated orchestration need. Until then, wrapping each Harness feature creates hypothetical variation.

### 4.4 Adapters intentionally absent

- No Raven storage Adapter: only same-session replay is required, and Harness owns it.
- No Raven session persistence Adapter: Raven must not implement or proxy Harness persistence.
- No custom LLM/model Adapter: Harness owns model routing and execution.
- No client/UI Adapter: tool results and chat supply v1 visibility.
- No custom scheduler Adapter: autonomous stages are Raven policy executed with current Harness facilities.
- No multiple public Outcome Adapters: the four Outcomes are values in one Task Interface, not separate Modules.

## 5. Depth, Leverage, and Locality tradeoffs

### Public Interface Depth

One action-oriented tool is deeper than separate tools for create/update-source, create/update-claim, checkpoint, verify, steer, and complete. The caller learns one identity model, one action union, one result shape, and a concise set of invariants. Behind it, Raven enforces evidence registration, progressive delivery, revisions, retries, exact-final verification, and partial Completion. This gives high **Leverage** across all four Outcomes and across both production calls and acceptance tests.

The cost is that `raven_task` has a nontrivial discriminated union and stateful ordering rules. That complexity is irreducible business meaning, not accidental surface area. Keeping actions in one tool avoids exposing internal topology while making illegal transitions explicit.

### Evidence Locality

Source identity, Claim disposition, citation rendering, and Completion checks remain in the same Raven Task Module. This maximizes **Locality**: a correction to “failed Sources cannot support accepted Claims” is made once and affects every Outcome and final check. Splitting a source repository, claim manager, citation module, and verifier service into public packages would distribute one invariant over several Interfaces.

The tradeoff is a larger hidden Implementation. That is acceptable because **Depth** is measured by caller leverage, not implementation line count. Private functions and records can remain internally factored without becoming public Seams.

### Harness Locality

Direct use of `tools`, `systemPrompt`, and session metadata localizes RC-specific integration in the thin Cordis plugin. The pure Raven Task Implementation should not import Harness objects. If the pinned Harness RC changes, registration code changes in one place; Raven does not maintain parallel abstractions that duplicate the platform contract.

The tradeoff is deliberate version coupling at the plugin edge. Pinning and packed-consumer tests are more honest than claiming portability through one-Adapter ports.

### Source-verification Locality

The `SourceVerifier` Seam isolates nondeterministic reopening while keeping evidence policy above it. Tests gain deterministic, exhaustive failure scenarios, and production gains optional remote verification. This is a real two-Adapter Seam with useful **Leverage**: the same completion logic is exercised against network and fake outcomes.

The tradeoff is that the fake must emulate observation outcomes, not reimplement completion policy. Allowing an Adapter to declare a Task complete would split authority and reduce **Locality**.

### Optional orchestration tradeoff

Keeping subagents, workflows, and goals hidden prevents their provider topology from leaking into the Raven Interface and permits graceful absence. It also means Raven cannot initially swap orchestration strategies through one uniform formal port. That is preferable in v1 because the strategies do not yet share a demonstrated stable contract. Add the Seam when actual second-Adapter usage reveals the common Interface, not before.

### Persistence tradeoff

Using official session replay metadata provides high **Leverage** with minimal surface and avoids a competing database. The limitation is explicit: Raven v1 offers same-session reconstruction, not cross-session projects or a reusable corpus. Adding a storage Seam now would buy hypothetical portability at the cost of configuration, migrations, lifecycle ownership, and a shallower package family.

## 6. Recommendation

Implement Raven v1 as one dependency-light ESM Cordis package with no provided process service, no client half, no custom storage, and no public workflow topology.

Its external **Seam** is the Harness model-tool registry, where the package contributes exactly one deep `raven_task` **Interface**, plus a concise scoped prompt contribution. Use Harness session/tool-result metadata directly to reconstruct compact same-session Task state. Keep all Task semantics in a hidden Raven Task **Module**.

Create exactly one Raven-owned internal Seam now: `SourceVerifier`, with `HarnessWebSourceVerifier` and `DeterministicSourceVerifier` **Adapters**. Keep deterministic evidence and Completion policy above that Seam. Integrate required Harness `tools`, `systemPrompt`, and session facilities directly; treat subagents, goals, and workflows as optional hidden capabilities. Do not create ports for dependencies with only one Adapter.

Release acceptance should verify through the same public Interface:

1. Cordis load/unload registration and cleanup;
2. all action and phase ordering rules;
3. one continuing Task identity across Steering Revisions;
4. progressive Checkpoint ordering and preservation;
5. rejection of unknown or failed Source support;
6. deterministic and web-verifier Adapter parity at the `SourceVerifier` Seam;
7. exact-final Artifact verification after the last revision/edit;
8. bounded retries and independent partial-result survival;
9. `completed` versus `completed-with-limits` disposition;
10. same-session replay from canonical tool-result metadata; and
11. packed clean-consumer compatibility with DeepSeek Harness `0.1.0-rc.5` on Node `^22.19.0 || >=24`.

This shape best balances **Depth**, **Leverage**, and **Locality**: one small user/model Interface hides substantial trusted behavior; platform coupling stays at one plugin edge; the only Raven-owned Adapter family corresponds to demonstrated variation; and future Seams are added only when actual adapters or consumers make them real.
