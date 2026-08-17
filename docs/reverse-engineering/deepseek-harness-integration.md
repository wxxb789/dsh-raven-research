# DeepSeek Harness Integration Report for Raven Research

## Scope and evidence baseline

This report inspects the current checkout at `Q:\repos\deepseek-harness` (commit `47f943859b`, root package version `0.1.0-rc.5`) as primary source. It recommends how a native research/writing/learning extension in `Q:\repos\dsh-raven-research` should integrate without modifying Harness. Source references are checkout-relative and include exact line ranges.

The root is a private ESM pnpm workspace, requires Node `^22.19.0 || >=24`, and publishes/builds leaf packages separately (`package.json:2-18,20-24`). The recommendations below therefore target the current RC contracts, not an assumed stable 1.0 API.

## Executive recommendation

Build Raven as a **small set of external ESM Cordis packages plus an agent-preset composition**, not as a fork, monolithic replacement runtime, dynamic Cordis package, or custom session backend:

1. `@<scope>/dsh-raven-core`: pure domain logic and schemas, with no Cordis dependency.
2. `@<scope>/dsh-raven`: one host Cordis plugin that contributes:
   - a `ctx.raven` domain service for use cases;
   - a small set of `defineTool(...)` model tools registered through `ctx.tools`;
   - prompt sections/context through `ctx.systemPrompt`;
   - optional session projection definitions for durable, replayable per-session learning state;
   - lifecycle cleanup owned by Cordis effects.
3. Optional `@<scope>/dsh-raven-storage`: a provider using the generic storage-domain seam only if Raven needs durable data independent of a session log.
4. A user-authored preset directory containing `agent.cordis.yml` that composes the published Raven package alongside shipped capabilities. Do not edit the shipped preset or Harness checkout.

Use Harness sessions as the authoritative audit/history stream and existing session persistence as its durability mechanism. Store only Raven-specific cross-session entities (sources, notes, concepts, writing projects, spaced-repetition state) in a Raven-owned storage domain. Use subagent/workflow services as optional orchestration dependencies rather than embedding another scheduler.

This is the leanest production-usable shape because it follows the repository's explicit capability-seam split: service definition, provider, and model-facing consumer are separable, while a simple deployment may package service and tool consumer together. The subagent package documents that pattern directly (`packages/subagent/subagent/src/index.ts:1-15`), and the example spine demonstrates bundle composition via child `ctx.plugin(...)` calls (`packages/examples/agent-spine-demo/src/index.ts:202-244`).

## Intended extension points

### 1. Cordis plugin and lifecycle model

A native package exports ordinary plugin metadata and functions: typically named exports `name`, `inject`, `Config`, and `apply(ctx, config)`. For this namespace-plugin shape, do not also export `default`: Loader normalization uses `exports.default ?? exports`, so a default `apply` collapses the namespace and drops `inject`/`Config` (`packages/fs/tool-fs-search/tests/load-path.spec.ts:1-14,25-35`). A representative first-party tool plugin exports `name` and a required service list (`packages/jobs/tool-jobs/src/index.ts:21-23`) plus a Schemastery config (`packages/jobs/tool-jobs/src/index.ts:31-53`). The bundle example mounts services and consumers using `ctx.plugin(...)`; dependency order is declared through `inject`, so activation can pend until dependencies exist (`packages/examples/agent-spine-demo/src/index.ts:202-210,220-244`).

All registrations should be disposer-backed and owned by the calling fiber. Tool registration explicitly returns an unregister disposer (`packages/core/tools/src/index.ts:1031-1061`); prompt sections, dynamic context, and variables do likewise (`packages/core/system-prompt/src/index.ts:373-407,438-454`). Storage-domain handles are caller-owned and should be closed from a `ctx.effect` disposer (`packages/storage/storage-domain/src/index.ts:84-100`).

**Raven pattern:** keep `apply` thin. Construct the domain service, `ctx.provide('raven', service)` if implemented as a non-`Service` provider, register tools/prompt/projections, and ensure every long-lived resource is returned through `ctx.effect`, `ctx.on`, a registry disposer, or a child plugin fiber.

### 2. Model tools

`@deepseek-ai/dsh-tools` is the primary native tool seam. `defineTool` takes a unique name, model description, typed parameter schema, canonical output schema/rendering, optional timeout/concurrency/presentation hooks, and an async executor receiving validated arguments plus execution context (`packages/core/tools/src/schema.ts:482-535,538-568`). The registry validates output shape/schema, timeout, reserved names, and registers globally or in the calling agent scope; scoped tools shadow globals (`packages/core/tools/src/index.ts:1031-1061`).

The package exposes built JS/types from its root and selected subpaths, while `./src/*` exists in the checkout but is not shipped in `files` (`packages/core/tools/package.json:13-40`). Production consumers must import public package exports, never `@deepseek-ai/.../src/*` or relative Harness source.

**Raven pattern:** expose a few use-case tools (for example `research_capture`, `research_synthesize`, `writing_outline`, `learning_review`) instead of CRUD primitives. Each tool should return a canonical JSON value and render bounded model-facing content. Keep large source bodies in Raven storage and return identifiers/summaries. Use `exec.signal` for cancellation and set cooperative timeouts where useful.

### 3. Session and context integration

Sessions are event sourced: the core owns the append-only in-memory log and derived LLM history, while persistence is explicitly a plugin concern that subscribes to `session/event` and drains at `session/flush` (`packages/core/session/src/index.ts:1-6`). Session events are merge-extensible; plugin-owned event types are supported (`packages/core/session/src/index.ts:167-183`). Events must be losslessly JSON-serializable, detached/frozen at boundaries (`packages/core/session/src/index.ts:149-157,187-194`).

Lifecycle events have explicit semantics:

- `session/created` is a synchronous publication boundary and may veto (`packages/core/session/src/index.ts:42-64`).
- `session/event` is post-commit and fire-and-forget; observer failures do not undo append (`packages/core/session/src/index.ts:65-76`).
- `session/flush` is an awaited parallel durability checkpoint (`packages/core/session/src/index.ts:77-85`).

The agent creation API supports unpublished scoped composition through `setup(agentCtx)`. Registrations made there exist before session/agent announcements and first prompt assembly, and failures roll back publication (`packages/core/agent/src/index.ts:73-132`). Returned handles are ownership capabilities whose async `dispose()` stops/drains the loop, unregisters agent/session, and unwinds scoped state (`packages/core/agent/src/index.ts:158-175`).

**Raven pattern:**

- Append whole-state or semantically complete Raven session events for decisions that belong in the conversational record.
- Never mutate log objects or retain mutable aliases.
- Register preset/agent-scoped tools and prompt context through the provided scope rather than filtering by ambient session IDs.
- Observe committed events for indexing/analytics; do not treat `session/event` listeners as transaction vetoes.
- Flush through the session store's supported checkpoint path when an operation needs durable read-after-write; do not dispatch raw events.

### 4. Prompt and runtime context

`ctx.systemPrompt` is a scoped registry. It supports ordered static sections, ordered dynamic context, prompt variables, tool-schema providers, and runtime-context suppression (`packages/core/system-prompt/src/index.ts:337-370,373-454`). Scoped entries shadow global entries with the same name (`packages/core/system-prompt/src/index.ts:373-405,438-454`).

**Raven pattern:** add a short static section defining the research/writing protocol and a dynamic context provider that emits only the active project's compact state. Keep full notes out of every prompt. Prefer model tools for retrieval; use dynamic context only for small, immediately relevant state.

### 5. Replayable projections

The session-projection seam is intended for domain read models. A projection contributes synchronous pure `init/apply/view` functions, a wire schema, and a `stateVersion`; state must be plain JSON (`packages/session/session-projection/src/index.ts:1-17,34-74`). Returning the same state reference on irrelevant events avoids downstream work (`packages/session/session-projection/src/index.ts:52-60`). The registry owns event subscription, watermarks, snapshots, and registration lifecycle; unloaded plugins disappear as capability absence (`packages/session/session-projection/src/index.ts:155-169,171-183`).

The goal domain is a concrete pattern: event-sourced state, compare-and-set revisions, process-local activation (`packages/goal/goal/src/index.ts:1-4`), and a projection transition that ignores malformed/unrelated events and returns whole current state (`packages/goal/goal/src/index.ts:83-113`).

**Raven pattern:** use projections for compact per-session state such as active research question, selected corpus IDs, draft phase, or learning queue summary. Bump `stateVersion` whenever serialized state or fold semantics change. Do not use projections as the primary cross-session database.

### 6. Persistence

`ctx.sessionPersistence` is an abstract durable append-only session store. Backends guarantee contiguous JSON-serializable events; append resolves after durability, and load repairs complete interrupted tails without rewriting committed events (`packages/session/session-persistence/src/index.ts:78-87,126-143,170-183`). Inspection and suffix reads are supported without publishing live sessions (`packages/session/session-persistence/src/index.ts:185-220`).

For Raven-owned cross-session state, the generic storage-domain facility is the safer extension point. Consumers define schema-validated domains and do not touch storage backends directly (`packages/storage/storage-domain/src/index.ts:1-7,19-27`). Backend selection is deployment configuration, with per-domain routes (`packages/storage/storage-domain/src/index.ts:46-62`), and `open()` validates persisted records against the declared schema (`packages/storage/storage-domain/src/index.ts:84-145`).

**Recommendation:** do not implement `SessionPersistence` for Raven. Compose an existing JSONL/SQLite session backend and, if needed, open one versioned Raven domain (for example `raven-v1`) through `ctx.storageDomain`. This avoids coupling Raven's entities to Harness crash-repair and session artifact formats.

### 7. Orchestration

The subagent seam is a named-provider registry supporting multiple providers; providers, service definition, and model tool are separate packages (`packages/subagent/subagent/src/index.ts:1-15`). It distinguishes one-shot runs, durable continuable children, follow-ups, and discovery, and makes ownership/publication boundaries explicit (`packages/subagent/subagent/src/index.ts:16-29`). Observe `subagent/start`/`end` only for lifecycle; provider resolution has added/removed events (`packages/subagent/subagent/src/index.ts:129-166`).

The workflow seam provides `ctx.workflowEngine`. `start()` accepts a plain-JS script, JSON metadata/args, parent Agent, provider/cap overrides, and cancellation (`packages/workflow/workflow/src/runtime-types.ts:14-34`). A live run is holder-owned; `result` does not reject, and callers must dispose it to await cleanup (`packages/workflow/workflow/src/runtime-types.ts:36-48`). Workflow lifecycle events are observe-only and listener failures are contained (`packages/workflow/workflow/src/index.ts:31-90,150-186`).

**Raven pattern:** begin without a custom orchestrator. Implement deterministic research pipelines in Raven core and optionally call `ctx.subagents` for a bounded specialist task. Only depend on `workflowEngine` when users need model-authored fan-out. Treat it as optional via `ctx.get(...)` unless Raven cannot function without it. Always dispose holder-owned runs.

`ctx.goals` is a distinct same-session continuation mechanism, not a durable scheduler. Goal snapshots/history are session events, but activation authority is process-local: session start disarms it, `disarm()` does not change durable phase/revision, and an explicit `resume()` rearms it (`packages/goal/goal/src/index.ts:193-241,244-327`). Use it only for human-authorized long-running objectives; do not use it as cron, a general job queue, or cross-session orchestration.

## Packaging conventions

### Package shape

First-party packages are public ESM packages with `main: lib/index.js`, `types: lib/types/index.d.ts`, conditional `exports`, a restricted `files` list, MIT license, runtime dependencies for implementation libraries, and Harness/Cordis collaborators as peer dependencies plus dev dependencies (`packages/jobs/tool-jobs/package.json:1-58`; `packages/core/tools/package.json:1-68`).

Recommended Raven package manifest conventions:

- `type: "module"`;
- root `exports` for built JS/types and `./package.json`;
- publish only `lib/**` declarations/runtime, not source-path escape hatches;
- put `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-system-prompt`, and optional capability definitions in `peerDependencies` pinned to a compatible RC range;
- duplicate peers in `devDependencies` for local build/test;
- keep schema/runtime libraries actually bundled/used by Raven in `dependencies`.

The root workspace itself is not an integration contract. Its members are internal (`package.json:11-18`), and workspace linking is configured for local Harness development (`pnpm-workspace.yaml:1-29`). A clean external checkout should install published packages from a registry or explicit tarballs, not rely on `workspace:*`, Harness path aliases, or a sibling checkout.

### One package or several?

Start with two packages: pure core and one host plugin. Split provider/tool packages only when another consumer needs the service without model tools, another provider implementation appears, or dependency weight materially differs. The Harness architecture supports the three-way seam but does not require maximum fragmentation for an external v1.

### Composition loading

Normal app boot uses Cordis Loader/Include/Group and drives a leaf `cordis.yml` to settlement (`packages/boot/app-boot/src/index.ts:1-18`). Config paths resolve relative to the invoking cwd unless absolute (`packages/boot/app-boot/src/index.ts:52-69`). The Loader YAML dialect includes `!!js` expressions (`packages/boot/app-boot/src/index.ts:200-207`). A composition row conventionally uses stable `id`, package `name`, and optional `config`; the headless example shows plain package rows and provider/tool separation (`examples/headless-agent/cordis.yml:34-45,63-71,84-150`).

For the current Web product, agent presets are the supported session-plane extension point. A preset is a directory with `agent.cordis.yml`; user presets live under the Harness-home `.agent-presets` root (`packages/preset/agent-presets/src/discovery.ts:1-14,25-42`). Discovery parses with the Loader's own YAML schema and reports malformed rows as broken (`packages/preset/agent-presets/src/discovery.ts:43-105`). Presets are mounted once under a standing scope and shared by sessions naming them; plugins themselves key per-session state (`packages/preset/agent-presets/src/index.ts:1-20`). Discovery is reread on each list/resolve call (`packages/preset/agent-presets/src/index.ts:75-81`).

A profile-wide Raven installation may instead ship a thin bundle package. Harness bundle packages declare `dsh.bundle.patch`, export and publish `cordis.patch.yml`, and may carry no runtime API (`packages/bundle/base/package.json:13-40`; `packages/bundle/base/src/index.ts:1-9`). This is appropriate when Raven should insert host/provider rows into every session of a profile; an agent preset remains leaner when Raven is an opt-in model-facing capability set.

**Clean integration:** publish/install Raven packages into the deployment's Node resolution graph. For opt-in agents, create a new user preset directory and add a Raven row to its `agent.cordis.yml`. For profile-wide installation, publish a separate Raven bundle package whose manifest points `dsh.bundle.patch` at its packaged patch. Never edit a shipped preset or shipped bundle.

## Test strategy and helpers

1. **Pure unit tests:** test schemas, reducers, ranking, citation assembly, and writing transformations without Harness.
2. **In-process plugin tests:** create a Cordis `Context`, mount required services, load Raven, inspect tool registrations, execute through `ctx.tools`, and dispose the context. Harness's internal `@deepseek-ai/dsh-agent-loop-testkit` demonstrates the prerequisite set—LLM, session, prompt, tools, and agent registry—while leaving loop/adapter/teardown ownership to the test (`packages/test-support/agent-loop-testkit/src/index.ts:1-46`). Reproduce this small fixture externally rather than treating `packages/test-support/*` as a supported compatibility API.
3. **Projection replay tests:** fold representative logs and assert versioned snapshots, including unknown and malformed Raven events.
4. **Real Loader composition test:** write a temporary `cordis.yml`, boot through the real app boot/Loader, and assert Raven's services/tools. Harness repeatedly uses this pattern; the loader-smoke helper explicitly tests both source mode and plain-Node built-lib mode (`packages/test-support/loader-smoke/src/index.ts:1-11,25-52,94-121`).
5. **Clean-consumer test:** pack Raven packages, install them in a temporary consumer with published Harness dependencies, run plain Node (no `tsx`, no path aliases), and load a minimal composition. Harness's built-bin test builds a temp consumer/node_modules and loads a relative ESM plugin plus package rows (`packages/examples/acp-demo/tests/built-bin.e2e.ts:61-110,134-145`).
6. **Optional full-loop test:** use a deterministic adapter or mock server; assert session events and canonical tool results rather than brittle prose. Harness publishes a mock LLM server and replay helpers, but verify their published-version compatibility before adopting them as external test dependencies.

Do not rely on `./src/*` export patterns in tests: several package manifests expose them for checkout development but omit source from published `files` (`packages/core/tools/package.json:25-40`; `packages/test-support/agent-loop-testkit/package.json:16-32`). Test the same public roots a clean consumer uses.

## Suggested Raven v1 topology

```text
dsh-raven-research/
  packages/
    core/                 # pure entities, value objects, reducers, citation rules
    plugin/               # Cordis service + native model tools + prompt/projections
  presets/
    raven/
      agent.cordis.yml    # example/copy source; installed into user preset root
  tests/
    integration/          # real Loader and clean-consumer tests
```

Within `plugin`:

- `src/index.ts`: plugin exports, Config, apply;
- `src/service.ts`: `RavenService` use-case API;
- `src/tools/*.ts`: one `defineTool` per user intent;
- `src/session-events.ts`: module augmentation and append helpers;
- `src/projection.ts`: optional pure projection;
- `src/storage.ts`: optional `defineDomain` declaration and owner lifecycle;
- `src/prompt.ts`: compact static/dynamic contributions.

Suggested hard dependencies for the first release: `tools`, `systemPrompt`, and whichever Raven service/provider it owns. Suggested optional dependencies: `sessionProjections`, `storageDomain`, `subagents`, and `workflowEngine`; read them dynamically and degrade clearly unless the selected Raven feature specifically requires them.

## Unsupported or risky assumptions

1. **No declared third-party compatibility guarantee was found.** The checkout is `0.1.0-rc.5` (`package.json:2-4`); public npm packaging is evidence of intended consumption, not a promise of semver stability. Pin and test exact compatible versions.
2. **Internal source paths are unsupported for clean installs.** Although manifests expose `./src/*`, those files are commonly excluded from published `files` (`packages/core/tools/package.json:25-40`).
3. **Workspace aliases are not an external deployment mechanism.** `workspace:^` and pnpm linking describe the monorepo build (`pnpm-workspace.yaml:23-29`), not how Raven should resolve in a separate checkout.
4. **Agent-preset standing mounts are not per-session plugin instances.** Plugin mutable state must be keyed by session/agent or held in scoped registries; assuming one `apply` per session conflicts with the documented mount model (`packages/preset/agent-presets/src/index.ts:1-14`).
5. **Session event augmentation does not automatically persist arbitrary mutable objects.** Event payloads must be lossless JSON and obey snapshot/ownership rules (`packages/core/session/src/index.ts:149-194`).
6. **`session/event` is not a transactional hook.** It is post-commit and listener failures are contained (`packages/core/session/src/index.ts:65-76`).
7. **Workflow and subagent presence is composition-dependent.** Do not access `ctx.workflowEngine` or `ctx.subagents` as mandatory properties without declaring `inject`; use optional service lookup for graceful degradation.
8. **The storage-domain API requires a configured storage hub/backend route.** Opening a domain without an available routed backend fails (`packages/storage/storage-domain/src/index.ts:46-62,84-113`).
9. **Browser/client integration is not justified for v1.** Nothing in the requested research/writing/learning runtime requires a custom GUI. Add a client package only when a concrete UI workflow exists, then follow client-module/slot contracts separately.
10. **Dynamic Cordis plugins are not a production packaging substitute.** They are runtime/session-temporary mechanisms, whereas this report targets clean-checkout native package installation and preset composition.
11. **`packages/test-support/*` is repository test infrastructure, not an asserted third-party stability surface.** Its code is useful evidence for fixture topology, but external Raven tests should own equivalent minimal fixtures and validate packed consumers.
12. **Goals are not durable scheduling authority.** Durable goal events coexist with process-local armed/disarmed continuation state (`packages/goal/goal/src/index.ts:193-241`); use a real scheduler/job provider for timed or cross-session work.

## Adoption checklist

- Pin Node and Harness RC versions.
- Build ESM output and declarations; publish only built artifacts.
- Import only documented package-root/subpath exports present in packed artifacts.
- Register every tool/prompt/listener/domain with fiber-owned cleanup.
- Keep session events plain JSON and version Raven event payloads.
- Use a projection only for deterministic replayable session state.
- Use storage-domain only for Raven-owned cross-session data.
- Compose optional orchestration providers rather than embedding one.
- Ship an example user preset; optionally ship a separate `dsh.bundle.patch` bundle for profile-wide installation; never edit Harness or shipped compositions.
- Gate releases on unit, in-process, real-Loader, and packed clean-consumer tests.
