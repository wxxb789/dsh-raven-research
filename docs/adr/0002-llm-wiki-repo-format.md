---
status: accepted
---

# Base Raven's repository organization on llm-wiki

A Raven Task that only renders into chat evaporates at session end, so Raven emits its completed work as files. It adopts the llm-wiki layout (`wiki/SCHEMA.md`, `wiki/index.md`, `wiki/log.md`, immutable `raw/` sources, and agent-owned `queries/entities/concepts/comparisons` pages) instead of inventing a Raven-specific format, because the two models are already isomorphic: immutable `raw/` sources are Raven Sources, `sources:` frontmatter is the Claim→Source trace, `contested:`/`contradictions:` are Raven contradiction links, and the `sha256` drift check is the excerpt re-verification. A repository Raven initializes is therefore a valid llm-wiki, readable by Obsidian and by that skill's own tooling. Raven emits page bytes through a read-only `export` action and never writes files itself, keeping the plugin free of a filesystem dependency while the Harness agent performs the writes. Raven's `raw/` pages record the verified excerpt plus its verification receipt rather than a full page capture, declared as `capture: excerpt-only` so the difference from a full-body llm-wiki ingest is visible rather than implied. Scale, quality, and insight machinery from that skill — lint/health scripts, index regeneration, tier promotion, stub materialization, and log rotation — is deliberately deferred.
