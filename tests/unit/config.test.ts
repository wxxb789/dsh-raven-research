import { describe, expect, it } from 'vitest'

import {
  Config,
  RAVEN_SETTINGS_CEILINGS,
  RAVEN_SETTINGS_NAMESPACE,
  SOURCE_DISCOVERY_MODES,
  SOURCE_VERIFICATION_MODES,
} from '../../src/config.js'

describe('Raven deployment settings', () => {
  it('names one namespace and defaults to remote verification and seam discovery', () => {
    expect(RAVEN_SETTINGS_NAMESPACE).toBe('raven-research')
    expect(SOURCE_VERIFICATION_MODES).toEqual(['remote', 'structural-only'])
    expect(SOURCE_DISCOVERY_MODES).toEqual(['seam', 'disabled'])
    expect(Config({})).toEqual({
      sourceVerification: 'remote',
      sourceCheckTimeoutMs: 20_000,
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

  it('gives the Source deadline a real default while keeping 0 available', () => {
    // 0 meant "no deadline" over a SEQUENTIAL loop that both Checkpoint and
    // Completion re-run, so one hung origin held a Task step open indefinitely.
    expect(Config({}).sourceCheckTimeoutMs).toBe(20_000)
    // ...and a deployment that deliberately waits out a slow archive still can.
    expect(Config({ sourceCheckTimeoutMs: 0 }).sourceCheckTimeoutMs).toBe(0)
  })

  it('caps every settings-reachable numeric so the card cannot ask for a self-DoS', () => {
    // These fields are editable from the browser settings card and drive concurrent
    // fan-out and model spend, so a lower bound alone is not a bound.
    expect(() => Config({ searchMaxQueries: 100_000 })).toThrow()
    expect(() => Config({ searchMaxResults: 100_000 })).toThrow()
    expect(() => Config({ draftMaxTokens: 10_000_000 })).toThrow()
    expect(() => Config({ searchTimeoutMs: 86_400_000 })).toThrow()
    expect(() => Config({ draftTimeoutMs: 86_400_000 })).toThrow()
    expect(() => Config({ sourceCheckTimeoutMs: 86_400_000 })).toThrow()
    // The ceiling itself stays accepted, so the bound is inclusive and reachable.
    expect(Config({ searchMaxQueries: RAVEN_SETTINGS_CEILINGS.searchMaxQueries }).searchMaxQueries)
      .toBe(RAVEN_SETTINGS_CEILINGS.searchMaxQueries)
    expect(Config({ draftMaxTokens: RAVEN_SETTINGS_CEILINGS.draftMaxTokens }).draftMaxTokens)
      .toBe(RAVEN_SETTINGS_CEILINGS.draftMaxTokens)
  })

  it('refuses a malformed model route where the operator can still see the typo', () => {
    // A silently skipped entry made an all-typo list indistinguishable from an
    // intentionally empty one, and the operator was told "no route is configured".
    expect(() => Config({ draftRoutes: ['noslash'] })).toThrow()
    expect(() => Config({ draftRoutes: ['/fast'] })).toThrow()
    expect(() => Config({ draftRoutes: ['alpha/'] })).toThrow()
    // A namespaced model id still passes: the split is on the FIRST slash.
    expect(Config({ draftRoutes: ['openrouter/deepseek/deepseek-chat'] }).draftRoutes)
      .toEqual(['openrouter/deepseek/deepseek-chat'])
    expect(() => Config({
      draftRoutes: Array.from({ length: RAVEN_SETTINGS_CEILINGS.draftRoutes + 1 }, (_item, index) => `p${index}/m`),
    })).toThrow()
  })
})
