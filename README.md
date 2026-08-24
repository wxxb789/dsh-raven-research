<div align="center">

<img src="assets/banner.svg" width="820" alt="dsh-raven-research — start, checkpoint, steer, complete, export: one progressive, source-grounded Task inside DeepSeek Harness">

# dsh-raven-research

**One progressive, source-grounded Task for deep research, writing, and learning —
inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

Early checkpoints you can steer mid-run · citations verified against the bytes actually retrieved · no second agent runtime.

[![CI](https://img.shields.io/github/actions/workflow/status/wxxb789/dsh-raven-research/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white)](https://github.com/wxxb789/dsh-raven-research/actions/workflows/ci.yml)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek_Harness-dsh--plugin-1a7f37?style=flat-square)](https://github.com/topics/dsh-plugin)
[![Harness 0.1.1-rc.2](https://img.shields.io/badge/harness-0.1.1--rc.2-4c6ef5?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.19-5fa04e?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Stars](https://img.shields.io/github/stars/wxxb789/dsh-raven-research?style=flat-square&logo=github&color=e3b341)](https://github.com/wxxb789/dsh-raven-research/stargazers)

English · [中文](README.zh.md)

[**TL;DR**](#tldr) · [**Install**](#install) · [**Usage**](#usage) · [**How it works**](#how-it-works-under-the-hood) · [**Configuration**](#configuration) · [**Operating**](#operating-raven) · [**FAQ**](#faq)

</div>

> [!IMPORTANT]
> **v1 developer preview.** Pinned and tested against DeepSeek Harness `0.1.1-rc.2`, which is itself an RC and ships
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
| DeepSeek Harness | `0.1.1-rc.2` (checkout `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`) — see [Version pinning and peer dependencies](#version-pinning-and-peer-dependencies) |
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

### 3. Raven is isolated to its own mode

**Raven contributes nothing until a session is started in Raven mode.** In `code` mode, in any other mode, and on
every settings page, this package is invisible: no `raven_task` in the tool catalog, no system-prompt section, no
pre-step Task context, and no settings card. Choosing the mode is the act of asking for Raven, and it is the only
way to get it.

That is why installing Raven is **one** step — step 4, the mode — and not two. Raven splits by `role`:

| Role | Mounted by | Registers | Isolated? |
| --- | --- | --- | --- |
| `role: agent` | the `raven` agent preset, step 4 | `raven_task`, its system-prompt section, the pre-step Task context, and the `tools/code-dispatch-log` waterfall | yes — scoped to the mode |
| `role: host` | nothing, by default | the `raven-research` settings namespace (the Settings → Plugins card) and the mount-time capability warning | **no** — a settings page is global |

The `tools/code-dispatch-log` waterfall does **not** need the host plane: event admission extends up the scope
chain and that event is scoped to `dispatch.agent`, so an agent-scoped listener still receives its own agent's Code
Mode sub-dispatches. Nothing the agent half needs is process-wide.

The settings namespace is the one surface that cannot be isolated, because a settings page is a *global* surface: a
card served from the host plane is visible from every mode, and a card served from inside the preset would appear
and vanish with a session using that preset. Isolation and the card cannot both be had — so isolation wins, and
**Raven is configured in the preset row instead**, in the `config:` block of the row the installer inserts. Every
field is listed there at its default and commented out, so you can see what is configurable without leaving the
file:

```yaml
- id: raven-research
  name: dsh-raven-research
  config:
    role: agent
    # sourceVerification: remote
    # sourceCheckTimeoutMs: 20000
    # searchMaxQueries: 4
    # proseLayout: sentence-per-line
    # …
```

<details>
<summary><b>Opt-in: the settings card, and the isolation it costs</b></summary>

<br>

> [!WARNING]
> **This breaks isolation, deliberately.** The card is a global page; mounting the host row makes Raven visible
> from *every* mode's Settings, including modes that will never offer `raven_task`. Do this only if editing YAML is
> worse for you than a Raven card appearing in `code` mode.

`dsh plugin add` will NOT do this for you. Raven declares no `dsh.bundle`, and the CLI says so when you install
it — *installed as a plain dependency, not a profile layer*. That absence is the isolation; mounting the row is a
deliberate act.

Paste the row into your profile's own overlay, `$DSH_HOME/profiles/<name>/cordis.patch.yml`, which is applied
after every bundle layer:

```yaml
# Raven's opt-in host row: the settings card, deliberately.
# `role: host` registers ONLY the `raven-research` settings namespace and the mount-time
# capability warning. No `raven_task`, no prompt section, no per-step Task context — those
# belong to `role: agent`, which the `raven` preset mounts. Other modes gain a card, not a tool.
# Delete this entry to return to full isolation.
- insert:
    - id: raven-research
      name: dsh-raven-research
      config:
        role: host
```

Restart the app afterwards: the composition is read at boot, and the browser half is loaded from the live loader
entries, so a card cannot appear in a process that started before the row existed.

With the card mounted, the preset row's `config:` becomes the *base layer*: a value stored in the user's
`settings.yaml` overrides it while the provider is composed, and the preset values become authoritative again if
it goes away. Mounting both roles is supported — the double-mount check only warns when the same role is mounted
twice.

</details>

### 4. Install the Raven mode

The agent half reaches a session as an agent preset — which is what a **mode** in the new-session UI is. Install it
with the bin this package provides:

```bash
npx dsh-raven-install-preset
```

That writes `$DSH_HOME/.agent-presets/raven` (`$DSH_HOME` defaults to `~/.dsh`), the user preset root
`@deepseek-ai/dsh-agent-presets` already scans.

**The mode INHERITS your deployment's own `code` preset, live.** A preset's `agent.cordis.yml` is the *whole*
agent composition — persona, tools, shell, compaction — not an overlay on a default, so a preset containing only
Raven's row would boot an agent with no persona, no tools and no shell. The installer therefore:

1. resolves a base preset — `--base <id>`, defaulting to `code` — by looking in `$DSH_HOME/.agent-presets`, then
   each `--base-root <dir>` you pass, then `$DSH_CHECKOUT/apps/cli/config/agent-presets` when `DSH_CHECKOUT` is
   set. If none of them carries it, the installer **fails naming every location it tried** and tells you to pass
   `--base-root` pointing at your deployment's `config/agent-presets`, rather than inventing a composition;
2. writes `raven/agent.cordis.yml` as a ~2 KB composition of **two top-level sibling rows**: one
   `cordis:include` row whose `path` is that base composition, and beside it, at the same level of the same
   document, one `dsh-raven-research` row with `config: { role: agent }`. That second row is the whole
   difference from the base;
3. puts a generated header on top naming the base preset id, the path it is read from, and the fact that this is
   **not** a snapshot.

```yaml
# $DSH_HOME/.agent-presets/raven/agent.cordis.yml — the whole file, minus its header
- id: inherited-code
  name: cordis:include
  config:
    # a file:// URL: the include resolves this with new URL(path, baseUrl) then
    # fileURLToPath, and a bare Windows path like Q:\… parses as a URL *scheme*
    path: file:///path/to/your/config/agent-presets/code/agent.cordis.yml

# Raven's row is a SIBLING of the include above — never inside its `patches` list.
- id: raven-research
  name: dsh-raven-research
  config:
    role: agent
```

> [!IMPORTANT]
> **This is live inheritance, not a copy.** `cordis:include` reads that file at *mount* time, so upgrading the
> Harness changes what Raven mode inherits on the very next session — there is nothing to re-sync and no copy to go
> stale.

> [!IMPORTANT]
> **The installer never touches your Harness.** Raven is a plugin *of* a deployment, not a co-owner of it. Every
> write it makes lands inside `$DSH_HOME/.agent-presets/raven`. Your preset files are read and never written,
> moved, renamed — not even a permission bit is changed.

> [!WARNING]
> **Why the row is a sibling, and must never move into `patches`.** `Include` rebases its child tree onto the
> directory of the file it included. A row inserted through the include's `patches` list therefore resolves
> `dsh-raven-research` from inside your **Harness install**, where it is not installed; the include fails to
> apply; and the failing tree is written back as `[]`. Nothing suppresses that write — a nested include is
> instantiated from the plain `Include`, not the `PresetTree` subclass whose `write()` is a no-op.
> **This truncated a real file:** a deployment's shipped `code` preset was found at 3 bytes, down from 13605.

A side-by-side run over a copy of that same base reproduced it exactly. The patched shape failed to mount and left
a 3-byte base. The sibling shape this installer writes mounted cleanly and left the base untouched:

```text
HOST-ONLY tools: []
roster:            ["raven"]
installed file:    1981 bytes
base after mount:  13605 bytes (unchanged)
```

Both rows resolve from the installed preset directory, the base is read live and never written, and `raven_task`
appears only in the preset's scope. Your base file stays writable and is left exactly as it was — the guard is
emitting a shape that **resolves**, not a permission bit on a file this package does not own. Separately, in case
something *else* writes your base, the installer **detects** it, which costs nothing and touches nothing:

| what a re-run finds | what it says |
| --- | --- |
| base digest unchanged | nothing; the mode is up to date |
| base changed | that this is expected after a Harness upgrade, and **nothing needs doing** — live inheritance already picked it up. Still exits zero |
| base now contains Raven's own row | a **warning** naming the file, saying this installer never writes it, and telling you to restore it from your Harness install |

`--snapshot` remains for a deployment that would rather not depend on a file outside this package. It composes a
**copy** — the base's comments preserved by concatenating *text* rather than re-emitting YAML — and that copy goes
stale on a Harness upgrade; `--snapshot --force` re-syncs it.

The installer is idempotent in both modes: a re-run that would change nothing says so, and a live install whose base
moved on is *still* up to date, because it never copied it. It refuses to overwrite a differing copy without
`--force`. Use `--dry-run` to see what it would do without touching anything.

<details>
<summary><b>Alternative: add Raven to a preset you already maintain</b></summary>

<br>

To put Raven inside an existing preset rather than give it its own mode, skip the installer and append the row from
[`examples/agent-row.cordis.yml`](./examples/agent-row.cordis.yml) to that preset's `agent.cordis.yml`:

```yaml
- id: raven-research
  name: dsh-raven-research
  config:
    role: agent
    # Optional base layer for the raven-research settings namespace:
    # sourceVerification: remote
    # sourceCheckTimeoutMs: 30000
```

> [!WARNING]
> **Never edit a shipped Harness preset** — copy it first. Raven publishes no process service, so this row needs no
> isolate realm. It consumes the preset's scoped `tools` and `systemPrompt` registries and obtains `web` dynamically
> when source reopening is available.

</details>

> [!NOTE]
> The mode is the whole install. The host row is an opt-in that trades isolation for the settings card — see
> [step 3](#3-raven-is-isolated-to-its-own-mode). With the roles split they do not overlap, so mounting both does
> not register `raven_task` twice.

> [!IMPORTANT]
> Because the agent half is mounted per agent scope, each scope gets its own plugin instance and therefore its own
> **in-memory** Task book. An Agent Team no longer shares one in-memory book; each member falls back to what its own
> durable session log carries. Task state still survives replay — see
> [One Task book, two durability paths](#one-task-book-two-durability-paths).

### 5. Verify

Start the Harness, pick **Raven** as the mode for a new session, and ask the agent for something substantive (see
[Usage](#usage)). Raven is live when a `raven_task` call appears in the transcript and a Checkpoint arrives before
the final answer.

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

A default (live) install needs **no** re-sync after a Harness upgrade — that is the point of it. Re-run the
installer only if you installed with `--snapshot`:

```bash
npx dsh-raven-install-preset --snapshot --force
```

Two things to check before upgrading:

- **Harness pin.** Compare `dshRaven.harnessVersion` in `package.json` with the Harness you actually run. Raven is
  pinned to one RC and does not claim compatibility with untested versions.
- **Base.** A live install tracks the upgraded base automatically. A `--snapshot` install does not: upgrading the
  *Harness* is exactly the case that leaves the copy inlined into `raven/agent.cordis.yml` stale, and running the
  installer without `--force` reports that before changing anything.
- **Settings.** `raven-research` values stored in the user's `settings.yaml` survive the reinstall; the preset
  `config:` block is only the base layer.

> [!WARNING]
> An in-flight Task lives in the session, not on disk. Finish it or `export` it before swapping the build.

## Uninstall

1. Remove the Raven mode. It is a directory, so deleting it is the whole step:

   ```bash
   rm -rf "${DSH_HOME:-$HOME/.dsh}/.agent-presets/raven"
   ```

   If you mounted the row into a preset you maintain instead, delete the `- id: raven-research` row from that
   preset's `agent.cordis.yml`. If you opted into the settings card, also remove the host row from the profile
   bundle with `dsh plugin --profile <name> remove dsh-raven-research`.

2. Remove the package from the deployment:

   ```bash
   pnpm remove dsh-raven-research
   ```

3. Optional: drop the `raven-research` section from the user's `settings.yaml`, if you ever opted into the card.

Every Raven registration — the `raven_task` tool, the prompt section, the `agent/pre-step` listener, the
`tools/code-dispatch-log` listener, the settings section, and the browser card — is disposer-backed and owned by its
Cordis fiber, so unloading removes all of it and leaves no orphaned tool or prompt text (`pnpm test:dsh` exercises
exactly that disposal path against a real Harness Loader). Restart the Harness if your deployment does not reload
the composition on change.

Nothing else is left behind: Raven owns no database and no cache, and writes no files at runtime (the preset
directory the installer writes is what step 2 removes). Task state lives in the Harness session
log, and anything you exported is a plain llm-wiki repository you already own.

## Usage

`raven_task` is registered by the `raven` agent preset, so it exists **only in Raven mode**. Pick that mode when
starting the session; in any other mode the agent has no Raven tool and will answer without a Task.

Within Raven mode there is no launch phrase and no separate Raven UI — users talk to the Harness agent normally,
and the model drives the Task lifecycle.

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

Code Mode is the Harness feature whose preset alias in the UI is **PTC mode**, so a deployment running that preset is
exactly the one this path serves. Raven does not restate that contract locally: `src/plugin.ts` imports
`CodeDispatchEventData` and `CodeDispatchLog` from `@deepseek-ai/dsh-tools` and pins the event key to the official
augmented `SessionEventMap`, so an upstream rename or reshape is a **compile error** here rather than a Task step that
quietly stops being restored. `pnpm test:dsh` closes the other half: it composes the official `run_code` tool over an
in-process code runtime and runs a real program that calls `raven_task`, so the real bridge runs the real waterfall
and appends the real `tool/code-dispatch` event — and it asserts the upstream declarations themselves, naming what to
restate if they ever move.

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
`settings.plugin.item` slot it targets is the contract as declared by Harness `0.1.1-rc.2`; `0.1.0-rc.6` is still
the newest version published to npm and declares the older list-shaped slot, so Raven vendors the newer shape —
together with the locale registration signature, the schema service, the describe face, and the card chrome it
mirrors — and `scripts/verify-dsh.ts` asserts all of them against the Harness checkout under test, which turns any
drift into a failed release gate instead of a card that silently never renders, renders its own dictionary keys, or
judges values by a contract the Host no longer honours.

Because the client bundle preset that compiles `.module.css` is unpublished, the card carries its stylesheet as text
and injects one `<style data-plugin="dsh-raven-research">` tag at module scope, which is the same end state that
preset produces. Losing that injection does not fail a build — it renders an unstyled blob inside a list of styled
cards — so `tests/integration/client-bundle.test.ts` asserts the CSS is in the artifact.

## Operating Raven

Everything in this section is a runtime property of the deployment, not a Raven setting.
A user who skips it discovers most of it when a Task refuses to complete.

### Prerequisites

| Outcome | Needs a composed `web` capability? | Needs a search credential? |
| --- | --- | --- |
| `research` | **Required** | Only for `action=discover` |
| `academic-writing` | **Required** | Only for `action=discover` |
| `general-writing` | Only if the Task registers Sources | Only for `action=discover` |
| `learning` | Only if the Task registers Sources | Only for `action=discover` |

**A composed `web` capability with a fetch provider is required for `research` and
`academic-writing`.** These two Outcomes default to `grounding: required`, and that floor
cannot be lowered to `none` by a setting or by the agent. Verification is what makes a
Source a Source: Raven reopens each recorded URL and requires the recorded excerpt to
occur in the retrieved body. With no fetch provider, **no Source can ever be verified**,
so no externally grounded Checkpoint can be published and Completion cannot succeed — a
grounding-required Task with zero verified Claims stays `active` rather than being
labelled complete. That is deliberate: the alternative is a "completed" research
document whose citations were never checked.

You will see the refusal as a Source check reporting:

```text
DeepSeek Harness web capability is not composed
```

and, when a provider is composed but none of them can serve the request, the Harness's
own error:

```text
no usable web provider is registered
```

**Discovery additionally needs the search provider's credential.** `action=discover` uses
the `web` **search** half, which is a different provider from the fetch half — fetch can
work while search does not. The DeepSeek search provider resolves a credential through
the credentials service, and without it the query fails with:

```text
DeepSeek search has no API key for "DEEPSEEK_API_KEY"; store it through the credentials service
```

That failure is recorded as a `tool` Limitation on the Task and the sibling queries keep
their Leads — a batch is never lost to one failing query. With no search half composed at
all, `discover` reports:

```text
DeepSeek Harness web search capability is not composed
```

Discovery is a convenience, not a requirement: the agent's own retrieval tools still
work, and it is always the agent — never `discover` — that opens a Lead and records the
excerpt.

Drafting is off by default and needs no credential of its own; if `draftRoutes` is empty,
`action=draft` reports `no Draft Variant route is configured` instead of quietly drafting
from the session model. A configured route does require that provider's credential in the
Harness.

### Cost

Raven adds no model of its own, but two actions multiply work the deployment pays for.

- **A draft round bills every configured route, in parallel.** `action=draft` sends the
  same instruction to every route in `draftRoutes` (or the subset the agent selects) and
  runs them concurrently, so the cost of one round is the sum over routes, not the cost
  of one model. Three routes is three billed completions for one instruction. Each is
  bounded by `draftMaxTokens` (default `4000` output tokens) and `draftTimeoutMs`
  (default `120000`). This is why the deployment owns the route list and the agent may
  only pick a subset: naming a model is naming spend and a data path.
- **Verification re-fetches every cited Source, twice per publication.** Sources are
  reopened at `checkpoint` **and** again at `complete` — Completion does not trust the
  Checkpoint's earlier result, because a volatile page can change between them and a
  stale pass is exactly the failure the verification exists to prevent. A Task with 20
  Sources checkpointed four times and completed once performs on the order of 100 fetches.
  Bound each one with `sourceCheckTimeoutMs`.
- **Discovery** costs one search-backend call per query in the batch, up to
  `searchMaxQueries` (default `4`), each requesting up to `searchMaxResults` (default `8`)
  candidates.

Checkpoints, steering, status, stop, resume, and export perform no network calls and
bill nothing.

### Data handling

Raven has no store, no telemetry, and no network destination of its own. Everything that
leaves the machine leaves through a Harness capability the deployment composed:

| What leaves | Where it goes | When |
| --- | --- | --- |
| Recorded Source **URLs**, re-fetched in full | The origin host of each Source | Every `checkpoint` with Sources, and every `complete` |
| **Search queries** you or the agent formulate | The composed search backend (e.g. the DeepSeek search provider) | Every `discover` |
| The **draft instruction** and whatever context the drafter sends with it | Every configured model route in the round | Every `draft` |

Note the third row: **Artifact and instruction text is sent to each draft route**, so a
route pointed at a third-party provider is a data path for the text being written. That
is the reason `draftRoutes` is a deployment setting and not something the agent can widen.

Nothing else is transmitted. Recorded excerpts, Claims, Limitations, and Artifacts live
in the Harness **session log** and nowhere else; Raven writes no file at any point.

**On `export`, Raven still writes nothing.** `action=export` is a pure projection: it
returns llm-wiki page bytes and their intended paths, and the *agent* writes them with
ordinary Harness file tools, inside that agent's existing approval and sandbox boundary.
What lands on disk when you accept those writes is:

```text
wiki/queries/<slug>.md    the Artifact page, with derived frontmatter
wiki/raw/<source-id>.md   one immutable page per Source: the verified excerpt only
                          (capture: excerpt-only) plus its verification receipt and a
                          sha256 over that page's own body
wiki/log.md               one appended entry
wiki/SCHEMA.md            seeded only with init=true
wiki/index.md             seeded only with init=true
```

The `raw/` pages store the bounded excerpt, **not** a full page capture, so an export is
not a copy of the sources you read.

### Limits

Every ceiling is per Task and enforced by the engine, so a direct caller cannot bypass
it. They exist because Task state is replayed from the session log on every resume:
unbounded state would eventually make a session unloadable.

| Cap | Limit | What happens at the limit |
| --- | --- | --- |
| Sources | **256** | Further Source registrations in the submitted batch are rejected; the Checkpoint is refused with the cap named, leaving prior state intact. |
| Claims | **512** | Same — the batch is refused rather than silently truncated, so provenance is never partially recorded. |
| Checkpoints | **128** | `checkpoint` is refused. The Task stays active and completable against its latest existing Checkpoint. |
| Limitations | **256** | Recorded failures stop accumulating. The Task keeps working; the cap is reported so a Limitation is never dropped silently. |
| Artifact | **100,000 characters** | The submitted Artifact is rejected before it is laid out or hashed. Split the work or export and continue. |
| Steering Revisions | **128** | `steer` is refused; existing Checkpoints and evidence are untouched. |

Two rules make these survivable rather than terminal: a refused contribution **never
mutates state** — resubmit a smaller batch — and a Task that has hit a cap can always
still `complete` and `export`. Individual field ceilings (a request or correction at
20,000 characters, a summary at 2,000, an excerpt at 20,000, a Source title at 1,000, a
locator at 4,000) are reported the same way.

### Troubleshooting

| What you see | Why | What to do |
| --- | --- | --- |
| `DeepSeek Harness web capability is not composed` | No fetch provider. No Source can be verified. | Compose the `web` capability. For non-grounded writing or learning, start the Task with `grounding: none`. |
| `no usable web provider is registered` | `web` is composed but no registered provider can serve the request. | Check which providers the deployment registers and whether they are `available()`. |
| `DeepSeek search has no API key for "DEEPSEEK_API_KEY"` | Discovery reached the search provider, which has no credential. | Store the key through the credentials service (Models page in the Web GUI, or the environment). Fetch is unaffected. |
| `DeepSeek Harness web search capability is not composed` | No search half at all. | Compose a search provider, or let the agent use its own retrieval tools — discovery is optional. |
| Discovery reports unavailable and records a Limitation, with no error | `sourceDiscovery: disabled`. | Deliberate: an empty result would read as "nothing exists". Set it back to `seam`. |
| `no Draft Variant route is configured` | `draftRoutes` is empty — the default. | Set `draftRoutes` to `provider/model` entries. Drafting is off until you do. |
| A route is refused with the configured set named | The agent selected a route outside `draftRoutes`. | Expected: the agent may only select a subset. Add the route to the deployment setting if it should be allowed. |
| A Checkpoint recording Sources is refused, naming `structural-only` | `sourceVerification: structural-only` withholds every remote check. | Set it back to `remote`. It never turns unchecked Sources into confirmed ones. |
| Completion is refused: candidate bytes differ from the latest Checkpoint | The final edit was never published as a Checkpoint, or the *submitted* bytes were edited rather than the *stored* ones. | Re-read the rendered Artifact and complete with exactly those bytes. Storage is in the Task's Prose Layout, so the returned bytes differ from what was sent. |
| Completion is refused: a Steering Revision has no subsequent Checkpoint | A correction arrived after the last Checkpoint. | Publish a Checkpoint that applies the correction, then complete. |
| A cited Source reports its excerpt absent, naming the nearest passage | The excerpt does not occur in the retrieved body. | Repair the excerpt from the named passage. Do not weaken a correct excerpt until it fits — an *absent* excerpt is a different signal from a *diverging* one. |
| A Source reports `unavailable` on a truncated retrieval | The fetch was cut off; a cut-off body cannot disprove an excerpt from the tail. | Not an accusation of fabrication. Retry, or cite a locator earlier in the document. |
| A grounded Task will not complete despite good work | No material supported/qualified external Claim has a currently reachable, excerpt-matched Source. | Verify at least one Source, or accept `completed-with-limits` by deferring the affected Claims explicitly. |
| The settings card is missing from Settings › Plugins | The deployment does not compose `@deepseek-ai/dsh-client-ui-settings-plugins`, or the client shell lacks the `locale`/`settingsSchema` services. | Edit `settings.yaml` directly. The Harness web app bundle does compose it. |
| An in-flight Task vanished | Task state lives in the session, not on disk. | `export` before swapping builds or ending a session. Use `status` after a resume to reconstruct the book. |

## Version pinning and peer dependencies

Two version numbers in `package.json` look like they disagree. They do not, and the
difference is worth understanding before reading it as drift.

```json
"peerDependencies": { "@deepseek-ai/dsh-tools": "*", ... },
"devDependencies":  { "@deepseek-ai/dsh-tools": "0.1.0-rc.6", ... },
"dshRaven": {
  "harnessVersion": "0.1.1-rc.2",
  "harnessCommit": "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e"
}
```

**The peers are `*` deliberately.** A profile installs plugins with
`autoInstallPeers: false` and `nodeLinker: hoisted` precisely so an out-of-tree plugin's
peers fall through to the running Harness installation and every plugin shares **one**
cordis instance. A narrowed range cannot make a mismatched deployment work — it either
fails the install or resolves a *second* copy whose services the Harness cannot see, and
that failure presents as an absent service rather than as a version conflict. So the
range is not where compatibility is expressed.

**The `dshRaven` pin is where it is expressed.** It names the exact Harness version and
commit this build was tested against. `scripts/verify-dsh.ts` is its executable check —
it reads the pin from `package.json` (there is deliberately no second copy) and composes
Raven against a real checkout — and the release workflow refuses to publish a build whose
pin is absent or malformed. **Read the pin, not the ranges, to know what this build runs
against.**

**The `@deepseek-ai/*` devDependencies are at `0.1.0-rc.6` while the pin says
`0.1.1-rc.2`, and that gap is expected.** Those devDependencies are the newest Service
Definition packages *published to npm*; the pin targets the *Harness release*, which
moves ahead of them. The two numbers describe different things and are not required to
match. Where the gap actually matters — the client slot contract, whose shape changed
between them — Raven vendors the newer shape in `src/client/slot-contract.ts` and
`scripts/verify-dsh.ts` asserts it against the pinned checkout, so the drift breaks the
release gate instead of silently producing a card that never renders. Dependabot is
configured to ignore `@deepseek-ai/*` so an automated bump cannot move that seam while
leaving the pin claiming a compatibility that no longer holds.

The honest consequence of `*`: a pre-1.0 RC that reshapes a seam gives **no install-time
signal**. The pin plus `pnpm run test:dsh` against a matching checkout is the only thing
that catches it, which is why that gate is mandatory before a release — see
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Compatibility

Raven v1 is pinned and tested against:

- DeepSeek Harness `0.1.1-rc.2`;
- Harness checkout commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`;
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

Issues and pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the gates, the pin rules, and
the release procedure, and [SECURITY.md](./SECURITY.md) to report a vulnerability. Run `pnpm check` before opening a
PR; the release-equivalent gate is `pnpm check:release` with `DSH_CHECKOUT` pointing at a Harness checkout. Changes
are recorded in [CHANGELOG.md](./CHANGELOG.md).

If Raven saves you a rewrite, a ⭐ helps other DeepSeek Harness users find it — and browse
[`dsh-plugin`](https://github.com/topics/dsh-plugin) for the rest of the ecosystem.

## License

[MIT](LICENSE)

---

<div align="center">

[TL;DR](#tldr) · [Install](#install) · [Upgrade](#upgrade) · [Uninstall](#uninstall) · [Usage](#usage) · [How it works](#how-it-works-under-the-hood) · [Operating](#operating-raven) · [Troubleshooting](#troubleshooting) · [FAQ](#faq)

<sub><b>Keywords:</b> DeepSeek Harness plugin · dsh-plugin · Cordis plugin · AI research agent · deep research · agentic research · source grounding · citation verification · evidence-based writing · academic writing assistant · learning assistant · retrieval-augmented generation · hallucination mitigation · TypeScript · Node.js</sub>

</div>
