# Security Policy

## Supported versions

`dsh-raven-research` is a v1 developer preview pinned to one DeepSeek Harness RC. Only
the latest released version, running against the Harness release named in
`dshRaven.harnessVersion` in `package.json`, receives security fixes. There are no
backports to earlier pins.

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/wxxb789/dsh-raven-research/security/advisories/new).
Please do not open a public issue for an unpatched vulnerability.

Include the affected version, the Harness version you run, a minimal reproduction, and
the impact you observe. An acknowledgement should arrive within 7 days and an initial
assessment within 14. If a report is accepted, the fix and its advisory are published
together.

## What is and is not in Raven's trust boundary

Raven's runtime plugin lives inside a Harness process. It runs no server, opens no port,
and owns no database, cache, Task-state file, export file, or Workspace file. The separate preset installer
writes only its documented user preset directory, and exported or Workspace-planned paths/bytes become files
only when the Harness agent or user writes them. That shapes what a vulnerability report
here can mean.

**In scope**

- **Citation integrity.** Anything that lets an Artifact present a Claim as verified
  when its excerpt does not occur in the retrieved body — a normalization that can be
  tricked, a redirect that escapes source identity, a truncated retrieval reported as a
  match. Raven's central promise is that a citation resolves to inspected bytes, so
  defeating that check is a security bug and not merely a correctness one.
- **Credential and secret leakage.** Raven rejects credential-bearing Source URLs and
  never stores provider keys. A path that records, renders, exports, or logs one is in
  scope.
- **Injection through recorded evidence.** Source titles, locators, and Claim text are
  Markdown/HTML escaped before rendering; an escape that can be broken is in scope.
- **Export or Workspace path traversal.** Both tools return page bytes and file paths for the agent to write. A
  projected path that escapes `wiki/`, accepts absolute/backslash/parent segments, or rebinds an immutable raw path
  is in scope even though Raven itself never writes it.
- **Workspace transition integrity.** A plan that silently overwrites bytes different from its inspected snapshot,
  duplicates an operation log on retry, rewrites an adopted Original Resource, or accepts unattested Markdown
  normalization is in scope. Agents still must enforce the returned preconditions before writing.
- **Denial of service through the caps.** A submission that evades per-Task state ceilings or per-Workspace-operation
  file, byte, document, and result ceilings to exhaust memory.

### Source destination filtering and residual SSRF risk

With `sourceNetworkPolicy: public-only` (explicit in the shipped Raven preset), Raven refuses local hostnames,
private/special IP literals, and DNS names for which any answer is non-public before it
calls `ctx.web.fetch`. It repeats the check for the provider's final URL. A policy refusal
is `unavailable`, never evidence that the Source or excerpt is false.

This is a pre-flight destination filter, **not an SSRF sandbox**. The current Harness web
seam exposes no dispatcher, pinned-address, or DNS-lookup hook, so the provider resolves
the hostname again when it connects. An attacker controlling authoritative DNS may change
the answer between Raven's check and that connection. Deployments that can reach sensitive
internal targets must confine the fetch provider at the network layer. `unrestricted`
removes Raven's filter and is only appropriate when that confinement already exists or the
provider intentionally serves trusted internal Sources.

**Out of scope**

- The DeepSeek Harness itself, its `web`, `llm`, `settings`, or `tools` capabilities,
  and any search or model provider. Report those to their own projects.
- Content of retrieved sources, and the truthfulness of any Claim. Raven verifies
  literal excerpt presence and URL reachability; it does not and cannot verify semantic
  entailment. A model citing a real source for a wrong conclusion is a model limitation,
  documented in the README.
- Spend incurred by drafting or verification. Route configuration is the deployment's,
  and the cost model is documented in the README.
- Anything requiring an attacker who already controls the Harness process, the settings
  file, or the session log — at that point Raven's inputs are already the attacker's.

## Supply chain

Raven ships **zero runtime dependencies**; every `@deepseek-ai/*` package is a peer
supplied by the Harness deployment, so a Raven install adds no transitive runtime tree.
Releases are published from a tag by `.github/workflows/release.yml` with npm provenance,
so the published tarball can be traced to the workflow run and commit that produced it.
Dependabot is scoped to development tooling only and cannot move the pinned Harness
packages.
