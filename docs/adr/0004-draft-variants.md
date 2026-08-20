---
status: accepted
---

# A Draft Variant is a candidate, not a Checkpoint

Writing improves when the same brief is rendered several ways and compared, so Raven can ask several model routes for one bounded instruction at once. The whole risk of that feature is that generated prose reads authoritatively: three models agreeing on a sentence feels like corroboration and is not. A Draft Variant is therefore classified exactly as a Lead is — located, not verified. It carries no evidence of its own, can never be cited, never counts toward the evidence floor, and joins the Task only when its wording is adopted into a Checkpoint that Raven verifies against real Sources. An acceptance test asserts this directly: adopting variant wording verbatim still leaves a grounding-required Completion refused until a recorded Source excerpt supports it.

The route list belongs to the deployment, not to the agent. Naming a model names spend and a data path, so `draftRoutes` is the whole universe of routes a Task may reach and the agent may only select a subset of it; an unconfigured route is refused with the configured set named rather than quietly substituted. Drafting is off until a deployment opts in, and an empty list reports that it did not run instead of silently falling back to the session model.

Direct `ctx.llm.stream` calls rather than subagents: drafting is a pure text transform with no tools and no multi-turn reasoning, so a subagent's system prompt, tool registry, session persistence, and lifecycle would all be overhead to strip back out, and its output would be agent chatter rather than clean prose. Direct calls also give exact per-draft `(provider, model)` control and one shared cancellation signal. Routes run concurrently under their own deadlines so one dead provider costs its own variant rather than the round. The seam signals adapter failure through a terminal `finish` chunk rather than a throw, so the finish reason is inspected explicitly — a drafter that only wrapped the loop in `try`/`catch` would accept an empty or truncated draft as a real one.

Only bounded provenance is persisted: route, status, and character count, never the variant text. Unadopted wording riding the Task's durable record would look like something that had been chosen. Variants are laid out in the Task's Prose Layout before they are returned, so candidates diff line by line.
