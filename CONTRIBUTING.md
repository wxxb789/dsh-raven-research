# Contributing

Issues and pull requests are welcome. This document covers the gates, the ownership
rules that keep them meaningful, and the release procedure — including the exact pinned-Harness compatibility gate.

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
| `pnpm run eval -- check` | Strict evaluation scenarios, assessor IDs, workflow/rubric coverage, complete suite digest, and frozen fixture SHA-256 integrity. No model call. | CI (`check`) |
| `pnpm run eval -- verify-baseline <manifest>` | Frozen suite/run/report/example/review/archive hashes, production-promotable pairs, and two independent substantive reviews per dimension. No model call. | Local/private evidence review; generated baselines are not committed |
| `pnpm run check` | Lint, typecheck, deterministic evaluation integrity, build, and tests. | CI, per Node version |
| `pnpm run test:pack` | The **published tarball**: exact file allowlist, real `prepack`, install into a clean external consumer, then import/apply/execute. Uses registry access by default; an offline workstation may provide `RAVEN_PACK_STORE_DIR`, `RAVEN_PACK_CACHE_DIR`, and `RAVEN_PACK_OFFLINE=1` for pre-populated pnpm data. | CI (`pack` job) |
| `pnpm run test:dsh` | Raven composed against a **real Harness checkout** at the pinned commit: Loader, prompt order, tool registry, PTC bridge/replay, settings, bundle patch, preset standing mount, React major, disposal. | Local; release CI (`compatibility`) |
| `pnpm run check:release` | `check` + `test:pack` + `test:dsh`. | Local before tagging |

Run `pnpm run check` before opening a PR.

### How release CI checks the Harness pin

`test:dsh` composes Raven against DeepSeek Harness **by source path**. The release workflow reads the only pin from `package.json`, checks out that exact immutable commit into an isolated path, installs its frozen workspace, and runs `test:dsh`; npm publish depends on that job. It never tests a floating branch or a vendored copy. The local gate remains required before tagging because it catches compatibility failures before the release request exists.

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

## Evaluation changes

`pnpm run eval -- check` is deterministic and belongs in every PR. It validates strict scenario and assessor schemas, exact fixture hashes, all required product workflows, and every review dimension without calling a model.

Live comparison is deliberately separate because it is paid and stochastic. `.github/workflows/evaluation.yml` runs one selected scenario manually against the exact Harness pin, stages the same absolute cwd for vanilla PTC and PTC-plus-Raven, archives raw Session/model/service evidence, and never rewrites a baseline. Use `pnpm run eval -- review` to produce opaque A/B content packets; lifecycle traces and the unblinding map remain outside that packet. Preserve every underlying artifact and categorical judgment—never replace them with a weighted quality score.

A fixture-model runner smoke proves composition, tool/prompt treatment, call ledgers, and real process resume; it is explicitly non-promotable and says nothing about output quality. A live baseline must use clean Raven and Harness checkouts, both arm orders across replicates, the same provider/model/settings/source bytes, and completed reviews under [`evaluation/rubric.md`](evaluation/rubric.md).

## The Harness pin

`package.json` carries the only copy:

```json
"dshRaven": {
  "harnessVersion": "0.1.2-alpha.1",
  "harnessCommit": "cd5ef8148158c3a752a658978873241fdf8e2bbc"
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

Generated benchmark outputs contain raw Session evidence and must remain private: do not commit or upload `evaluation/results/**` or `evaluation/baselines/production-*/`. Finalize and release the product independently of those local artifacts:

1. Finalize the release code, documentation, `package.json` version, and dated `CHANGELOG.md` entry.
2. Commit those bytes on the history that will be released.
3. Run the private evaluation suite against that exact clean commit when release evidence is required, review it locally, and keep every generated run, archive, packet, and decision outside Git history.
4. Run the full local gate against the pinned checkout: `DSH_CHECKOUT=... pnpm run check:release`.
5. Tag that same commit as `vX.Y.Z` without changing product, documentation, version, or changelog bytes. The tag must match `package.json` exactly or the release workflow refuses.
6. Push the tag. `.github/workflows/release.yml` reruns the code, package, and compatibility gates and publishes with npm provenance.

`workflow_dispatch` runs the same workflow with `dry_run` on by default: every gate
runs, nothing is published.
