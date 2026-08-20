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
      proseLayout: 'sentence-per-line',
      proseFormat: 'markdown',
      draftRoutes: [],
      draftMaxTokens: 4_000,
      draftTimeoutMs: 120_000,
    })
  })

  it('defaults writing to sentence-per-line Markdown and to no configured model route', () => {
    // The default is the feature ON: a line is the smallest edit unit unless a
    // deployment deliberately turns that off.
    expect(Config({}).proseLayout).toBe('sentence-per-line')
    expect(Config({}).proseFormat).toBe('markdown')
    expect(Config({ proseLayout: 'as-written' }).proseLayout).toBe('as-written')
    expect(() => Config({ proseLayout: 'one-sentence' } as never)).toThrow()
    expect(() => Config({ proseFormat: 'html' } as never)).toThrow()
    // Naming a model is naming spend, so drafting stays off until a deployment opts in.
    expect(Config({}).draftRoutes).toEqual([])
    expect(Config({ draftRoutes: ['deepseek/deepseek-chat'] }).draftRoutes).toEqual(['deepseek/deepseek-chat'])
    expect(() => Config({ draftMaxTokens: -1 })).toThrow()
    expect(() => Config({ draftTimeoutMs: 1.5 })).toThrow()
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
