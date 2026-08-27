import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'

import {
  describeFields,
  draftValue,
  fieldText,
  inheritedText,
  plannedWrites,
  projectCardState,
  RAVEN_FIELD_GROUPS,
  RAVEN_GROUPS,
  ROUTE_FIELD,
  type RavenCardShell,
  type RavenFieldSpec,
  type RavenScopeSnapshot,
  type RavenStagedEdit,
} from '../../src/client/card-state.js'
import { en, zh } from '../../src/client/locales.js'
import type { RavenSchemaNode, RavenSettingsSchemaService } from '../../src/client/slot-contract.js'
import { Config } from '../../src/config.js'

/**
 * A stand-in for the Harness's `ctx.settingsSchema`, mirroring
 * `packages/client/ui-settings/src/client/schema.ts` method for method.
 *
 * Deliberately the real Schemastery rather than a fake: the whole point of the
 * card reading its rules from the registered schema is that the rules are the
 * Host's, so a test that stubbed them would prove nothing about the drift this
 * design exists to prevent.
 */
const schema: RavenSettingsSchemaService = {
  rehydrate: serialized => new (Schema as never as new (value: unknown) => RavenSchemaNode)(serialized),
  validate: (node, draft) => {
    try {
      ;(node as unknown as (value: unknown) => unknown)(draft)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  },
  nodeAtPath: (root, path) => {
    let node: RavenSchemaNode | undefined = root
    for (const key of path) {
      if (node === undefined) return undefined
      node = node.type === 'object' ? node.dict?.[key] : undefined
    }
    return node
  },
  hasPath: (value, path) => {
    if (path.length === 0) return value !== undefined
    if (typeof value !== 'object' || value === null) return false
    return (path[path.length - 1] as string) in value
  },
}

/** Exactly the envelope the wire carries: `toJSON()`, serialized and parsed. */
const wire = JSON.parse(JSON.stringify(Config.toJSON())) as unknown
const specs = describeFields(schema.rehydrate(wire))
const specOf = (name: string): RavenFieldSpec => {
  const spec = specs.find(entry => entry.name === name)
  if (spec === undefined) throw new Error(`no spec for ${name}`)
  return spec
}

const shell: RavenCardShell = { open: true, saving: false, failed: false }

const ready: RavenScopeSnapshot = {
  status: 'ready',
  value: {
    guidance: 'auto',
    sourceVerification: 'remote',
    sourceNetworkPolicy: 'public-only',
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
  },
  base: { proseLayout: 'sentence-per-line', searchTimeoutMs: 30_000 },
  user: {},
  writable: true,
  mode: 'host',
}

const staged = (entries: Record<string, RavenStagedEdit>): Map<string, RavenStagedEdit> =>
  new Map(Object.entries(entries))
const set = (text: string): RavenStagedEdit => ({ text, clear: false })
const clear = (text: string): RavenStagedEdit => ({ text, clear: true })

const project = (
  snapshot: RavenScopeSnapshot,
  edits: Map<string, RavenStagedEdit> = new Map(),
) => projectCardState(schema, specs, snapshot, edits, shell)

const field = (state: ReturnType<typeof project>, name: string) =>
  state.fields.find(entry => entry.name === name)

const plan = (snapshot: RavenScopeSnapshot, edits: Map<string, RavenStagedEdit>) =>
  plannedWrites(schema, specs, snapshot, edits)

describe('Raven settings card fields, read from the registered schema', () => {
  it('derives every field the Host schema declares, in declaration order', () => {
    // Not a list this card maintains: adding a field to `Config` must make it
    // appear here without touching the browser half.
    expect(specs.map(spec => spec.name)).toEqual(Object.keys(ready.value ?? {}))
  })

  it('derives each control kind from the schema node, not from a local table', () => {
    expect(specOf('sourceVerification').kind).toBe('choice')
    expect(specOf('searchTimeoutMs').kind).toBe('number')
    expect(specOf('draftRoutes').kind).toBe('routes')
  })

  it('derives the accepted choices from the schema union', () => {
    expect(specOf('guidance').choices).toEqual(['auto', 'off'])
    expect(specOf('proseLayout').choices).toEqual(['sentence-per-line', 'as-written'])
    expect(specOf('sourceDiscovery').choices).toEqual(['seam', 'disabled'])
    expect(specOf('searchTimeoutMs').choices).toEqual([])
  })

  it('files every field under a group, and every declared group is reachable', () => {
    for (const spec of specs) expect(RAVEN_GROUPS).toContain(spec.group)
    // A field the schema declares and the group table does not must still
    // render rather than vanish.
    expect(RAVEN_FIELD_GROUPS['not-a-field']).toBeUndefined()
    expect(describeFields({
      type: 'object',
      dict: { surprise: { type: 'string' } },
    })[0]?.group).toBe('other')
  })

  it('describes nothing at all when the envelope is not an object schema', () => {
    expect(describeFields(undefined)).toEqual([])
    expect(describeFields({ type: 'string' })).toEqual([])
  })
})

describe('Raven settings card drafts', () => {
  it('hands a well-formed number to the schema as a number', () => {
    expect(draftValue(specOf('searchTimeoutMs'), ' 30000 ')).toBe(30_000)
  })

  it('hands a malformed number on as text, so the schema reports why', () => {
    // The card states no bound of its own; `config.ts` owns them.
    expect(draftValue(specOf('searchTimeoutMs'), 'soon')).toBe('soon')
    const state = project(ready, staged({ searchTimeoutMs: set('soon') }))
    expect(field(state, 'searchTimeoutMs')?.failure).toEqual({
      kind: 'schema',
      message: expect.stringContaining('expected number'),
    })
  })

  it('lets the schema refuse a negative and a fractional value in its own words', () => {
    const negative = project(ready, staged({ searchTimeoutMs: set('-1') }))
    expect(field(negative, 'searchTimeoutMs')?.failure?.kind).toBe('schema')
    const fractional = project(ready, staged({ searchTimeoutMs: set('1.5') }))
    expect(field(fractional, 'searchTimeoutMs')?.failure?.kind).toBe('schema')
    expect(project(ready, staged({ searchTimeoutMs: set('0') })).invalid).toBe(false)
  })

  it('splits routes per line and reports the one rule the schema cannot express', () => {
    expect(draftValue(specOf(ROUTE_FIELD), 'alpha/fast\n\n beta/org/deep-v2 '))
      .toEqual(['alpha/fast', 'beta/org/deep-v2'])
    // The Host schema now carries the route-shape pattern itself, so a malformed
    // entry is refused in the SCHEMA's own words rather than by this card's local
    // copy of the rule — which is the arrangement ADR 0005 asks for, and which is
    // what tells an operator WHICH entry is wrong instead of silently skipping it
    // and then reporting "no Draft Variant route is configured". The card keeps
    // `routeShape` as a backstop for a Harness whose schema service cannot express
    // the pattern; either way the draft is refused, which is what must not regress.
    const state = project(ready, staged({ draftRoutes: set('alpha/fast\nnoslash') }))
    expect(field(state, 'draftRoutes')?.failure?.kind).toMatch(/^(?:schema|routeShape)$/)
    expect(state.invalid).toBe(true)
    expect(project(ready, staged({ draftRoutes: set('/fast') })).invalid).toBe(true)
    expect(project(ready, staged({ draftRoutes: set('alpha/fast') })).invalid).toBe(false)
  })

  it('round-trips a stored value through the control text', () => {
    expect(fieldText(specOf('draftRoutes'), ['alpha/fast', 'beta/deep'])).toBe('alpha/fast\nbeta/deep')
    expect(fieldText(specOf('searchTimeoutMs'), 30_000)).toBe('30000')
    expect(fieldText(specOf('proseLayout'), 'as-written')).toBe('as-written')
    expect(fieldText(specOf('searchTimeoutMs'), undefined)).toBe('')
  })

  it('seeds a reset with the composition layer, not with a blank control', () => {
    expect(inheritedText(ready, specOf('searchTimeoutMs'))).toBe('30000')
    expect(inheritedText(ready, specOf('draftMaxTokens'))).toBe('')
  })
})

describe('Raven settings card copy', () => {
  it('ships the same key set in every locale, which registration requires', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('carries a label, a hint, and an option label for every schema field', () => {
    for (const spec of specs) {
      expect(en).toHaveProperty(spec.name)
      expect(en).toHaveProperty(`${spec.name}Hint`)
      for (const choice of spec.choices) expect(en).toHaveProperty(`choice.${choice}`)
    }
    for (const group of RAVEN_GROUPS) expect(en).toHaveProperty(`group.${group}`)
  })

  it('leaves no key resolving to an empty string in either locale', () => {
    for (const [key, text] of Object.entries({ ...en })) expect(text.length, key).toBeGreaterThan(0)
    for (const [key, text] of Object.entries({ ...zh })) expect(text.length, key).toBeGreaterThan(0)
  })
})

describe('Raven settings card projection', () => {
  it('shows the accepted value where nothing is staged', () => {
    const state = project(ready)
    expect(state.status).toBe('ready')
    expect(state.dirty).toBe(false)
    expect(state.invalid).toBe(false)
    expect(field(state, 'proseLayout')?.text).toBe('sentence-per-line')
    expect(field(state, 'searchTimeoutMs')?.text).toBe('30000')
  })

  it('carries the shell the controller owns rather than deriving it from the snapshot', () => {
    const state = projectCardState(schema, specs, ready, new Map(), { open: false, saving: true, failed: true })
    expect(state.open).toBe(false)
    expect(state.saving).toBe(true)
    expect(state.failed).toBe(true)
  })

  it('marks a field overridden by its PRESENCE in the user layer, not by comparing values', () => {
    // The user layer sets the field to exactly the composition default. A value
    // comparison would call this "not overridden" and hide the reset control.
    const state = project({ ...ready, user: { proseLayout: 'sentence-per-line' } })
    expect(field(state, 'proseLayout')?.overridden).toBe(true)
    expect(field(state, 'proseFormat')?.overridden).toBe(false)
  })

  it('treats a non-object user layer as no overrides rather than throwing', () => {
    for (const user of [undefined, null, 'nonsense', 42]) {
      const state = project({ ...ready, user })
      expect(state.fields.every(entry => !entry.overridden)).toBe(true)
    }
  })

  it('previews the save on the badge instead of reporting a state the edit contradicts', () => {
    const overridden = { ...ready, user: { proseLayout: 'as-written' } }
    expect(field(project(overridden, staged({ proseLayout: clear('sentence-per-line') })), 'proseLayout')?.overridden)
      .toBe(false)
    expect(field(project(ready, staged({ proseFormat: set('plain') })), 'proseFormat')?.overridden).toBe(true)
    expect(field(project(ready, staged({ searchTimeoutMs: set('soon') })), 'searchTimeoutMs')?.overridden)
      .toBe(false)
  })

  it('shows a staged edit and marks it unacceptable without losing what was typed', () => {
    const state = project(ready, staged({ searchTimeoutMs: set('30_000') }))
    const edited = field(state, 'searchTimeoutMs')
    expect(edited?.text).toBe('30_000')
    expect(edited?.edited).toBe(true)
    expect(edited?.failure?.kind).toBe('schema')
    expect(state.dirty).toBe(true)
    expect(state.invalid).toBe(true)
  })

  it('does not call a draft dirty when it restates what the Host already holds', () => {
    expect(project(ready, staged({ proseLayout: set('sentence-per-line') })).dirty).toBe(false)
    expect(project(ready, staged({ proseLayout: clear('sentence-per-line') })).dirty).toBe(false)
  })

  it('keeps an unstaged field live while another field is being edited', () => {
    const moved = project(
      { ...ready, value: { ...ready.value, searchTimeoutMs: 5_000 } },
      staged({ proseLayout: set('as-written') }),
    )
    expect(field(moved, 'searchTimeoutMs')?.text).toBe('5000')
    expect(field(moved, 'proseLayout')?.text).toBe('as-written')
  })

  it('renders read-only in memory mode, where a Save could never take effect', () => {
    const state = project({ ...ready, mode: 'memory', writable: true })
    expect(state.writable).toBe(false)
    expect(state.memory).toBe(true)
  })

  it('renders read-only when the Host document refuses writes', () => {
    expect(project({ ...ready, writable: false }).writable).toBe(false)
  })
})

describe('Raven settings card save plan', () => {
  it('writes every staged edit in field order', () => {
    expect(plan(ready, staged({
      draftRoutes: set('alpha/fast'),
      proseLayout: set('as-written'),
    }))).toEqual([
      { name: 'proseLayout', op: 'set', value: 'as-written' },
      { name: 'draftRoutes', op: 'set', value: ['alpha/fast'] },
    ])
  })

  it('writes a number as a number, which is what the schema accepted', () => {
    expect(plan(ready, staged({ searchTimeoutMs: set('45000') })))
      .toEqual([{ name: 'searchTimeoutMs', op: 'set', value: 45_000 }])
  })

  it('clears a field the user layer carries and skips one it never did', () => {
    expect(plan({ ...ready, user: { proseLayout: 'as-written' } }, staged({
      proseLayout: clear('sentence-per-line'),
      proseFormat: clear('markdown'),
    }))).toEqual([{ name: 'proseLayout', op: 'clear' }])
  })

  it('writes nothing at all when any staged edit is unacceptable', () => {
    // Half-saving would leave the namespace in a state the user never asked for
    // and never saw.
    expect(plan(ready, staged({
      proseLayout: set('as-written'),
      searchTimeoutMs: set('soon'),
    }))).toBeUndefined()
  })

  it('plans nothing when nothing is staged', () => {
    expect(plan(ready, new Map())).toEqual([])
  })
})
