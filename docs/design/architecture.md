# Raven v1 Architecture

## Alternatives compared

### Minimal one-entry-point design

[`alternatives/minimal-interface.md`](./alternatives/minimal-interface.md) reduces the
model interface to `advance` and `stop`. It has the highest apparent Depth and the
smallest schema, but `advance` conflates task creation, state inspection, evidence
capture, checkpoint publication, steering, verification, and completion. In the
actual Harness execution model the main model—not the tool executor—does the web
research and writing between tool calls. A magical `advance` would therefore hide
which contribution is being committed and make failures difficult to diagnose.

### Default-first design

[`alternatives/default-first-interface.md`](./alternatives/default-first-interface.md)
makes a one-field request the common path and infers the Outcome. This is ideal for
a hypothetical caller that asks Raven to run another model loop. Raven v1 is instead
a native plugin inside the loop: the user already gives the request to the Harness
agent, which uses Raven to maintain one durable Task. Repeating the request through
the tool would add a second orchestration layer.

### Flexible contribution design

[`alternatives/flexible-interface.md`](./alternatives/flexible-interface.md) makes
state transitions and atomic evidence/artifact contributions explicit. It best fits
the real execution boundary and gives strong Locality for Source-before-Claim
validation. Its public verification profiles, compare-and-set revisions, and six
lifecycle actions are more flexibility than v1 needs.

### Ports-and-adapters design

[`alternatives/ports-adapters-interface.md`](./alternatives/ports-adapters-interface.md)
correctly distinguishes current Harness dependencies from real variation. It avoids
pass-through wrappers around `tools`, `systemPrompt`, and session metadata and
introduces one real internal Seam, `SourceVerifier`, with production and
deterministic Adapters. This is the strongest dependency design.

## Decision

Raven v1 combines the flexible contribution design with the selective Seam placement
of the ports-and-adapters design.

The user-facing contract is one **Raven Task**. The native package contributes one
model tool, `raven_task`, whose action variants maintain that Task, and one compact
prompt section that tells the existing Harness agent how to use it. The tool does
not run another model, scheduler, or public workflow. The Harness agent performs
research and writing with its existing tools, then atomically contributes Sources,
Claims, Limitations, and an Artifact Checkpoint to Raven.

This preserves a deep external Module while avoiding a semantically overloaded
`advance` operation. Tool actions are an internal protocol for the model, not new
user-visible tasks or stages.

## External Interface

The Cordis plugin exports named `name`, `inject`, and `apply` values. It has no
default export, no client half, and no provided process service.

```ts
type RavenTaskAction =
  | {
      action: "start"
      outcome: "research" | "general-writing" | "academic-writing" | "learning"
      request: string
      grounding?: "required" | "optional" | "none"
    }
  | {
      action: "checkpoint"
      taskId: string
      stage: "discover" | "read" | "analyze" | "draft" | "verify" | "refine"
      summary: string
      artifact: string
      sources?: SourceInput[]
      claims?: ClaimInput[]
      failures?: FailureInput[]
    }
  | { action: "steer"; taskId: string; correction: string }
  | { action: "complete"; taskId: string; artifact: string }
  | { action: "status"; taskId?: string }
  | { action: "stop"; taskId: string; reason?: string }
  | { action: "resume"; taskId: string }
```

The tool is exclusive by default because it does not opt into Harness parallel tool
execution. Same-Task mutations therefore serialize inside one agent without adding
an `expectedRevision` field that the model must echo. The state still carries a
monotonic revision for audit and replay validation. The tool schema enforces shape,
enums, required fields, and unknown-key rejection. The current Harness JSON Schema
subset has no `maxLength` or `maxItems`, so bound descriptions are model guidance—not
registry constraints. The engine and replay codec are the executable enforcement
owners for every text/collection ceiling, including direct callers that bypass the
registry.

### Why these actions exist

- `start` establishes one Task identity and Outcome before work is recorded.
- `checkpoint` atomically commits an independently useful Artifact plus the evidence
  and failures that inform it. Stages are observations, never approval gates.
- `steer` appends a Steering Revision to the same Task and invalidates stale final
  verification.
- `complete` verifies the exact candidate Artifact and recorded source references.
  It either completes, completes with explicit Limitations, or returns actionable
  issues while leaving the Task active.
- `status` reconstructs compact state after resume or compaction.
- `stop` and `resume` let the user interrupt work without losing or replacing the
  Task.

There is deliberately no public Source CRUD, Claim CRUD, worker management,
verification job, workflow stage controller, or approval action.

## Domain records

### Task state

One compact JSON state contains:

- Task ID, Outcome, request, grounding policy, phase, monotonic revision, and times;
- Steering Revisions;
- immutable Checkpoint descriptors and the latest Artifact;
- normalized Sources and Claims;
- Source/tool/coverage Limitations;
- the most recent verification receipt and exact Artifact SHA-256.

Task phases are `active`, `stopped`, `completed`, and `completed-with-limits`.
Normal research stages do not appear as phases.

### Source

A Source has a stable ID, canonical HTTP(S) URL, title, locator, bounded excerpt,
optional role/family/as-of metadata, inspection time, and source-check result.
Registration rejects credential-bearing URLs, duplicate identities, missing
locators/excerpts, and any attempt to change the URL, title, locator, excerpt, role,
family, or as-of metadata behind an existing ID. Exact resubmission is idempotent and
preserves the prior verification record; changed evidence requires a new Source ID.

A search result, snippet, remembered citation, or worker mention is not a Source
until the main agent has inspected it and supplies the locator and bounded verbatim
excerpt. Before an externally grounded Checkpoint is published, Raven independently
reopens the URL and requires that excerpt to occur in the retrieved body after
HTML/entity and whitespace presentation normalization.

### Claim

A Claim has a stable ID, text, `external | analysis` kind,
`material | context` importance, `supported | qualified | deferred | rejected`
disposition, and Source IDs. A supported or qualified external Claim cannot have an
empty, unknown, or failed Source set. Reusing a Claim ID for different text is
rejected rather than silently rewriting provenance.

### Artifact and citations

Artifacts cite Sources with `[@source-id]` tokens. Raven validates the tokens and
mechanically renders them as Markdown links from Source records, followed by a
Sources list and a generated Claim trace that maps every material supported/qualified
Claim ID and escaped text to its Source IDs. Source titles, locators, and Claim text
are Markdown/HTML escaped before rendering. Unknown IDs and unregistered raw external
URLs are rejected. This keeps the URL and Claim↔Source mapping outside model memory;
literal anchor matching does not replace main-agent semantic entailment judgment.

The Claim trace also annotates independence. A Claim citing two or more Sources that
all declare one `sourceFamily` renders as a single family and explicitly not as
independent corroboration, and undeclared families render as unverified rather than
being assumed independent. Family is declared by originating record and institutional
lineage, never derived from host: outlets republishing one wire item are one family,
while distinct formal documents on one host may be separate families. Raven does not
mechanically require multiple families, because independence only counts for the same
atomic proposition — two Sources each supporting a different clause of a compound Claim
are not cross-verification, and that judgment stays with the agent. Raven enforces only
what it can verify and makes the rest impossible to misread.

A Checkpoint stores its immutable ordinal, stage observation, summary, Artifact
SHA-256, character count, creation time, and applied Steering Revision. The latest
Artifact content remains in compact state; older full contents already live in
prior durable tool results, avoiding quadratic snapshot growth. Request, Artifact,
summary, correction, Source, Claim, Limitation, Checkpoint, and Steering collections
all have executable size ceilings shared by action validation and replay decoding.

## Progressive execution

The prompt requires this observable cadence for substantial work:

```text
start Raven Task
→ use existing Harness tools to inspect an initial credible source set
→ reopen the recorded URLs and match the bounded excerpts
→ checkpoint a useful outline, draft, explanation, or findings
→ continue research and evidence checks without asking permission
→ apply user correction as a Steering Revision on the same Task
→ emit a revised Checkpoint for every substantive final edit
→ complete only those exact latest Checkpoint bytes
```

A Checkpoint result renders the useful Artifact immediately while the Task remains
active. The user can react to it while the Harness agent proceeds through later
model/tool steps. The system never treats a progress slogan as a Checkpoint.

## Completion and graceful degradation

`checkpoint` and `complete` both ask the `SourceVerifier` to reopen relevant URLs
and match recorded excerpts. `complete` also performs deterministic checks against
the exact latest Checkpoint fingerprint.

Completion is rejected, with no state loss, when:

- the final Artifact has unknown citation IDs or unknown raw URLs;
- no useful prior Checkpoint exists;
- the latest Steering Revision has no subsequent Checkpoint;
- the candidate bytes differ from the exact latest Checkpoint fingerprint;
- a material supported/qualified external Claim lacks a Source citation in the
  final Artifact;
- a cited Source is broken, unavailable, or lacks its recorded excerpt;
- a grounding-required Task has no material supported/qualified external Claim with
  at least one currently reachable, excerpt-matched Source. A zero-valid-work result
  remains active even when its coverage failure is honest.

The Task becomes `completed-with-limits` rather than failing wholesale when the
Artifact remains useful after failed dependencies have been removed from accepted
support, affected Claims are deferred, and coverage Limits are explicit. A broken or
unverifiable Source cannot appear in the completed Artifact as accepted support.
Independent verified Sources, Claims, and Artifact sections survive. When a Source
later fails verification, Raven automatically defers every supported/qualified Claim
whose usable support set becomes empty and records a Source Limitation.

Every substantive final edit must first become a Checkpoint; Completion requires the
candidate SHA-256 to equal that exact latest post-steer Checkpoint fingerprint.
Tool, worker, or scheduler completion is never Raven Completion.

## Internal Modules

### Task engine

A pure Task engine parses one action, restores the latest state, proposes a complete
next state, validates invariants, and returns either the next state or an actionable
non-mutating result. It owns all lifecycle, revision, Checkpoint, Source, Claim,
citation, and completion semantics.

### Source verifier Seam

This is the one Raven-owned infrastructure Seam in v1:

```ts
interface SourceVerifier {
  verify(sources: readonly SourceRecord[], signal: AbortSignal):
    Promise<readonly SourceCheckResult[]>
}
```

Two real Adapters justify it:

1. `HarnessWebSourceVerifier` dynamically reads the optional `ctx.web` capability,
   reopens URLs with the tool cancellation signal, normalizes HTML/entity/whitespace
   presentation, rejects cross-host resolution, and marks a Source reachable only
   when its bounded excerpt occurs in the retrieved body. Provider absence, identity
   drift, or mismatch is never fabricated success. Extraction distinguishes block-level
   from inline elements: block boundaries emit one separator, inline markup emits none,
   so `pre<em>cise</em>`, `50<sup>th</sup>`, and inline-wrapped CJK do not produce false
   anchor failures. On mismatch the adapter reports the longest matching prefix plus the
   nearest retrieved passage so the agent repairs the anchor instead of retrying it
   unchanged, and separates a partial divergence from an excerpt absent entirely — the
   latter is a fabrication signal rather than an anchor defect.
2. `DeterministicSourceVerifier` supplies reachable, failed, redirected, unavailable,
   and cancelled outcomes for tests.

The Adapter reports observations only. Responses must match the requested Source ID
set exactly once per Source and pass runtime validation for status, time, HTTP code,
and resolved URL; protocol violations conservatively make the requested Sources
unavailable. Provider calls are raced against cancellation so an adapter that ignores
`AbortSignal` cannot hold Raven open. Claim and Completion policy remains in the Task
engine, preserving Locality.

### Direct Harness integration

Raven directly uses the current required `tools` and `systemPrompt` Interfaces.
It does not create pass-through ports for one implementation. The plugin stores
schema-versioned compact state in official `tool/result.meta`. A versioned codec
recursively validates all root fields, nested records, allowed key sets, size ceilings,
unique identities, counters, URLs, hashes, evidence links, and phase invariants;
malformed, unknown-version, or unknown-field snapshots are skipped so an older valid
snapshot can be restored. Metadata v2 records the updated Task plus the Session's
`currentTaskId`; replay scans every Raven result and rebuilds a `session → taskId →
state` registry instead of retaining only the latest Task. At most one Task may be
active in a Session, status inspection of history does not change the current Task,
resuming an older Task requires the current one to be stopped, and new Task ordinals
use the Session-wide maximum. An in-memory registry covers calls before results are
durably appended; replay metadata remains the restart source of truth.

Long-running continuation, subagents, and workflows remain ordinary Harness tools
available to the main agent. The prompt may recommend them proportionately, but the
Raven package neither wraps nor requires them. Their topology never enters Raven
Task state.

## Cordis lifetime and composition

The plugin declares `inject = ["tools", "systemPrompt"]`. It registers one scoped
prompt section, one scoped tool, and one scoped `agent/pre-step` listener that injects
only a compact active-Task summary after resume. All registrations are owned by the
Cordis fiber and disappear on unload.

The package publishes no service. A row in a user-authored agent preset can therefore
sit loose without an isolate realm. Shipped presets and the Harness host composition
remain untouched.

## Package layout

```text
src/
  domain.ts       # owned JSON types and guards
  engine.ts       # deep Task Module
  prompt.ts       # concise stable protocol
  plugin.ts       # direct Harness registrations and web Adapter
  index.ts        # named Cordis exports

tests/
  unit/           # engine invariants and verifier observations
  acceptance/     # four Outcomes and progressive/steering/failure scenarios
  integration/    # plugin load/replay/packed-consumer checks
```

One ESM package is the release unit. It has no runtime npm dependencies beyond Node
built-ins and compatible Harness peers supplied by the deployment. Splitting a core,
service, tool, storage provider, or client package is deferred until a second real
consumer or Adapter exists.

## Agreed test Seams

The direct objective already fixes the test surfaces:

1. **Cordis load Seam:** plugin exports survive real Loader unwrapping; tool, prompt,
   and listener mount and dispose cleanly.
2. **Raven Task Interface:** all four Outcomes use one Task identity; Checkpoints,
   Steering Revisions, stop/resume, replay, and terminal dispositions obey the
   executable contract.
3. **SourceVerifier Seam:** production-shaped and deterministic Adapters produce the
   same completion policy, including unknown citations, broken links, optional
   capability absence, cancellation, and independent partial-result survival.

Tests assert canonical state and dispositions rather than brittle generated prose or
a specific agent graph.

## Compatibility target

Raven v1 targets DeepSeek Harness `0.1.0-rc.5` at commit
`47f943859bef60e4160492346772ded9b24f765a`, Node `^22.19.0 || >=24`, and pnpm
`11.21.0`. Release checks use built ESM and declarations, a real Loader-path smoke
test against that checkout, and a packed clean-consumer install. The version is an
RC, so the package claims only the exact tested compatibility family.
