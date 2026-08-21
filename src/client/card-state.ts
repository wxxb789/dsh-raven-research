/**
 * The Raven settings card's form model — pure, synchronous, and free of React
 * and of any transport.
 *
 * What the card may accept is NOT decided here. The fields, their kinds, their
 * accepted values, and their bounds are read from the schema the Host half
 * registered the namespace with, and every draft is judged by the Harness's own
 * `settingsSchema.validate`. This module owns only what a schema cannot answer:
 * how a text box becomes a JSON value, which staged edit is a real change, and
 * what one Save would write.
 *
 * That split is the point. A card that restated the schema's rules would be a
 * second source of truth for "is this acceptable", and the two would drift on
 * the first bound anyone edited in `config.ts`.
 *
 * The module stays pure so every rule in it is testable in Node, without a
 * browser, and it reaches for nothing but its own types.
 * @module
 */

import type { RavenSchemaNode, RavenSettingsSchemaService } from './slot-contract.js'

export type RavenFieldKind = 'choice' | 'number' | 'routes' | 'text'

/**
 * Which decision a row belongs to. Eleven controls in one flat list read as a
 * wall of numbers; the group is what says whether a row is about evidence,
 * about spend, or about how the writing is shaped.
 *
 * The schema carries no group, order, or title metadata — the Harness's own
 * cards take all three from locale keys and slot order for the same reason — so
 * this table is local. A field the schema declares and this table does not
 * lands in `other`, which renders rather than disappearing.
 */
export type RavenFieldGroup = 'evidence' | 'discovery' | 'prose' | 'draft' | 'other'

/** The groups in render order. */
export const RAVEN_GROUPS: readonly RavenFieldGroup[] = ['evidence', 'discovery', 'prose', 'draft', 'other']

/** Which group each known field renders under. */
export const RAVEN_FIELD_GROUPS: Readonly<Record<string, RavenFieldGroup>> = {
  sourceVerification: 'evidence',
  sourceCheckTimeoutMs: 'evidence',
  sourceDiscovery: 'discovery',
  searchMaxQueries: 'discovery',
  searchMaxResults: 'discovery',
  searchTimeoutMs: 'discovery',
  proseLayout: 'prose',
  proseFormat: 'prose',
  draftRoutes: 'draft',
  draftMaxTokens: 'draft',
  draftTimeoutMs: 'draft',
}

/**
 * The one field whose accepted values the schema genuinely cannot express.
 *
 * `draftRoutes` is `array(string)`, so the Host accepts any strings at all — and
 * the engine then skips every entry that is not `provider/model` rather than
 * failing. A card that let such a value through would be offering a Save whose
 * effect is silence, so the shape is checked here and reported as this card's
 * own rule, not as the Host's.
 */
export const ROUTE_FIELD = 'draftRoutes'

/** Whether one line is a `provider/model` route, split on the FIRST slash. */
function isRoute(line: string): boolean {
  const slash = line.indexOf('/')
  return slash > 0 && slash < line.length - 1
}

export interface RavenFieldSpec {
  readonly name: string
  readonly kind: RavenFieldKind
  readonly group: RavenFieldGroup
  /** Present for a `choice` field: the exact accepted values, in schema order. */
  readonly choices: readonly string[]
  /** The field's own schema node, which is what judges a draft. */
  readonly node: RavenSchemaNode
}

/**
 * Read the editable fields out of the registered schema, in declaration order.
 *
 * Declaration order is the schema's own: a Schemastery `object` node keeps its
 * properties in a plain record, and string keys iterate in insertion order.
 * @param root - the namespace's rehydrated root node.
 * @returns one spec per property, or nothing when the node is not an object.
 */
export function describeFields(root: RavenSchemaNode | undefined): readonly RavenFieldSpec[] {
  const dict = root?.type === 'object' ? root.dict : undefined
  if (dict === undefined) return []
  return Object.entries(dict).map(([name, node]): RavenFieldSpec => {
    const consts = node.type === 'union' ? (node.list ?? []).filter(member => member.type === 'const') : []
    const choice = consts.length > 0 && consts.length === (node.list ?? []).length
    return {
      name,
      kind: choice ? 'choice' : node.type === 'array' ? 'routes' : node.type === 'number' ? 'number' : 'text',
      group: RAVEN_FIELD_GROUPS[name] ?? 'other',
      choices: choice ? consts.map(member => String(member.value)) : [],
      node,
    }
  })
}

/** Snapshot shape this card reads, narrowed to the fields it uses. */
export interface RavenScopeSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: Record<string, unknown> | undefined
  /** The composition layer — what a cleared field re-inherits. */
  readonly base?: unknown
  readonly user: unknown
  readonly writable: boolean
  readonly mode: 'host' | 'memory'
}

/**
 * One field's staged edit.
 *
 * `clear` is carried separately from the text because the two are different
 * intents that can show the same characters: a reset seeds the control with the
 * value the field will re-inherit, and that text is exactly what an ordinary
 * edit restating the composition default would contain.
 */
export interface RavenStagedEdit {
  readonly text: string
  /** True when this edit removes the user-layer entry, whatever text it shows. */
  readonly clear: boolean
}

export interface RavenFieldState {
  readonly name: string
  readonly kind: RavenFieldKind
  readonly group: RavenFieldGroup
  readonly choices: readonly string[]
  /** Exactly what the input shows: the staged edit when one exists, else the accepted value. */
  readonly text: string
  /**
   * Whether saving would leave a user-layer entry for this field.
   *
   * With nothing staged this is the PRESENCE of the key in the user layer, never
   * a comparison of values: an override that happens to equal the composition
   * default is still an override, and a value comparison cannot see it. With an
   * edit staged the badge previews the save instead of reporting a state the
   * pending edit already contradicts.
   */
  readonly overridden: boolean
  readonly edited: boolean
  /**
   * Why the draft is not acceptable, or undefined when it is. Normally the
   * Harness schema's own words; `routeShape` marks this card's one local rule.
   */
  readonly failure: { readonly kind: 'schema'; readonly message: string } | { readonly kind: 'routeShape' } | undefined
}

/** Card-level state the controller owns rather than the snapshot. */
export interface RavenCardShell {
  /** Whether the card is disclosing its controls. */
  readonly open: boolean
  /** Whether a save is crossing the wire. */
  readonly saving: boolean
  /** Whether the last save did not land as staged. */
  readonly failed: boolean
}

export interface RavenCardState extends RavenCardShell {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly writable: boolean
  readonly memory: boolean
  readonly dirty: boolean
  /** True when at least one staged edit is unacceptable; saving is refused. */
  readonly invalid: boolean
  readonly fields: readonly RavenFieldState[]
}

/**
 * Turn one control's text into the JSON value the Host would store.
 *
 * A malformed number is deliberately handed on as the raw string rather than
 * withheld: the schema then reports why in its own words, instead of this
 * module inventing a bound it would have to keep in step with `config.ts`.
 */
export function draftValue(spec: RavenFieldSpec, text: string): unknown {
  if (spec.kind === 'routes') {
    return text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  }
  if (spec.kind !== 'number') return text
  const trimmed = text.trim()
  return /^[+-]?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed
}

/** Render one stored value back into control text. */
export function fieldText(spec: RavenFieldSpec | undefined, value: unknown): string {
  if (spec?.kind === 'routes') {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : ''
  }
  if (value === undefined || value === null) return ''
  return typeof value === 'object' ? '' : String(value)
}

/** Why one draft is unacceptable, asking the Host's schema first. */
function judge(
  schema: RavenSettingsSchemaService,
  spec: RavenFieldSpec,
  text: string,
): RavenFieldState['failure'] {
  const value = draftValue(spec, text)
  const message = schema.validate(spec.node, value)
  if (message !== undefined) return { kind: 'schema', message }
  if (spec.name !== ROUTE_FIELD) return undefined
  return (value as string[]).every(isRoute) ? undefined : { kind: 'routeShape' }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * The control text a reset seeds, so it previews the composition layer instead
 * of blanking and implying the setting is about to disappear.
 */
export function inheritedText(
  snapshot: RavenScopeSnapshot,
  spec: RavenFieldSpec,
): string {
  return fieldText(spec, record(snapshot.base)[spec.name])
}

/**
 * Project one snapshot plus the staged edits into what the card renders.
 *
 * A field with no staged edit shows the accepted value, so a change committed
 * elsewhere — another browser, a hand edit of settings.yaml — appears here
 * without discarding what this user is in the middle of typing.
 */
export function projectCardState(
  schema: RavenSettingsSchemaService,
  specs: readonly RavenFieldSpec[],
  snapshot: RavenScopeSnapshot,
  edits: ReadonlyMap<string, RavenStagedEdit>,
  shell: RavenCardShell,
): RavenCardState {
  const fields = specs.map((spec): RavenFieldState => {
    const staged = edits.get(spec.name)
    const failure = staged === undefined || staged.clear ? undefined : judge(schema, spec, staged.text)
    return {
      name: spec.name,
      kind: spec.kind,
      group: spec.group,
      choices: spec.choices,
      text: staged?.text ?? fieldText(spec, snapshot.value?.[spec.name]),
      overridden: staged === undefined
        ? schema.hasPath(snapshot.user, [spec.name])
        : !staged.clear && failure === undefined,
      edited: staged !== undefined,
      failure,
    }
  })
  return {
    ...shell,
    status: snapshot.status,
    // Memory mode never accepts writes, so the card must render read-only
    // rather than offer a Save that silently does nothing.
    writable: snapshot.writable && snapshot.mode === 'host',
    memory: snapshot.mode === 'memory',
    dirty: planEdits(schema, specs, snapshot, edits).length > 0,
    invalid: fields.some(field => field.failure !== undefined),
    fields,
  }
}

/** One write a Save performs. */
export type RavenWrite =
  | { readonly name: string; readonly op: 'set'; readonly value: unknown }
  | { readonly name: string; readonly op: 'clear' }

/**
 * Every staged edit that would change what the Host holds, in field order,
 * including the ones carrying no runnable write because the draft is not
 * acceptable.
 *
 * A draft restating what the section already carries is not a change, so
 * retyping a value is not an edit; neither is clearing a field the user layer
 * never carried, however that clear was staged. An unacceptable draft stays in
 * the plan, which is what keeps the form dirty and makes the Save refuse rather
 * than quietly drop it.
 */
function planEdits(
  schema: RavenSettingsSchemaService,
  specs: readonly RavenFieldSpec[],
  snapshot: RavenScopeSnapshot,
  edits: ReadonlyMap<string, RavenStagedEdit>,
): readonly (RavenWrite | undefined)[] {
  const planned: (RavenWrite | undefined)[] = []
  for (const spec of specs) {
    const staged = edits.get(spec.name)
    if (staged === undefined) continue
    if (staged.clear) {
      if (schema.hasPath(snapshot.user, [spec.name])) planned.push({ name: spec.name, op: 'clear' })
      continue
    }
    if (staged.text === fieldText(spec, snapshot.value?.[spec.name])) continue
    planned.push(judge(schema, spec, staged.text) === undefined
      ? { name: spec.name, op: 'set', value: draftValue(spec, staged.text) }
      : undefined)
  }
  return planned
}

/**
 * The writes one Save performs, or nothing at all when any staged edit is
 * unacceptable. Saving the valid half of a form would leave the namespace in a
 * state the user never asked for and never saw, which is worse than refusing
 * the whole Save.
 */
export function plannedWrites(
  schema: RavenSettingsSchemaService,
  specs: readonly RavenFieldSpec[],
  snapshot: RavenScopeSnapshot,
  edits: ReadonlyMap<string, RavenStagedEdit>,
): readonly RavenWrite[] | undefined {
  const planned = planEdits(schema, specs, snapshot, edits)
  return planned.every(entry => entry !== undefined) ? planned : undefined
}
