import { describe, expect, it } from 'vitest'

import { Config, RAVEN_SETTINGS_NAMESPACE, SOURCE_DISCOVERY_MODES, SOURCE_VERIFICATION_MODES } from '../../src/config.js'

describe('Raven deployment settings', () => {
  it('names one namespace and defaults to remote verification and seam discovery', () => {
    expect(RAVEN_SETTINGS_NAMESPACE).toBe('raven-research')
    expect(SOURCE_VERIFICATION_MODES).toEqual(['remote', 'structural-only'])
    expect(SOURCE_DISCOVERY_MODES).toEqual(['seam', 'disabled'])
    expect(Config({})).toEqual({
      sourceVerification: 'remote',
      sourceCheckTimeoutMs: 0,
      sourceDiscovery: 'seam',
      searchMaxQueries: 4,
      searchMaxResults: 8,
      searchTimeoutMs: 30_000,
    })
  })

  it('accepts the declared discovery modes and refuses anything else', () => {
    expect(Config({ sourceDiscovery: 'disabled' }).sourceDiscovery).toBe('disabled')
    expect(() => Config({ sourceDiscovery: 'guess' } as never)).toThrow()
    expect(Config({ searchMaxQueries: 2 }).searchMaxQueries).toBe(2)
    expect(() => Config({ searchMaxQueries: -1 })).toThrow()
    expect(() => Config({ searchTimeoutMs: 1.5 })).toThrow()
  })

  it('accepts the declared verification modes and refuses anything else', () => {
    expect(Config({ sourceVerification: 'structural-only' }).sourceVerification).toBe('structural-only')
    expect(() => Config({ sourceVerification: 'trust-me' } as never)).toThrow()
  })

  it('refuses a deadline that is not a natural number of milliseconds', () => {
    expect(Config({ sourceCheckTimeoutMs: 30_000 }).sourceCheckTimeoutMs).toBe(30_000)
    expect(() => Config({ sourceCheckTimeoutMs: -1 })).toThrow()
    expect(() => Config({ sourceCheckTimeoutMs: 1.5 })).toThrow()
  })
})
