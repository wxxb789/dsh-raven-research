import { describe, expect, it } from 'vitest'

import { canonicalSourceUrl, redactedLeadUrl, sameSourceIdentity } from '../../src/url.js'

describe('sameSourceIdentity', () => {
  it('accepts an identical URL', () => {
    expect(sameSourceIdentity('https://example.com/a', 'https://example.com/a')).toBe(true)
  })

  it('accepts an ordinary http to https upgrade on the same host', () => {
    expect(sameSourceIdentity('http://example.com/a', 'https://example.com/a')).toBe(true)
  })

  it('accepts an upgrade when either side spells out its default port', () => {
    expect(sameSourceIdentity('http://example.com:80/a', 'https://example.com/a')).toBe(true)
    expect(sameSourceIdentity('http://example.com/a', 'https://example.com:443/a')).toBe(true)
    expect(sameSourceIdentity('http://example.com:80/a', 'https://example.com:443/a')).toBe(true)
  })

  it('rejects an https to http downgrade', () => {
    expect(sameSourceIdentity('https://example.com/a', 'http://example.com/a')).toBe(false)
    expect(sameSourceIdentity('https://example.com:443/a', 'http://example.com:80/a')).toBe(false)
  })

  it('preserves same-scheme default-port equivalence', () => {
    expect(sameSourceIdentity('https://example.com/a', 'https://example.com:443/b')).toBe(true)
    expect(sameSourceIdentity('http://example.com:80/a', 'http://example.com/b')).toBe(true)
  })

  it('rejects same-scheme non-default port drift', () => {
    expect(sameSourceIdentity('https://example.com/a', 'https://example.com:8443/a')).toBe(false)
    expect(sameSourceIdentity('https://example.com:8443/a', 'https://example.com:443/a')).toBe(false)
    expect(sameSourceIdentity('http://example.com/a', 'http://example.com:8080/a')).toBe(false)
  })

  it('rejects an upgrade that also drifts off a default port', () => {
    expect(sameSourceIdentity('http://example.com:8080/a', 'https://example.com/a')).toBe(false)
    expect(sameSourceIdentity('http://example.com/a', 'https://example.com:8443/a')).toBe(false)
  })

  it('rejects cross-host changes, including subdomains', () => {
    expect(sameSourceIdentity('https://example.com/a', 'https://other.com/a')).toBe(false)
    expect(sameSourceIdentity('https://example.com/a', 'https://www.example.com/a')).toBe(false)
    expect(sameSourceIdentity('http://example.com/a', 'https://evil.com/a')).toBe(false)
  })

  it('normalizes host case and a trailing dot', () => {
    expect(sameSourceIdentity('https://EXAMPLE.com/a', 'https://example.com/a')).toBe(true)
    expect(sameSourceIdentity('https://example.com./a', 'https://example.com/a')).toBe(true)
    expect(sameSourceIdentity('http://Example.COM./a', 'https://example.com/a')).toBe(true)
  })

  it('still rejects credentials and non-http schemes on either side', () => {
    expect(() => sameSourceIdentity('https://user:token@example.com/a', 'https://example.com/a'))
      .toThrow(/credentials/)
    expect(() => sameSourceIdentity('https://example.com/a', 'ftp://example.com/a'))
      .toThrow(/http or https/)
    expect(() => sameSourceIdentity('not a url', 'https://example.com/a'))
      .toThrow(/invalid Source URL/)
  })
})

describe('canonicalSourceUrl', () => {
  it('returns the parsed href for a public http(s) URL', () => {
    expect(canonicalSourceUrl('https://example.com/a')).toBe('https://example.com/a')
  })

  it('rejects credentials, foreign schemes, and unparsable input', () => {
    expect(() => canonicalSourceUrl('https://user@example.com/a')).toThrow(/credentials/)
    expect(() => canonicalSourceUrl('https://:pw@example.com/a')).toThrow(/credentials/)
    expect(() => canonicalSourceUrl('file:///etc/passwd')).toThrow(/http or https/)
    expect(() => canonicalSourceUrl('nope')).toThrow(/invalid Source URL/)
  })
})

describe('redactedLeadUrl', () => {
  it('erases credentials but keeps the candidate', () => {
    expect(redactedLeadUrl('https://user:token@example.com/a')).toBe('https://example.com/a')
  })

  it('drops unparsable and non-http(s) candidates', () => {
    expect(redactedLeadUrl('nope')).toBeUndefined()
    expect(redactedLeadUrl('ftp://example.com/a')).toBeUndefined()
  })
})
