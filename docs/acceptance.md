# Raven v1 Acceptance Evidence

## Test surfaces

The requested public contract fixes three test seams:

1. **Cordis load seam** — named exports, prompt/tool registration, real Loader
   unwrapping, execution through `ctx.tools`, and disposal.
2. **Raven Task interface** — one Task across Outcomes, Checkpoints, Steering
   Revisions, stop/resume, replay, and Completion.
3. **SourceVerifier seam** — deterministic and Harness-web observations feeding the
   same source/claim/completion policy.

Tests assert canonical state and dispositions rather than model prose or one internal
agent topology.

## Completion criteria matrix

| Criterion | Evidence |
|---|---|
| Clean install, load, and run against intended Harness | `pnpm test:pack` creates an external staging project with no `lib/`, links only the pinned toolchain, exercises real `prepack` without mutating the repository build, enforces the exact tarball allowlist, and installs it with an isolated pnpm home/store in a second external consumer before import/apply/execute; `pnpm test:dsh` requires the exact clean Harness commit, loads a real `cordis.yml` through Loader + Include, executes start/checkpoint/complete through the real tool registry and `ctx.web` seam, and removes the composition to verify disposal. |
| Build, lint, typecheck, and tests pass | `pnpm check` runs Oxlint with warnings denied, strict TypeScript, 37 Vitest tests, and tsdown ESM/declaration build. |
| Evidence-backed Keep / Change / Drop assessment | `docs/reverse-engineering/assessment.md` synthesizes the detailed Hermes profile, nana-research, and Harness reports and maps preserved mechanisms to source files and line ranges. |
| Four first-class Outcomes | `tests/acceptance/raven.acceptance.test.ts` has end-to-end scenarios for `research`, `general-writing`, `academic-writing`, and `learning` through the same tool and Task state. |
| Progressive research and mid-run correction | The first acceptance scenario verifies one initial Source and publishes an active early Artifact before the second Source, broader collection, and final Completion verification; it then continues research, applies `steer`, emits a revised Checkpoint, and completes with the original Task ID. |
| No mandatory normal-stage confirmation | At the executable Raven interface, the acceptance suite verifies there is no `confirm` or `approve` action and the real DSH composition advances start/checkpoint/complete without an approval call; the prompt explicitly forbids approval requests between normal stages. |
| No fabricated citations or broken references | Unit/acceptance tests require registered Source IDs for material external Claims, mechanically render Source URLs plus a Claim↔Source trace, reject unknown raw URLs and cross-host resolved identities, and refuse grounded Checkpoints or Completion when a URL is broken or its recorded excerpt is absent. A loopback integration test retrieves real HTTP bytes, rejects invented support, accepts a matching HTML-normalized excerpt, and completes only the exact checkpointed Artifact. |
| Partial failures degrade gracefully | The engine first observes a real verifier failure for one dependent Source, automatically defers Claims that lose all usable support, and records a Limitation; a revised Checkpoint preserves the independently verified Claim and can complete as `completed-with-limits`. A separate test ensures zero valid grounded work remains active rather than being mislabeled graceful Completion. |

## Vitest inventory

- `tests/unit/engine.test.ts`
  - strict action/nested-record unknown-field rejection;
  - Task start/status and default grounding;
  - immutable Source identity and evidence anchors;
  - Source/Claim capture, bounded state, escaped Markdown rendering, and generated Claim trace;
  - same-Task Steering Revision;
  - verified excerpts before grounded Checkpoint publication;
  - exact final Artifact equality with the latest Checkpoint;
  - strict verifier response identity/protocol validation;
  - cancellation of a never-settling verifier at the engine seam;
  - zero-valid-work Completion rejection;
  - automatic Claim deferral after dependency failure;
  - dependency-aware partial failure;
  - stop/resume preservation.
- `tests/unit/codec.test.ts`
  - complete JSON round-trip;
  - unknown-version and unknown-field rejection;
  - malformed nested-record rejection.
- `tests/unit/process.test.ts`
  - bounded child-process deadline;
  - cancellation reason preservation while the process tree settles.
- `tests/integration/plugin.test.ts`
  - named Cordis exports, bounded schema annotations, and one prompt/tool/listener registration;
  - compact Task reconstruction from durable `tool/result.meta` after plugin reload;
  - preservation and replay of multiple historical Task identities in one Session.
- `tests/integration/source-provenance.test.ts`
  - real loopback HTTP retrieval;
  - invented excerpt rejection before publication;
  - HTML/entity-normalized verbatim excerpt matching and exact Completion;
  - cancellation of a provider Promise that ignores `AbortSignal`.
- `tests/acceptance/raven.acceptance.test.ts`
  - progressive Research with later evidence and steering;
  - General Writing;
  - Academic Writing;
  - Learning;
  - fabricated/unregistered URL rejection;
  - known-broken cited Source rejection;
  - absence of normal-stage confirmation actions.

## Release gate

```powershell
$env:DSH_CHECKOUT = 'Q:\repos\deepseek-harness'
pnpm check:release
```

This command runs the repository gate, the packed clean-consumer install, and the
real Harness compatibility smoke test.
