import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

import { RAVEN_LIMITS } from './domain.js'

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
})
