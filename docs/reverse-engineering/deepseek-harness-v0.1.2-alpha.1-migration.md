# DeepSeek Harness 0.1.1-rc.2 → 0.1.2-alpha.1 Migration Report

## Scope and comparison endpoint

This report covers externally observable changes that can affect an out-of-tree Host-plane plugin, browser/client plugin, custom profile/launcher, direct Remote consumer, or plugin test/packaging tool. It uses only primary material in the implementation checkout: Git history, package manifests and exports, source, first-party design notes/docs, and tests.

The comparison is:

- **Baseline:** [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e), the `dsh-v0.1.1-rc.2` release merge.
- **Release-version commit:** [`6c705be1ce6774a000d061da41d1823b03a3d42c`](https://github.com/deepseek-ai/deepseek-harness/commit/6c705be1ce6774a000d061da41d1823b03a3d42c), whose subject is `release(dsh): 0.1.2-alpha.1`.
- **Official tagged target:** [`dsh-v0.1.2-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1) resolves to [`cd5ef8148158c3a752a658978873241fdf8e2bbc`](https://github.com/deepseek-ai/deepseek-harness/commit/cd5ef8148158c3a752a658978873241fdf8e2bbc), current `HEAD`. Its tree is the same `a712eec535b48badc4fefb4df5176a7002e4280b` tree as `6c705be1`.

The literal `v0.1.2-alpha.1` ref does not exist; the official prefix is `dsh-v`. This checkout did not have either release tag fetched locally, so the original audit compared commits directly. Raven pins the official tagged merge `cd5ef814`; implementation evidence remains commit-pinned to `6c705be1` because both targets have the same tree. The complete official comparison is [`dsh-v0.1.1-rc.2...dsh-v0.1.2-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.1-rc.2...dsh-v0.1.2-alpha.1).

### Classification used here

- **Breaking:** old source, wire data, persisted data, configuration, or process behavior is rejected, disappears, or changes meaning without a compatibility path.
- **Conditional breaking:** only direct/custom consumers of a lower-level surface must migrate; ordinary plugins on the supported higher-level path do not.
- **Behavior change:** source remains accepted but runtime output, ordering, privacy, timing, or presentation changes.
- **Additive/internal:** no old supported consumer action is required.

## Executive summary

The release is materially breaking for an external plugin ecosystem. The largest changes are:

1. `@deepseek-ai/dsh-client-runtime` and `@deepseek-ai/dsh-host-apiproxy` are deleted with no compatibility facade.
2. Client state is split into controller models, UI adapters, target-specific Conversation owners, a static store package, and the renderer; old `useSession` selectors and several slot props change meaning.
3. Browser RPC moves from ApiProxy/frame DTOs to generated owner Remotes, exact Connection fetch routes, and generation state.
4. The custom boot wire gains required `WebBootGraph.batches`; initial plugin delivery uses exact immutable combo URLs and opaque revisions.
5. Every Host API/index/Remote/WebSocket request now requires a launch-token-to-cookie browser session. Custom Web compositions also gain hard service dependencies.
6. Public identifiers and config values rename without aliases: `CallId` → `ToolCallId`, and `code` mode/preset/dispatch vocabulary → `ptc`/`PtcDispatch*`.
7. Session history can carry packed chunk rows; raw presentation DTOs disappear; several persistence/projection implementer interfaces change; SQLite schema 17 is rejected by the schema-19 target.
8. UI primitives remove built-in language fallbacks and require complete localized label props.
9. Profile launch, preset roots, HMR defaults, SDK launch options, and several narrow plugin config schemas change.

At the same time, the ordinary client-plugin **package declaration and factory wrapper remain compatible**: `dsh.client.platform: "web"`, a built `./client` export, and `window.__ModuleLoader__.load({ id, factory })` are still the contract. The `dsh plugin --profile ...` pnpm-forwarding syntax also remains compatible. Node and pnpm floors do not change.

## Immediate impact on this consumer repository

The pre-migration Raven snapshot was pinned to the baseline and exposed these high-risk seams:

1. **Host PTC vocabulary:** `src/plugin.ts` imported `CodeDispatchEventData` / `CodeDispatchLog` and listened to `tools/code-dispatch-log`. Replace them with the PTC vocabulary while keeping durable `tool/code-dispatch` unchanged.
2. **Deleted client umbrella:** `src/client/index.ts` and `src/client/controller.ts` imported from `@deepseek-ai/dsh-client-runtime/client`. Move `ClientContext` to Cordis `Context`, settings ownership to `ui-settings/client`, and store APIs to `dsh-client-store` only when the plugin actually needs that richer store.
3. **Bundle module table:** remove the runtime external, keep shell baseline modules implicit, and compare emitted bare requests against the target's own platform table instead of copying exact specifiers.
4. **Settings-card slot:** `settings.plugin.item` remains a keyed, root-scoped slot, and `ctx.slots.inject(...register(...))` remains the correct lifecycle.
5. **Durable state:** Raven already avoided repository-external session event names and stored state in known `tool/result.meta` / `tool/code-dispatch` records. Preserve that design.
6. **Prompt placement:** Raven's numeric section order `116` lands before target `PTC_ONLY = 800`; derive a position between exported target bounds and assert assembled relative order.
7. **Preset installer:** replace the old fixed CLI preset path and `code` default with package-manifest discovery and `ptc`.
8. **Settings-card owner:** declare the `dsh-client-ui-settings-plugins` package edge and prefer target client types where published.
9. **Pins and gates:** pin official `dsh-v0.1.2-alpha.1` / `cd5ef814`, rebuild artifacts, then run full, packed-consumer, and exact-checkout gates.

Research changed only this report; the completed implementation and environment-specific browser skip are recorded in the status section below.

---

## 1. Package topology and export-map breaks

A manifest/export audit found that common packages retain their `main`, `types`, `bin`, and export maps except for the changes below.

### Deleted packages

| Old package | Classification | Replacement |
|---|---|---|
| `@deepseek-ai/dsh-client-runtime` | **Breaking** | Store/Slot infrastructure was first extracted in [`1b535f61`](https://github.com/deepseek-ai/deepseek-harness/commit/1b535f611cee0479e8732cb169eba4fd8a406bee), then the Runtime package was deleted in [`be531688`](https://github.com/deepseek-ai/deepseek-harness/commit/be531688f312537787838ffceaf9382b6a918884), with no facade. Split ownership is `dsh-client-store`, `dsh-api-session-controller/client`, `dsh-api-workspace-controller/client`, `dsh-client-ui-renderer/client`, `dsh-client-ui-session/client`, `dsh-client-ui-conversation/client`, and `dsh-client-ui-chat/client`. See the [old manifest](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/runtime/package.json). |
| `@deepseek-ai/dsh-host-apiproxy` | **Breaking** | Generated owner Remotes, `dsh-api-gateway`, `dsh-api-remotes`, the three controller packages, and Connection exact Fetch. See the [old manifest](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/host/apiproxy/package.json) and deletion [`4f00a8b8`](https://github.com/deepseek-ai/deepseek-harness/commit/4f00a8b82af9145d9ee19d5201972ef92fb311da). |
| `@deepseek-ai/dsh-acp-snapshot` | Conditional test-consumer break | `@deepseek-ai/dsh-session-snapshot`; runtime behavior is internal test infrastructure. |
| `@deepseek-ai/dsh-acp-demo` / bin `dsh-acp-demo` | Conditional CLI/demo break | `dsh --profile acp` plus patch overlays. |
| `@deepseek-ai/dsh-sdk-jsonrpc-demo` / bin `dsh-jsonrpc-agent` | Conditional CLI/demo break | `dsh --profile sdk` or `sdk-minimal`. |

The private `dsh-jsonrpc-agent-pkg` runtime-closure name becomes `dsh-python-runtime-closure`; that name is not a normal plugin import surface.

### Existing-package export-map changes

- **Breaking:** `@deepseek-ai/dsh-file-reference/typert` and `/remote` are removed in [`2d4393d8`](https://github.com/deepseek-ai/deepseek-harness/commit/2d4393d842139f16f4ae32b8ae31476a597cdd22). Use `@deepseek-ai/dsh-api-session-controller/typert` and `/remote`; ordinary browser code gets the selected `ctx.remote.fileReferences` contribution through `@deepseek-ai/dsh-api-remotes/client` ([target controller manifest](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/api/session-controller/package.json#L16-L46)).
- **Additive:** `@deepseek-ai/dsh-session/chunk-rows`; `@deepseek-ai/dsh-host-directory-picker/types`; `@deepseek-ai/dsh-llm/{typert,remote}`; `@deepseek-ai/dsh-agent-presets/{typert,remote}`; `@deepseek-ai/dsh-subagent/{typert,remote}`; and `@deepseek-ai/dsh-tool-subagent/model-selection-settings`.
- **Internal/experimental additive:** extra Agent Team subpaths and new experimental packages.

### Public helper/type moves with unchanged package export maps

- `requestImageDimensions`: `@deepseek-ai/dsh-attachment-local` → `@deepseek-ai/dsh-attachment` ([`30704dc1`](https://github.com/deepseek-ai/deepseek-harness/commit/30704dc1df10a54c31d0ad6513bcc2690feaf9de), [target source](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/attachment/attachment/src/request-projection.ts#L13-L38)).
- `Win32Error` and `quoteArg`: `@deepseek-ai/dsh-sandbox-windows-acl` → new `@deepseek-ai/dsh-win32-process` ([`668da7f5`](https://github.com/deepseek-ai/deepseek-harness/commit/668da7f507afb7404bfc6e4721e34f541d8a4f44)).
- `TodoItem`: `@deepseek-ai/dsh-session/types` → `@deepseek-ai/dsh-tool-todo/types`; the latter now owns the `todo/write` module augmentation ([`a2b41509`](https://github.com/deepseek-ai/deepseek-harness/commit/a2b415096d732f9c5b2eeb62005e640a2e1a5522), [target types](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/todo/tool-todo/src/types.ts#L21-L37)).

Although many manifests expose `./src/*`, source files are generally excluded from published `files`. The repository itself says same-package tests may import internals and must not widen public APIs for that purpose ([client export rules](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/AGENTS.md#L30-L36)). An out-of-tree plugin should treat only packed JS/declaration entries as consumable.

---

## 2. Host-plane public TypeScript breaks

### 2.1 `CallId` is replaced without an alias

Commit [`a789637d`](https://github.com/deepseek-ai/deepseek-harness/commit/a789637db66ea9a74048620f33a2d8f6489ecb9c) replaces the exported nominal type and constructor:

`CallId = Branded<'CallId'>` / `CallId(value)` → `ToolCallId = Branded<'ToolCallId'>` / `ToolCallId(value)`.

This propagates through LLM tool-call blocks/deltas, tool results, tool execution, approval requests, session `tool/call` events, spill/pruning data, and client Conversation records. There is no assignable compatibility brand. Update imports, constructors, type augmentations, fixtures, and structural DTOs; do not cast the old brand through. Evidence: [old brand](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm/src/brand.ts#L31-L40) → [new brand](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/llm/llm/src/brand.ts#L31-L40).

### 2.2 Code mode becomes PTC, with no aliases

Commit [`3ca9c7d4`](https://github.com/deepseek-ai/deepseek-harness/commit/3ca9c7d4891760ba366123bf9f5d45ed7133c088) deliberately performs a pre-release no-alias rename ([decision](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-25-rename-code-mode-to-ptc.md#L9-L26)):

| Old | New |
|---|---|
| `ToolPresentationMode: 'code'` | `'ptc'` |
| `tools.mode: code` / `DSH_TOOLS_MODE=code` | `ptc` |
| preset id/directory `code` | `ptc` |
| `CodeDispatchStartEventData` | `PtcDispatchStartEventData` |
| `CodeDispatchEventData` | `PtcDispatchEventData` |
| `CodeDispatchLog` | `PtcDispatchLog` |
| Cordis waterfall `tools/code-dispatch-log` | `tools/ptc-dispatch-log` |
| prompt section `tools:code-only` | `tools:ptc-only` |

The persistent names **do not change** in this release: `tool/code-dispatch-start`, `tool/code-dispatch`, `tools-code-mode`, and the `:code:` sub-call segment stay old for log compatibility ([consequences](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-25-rename-code-mode-to-ptc.md#L33-L37)). Do not rename stored-event readers.

A persisted session whose selected preset id is `code` no longer finds a shipped preset with that id. Finish/export it before cutover or temporarily provide a user-authored `code` preset copy that composes the new PTC rows.

### 2.3 LLM/image API changes

Direct LLM/provider implementers must account for all of these:

- `RequestImageOffloadPolicy` gains required `placeholder(ref)`.
- `requestImageHandleText(version)` becomes `requestImageHandleText(ref, { width, height }, access?)`.
- `OFFLOADED_IMAGE_TEXT`, `offloadRequestImages`, and `isTokenDelta` are removed. Use `offloadedImageText`, `offloadedImagePrefixCount`, `offloadRequestImagesWithPolicy` with an explicit placeholder, and/or a domain-local delta predicate. The new access bridge is `resolveImageAttachmentAccess` ([target content API](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/llm/llm/src/content.ts)).
- `LlmModelDiscoveryRequest.signal` is removed from the request object. A registered discovery callback now receives `(request, signal?)`, and `discoverModels` takes the signal separately. Old implementations that read `request.signal` silently stop observing cancellation unless migrated.
- Direct construction of `DeepSeekAdapter` gains required `prepareExtensions`. A neutral implementation returns `{ fields: {}, accept: async () => {} }`; the first-party plugin delegates to `ctx.deepseekLlmApiExtensions?.prepare(request)` ([target wiring](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/llm/llm-deepseek/src/index.ts#L452-L469)).
- `LlmAdapter.imageRequestPricing()`, `TokenUsage.totalTokens?`, and image-pricing types are additive because the base implementation and fields are optional.

Image configuration also changes. `requestImageDimensions` moves as noted above; `NormalizationPolicy` gains required `maxPixels`; `DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION` changes 2048 → 8192 while a new default 2048×2048 total-pixel budget preserves the intended ordinary area bound. Do not reinterpret the new long-edge constant as the old sole budget.

For `llm-deepseek` config, `imageDetail: low` becomes `imagePixelBudget: low`; `imageDetail: auto` should be omitted for the 640,000 default or replaced with `imagePixelBudget: 640000`. The old key is rejected ([target validation](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/llm/llm-deepseek/src/index.ts#L212-L274)).

### 2.4 Prompt ordering changes meaning

Commit [`43ac97b5`](https://github.com/deepseek-ai/deepseek-harness/commit/43ac97b554845929707f075cc29ef001fee3a173) moves first-party prompt sections into sparse bands and exports `FIRST_PARTY_SECTION_ORDER`. Equal numeric orders now use deterministic code-unit **section-name** order instead of relying on insertion/stable-sort order ([target source](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/core/system-prompt/src/index.ts#L120-L169)).

This is a behavior break for an external section that assumed old first-party numbers or same-order insertion. Give the plugin a unique finite order and re-inspect its final prompt position. `PERSONA_ORDER` remains numerically 0, so importing that constant is compatible.

### 2.5 Typert context/stream contracts

Commit [`3d6d595d`](https://github.com/deepseek-ai/deepseek-harness/commit/3d6d595d794ba715c60ff850f044cc02e6c53d40) changes context registration from one-way provider/binder types to adapters:

- `TypertHostContextProvider` → `TypertHostContextAdapter`, adding `identity(ctx)` beside `resolve(id)`.
- `TypertClientContextBinder` → `TypertClientContextAdapter`, adding `resolve(id)` beside `identity(ctx)`.
- Registry `registerHost/registerClient/getHost/getClient` types change and `identifyHost` is added.
- `TypertClientRemote.$dispatch` is removed; event listeners use `$on`, including waterfall return/`next()` semantics.
- A custom `TypertGateway` implementation must implement the new Remote stream/event faces (wire/register/stream operations).

See [old types](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/typert/protocol/src/types.ts#L294-L321) and [target adapters](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/typert/protocol/src/types.ts#L354-L396).

### 2.6 Interaction provider contracts

- `UserQuestionProvider` and `UserQuestionService.registerProvider` are removed. An answerer now handles the Cordis waterfall `user-questions/request` and either returns an answer or calls `next()`; use the target [`AskUserQuestionRequestEvent`](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/interaction/user-questions/src/types.ts#L67-L75).
- The `approval/request` augmentation moves to the package `./types` face. Its scoped `this` changes from `Scoped<ApprovalService>` to `Scoped<Agent>`, the payload becomes [`ApprovalRequestEvent`](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/interaction/user-approval/src/types.ts#L63-L76), and `callId` uses `ToolCallId`.

### 2.7 Other required-member/signature breaks

These are easy to miss because their package remains present:

| Old contract | Target contract / migration |
|---|---|
| `SessionReferenceCandidate` literal | Add required `sameWorkspace: boolean` ([target type](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/context/session-reference/src/types.ts#L47-L61)). |
| `SubagentCapabilities` literal | Add required `agentOptions: boolean` ([target type](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/subagent/subagent/src/types.ts#L86-L93)). |
| `TokenSurfaceNode` literal | Add required `heuristicTokens`; update custom token-surface producers/fakes. |
| `IndexInjection` exhaustive switch | Handle new `script-preload` variant; consumers that pass through unknown variants are compatible. |
| `ui-agent-preset` selector | `select(): Promise<void>` → `Promise<string | undefined>`; return an explicit string/error detail or `undefined`. `SeatSessionSummary` is removed; use the controller-owned session summary. |
| Direct Agent type import from `runtime-types` | The root effective `Agent` shape remains, but its minimal authority moves to `@deepseek-ai/dsh-agent/types` and runtime capability is module augmentation. Root imports are the compatible path. |

---

## 3. ApiProxy, Connection, Remote, and browser authentication

### 3.1 ApiProxy operation migration

The first-party migration record states that “no API Proxy service remains” and provides the authoritative operation table ([decision](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-10-unary-apiproxy-remote-migration.md#L13-L35)):

| Former ApiProxy operation | Target owner |
|---|---|
| `session.rename` | `ctx.remote.sessionTitle.rename` |
| `command.list/execute` | `ctx.remote.commands.list/execute` |
| `llm.providers` / configurable providers / discovery | `ctx.remote.llm.*` |
| `llm.models` | `ctx.remote.session.modelCatalog` |
| `credentials.*` | `ctx.remote.credentials.*` |
| `settings.*` | `ctx.remote.settings.*` |
| `agentPreset.*` | `ctx.remote.agentPresets.*` or Settings for native open |
| `subagent.interrupt` | `ctx.remote.subagents.interruptByParent` |
| Workspace list/mutations | `ctx.remote.workspace.*` / workspace controller model |
| `skill.list` | `ctx.remote.skills.list` |
| `fileReferences.list` | `ctx.remote.fileReferences.list`, owned by session controller |
| directory pick/list/create | `ctx.remote.directoryPicker.*` |
| `host.openPath` | `ctx.remote.session.openWorkspacePath` after client-side workspace resolution |
| `host.describe` | Connection generation `host.home` plus owner capability queries |
| `session.export` | exact `GET/HEAD /api/session.export` route |

Direct callers must stop reading `connection.api`, `HostFrame`, `MuxFrame`, `RpcMethodMap`, or `hostDescription`. Select generated contributions through `dsh-api-remotes/client`, call `ctx.remote.<namespace>`, and read Host facts from `connection.generation.getSnapshot()?.host`.

Non-JSON feature downloads register exact methods/routes through Connection rather than extending a monolithic proxy.

### 3.2 Connection source and transport breaks

The old `ConnectionHandle` contained `api`, `hostDescription`, `rpc`, and `start`. The target exposes `isLoopback`, `generation`, `rpc`, `registerGenerationSource`, and `start` ([target client handle](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/connection/src/client/index.ts#L105-L138)). Old envelope sinks are replaced by generation sources and owner-specific streams.

Custom browser transport globals also change: `__DSH_TRANSPORT__.createApiClient()` is removed. Implement the target `ClientTransportHooks`: required `fetch`, optional `openStream`, `loadBundle`, and `ownsHost` ([target contract](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/connection/src/client/index.ts#L73-L130)).

### 3.3 Uniform browser authentication is a hard runtime break

Commit [`3e24087b`](https://github.com/deepseek-ai/deepseek-harness/commit/3e24087bfaeabe40b58ba2f7b936895b8f93fe27) authenticates index, generic RPC, generated Remote, exact Fetch, and WebSocket routes uniformly ([design](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md#L11-L23)).

Migration for a custom caller/proxy:

1. Treat the printed `http://host:port/?token=<secret>` URL as a credential.
2. Perform `GET /?token=...`; preserve the redirect and `Set-Cookie`.
3. Send the cookie on later index, `/api`, exact Fetch, and WebSocket requests.
4. Keep hostname and port stable because the cookie is authority-bound.
5. Do not put the token on an API URL or in `Authorization`; neither is accepted.

An in-page same-origin client plugin normally needs no special code because browser fetch/WebSocket carries the cookie. An unauthenticated external API client now receives 401.

### 3.4 Custom Web compositions gain required services and signatures

- `@deepseek-ai/dsh-client-connection` Host inject changes from `['webServer']` to `['webServer', 'credentials']`; `apply` becomes async and `cookieMaxAgeDays` is additive config. Compose a writable credentials provider before Connection ([target source](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/connection/src/index.ts#L66-L112)).
- `@deepseek-ai/dsh-host-frontend-static` changes from `['webServer']` to `['webServer', 'connection']`.
- Exported `serveStatic(path, res, root, index, renderIndex)` gains an `authorizeIndex` callback before `renderIndex` ([target source](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/host/frontend-static/src/index.ts)).
- Webserver gzip config is additive; existing route handlers still own their response.

---

## 4. Client architecture, slots, settings, and UI

### 4.1 Deleted `dsh-client-runtime`: symbol migration

| Old `@deepseek-ai/dsh-client-runtime/client` family | New owner |
|---|---|
| `ClientContext` | `Context as ClientContext` from `@deepseek-ai/cordis` |
| `createSnapshotStore`, `defineStore`, `shallowEqual`, store/observable types | [`@deepseek-ai/dsh-client-store`](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/store/src/index.ts) |
| Session models, `ISession(s)`, list/projection types, scopes | [`@deepseek-ai/dsh-api-session-controller/client`](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/api/session-controller/src/client/index.ts) |
| Workspace models/types | `@deepseek-ai/dsh-api-workspace-controller/client` |
| Workspace path helpers | `@deepseek-ai/dsh-util-workspace-path` |
| `SettingsScope*` | [`@deepseek-ai/dsh-client-ui-settings/client`](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/ui-settings/src/client/index.ts) |
| `SlotRegistry`, root renderer types | [`@deepseek-ai/dsh-client-ui-renderer/client`](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/ui-renderer/src/client/index.ts) |
| Session hook/scope adapter | `@deepseek-ai/dsh-client-ui-session/client` |
| Target-neutral Conversation registries/assembler | `@deepseek-ai/dsh-client-ui-conversation/client` |
| Chat nodes/snapshot/store/slot types | `@deepseek-ai/dsh-client-ui-chat/client` |

There is intentionally no replacement central facade ([ownership note](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-20-client-session-conversation-ownership.md#L377-L441)). Remove the old package from imports, peer/dev dependencies, client module edges, and any profile row.

A target-form settings client starts like this:

```ts
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
```

Use type-only imports to activate declaration merges without creating forbidden cross-feature runtime requires.

### 4.2 Hook and slot-prop semantics

The production SlotMap grows without deleting a production key: new slots are `conversation.approval.detail`, `conversation.trajectory.images`, `settings.models.provider-card`, and `settings.models.footer`. The registration API, cardinalities, scopes, and `ctx.slots.inject(...register(...))` lifecycle remain.

The breaking part is data ownership:

- Old `useSession` selected the monolithic `ConversationSnapshot`. New `useSession` selects controller `SessionSnapshot` lifecycle/control state.
- Use `useConversation` for target-neutral assembly, `useChat` for Chat, and `useTrajectory` for Trajectory; `UseConversationSession` is removed.
- `useWorkspaces` retains its name, but the target snapshot no longer contains old `baselinesReady` / `recentWorkspaceId`.
- `SessionAreaProps.children` changes from `(sessionId) => ReactNode` to `ReactNode`; read `sessionId` from standard slot props.
- `conversation.composer`, `conversation.view`, input-zone, image-source, Chat/details/turn-tail, and related owner props change shape. Re-derive component props from target `PropsRuntime` / `PropsRenderSlots` instead of preserving handwritten interfaces.
- Chat-specific exports such as `ChatNode*`, `ChatStore*`, `ChatView*`, `CommandRow*`, `Details*`, and `UseChatNodeTurnData` move from `ui-conversation/client` to `ui-chat/client`.

The target hook table and four-share component model are documented in [Slots](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/docs/subsystems/slots.md#L60-L104).

### 4.3 Runtime imports between feature plugins are no longer a compatibility path

Commits [`997ad27a`](https://github.com/deepseek-ai/deepseek-harness/commit/997ad27a60171b47166663cd25709ee3e4dc312f) and [`e5395b36`](https://github.com/deepseek-ai/deepseek-harness/commit/e5395b36afc7f62d6e56900c1b17272765935507) remove compatibility imports/re-exports. A feature client plugin must not runtime-import another feature plugin merely to share implementation. Share declarations via `import type`, behavior through Cordis services, and UI through slots ([rules](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/AGENTS.md#L30-L36)).

### 4.4 Settings client migration

For ordinary settings-card consumers, `ctx.settingsScope.bind()`, `getSnapshot`, `subscribe`, `set`, and `unset` remain the preferred facade. Direct ApiProxy settings calls must become `ctx.remote.settings`; declare Cordis dependencies `remote` and `remote.settings` where called.

`SettingsScope` gains required `mutate`. Normal consumers need not call it, but external structural fakes/implementations must add the method. The target also publishes the `describe()` mirror and schema service types from `ui-settings/client`.

Existing settings slot names remain. The two model extension slots are additive. The target first-party [settings-card cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/docs/cookbook/adding-a-settings-card.md#L46-L100) shows the supported pattern.

### 4.5 UI primitives remove language defaults

Commit [`3c10f5d2`](https://github.com/deepseek-ai/deepseek-harness/commit/3c10f5d2d361504d3790a2c9057252f7d584f0ff) makes Cordis-free primitives require caller-owned localized copy:

- `ConnectionBanner.label` required.
- `HoverCard.copyLabel/copiedLabel` required.
- `CodeBlock.copyLabel/copiedLabel` required.
- `JsonBlock.truncatedLabel` required.
- `DiffBlock`, `ReadBlock`, `SearchBlock`, and `WebBlock` require complete `labels`.
- `TerminalBlock.labels?: Partial<...>` → complete required labels.
- `JsonTree.label` and complete `labels` required.
- Non-headless `Modal.closeLabel` required; omit it only with `headless: true`.
- `RiskConfirmation.closeLabel` required.
- `MarkdownText.codeLabels?` → required `labels: { code: { copyLabel, copiedLabel }, footnotes }`.

Use a typed locale namespace and pass all labels. The [target primitive contract](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/ui-primitives/README.md#L28-L40) and [complete fixture](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/ui-primitives/tests/labels.client.ts) are primary examples.

### 4.6 Other client implementer breaks

- `ThemeSettings` and `ThemeSnapshot` gain required `fontSize`; external literals/fakes should use `14`. The schema default means persisted settings need no rewrite.
- `ui-input-trigger`: `ArbitrateKey` adds `tab`; `CandidateRequest` adds required drill state; `InputTriggerPick` adds an action; candidate icon becomes `InputTriggerCandidateIcon`; `MenuViewInjected` gains required `headers`, `onHover`, and `onCrumb`, and `onPick` accepts an action. Source plugins using only the documented trigger source/pick contract should recompile; custom menu renderers/controllers must update.
- The Lexical composer rewrite is **not itself a trigger-source protocol break**: its first-party decision explicitly keeps `TokenSpan`, `ReferenceInsert`, `CommandClaim`, the four `slash/input-*` events, sources, controller, and menu byte-compatible ([note](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-20-web-composer-lexical-editor.md#L13-L26)). Removed textarea-machine types were implementation internals; Conversation/Chat owner moves above are the real public break.

### 4.7 Observable styling changes

No existing `--dsw-*` custom-property name is removed. However, default content typography shrinks, `fontSize` becomes user-controlled, and new `--dsh-content-font-*` variables influence metrics. Revalidate fixed-pixel layouts and visual snapshots.

The shell also enables `body { text-autospace: normal }`; code/pre and known aligned-result selectors opt out. An external terminal/table/diff surface outside those selectors should add `text-autospace: no-autospace` ([target base CSS](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/web/src/base.css#L28-L42)).

---

## 5. Client loading, boot data, module graph, and HMR

### 5.1 The ordinary plugin declaration remains compatible

Both endpoints require:

- a package `dsh.client` object with `platform: "web"`;
- a resolvable built `./client` export;
- optional string arrays `inject` and `external`;
- optional boolean `immediately`;
- a lazy-CJS artifact that calls `window.__ModuleLoader__.load({ id, factory })` and returns `module.exports`.

See the target [client modules contract](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/modules/README.md#L28-L44). A normal ESM browser bundle was invalid at both endpoints. The first-party `clientBundle()` build preset remains repository-private, so an out-of-tree package must still reproduce the wrapper.

Merely installing a package is still not activation. The Host scans active Loader rows; a bundle patch or explicit profile/preset row must name the package. The external settings-card isolation design used by Raven therefore remains valid.

### 5.2 Shared module table changes

Baseline shell modules were React, React DOM, Cordis, UI slots, and UI primitives, while `@deepseek-ai/dsh-client-runtime/client` was a parser-preloaded dynamic external. The target removes that external and adds shell-static `@deepseek-ai/dsh-client-store` ([target platform table](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/web/src/platform.ts#L8-L16)).

Migration for a manual bundle:

- Remove every `require('@deepseek-ai/dsh-client-runtime/client')`.
- Externalize `@deepseek-ai/dsh-client-store` by that exact name when used.
- Do not list shell baseline modules under `dsh.client.external`; they are implicit.
- List a non-baseline dynamic request by its exact import specifier; only a trailing `/client` aliases the package row.
- Do not use `external` as a feature-plugin implementation-sharing mechanism.

The target verifies malformed, missing, self, and cyclic synchronous requests ([module rules](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/AGENTS.md#L73-L97)).

`dsh.client.inject` still does not order Cordis activation; service injection does. It now additionally ensures the named dependency factory arrives before consumer materialization ([`5549b9ad`](https://github.com/deepseek-ai/deepseek-harness/commit/5549b9add532ddf432aa52f1c9422d1eda3ff2e2)), which is compatible load-order protection.

### 5.3 Duplicate package sources now fail loud

Commit [`dc1be133`](https://github.com/deepseek-ai/deepseek-harness/commit/dc1be1334f3849ea33620fcfda77129148485694) rejects multiple active Loader sources that resolve to the same manifest package name. This affects a package mounted simultaneously by bare name and a relative/`file:` alias, or by two config trees with different source identities. Keep one active source. Repeating the same source is distinct from conflicting source identities; the [tests](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/modules/tests/node-half.client.spec.ts#L340-L393) pin recovery after one source leaves.

### 5.4 Custom `window.__DSH_BOOT__` is wire-incompatible

Old graph:

```ts
interface WebBootGraph { rev: string; entries: WebBootEntry[] }
```

Target graph:

```ts
interface WebBootGraph {
  rev: string
  entries: WebBootEntry[]
  batches: Array<{
    phase: 'bootstrap' | 'application'
    url: string
    rev: string
    entries: string[]
  }>
}
```

Every entry must belong to exactly one initial batch. Parsing produces `BootModuleRow.initialUrl` and now also carries its normalized `inject`. Initial load follows batch URLs; HMR follows a revisioned single-resource combo URL. Startup revisions are opaque nonces, not necessarily content hashes. Unknown URL combinations/revisions return 404. See [old graph](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/modules/src/client/manifest.ts#L66-L76), [target graph/parser](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/modules/src/client/manifest.ts#L65-L92), [`5bbaf168`](https://github.com/deepseek-ai/deepseek-harness/commit/5bbaf168d9759f78884a32c361d970544ba037d4), and [`83463aa8`](https://github.com/deepseek-ai/deepseek-harness/commit/83463aa89627575b205a438c521458bddd9df771).

A custom shell/proxy must preserve the entire combo query string, use the graph-provided URL, and stop constructing old `/plugins/<id>/client.js?rev=...` paths.

The optional `window.__DSH_BOOT_READY__` deferred is additive; a target-aware asynchronous injection producer may use it, while old synchronous pages still boot when it is absent.

### 5.5 Browser floor and artifact validation

The target injection tail uses `Promise.withResolvers()` without a local polyfill, and the shell build target is explicit ES2022. A browser without that API fails before client boot. Upgrade the browser or inject a polyfill before the readiness tail in a custom page ([target injection](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/host/webserver/src/injections.ts#L78-L104)).

There is also an implementation/docs discrepancy: target frontend path resolution no longer proves `apps/web/dist/index.html` exists at startup, so a printed URL can still lead to a 404. Treat an authenticated clean-root load as the readiness check and rebuild with `pnpm run build` if it fails.

### 5.6 HMR distinctions

Three mechanisms must not be conflated:

1. **Profile patch reload**: `dsh.profile.patchReload` watches patch files only.
2. **Cordis module HMR**: the base row becomes disabled by default in [`fd814589`](https://github.com/deepseek-ai/deepseek-harness/commit/fd814589fb590bbc332894fe6efc10270dfd0a7e). A custom profile that relied on it must explicitly enable the `hmr` row. Stock Web already disabled that shared row at baseline.
3. **Client-plugin bundle HMR**: remains mounted in the Web composition, but reloads only while the separate same-checkout `pnpm run dev:web` watcher rebuilds client bundles.

The source-checkout sequence remains: complete `pnpm run build`; run `pnpm dsh web`; separately run `pnpm run dev:web`. Shell and plain-package changes still require rebuild plus page refresh; starting another Vite server does not update the running `dsh web` page.

---

## 6. Session history, persistence, and projections

### 6.1 Session tool-view DTOs are removed

Commit family [`a42c0b52`](https://github.com/deepseek-ai/deepseek-harness/commit/a42c0b523ae558ebe51131717d184363a9c82bc6) / [`a4c296f9`](https://github.com/deepseek-ai/deepseek-harness/commit/a4c296f9fe1be6692053276426c49ee5d1e9a279) removes `SessionEventEntry.view`, `SessionToolView`, `SessionToolCallView`, and the client Session's parallel view array. History carries raw validated events and durable `tool/result.data.meta`; client `ui-tool` derives cards and external business renderers register by tool name in `tool.call.toolview`.

There is explicitly no dual-write/version-negotiation compatibility field ([decision](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.md#L23-L53), [wire contract](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.md#L155-L180)).

### 6.2 Session history gains packed records

Pages and follow opening snapshots now carry a discriminated `SessionHistoryRecord[]`:

- `{ type: 'event', event: SessionWireEvent }`
- `{ type: 'chunks', event: ChunkRowEvent }`, whose event type is `chunkrow/text-chunks`, `chunkrow/reasoning-chunks`, or `chunkrow/tool-call-chunks`.

Direct history consumers must switch on the outer type and explicitly decode when they require one logical event per chunk. A Conversation Definition that consumes Assistant deltas must implement both scalar and packed branches. Live stream events remain scalar. See the [packed-history decision](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-15-packed-session-history-transport.md#L13-L23) and consequences [L55-L61](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-15-packed-session-history-transport.md#L55-L61).

### 6.3 Unknown/external event nuance

The target removes public `SessionEvent.ignorable?: true`. A raw writer that previously persisted an unknown event with `ignorable: true` loses its skip escape hatch; the target rejects that log.

However, repository-external event reload is **not newly broken for ordinary `Session.append` users**. At the baseline, the coordinator already accepted an unknown event only when the stored record explicitly carried `ignorable: true`, while `Session.append` did not expose a way for an external plugin to set it. Thus a normal external `SessionEventMap` augmentation could run live but already failed on reload. The target simplifies this to “all unknown types fail” and still has no external event registration ([target decision](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/simplification/2026-08-25-fail-closed-session-event-vocabulary.md#L13-L21)).

Migration remains: do not persist a repository-external event through first-party session persistence. Use a known repository event's documented metadata, a first-party-owned event contribution, or plugin-owned storage.

### 6.4 Other Session type changes

- `RequestHeaderReason` adds `'series'`; update exhaustive switches.
- `request/header` gains `startsSeries?: true`.
- `TodoItem` and `todo/write` augmentation move to the Todo package.
- `sourceEventSeqs` may be physically encoded as a scalar/range representation in new JSONL artifacts even though logical reads restore the number array.

### 6.5 Persistence/projection implementer APIs

| Old | New / migration |
|---|---|
| External `SessionPersistence` subclass without `borrowSession` | Implement target abstract `borrowSession(id, signal?)` ([target abstract API](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/session/session-persistence/src/index.ts#L228-L244)). |
| `ProjectionDefinition.init(): S` | `init(header: SessionHeader): S`. |
| `restore(checkpoint, events, baseSeq)` | Accept the target header argument too ([target projection API](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/session/session-projection/src/index.ts#L46-L62)). |
| `SessionProjectionCache.coldSnapshot(id, signal?)` | `coldSnapshot(meta, events)`; use the new hydrate/cached-snapshot faces for controller integration. |

These are breaks for provider/implementer plugins and structural fakes, not for a plugin that only consumes `ctx.sessionPersistence` or registers a projection through the target interface.

### 6.6 Physical persistence formats

- **SQLite:** schema 17 → 19, 64 KiB pages, integer internal session keys, and dictionary-compressed independent values. Every other schema is rejected; there is no built-in migration ([target limitations](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/session/session-persistence-sqlite/README.md#L63-L78)). Export logical headers/events with the old build, create a fresh target DB, import through the persistence API, and verify list/load. Never change only `PRAGMA user_version`.
- **JSONL:** `SESSION_FORMAT_VERSION` remains 0 and old first-party logs load in the target. New writers can use scalar/range provenance encoding, so a rollback-era raw parser must not assume old bytes. Back up the root before first target write if rollback matters.

The logical Session API is intentionally storage-layout blind; only raw-file/SQL tooling must understand these physical changes.

---

## 7. Config, preset, profile, and SDK schema breaks

### 7.1 Profile manifest and app-boot APIs

`dsh.profile.patchReload` is new with values `live | startup`:

- stock `web`: `live`;
- stock `headless`, `acp`, `sdk`, `sdk-minimal`: `startup`;
- custom or omitted: historical `live` default.

An invalid value fails loud. Loading an exact stock tuple may write the stock default back into its manifest ([target templates/generator](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/boot/app-boot/src/profile.ts#L137-L217)). A custom headless profile that depended on live edits should set `live` explicitly.

Direct `@deepseek-ai/dsh-app-boot` consumers have source breaks:

- `Profile` gains required `patchReload`.
- `PROFILE_TEMPLATES[name]` changes from a string array to `{ bundles, patchReload }`.
- `healProfilesModuleFallback(installAnchor, home?)` becomes async `healProfilesModuleFallback({ installAnchor, profile?, home? }): Promise<void>` and must be awaited.
- `initProfile(dir, bundles, patchReload?)` is source-compatible for two-argument calls.

### 7.2 Shipped preset ownership and helper APIs

Shipped presets move from the source tree at `apps/cli/config/agent-presets` (published under `@deepseek-ai/dsh/config/agent-presets`) into `packages/preset/agent-presets/presets` / `@deepseek-ai/dsh-agent-presets/presets` in [`f94495e5`](https://github.com/deepseek-ai/deepseek-harness/commit/f94495e5275861b71baa16fcfe6f0b3406a5c425). Do not hard-code the old CLI package path. Use the preset roster/service or target `SHIPPED_PRESET_ROOT`.

`AgentPresets.Config` gains required TypeScript field `includeShippedRoot`, with schema default `true`. The bundled root is prepended and wins duplicate ids. An embedder that wants the old “configured roots only” behavior sets it to `false`; remove an explicit old shipped-root entry when accepting the new default.

Direct helper breaks:

- `scanRoot(root)` → `scanRoot(root, harnessBase)`
- `discoverPresets(roots)` → `discoverPresets(roots, harnessBase)`
- `PresetMount` gains required `tree`.
- `PresetBearingSession` / `resolveSessionPreset` are removed in favor of the target projection/roster path.

Pass the composition's Harness base URL so package rows are validated against the same resolution base the Loader uses.

### 7.3 Narrow plugin config breaks

| Plugin/config | Old | Target migration |
|---|---|---|
| Tools presentation | `code` | `ptc` only. |
| DeepSeek image route | `imageDetail` | `imagePixelBudget`; omit for default or set a number/`low`. |
| `web-fetch-http` | configurable `maxUrlLength` | Key removed; fixed maximum is 2048. Remove the key; a non-2048 override has no built-in equivalent. |
| `attachment-local` normalization | long-edge-only policy | Add `normalizedImageMaxPixels` / required `NormalizationPolicy.maxPixels`; review new long-edge/byte-target semantics. |
| `subagent-dsh-sdk` | required `command` + `args` | Profile launcher fields: `dshBin?`, `profile` (default `sdk`), `patches`, and absolute `dshHome`; delete command/args. |
| Connection | webServer only | Compose credentials; optional `cookieMaxAgeDays` controls browser-session lifetime. |

### 7.4 SDK client launch options

`HarnessClientOptions { command, args?, cwd?, ... }` becomes profile-based:

`{ dshBin?, profile?, patches?, dshHome?, processCwd?, env?, initializeTimeoutMs?, ... }`.

`DeepSeekHarnessOptions { launch: ... }` is flattened to extend those options directly. Migrate to:

`new DeepSeekHarness({ dshBin, profile, patches, dshHome, processCwd, cwd, provider, model, reasoningEffort })`.

The Python SDK has the corresponding hard migration: `runtime_bin` → `dsh_bin`, direct `cordis` → `profile + patches`, session root → explicit `dsh_home`, and removed launch override/default-config helpers. These matter only to a plugin's Python harness or embedder, not to its Node package at runtime.

---

## 8. CLI/plugin installation and process behavior

### Unchanged plugin-manager contract

`dsh plugin --profile <name> <args...>` still initializes a missing profile and forwards the remaining arguments to the actual `pnpm` on `PATH` with the profile directory as cwd. `add`, `install`, `remove`, `list`, `why`, and `update` retain pnpm semantics. Relative path specs are anchored to the invoking directory. On successful exit, DSH reconciles dependencies that declare `dsh.bundle` into `dsh.profile.bundles`; packages without it remain plain dependencies with a warning ([target CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/apps/cli/reference/README.md#L44-L66)).

The generated profile still uses `nodeLinker: hoisted` and `autoInstallPeers: false`, preserving the single-Harness/single-Cordis fallthrough design. Bundle membership changes require profile restart.

### Changed launch/process behavior

- Standalone demo bins are replaced by `dsh --profile acp|sdk|sdk-minimal`. A former complete `cordis.yml` is not automatically a profile patch; convert it to row-id deltas over a shipped profile or package it as a bundle.
- Headless success can now stream provider reasoning to stderr under `dsh: reasoning:`. Machine consumers should parse stdout plus exit code as the result and treat stderr as progress/diagnostics.
- `--dump-config` no longer guarantees that the shared profile module fallback is healed. Boot the profile before relying on that filesystem side effect.
- Missing frontend dist can surface as root 404 rather than an early launch error, as noted above.

### Privacy/operational behavior changes

These are not plugin API breaks but are externally observable and may require deployment action:

- Shipped telemetry changes from disabled to feedback-gated sharing. After `/feedback`, unshared session records can be uploaded and may contain messages, tool arguments/results, and paths. Preserve old behavior with `DSH_TELEMETRY_MODE=DISABLED` or non-empty `DSH_TELEMETRY_DISABLED` ([base behavior docs](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/apps/cli/reference/README.md)).
- A default-on DeepSeek request extension sends active Loader package names and versions. A separate canonical session-log upload extension is present but default-off.
- Shipped `web_fetch` becomes public-destination-only; old internal/private URL use is refused.
- The minimal profile no longer mounts Goal by default.
- WebSocket Remote mux adds a Host ping heartbeat; ordinary Remote consumers need no change.

---

## 9. Engine and tooling constraints

### Unchanged floors

The root remains:

- Node `^22.19.0 || >=24.0.0` (Node 23 remains excluded);
- `pnpm@11.7.0`;
- ESM-only package output;
- TypeScript `^6.0.3`, tsdown `^0.22.2`, tsx `^4.22.4`, and Vitest `^4.1.8`.

Most published leaves still do not repeat the root `engines`, so npm may not enforce the actual runtime floor. An external plugin should retain its own explicit Node engine declaration.

### Changed build/runtime constraints

- The browser module baseline changes as described under loading; a stale old client bundle can compile but fail at synchronous `require` in the page.
- Generated Typert artifacts cannot be reused across the migration. Rebuild host declarations and Remote contributions against the target owner packages.
- `@agentclientprotocol/sdk` moves from 0.25.1 to 1.4.0; a direct ACP protocol/library consumer should not assume library-level source compatibility.
- The repository removes the top-level `examples` workspace member; scripts filtering those old packages fail.
- The target browser effectively requires `Promise.withResolvers`, independent of the Node floor.

Cordis, Cosmokit, and Schemastery vendored package exports/public declarations have no release-range delta. Ordinary `name` / `inject` / `Config` / `apply(ctx, config)` Cordis plugin lifecycle remains the same.

### Published-package availability is a separate gate

At audit time, `pnpm config get registry` in this consumer resolves to `https://packagefeedproxy.microsoft.io/npm/`. Direct queries to that configured registry returned `ERR_PNPM_PACKAGE_NOT_FOUND` for `@deepseek-ai/dsh-tools@0.1.2-alpha.1` and HTTP 404 for the newly introduced `@deepseek-ai/dsh-client-store@0.1.2-alpha.1`. This is not source evidence of another Harness API change; it is an environment/publication constraint.

Consequently, two compatibility proofs must remain separate:

1. **Runtime/source compatibility:** test against checkout commit `6c705be1` and its built artifacts.
2. **Published compile/install compatibility:** test only when the configured registry exposes the complete `0.1.2-alpha.1` package set, or install the exact target release tarballs from a trusted build. A source-compatible migration can still fail package installation or TypeScript resolution while those artifacts are absent.

Do not weaken peer ranges or mix older RC declarations with the alpha runtime to make the registry query pass; that can produce duplicate/incoherent Cordis and service-definition identities.

---

## 10. Changes that are additive or internal for ordinary plugins

Do **not** treat these as required migrations unless the plugin directly implements the lower-level contract:

- Client plugin manifest shape and lazy-CJS registration wrapper remain.
- No production slot key is removed; four new slots are additive.
- External locale/language registration is additive.
- Models provider-card/footer slots are additive.
- New controller packages, `./typert`/`./remote` subpaths, Webhook packages, image-pricing facts, and optional token totals are additive.
- Client bundle batching, hashing deferral, gzip, indexed source maps, immutable response snapshots, and HMR polling optimizations are internal to an ordinary plugin. They are breaking only for a custom boot-wire/URL producer.
- Resolver changes that use each Loader row's owning base URL improve relative/`file:` out-of-tree loading; the only new failure is duplicate manifest identities.
- Lexical editor internals, optimistic composer echo, turn rail, UI copy/layout work, tests, docs, CI, and alias-generator changes do not alter the standard plugin registration contract.
- Webserver compression fields are additive.
- Root `Agent` declaration ownership moves internally, but the root effective handle shape remains compatible.

---

## 11. Recommended migration order

1. **Pin the endpoint** to Harness version `0.1.2-alpha.1` and official `dsh-v0.1.2-alpha.1` commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`; do not record the nonexistent unprefixed `v0.1.2-alpha.1` tag.
2. **Replace removed packages and subpaths** first: client runtime, Host ApiProxy, file-reference Remote artifacts, test/demo packages.
3. **Migrate Host vocabulary and nominal types:** `ToolCallId`, PTC mode, PTC dispatch types/waterfall, Todo type owner, Typert adapters, interaction waterfalls.
4. **Migrate API calls:** generated owner Remotes, controller client models, Connection generation, and exact fetch routes.
5. **Split client imports and hooks:** store, Session, Workspace, renderer, UI adapters, Conversation, and Chat owners; re-derive slot component props.
6. **Update bundle externals:** remove runtime/client and add exact shell-seeded `dsh-client-store`; eliminate feature runtime imports.
7. **Update UI props:** complete localized primitive labels, target Theme/input-trigger structural members, and target settings fakes.
8. **Update config/profile/preset/SDK schemas:** `ptc`, image/fetch/subagent fields, `patchReload`, shipped preset root, profile launch options.
9. **Update session providers and raw tooling:** packed history, raw-event-only presentation, projection/persistence signatures, SQLite migration, JSONL raw parser assumptions.
10. **Update custom Web transport if present:** browser cookie exchange, credentials/Connection/frontend composition, `WebBootGraph.batches`, exact combo URLs, target transport hooks, browser floor.
11. **Rebuild all artifacts:** target-generated Typert code, Host ESM, lazy-CJS `lib/client.js`, and the Web shell. Do not test with a stale bundle.
12. **Validate source and publication separately:** first use the official tagged checkout `cd5ef814` (same tree as `6c705be1`); only then validate registry installation once the configured registry exposes the complete alpha package set.
13. **Validate as a packed out-of-tree consumer:** install into a fresh profile, inspect `--dump-config`, boot the exact profile, exchange the token cookie, load the clean root, verify the plugin surface, run a session, restart, and verify durable reload.

## Implementation status for this repository

- [x] No source import, direct dependency, manifest edge, or emitted `require` names `@deepseek-ai/dsh-client-runtime`. Transitive RC compile packages still reference their own old runtime until alpha packages are published.
- [x] No import or call uses `@deepseek-ai/dsh-host-apiproxy`.
- [x] `CodeDispatch*` and `tools/code-dispatch-log` are replaced, while stored `tool/code-dispatch` remains.
- [x] Client `Context` comes from Cordis and settings augmentation from `ui-settings/client`. Raven needs only `HostObservable`, so its small plugin-owned publication source avoids an unavailable alpha store dependency and isolates subscriber failures with notification/unsubscribe tests.
- [x] The client bundle wrapper id equals package `name`; baseline externals stay implicit, the build generically preserves bare requests, and `test:dsh` checks every emitted request against the target module table.
- [x] `settings.plugin.item` renders after an authenticated target boot.
- [x] No Raven-specific Session event is written through first-party persistence.
- [x] Target preset values use `ptc`; live includes prefer the deployment-stable DSH package link, legacy generated `code` installs receive an explicit one-time `--force` migration, and discovery fails closed on malformed manifests or unexpected filesystem errors.
- [x] The official `cd5ef814` Host gate passes, including Loader/PTC replay, prompt bounds, client module-table requests, target preset discovery, and standing mount.
- [x] Packed external install passes through the configured mirror.
- [x] Authenticated browser boot, card render, save, reset, and page reload smoke pass.

### Browser validation

| Route/flow | Status | Evidence |
|---|---|---|
| Disposable `http://127.0.0.1:3180/` | Pass | Token exchange redirected to a clean authenticated root titled `DeepSeek Harness`. |
| Settings → Plugins → Raven | Pass | The packed plugin rendered `Raven 深度研究`, expanded into target-derived controls, and exposed enabled Save/Discard only after an edit. |
| Guidance save and reload | Pass | `auto → off` saved, the clean root was reopened with the same authenticated session, and `off` remained selected with Save disabled. |
| Reset | Pass | Reset staged the inherited `auto` value and saved cleanly. |
| Browser diagnostics | Pass with target warning | `agent-browser errors` reported no page errors and no Raven console error. The target Connection emitted repeated `connection lost` warnings while the test server remained listening; Raven card reads/writes continued to settle. |

The approved `agent-browser` fallback ran headless against a disposable `raven-browser-test-a1` profile; the default `web` profile was not modified.

Feedback telemetry and package inventory are deployment-level release behavior, not Raven-owned settings; operators must choose their policy during rollout.

## Primary evidence index

- [Complete comparison](https://github.com/deepseek-ai/deepseek-harness/compare/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e...6c705be1ce6774a000d061da41d1823b03a3d42c)
- [Web Client architecture](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/docs/subsystems/web-client.md)
- [Slots subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/docs/subsystems/slots.md)
- [Client Modules package](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/modules/README.md)
- [Client package rules](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/packages/client/AGENTS.md)
- [Unary ApiProxy → Remote migration](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-10-unary-apiproxy-remote-migration.md)
- [Client Session/Conversation ownership](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-20-client-session-conversation-ownership.md)
- [Client-derived tool presentation](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.md)
- [Browser authentication](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md)
- [Packed history transport](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-15-packed-session-history-transport.md)
- [Fail-closed session vocabulary](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/simplification/2026-08-25-fail-closed-session-event-vocabulary.md)
- [Code mode → PTC](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/.agents/notes/implemented/architecture/2026-08-25-rename-code-mode-to-ptc.md)
- [CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/6c705be1ce6774a000d061da41d1823b03a3d42c/apps/cli/reference/README.md)
