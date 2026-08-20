import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

import { RAVEN_LIMITS } from './domain.js'
import type { ProseFormat, ProseLayout } from './prose.js'

/**
 * The settings namespace Raven owns. Registering it is what exposes it: a Harness
 * that serves settings answers this namespace for every configuration surface,
 * with no allowlist to join and nothing to declare in the Harness itself.
 */
export const RAVEN_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('raven-research')

export const SOURCE_VERIFICATION_MODES = ['remote', 'structural-only'] as const

export type SourceVerificationMode = typeof SOURCE_VERIFICATION_MODES[number]

export const SOURCE_DISCOVERY_MODES = ['seam', 'disabled'] as const

export type SourceDiscoveryMode = typeof SOURCE_DISCOVERY_MODES[number]

/**
 * Deployment-owned Raven policy.
 *
 * Every field is a decision about the environment a Raven Task runs in, never a
 * decision about the Task itself. The evidence floor belongs to the Outcome and no
 * setting can lower it: withholding remote checks makes Sources unverifiable and
 * refuses the Checkpoint, which is the honest degradation, not a weaker standard.
 */
export interface RavenConfig {
  sourceVerification?: SourceVerificationMode
  sourceCheckTimeoutMs?: number
  sourceDiscovery?: SourceDiscoveryMode
  searchMaxQueries?: number
  searchMaxResults?: number
  searchTimeoutMs?: number
  proseLayout?: ProseLayout
  proseFormat?: ProseFormat
  draftRoutes?: string[]
  draftMaxTokens?: number
  draftTimeoutMs?: number
}

export const Config: z<RavenConfig> = z.object({
  sourceVerification: z
    .union([z.const('remote'), z.const('structural-only')])
    .default('remote')
    .description(
      'Whether recorded Sources are re-fetched to confirm their excerpts. '
      + '"structural-only" keeps every check local, which means no Source can be confirmed: '
      + 'a Checkpoint that records Sources is refused with the policy named, instead of '
      + 'publishing evidence nobody inspected. Set it only for a deployment that cannot reach '
      + 'the network, where the honest outcome is a clear refusal rather than a link error per Source.',
    ),
  sourceCheckTimeoutMs: z
    .natural()
    .default(0)
    .description(
      'Deadline for one remote Source check, in milliseconds. 0 means no deadline. '
      + 'An exceeded deadline reports that one Source as unverifiable instead of holding the Checkpoint open.',
    ),
  sourceDiscovery: z
    .union([z.const('seam'), z.const('disabled')])
    .default('seam')
    .description(
      'Whether raven_task action=discover may run queries through the Harness web search seam. '
      + '"disabled" reports discovery as unavailable and records a Limitation instead of returning Leads; '
      + 'it never makes the agent believe it searched. Set it for a deployment that must not issue search '
      + 'traffic from inside a Raven Task, where the agent still has its own tools.',
    ),
  searchMaxQueries: z
    .natural()
    .default(RAVEN_LIMITS.searchQueries)
    .description(
      'Upper bound on queries accepted by one discover call, mirroring the Harness web_search batch bound. '
      + '0 means the built-in bound. Complementary queries in ONE call are the point: they share a deadline, '
      + 'are deduplicated against each other, and cost one Task step.',
    ),
  searchMaxResults: z
    .natural()
    .default(RAVEN_LIMITS.searchResults)
    .description(
      'Upper bound on candidates requested per query, mirroring the Harness web_search source bound. '
      + '0 means the built-in bound. The merged Lead list is bounded separately so a wide batch cannot flood a Task step.',
    ),
  searchTimeoutMs: z
    .natural()
    .default(30_000)
    .description(
      'Deadline for one discovery query, in milliseconds. 0 means no deadline. A query that exceeds it is '
      + 'recorded as a failed query and a Task Limitation; its siblings still return their Leads.',
    ),
  proseLayout: z
    .union([z.const('sentence-per-line'), z.const('as-written')])
    .default('sentence-per-line')
    .description(
      'How Raven lays out every stored Artifact. "sentence-per-line" puts exactly one sentence on each '
      + 'line, which makes a LINE the smallest edit unit: a revision then diffs as the sentences that '
      + 'actually changed instead of as whole rewritten paragraphs. Markdown structure — fenced code, '
      + 'tables, headings, frontmatter, math — is copied through untouched. "as-written" stores exactly '
      + 'what the agent submitted.',
    ),
  proseFormat: z
    .union([z.const('markdown'), z.const('plain')])
    .default('markdown')
    .description(
      'The Artifact format Raven assumes. "markdown" is the default final output format and is what '
      + 'makes the layout structure-aware. "plain" treats every line as prose, so a deployment whose '
      + 'Artifacts are not Markdown does not get its headings and code reflowed as sentences.',
    ),
  draftRoutes: z
    .array(z.string())
    .default([])
    .description(
      'Model routes a Draft Variant may be requested from, each "provider/model" and split on the FIRST '
      + 'slash so a namespaced model id survives. This list is the whole universe: the agent may select a '
      + 'subset of it and nothing else, because naming a model is naming spend and a data path. Empty '
      + 'disables Draft Variants and reports that instead of quietly drafting from the session model.',
    ),
  draftMaxTokens: z
    .natural()
    .default(4_000)
    .description(
      'Upper bound on the length of one Draft Variant, in model output tokens. 0 means the built-in bound. '
      + 'Every route in a round shares it so the variants stay comparable.',
    ),
  draftTimeoutMs: z
    .natural()
    .default(120_000)
    .description(
      'Deadline for one Draft Variant, in milliseconds. 0 means no deadline. A route that exceeds it '
      + 'produces no variant and says so; its siblings still return theirs.',
    ),
})
