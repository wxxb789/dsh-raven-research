# Raven Domain Glossary

## Raven Task

The single user-visible unit of work. A Raven Task has one continuing identity from the initial request through research, drafting, steering, verification, and completion, regardless of how many agents or tools contribute internally. Each owning Agent or detected Task Team has at most one active Task at a time; stopped and completed Task histories may remain addressable.

## Raven Workspace

A user-owned, long-lived llm-wiki repository that Raven can initialize, adopt, grow, inspect, and maintain across many Raven Tasks. Markdown pages are its source of truth; `index.md` is disposable derived structure and `log.md` is append-only history. A Workspace never owns, starts, stops, or completes a Task. Raven emits conditional file plans and the Harness agent applies them with ordinary file tools, so the Workspace remains a plain llm-wiki rather than a Raven database.

## Outcome

The kind of useful result the user wants from a Raven Task. The four first-class Outcomes are **Research**, **General Writing**, **Academic Writing**, and **Learning**.

## Artifact

The useful content produced by a Raven Task, such as findings, an outline, a draft, an explanation, a study guide, or a final document. An Artifact evolves during the Task rather than appearing only at the end.

## Checkpoint

A user-visible version of the Artifact emitted while the Raven Task is still active. A Checkpoint is useful on its own, records the Task's current understanding, and gives the user an opportunity to steer subsequent work.

## Steering Revision

A user correction or change of emphasis applied to the existing Raven Task. A Steering Revision preserves prior evidence and Checkpoints and does not restart the Task.

## Lead

A candidate Raven has located but not inspected. A Lead records where something might be, never what it says. Discovery produces Leads; only inspection turns one into a Source. A Lead can never carry a Claim, appear in an Artifact citation, or count toward the evidence floor.

## Draft Variant

One candidate rendering of the same writing instruction, produced by one model route. A Draft Variant is a candidate in exactly the sense a Lead is: it carries no evidence of its own, can never be cited, and joins the Raven Task only when its wording is adopted into a Checkpoint that Raven verifies against real Sources. Comparing variants chooses phrasing; it never establishes a fact, and a sentence every variant agrees on is still unsupported until a Source excerpt supports it.

## Insight Candidate

A candidate interpretation Raven has derived from one or more Claims, such as a connection, explanation, hypothesis, reframing, implication, or thesis. It records its premise Claims, assumptions, rationale, plausible alternatives, confidence, and what evidence would weaken it. An Insight Candidate is neither external fact nor accepted analysis. Raven may later promote it into an analysis Claim while preserving that lineage; competing candidates remain candidates rather than disappearing.

## Synthesis Pass

An explicit examination of a bounded Artifact or section for what follows from its Claims. A Synthesis Pass may seek synthesis, honor a request for summary, or provide explanation without a novelty requirement. It records the Claims considered, the Insight Candidates produced, and any Summary Debt found; it does not publish an Artifact or accept a candidate by itself.

## Skeleton Candidate

One proposed argument architecture for a substantive long-form Artifact. It is more than an outline: it defines a distinct frame and thesis, central question, reasoning flow, purposeful sections, relevant Claim and Insight links, evidence needs, counterarguments, unresolved weaknesses, and intended reader takeaway. Candidates in one Structure Studio round must make materially different claims about what the Artifact is explaining, not merely reorder headings.

## Structure Battle

Raven's private comparative critique of every current Skeleton Candidate. It records what each architecture explains better, fails to explain, assumes, repeats from conventional wisdom, requires as evidence, contributes as non-obvious insight, and offers for a hybrid. The user receives only the strongest alternatives, tradeoffs, and Raven's recommendation rather than tournament noise.

## Selected Skeleton

The intentionally resolved argument architecture that constrains substantive drafting. It may adopt one Candidate or preserve a user-directed or Raven-selected hybrid. Its section-level Claim and Insight links, counterargument-specific lineage, evidence gaps, weaknesses, and reader takeaway remain in Task state and in drafting context. The selection records its Task revision, and every prose Checkpoint records that revision so Completion cannot reuse prose written for an obsolete Skeleton. A later Steering Revision invalidates the selection until Raven battles and resolves a current architecture again.

## Summary Debt

A visible deficit in material that is organized but still consists mostly of restatement, chronology, or description. Summary Debt means the requested synthesis has not yet produced enough defensible interpretation, explanation, connection, or implication. It does not apply when summary is the requested result or when explanation rather than novelty is the goal.

## Prose Layout

The canonical line shape of a stored Artifact. Raven owns it rather than the executor, because Completion compares Artifact bytes: if each writer laid out its own text, one model's line-wrapping habits would decide whether a final Artifact matches its Checkpoint. Under the default layout each sentence occupies its own line, which makes a line the smallest edit unit — a revision then reads as the sentences that changed rather than as rewritten paragraphs. A Prose Layout never alters meaning and never reflows document structure.

## Source Origin

The place a Source entered Raven from. Raven currently recognizes exactly four Source Origins: **Web**, **Local**, **llm-wiki**, and **MCP**. Origin changes how the Original Resource is reopened, never how Claims refer to the Source.

## Original Resource

The item outside Raven that a Source identifies: a web page, local file, llm-wiki page, or MCP resource. Its identity and media type remain distinct from every representation Raven derives from it.

## Markdown Representation

The canonical semantic material Raven inspects and verifies. It is either original Markdown preserved as written or Markdown derived from an Original Resource with the producer named. A derived representation never replaces or impersonates its Original Resource.

## Source

An external item that Raven has actually inspected and can identify again. A Source binds one Original Resource to its Markdown Representation, locator, excerpt, verification state, and stable identity. Claims link to that Source identity without depending on its Source Origin. A search result or remembered citation is only a Lead until inspected.

## Source Policy

The current Raven Task's steerable rules for admitting and preferring Sources. It may allow or block web sites, prefer primary Sources, scope local folders and llm-wikis, and include or exclude named MCP sources. Source Policy belongs to the Task rather than the deployment and may change through a Steering Revision without restarting the Task.

## Claim

A proposition considered or used by a Raven Task. An external Claim records what inspected Sources say. An analysis Claim records what Raven infers and retains the Insight Candidate, premise Claims, and assumptions from which the inference was promoted. Either kind records whether it is supported, qualified, deferred, or rejected; an analysis Claim loses accepted authority when a premise does.

## Evidence Link

The traceable relationship from a Claim to one or more Sources, including the location or excerpt that carries the relevant support. Multiple links do not imply independence when they share the same underlying origin.

## Verification

A check that a Source reference resolves, an Evidence Link points to inspected material, a Claim does not exceed that material, and the current Artifact reflects the recorded evidence and Steering Revisions. Verification can find limitations without invalidating unrelated work.

## Limitation

A visible gap caused by unavailable evidence, failed tools, incomplete coverage, unresolved contradiction, or a deliberately bounded scope. A Limitation narrows what Raven may claim; it does not automatically make the whole Raven Task fail.

## Task Team

The set of Agents that share one Raven Task when the deployment composes Agent Teams and Raven successfully detects membership. A detected Task Team has one Task identity, one evidence set, and one Artifact regardless of how many members contribute; a member never owns a competing Task of its own. If membership is absent or cannot be detected, each Agent owns an independent Task book. Team membership changes who may contribute, never what the Task owes the user.

## Contextual Guidance

A brief, user-facing hint about a Raven capability that is directly relevant to the current conversation, such as redirecting the work, changing source constraints, pausing and resuming, or preserving a result. In **auto** policy Raven may offer at most one useful hint and avoids capabilities the user already understands; **off** suppresses these optional hints without changing Task behavior. Tool actions and lifecycle vocabulary remain internal to the main agent in both policies.

## Completion

The business outcome that the requested Artifact is useful and its required checks have been performed. Completion may be explicitly limited when unresolved Limitations remain. Tool or worker termination alone is not Completion.
