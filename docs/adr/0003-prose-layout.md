---
status: accepted
---

# Raven owns the line shape of a stored Artifact

An agent editing prose treats a paragraph as the smallest modifiable unit: to change one clause it rewrites the block, so every diff is coarse, every review re-reads unchanged text, and a regression hides inside a paragraph that merely "changed". Raven therefore normalizes every stored Artifact into a Prose Layout, and the default layout puts exactly one sentence on each line so that a LINE becomes the smallest edit unit.

Ownership sits with Raven rather than with the executor because Completion compares Artifact byte hashes. If each writer laid out its own text, one model's line-wrapping habits would decide whether a final Artifact matches its Checkpoint. Raven normalizing on the way in means the render shows the stored bytes, the agent edits those exact bytes next round, and the hash means one thing. The transform is consequently required to be idempotent — `layoutProse(layoutProse(x)) === layoutProse(x)` — so a caller may resend either its own packed text or the bytes Raven returned and Completion is never blocked on a formatting difference nobody made.

The transform is Markdown-structure-aware because reflowing a fenced code block, a table row, or a heading would corrupt the document: fences, tables, headings, thematic breaks, link reference definitions, math blocks, YAML frontmatter, and authored hard line breaks are copied through untouched, while list items and blockquotes receive the continuation prefix that keeps the block valid. Sentence splitting is deliberately conservative — abbreviations, initials, decimals, inline code spans, and link destinations are never split — because a missed split merges two sentences onto one line, which reads correctly, while an over-eager split corrupts a citation.

A Checkpoint records the layout its bytes are in. Without that, changing the setting mid-Task produced a Completion hash mismatch that read as an unauthorized final edit rather than as the reformat it was. The layout is a deployment setting (`proseLayout`), defaulting to on; `as-written` stores exactly what the agent submitted. The Artifact format is Markdown by default (`proseFormat`), which is also what makes the layout structure-aware.
