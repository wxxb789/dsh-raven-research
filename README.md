<div align="center">

<img src="assets/banner.svg" width="820" alt="dsh-raven-research — start, checkpoint, steer, complete, export: one progressive, source-grounded Task inside DeepSeek Harness">

# dsh-raven-research

**One progressive, source-grounded Task for deep research, writing, and learning —
inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

Early checkpoints you can steer mid-run · citations verified against the bytes actually retrieved · no second agent runtime.

[![CI](https://img.shields.io/github/actions/workflow/status/wxxb789/dsh-raven-research/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white)](https://github.com/wxxb789/dsh-raven-research/actions/workflows/ci.yml)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek_Harness-dsh--plugin-1a7f37?style=flat-square)](https://github.com/topics/dsh-plugin)
[![Harness 0.1.0-rc.8](https://img.shields.io/badge/harness-0.1.0--rc.8-4c6ef5?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.19-5fa04e?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Stars](https://img.shields.io/github/stars/wxxb789/dsh-raven-research?style=flat-square&logo=github&color=e3b341)](https://github.com/wxxb789/dsh-raven-research/stargazers)

English · [中文](README.zh.md)

[**TL;DR**](#tldr) · [**Install**](#install) · [**Usage**](#usage) · [**How it works**](#how-it-works-under-the-hood) · [**Configuration**](#configuration) · [**FAQ**](#faq)

</div>

> [!IMPORTANT]
> **v1 developer preview.** Pinned and tested against DeepSeek Harness `0.1.0-rc.8`, which is itself an RC and ships
> breaking changes. Not published to npm yet — [install from a checkout](#install).

## TL;DR

- **What it is:** a DeepSeek Harness (`dsh`) plugin that adds one progressive, evidence-aware Task abstraction for
  deep research, general writing, academic writing, and learning.
- **Why it matters:** you get a useful Checkpoint early, you steer it mid-run instead of restarting, and every
  citation is checked against the bytes actually retrieved — not against what the model remembers.
- **How it is built:** one [Cordis](https://github.com/cordiverse/cordis) plugin on the host plane, one
  model-facing `raven_task` tool, one compact prompt section, and one settings card in the Web GUI. No second
  agent runtime, no model host, no vector store, no database. The Harness agent keeps researching and writing
  with its normal tools.
- **Install:** `pnpm build && pnpm pack`, add the tarball to your Harness deployment, then
  `dsh plugin --profile <name> add dsh-raven-research`. See [Install](#install).
- **Use:** talk to the Harness agent normally — no launch phrase, no separate Task UI. See [Usage](#usage).
## Why Raven

A substantial research or writing request usually disappears into a long batch pipeline: you wait, you get one wall
of text, and the citations are whatever the model remembered. Raven changes the shape of that work.

| Plain long-running agent run | With Raven |
| --- | --- |
| Silence until a final dump | An early useful outline, draft, or findings set as a **Checkpoint**, then incremental refinement of the same Artifact |
| A correction restarts the work | A correction becomes a **Steering Revision** on the same Task; prior evidence and Checkpoints survive |
| Citations are remembered strings | Citations resolve to **inspected Sources**; excerpts are matched against retrieved bodies |
| Three reprints of one wire story read as three confirmations | Claims sharing a declared `sourceFamily` are marked as **not independent corroboration** |
| One dead link fails the whole run | Failed dependencies **defer only the affected Claims**; independently verified work still completes honestly |
| State dies with the tool call | The Task book is **rebuilt from the session log** and survives stop/resume |

Normal `discover → read → analyze → draft → verify → refine` movement stays autonomous. Raven asks only when an
unresolved choice changes the public outcome, evidence floor, audience, deliverable, significant cost, or an
external/destructive/sensitive side effect.

## Features

- **Batched discovery over the official search seam.** `discover` sends several complementary queries in one Task
  step through the Harness `web` search capability, folds one URL returned by several queries into one Lead, and
  keeps every sibling's results when a query fails — the failure is recorded as a Limitation, not an aborted batch.
  What comes back are **Leads**, never Sources: nothing can be cited until it has been opened and excerpted.
- **Agent Teams reuse.** Where the deployment composes the Harness Agent Teams capability, the Raven Task belongs to
  the Team: every member reads and extends the same Task, a teammate cannot start a competing one, and each member's
  own durable records merge into one Task book. Where no Team is composed, nothing changes.
- **Progressive delivery.** A Checkpoint is useful on its own and is published while the Task is still running, so
  you can redirect the work before the expensive part.
- **Steering instead of restarts.** `steer` applies a user correction to the live Task and preserves prior evidence.
- **Citations checked against retrieved bytes.** Artifacts cite stable Source IDs with `[@source-id]`. Raven matches
  bounded excerpts against retrieved bodies, renders recorded URLs mechanically, and rejects unknown citations,
  unregistered URLs, cross-host redirects, and broken or mismatched Sources. A mismatch reports the nearest
  retrieved passage so the anchor can be repaired instead of retried blindly.
- **Independence-aware Claim trace.** Every Completion appends a trace mapping material Claim IDs and text to Source
  IDs, marking Claims whose Sources share one `sourceFamily` so reprints of a single originating record cannot read
  as several confirmations. Genuinely conflicting Claims are recorded as contested rather than silently resolved.
- **Honest partial results.** Withdrawn Claims force the asserting prose to be edited in the same Checkpoint; a
  dropped citation may not leave a bare assertion standing. Unverifiable evidence refuses publication rather than
  silently downgrading to "unchecked".
- **Session-durable Task book.** Works from a direct tool call and from inside a Code Mode `run_code` program, and
  survives stop/resume — see [One Task book, two durability paths](#one-task-book-two-durability-paths).
- **One sentence per line.** Every stored Artifact is normalized so each sentence occupies its own line, making a
  **line** the smallest edit unit: a revision diffs as the sentences that actually changed instead of as whole
  rewritten paragraphs. The transform is Markdown-structure-aware and idempotent — fenced code, tables, headings,
  thematic breaks, link definitions, math blocks, YAML frontmatter, hard line breaks, and list/blockquote
  continuation prefixes are copied through untouched.
- **Draft Variants.** `draft` asks every configured `provider/model` route for the same bounded instruction and
  returns the candidates, each laid out one sentence per line so they diff line by line. A Draft Variant is a
  candidate exactly as a Lead is: it carries no evidence, can never be cited, and never counts toward the evidence
  floor. Off until a deployment configures routes.
- **First-class settings namespace.** Registering the plugin exposes `raven-research` to every configuration surface
  a Harness deployment composes; there is nothing to add to the Harness itself.
- **A settings card in the Web GUI.** Raven ships a browser half that registers a card under Settings › Plugins for
  its own namespace — see [Configuration](#configuration) for what that requires.
- **Durable export.** `export` emits a valid [llm-wiki](docs/adr/0002-llm-wiki-repo-format.md) repository — artifact
  page, immutable `raw/` source pages with verification receipts, and an appendable `log.md` — that the agent writes
  with ordinary file tools. Raven never touches the filesystem itself.

## Install

Raven is **not on npm yet**, so install it from a checkout. Everything below happens outside the Harness repository:
you never edit a Harness checkout or a shipped preset.

### Requirements

| Requirement | Version |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.8` (checkout `141eb6fef83422698aef7a981029e843e8161534`) |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| pnpm | `11.21.0` |
| Peer dependencies | Nine `@deepseek-ai/*` packages — the cordis framework, the schema library, and seven Harness Service Definitions (`cordis`, `dsh-agent`, `dsh-llm`, `dsh-session`, `dsh-settings`, `dsh-system-prompt`, `dsh-tools`, `dsh-web`, `schemastery`) — supplied by the Harness deployment, never bundled |

### 1. Build and pack

```bash
git clone https://github.com/wxxb789/dsh-raven-research.git
cd dsh-raven-research
pnpm install --frozen-lockfile
pnpm build
pnpm pack        # -> dsh-raven-research-0.1.0.tgz
```

### 2. Add the tarball to your Harness deployment

Run this from the deployment root; the package only has to be resolvable in that Node resolution graph:

```bash
pnpm add /path/to/dsh-raven-research-0.1.0.tgz
```

The tarball installs with no runtime dependency of its own; the deployment supplies the peers. They are peers rather than dependencies on purpose: a profile installs plugins with `autoInstallPeers: false` so they fall through to the running installation and every plugin shares one cordis instance. Once the package
is published, the equivalent dependency is `dsh-raven-research@0.1.0`.

### 3. Enable it

Raven declares a Profile Bundle (`dsh.bundle.patch` in `package.json`), so the Harness CLI can mount it for you:

```bash
dsh plugin --profile <name> add dsh-raven-research
```

That appends the package to the profile's `dsh.profile.bundles`, and the bundled
[`cordis.patch.yml`](./cordis.patch.yml) inserts one row on the **host plane**:

```yaml
- insert:
    - id: raven-research
      name: dsh-raven-research
```

Host plane is deliberate. Raven publishes no Service, so the usual host-plane criterion does not apply; what does
apply is that two of the things it registers are process-wide. Its settings namespace can only be offered while
something serves it — mounted only inside a preset, `raven-research` would appear in the settings UI exactly while
a session using that preset happened to be alive, and vanish between sessions. The `tools/code-dispatch-log`
waterfall, which carries the durable record of a Task step taken from inside `run_code`, is process-wide for the
same reason. Because `tools` and `system-prompt` are layered registries, a host row lands in the global layer and
every agent sees `raven_task` without opting in.

<details>
<summary><b>Alternative: scope Raven to one agent preset</b></summary>

<br>

To give Raven to a single preset instead, skip the bundle and append the row from
[`examples/agent-row.cordis.yml`](./examples/agent-row.cordis.yml) to that preset's `cordis.yml`:

```yaml
- id: raven-research
  name: dsh-raven-research
  # Optional base layer for the raven-research settings namespace:
  # config:
  #   sourceVerification: remote
  #   sourceCheckTimeoutMs: 30000
```

> [!WARNING]
> **Never edit a shipped Harness preset** — copy it first. Raven publishes no process service, so this row needs no
> isolate realm. It consumes the preset's scoped `tools` and `systemPrompt` registries and obtains `web` dynamically
> when source reopening is available.

</details>

> [!WARNING]
> **Do not do both.** The same package mounted on the host plane and inside a preset registers `raven_task` twice,
> into two different layers.

### 4. Verify

Start the Harness and ask the agent for something substantive (see [Usage](#usage)). Raven is live when a
`raven_task` call appears in the transcript and a Checkpoint arrives before the final answer.

## Upgrade

```bash
cd dsh-raven-research
git pull
pnpm install --frozen-lockfile
pnpm check          # lint, typecheck, test, build
pnpm pack
```

Then re-add the fresh tarball from the deployment root:

```bash
pnpm add /path/to/dsh-raven-research-<version>.tgz
```

pnpm keys a local tarball by its integrity hash, so new bytes are picked up even when the version string is
unchanged; if a deployment still serves the old build, run `pnpm install --force`.

Two things to check before upgrading:

- **Harness pin.** Compare `dshRaven.harnessVersion` in `package.json` with the Harness you actually run. Raven is
  pinned to one RC and does not claim compatibility with untested versions.
- **Settings.** `raven-research` values stored in the user's `settings.yaml` survive the reinstall; the preset
  `config:` block is only the base layer.

> [!WARNING]
> An in-flight Task lives in the session, not on disk. Finish it or `export` it before swapping the build.

## Uninstall

1. Remove Raven from the profile bundle:

   ```bash
   dsh plugin --profile <name> remove dsh-raven-research
   ```

   If you mounted the preset row instead, delete the `- id: raven-research` row from that preset's `cordis.yml`.

2. Remove the package from the deployment:

   ```bash
   pnpm remove dsh-raven-research
   ```

3. Optional: drop the `raven-research` section from the user's `settings.yaml`.

Every Raven registration — the `raven_task` tool, the prompt section, the `agent/pre-step` listener, the
`tools/code-dispatch-log` listener, the settings section, and the browser card — is disposer-backed and owned by its
Cordis fiber, so unloading removes all of it and leaves no orphaned tool or prompt text (`pnpm test:dsh` exercises
exactly that disposal path against a real Harness Loader). Restart the Harness if your deployment does not reload
the composition on change.

Nothing else is left behind: Raven owns no database, no cache, and no files. Task state lives in the Harness session
log, and anything you exported is a plain llm-wiki repository you already own.

## Usage

There is no launch phrase and no separate Raven UI — users talk to the Harness agent normally, and the model drives
the Task lifecycle.

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

Steering is just the next message — "focus on cost, not adoption", "make it more sceptical", "cite only primary
sources" — and it lands on the same Task instead of starting a new one.

### The `raven_task` actions

`raven_task` is model-facing. These are internal lifecycle operations on one user Task, not workflows a user has to
manage:

| Action | What it does |
| --- | --- |
| `start` | Opens one Task with an Outcome (`research`, `general-writing`, `academic-writing`, `learning`) and a grounding level (`required`, `optional`, `none`). |
| `discover` | Runs one batch of complementary queries through the Harness `web` search seam and returns **Leads** — uninspected candidates, never Sources. A failing query becomes a Limitation instead of losing the batch. |
| `draft` | Asks every configured `provider/model` route for the same bounded instruction and returns the candidates for comparison. A **Draft Variant** carries no evidence and can never be cited. |
| `checkpoint` | Publishes a user-visible Artifact version with new Sources, Claims, and recorded failures, and verifies grounded evidence. |
| `steer` | Applies a user correction to the same Task, preserving prior evidence and Checkpoints. |
| `complete` | Validates citation identity, material Claim links, matched excerpts, Source reachability, and the exact Artifact fingerprint against the latest post-steer Checkpoint. |
| `status` | Reports the current Task book. |
| `stop` | Ends the Task with a recorded reason; explicitly not Completion. |
| `resume` | Reopens a stopped Task — including an older one — without losing evidence or Artifact. |
| `export` | Returns llm-wiki page bytes for the agent to write with ordinary file tools. |

### One sentence per line

Raven stores every Artifact in the Task's Prose Layout rather than in whatever line shape the model submitted.
Under the default `sentence-per-line` layout each sentence occupies its own line, so a **line** is the smallest
edit unit and a revision diffs as the sentences that actually changed. Markdown structure is never reflowed:
fenced code, tables, headings, thematic breaks, link definitions, math blocks, YAML frontmatter, hard line breaks,
and list or blockquote continuation prefixes are copied through as written.

The transform is idempotent, and the stored bytes are the ones Completion compares against — so the returned
Artifact, not the submitted one, is what the model edits next. Set `proseLayout: as-written` to store exactly what
the agent wrote, or `proseFormat: plain` where Artifacts are not Markdown.

### Comparing wording: Draft Variants

`action=draft` sends one bounded instruction — a section, a paragraph, an abstract — to every configured
`provider/model` route and returns the results together, each laid out one sentence per line so they diff line by
line. A route that fails or times out costs its own variant, never the round.

A Draft Variant is a **candidate**, exactly as a Lead is. It carries no evidence, may never be cited, and never
counts toward the evidence floor; a sentence every variant agrees on is still unsupported until a recorded Source
excerpt supports it. Adopt phrasing, never facts.

The deployment owns the route list: the agent may select a subset of `draftRoutes` and nothing else, because naming
a model is naming spend and a data path. An unknown route is refused with the configured set named rather than
quietly substituted. Drafting is **off** until a deployment sets `draftRoutes`; until then the call reports that
instead of drafting from the session model.

### Keeping the result after the session: llm-wiki export

After Completion, `action=export` returns page bytes for an [llm-wiki](docs/adr/0002-llm-wiki-repo-format.md)
repository: an artifact page under `wiki/queries`, one immutable `wiki/raw` page per Source carrying the verified
excerpt and its verification receipt (`capture: excerpt-only`), and one appendable `wiki/log.md` entry. Pass
`init=true` to also seed `SCHEMA.md`, `index.md`, and `log.md` for a repository with no wiki yet. The result is a
valid llm-wiki, readable by Obsidian and by that skill's own tooling. Write the returned bytes exactly — each
raw-page digest covers its own body, so editing after export invalidates it.

## How it works (under the hood)

```mermaid
flowchart LR
  U[User request] --> S["raven_task start"]
  S --> C1["Checkpoint<br/>early useful Artifact"]
  C1 --> ST["steer<br/>user correction"]
  ST --> C2["Checkpoint<br/>refined Artifact"]
  C2 --> V{"Source and Claim<br/>verification"}
  V -- "excerpt matches retrieved bytes" --> D["complete"]
  V -- "unknown citation / broken source" --> L["Claim deferred<br/>Limitation recorded"]
  L --> C2
  D --> E["export<br/>llm-wiki pages"]
```

### What the plugin registers

Raven exports plain Cordis plugin metadata (`name`, `inject = ['tools', 'systemPrompt']`, a Schemastery `Config`,
and `apply`) and keeps `apply` thin. On the host plane it registers:

- one `raven_task` model tool through `ctx.tools`;
- one compact static section through `ctx.systemPrompt`;
- one `agent/pre-step` listener that puts the live Task book in front of the model before each step;
- one `tools/code-dispatch-log` listener that keeps a Code Mode Task step durable (see below); and
- the `raven-research` settings section, gated behind `ctx.inject` so a deployment without a settings service simply
  never runs that wiring.

The package also ships a browser half (`dsh.client`, exported as `./client`) whose only contribution is one card in
the keyed `settings.plugin.item` slot, registered under the key `raven-research` — the same string the host half
registers as its settings namespace. That keying is what lets a plugin distributed outside the Harness repository
contribute a card at all: the tab pairs the two halves without ever learning what the namespace means. The browser
half mirrors no Task state; the tool, the evidence checks, the model calls, and the durable record are all host
concerns.

`web` is deliberately not injected: it is fetched dynamically from the context when a Source has to be reopened or a
discovery batch runs, so a deployment without it still loads and still writes. The experimental `agentTeams`
capability is read the same way and is never a dependency: it is private and unpublished upstream, so Raven mirrors
only the shape it reads and degrades to single-agent behaviour everywhere else. Every registration returns a
disposer owned by the calling fiber, which is what makes [uninstall](#uninstall) clean.

### One Task book, two durability paths

Raven keeps one Task book per session — or per Agent Team — and rebuilds it from the session log rather than from
storage of its own:

- A **direct tool call** carries the Task record as durable result metadata (`tool/result.meta`, kind
  `dsh-raven-research/task-state`).
- A call made **inside a Code Mode `run_code` program** is a nested sub-call with no result card, so the Harness
  computes no presentation metadata for it. Raven attaches the same record to the durable copy of that sub-dispatch
  instead, through the `tools/code-dispatch-log` waterfall, as an HTML comment on the Harness-owned
  `tool/code-dispatch` event.

> [!IMPORTANT]
> Raven writes **no plugin-owned session event type**. The Harness persistence read path refuses to interpret any
> stored log containing an event type it does not know unless the writer marked that event `ignorable`, and
> `Session.append` gives an out-of-repo plugin no way to set that marker — so a single Code Mode Task step written
> under a plugin-owned type would make the entire session unloadable. Riding a known event type keeps the session
> loadable by construction. If a deployment's spill policy replaces an oversized log copy, that one step is simply
> not restored; the session still loads, and the next direct call republishes the whole record.

Either path restores the book when a session resumes, so a Task advanced from inside a program is not silently lost.

### One Task per Agent Team

Where the deployment composes the Harness Agent Teams capability, Raven keys the Task book by the Team id rather
than by the Agent id, so the Lead and every teammate share one Task identity, one evidence set, and one Artifact.
A teammate's `start` is refused while the Team's Task is active, its Checkpoints land on that Task, and each
member's own durable records merge into the shared book as that member is first seen. Raven reads the capability
structurally through `ctx.get('agentTeams')` and contains every call: the Team packages are private, unpublished,
and carry no stability promise upstream, so the absence — or a throwing probe — must never fail a Task step.

### The failure path carries the Task too

A failed call has to reach the model with the Task it must correct against, but the registry's own error text cannot
know a Task is open. Raven attaches a `<raven_task_recovery>` note through the tool-owned content finalizer — the
one hook that also runs for invalid arguments and cancellations, where the output projection never runs at all.

### The verification pipeline

Grounded Checkpoints and Completion run recorded Sources through an internal `SourceVerifier` seam (a Harness-web
adapter in production, a deterministic adapter in tests):

1. Reopen the recorded URL over the Harness `web` capability, bounded by `sourceCheckTimeoutMs`.
2. Reject a redirect that leaves the recorded source identity, so a parked or aggregated host cannot silently stand
   in for a citation.
3. Normalize HTML presentation to text, then match the bounded excerpt literally; a mismatch reports the nearest
   retrieved passage instead of a bare failure.
4. Treat a truncated retrieval as **unverifiable**, never as fabrication — a body the fetch contract cut off is a
   retrieval limit, not missing evidence.
5. Report a per-Source timeout as unverifiable instead of holding the whole Checkpoint open.

Completion then re-checks citation identity, material Claim links, Source reachability, and the exact Artifact
fingerprint, and appends the independence-aware Claim trace.

### Package surface and non-goals

Raven ships as one dependency-light ESM package: one Cordis plugin, one model tool, one prompt section, a pure
TypeScript Task engine, a browser half contributing a single settings card, compact same-session replay through
official `tool/result.meta` and `tool/code-dispatch`, and three seams over official Harness capabilities — a
`SourceSearcher` for Leads and a `SourceVerifier` for evidence over `ctx.web`, and a drafter for Draft Variants.

It deliberately excludes a Task GUI, model host, vector store, custom scheduler, general agent framework, and
Raven-owned database. Long-running goals, subagents, workflows, files, and persistence remain Harness
responsibilities.

<details>
<summary><b>Design evidence and decisions</b></summary>

<br>

- [`docs/design/architecture.md`](./docs/design/architecture.md)
- [`docs/adr/0001-one-task-one-tool.md`](./docs/adr/0001-one-task-one-tool.md)
- [`docs/adr/0002-llm-wiki-repo-format.md`](./docs/adr/0002-llm-wiki-repo-format.md)
- [`docs/adr/0003-prose-layout.md`](./docs/adr/0003-prose-layout.md)
- [`docs/adr/0004-draft-variants.md`](./docs/adr/0004-draft-variants.md)
- [`docs/adr/0005-bundle-and-settings-card.md`](./docs/adr/0005-bundle-and-settings-card.md)
- [`docs/acceptance.md`](./docs/acceptance.md)
- [`docs/reverse-engineering/assessment.md`](./docs/reverse-engineering/assessment.md)
- [`docs/reverse-engineering/hermes-research-skills.md`](./docs/reverse-engineering/hermes-research-skills.md)
- [`docs/reverse-engineering/hermes-r-round-references.md`](./docs/reverse-engineering/hermes-r-round-references.md)
- [`docs/reverse-engineering/hermes-nana-wiki.md`](./docs/reverse-engineering/hermes-nana-wiki.md)
- [`CONTEXT.md`](./CONTEXT.md)

</details>

## Configuration

Raven owns the `raven-research` settings namespace. Registering it is what exposes it: a Harness that composes a
settings provider serves the namespace to every configuration surface.

| Field | Default | Effect |
| --- | --- | --- |
| `sourceVerification` | `remote` | `structural-only` withholds every remote check. No Source can then be confirmed, so a Checkpoint that records Sources is refused with the policy named. Set it only where the network is genuinely out of reach. |
| `sourceCheckTimeoutMs` | `0` | Deadline for one remote Source check, in milliseconds. `0` means no deadline. An exceeded deadline reports that one Source as unverifiable instead of holding the Checkpoint open. |
| `sourceDiscovery` | `seam` | `disabled` withholds `action=discover` entirely: the call reports discovery as unavailable and records a Limitation rather than returning an empty result the agent could mistake for "nothing exists". The agent keeps its own Harness tools. |
| `searchMaxQueries` | `4` | Upper bound on queries in one `discover` batch, mirroring the Harness `web_search` batch bound. The bound is applied **before** deduplication, so repeating a query spends its slot. |
| `searchMaxResults` | `8` | Upper bound on candidates requested per query, mirroring the Harness `web_search` source bound. The merged Lead list is bounded separately. |
| `searchTimeoutMs` | `30000` | Deadline for one discovery query, in milliseconds. `0` means no deadline. An exceeded query is recorded as a failed query and a Limitation; its siblings still return their Leads. |
| `proseLayout` | `sentence-per-line` | How every stored Artifact is laid out. The default puts one sentence on each line, making a line the smallest edit unit. `as-written` stores exactly what the agent submitted. |
| `proseFormat` | `markdown` | The Artifact format Raven assumes. `markdown` is the documented default final output format and is what makes the layout structure-aware. `plain` treats every line as prose, so a deployment whose Artifacts are not Markdown does not get its headings and code reflowed as sentences. |
| `draftRoutes` | `[]` | Model routes a Draft Variant may be requested from, one `provider/model` per entry, split on the **first** slash so a namespaced model id survives — `openrouter/deepseek/deepseek-chat` is the provider `openrouter` and the model `deepseek/deepseek-chat`. This list is the whole universe: the agent may select a subset of it and nothing else. Empty disables Draft Variants and reports that instead of drafting from the session model. |
| `draftMaxTokens` | `4000` | Upper bound on one Draft Variant, in model output tokens. `0` means the built-in bound. Every route in a round shares it so the variants stay comparable. |
| `draftTimeoutMs` | `120000` | Deadline for one Draft Variant, in milliseconds. `0` means no deadline. A route that exceeds it produces no variant and says so; its siblings still return theirs. |

> [!NOTE]
> No setting can lower a Task's evidence floor. Withholding checks makes evidence unverifiable, which refuses
> publication; it never turns unchecked Sources into confirmed ones.

The composition entry in `cordis.yml` is the `base` layer. A value stored in the user's `settings.yaml` overrides it
and takes effect on the next Source check, with no restart; if the settings service goes away, the composition entry
becomes authoritative again.

A browser card for this namespace is registered under **Settings › Plugins** by Raven's browser half, so the fields
above are editable without hand-writing `settings.yaml`. It is a disclosure card grouped into evidence, discovery,
prose, and drafting, drawn to the same geometry and design tokens as the cards the Harness ships for its own
plugins — they share one list, and a card that measured itself differently would read as a different kind of object.
Every edit is staged and written only on Save, including a Reset, because a settings write is a durable
revision-fenced document mutation rather than something a control should commit as it settles; the card marks which
keys the user layer actually overrides from key PRESENCE rather than value comparison, refuses a Save while any
staged edit is unacceptable rather than writing the valid half of a form, and reads the section back afterwards
rather than treating "no exception" as "landed". Copy ships in English and Simplified Chinese.

The card states no validation rules of its own. Its fields, their control kinds, their accepted values, and their
bounds are read from the schema the Host half registered — reached through `settingsScope.describe()`, which carries
each namespace's serialized schema, and rehydrated through the Harness's own `settingsSchema` service, whose class
doc names this exact use: *"Dynamic client plugins receive this Cordis entity instead of importing executable
helpers from one another."* A refused draft therefore reports the schema's own words (`expected number >= 0 but got
-5`), a bound that lives only in `config.ts`. Adding a field to `Config` makes it appear in the card without
touching the browser half; only its label, hint, and group are local, because the schema carries no title, order, or
group metadata and the Harness's own cards take all three from locale keys for the same reason.

One rule is deliberately this card's rather than the schema's: `draftRoutes` is `array(string)`, so the Host accepts
any strings at all and the engine then skips every entry that is not `provider/model`. Refusing that Save is the
card declining to offer an action whose effect would be silence, and it is reported as the card's own rule.

Three honest requirements. The card only appears in a deployment that composes
`@deepseek-ai/dsh-client-ui-settings-plugins` — the Harness web app bundle does. It injects the browser `locale` and
`settingsSchema` services, so a client shell without them runs none of this wiring. And the keyed
`settings.plugin.item` slot it targets is the contract as declared by Harness `0.1.0-rc.8`; `0.1.0-rc.6` is still
the newest version published to npm and declares the older list-shaped slot, so Raven vendors the newer shape —
together with the locale registration signature, the schema service, the describe face, and the card chrome it
mirrors — and `scripts/verify-dsh.ts` asserts all of them against the Harness checkout under test, which turns any
drift into a failed release gate instead of a card that silently never renders, renders its own dictionary keys, or
judges values by a contract the Host no longer honours.

Because the client bundle preset that compiles `.module.css` is unpublished, the card carries its stylesheet as text
and injects one `<style data-plugin="dsh-raven-research">` tag at module scope, which is the same end state that
preset produces. Losing that injection does not fail a build — it renders an unstyled blob inside a list of styled
cards — so `tests/integration/client-bundle.test.ts` asserts the CSS is in the artifact.

## Compatibility

Raven v1 is pinned and tested against:

- DeepSeek Harness `0.1.0-rc.8`;
- Harness checkout commit `141eb6fef83422698aef7a981029e843e8161534`;
- Node.js `^22.19.0 || >=24.0.0`; and
- pnpm `11.21.0`.

DeepSeek Harness is currently an RC and ships breaking changes. Raven does not claim compatibility with untested
Harness versions.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:pack
```

The repository uses a TypeScript-first modern toolchain: TypeScript 6 for strict type checking, tsdown for ESM and
declaration builds, Vitest for unit/integration/acceptance tests, Oxlint with warnings denied, and pnpm with a
frozen lockfile and an explicit `esbuild` build allowlist.

Verify the real Harness Loader, prompt registry, tool registry, execution pipeline, and Cordis disposal against the
intended checkout:

```powershell
$env:DSH_CHECKOUT = 'Q:\repos\deepseek-harness'
pnpm test:dsh
```

For a release-equivalent local gate:

```powershell
$env:DSH_CHECKOUT = 'Q:\repos\deepseek-harness'
pnpm check:release
```

### Acceptance coverage

<details>
<summary><b>The Vitest suite covers all four Outcomes and verifies that Raven …</b></summary>

<br>

- batches complementary discovery queries, folds one URL into one Lead, and survives a failing query;
- refuses to present Leads as evidence, and reports withheld or absent discovery instead of an empty search;
- lays every stored Artifact out one sentence per line, idempotently, without reflowing Markdown structure;
- returns Draft Variants as candidates only, and reports an unconfigured or unknown route instead of substituting one;
- inserts exactly one host-plane row from the bundle patch, and registers the settings card under its namespace key;
- shares one Task across an Agent Team and refuses a teammate's competing Task;
- keeps a Code Mode Task step durable without writing any plugin-owned session event type;
- exposes a useful intermediate research Artifact before final verification;
- refines the same Task after a mid-run user correction;
- proceeds through normal stages without a confirmation action;
- rejects unknown references and recorded excerpts absent from retrieved source bytes;
- reopens cited URLs before grounded Checkpoints and again at Completion;
- preserves independent results across partial source failures;
- requires Completion bytes to equal the latest post-steer Checkpoint;
- distinguishes Completion from tool/worker termination; and
- stops and resumes without losing the Task, evidence, or Artifact.

</details>

`pnpm test:pack` creates an isolated staging project with no `lib/`, links only the pinned development toolchain,
exercises the real `prepack` lifecycle without mutating the repository build, checks the exact nine-file allowlist,
and installs the tarball with an isolated pnpm home/store in a second external consumer before import, apply, and
model-tool execution.

## FAQ

**Does Raven replace the Harness agent, or add another model?**
Neither. Raven adds one task abstraction and one tool. The existing Harness agent does the research and writing
with its own tools and its own model.

**Do I need a vector database, an index, or an embedding pipeline?**
No. Raven has no store of its own. Sources are recorded by stable identity and reopened over the Harness `web`
capability when verification runs.

**Does Raven search the web itself, or does the agent?**
Both, on purpose. `action=discover` runs a batch of complementary queries through the same `ctx.web` search seam
that backs the Harness `web_search` tool, so the queries and their failures become part of the Task record instead
of disappearing into the transcript. The agent keeps its own retrieval tools for everything else, and it is still
the agent that opens a Lead and records the excerpt — discovery never produces evidence.

**Does it work inside an Agent Team?**
Yes. The Raven Task belongs to the Team rather than to one member. Agent Teams is an experimental, unpublished
Harness capability, so Raven consumes it optionally: without it, every Agent simply owns its own Task book.

**Does it work without web access?**
Yes, for non-grounded writing and learning. Without a composed Harness `web` capability, external Claims are not
published as supported: they remain deferred, and a grounding-required Task with zero valid Claims stays active
rather than being labeled complete.

**Does it work in Code Mode (`run_code`)?**
Yes — see [One Task book, two durability paths](#one-task-book-two-durability-paths).

**How is this different from a "deep research" pipeline?**
A pipeline hides its middle and hands you one final report. Raven publishes the middle as steerable Checkpoints on
one continuing Task, and gates Completion on excerpt-level verification rather than on the run having finished.

**Does excerpt matching prove the Claim is true?**
No. Raven verifies URL reachability and literal presence of the bounded excerpt after whitespace/HTML presentation
normalization. Literal presence is not semantic entailment; the agent remains responsible for Claim judgment.

**Is it on npm?**
Not yet. Build and pack from a checkout — see [Install](#install).

**Which DeepSeek Harness versions are supported?**
Only the pinned RC listed under [Compatibility](#compatibility).

**How do I remove it cleanly?**
Drop one preset row and one dependency — see [Uninstall](#uninstall). Raven leaves no database, cache, or files
behind.

## v1 limits

- Excerpt verification is literal, not semantic (see FAQ).
- The four Outcomes select grounding defaults and explicit prompt policy inside the existing Harness agent; Raven
  embeds no second model and no deterministic prose generator, so content quality remains model-dependent.
- Natural-language correction detection is performed by the Harness model using Raven's pre-step context. The plugin
  supplies the deterministic same-Task `steer` transition; it does not guess corrections with a rule-based text
  classifier.
- Without a composed Harness `web` capability, external Claims stay deferred.
- State is durable within the owning Harness session, including multiple stopped or completed Task identities and
  later resume of an older Task. Cross-session projects, reusable corpora, and spaced-repetition storage are out of
  scope; `export` is the supported way to keep work.
- Raven renders Task progress through ordinary tool results and chat; its only browser surface is the settings card,
  and v1 has no custom UI for the Task itself.
- Draft Variants are off until a deployment configures `draftRoutes`, and a variant is never evidence: it cannot be
  cited and never counts toward the evidence floor.

## Contributing

Issues and pull requests are welcome. Run `pnpm check` before opening a PR; the release-equivalent gate is
`pnpm check:release` with `DSH_CHECKOUT` pointing at a Harness checkout.

If Raven saves you a rewrite, a ⭐ helps other DeepSeek Harness users find it — and browse
[`dsh-plugin`](https://github.com/topics/dsh-plugin) for the rest of the ecosystem.

## License

[MIT](LICENSE)

---

<div align="center">

[TL;DR](#tldr) · [Install](#install) · [Upgrade](#upgrade) · [Uninstall](#uninstall) · [Usage](#usage) · [How it works](#how-it-works-under-the-hood) · [FAQ](#faq)

<sub><b>Keywords:</b> DeepSeek Harness plugin · dsh-plugin · Cordis plugin · AI research agent · deep research · agentic research · source grounding · citation verification · evidence-based writing · academic writing assistant · learning assistant · retrieval-augmented generation · hallucination mitigation · TypeScript · Node.js</sub>

</div>
