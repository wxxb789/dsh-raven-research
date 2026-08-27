# Contributing

Issues and pull requests are welcome. This document covers the gates, the ownership
rules that keep them meaningful, and the release procedure — in particular the one gate
that cannot run in CI.

## Setup

```bash
pnpm install --frozen-lockfile
```

Node `^22.19.0 || >=24.0.0` and pnpm `11.21.0` (the `packageManager` field pins it).

## The gates

| Command | What it proves | Where it runs |
| --- | --- | --- |
| `pnpm run lint` | Oxlint with warnings denied. | CI (`check`) |
| `pnpm run typecheck` | TypeScript 6, strict, no emit. | CI (`check`) |
| `pnpm run test` | Vitest: unit, acceptance, integration. | CI (`check`) |
| `pnpm run build` | tsdown ESM + declarations. | CI (`check`) |
| `pnpm run check` | All four of the above. | CI, per Node version |
| `pnpm run test:pack` | The **published tarball**: exact file allowlist, real `prepack`, install into a clean external consumer, then import/apply/execute. Uses registry access by default; an offline workstation may provide `RAVEN_PACK_STORE_DIR`, `RAVEN_PACK_CACHE_DIR`, and `RAVEN_PACK_OFFLINE=1` for pre-populated pnpm data. | CI (`pack` job) |
| `pnpm run test:dsh` | Raven composed against a **real Harness checkout** at the pinned commit: Loader, prompt registry, tool registry, Code Mode bridge, settings, bundle patch, browser slot contracts, disposal. | **Local only** |
| `pnpm run check:release` | `check` + `test:pack` + `test:dsh`. | **Local only** |

Run `pnpm run check` before opening a PR.

### Why `test:dsh` is not in CI

It composes Raven against the DeepSeek Harness **by source path**, at one pinned commit
of a separate repository. CI has no honest way to obtain that: vendoring the Harness
would make this repository carry a copy it cannot keep current, and cloning a floating
branch would turn a green gate into a statement about whatever landed upstream this
morning rather than about the commit Raven is pinned to. So it is a documented local
release gate, run on a machine that has the pinned checkout, and CI verifies only that
the pin is present and well-formed.

To run it:

```bash
DSH_CHECKOUT=/path/to/deepseek-harness pnpm run test:dsh
```

```powershell
$env:DSH_CHECKOUT = 'Q:\repos\deepseek-harness'
pnpm run test:dsh
```

The checkout must be at the exact version and commit named by `dshRaven` in
`package.json`, and it must be clean — a dirty tree is not the pinned commit, so a pass
would prove nothing. If it fails, the message names both values and both repairs.

## The Harness pin

`package.json` carries the only copy:

```json
"dshRaven": {
  "harnessVersion": "0.1.1-rc.2",
  "harnessCommit": "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e"
}
```

`scripts/verify-dsh.ts` reads it rather than restating it. Do not add a second copy
anywhere: the previous duplicate had already drifted, and because both copies agreed
with each other the gate reported a healthy pin against a commit nobody could check out.

Retargeting the pin is a deliberate act, and both fields move together:

1. Check out the new Harness release locally.
2. Update both `dshRaven` fields.
3. Run `pnpm run check:release` with `DSH_CHECKOUT` pointing at it.
4. Update the compatibility statements in `README.md`, `README.zh.md` (badge, requirements
   table, Compatibility section) and `docs/design/architecture.md`.
5. Record it in `CHANGELOG.md` as a breaking change, even if no Raven API moved.

### The `@deepseek-ai/*` devDependencies are a different number

They are pinned at the newest **published** Service Definition versions, which lag the
Harness release the pin targets. That gap is expected, not drift — see the README's
"Version pinning and peer dependencies" section. Dependabot is configured to ignore
`@deepseek-ai/*` precisely so it cannot move the compiled seam while leaving `dshRaven`
claiming a compatibility that no longer holds.

## Code conventions

- **Document WHY, not what.** Every non-obvious decision carries a doc comment naming the
  failure it prevents. If you change behaviour, update the rationale comment; do not
  delete existing rationale.
- **Every behaviour change needs a test that fails without the fix.**
- **Recorded decisions live in `docs/adr/`.** Several things that look like bugs are
  decisions — read `docs/design/architecture.md` and the ADRs before "fixing" one. If you
  disagree with a decision, add an ADR that supersedes it rather than quietly reversing it.
- **`src/index.ts` is the public export surface.** Adding to it is an API change.
- **No new runtime dependencies.** Raven ships zero, and that is a property of the
  package: peers fall through to the running Harness installation so every plugin shares
  one cordis instance.

## Releasing

1. Land everything on `main` and make sure CI is green.
2. Run the full local gate against the pinned checkout:
   `DSH_CHECKOUT=... pnpm run check:release`.
3. Move the `CHANGELOG.md` `[Unreleased]` entry under the new version with its date.
4. Bump `version` in `package.json`.
5. Commit, then tag `vX.Y.Z` — the tag must match `package.json` exactly or the release
   workflow refuses.
6. Push the tag. `.github/workflows/release.yml` reruns the full gate and publishes with
   npm provenance.

`workflow_dispatch` runs the same workflow with `dry_run` on by default: every gate
runs, nothing is published.
