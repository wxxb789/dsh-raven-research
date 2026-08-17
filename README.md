# dsh-raven-research

Raven is a host-only native Cordis plugin for DeepSeek Harness that adds one
progressive, evidence-aware task abstraction for:

- source-grounded web research;
- general writing;
- academic writing; and
- learning assistance.

Raven does not add another agent runtime. The existing Harness agent researches and
writes with its normal tools while Raven maintains one continuing task identity,
visible intermediate artifacts, user steering, source/claim traceability, and final
completion checks.

## What makes Raven different

A substantial task does not disappear into a long batch pipeline. Raven publishes an
early useful outline, draft, explanation, study guide, or set of findings as a
Checkpoint, continues collecting and checking evidence, and incrementally refines the
same Artifact. A user correction becomes a Steering Revision on the same Task rather
than a restart.

Normal `discover → read → analyze → draft → verify → refine` movement is autonomous.
Raven asks only when an unresolved choice changes the public outcome, evidence floor,
audience, deliverable, significant cost, or an external/destructive/sensitive side
effect.

When external evidence is used, Raven records inspected Sources and material Claims.
Artifacts cite stable Source IDs with `[@source-id]`; the plugin matches bounded
excerpts against retrieved bodies, renders recorded URLs mechanically, and appends a
Claim trace mapping material Claim IDs/text to Source IDs. The trace marks Claims whose
Sources share one declared `sourceFamily` as not independent corroboration, so reprints
of one originating record cannot read as several confirmations. Unknown citations,
unregistered URLs, cross-host redirects, and broken or mismatched Sources are
rejected; a mismatch reports the nearest retrieved passage so the anchor can be
repaired instead of retried unchanged. Failed dependencies automatically defer Claims
that lose all usable support, while independently verified work can still complete
honestly.

## Compatibility

Raven v1 is pinned and tested against:

- DeepSeek Harness `0.1.0-rc.5`;
- Harness checkout commit `47f943859bef60e4160492346772ded9b24f765a`;
- Node.js `^22.19.0 || >=24.0.0`; and
- pnpm `11.21.0`.

DeepSeek Harness is currently an RC. Raven does not claim compatibility with untested
Harness versions.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:pack
```

The repository uses a TypeScript-first modern toolchain:

- TypeScript 6 for strict type checking;
- tsdown for ESM and declaration builds;
- Vitest for unit, integration, and acceptance tests;
- Oxlint with warnings denied; and
- pnpm with a frozen lockfile and an explicit `esbuild` build allowlist.

Verify the real Harness Loader, prompt registry, tool registry, execution pipeline,
and Cordis disposal against the intended checkout:

```powershell
$env:DSH_CHECKOUT = 'Q:\repos\deepseek-harness'
pnpm test:dsh
```

For a release-equivalent local gate:

```powershell
$env:DSH_CHECKOUT = 'Q:\repos\deepseek-harness'
pnpm check:release
```

## Install from a local checkout

Build and pack Raven:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm pack
```

Install the resulting tarball into the DeepSeek Harness deployment's Node resolution
graph with pnpm. Once the package is published, the equivalent dependency is
`dsh-raven-research@0.1.0`.

Create or copy a **user-authored** agent preset, then append the row in
[`examples/agent-row.cordis.yml`](./examples/agent-row.cordis.yml):

```yaml
- id: raven-research
  name: dsh-raven-research
```

Do not edit a shipped Harness preset. Raven publishes no process service, so this row
needs no isolate realm. It consumes the preset's scoped `tools` and `systemPrompt`
registries and obtains `web` dynamically when source reopening is available.

## Use

Users talk to the Harness agent normally; there is no launch phrase or separate Raven
UI. Examples:

```text
Research the strongest primary-source evidence for and against this policy. Show me
an early findings outline, keep working, and refine it into a decision memo.
```

```text
Turn these notes into an 800-word essay for engineering managers. Draft early so I
can redirect the emphasis.
```

```text
Develop a literature-review section from these papers. Preserve disagreement and do
not invent references.
```

```text
Teach me closures with one mental model, two worked examples, and a self-check.
```

The `raven_task` tool is model-facing. Its `start`, `checkpoint`, `steer`, `complete`,
`status`, `stop`, and `resume` actions are internal lifecycle operations on one user
Task, not separate workflows the user must manage.

## Architecture

Raven ships as one dependency-light ESM package with:

- one Cordis plugin;
- one `raven_task` model tool;
- one compact system-prompt section;
- a pure TypeScript Task engine;
- compact same-session replay through official `tool/result.meta`; and
- one internal `SourceVerifier` seam with Harness-web and deterministic test adapters.

It deliberately excludes a GUI, model host, vector store, custom scheduler, general
agent framework, and Raven-owned database. Long-running goals, subagents, workflows,
files, and persistence remain Harness responsibilities.

Design evidence and decisions:

- [`docs/reverse-engineering/assessment.md`](./docs/reverse-engineering/assessment.md)
- [`docs/reverse-engineering/hermes-research-skills.md`](./docs/reverse-engineering/hermes-research-skills.md)
- [`docs/reverse-engineering/hermes-r-round-references.md`](./docs/reverse-engineering/hermes-r-round-references.md)
- [`docs/reverse-engineering/hermes-nana-wiki.md`](./docs/reverse-engineering/hermes-nana-wiki.md)
- [`docs/design/architecture.md`](./docs/design/architecture.md)
- [`docs/adr/0001-one-task-one-tool.md`](./docs/adr/0001-one-task-one-tool.md)
- [`docs/acceptance.md`](./docs/acceptance.md)
- [`CONTEXT.md`](./CONTEXT.md)

## Acceptance coverage

The Vitest suite covers all four Outcomes and verifies that Raven:

- exposes a useful intermediate research Artifact before final verification;
- refines the same Task after a mid-run user correction;
- proceeds through normal stages without a confirmation action;
- rejects unknown references and recorded excerpts absent from retrieved source bytes;
- reopens cited URLs before grounded Checkpoints and again at Completion;
- preserves independent results across partial source failures;
- requires Completion bytes to equal the latest post-steer Checkpoint;
- distinguishes Completion from tool/worker termination; and
- stops and resumes without losing the Task, evidence, or Artifact.

`pnpm test:pack` creates an isolated staging project with no `lib/`, links only the
pinned development toolchain, exercises the real `prepack` lifecycle without mutating
the repository build, checks the exact six-file allowlist, and installs the tarball
with an isolated pnpm home/store in a second external consumer before import, apply,
and model-tool execution.

## v1 limits

- Raven verifies URL reachability and literal presence of the bounded excerpt after
  whitespace/HTML presentation normalization. Literal presence is not semantic
  entailment; the main agent remains responsible for Claim judgment.
- The four Outcomes select grounding defaults and explicit prompt policy inside the
  existing Harness agent; Raven does not embed a second model or deterministic prose
  generator, so content quality remains model-dependent.
- Natural-language correction detection is performed by that Harness model using
  Raven's pre-step context. The plugin supplies the deterministic same-Task `steer`
  transition; it does not guess corrections with a rule-based text classifier.
- Without a composed Harness `web` capability, Raven can still perform non-grounded
  writing and learning, but it will not publish external Claims as supported; they
  remain deferred, and a grounding-required Task with zero valid Claims remains
  active rather than being labeled complete.
- State is durable within the owning Harness session, including multiple stopped or
  completed Task identities and later resume of an older Task. Cross-session projects,
  reusable corpora, and spaced-repetition storage are intentionally out of scope.
- Raven renders progress through ordinary tool results and chat; v1 has no custom
  browser UI.
