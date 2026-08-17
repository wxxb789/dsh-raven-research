function identity(value: URL): string {
  const hostname = value.hostname.toLowerCase().replace(/\.$/, '')
  return `${hostname}:${value.port || 'default'}`
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

/** Same host identity, allowing an ordinary HTTP→HTTPS upgrade but not host/port drift. */
export function sameSourceIdentity(left: string, right: string): boolean {
  return identity(new URL(canonicalSourceUrl(left))) === identity(new URL(canonicalSourceUrl(right)))
}
