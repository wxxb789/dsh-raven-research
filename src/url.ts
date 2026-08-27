/**
 * Default port per scheme. A redirect that spells the default port out — the
 * ordinary `https://host/x` → `https://host:443/x` an origin or a proxy may
 * emit — is the SAME origin, and treating it as host drift rejected a Source
 * whose evidence was never in question. Folding is safe in exactly this
 * direction: only the port that the scheme already implies is erased, so
 * `:8443` still differs from `:443` and a genuine cross-origin redirect is
 * still refused.
 */
const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
}

interface Identity {
  hostname: string
  scheme: string
  port: string
}

function identity(value: URL): Identity {
  const scheme = value.protocol.toLowerCase()
  return {
    hostname: value.hostname.toLowerCase().replace(/\.$/, ''),
    scheme,
    port: value.port === '' ? DEFAULT_PORTS[scheme] ?? 'default' : value.port,
  }
}

/** True when the identity sits on the port its own scheme implies. */
function isDefaultPort(value: Identity): boolean {
  return value.port === DEFAULT_PORTS[value.scheme]
}

/** Parse one canonical HTTP(S) Source URL and reject embedded credentials. */
export function canonicalSourceUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError(`invalid Source URL: ${value}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Source URL must use http or https')
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new TypeError('Source URL must not contain credentials')
  }
  return parsed.href
}

/**
 * One backend-supplied candidate URL, stripped of anything that must not be
 * printed into a transcript.
 *
 * A Lead URL is third-party text that Raven RENDERS: a search backend answering
 * with `https://user:token@host/path` would put that credential into the model's
 * context and into the durable session log, where no later redaction can reach
 * it. Registration already refuses a credential-bearing Source URL outright, but
 * a Lead is not evidence and refusing it would silently drop a candidate, so the
 * credential is erased and the candidate survives. A URL that does not parse at
 * all cannot be inspected for credentials, so it is dropped rather than printed
 * on the chance that it is harmless.
 */
export function redactedLeadUrl(value: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    parsed.username = ''
    parsed.password = ''
  }
  return parsed.href
}

/**
 * Same host identity, allowing an ordinary HTTP→HTTPS upgrade but not host/port
 * drift.
 *
 * The upgrade is accepted in ONE direction and only between the two schemes'
 * own default ports: `http://host` → `https://host` is the redirect every
 * origin emits, while `https://host` → `http://host` is a downgrade whose
 * evidence is no longer the evidence that was registered, so it is refused. A
 * non-default port never participates, which keeps `:8443` distinct from `:443`
 * and leaves a genuine cross-origin redirect refused.
 */
export function sameSourceIdentity(left: string, right: string): boolean {
  const from = identity(new URL(canonicalSourceUrl(left)))
  const to = identity(new URL(canonicalSourceUrl(right)))
  if (from.hostname !== to.hostname) return false
  if (from.scheme === to.scheme) return from.port === to.port
  if (from.scheme !== 'http:' || to.scheme !== 'https:') return false
  return isDefaultPort(from) && isDefaultPort(to)
}
