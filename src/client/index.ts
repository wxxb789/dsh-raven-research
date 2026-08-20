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
import type {} from './slot-contract.js'

/**
 * The namespace the Host half registers. Spelled here rather than imported from
 * the Host half: a browser bundle that reached into the Node entry would drag
 * its Node imports into the page.
 */
export const RAVEN_NAMESPACE = 'raven-research'

export const name = 'raven-research/client'
export const inject = ['slots', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const controller = new RavenCardController(
    ctx.settingsScope.bind({ namespace: RAVEN_NAMESPACE }) as SettingsScope<Record<string, unknown>>,
  )
  ctx.effect(() => () => { controller.dispose() }, 'raven-research: settings card scope')
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: RAVEN_NAMESPACE,
      inject: () => controller.inject(),
    }, RavenSettingsCard)
  })
}
