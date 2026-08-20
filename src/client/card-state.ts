/**
 * The Raven settings card's form model — pure, synchronous, and free of React
 * and of any transport.
 *
 * The card chrome and staged-form machinery the Harness ships cannot be
 * imported: the client bundle-purity rule forbids a cross-plugin value import,
 * because it would either inline a duplicate runtime instance or require a
 * specifier the browser module table cannot answer. So this is a
 * reimplementation, and the whole point of putting it here is that a
 * reimplementation is exactly the thing most likely to drift — keeping it pure
 * means every rule in it is testable in Node, without a browser.
 *
 * It imports only `prose.js` and `route.js`, both dependency-free. Reaching for
 * the engine or the settings schema instead would drag `node:crypto` and the
 * Harness settings runtime into the browser bundle.
 * @module
 */

import { PROSE_FORMATS, PROSE_LAYOUTS } from '../prose.js'
import { parseDraftRoute, SOURCE_DISCOVERY_MODES, SOURCE_VERIFICATION_MODES } from '../route.js'

export type RavenFieldKind = 'choice' | 'natural' | 'routes'

export interface RavenFieldSpec {
  readonly name: string
  readonly kind: RavenFieldKind
  /** Present for a `choice` field: the exact accepted values, in display order. */
  readonly choices?: readonly string[]
}

/**
 * Every editable field, in the order the card renders them: what the evidence
 * is checked against first, then what discovery may spend, then how the writing
 * is shaped, then what drafting may spend.
 */
export const RAVEN_FIELDS: readonly RavenFieldSpec[] = [
  { name: 'sourceVerification', kind: 'choice', choices: SOURCE_VERIFICATION_MODES },
  { name: 'sourceCheckTimeoutMs', kind: 'natural' },
  { name: 'sourceDiscovery', kind: 'choice', choices: SOURCE_DISCOVERY_MODES },
  { name: 'searchMaxQueries', kind: 'natural' },
  { name: 'searchMaxResults', kind: 'natural' },
  { name: 'searchTimeoutMs', kind: 'natural' },
  { name: 'proseLayout', kind: 'choice', choices: PROSE_LAYOUTS },
  { name: 'proseFormat', kind: 'choice', choices: PROSE_FORMATS },
  { name: 'draftRoutes', kind: 'routes' },
  { name: 'draftMaxTokens', kind: 'natural' },
  { name: 'draftTimeoutMs', kind: 'natural' },
]

const SPEC_BY_NAME = new Map(RAVEN_FIELDS.map(field => [field.name, field]))

/** Snapshot shape this card reads, narrowed to the fields it uses. */
export interface RavenScopeSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: Record<string, unknown> | undefined
  readonly user: unknown
  readonly writable: boolean
  readonly mode: 'host' | 'memory'
}

export interface RavenFieldState {
  readonly name: string
  readonly kind: RavenFieldKind
  readonly choices: readonly string[]
  /** Exactly what the input shows: the staged edit when one exists, else the accepted value. */
  readonly text: string
  /**
   * Whether the user layer carries this key.
   *
   * Derived from PRESENCE, never from comparing values: an override that happens
   * to equal the composition default is still an override, and a value
   * comparison cannot see it. This is the single most likely bug in a
   * hand-rolled card, so it has its own test.
   */
  readonly overridden: boolean
  readonly edited: boolean
  readonly invalid: boolean
}

export interface RavenCardState {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly writable: boolean
  readonly memory: boolean
  readonly dirty: boolean
  /** True when at least one staged edit cannot be parsed; saving is refused. */
  readonly invalid: boolean
  readonly fields: readonly RavenFieldState[]
}

export type ParsedField =
  | { readonly ok: true; readonly value: string | number | string[] }
  | { readonly ok: false }

/** Parse one field's editor text into the JSON value the Host stores. */
export function parseFieldText(name: string, text: string): ParsedField {
  const spec = SPEC_BY_NAME.get(name)
  if (spec === undefined) return { ok: false }
  if (spec.kind === 'choice') {
    return spec.choices?.includes(text) === true ? { ok: true, value: text } : { ok: false }
  }
  if (spec.kind === 'natural') {
    const trimmed = text.trim()
    // Deliberately not Number(): that accepts '', '1e3', '0x10', ' 1.0 ', and
    // Infinity, and the Host schema would then reject a value the card called valid.
    if (!/^\d+$/.test(trimmed)) return { ok: false }
    const parsed = Number.parseInt(trimmed, 10)
    return Number.isSafeInteger(parsed) ? { ok: true, value: parsed } : { ok: false }
  }
  const routes = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  return routes.every(route => parseDraftRoute(route) !== undefined)
    ? { ok: true, value: routes }
    : { ok: false }
}

/** Render one stored value back into editor text. */
export function fieldText(name: string, value: unknown): string {
  const spec = SPEC_BY_NAME.get(name)
  if (spec?.kind === 'routes') {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : ''
  }
  if (value === undefined || value === null) return ''
  return typeof value === 'object' ? '' : String(value)
}

/**
 * Project one snapshot plus the staged edits into what the card renders.
 *
 * A field with no staged edit shows the accepted value, so a change committed
 * elsewhere — another browser, a hand edit of settings.yaml — appears here
 * without discarding what this user is in the middle of typing.
 */
export function projectCardState(
  snapshot: RavenScopeSnapshot,
  edits: ReadonlyMap<string, string>,
): RavenCardState {
  const user = typeof snapshot.user === 'object' && snapshot.user !== null && !Array.isArray(snapshot.user)
    ? snapshot.user as Record<string, unknown>
    : {}
  const fields = RAVEN_FIELDS.map((spec): RavenFieldState => {
    const staged = edits.get(spec.name)
    const text = staged ?? fieldText(spec.name, snapshot.value?.[spec.name])
    return {
      name: spec.name,
      kind: spec.kind,
      choices: spec.choices ?? [],
      text,
      overridden: Object.hasOwn(user, spec.name),
      edited: staged !== undefined,
      invalid: staged !== undefined && !parseFieldText(spec.name, staged).ok,
    }
  })
  return {
    status: snapshot.status,
    // Memory mode never accepts writes, so the card must render read-only
    // rather than offer a Save that silently does nothing.
    writable: snapshot.writable && snapshot.mode === 'host',
    memory: snapshot.mode === 'memory',
    dirty: edits.size > 0,
    invalid: fields.some(field => field.invalid),
    fields,
  }
}

/**
 * The writes one Save performs: every staged edit that parses, in field order.
 *
 * Returns nothing at all when any edit is invalid. Saving the valid half of a
 * form would leave the namespace in a state the user never asked for and never
 * saw, which is worse than refusing the whole Save.
 */
export function plannedWrites(
  edits: ReadonlyMap<string, string>,
): readonly { readonly name: string; readonly value: string | number | string[] }[] | undefined {
  const writes: { name: string; value: string | number | string[] }[] = []
  for (const spec of RAVEN_FIELDS) {
    const staged = edits.get(spec.name)
    if (staged === undefined) continue
    const parsed = parseFieldText(spec.name, staged)
    if (!parsed.ok) return undefined
    writes.push({ name: spec.name, value: parsed.value })
  }
  return writes
}
