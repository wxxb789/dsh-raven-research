/**
 * The card's own stylesheet.
 *
 * The Harness client bundle preset compiles `.module.css` through lightningcss
 * and emits exactly this injection. That preset is unpublished and its compiler
 * is not a dependency this package can add, so the card carries its stylesheet
 * as text and injects it itself. The end state is identical: one
 * `<style data-plugin="dsh-raven-research">` tag the loader owns.
 *
 * The entry calls this at module scope on purpose. The loader claims plugin
 * styles immediately after a factory returns, so a tag created later — inside
 * `apply`, say — would never be claimed and would outlive an unload. It is an
 * explicit call rather than a bare `import './styles.js'` because this package
 * declares `sideEffects: false`, under which a bundler may drop an import whose
 * bindings nothing reads.
 *
 * The geometry mirrors the cards the Harness plugin configuration tab renders
 * for its own plugins, because they share one `<ul>`: a card that measured
 * itself differently would read as a different kind of object. Every colour is
 * a `--dsw-alias-*` design token, so the card follows the active theme instead
 * of pinning light-mode values. One deliberate divergence: the Harness card CSS
 * reaches for `--dsw-alias-label-error`, which the theme does not define, so
 * error copy here uses `--dsw-alias-state-error-primary`, which it does.
 *
 * ## Containment
 *
 * This card is rendered inside a scroll container the Harness owns and this
 * package cannot see. An absolutely positioned descendant resolves against the
 * nearest POSITIONED ancestor, and the tab's scrolling list is not positioned —
 * so such a descendant escapes that list's clip, lands in the settings dialog's
 * own box, and adds its offset to a panel that is `overflow: hidden` and has no
 * scrollbar to undo it. Focusing it then scrolls the dialog's header and nav
 * permanently out of view. The card root therefore establishes a containing
 * block, so nothing this stylesheet positions can reach past the card; and the
 * one control that needs to be invisible without leaving the focus order stays
 * in flow at zero size rather than being positioned at all.
 * `tests/unit/styles.test.ts` holds both rules.
 * @module
 */

/** Plugin id; must equal the bundle id the loader registered. */
const PLUGIN_ID = 'dsh-raven-research'

/** Tag identity, mirroring the preset's `<pkg>/<file>` convention. */
const STYLE_ID = `${PLUGIN_ID}/raven-card.css`

/**
 * The stylesheet, exported so the containment rules that keep this card from
 * disturbing the page around it are testable without a browser.
 */
export const RAVEN_CARD_CSS = `
.dsh-raven-card {
  list-style: none;
  /* The containing block for everything this card positions. Without it an
     absolutely positioned descendant resolves against the settings dialog and
     escapes the plugin list's clip; see the module comment. */
  position: relative;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  transition: border-color .16s, background .16s;
}
.dsh-raven-card:hover { border-color: var(--dsw-alias-label-dimmed); }
/* An open card reads as the one being worked on, not merely taller. */
.dsh-raven-card--open {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-raven-card__header {
  width: 100%;
  appearance: none;
  border-width: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
}
.dsh-raven-card__header:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
/* Name over description: the description is what tells two cards apart, so it
   gets its own line rather than trailing the name. */
.dsh-raven-card__headtext {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-raven-card__name {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.dsh-raven-card__description {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
/* Carried on the header so a collapsed card still says it holds edits. */
.dsh-raven-card__pending {
  flex: none;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsh-raven-card__chevron,
.dsh-raven-card__chevron--open {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transition: transform .16s;
}
.dsh-raven-card__chevron--open { transform: rotate(180deg); }
.dsh-raven-card__body {
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding-bottom: 8px;
}
.dsh-raven-card__notice {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
/* Eleven controls in one flat list read as a wall. The group heading is what
   says which decision a row belongs to. */
.dsh-raven-card__group {
  margin: 0;
  padding: 14px 0 2px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-raven-card__group--first { border-top-width: 0; }
.dsh-raven-card__row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.dsh-raven-card__row + .dsh-raven-card__row {
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-raven-card__head { display: flex; align-items: center; gap: 8px; }
.dsh-raven-card__label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-raven-card__badges { display: inline-flex; align-items: center; gap: 8px; }
.dsh-raven-card__badge {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsh-raven-card__reset {
  border-width: 0;
  background: transparent;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-raven-card__reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dsh-raven-card__reset:disabled { cursor: default; }
.dsh-raven-card__input,
.dsh-raven-card__input--invalid,
.dsh-raven-card__area,
.dsh-raven-card__area--invalid {
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-raven-card__input,
.dsh-raven-card__input--invalid { height: 34px; }
/* Routes are a list, so the control is a list-shaped box; the code font makes a
   mistyped provider/model visible as a shape, not just as a rejected save. The
   fallback stack mirrors the theme's own and deliberately omits a bare
   \`monospace\` tail, which Windows resolves to SimSun for CJK. */
.dsh-raven-card__area,
.dsh-raven-card__area--invalid {
  min-height: 76px;
  padding: 8px 12px;
  resize: vertical;
  font-family: var(--ds-font-family-code, 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, Menlo);
}
.dsh-raven-card__input:focus-visible,
.dsh-raven-card__input--invalid:focus-visible,
.dsh-raven-card__area:focus-visible,
.dsh-raven-card__area--invalid:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-raven-card__input:disabled,
.dsh-raven-card__input--invalid:disabled,
.dsh-raven-card__area:disabled,
.dsh-raven-card__area--invalid:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.dsh-raven-card__input--invalid,
.dsh-raven-card__area--invalid { border-color: var(--dsw-alias-state-error-primary); }
/* Every choice visible at once: a collapsed list would hide that the other
   value is a real, currently unchosen policy. */
.dsh-raven-card__choices {
  display: inline-flex;
  align-self: flex-start;
  padding: 2px;
  gap: 2px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
}
.dsh-raven-card__option {
  display: inline-flex;
  align-items: center;
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  transition: background .12s, color .12s;
}
.dsh-raven-card__option:hover { color: var(--dsw-alias-label-primary); }
.dsh-raven-card__option[data-active='true'] {
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
/* The radio stays in the accessibility and focus order; only its own box is
   removed, so arrow-key traversal and Space still work. Zero-sized and IN FLOW
   rather than positioned: an absolutely positioned control would resolve
   against whatever ancestor happens to be positioned, and when the card is
   rendered inside a host scroll container that is the settings dialog itself —
   focusing the control then scrolls the dialog's own chrome out of view. */
.dsh-raven-card__radio {
  appearance: none;
  flex: none;
  width: 0;
  height: 0;
  margin: 0;
  padding: 0;
  border-width: 0;
  outline: none;
  opacity: 0;
}
.dsh-raven-card__radio:disabled { cursor: default; }
.dsh-raven-card__option:has(.dsh-raven-card__radio:disabled) {
  cursor: default;
  color: var(--dsw-alias-label-dimmed);
}
.dsh-raven-card__option:has(.dsh-raven-card__radio:focus-visible) {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -1px;
}
.dsh-raven-card__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-raven-card__invalid {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-raven-card__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-raven-card__error {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-raven-card__discard,
.dsh-raven-card__save {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
.dsh-raven-card__discard {
  border-color: var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.dsh-raven-card__discard:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-raven-card__save {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}
.dsh-raven-card__discard:disabled,
.dsh-raven-card__save:disabled { opacity: 0.4; cursor: default; }
.dsh-raven-card__discard:focus-visible,
.dsh-raven-card__save:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
`

/**
 * Inject the stylesheet once. Idempotent under re-evaluation, and a no-op
 * outside a browser so the bundle stays loadable under a DOM-free harness.
 */
export function injectCardStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = RAVEN_CARD_CSS
  document.head.appendChild(tag)
}
