import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/**
 * The settings namespace Raven owns. Registering it is what exposes it: a Harness
 * that serves settings answers this namespace for every configuration surface,
 * with no allowlist to join and nothing to declare in the Harness itself.
 */
export const RAVEN_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('raven-research')

export const SOURCE_VERIFICATION_MODES = ['remote', 'structural-only'] as const

export type SourceVerificationMode = typeof SOURCE_VERIFICATION_MODES[number]

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
})
