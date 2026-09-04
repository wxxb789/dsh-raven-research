# Raven evaluation suite

This suite measures Raven as a treatment on top of DeepSeek Harness rather than comparing different agents, providers, models, or source access.

## Comparison design

The primary comparison is paired:

- **Vanilla:** the exact pinned `ptc` preset with unrelated background-job, skill, goal, planning, optional delegation/workflow-provider, interactive, and task-list rows removed, so research uses the declared route allowlist and auditable evidence tools.
- **Raven:** the same constrained `ptc` bytes plus one sibling `dsh-raven-research` agent row.

The constrained-row removal is identical in both arms and its bytes are recorded as `baseCompositionSha256`; it removes optional alternate-provider delegation. If the shared Harness path still chooses a same-route subagent, the parent prompt/result and every model call remain logged and must satisfy the same provider/model allowlist. The main provider, model, reasoning effort, output cap, non-Raven tool schemas, non-Raven prompt sections, model-visible workspace bytes, source corpus, permissions, network policy, and user-turn bytes must match. Only local and llm-wiki fixtures enter that workspace; web and MCP bytes remain behind the same deterministic providers for both arms. Raven necessarily adds `raven_task`, `raven_workspace`, its prompt section, and its Task context; those are the treatment, not a fairness violation. Raven's host settings overlay is excluded, while any explicitly supplied shared Harness settings file is identical for both arms.

`draftRoutes` is empty for the primary comparison. Multi-model drafting is evaluated separately as a Raven single-model versus Raven multi-model ablation and reported as a quality/cost frontier. It is not folded into the vanilla-versus-Raven uplift claim.

Before either arm starts, the runner reads the scenario, rubric, and every referenced Source exactly once, verifies declared Source digests, and writes one run-level immutable snapshot. Both serial arms are copied only from that snapshot; `frozenInputParity` rehashes every arm copy. Each pair records execution order and replicate number. Run order is counterbalanced. Replicates expose model variability; they are not used to claim statistical significance.

## What is automated

Automated checks cover facts the runtime can establish honestly:

- schema version, unique IDs, safe paths, frozen-file SHA-256 integrity, and secret-scanned upload admission;
- paired non-treatment prompt and tool-schema parity in every process generation, identical model-visible input bytes, and exact recorded provider/model route allowlists;
- a fail-closed tool-access ledger that rejects shell/search tools or reads outside the model-visible workspace;
- terminal reason, allowed Raven Completion state for the latest Task identity, canary absence, Checkpoint count, Structure selection, stop/resume generations, and cross-Task Session identity;
- model, tool, search, fetch, PTC nested-call, and protocol-failure counts;
- provider-reported token buckets and wall-clock time when present.

When assessor observations are attached, `evaluatePairFromEvidence` additionally verifies their Artifact/citation/Source-excerpt paths, declared Source-family and contradiction records, Checkpoint chronology, and transcript hashes against preserved bytes. Annotation-only projections can never pass the release gate.

Literal excerpt presence does **not** prove entailment. A completed Task does **not** prove that the model declared every material assertion. Those properties remain explicit review questions. Missing provider usage is recorded as unavailable, never zero.

## What requires review

Intellectual quality is reviewed from blinded A/B artifacts plus the frozen sources and relevant lifecycle trace. Reviewers assess research correctness, support fidelity, source authority and independence, material coverage, contradiction handling, insight defensibility, synthesis usefulness, resistance to summary-only writing, argument structure, prose, steering retention, Checkpoint usefulness, and knowledge reuse.

The rubric is categorical and evidence-based. A review batch is create-once: every review copies a binding over the packet manifest, hidden mapping commitment, scenario, rubric, scenario-specific assessor checklist, and A/B Artifact digests. Content reviewers list every checklist fact/contradiction ID in `assessorIds`; lifecycle-only reviews use an empty list. Every non-n/a arm judgment cites exact evidence, and `sourceId` is set only for a quote copied from that Source rather than from an Artifact. Standalone reports label reviews structurally complete but evidence-unverified; schema-v2 baseline verification confirms unique exact Artifact/Source quotes and lifecycle event sequences against preserved bytes. The report does not emit a weighted total, decimal creativity score, automatic winner, confidence interval from a handful of runs, or a currency estimate without a versioned provider price snapshot. See [`rubric.md`](rubric.md).

## Evidence model

Tracked scenarios and fixtures are immutable benchmark inputs. A live run writes full evidence under `.tmp/evaluation/<run-id>/`:

```text
manifest.json
SAFE_TO_UPLOAD
reviews.jsonl                 # after review
report.json / report.md       # after reporting
<arm>/
  scenario.json / rubric.md
  input-workspace/            # frozen reviewer snapshot, all origins
  final-workspace/            # model-visible workspace after the arm
  session.jsonl / model-calls.jsonl / service-calls.jsonl
  prompt-process-*.json / tool-schemas-process-*.json
  artifact-process-*.md / raven-states-process-*.json
  checkpoints/
  raven-state.json       # Raven arm only
  service-calls.jsonl
```

A promoted schema-version 2 baseline keeps the raw archive, reports, append-only bound reviews, packet/checklist/unblinding files, representative outputs, Session/model ledgers, and a two-approver promotion decision. These generated files remain private and ignored because raw Session evidence may be large or sensitive; the repository publishes the reproducible method and inputs, not benchmark outputs or a leaderboard.

## Scenario coverage

The core suite contains eight workflows:

1. research over independent, reprinted, conflicting, self-interested, and superseded records;
2. substantial general writing from supplied local notes;
3. academic-style grounded writing over conflicting methods and limitations;
4. Task A llm-wiki growth followed by independent Task B reuse and freshness handling;
5. equivalent evidence through web, local, llm-wiki, and MCP origins;
6. an early useful Checkpoint followed by user Steering and real process restart;
7. competing argument Skeletons, user hybridization, and Steering invalidation;
8. Raven single-route versus multi-route drafting as a separate Raven-vs-Raven quality/cost ablation.

Deterministic product tests cover a transient `429`, terminal `404`, one failed search query, one failed draft route, corrupt replay input, concurrent Task mutation, and stop/resume durability. These fault checks are reported separately from stochastic output-quality pairs.

## Commands

Validate manifests, assessor IDs, required coverage, and every frozen fixture digest without a model call:

```bash
pnpm run eval -- check
```

Run one paid paired scenario through isolated `ptc` and `ptc`+Raven presets:

```powershell
$env:DSH_CHECKOUT = 'Q:\repos\deepseek-harness'
pnpm run eval -- run `
  --scenario research `
  --provider deepseek-official `
  --model deepseek-v4-flash `
  --reasoning-effort high `
  --max-tokens 8192 `
  --credentials "$HOME\.dsh\.credentials.yaml" `
  --settings "$HOME\.dsh\settings.yaml" `
  --out .tmp/evaluation/research-r1
```

For the separate Raven single-route versus multi-route ablation, use `--scenario multi-model-drafting` and repeat `--draft-route provider:model` at least twice. Those arms both run Raven with the same main model and frozen inputs; this result is never mixed into the vanilla-versus-Raven causal comparison.

The Harness checkout must match `package.json.dshRaven` exactly and be clean. A keyless `--fixture-model --allow-dirty-harness` run exists only to smoke-test the runner lifecycle; its manifest is marked dirty/fixture and can never be promoted as product evidence. Each arm gets an isolated `DSH_HOME` and output root, the same absolute staging cwd reset from identical fixture bytes, and a generated preset that differs only by Raven's sibling row. A scenario containing `after-process-restart` is resumed in a fresh Harness process from JSONL session persistence. Managed credentials and settings are read in place by both arms; secret bytes are never copied into or hashed in the evidence archive.

Prepare a deterministic content-blinded packet after a run:

```bash
pnpm run eval -- review --run .tmp/evaluation/research-r1 --seed reviewer-batch-1
```

The packet contains opaque `A.md`/`B.md`, frozen Sources, rubric, evidence hashes, and a review form. The mapping is stored in the parent `review/unblinding.json`, outside the packet reviewers receive. Unblinded Session, model-call, and service-call evidence is copied separately to `review/lifecycle/` for second-stage control/durability review after content judgments are fixed. Release review records use the strict append-only schema tested by `decodeEvaluationReview`.

Generate the factual validity/completion/usage report without assigning a winner:

```bash
pnpm run eval -- report --run .tmp/evaluation/research-r1
```

Build and verify a canonical non-extracting baseline in an ignored local directory without rerunning paid calls:

```bash
pnpm run eval -- archive --out .tmp/private-baseline/raw-archive.json --run .tmp/evaluation/research-r1 --run .tmp/evaluation/research-r2
pnpm run eval -- verify-baseline .tmp/private-baseline/manifest.json
```

Do not commit or upload generated runs, archives, review packets, decisions, or reports.

The baseline binds the current methodology/rubric/assessor/scenario/Source suite digest, exact run/report/example/review files, two independent substantive reviews per dimension, and the raw archive bytes plus HTTPS location. Production verification decodes every canonical archive member without filesystem extraction and recomputes per-generation prompt/tool treatment parity, Source/model-workspace hashes, progress, final Raven state, Session/model/service ledgers, model routes, tool access, and upload admission.

A run ID is immutable: `--out` accepts and atomically reserves only one direct `.tmp/evaluation/<safe-run-id>` child. Harness runtime homes live outside the evidence archive. The child process receives a scrubbed environment and a workspace-write sandbox; promotion additionally fails when the durable tool ledger shows a shell/search call or any read outside the model-visible workspace. Managed credentials stay outside that workspace. Local archive admission still requires `SAFE_TO_UPLOAD` from exact credential-byte and suspicious-pattern scanning; symlinks, special files, and unknown binary evidence fail closed. This marker supports deliberate private transfer but does not authorize publication.

No production or development result bundle is tracked. `evaluation/results/**` and `evaluation/baselines/production-*/**` are ignored so raw model/session evidence cannot be published accidentally.

## Release policy

Deterministic codecs, fixture integrity, fake-provider runner tests, and baseline-manifest validation belong in required CI. Live paired runs are paid and stochastic, so run and review them privately; neither CI nor release automation uploads or requires a published benchmark archive.

A failed arm remains valid benchmark evidence when the pair is methodologically comparable. Reports therefore separate:

- **validity:** whether the pair isolates Raven;
- **automated outcome:** what each arm demonstrably did;
- **human review:** categorical judgments with evidence;
- **usage disclosure:** raw measured samples and unavailable fields.
