import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

import { RAVEN_LIMITS } from './domain.js'
import type { ProseFormat, ProseLayout } from './prose.js'
import type { SourceDiscoveryMode, SourceVerificationMode } from './route.js'

/**
 * The settings namespace Raven owns. Registering it is what exposes it: a Harness
 * that serves settings answers this namespace for every configuration surface,
 * with no allowlist to join and nothing to declare in the Harness itself.
 */
export const RAVEN_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('raven-research')

// Re-exported rather than declared here: the browser settings card needs the
// same option lists, and this module reaches for the Harness settings runtime.
export {
  SOURCE_DISCOVERY_MODES,
  SOURCE_VERIFICATION_MODES,
  type SourceDiscoveryMode,
  type SourceVerificationMode,
} from './route.js'

/**
 * Ceilings on every settings-reachable numeric.
 *
 * A lower bound alone is not a bound: these fields are editable from the browser
 * settings card, and `discover` fans its whole batch out concurrently while a
 * verification pass walks every recorded Source, so `searchMaxQueries: 100000`
 * typed into a form is a UI-reachable self-DoS and `draftMaxTokens: 10000000` is
 * unbounded spend on someone else's account. The ceilings are deliberately a
 * small multiple of the built-in operating bounds rather than the largest value
 * the runtime could survive: a deployment that genuinely wants more is asking for
 * a different plugin bound, not a wider text box. `draftRoutes` is clamped the
 * same way, matching the ceiling the plugin already applies when it reads the list.
 */
export const RAVEN_SETTINGS_CEILINGS = {
  /** One deadline may reach an hour; beyond that a "deadline" is not one. */
  timeoutMs: 3_600_000,
  searchMaxQueries: 16,
  searchMaxResults: 32,
  draftMaxTokens: 64_000,
  draftRoutes: RAVEN_LIMITS.draftRoutes,
} as const

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
    .max(RAVEN_SETTINGS_CEILINGS.timeoutMs)
    .default(20_000)
    .description(
      'Deadline for one remote Source check, in milliseconds. 0 means no deadline. '
      + 'An exceeded deadline reports that one Source as unverifiable instead of holding the Checkpoint open. '
      + 'It defaults to a real deadline rather than to 0 because the verification pass walks the recorded '
      + 'Sources one at a time and BOTH Checkpoint and Completion re-run it: without a deadline one hung '
      + 'origin holds a Task step open for as long as the provider is willing to wait. 0 remains available '
      + 'for a deployment that deliberately wants to wait out a slow archive, and the whole pass is bounded '
      + 'separately so no number of Sources can add up to an unbounded wait.',
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
    .max(RAVEN_SETTINGS_CEILINGS.searchMaxQueries)
    .default(RAVEN_LIMITS.searchQueries)
    .description(
      'Upper bound on queries accepted by one discover call, mirroring the Harness web_search batch bound. '
      + '0 means the built-in bound. Complementary queries in ONE call are the point: they share a deadline, '
      + 'are deduplicated against each other, and cost one Task step.',
    ),
  searchMaxResults: z
    .natural()
    .max(RAVEN_SETTINGS_CEILINGS.searchMaxResults)
    .default(RAVEN_LIMITS.searchResults)
    .description(
      'Upper bound on candidates requested per query, mirroring the Harness web_search source bound. '
      + '0 means the built-in bound. The merged Lead list is bounded separately so a wide batch cannot flood a Task step.',
    ),
  searchTimeoutMs: z
    .natural()
    .max(RAVEN_SETTINGS_CEILINGS.timeoutMs)
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
    // Validated at the settings boundary, not only when the list is read. A typo
    // that reaches the plugin is skipped there — one bad entry must not take the
    // other routes down with it — but a skipped entry makes an all-typo list
    // indistinguishable from a deliberately empty one, and the operator is told
    // "no Draft Variant route is configured" for a list they can see. Refusing the
    // shape here means the browser card reports the schema's own words while the
    // draft is still on screen, which is the only moment the typo is cheap to fix.
    // The pattern is deliberately only as strict as `parseDraftRoute`: a non-empty
    // segment on each side of the FIRST slash, so a namespaced model id still passes.
    .array(z.string().pattern(/^[^/\s]+\/\S+$/))
    .max(RAVEN_SETTINGS_CEILINGS.draftRoutes)
    .default([])
    .description(
      'Model routes a Draft Variant may be requested from, each "provider/model" and split on the FIRST '
      + 'slash so a namespaced model id survives. This list is the whole universe: the agent may select a '
      + 'subset of it and nothing else, because naming a model is naming spend and a data path. Empty '
      + 'disables Draft Variants and reports that instead of quietly drafting from the session model.',
    ),
  draftMaxTokens: z
    .natural()
    .max(RAVEN_SETTINGS_CEILINGS.draftMaxTokens)
    .default(4_000)
    .description(
      'Upper bound on the length of one Draft Variant, in model output tokens. 0 means the built-in bound. '
      + 'Every route in a round shares it so the variants stay comparable.',
    ),
  draftTimeoutMs: z
    .natural()
    .max(RAVEN_SETTINGS_CEILINGS.timeoutMs)
    .default(120_000)
    .description(
      'Deadline for one Draft Variant, in milliseconds. 0 means no deadline. A route that exceeds it '
      + 'produces no variant and says so; its siblings still return theirs.',
    ),
})