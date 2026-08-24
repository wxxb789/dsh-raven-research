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

function identity(value: URL): string {
  const hostname = value.hostname.toLowerCase().replace(/\.$/, '')
  const scheme = value.protocol.toLowerCase()
  const port = value.port === '' ? DEFAULT_PORTS[scheme] ?? 'default' : value.port
  return `${hostname}:${port}`
}

/** Parse one canonical public HTTP(S) Source URL and reject embedded credentials. */
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

/** Same host identity, allowing an ordinary HTTP→HTTPS upgrade but not host/port drift. */
export function sameSourceIdentity(left: string, right: string): boolean {
  return identity(new URL(canonicalSourceUrl(left))) === identity(new URL(canonicalSourceUrl(right)))
}
