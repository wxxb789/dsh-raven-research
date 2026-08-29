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
`advance` operation. Tool actions, Task ids, phases, and revisions are a model-facing
internal protocol, not a user-operated workflow language. The main-agent prompt maps
ordinary requests onto that protocol; the engine enforces the resulting transitions,
not the natural-language classification that selected them. Contextual user guidance is
a separate `auto | off` policy and never changes Task semantics.

## External Interface

The Cordis plugin exports named `name`, `inject`, and `apply` values. It has no
default export and provides no process Service. It ships two halves in one
package: the Host half above, and a browser half at `./client` whose only
contribution is one card on the Settings › Plugins page.

```ts
type RavenTaskAction =
  | {
      action: "start"
      outcome: "research" | "general-writing" | "academic-writing" | "learning"
      request: string
      grounding?: "required" | "optional" | "none"
      sourcePolicy?: Partial<SourcePolicy>
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
  | { action: "discover"; taskId: string; queries: string[] }
  | { action: "draft"; taskId: string; instruction: string; routes?: string[] }
  | { action: "steer"; taskId: string; correction: string; sourcePolicy?: Partial<SourcePolicy> }
  | { action: "complete"; taskId: string; artifact: string }
  | { action: "status"; taskId?: string }
  | { action: "stop"; taskId: string; reason?: string }
  | { action: "resume"; taskId: string }
  | { action: "export"; taskId: string; title?: string; tags?: string[]; init?: boolean }
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

- `start` establishes one Task identity and Outcome before work is recorded. The
  evidence floor belongs to the Outcome, not to the executor: `research` and
  `academic-writing` default to `required` and may be narrowed to `optional`, but
  never to `none`. An executor that could switch its own floor off could relabel
  ungrounded prose as research and still complete cleanly.
- `discover` runs ONE batch of complementary queries through the Harness `ctx.web`
  search half and returns Leads. It is a separate action rather than a `checkpoint`
  field because finding candidates and committing evidence are different authorities:
  a Lead has been located, not read, so it may never reach a Claim, an Artifact
  citation, or the evidence floor. The batch is the unit on purpose — several angles
  share one deadline, deduplicate against each other, and cost one Task step, which is
  what makes a wide first sweep cheaper than a sequence of narrow ones. A query that
  fails becomes a `tool` Limitation on the Task instead of aborting the batch, so the
  Task keeps the angles that worked and still records the angle it lost.
- `checkpoint` atomically commits an independently useful Artifact plus the evidence
  and failures that inform it. Stages are observations, never approval gates.
- `draft` asks every configured model route for the same bounded instruction and
  returns the candidates side by side. It is a separate action for the same reason
  `discover` is: producing candidate wording and committing evidence are different
  authorities. A Draft Variant has been written, not verified, so it may never reach
  a Claim, an Artifact citation, or the evidence floor. The deployment owns the route
  list and the agent may only select a subset of it, because naming a model is naming
  spend and a data path. A route that fails becomes one labelled variant rather than a
  failed round, so the comparison survives one dead provider.
- `steer` appends a Steering Revision to the same Task and invalidates stale final
  verification.
- `complete` verifies the exact candidate Artifact and recorded source references.
  It either completes, completes with explicit Limitations, or returns actionable
  issues while leaving the Task active.
- `status` reconstructs compact state after resume or compaction.
- `stop` marks an active Task stopped, preserving its accepted state; `resume` reopens
  only a stopped Task after an explicit current-user request. Stop prevents later Task
  mutation after it is processed, but it does not cancel Harness execution, providers,
  or workers already in flight. Completed Tasks are terminal.

There is deliberately no public Source CRUD, Claim CRUD, worker management,
verification job, workflow stage controller, or approval action.

## Domain records

### Task state

One compact JSON state contains:

- Task ID, Outcome, request, grounding policy, steerable Source Policy, phase, monotonic revision, and times;
- Steering Revisions, including effective Source Policy snapshots when changed;
- immutable Checkpoint descriptors and the latest Artifact;
- Sources with distinct Original Resources and Markdown Representations, plus origin-agnostic Claims;
- Source/tool/coverage Limitations;
- the most recent verification receipt and exact Artifact SHA-256.

A mutation is admitted only when the whole UTF-8 JSON snapshot remains at or below
1,000,000 bytes; non-final mutations leave 64,000 bytes of that ceiling reserved so
Completion cannot deadlock on the cap. This aggregate budget closes the multiplicative
gap left by independent per-field caps. Results that do not advance Task revision carry only a compact metadata
pointer rather than persisting the same snapshot again.

Task phases are `active`, `stopped`, `completed`, and `completed-with-limits`.
Normal research stages do not appear as phases.

### Lead

A Lead is a candidate Raven located but did not inspect: URL, optional title,
snippet, and publication label, plus the queries that surfaced it. Leads are returned
by `discover` and never enter Task state — they are not evidence, they do not
survive a session reload, and re-running discovery is cheaper than storing them. A
candidate returned by several queries is one Lead recording all of them: breadth
information for the agent's next move, explicitly not corroboration, because one
backend answering twice is still one observation.

### Source

A Source has a stable ID and one Original Resource whose `origin` is exactly `web`,
`local`, `llm-wiki`, or `mcp`. The Resource carries a credential-free canonical URI,
optional original media type, and a named source for llm-wiki or MCP. Separately, the
Source records Raven's canonical semantic representation: Markdown preserved as
`original`, Markdown marked `converted` with its producing Harness tool/converter, or
`null` when inspection/conversion failed. Coverage is explicit: `full`, exact `segment`,
or `unknown` projection, so a bounded read cannot impersonate a whole Resource. Title,
locator, bounded excerpt, role/family/as-of metadata, inspection time, and source-check
result remain common to every origin.
The legacy `url` field remains an alias for the Resource URI so existing web calls replay.

Identity is the canonical Original Resource URI; Source IDs and identities cannot be rebound, and relabeling the same Resource with another Origin cannot manufacture independent evidence. Origin is also bound to scheme: HTTP(S) for web, `file:` for local, `file:`/`llm-wiki:` for llm-wiki, and `mcp:` for MCP. Exact
resubmission is idempotent and preserves the prior verification record. A refused Source
may be repaired under its ID, returning to `unchecked`, while changed confirmed evidence
requires a new Source ID. Original Markdown requires `text/markdown` and is stored without
transformation. Non-web normalized Markdown is bounded by the aggregate Task-state budget.

A Lead or uninspected tool result is not a Source. The main agent inspects web, file,
llm-wiki, or MCP resources with ordinary Harness tools before registration. Web keeps its
existing independent re-fetch, HTTP identity, redirect, and excerpt checks. Other origins verify the Evidence Link against session-attested Markdown while retaining the Original Resource URI and producer. Every non-web representation names a successful `inspectionCallId`; Raven correlates it with the owning session's `tool/call` and `tool/result`, validates resolved file identity or the `mcp__<sourceName>__*` namespace, and requires the recorded Markdown and declared coverage to match the actual result. A successful attestation persists `inspectionSha256`, binding Resource, representation, producer, call ID, and coverage so later Completion, replay, or another Team member can verify the immutable snapshot without possessing the original member's event view. Missing or empty Markdown, unsupported formats,
unreadable files, unavailable MCP capabilities, and conversion failures become
`unavailable` Source checks; dependent Claims are deferred and a Limitation is retained.

### Source Policy

Source Policy is mutable Raven Task state, not plugin configuration. `start` accepts a
partial policy and `steer` patches it on the same Task. Blocked web hosts override the
allowlist and include subdomains; configured local and llm-wiki roots constrain canonical
URIs at path boundaries; included/excluded MCP names select the named MCP source; and
`preferPrimary` guides evidence choice without rejecting secondary evidence. Non-web evidence is default-deny: local and llm-wiki require a configured root, while MCP requires an include or exclude rule on the Task. Verification
filters against the effective policy before calling `SourceVerifier`. A steering change
immediately marks newly excluded Sources unavailable and defers Claims lacking another
reachable Source, preserving both provenance and the reason for exclusion.

### Claim

A Claim has a stable ID, text, `external | analysis` kind,
`material | context` importance, `supported | qualified | deferred | rejected`
disposition, Source IDs, and optional `contradicts` links to Claims it genuinely
conflicts with. A supported or qualified external Claim cannot have an
empty, unknown, or failed Source set. Reusing a Claim ID for different text is
rejected rather than silently rewriting provenance. Contradiction links must resolve
to Claims in the same Task and cannot be self-referential; they are validated after
the whole batch so a mutually contradicting pair can be submitted together. The
rendered Claim trace marks both sides contested, so genuine disagreement between
authorities survives instead of one side being silently dropped.

### Artifact and citations

Artifacts cite Sources with `[@source-id]` tokens. Raven validates the tokens and
mechanically renders them as Markdown links from Source records, followed by a
Sources list and a generated Claim trace that maps every material supported/qualified
Claim ID and escaped text to its Source IDs. Source titles, locators, and Claim text
are Markdown/HTML escaped before rendering. Unknown IDs and unregistered raw external
URLs are rejected. This keeps the URL and Claim↔Source mapping outside model memory;
literal anchor matching does not replace main-agent semantic entailment judgment. The Sources
list names each Source Origin and whether its Markdown was original or converted (and by
what), so a Claim trace can always continue from Source ID to the Original Resource.

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

The prompt instructs the main agent toward this cadence for substantial work; the
engine validates each submitted transition but does not schedule when the agent calls it:

```text
start Raven Task
→ use existing Harness tools to inspect an initial credible source set
→ preserve or convert content to Markdown and match bounded excerpts
→ independently re-fetch web Resources; retain non-web Resource and producer provenance
→ checkpoint a useful outline, draft, explanation, or findings
→ continue research and evidence checks without asking permission
→ apply user correction as a Steering Revision on the same Task
→ emit a revised Checkpoint for every substantive final edit
→ complete only those exact latest Checkpoint bytes
```

A Checkpoint result makes the useful Artifact available while the Task remains active.
Display timing and whether the Harness agent proceeds through later model/tool steps are
owned by the Harness loop, not by Raven's engine. The system never treats a progress
slogan as a Checkpoint.

## Completion and graceful degradation

`checkpoint` and `complete` both ask the `SourceVerifier` to verify relevant Original Resources and match recorded excerpts against canonical Markdown. Web Resources are independently reopened; non-web representations retain their inspection producer. `complete` also performs deterministic checks against
the exact latest Checkpoint fingerprint.

Completion is rejected without losing an accepted Artifact or Checkpoint when:

A failed re-verification may still advance diagnostic state — refreshed Source checks,
deferred Claims, Limitations, and the receipt — while the Task remains active. Rejection
is therefore not necessarily a byte-for-byte no-op.

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
whose usable support set becomes empty and records a Source Limitation. This is a
two-step recovery: the failed call returns `needs-revision` while the Task remains active;
the agent removes or narrows unsupported prose in a new Checkpoint, and only a later
Completion may become `completed-with-limits`. Graceful degradation applies when useful
verified work remains, not to missing required capabilities or zero valid grounded work.

Every substantive final edit must first become a Checkpoint; Completion requires the
candidate SHA-256 to equal that exact latest post-steer Checkpoint fingerprint.
Tool, worker, or scheduler completion is never Raven Completion.

## Internal Modules

### Task engine

A pure Task engine parses one action, restores the latest state, proposes a complete
next state, validates invariants, and returns either the next state or an actionable
non-mutating result. It owns all lifecycle, revision, Checkpoint, Source, Claim,
citation, and completion semantics.

### Prose Layout

A pure, total, idempotent Module normalizes every submitted Artifact into the Task's
canonical line shape before it is hashed and stored. Idempotence is a hard requirement
rather than an elegance: Completion compares Artifact byte hashes, so a caller must be
able to resend either its own packed text or the bytes Raven returned without being
told it made an unauthorized final edit. See [ADR 0003](../adr/0003-prose-layout.md).

### Draft generator Seam

Drafting is a third Raven-owned Seam, kept separate from both evidence Seams because
producing candidate wording and confirming evidence are different authorities:

```ts
interface DraftGenerator {
  generate(request: DraftRequest, signal: AbortSignal): Promise<DraftResult>
}
```

`HarnessLlmDraftGenerator` reads `ctx.llm` dynamically and runs every route
concurrently under its own deadline. Two properties of that seam shape the Adapter. It
reports adapter, dispatch, and iteration failure through a terminal `finish` chunk
rather than by throwing, so the finish reason is inspected explicitly — a drafter that
only wrapped the loop in `try`/`catch` would accept an empty or truncated draft as a
real one. And it applies no retry or metering to a plugin-initiated call, which is
recorded here rather than assumed. See [ADR 0004](../adr/0004-draft-variants.md).

### Source searcher Seam

Discovery is a second Raven-owned Seam over the SAME official capability:

```ts
interface SourceSearcher {
  search(request: { queries: readonly string[]; maxResults: number }, signal: AbortSignal):
    Promise<LeadSearchResult>
}
```

`HarnessWebSourceSearcher` reads the optional `ctx.web` search half dynamically, like
the verifier reads its fetch half. It mirrors the Harness `web_search` tool where the
semantics are the tool's to define — the batch bound is applied before deduplication,
the per-query source bound is passed through, and candidates merge round-robin by rank
with exact-URL deduplication — and departs from it in exactly one place, deliberately:
the Harness tool cancels every sibling query as soon as one fails, because a
model-facing search either answers or errors, while a Raven batch is a Task step whose
successful angles are already paid for. Each query therefore carries its own deadline,
one failure yields a `tool` Limitation rather than a batch error, and only caller
cancellation aborts everything. Withheld discovery (`sourceDiscovery=disabled`) and an
uncomposed search provider report the same way an absent capability does — unavailable
with the reason named — because an empty result set would read as "nothing exists".

### Source verifier Seam

This is the second Raven-owned infrastructure Seam:

```ts
interface SourceVerifier {
  verify(sources: readonly SourceCheckRequest[], signal: AbortSignal, execution?: RavenExecution):
    Promise<readonly SourceCheckResult[]>
}
```

The production Adapter dispatches internally by Source Origin while preserving one interface for the Task engine:

1. Web Sources dynamically use the optional `ctx.web` capability. Raven reopens the URL with the tool cancellation signal, normalizes the result to Markdown-compatible text, rejects cross-host resolution, and marks the Source reachable only when the bounded excerpt occurs. Provider absence, identity drift, truncation, or mismatch is never fabricated success. Existing block/inline extraction, nearest-passage repair diagnostics, status taxonomy, retries, deadlines, and network policy remain unchanged.
2. Local, llm-wiki, and MCP Sources use canonical Markdown from a prior ordinary Harness file/MCP inspection. `inspectionCallId` must resolve exactly once to a successful call/result pair in the owning session. Raven checks the actual tool name against `producedBy`, uses structured `read` metadata to bind resolved file identity and reconstruct Markdown, or checks the named MCP namespace, Resource URI argument, and returned text. Exact excerpt presence then yields a non-HTTP `reachable` result. Missing receipts/content yield `unavailable`; provenance or content mismatch yields `failed`.
3. Deterministic test Adapters supply reachable, failed, redirected, unavailable, and cancelled outcomes through the same seam.

The Adapter reports observations only. Responses must match the requested Source ID set exactly once per Source and pass origin-aware runtime validation: HTTP status and resolved URL are required only for web and forbidden for non-web. Protocol violations conservatively make the requested Sources unavailable. Provider calls are raced against cancellation so an adapter that ignores
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
`currentTaskId`; replay scans every Raven result and rebuilds an owning-book registry —
Agent identity by default, detected Team identity when available — instead of retaining
only the latest Task. At most one Task may be active in one owning book, status inspection
of history does not change the current Task, resuming an older Task requires the current
one to be stopped, and new Task ordinals use that book's maximum. An in-memory registry
covers calls before results are durably appended; the latest successfully persisted
snapshot is the restart source of truth.

A PTC mode sub-call gets no result card, so its record cannot ride `tool/result.meta`.
It rides the durable copy of the sub-dispatch instead, through the official
`tools/ptc-dispatch-log` waterfall, as a base64 payload inside an HTML comment on the
Harness-owned `tool/code-dispatch` event. A plugin-owned session event type is rejected:
the Harness persistence reader accepts only its generated known-event set, and there is
no external event-name registration seam, so a private type would make the session
unloadable. Base64 keeps an Artifact containing `-->` from closing the comment. A spill
policy may lose that one step; the next direct call republishes the complete record.

The shared fields are inherited from the augmented
`SessionEventMap['tool/code-dispatch']`, not copied into a local payload declaration. The
published compile package predates `PtcDispatchLog`, so the exact-checkout release gate
proves the runtime half directly: it composes official `run_code`, executes Raven through
`tools/ptc-dispatch-log`, observes the appended `tool/code-dispatch`, and replays the
result. Runtime checks remain because durable logs may be truncated, spilled, or written
by an older build; a bad copy still loses one step rather than the session.

Agent Teams is consumed the same way `web` is — dynamically, never injected — but with
one additional constraint: the Harness Team packages are `private: true`, excluded from
the release payload, and carry no stability promise, so Raven may not import their
types or declare a peer dependency. It mirrors structurally the one method it reads,
`tryMembership(agent)`, contains every call, and keys the Task book by the returned
Team id so detected members share one active Task. After process restart, durable records
fold into that Team book as each member is observed; before then the rebuilt view may
contain only the calling member's history. Every probe failure mode — no capability, no
membership, or a throw — degrades to an independent single-Agent book. Raven therefore
documents Team ownership as conditional, not as a durability guarantee when membership
cannot be detected.

Long-running continuation, subagents, and workflows remain ordinary Harness tools
available to the main agent. The prompt may recommend them proportionately, but the
Raven package neither wraps nor requires them. Their topology never enters Raven
Task state.

## Durable knowledge: Raven Workspace

A Raven Task is bounded session-replayed work. A Raven Workspace is a separate, user-owned,
long-lived llm-wiki repository. Task Completion never closes a Workspace, Workspace adoption
never starts a Task, and deployments that need only one Task keep the existing workflow.
Workspace state is the Markdown already on disk, not a field in `RavenTaskState`.

The compatible `raven_task action=export` remains a pure one-off projection: one artifact
page under `wiki/queries`, one immutable `wiki/raw` page per Source, and one appendable
`wiki/log.md` entry. `init` can still seed `SCHEMA.md`, `index.md`, and `log.md`. Immutable raw
bytes use Source inspection time rather than export time, so projecting the same Task later
cannot change an existing raw page.

The sibling `raven_workspace` tool owns the maintained corpus lifecycle:

- `initialize` creates only missing standard llm-wiki structure;
- `adopt` preserves an existing llm-wiki byte-for-byte or expands a regular folder into
  immutable normalized-Markdown raw pages without touching Original Resources;
- `ingest` adds later non-web material idempotently and links changed Source revisions with
  `supersedes`; web material enters through a completed Task and `grow`, because Task web
  verification attests an excerpt rather than caller-supplied full Markdown;
- `grow` folds a completed Task into a query, concept, entity, or comparison page while
  preserving prior body history, Task provenance, Sources, confidence, and contradictions;
- `maintain` deterministically rebuilds the disposable `index.md` projection only from an explicitly complete Markdown snapshot;
- `health` checks structure, frontmatter/type alignment, raw digests, Source links,
  contradictions, and index freshness after the same `complete=true` attestation; and
- `reuse` performs bounded lexical ranking over supplied Markdown and labels hits as stored
  knowledge rather than freshly verified evidence.

Both projections are pure. Raven accepts exact bytes already inspected with ordinary Harness
tools and returns relative `wiki/...` bytes; it never reads or writes the filesystem. Each
Workspace write carries an `absent` or current-content `sha256` precondition, and every log
append carries a deterministic operation marker. The agent re-reads targets, enforces those
conditions, writes with ordinary Harness file tools, and re-reads the final bytes. This keeps
race detection, approval, sandbox, and filesystem authority in the Harness boundary.

Mixed-document adoption reuses the existing Source normalization contract. Original Markdown
is preserved; other media must name the producer, coverage, inspection call, media type,
Original Resource URI, and exact converted Markdown. Failed normalization is an explicit
issue, never a silent skip. Raw pages use content-addressed paths; an identical retry is a
no-op and changed content creates a new immutable revision.

Frontmatter is derived, never asserted. `sources:` comes from registered Sources,
`contested: true` and `contradictions:` come from Claim links, and `confidence` comes from
Task evidence and limitations. Markdown remains authoritative. `index.md` is disposable,
there is no required manifest, cache, embedding, or vector database, and a future optional
index must remain a rebuildable projection. See `docs/adr/0002-llm-wiki-repo-format.md`.

## Cordis lifetime and composition

The plugin declares `inject = ["tools", "systemPrompt"]`. It registers one scoped
prompt section, separate `raven_task` and `raven_workspace` tools, and one scoped
`agent/pre-step` listener. The listener
always restores compact continuity context for an active or stopped Task. Separately,
`guidance: auto` adds one policy block telling the main agent to offer at most one brief,
context-relevant capability hint and avoid repetition, tutorials, protocol exposure, and
approval gates; `guidance: off` omits only that block. The setting is read per step, so a
committed host override takes effect without changing Task state. All registrations are
owned by the Cordis fiber and disappear on unload.

The package publishes no service. A row in a user-authored agent preset can therefore
sit loose without an isolate realm. Shipped presets and the Harness host composition
remain untouched.

## Package layout

```text
src/
  domain.ts       # owned JSON types and guards
  route.ts        # dependency-free model-route and mode vocabulary, shared by both halves
  prose.ts        # pure, idempotent, Markdown-aware Prose Layout
  engine.ts       # deep Task Module
  codec.ts        # replay validation of the compact snapshot
  wiki.ts         # compatible one-off Task-to-llm-wiki projection
  workspace.ts    # durable llm-wiki adoption, growth, health, maintenance, and reuse
  config.ts       # deployment settings schema
  prompt.ts       # concise stable protocol
  plugin.ts       # direct Harness registrations and the web, model, and settings Adapters
  index.ts        # named Cordis exports
  client/         # browser half: one Settings > Plugins card
    card-state.ts # pure form model over the Host's own schema: fields, drafts, save planning
    controller.ts # staged edits and writes over the settings scope
    Card.tsx      # presentation only
    locales.ts    # card copy, English and Simplified Chinese
    styles.ts     # the card's own stylesheet, injected at module scope; owns containment
    slot-contract.ts # the slot, locale, schema-service, and Context augmentations, restated (see below)
    index.ts      # named browser Cordis exports

tests/
  unit/           # engine invariants, Prose Layout, card form model, bundle manifest
  acceptance/     # four Outcomes and progressive/steering/failure scenarios
  integration/    # plugin load/replay/packed-consumer/browser-artifact checks
```

The package is one ESM release unit shipping two halves, and it declares no runtime
npm dependency of its own.

The Host half never bundles a Harness package. A profile installs plugins with
`nodeLinker: hoisted` and `autoInstallPeers: false` precisely so an out-of-tree
plugin's peers fall through to the running installation and every plugin shares ONE
cordis instance; a bundled copy would give this plugin a second instance whose
services the Harness cannot resolve, and that failure looks like an absent service
rather than a build error.

The browser half inverts that rule: it keeps bare imports external without copying the
shell's changing baseline roster, and inlines relative implementation dependencies.
`dsh.client.external` remains absent because the target reserves it for non-baseline
additions. The exact-checkout gate compares every emitted `require` with the target's
own `PLATFORM_MODULES` and preloaded externals, so a new unanswerable bare import fails
before release.

### Browser half and the restated slot contract

The card reaches the page through the keyed `settings.plugin.item` slot, whose key is
the settings namespace. That keying is what lets a plugin distributed outside the
Harness repository contribute a card at all: the Host half registers the namespace,
the browser half registers a card under the same key, and the tab pairs them without
ever learning what the namespace means.

The declaring package's own augmentation cannot be imported across the client
bundle-purity boundary, and its published copy lags the running Harness — at
`0.1.0-rc.6` the slot is `kind: 'list'`, at `0.1.2-alpha.1` it is `kind: 'keyed'`. A card
registered under the older shape compiles and then never renders, with nothing logged
anywhere. `src/client/slot-contract.ts` therefore restates the targeted augmentation.
The package declares the settings-page owner in `dsh.client.inject`; bundle
materialization tests cover the keyed registration. Authenticated target-page interaction
remains a release requirement and is reported as skipped when no approved driver/profile is available.

The Harness card chrome and staged-form model are likewise off limits as values, so
the card reimplements them. All of that logic lives in `card-state.ts` and is pure — a
reimplementation is exactly the thing that drifts, and purity is what makes every rule
in it testable in Node without a browser. What is deliberately NOT reimplemented is the
answer to "is this draft acceptable": fields, control kinds, accepted values, and
bounds are read off the schema the Host registered and judged by the Harness's own
`settingsSchema` service, so a refused draft reports the schema's own words instead of
a bound this package would have to keep in step with `config.ts`.

Hand-drawing the chrome carries one obligation the imported chrome would have carried
for free. The card renders into a list inside a scrolling pane inside a dialog that
clips with `overflow: hidden`, and it can see none of those: they are host elements
with hashed class names. An absolutely positioned descendant resolves against the
nearest POSITIONED ancestor, and neither the list nor the pane is positioned — so such
a descendant escapes the pane's clip, lands in the dialog's own box, and inflates a
scroll extent that has no scrollbar to undo it. That is not cosmetic: focusing the
escaped element makes the browser scroll the dialog's header and navigation
permanently out of view, which reads as the whole settings page breaking on a click.
`styles.ts` therefore makes the card root a containing block and keeps its one
visually hidden control in flow at zero size, and `tests/unit/styles.test.ts` holds
both rules plus the scoping rule that no selector in the sheet may match outside the
card.

### Composition surfaces

Raven composes in two halves, split by the `role` setting (`host` | `agent` | `both`,
defaulting to `both` so a row naming no role keeps today's behaviour).

The package declares no `dsh.bundle`, and that absence is the shipped default's
isolation guarantee. Declaring it is exactly what makes `dsh plugin add` append a package to a
profile's bundle list, and the row that follows would register the `raven-research`
settings namespace — which is served process-wide, on a settings page that is global,
so a user sitting in any other mode would see a Raven card. The same row decides the
browser half: `dsh web` loads a package's client bundle only for a package the
composition names in a row, so no row means no card, no slot registration, and no
Raven surface anywhere outside its own mode. Installing the package therefore
contributes nothing until a session is started in Raven mode.

`cordis.patch.yml` still ships, demoted from a bundle to an OPT-IN overlay: a
deployment that wants the settings card pastes its row into the profile's own patch
or boots with `--patch`, and accepts that the card is visible in every mode. Raven's
own settings otherwise live on the agent row inside the preset, next to the mode they
configure.

The agent half — `raven_task`, the system-prompt section, the pre-step Task context,
and the `tools/ptc-dispatch-log` waterfall — reaches a session as the `raven` AGENT
PRESET, which is what makes Raven a selectable mode. `dsh-raven-install-preset` writes
it into `$DSH_HOME/.agent-presets`, the root `@deepseek-ai/dsh-agent-presets`
already scans via its own `includeUserRoot`; the bundle deliberately does not patch
that plugin's row, because a patch replaces a row's whole config by id and would
restate its `default` and `roots` as a silently overriding second copy.

That preset is composed at install time and INHERITS its base rather than copying it.
A preset's `agent.cordis.yml` is the whole agent — persona, tools, shell, compaction —
so a package-shipped one-row preset would boot an agent with no persona or shell, and a
package-shipped copy of a Harness composition would drift silently from the original.
What the installer writes is two sibling rows: a `cordis:include` naming the
deployment's own base preset, and Raven's row after it.

Three facts about that shape were established by executing it against the real Harness,
because each is the kind of thing a comment can assert and be wrong about.

Raven's row must be a SIBLING of the include, never inserted through the include's own
`patches` list. `Include` rebases its child tree onto the directory of the file it
included, so a patched-in row resolves its bare package name from the Harness's own
preset directory and fails with `Cannot find package`. A sibling row stays in the
preset's tree, where `PresetTree.import()` resolves bare specifiers from the host
composition's base — the profile that installed the package.

The include is genuinely live. Changing the base file and mounting again in a fresh
process changes what the mode composes, with no reinstall and nothing to re-sync. The
unit of freshness is a process: a Harness upgrade reaches the mode at the next `dsh`
start, not inside a running one.

Including a WRITABLE base can destroy it, and this was observed rather than reasoned
about. During development of this feature the deployment's own
`apps/cli/config/agent-presets/code/agent.cordis.yml` was found truncated to `[]` —
3 bytes, where 13605 belong — after an experiment mounted an include pointing at it and
the mount failed. That is exactly the inherited write `PresetTree.write()` suppresses and
a nested plain `Include` does not: the one that "in practice means truncating a shipped
composition to `[]`". The file was restored from git and the incident is recorded here
because it is the whole reason for the shape below.

An earlier experiment appeared to show the opposite, and it was wrong in a way worth
naming: the base it mounted was itself `[]`, so a truncating write produced a file
identical to the one it started with. "Unchanged" could not distinguish no write from
the write. A negative result about destruction needs a base whose content a write would
visibly replace.

The installer therefore writes only the sibling composition under Raven's own user
preset directory and never writes or changes the included base. It records the base's
`sha256` for detection: an ordinary upgrade is already picked up at mount, while a base
that now contains Raven's own row is reported as evidence that something else wrote it.

A `--snapshot` mode remains for a deployment that would rather not depend on a file
outside the package: it inlines the base's text, keeps its comments, records the same
digest, and is re-synced with `--force`.

The waterfall does not hold the tool on the host plane: event admission extends UP the
scope chain and `tools/ptc-dispatch-log` is scoped to `dispatch.agent`, so an
agent-scoped listener still receives its own agent's PTC mode sub-dispatches. The preset
mounts once under a standing scope; every joined session shares that plugin instance, and
Raven keys its Task books by Agent identity or successfully detected Team identity. `examples/agent-row.cordis.yml`
remains the hand-mounted preset-scoped alternative. With the roles split, mounting both
planes no longer registers
`raven_task` twice. See `docs/adr/0006-raven-as-a-mode.md`.

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
4. **Durable Task-state Seam:** a direct call publishes Task state as result metadata,
   while a nested PTC mode sub-call embeds the same record in the Harness-owned
   `tool/code-dispatch` event. Each path alone rebuilds the Task book on replay, neither
   duplicates the other, and Raven never writes a plugin-owned session event.
5. **Failure Recovery Seam:** the tool-owned content finalizer attaches the addressed
   Task's identity and recovery action to a failed outcome, including the invalid-argument
   and cancellation paths the output projection never sees, and is total: a hostile
   execution view preserves the content instead of replacing one failure with another.
6. **Settings Seam:** the `raven-research` namespace registers with the composition entry
   as its `base` layer; a resolved section takes effect on the next Source check, an
   absent settings service leaves the entry authoritative, and no setting lowers a Task's
   evidence floor.

Tests assert canonical state and dispositions rather than brittle generated prose or
a specific agent graph.

## Compatibility target

Raven v1 targets DeepSeek Harness `0.1.2-alpha.1` at commit
`cd5ef8148158c3a752a658978873241fdf8e2bbc`, Node `^22.19.0 || >=24`, and pnpm
`11.21.0`. Release checks use built ESM and declarations, a real Loader-path smoke
test against that checkout, and a packed clean-consumer install. The version is an
alpha prerelease, so the package claims only the exact tested compatibility family.

That target has exactly ONE machine-readable source: `dshRaven.harnessVersion` and
`dshRaven.harnessCommit` in `package.json`. `scripts/verify-dsh.ts` READS them rather
than restating them, because the previous second copy inside that script had already
drifted away from any reachable checkout — and since the two copies agreed with each
other, the gate reported a healthy pin while naming a commit nobody could produce. The
prose above is documentation of that value, never a third definition of it.

The published `@deepseek-ai/*` packages this repository builds against sit at
`0.1.0-rc.6` and legitimately lag the pinned Harness release; the two numbers describe
different things. Where that gap has teeth — the client slot contract, reshaped between
them — `src/client/slot-contract.ts` vendors the newer shape. Bundle materialization and
the exact target module-table gate cover executable packaging; authenticated card
interaction remains an explicitly reported manual release smoke.
