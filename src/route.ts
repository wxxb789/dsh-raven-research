/**
 * Model-route identity: pure, dependency-free, and shared by the Host half and
 * the browser card.
 *
 * It lives apart from the engine on purpose. The engine reaches for `node:crypto`
 * and the settings schema reaches for the Harness settings runtime, and the
 * browser bundle must contain neither; a route parser that lived in either would
 * drag the whole Host runtime into the page.
 * @module
 */

/** One model route asked for a Draft Variant. Identity is the pair, never the model alone. */
export interface RavenDraftRoute {
  readonly provider: string
  readonly model: string
}

/**
 * Split a configured `provider/model` route on its FIRST separator: a provider
 * route never contains one, while a model id routinely does
 * (`deepseek/deepseek-chat`), so splitting on the last would silently reroute
 * every namespaced model to the wrong provider.
 */
export function parseDraftRoute(spec: string): RavenDraftRoute | undefined {
  const trimmed = spec.trim()
  const separator = trimmed.indexOf('/')
  if (separator <= 0 || separator >= trimmed.length - 1) return undefined
  return { provider: trimmed.slice(0, separator), model: trimmed.slice(separator + 1) }
}

export function formatDraftRoute(route: RavenDraftRoute): string {
  return `${route.provider}/${route.model}`
}

export const SOURCE_VERIFICATION_MODES = ['remote', 'structural-only'] as const

export type SourceVerificationMode = typeof SOURCE_VERIFICATION_MODES[number]

export const SOURCE_DISCOVERY_MODES = ['seam', 'disabled'] as const

export type SourceDiscoveryMode = typeof SOURCE_DISCOVERY_MODES[number]
