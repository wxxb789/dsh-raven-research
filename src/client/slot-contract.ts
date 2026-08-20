/**
 * The `settings.plugin.item` slot contract, vendored.
 *
 * The declaring package's own `slot-contract.ts` is not importable across the
 * client bundle-purity boundary, and the published copy of that package lags
 * the running Harness: at `0.1.0-rc.6` the slot is declared `kind: 'list'`,
 * while the Harness this plugin targets (`0.1.0-rc.8`) declares `kind: 'keyed'`
 * with the settings namespace as the key. Registering under the older shape
 * would compile and then never render.
 *
 * So the augmentation is restated here, against the version Raven targets. This
 * is a real coupling to an unpublished contract and it is deliberate: the
 * alternative is a card that silently does not appear. `scripts/verify-dsh.ts`
 * asserts this shape against the Harness checkout under test, so a drift breaks
 * the release gate instead of the browser.
 * @module
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One plugin's card inside the configurable-plugins tab, keyed by its settings namespace. */
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: { children?: never } }
  }
}

export {}
