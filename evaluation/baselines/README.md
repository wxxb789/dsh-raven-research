# Evaluation baselines

A baseline is a reviewed, immutable evidence bundle—not a generated leaderboard.

Schema-version 2 directories contain one `manifest.json` that binds the local raw archive, durable archive URL, promotion decision, per-replicate run manifests and reports, review packet/checklist/unblinding files, append-only reviews, exact A/B examples, Session event logs, and model-call logs by path and SHA-256. The raw archive is a canonical JSON container of sorted path/SHA-256/base64 members, produced with `pnpm run eval -- archive --out <file> --run <run-root> ...`; it rejects unsafe paths, duplicate members, symlinks, special files, non-canonical base64, and digest drift without extracting attacker-controlled paths.

Production promotion requires at least two counterbalanced replicates for every core scenario. The verifier recomputes frozen-input, prompt/tool, workspace, latest-Task, process-resume, Structure/knowledge, model-route, and tool/read-isolation eligibility from the preserved run and ledger bytes instead of trusting a `promotable` flag. Two independent substantive reviews cover every applicable dimension; hard Raven product failures reject promotion. A `cost-value` failure may be preserved only through an explicit resolution bound to that exact scenario pair, as must Raven concerns, negative preferences, and reviewer disagreements. Two promotion approvers must be distinct from every evidence reviewer and bind the complete evidence file set, suite digest, and raw archive SHA-256/HTTPS location.

`pnpm run eval -- check` enumerates every tracked `evaluation/baselines/**/manifest.json` and verifies it without rewriting evidence. `pnpm run eval -- verify-baseline <manifest>` performs the same check for one named bundle.

Production and development evidence bundles are intentionally not tracked or published. Keep generated archives, Session logs, review packets, and decisions under ignored local paths; share only methodology or conclusions explicitly cleared for publication. A protocol-only fixture must be labeled as such and cannot be cited as product-quality evidence.
