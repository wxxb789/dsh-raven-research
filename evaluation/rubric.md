# Raven evaluation review rubric

Review one opaque A/B pair at a time. Use the frozen source pack, preserved artifacts, and cited event excerpts. Do not infer which arm is Raven while grading content.

For each applicable dimension, assign each artifact one status:

- **pass:** no material defect for this scenario;
- **concern:** a localized defect requires qualification or revision, but the result remains useful;
- **fail:** a material defect undermines the requested result;
- **n/a:** the scenario does not exercise the dimension.

Then record `A`, `B`, `tie`, or `cannot-judge` as the pairwise preference, with `low`, `medium`, or `high` confidence. Every `concern`, `fail`, or preference must cite an exact Artifact quote, Source ID, or event sequence and explain why it matters. Two reviewers assess every release pair independently. Adjudication appends a new record that references the originals; it never overwrites them.

## Research and evidence

### Research correctness

Check every material factual proposition against the frozen Sources. A literal excerpt match is necessary but not sufficient: judge whether the Source entails the proposition, whether qualifiers and dates survived, and whether proposal, announcement, implementation, and measured outcome remain distinct.

### Citation and claim-support fidelity

Check whether citations are placed where a reader can identify their support scope. Flag compound Claims for which different Sources support different clauses, citations that support only a narrower proposition, and material assertions omitted from the declared Claim trace.

### Source quality and independence

Judge authority, method, primary/secondary status, conflicts of interest, freshness, and version identity. Reprints, press-release rewrites, and records with the same originating institution do not become independent merely because they use different hosts.

### Coverage and contradictions

Use the scenario's assessor-side fact and contradiction checklist. Judge whether omissions are material, whether opposing evidence receives comparable scrutiny, and whether unresolved conflict changes the recommendation or is merely mentioned.

## Insight and synthesis

### Insight defensibility

A useful Insight names its premises, assumptions, alternative explanations, boundary conditions, and evidence that would change the conclusion. Plausibility alone is not a pass. Distinguish Source testimony from the agent's inference.

### Non-obviousness and usefulness

Ask whether the synthesis changes what a decision-maker understands or would do. Reward explanatory connections, implications, discriminating hypotheses, and justified reframing. Do not reward novelty theater or unsupported surprise.

### Resistance to summary-only writing

Check whether the result merely groups, sequences, or paraphrases Sources. Raven's Summary Debt signal is evidence about lineage only; reviewers still judge whether actual reasoning occurred.

## Structure and writing

### Argument and Skeleton quality

Judge thesis specificity, genuine difference between alternatives, reasoning flow, section purpose, evidence placement, counterargument treatment, unresolved weaknesses, and whether the selected or hybrid structure fits the user decision.

### Final prose quality

Judge clarity, precision, audience fit, compression, coherence, transitions, tone, citation readability, and redundancy. Do not reward verbosity, architecture jargon, or a source-by-source report when the user requested an argument.

## User control and durability

### Steering retention

Compare the Steering instruction with every later Checkpoint and the final Artifact. A pass requires substantive adoption, removal or qualification of stale emphasis, and preservation of compatible evidence—not merely repeating the user's words.

### Progressive Checkpoint usefulness

Judge whether the first Checkpoint arrived early enough to steer and was independently useful. A progress slogan, tool log, or placeholder outline fails even when a later final Artifact is strong.

### Stop/resume durability

Use lifecycle evidence to confirm a real persistence boundary. Judge whether resumed work naturally continues the prior Artifact, Sources, Claims, selected structure, and user direction without redoing completed work or silently forking identity.

### llm-wiki knowledge reuse

Judge whether later-Task reuse is relevant, traceable, and materially reduces repeated work. Stored knowledge must not impersonate fresh verification for volatile facts. Lexical retrieval rank alone is not quality evidence.

## Completion and cost interpretation

Completion reliability is scenario-specific. `completed-with-limits` may be an honest success when the requested useful core survives; it fails when the missing evidence is central. Review the named limitation rather than counting the terminal label.

Compare raw token buckets, call counts, and wall time only after quality review. Additional cost is neither automatically waste nor automatically justified. Currency remains unavailable unless the report names an immutable provider pricing snapshot. Never collapse quality and cost into one weighted score.
