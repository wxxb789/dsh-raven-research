/**
 * The browser contracts this card rides, vendored.
 *
 * None of these can be imported. The package declaring `settings.plugin.item`
 * is not on the browser module table, and its published copy lags the running
 * Harness: at `0.1.0-rc.6` — still the newest version published — the slot is
 * declared `kind: 'list'`, while the Harness this plugin targets (`0.1.1-rc.1`)
 * declares `kind: 'keyed'` with the settings namespace as the key. Registering
 * under the older shape would compile and then never render. The locale runtime
 * and the settings schema service are platform entities the shell answers at
 * load time, and both gained their current shape after rc.6, so the slivers this
 * card calls are declared rather than imported.
 *
 * So the augmentations are restated here, against the version Raven targets.
 * This is a real coupling to unpublished contracts and it is deliberate: the
 * alternative is a card that silently does not appear, whose copy never
 * resolves, or that judges values by rules the Host does not share.
 * `scripts/verify-dsh.ts` asserts every one of these shapes against the Harness
 * checkout under test, so a drift breaks the release gate instead of the
 * browser.
 * @module
 */

import type { RavenCardKey } from './locales.js'

/** The shipped locales; the registry requires every one of them in one call. */
export type RavenLocaleId = 'en' | 'zh'

/** The sliver of the browser locale runtime this card calls. */
export interface RavenLocaleRuntime {
  /**
   * Register this card's dictionaries, all locales in one call.
   * @param namespace - the namespace declared in `LocaleNamespaceMap`.
   * @param dictionaries - complete dictionaries keyed by locale id.
   * @returns the disposer removing every locale this call registered.
   */
  register(
    namespace: 'settings.raven-research',
    dictionaries: Record<RavenLocaleId, Record<RavenCardKey, string>>,
  ): () => void
}

/**
 * One Schemastery node, narrowed to what this card reads.
 *
 * Declared structurally rather than imported: Schemastery is a real dependency
 * of the Host half, but pulling it into the browser bundle to read four fields
 * would inline a validator the Host already runs on this card's behalf.
 */
export interface RavenSchemaNode {
  /** Node kind: `object`, `union`, `array`, `number`, `string`, `const`, … */
  readonly type: string
  /** Union members; a `const` member carries its accepted value in `value`. */
  readonly list?: readonly RavenSchemaNode[]
  /** Element schema of an `array` node. */
  readonly inner?: RavenSchemaNode
  /** Property schemas of an `object` node, in declaration order. */
  readonly dict?: Readonly<Record<string, RavenSchemaNode>>
  /** The accepted value of a `const` node. */
  readonly value?: unknown
  readonly meta?: { readonly default?: unknown }
}

/**
 * The sliver of the Harness's own settings schema service this card calls.
 *
 * Its class doc states the intent this card is taking up: "Dynamic client
 * plugins receive this Cordis entity instead of importing executable helpers
 * from one another."
 */
export interface RavenSettingsSchemaService {
  /**
   * Rehydrate one serialized `schema.toJSON()` envelope. The envelope is
   * reference-preserving (`{ uid, refs }`), so it cannot be read without this.
   * @param serialized - the envelope carried on the namespace's describe row.
   */
  rehydrate(serialized: unknown): RavenSchemaNode
  /**
   * Validate a draft against a schema node.
   * @param schema - the node to validate against.
   * @param draft - the candidate value.
   * @returns the failure text, or `undefined` when the draft is acceptable.
   */
  validate(schema: RavenSchemaNode, draft: unknown): string | undefined
  /**
   * Resolve the schema node at a settings path.
   * @param root - the namespace's root node.
   * @param path - object keys or array indexes.
   */
  nodeAtPath(root: RavenSchemaNode, path: readonly string[]): RavenSchemaNode | undefined
  /**
   * Report whether the final path key exists, independently of its value —
   * which is exactly what marks a field overridden.
   * @param value - the layer to traverse, typically the raw user layer.
   * @param path - object keys or array indexes.
   */
  hasPath(value: unknown, path: readonly string[]): boolean
}

/** One namespace row of the shared `settings.describe` mirror. */
export interface RavenNamespaceView {
  readonly ns: string
  /** The serialized schema envelope this namespace was registered with. */
  readonly schema: unknown
}

/**
 * The shared describe mirror's read face — the Harness documents it as the one
 * for "cross-namespace surfaces (schema introspection, the served-namespace
 * directory)", which is how this card reaches its own registered schema.
 */
export interface RavenSettingsDescribeFace {
  getSnapshot(): {
    readonly status: 'idle' | 'loading' | 'ready' | 'unavailable'
    readonly view: { readonly namespaces: readonly RavenNamespaceView[] } | undefined
  }
  subscribe(listener: () => void): () => void
}

/**
 * `settingsScope.describe()` exists on the running Harness but not in the
 * published typings this package compiles against, so the call site narrows
 * through this shape rather than through `ctx.settingsScope`'s declared type.
 */
export interface RavenSettingsScopeBinderLike {
  describe(): RavenSettingsDescribeFace
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One plugin's card inside the configurable-plugins tab, keyed by its settings namespace. */
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: { children?: never } }
  }

  interface LocaleNamespaceMap {
    /**
     * Raven's card copy. Declaring it is what puts the framework-synthesized
     * `t` seat, typed to these keys, on the card's props.
     */
    'settings.raven-research': RavenCardKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    locale: RavenLocaleRuntime
    settingsSchema: RavenSettingsSchemaService
  }
}
