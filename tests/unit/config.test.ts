import { describe, expect, it } from 'vitest'

import { Config, RAVEN_SETTINGS_NAMESPACE, SOURCE_VERIFICATION_MODES } from '../../src/config.js'

describe('Raven deployment settings', () => {
  it('names one namespace and defaults to remote verification without a deadline', () => {
    expect(RAVEN_SETTINGS_NAMESPACE).toBe('raven-research')
    expect(SOURCE_VERIFICATION_MODES).toEqual(['remote', 'structural-only'])
    expect(Config({})).toEqual({ sourceVerification: 'remote', sourceCheckTimeoutMs: 0 })
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
