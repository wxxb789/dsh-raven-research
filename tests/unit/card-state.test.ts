import { describe, expect, it } from 'vitest'

import {
  fieldText,
  parseFieldText,
  plannedWrites,
  projectCardState,
  RAVEN_FIELDS,
  type RavenScopeSnapshot,
} from '../../src/client/card-state.js'

const ready: RavenScopeSnapshot = {
  status: 'ready',
  value: {
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
  },
  user: {},
  writable: true,
  mode: 'host',
}

const field = (state: ReturnType<typeof projectCardState>, name: string) =>
  state.fields.find(entry => entry.name === name)

describe('Raven settings card fields', () => {
  it('offers every field the Host schema declares, and nothing else', () => {
    expect(RAVEN_FIELDS.map(spec => spec.name)).toEqual(Object.keys(ready.value ?? {}))
  })

  it('accepts only the declared choices', () => {
    expect(parseFieldText('proseLayout', 'as-written')).toEqual({ ok: true, value: 'as-written' })
    expect(parseFieldText('proseLayout', 'one-per-line').ok).toBe(false)
    expect(parseFieldText('sourceVerification', 'trust-me').ok).toBe(false)
  })

  it('accepts only a natural number, refusing everything Number() would have taken', () => {
    expect(parseFieldText('searchTimeoutMs', '30000')).toEqual({ ok: true, value: 30_000 })
    expect(parseFieldText('searchTimeoutMs', '0')).toEqual({ ok: true, value: 0 })
    for (const rejected of ['', ' ', '-1', '1.5', '1e3', '0x10', 'Infinity', 'NaN', '1,000']) {
      expect(parseFieldText('searchTimeoutMs', rejected).ok).toBe(false)
    }
  })

  it('accepts one provider/model route per line and refuses a malformed one', () => {
    expect(parseFieldText('draftRoutes', 'alpha/fast\nbeta/org/deep-v2'))
      .toEqual({ ok: true, value: ['alpha/fast', 'beta/org/deep-v2'] })
    expect(parseFieldText('draftRoutes', '')).toEqual({ ok: true, value: [] })
    expect(parseFieldText('draftRoutes', 'alpha/fast\nnoslash').ok).toBe(false)
    expect(parseFieldText('draftRoutes', '/fast').ok).toBe(false)
  })

  it('round-trips a stored value through the editor text', () => {
    expect(fieldText('draftRoutes', ['alpha/fast', 'beta/deep'])).toBe('alpha/fast\nbeta/deep')
    expect(fieldText('searchTimeoutMs', 30_000)).toBe('30000')
    expect(fieldText('proseLayout', 'as-written')).toBe('as-written')
    expect(fieldText('searchTimeoutMs', undefined)).toBe('')
  })
})

describe('Raven settings card projection', () => {
  it('shows the accepted value where nothing is staged', () => {
    const state = projectCardState(ready, new Map())
    expect(state.status).toBe('ready')
    expect(state.dirty).toBe(false)
    expect(state.invalid).toBe(false)
    expect(field(state, 'proseLayout')?.text).toBe('sentence-per-line')
    expect(field(state, 'searchTimeoutMs')?.text).toBe('30000')
  })

  it('marks a field overridden by its PRESENCE in the user layer, not by comparing values', () => {
    // The user layer sets the field to exactly the composition default. A value
    // comparison would call this "not overridden" and hide the reset control.
    const state = projectCardState({ ...ready, user: { proseLayout: 'sentence-per-line' } }, new Map())
    expect(field(state, 'proseLayout')?.overridden).toBe(true)
    expect(field(state, 'proseFormat')?.overridden).toBe(false)
  })

  it('treats a non-object user layer as no overrides rather than throwing', () => {
    for (const user of [undefined, null, 'nonsense', 42, ['a']]) {
      const state = projectCardState({ ...ready, user }, new Map())
      expect(state.fields.every(entry => !entry.overridden)).toBe(true)
    }
  })

  it('shows a staged edit and marks it invalid without losing what was typed', () => {
    const state = projectCardState(ready, new Map([['searchTimeoutMs', '30_000']]))
    const edited = field(state, 'searchTimeoutMs')
    expect(edited?.text).toBe('30_000')
    expect(edited?.edited).toBe(true)
    expect(edited?.invalid).toBe(true)
    expect(state.dirty).toBe(true)
    expect(state.invalid).toBe(true)
  })

  it('keeps an unstaged field live while another field is being edited', () => {
    const staged = new Map([['proseLayout', 'as-written']])
    const moved = projectCardState(
      { ...ready, value: { ...ready.value, searchTimeoutMs: 5_000 } },
      staged,
    )
    expect(field(moved, 'searchTimeoutMs')?.text).toBe('5000')
    expect(field(moved, 'proseLayout')?.text).toBe('as-written')
  })

  it('renders read-only in memory mode, where a Save could never take effect', () => {
    const state = projectCardState({ ...ready, mode: 'memory', writable: true }, new Map())
    expect(state.writable).toBe(false)
    expect(state.memory).toBe(true)
  })

  it('renders read-only when the Host document refuses writes', () => {
    expect(projectCardState({ ...ready, writable: false }, new Map()).writable).toBe(false)
  })
})

describe('Raven settings card save plan', () => {
  it('writes every staged edit in field order', () => {
    expect(plannedWrites(new Map([
      ['draftRoutes', 'alpha/fast'],
      ['proseLayout', 'as-written'],
    ]))).toEqual([
      { name: 'proseLayout', value: 'as-written' },
      { name: 'draftRoutes', value: ['alpha/fast'] },
    ])
  })

  it('writes nothing at all when any staged edit is invalid', () => {
    // Half-saving would leave the namespace in a state the user never asked for
    // and never saw.
    expect(plannedWrites(new Map([
      ['proseLayout', 'as-written'],
      ['searchTimeoutMs', 'soon'],
    ]))).toBeUndefined()
  })

  it('plans nothing when nothing is staged', () => {
    expect(plannedWrites(new Map())).toEqual([])
  })
})
