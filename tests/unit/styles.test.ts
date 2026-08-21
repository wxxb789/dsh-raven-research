import { describe, expect, it } from 'vitest'

import { RAVEN_CARD_CSS } from '../../src/client/styles.js'

/**
 * Rules about a stylesheet a card ships into a page it does not own.
 *
 * The card is rendered inside the Harness's plugin list, which is inside a
 * scrolling pane, which is inside a settings dialog that clips with
 * `overflow: hidden` and therefore has no scrollbar. This package sees none of
 * that, and cannot: those are host classes with hashed names. So the two things
 * it must guarantee are structural rather than cosmetic — the stylesheet may
 * not reach outside the card, and the card may not place anything outside
 * itself.
 *
 * Both were violated once. `.dsh-raven-card__radio` was `position: absolute`
 * inside a label that was not positioned, so its containing block resolved past
 * the plugin list — which is not positioned either — all the way to the
 * settings dialog. The zero-size controls escaped the list's clip, inflated the
 * dialog's scroll height, and the first click on a choice focused one, at which
 * point the browser scrolled the dialog to reveal it and took the dialog's
 * header and navigation permanently out of view.
 */

/** The sheet with comments removed, so a brace inside prose cannot read as a rule. */
const css = RAVEN_CARD_CSS.replace(/\/\*[\s\S]*?\*\//g, '')

interface Rule {
  readonly selectors: readonly string[]
  readonly body: string
}

/** Every rule in the sheet. It is deliberately flat: no at-rules and no nesting. */
const rules: readonly Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
  selectors: (match[1] ?? '').split(',').map(part => part.trim()).filter(part => part.length > 0),
  body: match[2] ?? '',
}))

/** One declaration's value, or undefined when the rule does not set that property. */
function declaration(rule: Rule, property: string): string | undefined {
  const found = new RegExp(String.raw`(?:^|;)\s*${property}\s*:\s*([^;]+)`).exec(rule.body)
  return found?.[1]?.trim()
}

/** The rules whose selector list mentions one class. */
function rulesFor(selector: string): readonly Rule[] {
  return rules.filter(rule => rule.selectors.some(one => one.startsWith(selector)))
}

describe('card stylesheet', () => {
  it('parses as a flat sheet of rules', () => {
    // Every assertion below reads `rules`, so an extraction that silently found
    // nothing would make the whole suite vacuously pass.
    expect(rules.length).toBeGreaterThan(20)
    for (const rule of rules) expect(rule.selectors.length).toBeGreaterThan(0)
  })

  it('scopes every selector to the card', () => {
    // A plugin stylesheet is injected into the one document every other plugin
    // and the whole shell render into. A selector that matched anything outside
    // this card would be this package silently restyling the Harness.
    for (const rule of rules) {
      for (const selector of rule.selectors) expect(selector.startsWith('.dsh-raven-card')).toBe(true)
    }
  })

  it('makes the card root a containing block', () => {
    // This is what bounds the blast radius of anything the card ever positions:
    // an absolutely positioned descendant resolves against the nearest
    // POSITIONED ancestor, and with this declaration that ancestor is the card
    // rather than whichever host element happens to be positioned.
    const root = rules.find(rule => rule.selectors.includes('.dsh-raven-card'))
    expect(root).toBeDefined()
    expect(declaration(root as Rule, 'position')).toBe('relative')
  })

  it('positions nothing relative to the viewport', () => {
    // `position: fixed` ignores the containing block above, so it is the one
    // value the card genuinely cannot contain.
    for (const rule of rules) expect(declaration(rule, 'position')).not.toBe('fixed')
  })

  it('keeps the hidden radio in flow', () => {
    // Focusing a control scrolls its ancestors to reveal it. A visually hidden
    // control that is out of flow is therefore not merely invisible: it is a
    // scroll instruction pointing at coordinates the reader cannot see. Hiding
    // it at zero size keeps it exactly where its label is, so the focus scroll
    // is the one the reader asked for.
    const radio = rulesFor('.dsh-raven-card__radio')
    expect(radio.length).toBeGreaterThan(0)
    for (const rule of radio) expect(declaration(rule, 'position')).toBeUndefined()

    const hidden = radio.find(rule => rule.selectors.includes('.dsh-raven-card__radio'))
    expect(hidden).toBeDefined()
    expect(declaration(hidden as Rule, 'width')).toBe('0')
    expect(declaration(hidden as Rule, 'height')).toBe('0')
    // Still rendered, so it stays focusable and keeps native radio-group
    // semantics; only its paint is suppressed.
    expect(declaration(hidden as Rule, 'display')).toBeUndefined()
    expect(declaration(hidden as Rule, 'opacity')).toBe('0')
  })

  it('spends only design tokens the theme defines', () => {
    // The Harness's own card CSS reaches for `--dsw-alias-label-error`, which
    // the theme does not define; a copy of that mistake renders invisible error
    // copy in whichever theme leaves the fallback empty.
    expect(css).not.toContain('var(--dsw-alias-label-error)')
    expect(css).toContain('var(--dsw-alias-state-error-primary)')
  })
})
