# Hermes Research Skills Gap-Closing Audit

## Scope and method

This is a read-only audit of every directory and file under
`C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research` against Raven's
implemented v1 contract. I first read `docs/reverse-engineering/assessment.md:1-362`
and `docs/design/architecture.md:1-331`. The tree contains 18 immediate skill
directories and 258 recursive files; every directory has a top-level `SKILL.md`.
The category description itself covers academic research, discovery, literature
review, reconnaissance, market data, monitoring, and scientific retrieval
(`C:/Users/lhan/AppData/Local/hermes/profiles/nana/skills/research/DESCRIPTION.md:1-3`).

The verdicts below evaluate mechanisms for Raven, not whether a Hermes skill should
remain installed. **Keep** means preserve the mechanism, **Change** means preserve
its principle through Raven's one Task/Source/Claim/Checkpoint model, and **Drop**
means do not add it to Raven core. “Specified” means the file gives a procedure or
code path; it does not prove the external service currently works.

## Activation status

Disk presence is not runtime activation. The profile's skill settings and disabled
list are at `C:/Users/lhan/AppData/Local/hermes/profiles/nana/config.yaml:447-506`.
`llm-wiki` is explicitly disabled at line 482 and `polymarket` at line 493. The
other 16 names are not disabled, which establishes only static eligibility, not
successful runtime discovery or loading. The separate plugin list only enables
`camofox-lifecycle` (`config.yaml:685-687`) and is not proof that skills are active.

## Highest-value gaps in Raven

1. **Archived-copy lineage and freshness ceilings are missing.** Raven should be
   able to distinguish the requested original URL from the inspected archive URL,
   record snapshot time, and prevent an old snapshot from being the sole support
   for a freshness-sensitive claim. `blocked-page-recovery/SKILL.md:40-51` specifies
   this discipline; Raven currently has only URL plus optional `as-of` metadata
   (`docs/design/architecture.md:129-142`).
2. **Academic-writing mode needs a compact, risk-adaptive quality profile.** Adopt
   claim→experiment mapping, explicit limitations, citation existence plus
   entailment checks, statistical/human-evaluation reporting where applicable, and
   exact final compilation checks. Do not port the 2,377-line phase manual.
3. **Search-lead promotion should be stated more explicitly.** Search results,
   snippets, citation graphs, market feeds, and social posts are discovery leads;
   only inspected original content becomes a Raven Source. This is already implied
   by `architecture.md:138-150` but deserves concise prompt language.
4. **Version identity for mutable scholarly sources should be first-class.** arXiv
   latest URLs drift; preserve the exact version read
   (`arxiv/SKILL.md:270-282`). Raven's immutable Source rule helps, but canonical URL
   handling should not silently erase `vN`.
5. **Retrieval should have a provider-agnostic escalation policy.** Cheap/static
   first, then dynamic/browser only when needed; bounded fallback, cancellation,
   and explicit failure. Keep this as agent guidance and Harness capability use,
   not a browser stack inside Raven.

## Contract conflicts to reject

- Public phases, launch/readiness gates, fixed “round” lifecycles, and routine
  approvals contradict one Raven Task with observational stages and no normal stage
  gates (`assessment.md:179-194,262-277`; `architecture.md:96-111`).
- JSONL registers, wiki databases, cron state, source caches, worker packets,
  worktree receipts, and migration forests contradict Raven's lean core and official
  `tool/result.meta` replay (`assessment.md:145-159,196-206,293-305`).
- Mandatory multi-agent or universal independent review contradicts Raven's
  risk-adaptive verification (`assessment.md:208-222`).
- Fixed provider ladders, local daemons, personal paths, cookies, and CLIs cannot be
  Raven dependencies; Raven must use existing Harness tools and the optional web
  verifier seam (`architecture.md:228-275`).

---

## Prioritized skills

### `research-paper-writing` — **Change**

**Purpose.** A comprehensive ML/AI paper-production manual spanning project setup,
literature review, experiment design/execution, analysis, drafting, self-review,
submission, and post-acceptance deliverables
(`research-paper-writing/SKILL.md:19-60,92-233,356-778,1535-2025`). The complete
`SKILL.md` is 2,377 lines; this audit covers it in full, not only the earlier first
280 lines.

**Concrete mechanisms.** It explicitly says “draft first, ask with the draft,” with
only targeted blocking questions for major ambiguity
(`SKILL.md:62-88`). It maps every experiment to a paper claim
(`:356-370`), saves incremental results and keeps an experiment journal
(`:390-429,470-559`), requires statistical analysis and honest negative/null result
handling (`:559-707`), and uses a two-pass drafting/refinement process with
limitations required (`:778-910,930-1048`). It performs simulated review, visual
review, and a claim-verification pass that traces factual claims to specific results
(`:1535-1657`), followed by deterministic citation/figure/label checks and exact
compilation (`:1695-1915`). Its Hermes integration prescribes parallel section
workers, `todo`, `memory`, and cron monitoring (`:2117-2299`).

The references deepen those mechanisms: citation search→existence→BibTeX→claim
validation→bibliography (`references/citation-workflow.md:71-214`); experiment,
human-evaluation, statistics, recovery, and visualization patterns
(`references/experiment-patterns.md:7-121,121-499,558-720` and
`references/human-evaluation.md:22-465`); venue checklists
(`references/checklists.md:19-422`); paper-type-specific structures
(`references/paper-types.md:17-end`); reviewer criteria
(`references/reviewer-guidelines.md:1-end`); and writing guidance
(`references/writing-guide.md:1-end`). `references/autoreason-methodology.md:58-198`
specifies a multi-role iterative loop and Borda scoring, while `:198-382` presents
model/task-selection and paper-refinement recommendations. The “multi-backbone” note
records a project-specific delegation pattern and claimed historical performance
(`references/multi-backbone-article-production-2026-06-17.md:5-36`). Venue templates
under `templates/` are real LaTeX/BibTeX/style assets for AAAI, ACL, COLM, ICLR,
ICML, and NeurIPS; they prove bundled formatting material exists, not that policies
remain current or that the PDFs compile in this host.

**Keep.** Draft-first checkpoints; claim→experiment edges; failed/negative-result
preservation; explicit limitations; exact citation existence and semantic support;
final-byte/compile checks; risk-triggered human-evaluation, ethics, reproducibility,
and statistical reporting.

**Change.** Express these as an `academic-writing` outcome profile on the same Raven
Task. Use checkpoints rather than eight public phases. Select only checks relevant
to the actual venue/study. Keep review optional/risk-adaptive rather than always
running an ensemble.

**Drop.** Mandatory repo initialization, commit-per-batch, cron monitoring, todo/memory
protocols, section-worker topology, fixed time percentages, and Autoreason/Borda as
core behavior. These are orchestration choices, not evidence invariants.

**Raven lacks / should adopt.** A compact academic closeout checklist keyed to the
artifact type: claim-result trace, statistical reporting, human-subjects/IRB and LLM
disclosures when applicable, venue-required sections, and compilation/reference
integrity. Raven already has Source/Claim traceability but not experiment-result
records; initially represent these in Claims and artifact text rather than adding a
new database.

**Contradictions.** The long fixed phase pipeline and `todo` update after every phase
(`SKILL.md:2142-2148,2196-2229`) would turn observational stages into gates and
inflate the lean prompt. Universal parallel drafting/review (`:2121-2175`) would
expose internal topology and add avoidable latency.

**Host/environment-specific.** Hermes tool names (`web_extract`, `delegate_task`,
`cronjob`, `memory`, `todo`), shell/LaTeX installations, venue template vintages,
external APIs and rate limits, and git conventions are not portable. Statements
such as “~40% error rate” (`:64-68`), empirical Autoreason wins, and template policy
currency are claims in prose; bundled files do not validate them.

### `chinese-military-academic-writing` — **Change**

**Purpose.** Generate, expand, trim, condense, and rewrite Chinese military-academic
articles using three learned style families, skeletons, strict character targets,
and batch production (`chinese-military-academic-writing/SKILL.md:8-58,137-224,263-418`).

**Concrete mechanisms.** It distinguishes Chinese-character count from total
character count and supplies mechanical counters (`SKILL.md:10-20,110-136,251-262,
340-390`); separates style selection, skeleton design, worker dispatch, and final
verification (`:224-262`); provides explicit expansion/trimming/condensation
procedures (`:263-418`); and names deterministic output conventions and style maps
(`:496-525`). Style references specify structural, lexical, transition, citation,
and data-specificity rules (`references/style-a-quick-ref.md:3-96`,
`style-b-quick-ref.md:3-106`, `style-c-quick-ref.md:5-63`). The concise-thesis and
exact-review notes add evidence boundary, research-to-writing sequence,
sentence-level traceability, and versioned repair
(`references/concise-thesis-reference-cap-and-chinese-standpoint.md:5-48`;
`references/exact-final-review-concise-thesis.md:5-39`). The proposal packet note
adds function-matrix, source compression, isolated outputs, exact length QA, and a
background delegation pitfall (`references/short-proposal-packet-workflow.md:5-74`).
The US-defense reference is a manually curated factual sheet with dates and common
errors (`references/us-defense-programs-verification.md:5-175`), not a live verifier.

**Keep.** Exact length-unit definition; deterministic character counting; evidence
boundary before stylistic transformation; sentence-level traceability; preserve
facts while trimming; exact post-repair review.

**Change.** Treat style/skeleton as artifact constraints captured in the request and
steering revisions, never as a separate workflow. Use source-backed claims instead
of trusting reusable factual notes. Make “Chinese standpoint” an explicit user
editorial requirement, not an epistemic license to suppress contrary evidence.

**Drop.** Fixed lexical quotas, rigid skeleton pairings, mass-generation fan-out,
project path conventions, and claimed “validated performance” numbers. They are
local production heuristics, not Raven invariants.

**Raven lacks / should adopt.** A typed or prompt-level length metric (`characters`,
`Chinese Han characters`, words) and deterministic artifact-length receipt would
improve general and academic writing without new state objects.

**Contradictions.** N×M dispatch architecture (`SKILL.md:224-251`) creates many public
artifacts/workers rather than one continuing task; style quotas can reward surface
imitation over evidence traceability.

**Host/environment-specific.** Local project paths, source-paper-derived styles,
Python counting commands, historical dated performance notes, and the curated 2026
US program sheet are non-portable and can become stale. “Validated” labels in
`skeleton4-industrial-ecosystem-notes.md:9-73` and `SKILL.md:383-410` are historical
claims without tests in this skill.

### `blocked-page-recovery` — **Change**

**Purpose/mechanisms.** A bounded retrieval-recovery ladder for blocked pages:
Wayback, archive.today, Jina, same-host API/RSS/JSON, then browser
(`blocked-page-recovery/SKILL.md:14-38`). It distinguishes live copies from dated
snapshots (`:40-51`), warns that HTTP 200/large bodies may be interstitials
(`:75-130`), and forbids unverifiable generic proxies and credential forwarding
(`:132-137`). The Python script implements only Wayback/archive.today/Jina
(`scripts/recover_page.py:113-184`), bounded 429 retries (`:57-75`), and
size/title/redirect heuristics (`:37-54,95-110`).

**Keep.** Snapshot provenance/date, freshness ceiling, fake-success rejection,
bounded fallback, and explicit failure.

**Change.** Add minimal optional Source lineage (`originalUrl`, `retrievalKind`,
`capturedAt`) and keep exact excerpt matching as the real acceptance test. Network
access remains provider-owned and cancellable.

**Drop.** The fixed downloader/provider list and API guessing. The script blocks on
`urllib`/`sleep`, lacks Raven cancellation and security policies, and cannot prove
semantic identity.

**Raven lacks.** Original→archive lineage and a mechanical rule that snapshots alone
cannot establish current price/availability/breaking-news claims.

**Contradictions/portability.** Direct network code bypasses Raven's Harness adapter.
The docs describe five routes but code automates three (`recover_page.py:184,209-214`);
archive.today returns no extracted snapshot date (`:156-160`); “validates every body”
means only heuristics, not target-content proof. `python3`, provider domains,
`JINA_API_KEY`, and service behavior are environmental.

### `multi-backend-research-routing` — **Keep principles / Change representation**

**Purpose/mechanisms.** Routes semantic discovery, X discovery, and original
inspection while keeping discovery below the evidence ceiling
(`multi-backend-research-routing/SKILL.md:15-61`). It reconciles backend caps
(`:63-74`), classifies route changes as none/bounded/material and preserves
non-retroactive execution history (`:76-97`), and separates external callable
capability from repository/private runtime objects
(`references/external-search-capability-boundary.md:5-46`). Its GHC-X note records a
specific local engine/model/CLI contract and instructs re-reading the live skill
(`references/ghc-x-search-integration.md:7-40`).

**Keep.** Search≠evidence, user-named backend precedence, honest cap accounting,
source-family independence, correction without rewriting history, and external
capability≠research object.

**Change.** Put user correction in Raven Steering Revision, consequential retrieval
failure in Limitations, and leave invocation details in the Harness transcript.

**Drop.** Nana iteration IDs, JSONL append/hash receipts, worktree handoffs, materials
indexes, frozen review populations, and universal fresh review
(`SKILL.md:95-134`).

**Raven lacks.** Concise explicit search-lead→inspected-Source promotion language.
Backend compliance remains transcript/main-agent responsibility rather than a new
Raven schema.

**Contradictions/portability.** Durable worker/register governance conflicts with the
hidden internal topology and lean core. GHC-X absolute paths, `grok-4.5`, CLI flags,
and reported passing tests are environment snapshots, not stable capability proof.
No bundled routing implementation enforces the prose.

### `arxiv` — **Keep / Change**

**Purpose/mechanisms.** arXiv Atom discovery by field/query, sorting/pagination,
metadata/BibTeX extraction, reading abstract/PDF, and optional Semantic Scholar
citation/recommendation traversal (`arxiv/SKILL.md:14-188,192-252`). The bundled
stdlib script implements query construction, XML parsing, and CLI output
(`arxiv/scripts/search_arxiv.py:1-114`). The skill explicitly preserves exact arXiv
version suffixes and checks withdrawal notices (`SKILL.md:270-282`).

**Keep.** Exact-version identity, withdrawn/retracted status checks, structured
metadata, and discovery→full-paper inspection.

**Change.** Treat API/citation-graph output as leads and register the exact inspected
abstract/PDF version as Source. Never equate citation count with evidentiary quality.

**Drop.** Bundling arXiv/Semantic Scholar clients into Raven. Existing Harness web
and research tools own retrieval.

**Raven lacks.** Explicit protection against canonicalization stripping `vN` and a
source-status field for withdrawn/retracted works.

**Portability/claims.** `curl`, Python, API endpoints, no-key claims, maximum results,
and rate limits (`:254-260`) can drift. The code proves request parsing, not current
network availability or API policy.

### `nana-research-wiki` — **Drop system / Keep selected lessons**

**Purpose.** A 93-file, 8k+-line operational knowledge base of Nana research
incidents, plan/round governance, extraction, lint, monitoring, breadth/deep-dive,
and acceptance workflows. `SKILL.md` routes work into those references; it is a
historical methodology index rather than one portable executable feature.

**Concrete mechanisms.** Notable reusable references include extraction fidelity
and deterministic validators (`scripts/pdf_md_noise_filter.py:1-end`,
`pymupdf_text_extract.py:1-end`, `verify_extraction_fidelity.py:1-end`), binary/PDF
normalization (`references/binary-to-md-normalization-2026-06-08.md:1-end`),
late asynchronous result triage (`references/late-async-result-triage.md:1-end`),
source-status accounting, same-source identity, claim narrowing, partial delivery,
and exact final artifact review across the dated case studies. Conversely, many
references encode R-round/NRS launch, frozen envelopes, immutable packet reviews,
JSONL closure, controller recovery, route/accounting, and migration chains (for
example `references/plan-lifecycle-schema-2026-06-08.md:1-end`,
`deterministic-prelaunch-readiness-transactions.md:1-end`, and
`task-gate-authority-transition-and-jsonl-closure.md:1-end`).

**Keep.** Exact extracted-byte fidelity; distinguish binary conversion success from
semantic extraction quality; preserve late results without silently changing an
accepted artifact; final-byte re-verification; repair claim/source identity instead
of relabeling it.

**Change.** Translate these into Source verification observations, Limitations,
Steering Revisions, and exact Checkpoint hashes. Use risk-adaptive checks, not every
historical review lens.

**Drop.** The wiki, R-round/NRS lifecycle, readiness/launch transactions, packet
forests, central manifests, migration compatibility, commit governance, and
mandatory reviewers.

**Raven lacks.** A clearer content-type/extraction-fidelity observation for PDF and
binary Sources; current exact excerpt matching catches many failures but does not
state whether extraction was structurally trustworthy.

**Contradictions/portability.** Most dated notes bind to `Q:/repos/nana-research`, its
plans, worktrees, artifacts, validators, monitors, and authority rules. They directly
contradict one Task/no stage gates/lean core. Titles such as “verified,” “final,” or
“proven” document a historical procedure; they do not independently prove current
correctness.

### `agent-reach` — **Change**

**Purpose/mechanisms.** A broad platform router covering web/search, social, video,
developer, and career sources via OpenCLI/platform CLIs/APIs. The bilingual top-level
contracts route by platform (`agent-reach/SKILL.md:1-end`, `SKILL_en.md:1-end`), while
`references/search.md`, `web.md`, `social.md`, `video.md`, `dev.md`, and `career.md`
provide commands and fallback paths.

**Keep.** Platform-aware routing, cheapest capable backend first, fallback on
capability failure, and preserving platform-native identifiers/URLs.

**Change.** Make it optional Harness retrieval guidance; every returned item remains
a lead until original inspection and Source registration. Record only failures that
affect claim coverage.

**Drop.** Platform client installation, authentication/session setup, and command
catalog from Raven core.

**Raven lacks.** No new domain object is needed; strengthen prompt guidance that
social/search metadata has a lower evidence ceiling and must retain author/date/post
identity.

**Contradictions/portability.** OpenCLI, platform-specific binaries, local services,
cookies, credentials, geographic availability, and command schemas are host-specific.
The skill specifies how to call them but does not prove installation, login, current
API compatibility, or factual correctness of results.

### `x-browser` — **Drop stack / Keep escalation policy**

**Purpose/mechanisms.** A four-layer browser router: static fetch, Hermes browser,
Chrome relay, Camofox, and PinchTab, selected by site defense and interaction depth
(`x-browser/SKILL.md:11-59`). It defines escalation signals (`:61-89`), Chrome relay
safety (`:91-165`), Camofox health/lifecycle (`:167-196`), PinchTab sessions and
resource governance (`:198-252`), and anti-patterns (`:284-292`). References contain
service setup, escalation, stealth recipes, binary sink, and cleanup SOPs.

**Keep.** Static-first escalation; do not treat challenge/paywall HTML as content;
close/cancel resources; isolate authenticated and anonymous sessions; set deadlines
for human handoff/recording.

**Change.** Raven should merely use available Harness tools and record resulting
Source/failure observations. Browser choice stays outside Task state.

**Drop.** Camofox/PinchTab/Chrome relay/watchdog/service supervision, stealth recipes,
and binary sink from Raven.

**Raven lacks.** Provider-agnostic retrieval escalation language and content-type /
magic-byte rejection can improve Source verification, but not as browser ownership.

**Contradictions/portability.** The stack assumes Hermes tools, git-bash, `uv`, local
ports 9222/9377, environment variables, user cookies, global CLIs, cron, systemd /
launchd/NSSM, and even `Q:/repos/nana-research` (`:188-196`). Claims that all layers
work cross-platform (`:23,258-269`), memory sizes, watchdog behavior, and Playwright
incompatibility are environment/version assertions, not validated by this skill.

### `x-tweet-fetcher` — **Drop package / Keep provenance lessons**

**Purpose/mechanisms.** A large script suite for fetching X posts/profiles/mentions,
Nitter/Camofox fallback, discovery, growth tracking, China-platform fetches, arXiv
author lookup, recommendations, and Obsidian export (`x-tweet-fetcher/SKILL.md:1-end`,
`README.md:1-end`; 18 Python scripts under `scripts/`). `fetch_tweet.py`,
`nitter_client.py`, and `camofox_client.py` implement provider fallbacks;
`common.py`/`config.py` centralize shared behavior; other scripts add profile and
downstream workflows.

**Keep.** Preserve post ID, author handle, timestamp, canonical URL, quoted/replied
context, and retrieval route; distinguish deleted/unavailable from “no post”; social
posts are attributed statements, not independent proof.

**Change.** Use whatever Harness platform tool exists, then register only inspected
post content as a Source with an explicit social/self-report role. Corroborate
material claims independently.

**Drop.** The Nitter instance list, scraping clients, personal growth system, Obsidian
writers, recommendation pipeline, China fetcher, configuration/version updater, and
all local browser coupling.

**Raven lacks.** A compact social-source role/evidence-ceiling convention and durable
post identity are useful; no X-specific task mode is warranted.

**Contradictions/portability.** Local Camofox, Nitter availability, cookies, proxies,
filesystem/vault paths, Python dependencies, platform HTML, and China network
conditions are volatile. README/changelog success claims and version labels prove
intent/history, not current end-to-end operation.

---

## Remaining requested skills

### `competitor-news-monitor` — **Change**

**Purpose/mechanisms.** A recurring company-news monitor with frozen watchlist,
source hierarchy, incremental cutoff with overlap, event-level deduplication,
materiality/confidence scoring, and silent delivery when nothing material changed
(`competitor-news-monitor/SKILL.md:14-72`). It correctly says a source failure is
unknown coverage, not “no news” (`:58-60,74-88`).

**Keep.** Event-level deduplication; primary-source hierarchy; facts vs interpretation;
job postings/anonymous reports as weak signals; failed coverage never becomes a
negative finding.

**Change.** These are excellent research-task semantics for a user-triggered digest,
but recurring monitoring needs a separately justified scheduler/storage consumer.
Raven can complete one digest Task and expose limitations.

**Drop.** `~/.hermes/competitor-watches`, cron creation, silent recurring ticks, and
mutable cutoffs from Raven core (`:45-54`). They conflict with no custom storage or
scheduler.

**Specified vs claimed.** The file is procedural only; there is no script enforcing
watchlist freeze, pagination, dedupe, score consistency, or cutoff transactions.

### `blogwatcher` — **Drop dependency / Keep feed-first idea**

**Purpose/mechanisms.** Documents `blogwatcher-cli` installation, persistent SQLite,
feed discovery, HTML-selector fallback, OPML import, scanning, and unread state
(`blogwatcher/SKILL.md:16-89,130-137`).

**Keep.** Prefer RSS/Atom for incremental discovery and retain canonical article URL,
published date, and feed identity.

**Change.** Feeds produce leads; inspect article content before Source acceptance.

**Drop.** CLI, SQLite database, unread state, Docker volumes, migration, and install
instructions. Monitoring is outside Raven v1.

**Portability/claims.** The prerequisite binary, PATH, Docker/Go, home-directory DB,
and selectors are host-specific. Example output and feature notes are documentation,
not proof the executable is installed or current.

### `polymarket` — **Drop domain client / Keep uncertainty caveat**

**Purpose/mechanisms.** Read-only Gamma/CLOB/Data API lookup for markets, prices,
books, trades, and history (`polymarket/SKILL.md:10-49`), including double-encoded
field parsing (`:59-63`). `references/api-endpoints.md:1-end` catalogs endpoints;
`scripts/polymarket.py:1-end` implements a CLI client.

**Keep.** Timestamp/as-of, market question and resolution criteria, volume/liquidity,
and raw outcome prices should accompany any interpretation.

**Change.** The claim “prices ARE probabilities” (`SKILL.md:25-33`) must become
“market-implied prices/odds,” not calibrated objective probability. Treat market data
as a source with uncertainty and manipulation/liquidity caveats.

**Drop.** Domain API client and monitoring from Raven. The profile explicitly disables
this skill (`config.yaml:493`).

**Portability/claims.** Endpoints, schemas, rate limits (`SKILL.md:65-70`), no-auth and
global-access statements (`:72-77`) can change; code proves parsing paths, not service
availability or calibration.

### `llm-wiki` — **Drop system / Keep corpus lessons**

**Purpose/mechanisms.** A persistent three-layer raw/source/synthesis wiki with schema,
frontmatter, taxonomy, confidence/contested fields, provenance markers, cross-links,
index/log, ingest/query/lint/archive operations (`llm-wiki/SKILL.md:15-255`). It
specifies orientation before mutation (`:72-96`), source-to-claim markers and
confidence (`:109-151,255-302`), deterministic lint for >100 pages
(`:318-387`), batch ingest (`:407-430`), and contradiction preservation
(`:511-570`). References cover six-phase folder ingest, stub materialization,
mechanical lint/health/log rotation, and a multi-wave R-round pipeline
(`references/folder-dump-batch-ingest.md:9-84`;
`stub-materialization-pass.md:1-end`; `mechanical-lint-tooling.md:1-190`;
`r-round-wave-pipeline.md:13-366`). Template scripts under `scripts/` are actual
starting code, not installed validators.

**Keep.** Never silently skip batch inputs; preserve source provenance and contested
claims; deterministic lint beats rereading a large corpus with an LLM; exclude
reports from their own scan; schema should adapt to repeated reality rather than
bulk-mutating evidence.

**Change.** Apply only to explicitly requested corpus-building products. Raven v1 can
record compact Sources/Claims/Artifact but must not become a reusable wiki.

**Drop.** Raw vault, taxonomy, wikilinks, index/log, stubs, tiers, cron health,
Obsidian/systemd, R-round waves/gates, and promotion machinery. The profile explicitly
disables this skill (`config.yaml:482`).

**Raven lacks.** For one Task, the useful gap is a visible accounting of skipped or
unreadable supplied inputs; use Failures/Limitations, not a wiki schema.

**Contradictions/portability.** Persistent corpus and stage/promotion gates violate
lean core and no stage gates. `~/.hermes`, `.harness` scripts, Obsidian, Node 22,
systemd, cron, and repository-specific R-rounds are environment-bound. Thresholds
such as “>100 pages” and context-cost claims (`SKILL.md:318-335`) are heuristics, not
benchmarked guarantees here.

---

## Previously audited skills: completeness disposition

The earlier audit already covered these five skills. They were nevertheless included
in the exhaustive file inventory; their prior conclusions remain consistent with
Raven and no contradictory new mechanism was found while closing this gap.

| Skill | Files reviewed in tree | Raven verdict | Evidence / rationale |
|---|---:|---|---|
| `deep-research-crew` | 1 | Change | Parallel discovery and main-agent synthesis are useful, but batch phases become progressive checkpoints (`deep-research-crew/SKILL.md:27-81,99-117`; `assessment.md:163-177`). |
| `grounded-citations` | 5 | Keep core / Change schema | Stable IDs, retrieval-time registration, mechanical rendering, and unknown-ID rejection directly underpin Raven Sources/Claims (`grounded-citations/SKILL.md:15-25,69-70,87-127`; scripts and citation references provide the Hermes-specific implementation). |
| `cross-source-fact-check` | 5 | Keep principles / Change | Independent source-family corroboration, contradiction handling, and ledger salvage matter; curl/CRS fallback and persisted-ledger repair remain tool/repo procedures (`cross-source-fact-check/SKILL.md:1-end`; all four references). |
| `nana-research-monitor` | 1 | Drop monitor / Keep failure semantics | Coverage failures must not become “no change,” but recurring cron/state/receipt machinery is outside Raven (`nana-research-monitor/SKILL.md:1-260`). |
| `r-round-plan-lifecycle` | 26 | Drop lifecycle / Keep exact verification lessons | Launch phrases, frozen plans, shard verdicts, receipts, and round gates contradict Raven; exact final-byte verification and partial-result honesty are retained (`r-round-plan-lifecycle/SKILL.md:1-end` and all 25 references; `assessment.md:179-194,262-291`). |

## Cross-skill mechanism matrix

| Mechanism | Raven disposition | Why |
|---|---|---|
| Draft first; expose useful artifact early | **Keep** | Already central to Checkpoints; strongest writing UX lesson. |
| Search result/snippet/citation graph as lead only | **Keep; clarify prompt** | Prevents evidence inflation. |
| Claim→source and claim→experiment trace | **Keep; extend academically** | Source trace exists; experiment trace can initially remain in Claim/artifact. |
| Snapshot original/copy/date/freshness | **Adopt (missing)** | Current Source metadata does not cleanly represent archive lineage. |
| Exact arXiv version / withdrawn status | **Adopt (missing/underspecified)** | Avoids citation drift and invalid evidence. |
| Exact length metric and receipt | **Adopt for writing** | Cheap deterministic quality check. |
| PDF/binary extraction fidelity | **Adopt as verifier observation** | Avoids treating conversion success as readable evidence. |
| Social/market/self-report evidence ceiling | **Adopt as concise role guidance** | Prevents attributed claims becoming independent proof. |
| Backend/browser escalation | **Keep as agent guidance** | Useful, but internal topology must not enter Task state. |
| Bounded retry and partial results | **Keep** | Already implemented by Failures/Limitations/completed-with-limits. |
| Event-level deduplication and failed coverage ≠ none | **Keep for monitoring-style research** | Generalizable reasoning even without scheduler. |
| Fixed phases, rounds, launch/readiness gates | **Drop** | Contradicts one Task/no stage gates. |
| Universal ensembles/fresh reviewers | **Drop default** | Use risk-adaptive verification only. |
| Wiki/SQLite/JSONL/cron/custom cache | **Drop** | Contradicts lean core and Harness reuse. |
| Camofox/PinchTab/Nitter/OpenCLI/provider clients | **Drop as dependencies** | Host-specific and volatile; consume available Harness capabilities instead. |
| Worktree/commit/packet/receipt governance | **Drop** | Repository operations, not Raven evidence semantics. |

## Recommended Raven actions

1. **Add archive provenance without adding a recovery subsystem.** Extend Source only
   when a real consumer is ready: `originalUrl?`, `retrievalKind?`, `capturedAt?`;
   require explicit limitation when original retrieval failed and disallow stale-only
   support for freshness-sensitive claims.
2. **Tighten the compact prompt.** State that search/social/API summaries are leads,
   original inspection is required, user steering does not rewrite prior tool history,
   and failed coverage is unknown rather than negative evidence.
3. **Add academic-writing closeout guidance.** Risk-adapt claim-result trace,
   limitations, citation entailment, statistics/human-evaluation/ethics, venue checks,
   and exact compilation. Keep it concise and artifact-driven.
4. **Preserve mutable-source identity.** Do not canonicalize away arXiv version
   suffixes; allow withdrawn/retracted status to force Claim deferral.
5. **Add deterministic artifact metrics.** Support explicit length unit and receipt;
   for PDFs/binaries, retain extraction/content-type fidelity status where available.
6. **Do not broaden Raven's architecture.** No new browser, scheduler, monitoring
   daemon, wiki, corpus, provider client, worker protocol, public stage, or GUI is
   justified by this audit.

## Exhaustiveness note

The inventory covered all 258 files in the 18 directories, including every
`SKILL.md`, all `references/`, all `scripts/`, README/changelog/version files, and
research-paper LaTeX/BibTeX/style/template assets (including bundled PDFs as binary
artifacts). Text line evidence is cited above at the mechanism level; vendor template
source establishes formatting assets, not live venue-policy validity. No file under
the Hermes profile was modified. This report is the only file written by the audit.
