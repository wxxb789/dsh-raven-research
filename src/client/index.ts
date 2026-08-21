/**
 * Raven's browser half: one card on the Settings › Plugins page.
 *
 * It contributes nothing else. The Task itself is a Host concern — the tool, the
 * evidence checks, the model calls, and the durable record all live there — and
 * a browser half that mirrored any of it would be a second copy of the truth.
 *
 * The card reaches the page through the keyed `settings.plugin.item` slot,
 * whose key is the settings namespace. That keying is precisely what lets a
 * plugin distributed outside the Harness repository contribute a card: the Host
 * half registers the namespace, this half registers a card under the same key,
 * and the tab pairs them without ever learning what the namespace means.
 * @module
 */

import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: merges `ctx.settingsScope` onto the browser Context. Erased at build,
// so it never reaches the bundle and never crosses the purity boundary.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

import { RavenSettingsCard } from './Card.js'
import { RavenCardController } from './controller.js'
import { en, RAVEN_LOCALE_NS, zh } from './locales.js'
import type { RavenSettingsScopeBinderLike } from './slot-contract.js'
import { injectCardStyles } from './styles.js'

// Module scope, and a call rather than a bare import: the loader claims plugin
// styles as soon as this factory returns, so the tag must exist by then, and
// this package declares `sideEffects: false`, under which a bundler may drop an
// import whose bindings nothing reads.
injectCardStyles()

/**
 * The namespace the Host half registers. Spelled here rather than imported from
 * the Host half: a browser bundle that reached into the Node entry would drag
 * its Node imports into the page.
 */
export const RAVEN_NAMESPACE = 'raven-research'

export { RAVEN_LOCALE_NS, en, zh } from './locales.js'
export type { RavenCardKey } from './locales.js'

export const name = 'raven-research/client'

/**
 * `settingsSchema` is what lets this card judge a draft by the schema the Host
 * actually registered instead of by rules restated here, so it is a
 * requirement rather than an enhancement: without it the card would have to
 * invent its own answer to "is this acceptable", which is the drift the
 * dependency exists to remove.
 */
export const inject = ['slots', 'settingsScope', 'settingsSchema', 'locale']

export function apply(ctx: ClientContext): void {
  const controller = new RavenCardController({
    scope: ctx.settingsScope.bind({ namespace: RAVEN_NAMESPACE }) as SettingsScope<Record<string, unknown>>,
    // `describe()` exists on the running Harness but not in the published
    // typings this package compiles against, so the binder is narrowed to the
    // one method rather than read through its declared type.
    describe: (ctx.settingsScope as unknown as RavenSettingsScopeBinderLike).describe(),
    schema: ctx.settingsSchema,
    namespace: RAVEN_NAMESPACE,
  })
  ctx.effect(() => () => { controller.dispose() }, 'raven-research: settings card scope')
  ctx.effect(() => ctx.locale.register(RAVEN_LOCALE_NS, { en, zh }), 'raven-research: card dictionaries')
  // inject() defers registration until the tab declares the slot, so this half
  // does not need the tab to exist yet — or ever.
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: RAVEN_NAMESPACE,
      locale: RAVEN_LOCALE_NS,
      inject: () => controller.inject(),
    }, RavenSettingsCard)
  })
}
