---
status: accepted
---

# Keep one Raven Task behind one model tool

Raven v1 exposes one continuing Raven Task through one host-only `raven_task` tool and a compact prompt section; it does not publish a `ctx.raven` service, split Outcomes into tools, or add storage, scheduling, or client packages. Explicit tool actions atomically record Checkpoints, Sources, Claims, Steering Revisions, and completion candidates because the existing Harness agent performs the actual research and writing between calls. Required Harness registries are used directly, while source reopening is the only Raven-owned internal Seam because production web checks and deterministic test checks are two real Adapters. This trades a moderately rich action union for high Depth and Locality while preserving the user's single-task contract, progressive visibility, same-session replay, and lean deployment. The later `raven_workspace` tool does not split this Task interface: it owns the separate lifecycle of a user-owned llm-wiki and only reads a completed Task contribution without mutating Task state.
