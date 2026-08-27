import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

import { RAVEN_LIMITS } from './domain.js'
import { SOURCE_NETWORK_POLICIES, type SourceNetworkPolicy } from './network-policy.js'
import type { ProseFormat, ProseLayout } from './prose.js'
import type { SourceDiscoveryMode, SourceVerificationMode } from './route.js'

/** The mount roles a Raven row may take. See {@link RavenConfig.role}. */
export const RAVEN_ROLES = ['host', 'agent', 'both'] as const

/** Which half of Raven a single mount registers. See {@link RavenConfig.role}. */
export type RavenRole = (typeof RAVEN_ROLES)[number]

/** User-facing contextual guidance policy. Tool behavior is identical in both modes. */
export const RAVEN_GUIDANCE_POLICIES = ['auto', 'off'] as const

/** Whether the main agent may surface brief, relevant Raven capability hints. */
export type RavenGuidancePolicy = (typeof RAVEN_GUIDANCE_POLICIES)[number]

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
export { SOURCE_NETWORK_POLICIES, type SourceNetworkPolicy } from './network-policy.js'

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
 * Every field is deployment/user policy for the environment or interaction, never
 * persisted Raven Task state. The evidence floor belongs to the Outcome and no
 * setting can lower it: withholding remote checks makes Sources unverifiable and
 * refuses the Checkpoint, which is the honest degradation, not a weaker standard.
 */
export interface RavenConfig {
  /**
   * Which half of Raven this mount registers. Read from the COMPOSITION ENTRY only —
   * never from the live settings thunk. See the schema description below.
   */
  role?: RavenRole
  guidance?: RavenGuidancePolicy
  sourceVerification?: SourceVerificationMode
  sourceNetworkPolicy?: SourceNetworkPolicy
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
  role: z
    .union([z.const('host'), z.const('agent'), z.const('both')])
    .default('both')
    .description(
      'Which half of Raven this mount registers. "host" registers ONLY the settings namespace and the '
      + 'mount-time capability warnings, so the configuration surface is served by the long-lived host '
      + 'plane and survives between sessions rather than existing only while one session is alive. '
      + '"agent" registers ONLY raven_task, the system-prompt section, the per-step Task context, and '
      + 'the tools/code-dispatch-log durability listener, so the tool exists exactly inside the agent '
      + 'scopes a preset row composes. "both" is the single-row deployment, today\'s behaviour, and the '
      + 'default, so a composition entry that names no role keeps working unchanged. Get it wrong and '
      + 'the failure is silent rather than loud: with no host row nothing serves the settings namespace, '
      + 'so the browser settings card has nothing to edit and every field falls back to its default; '
      + 'with no agent row no raven_task is registered, so the agent carries the prompt for a tool that '
      + 'does not exist. One agent-role row mounts once under the preset\'s standing scope; Raven keys '
      + 'that shared instance by Agent identity or successfully detected Team identity; failed membership probing falls back to an independent Agent book. '
      + 'This is a MOUNT-TIME decision and is therefore read from the composition entry alone, unlike '
      + 'every other field here: a settings surface that could flip a mount\'s role at runtime would '
      + 'register or unregister a tool underneath a running agent.',
    )
    // Hidden because it is mount-time, and the card is generic. The browser card
    // derives its rows from THIS schema on purpose (ADR 0005: it states no rules
    // of its own), so a field that must never be edited at runtime has to say so
    // where the schema is, not where the card is. Marking it here keeps the rule
    // with the decision instead of hard-coding one field name into the renderer,
    // which would silently stop covering the next mount-time field somebody adds.
    .hidden(),
  guidance: z
    .union(RAVEN_GUIDANCE_POLICIES.map(value => z.const(value)))
    .default('auto')
    .description(
      'Whether the main agent may briefly surface a Raven capability when it is directly relevant. '
      + '"auto" may mention one useful option such as redirecting the work, changing source constraints, '
      + 'pausing and resuming, or preserving a finished result. It must not turn routine work into a tutorial, '
      + 'repeat a capability the user already understands, expose tool protocol, or add approval gates. '
      + '"off" suppresses these optional hints without changing Raven Task behavior.',
    ),
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
  sourceNetworkPolicy: z
    .union(SOURCE_NETWORK_POLICIES.map(value => z.const(value)))
    .default('unrestricted')
    .description(
      'Pre-flight policy for model-supplied Source URLs. "public-only" refuses local hostnames, '
      + 'private or special IP literals, and DNS names with any non-public answer before calling '
      + 'the Harness fetch provider. It reduces SSRF exposure but cannot close DNS rebinding because '
      + 'the current web seam resolves again at connect time. "unrestricted" skips this filter; it remains '
      + 'the compatibility fallback for deployments that omitted this newer setting, while shipped Raven presets '
      + 'explicitly use "public-only" for new installs. Set "unrestricted" deliberately only when the fetch '
      + 'provider is already network-confined or intentionally serves trusted internal Sources.',
    ),
  sourceCheckTimeoutMs: z
    .natural()
    .max(RAVEN_SETTINGS_CEILINGS.timeoutMs)
    .default(0)
    .description(
      'Deadline for one remote Source check, in milliseconds. 0 means no deadline. '
      + 'An exceeded deadline reports that one Source as unverifiable instead of holding the Checkpoint open. '
      + 'The compatibility default remains 0 for deployments that omitted this newer setting; shipped Raven '
      + 'presets explicitly use 20000 so new Raven-mode installs still bound each check.',
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