# Flexible Interface Alternative for Raven v1

## Design intent

Raven v1 should maximize variation behind one stable public Seam. The caller sees one Raven Task and one model tool; it does not select phases, workers, providers, orchestration strategies, or persistence mechanisms. The design obtains flexibility by making the public Module deep and placing narrowly typed internal Interfaces only where v1 already has real variation: Outcome policy, verification policy, source access, and optional execution topology.

This alternative deliberately obeys the lean v1 exclusions: one dependency-light ESM Cordis package, no provided `ctx.raven` service, no client half or GUI, no custom database, scheduler, agent framework, model host, vector store, legacy lifecycle, stage confirmation protocol, or full-page bodies in Raven state.

## 1. Exact public Interface

### 1.1 Public Module and Seam

The external Module is the Raven Cordis plugin. Its public Seam consists of:

1. one scoped prompt section containing the compact epistemic contract; and
2. one scoped model tool named `raven_task`.

There are no public CRUD tools for Sources, Claims, Checkpoints, workers, stages, or verification jobs. Those operations would expose the Implementation and make a shallow Module.

```ts
type Outcome =
  | "research"
  | "general-writing"
  | "academic-writing"
  | "learning";

type VerificationProfile =
  | "standard"
  | "rigorous";

type RavenTaskInput =
  | {
      action: "start";
      outcome: Outcome;
      request: string;
      verification?: VerificationProfile; // default: "standard"
    }
  | {
      action: "advance";
      taskId: string;
      expectedRevision: number;
      contribution: Contribution;
    }
  | {
      action: "steer";
      taskId: string;
      expectedRevision: number;
      revision: {
        instruction: string;
        reason?: string;
      };
    }
  | {
      action: "pause" | "resume" | "stop";
      taskId: string;
      expectedRevision: number;
    }
  | {
      action: "complete";
      taskId: string;
      expectedRevision: number;
      artifact: ArtifactInput;
    };

type Contribution = {
  artifact?: ArtifactInput;
  sources?: SourceInput[];
  claims?: ClaimInput[];
  limitations?: LimitationInput[];
  progress?: {
    stage: "discover" | "read" | "analyze" | "draft" | "verify" | "refine";
    summary: string;
  };
};

type ArtifactInput = {
  kind: "findings" | "outline" | "draft" | "explanation" | "study-guide" | "final";
  content: string;
};

type SourceInput = {
  sourceId: string;
  uri: string;
  title?: string;
  locator: string;
  excerpt: string;
  role?: "primary" | "secondary" | "context";
  family?: string;
  inspected: true;
};

type ClaimInput = {
  claimId: string;
  text: string;
  kind: "external" | "analysis";
  disposition: "supported" | "qualified" | "deferred" | "rejected";
  sourceIds?: string[];
};

type LimitationInput = {
  code:
    | "source-unavailable"
    | "tool-failed"
    | "coverage-incomplete"
    | "contradiction-unresolved"
    | "verification-unavailable"
    | "scope-bounded";
  summary: string;
  affectedSourceIds?: string[];
  affectedClaimIds?: string[];
};

type RavenTaskResult = {
  taskId: string;
  revision: number;
  phase: "active" | "paused" | "stopped" | "completed" | "completed-with-limits";
  outcome: Outcome;
  verification: VerificationProfile;
  checkpoint?: CheckpointView;
  artifact: ArtifactView | null;
  sourceSummary: {
    inspected: number;
    usable: number;
    failed: number;
  };
  claimSummary: {
    supported: number;
    qualified: number;
    deferred: number;
    rejected: number;
  };
  limitations: LimitationView[];
  next: "advance" | "steer" | "resume" | "complete" | null;
};
```

`advance` is an internal lifecycle action exposed to the model through the single tool, not a second user-visible task. It accepts facts already produced by the model or Harness tools and atomically folds them into the current Task. It does not expose which agent, workflow shard, or provider produced them.

The result's replay metadata contains the compact canonical task snapshot: identifiers, revision, phase, Outcome, selected verification profile, current Artifact, Checkpoint identities, normalized Source and Claim records, Steering Revisions, and Limitations. It excludes fetched page bodies, hidden worker transcripts, and provider-specific payloads.

### 1.2 Invariants

1. **Single identity.** `taskId` is allocated by `start` and never changes across Checkpoints, Steering Revisions, pause/resume, provider changes, partial failures, or completion.
2. **One public Task.** Internal agents, workflow runs, retries, and provider calls never allocate public Raven Tasks and never appear in the public Interface.
3. **Monotonic revision.** Every accepted mutating action increments `revision` exactly once. `expectedRevision` is compare-and-set protection against stale model calls and replay races.
4. **Outcome stability.** An Outcome is required at `start`. Changing it is a material public-contract change and is not a Steering Revision; the caller must start a new Task after user authority.
5. **Verification profile stability.** The selected profile is recorded at `start`. A profile may be strengthened by a Steering Revision only when its cost/authority remains permitted; it may not be silently weakened.
6. **Progressive usefulness.** A substantial Task must emit at least one useful Checkpoint before exhaustive collection or final verification. A Checkpoint contains a non-empty Artifact and is useful independently; progress text alone is not a Checkpoint.
7. **Checkpoint immutability.** Each Checkpoint has a stable ID, creation revision, stage observation, Artifact bytes, and evidence snapshot. Later work creates another Checkpoint rather than rewriting an earlier one.
8. **No stage gates.** `discover`, `read`, `analyze`, `draft`, `verify`, and `refine` are observations attached to Checkpoints/progress. Transitioning among them never requires confirmation.
9. **Steering continuity.** `steer` appends a Steering Revision, preserves prior Checkpoints and evidence, increments the Task revision, and causes subsequent Artifact and verification decisions to be evaluated against all non-superseded revisions.
10. **Inspected-source identity.** A Source can be registered only after inspection and requires stable `sourceId`, `uri`, non-empty `locator`, and bounded non-empty `excerpt`. A search result or remembered citation is a lead and cannot be registered as a Source.
11. **Mechanical citation identity.** An Artifact may cite only registered `sourceId` values. Rendering resolves the recorded URI; caller-supplied free-form citation identities are not authoritative.
12. **Claim traceability.** An external Claim with `supported` or `qualified` disposition must reference at least one registered, usable Source. An analysis Claim may have no Sources but must remain classified as analysis.
13. **Failure isolation.** A failed or unreachable Source is marked unusable and cannot support an accepted Claim. Independent Sources, Claims, and Artifact sections survive.
14. **Non-transitive acceptance.** Worker/provider success, worker consensus, workflow completion, and tool success cannot accept a Claim or complete a Task. Only the main Raven reduction and completion checks can do so.
15. **Exact completion target.** `complete` verifies the exact supplied Artifact bytes after the latest substantive edit; verification of a previous draft cannot satisfy completion.
16. **Steering freshness.** Completion requires the final Artifact to reflect the latest Steering Revision or to record a specific Limitation explaining why it cannot.
17. **Completion semantics.** `completed` means the requested Artifact is useful and all checks required by the profile passed. `completed-with-limits` means the Artifact remains useful but one or more visible, bounded Limitations remain. Worker or tool termination is never Completion.
18. **Terminal behavior.** `completed`, `completed-with-limits`, and `stopped` reject `advance`, `steer`, and `complete`. `paused` accepts only `resume`, `stop`, and idempotent `pause`.
19. **Bounded state.** Replay metadata stores compact records and bounded excerpts, never full fetched bodies or another transcript store.
20. **Lifecycle ownership.** Tool and prompt registrations, optional provider handles, listeners, and running orchestration handles are disposer-owned by the Cordis fiber and cancellation-aware.

### 1.3 Action ordering

The legal public transition order is deliberately small:

```text
start -> active
active -> advance* -> active
active -> steer* -> active
active -> pause -> paused -> resume -> active
active|paused -> stop -> stopped
active -> complete -> completed|completed-with-limits
```

Within one accepted `advance`, reduction order is fixed:

1. validate `expectedRevision` and phase;
2. validate and normalize Source additions;
3. record source/tool failures as Limitations;
4. validate Claim references against the post-source registry;
5. mark Claims affected by unusable Sources as `deferred` or `rejected`;
6. apply Artifact changes;
7. evaluate whether the Artifact qualifies as a Checkpoint;
8. append progress/stage observation;
9. increment revision and return one canonical snapshot.

Within `complete`, order is fixed:

1. validate revision, active phase, non-empty Artifact, and latest Steering Revision;
2. freeze the exact candidate Artifact bytes;
3. validate citation tokens and registered Source identities;
4. validate material external Claims and Evidence Links;
5. run deterministic profile checks;
6. optionally reopen Sources through the configured Adapter;
7. classify unresolved issues by affected Claim/Artifact scope;
8. return `completed`, `completed-with-limits`, or a structured rejection while leaving the Task active;
9. persist the resulting compact snapshot in the official tool-result metadata Seam.

Independent checks may execute concurrently, but their results are reduced in deterministic order. Concurrency therefore cannot alter dispositions or revision history.

### 1.4 Error modes

Tool contract violations return a structured tool error and do not mutate task state:

| Code | Meaning | State effect |
|---|---|---|
| `INVALID_INPUT` | Schema, enum, bounded-excerpt, or required-field violation | none |
| `TASK_NOT_FOUND` | Unknown or unreconstructable `taskId` | none |
| `REVISION_CONFLICT` | `expectedRevision` is stale; result includes current revision | none |
| `INVALID_TRANSITION` | Action is illegal for current phase | none |
| `UNKNOWN_SOURCE` | Claim or Artifact cites an unregistered source ID | none |
| `UNINSPECTED_SOURCE` | Attempt to register a lead as an inspected Source | none |
| `UNSUPPORTED_CLAIM` | External supported/qualified Claim lacks usable evidence | none |
| `CHECKPOINT_NOT_USEFUL` | Empty/progress-only Artifact was requested as a Checkpoint | none |
| `STEERING_NOT_APPLIED` | Completion candidate does not reflect latest revision | none; remains active |
| `VERIFICATION_BLOCKED` | Required checks could not run and the affected load-bearing claim cannot be safely limited | none; remains active |
| `COMPLETION_REJECTED` | Artifact is not yet useful or required checks found actionable defects | none; remains active with issues |
| `CAPABILITY_UNAVAILABLE` | A requested nonessential profile feature has no Adapter | either explicit limitation or no mutation, according to profile requirement |
| `CANCELLED` | Harness cancellation occurred before commit | none for the in-flight action; earlier committed revisions survive |
| `INTERNAL_ERROR` | Invariant-preserving unexpected failure | no partial commit; earlier revisions survive |

Operational failures discovered during valid work—dead URLs, failed tools, incomplete coverage, or an unavailable optional verifier—are normally data, not tool errors. They become Limitations, narrow affected Claims, and permit unrelated work to continue. Only an invariant violation, unusable requested Artifact, or inability to satisfy the selected profile blocks completion.

## 2. Usage examples

### 2.1 Progressive Research with a partial source failure

```json
{
  "action": "start",
  "outcome": "research",
  "request": "Compare the documented durability semantics of two session stores.",
  "verification": "rigorous"
}
```

```json
{
  "action": "advance",
  "taskId": "rvn_01J...",
  "expectedRevision": 1,
  "contribution": {
    "sources": [
      {
        "sourceId": "S1",
        "uri": "https://example.test/store-a",
        "title": "Store A documentation",
        "locator": "Durability > Commits",
        "excerpt": "append resolves after the record is durable",
        "role": "primary",
        "inspected": true
      }
    ],
    "claims": [
      {
        "claimId": "C1",
        "text": "Store A acknowledges writes after durable append.",
        "kind": "external",
        "disposition": "supported",
        "sourceIds": ["S1"]
      }
    ],
    "artifact": {
      "kind": "findings",
      "content": "Initial finding: Store A documents durable acknowledgement [S1]. Store B remains under review."
    },
    "limitations": [
      {
        "code": "source-unavailable",
        "summary": "Store B reference returned a transient 503. No claim currently depends on it."
      }
    ],
    "progress": {
      "stage": "read",
      "summary": "Published the first grounded finding while alternative access to Store B is attempted."
    }
  }
}
```

This emits a Checkpoint immediately. Raven continues without asking permission to move from reading to analysis. If Store B remains unavailable after bounded adaptation, the final comparison can complete with limits if it is still useful and explicitly narrows the missing side; it must not fabricate symmetry.

### 2.2 Steering the same Academic Writing Task

```json
{
  "action": "steer",
  "taskId": "rvn_01J...",
  "expectedRevision": 4,
  "revision": {
    "instruction": "Reframe the argument around institutional incentives, retain the prior technical evidence, and use Chicago-style notes.",
    "reason": "The audience is a history seminar."
  }
}
```

Raven appends the Steering Revision, retains previous Checkpoints and Source/Claim identities, and produces a revised outline or draft in a later `advance`. It does not create a replacement research run, discard evidence, expose an internal writing specialist, or ask for a stage confirmation.

### 2.3 General Writing without fake citations

```json
{
  "action": "start",
  "outcome": "general-writing",
  "request": "Draft a concise internal announcement from the facts I provide."
}
```

The Outcome policy may require no external Sources when the Artifact contains only user-provided facts and clearly marked analysis. If the draft introduces an external material assertion, that assertion becomes an external Claim and must be grounded through registered Sources. Flexibility comes from Outcome policy, not from weakening the global traceability invariant.

### 2.4 Learning Outcome with progressive Artifact

```json
{
  "action": "advance",
  "taskId": "rvn_01J...",
  "expectedRevision": 2,
  "contribution": {
    "artifact": {
      "kind": "study-guide",
      "content": "Checkpoint 1: a mental model, two worked examples, and three retrieval questions..."
    },
    "claims": [
      {
        "claimId": "C7",
        "text": "The analogy below is Raven's teaching aid, not a statement from a source.",
        "kind": "analysis",
        "disposition": "qualified"
      }
    ],
    "progress": {
      "stage": "draft",
      "summary": "The learner can begin using the core model while edge cases are verified."
    }
  }
}
```

The Checkpoint is useful before the comprehensive exercise set exists. The user may steer difficulty or emphasis on the same Task.

### 2.5 Exact completion after a last edit

```json
{
  "action": "complete",
  "taskId": "rvn_01J...",
  "expectedRevision": 7,
  "artifact": {
    "kind": "final",
    "content": "...the exact final bytes including [S1] and [S4]..."
  }
}
```

Raven checks this content, not revision 6's draft. If `[S4]` is unknown, completion is rejected with `UNKNOWN_SOURCE`. If `S4` is registered but remote reopening is unavailable under `standard`, Raven records the explicit limitation and applies the profile's disposition rules. Under `rigorous`, a load-bearing unverifiable claim can keep the Task active.

## 3. Hidden Implementation

The public Module is internally deep. The following Modules and seams are private Implementation details; callers never configure or name them.

### 3.1 `TaskReducer` Module

A pure reducer accepts canonical state plus one validated action and returns either the next whole state or a domain error. It owns identity, revision compare-and-set, lifecycle transitions, Steering Revision history, Checkpoint immutability, Source/Claim normalization, failure isolation, and completion disposition.

This is the main test surface beneath the Cordis load Seam. It has no Cordis, network, subagent, workflow, clock, or filesystem dependency. Deterministic IDs and time values are accepted through private factories in tests.

### 3.2 `OutcomePolicy` Interface

```ts
interface OutcomePolicy {
  initialArtifactKinds(): readonly ArtifactInput["kind"][];
  checkpointUseful(state: TaskState, artifact: Artifact): PolicyDecision;
  materialClaims(state: TaskState, artifact: Artifact): readonly ClaimId[];
  completionUseful(state: TaskState, artifact: Artifact): PolicyDecision;
}
```

Four built-in Adapters implement this private Seam:

- `ResearchPolicy`: prioritizes findings/comparison and comprehensive evidence coverage.
- `GeneralWritingPolicy`: prioritizes audience, purpose, coherence, and avoids demanding Sources for purely user-supplied content.
- `AcademicWritingPolicy`: tightens argument, citation, contradiction, and final-reference checks.
- `LearningPolicy`: prioritizes explanatory sequence, worked examples, retrieval practice, and honest separation of teaching analogy from external fact.

All policies share the global evidence invariants. They vary usefulness and required checks, not the meaning of Source, Claim, or Completion.

### 3.3 `VerificationPolicy` Interface

```ts
interface VerificationPolicy {
  plan(state: TaskState, candidate: Artifact): readonly VerificationCheck[];
  dispose(results: readonly CheckResult[]): CompletionDisposition;
}
```

`standard` and `rigorous` are v1 Adapters over the same normalized records. Both run deterministic citation identity, Source record, Claim support, latest-steering, and exact-Artifact checks. `rigorous` may additionally request fresh source reopening, contradiction review, or independent review for load-bearing/high-consequence synthesis.

A future `audit` Adapter can deepen checks without introducing another task lifecycle or evidence schema. The profile name is public because it changes caller-visible cost and assurance; check topology is hidden.

### 3.4 `CheckpointPolicy` Module

This Module decides when a proposed Artifact is useful enough to emit. It enforces an early Checkpoint on substantial work and prevents progress chatter from being mislabeled as an Artifact. It may choose Outcome-specific forms—findings for Research, outline/draft for Writing, mental model/study guide for Learning—without creating stage gates.

### 3.5 `EvidenceIndex` Module

The evidence Module owns Source registration, Claim disposition, citation-token resolution, source-family hints, failure propagation, and bounded excerpts. Its small private Interface provides operations such as `registerSources`, `evaluateClaims`, and `resolveCitations`; callers do not manipulate ledger rows.

An Evidence Link is represented leanly in v1 by `Claim.sourceIds` plus each Source's locator/excerpt. A separate edge table is deferred until a second consumer or richer audit requirement makes that Seam real.

### 3.6 `CompletionEvaluator` Module

This Module composes Outcome and verification policy results into one of:

- accept as `completed`;
- accept as `completed-with-limits` with explicit affected scope; or
- reject completion with actionable issues while retaining `active` state.

It alone may produce a terminal Completion. Orchestration Adapters return candidate Contributions, never terminal authority.

### 3.7 `TaskSnapshotCodec` Module

This Module encodes and reconstructs the latest compact state through the official `tool/result.meta` Seam. It versions the wire format, validates replayed JSON, ignores unrelated events/results, and never stores provider objects or full page bodies. Same-session replay is the v1 durability scope.

### 3.8 Optional topology remains hidden

A private `ContributionRunner` selects among direct main-agent work and optional provider-backed fan-out. Regardless of selection, it returns the same `Contribution` value to `TaskReducer`.

```ts
interface ContributionRunner {
  run(request: InternalWorkRequest, signal: AbortSignal): Promise<ContributionBatch>;
}
```

The runner may split separable evidence questions, but every result is treated as an untrusted candidate Claim. The main reduction validates Source identity and Claim support. Provider names, worker counts, shards, retries, and workflow scripts never enter Task state or user-visible results.

Selection is capability- and policy-driven rather than user-driven:

1. use direct execution for ordinary work;
2. use a subagent Adapter when a bounded separable question benefits from it;
3. use a workflow Adapter only for justified model-authored fan-out;
4. fall back to direct execution or a visible Limitation when an optional capability is absent;
5. never change the public action sequence.

## 4. Dependency Adapters

### 4.1 Cordis/Harness Adapter

`RavenPluginAdapter` is the only external integration Adapter. It:

- injects only required `tools` and `systemPrompt` capabilities;
- registers `raven_task` and its disposer;
- registers one compact prompt section and its disposer;
- reads/writes official tool-result replay metadata;
- passes Harness cancellation into verification and orchestration;
- obtains optional capabilities with `ctx.get(...)` rather than mandatory property access;
- keeps mutable state session-keyed because a preset is a standing mount shared by sessions.

It publishes no process service. The preset row therefore needs no isolate realm solely for Raven.

### 4.2 `SourceAccess` Interface

```ts
interface SourceAccess {
  reopen(source: SourceRecord, signal: AbortSignal): Promise<ReopenResult>;
}
```

Adapters:

- `HarnessWebSourceAdapter` uses the optional Harness web capability when available.
- `UnavailableSourceAdapter` reports capability absence without pretending verification occurred.
- deterministic test Adapters return reachable, mismatched, unavailable, or cancelled results.

Provider-specific response fields are normalized immediately into `ReopenResult`; they cannot leak into Source or Claim records. Future browser, repository, scholarly database, or enterprise search Adapters satisfy this Interface only when they actually need reopening semantics. Discovery/retrieval tools remain owned by Harness; Raven does not build a parallel fetch stack.

### 4.3 `ReviewRunner` Interface

```ts
interface ReviewRunner {
  review(input: ReviewRequest, signal: AbortSignal): Promise<ReviewObservation[]>;
}
```

Adapters:

- `MainAgentReviewAdapter` is always available.
- `SubagentReviewAdapter` uses the optional subagent registry.
- `WorkflowReviewAdapter` uses the optional workflow engine and always disposes holder-owned runs.

Review observations are advisory inputs. They cannot mutate Raven state, accept Claims, or complete a Task.

### 4.4 Provider Adapter normalization

A future provider Adapter must satisfy these rules:

1. accept a bounded internal request plus cancellation;
2. return lossless JSON candidates using Raven-owned types;
3. identify inspected Sources with URI, locator, and excerpt;
4. report failures per candidate/source rather than throwing away successful siblings;
5. expose no worker identity or topology in the public result;
6. make no Completion decision;
7. own and dispose provider handles;
8. use bounded retries: preserve passing work, retry a useful partial once, respawn once where supported, switch method once, then defer/block the affected item.

This is the future-provider Seam with highest Leverage: provider churn remains local to one Adapter while evidence, Checkpoints, steering, and completion remain unchanged.

### 4.5 Persistence Adapter intentionally deferred

There is no v1 storage Interface. Official tool-result metadata already supplies the required same-session replay Seam. Introducing `RavenRepository` with one implementation would be hypothetical and would weaken Locality by duplicating Harness persistence semantics. A versioned storage-domain Adapter becomes justified only when a concrete second lifetime—cross-session corpus, spaced repetition, or reusable projects—is approved.

## 5. Depth and Locality tradeoffs

### 5.1 Where this design gains Depth

The caller learns one tool, six actions, one Task identity, four Outcomes, two assurance choices, and a compact result. Behind that Interface sit progressive Artifact policy, normalized evidence, revision control, risk-adaptive verification, graceful degradation, replay, and optional orchestration. Deleting the Module would force every caller to recreate citation checks, Steering Revision history, partial-failure rules, completion semantics, and topology fallback. That is genuine Depth and caller Leverage.

The single `advance` action is intentionally broader than many CRUD calls. Its atomic Contribution keeps Source-before-Claim ordering local and permits a Source, its Claims, an Artifact, and Limitations to commit coherently. Separate `add_source`, `add_claim`, `publish_checkpoint`, and `record_failure` tools would expose implementation order and multiply invalid intermediate states.

### 5.2 Where flexibility costs interface complexity

`expectedRevision` adds caller ceremony, but it protects replay and concurrent steering with a small, explicit invariant. Without it, stale model calls could silently overwrite newer user direction. This cost buys enough correctness and provider independence to merit inclusion.

`verification` is public because assurance and cost affect the user's contract. In contrast, stage, provider, worker count, retry plan, and topology remain private because exposing them would add knobs without increasing useful Outcome control.

`advance` accepts a structured Contribution, which is a larger type than a prose-only tool. The structure is justified because traceable Sources/Claims and isolated partial failures cannot be reliably recovered from free-form text. The Interface remains deep by keeping normalization rules and ledger mechanics inside.

### 5.3 Locality wins

- Outcome differences live in four policy Adapters, not conditionals scattered through tool handlers.
- Verification-profile differences live in one Verification Module over one evidence model.
- Provider differences terminate at `ContributionRunner`, `SourceAccess`, or `ReviewRunner`; provider payloads do not contaminate Task state.
- All lifecycle/revision rules live in `TaskReducer`.
- All completion authority lives in `CompletionEvaluator`.
- All Harness registration and replay details live in `RavenPluginAdapter` and `TaskSnapshotCodec`.

A bug in citation resolution, partial failure, or Steering Revision handling is fixed once and benefits every Outcome, profile, provider, and topology. This is maintainer Locality and system-wide Leverage.

### 5.4 Avoided shallow seams

Do not create public Interfaces for stage controllers, worker pools, source CRUD, claim CRUD, checkpoint CRUD, provider selection, or storage. Do not split the package into core/service/provider/tool packages in v1. There is one external consumer and one plugin implementation; package proliferation would turn private test seams into deployment obligations.

Private Interfaces should also follow the two-Adapter rule. OutcomePolicy and VerificationPolicy already have multiple Adapters. SourceAccess and ReviewRunner have real available/unavailable or main-agent/provider variations. Other strategies should remain ordinary functions until a second implementation appears.

### 5.5 Test leverage

Tests cross the same meaningful seams:

1. real Loader test: plugin mounts, prompt and one tool register, and disposal removes them;
2. action Interface tests: all legal transitions, compare-and-set conflicts, replay, Checkpoints, Steering Revisions, and terminal phases;
3. evidence/completion tests: unknown citations, unsupported external Claims, failed Source isolation, latest-edit verification, and limited completion;
4. policy matrix: four Outcomes × verification profiles over shared invariants;
5. Adapter contract tests: source reopening normalization, cancellation, bounded failure, and hidden topology equivalence;
6. packed clean-consumer test against Harness `0.1.0-rc.5` and supported Node versions.

Tests should assert canonical records and dispositions, not brittle prose or a specific worker graph.

## 6. Recommendation

Adopt this alternative with one adjustment to the earlier integration report: follow the later assessment's leaner packaging decision and ship one ESM Cordis package rather than a core/plugin family or public `ctx.raven` service. Keep the pure Modules and internal Interfaces as source-level organization inside that package.

Make `raven_task` the sole public action Seam exactly as defined above. Preserve the public concepts that users can meaningfully control—Outcome, request, Steering Revision, pause/resume/stop, and verification profile—while hiding stages, retries, providers, workers, and orchestration topology. Use atomic Contributions to retain Source/Claim traceability and progressive Checkpoints without public CRUD or stage confirmations.

Implement built-in Outcome and verification policy Adapters now because they represent required real variation. Implement Harness web reopening and main-agent review with unavailable/test Adapters. Treat subagent and workflow Adapters as optional acceleration and verification topology, never as semantic dependencies. Defer storage, client UI, Audit profile, cross-session knowledge, and provider-specific retrieval packages until a second concrete consumer or lifetime makes those seams real.

This shape offers the best v1 balance: a small, stable Interface with high Depth; strong Leverage across all four Outcomes and verification profiles; Locality for evidence, lifecycle, and completion rules; and future provider/topology flexibility that does not leak implementation machinery to users.
