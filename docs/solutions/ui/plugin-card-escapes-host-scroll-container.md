---
title: "Plugin settings card breaks the whole settings dialog: absolutely positioned descendant escapes the host scroll container"
date: 2026-08-21
category: ui
module: src/client
problem_type: ui_bug
component: frontend
symptoms:
  - "Clicking any radio option in the plugin's settings card scrolls the settings dialog's header and left navigation permanently out of view"
  - "The dialog cannot be scrolled back; only closing and reopening it restores the chrome"
  - "No console error, no React error boundary, no failed request — the DOM is intact and only the rendering is wrong"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [css, containing-block, dsh-plugin, settings-card, accessibility, scroll-containment]
---

# Plugin settings card breaks the whole settings dialog: absolutely positioned descendant escapes the host scroll container

## Problem

The Raven settings card ships its own stylesheet, because the Harness's compiled card chrome cannot be imported across the client bundle-purity boundary. Its choice controls used the standard visually-hidden-radio idiom — `position: absolute` on a 1×1 transparent `<input type="radio">` inside a `<label>`. Clicking any choice destroyed the layout of the entire **Settings** dialog: the title, the left navigation, and the tab bar disappeared and could not be brought back without closing the dialog.

The card itself looked fine. Nothing about the symptom pointed at the card.

## Symptoms

- Clicking a radio option in the card scrolls the settings dialog's own chrome out of view, permanently for that dialog session.
- Nothing is logged. No exception, no error boundary, no failed request.
- The accessibility tree still lists every control, so a snapshot-based check reports a healthy page while a screenshot shows a broken one.

## What Didn't Work

- **Looking for a JavaScript fault.** The console was empty and the click handler ran correctly: the radio flipped, the "unsaved" pill appeared, the staged edit was correct. The bug is not in behaviour at all.
- **Suspecting a CSS leak.** Every selector in the sheet is already prefixed `.dsh-raven-card`, so nothing could match a host element. Correct, and irrelevant — the escape is by *containing block*, not by selector.
- **Re-checking the design tokens and geometry.** They were fine. The card renders correctly right up to the moment a control inside it takes focus.

## Solution

Two changes in `src/client/styles.ts`.

Keep the hidden control in flow, at zero size, instead of positioning it:

```css
/* before — escapes to the nearest positioned ancestor, which is a host element */
.dsh-raven-card__radio {
  appearance: none;
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  opacity: 0;
}

/* after — invisible, still focusable, still exactly where its label is */
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
```

And make the card root a containing block, so the class of bug cannot recur if anything in the card is ever positioned again:

```css
.dsh-raven-card {
  position: relative;
  /* ... */
}
```

Measured before and after, in the running page:

| | before | after |
|---|---|---|
| `radio.offsetParent` | `nztFFW_panel` (the settings dialog) | `dsh-raven-card` |
| dialog `scrollHeight` / `clientHeight` | 1503 / 520 | 520 / 520 |
| dialog `scrollTop` after one click | 326 | 0 |
| plugin list `scrollTop` after one click | 299 | 299 |

The plugin list — the element that is *supposed* to scroll — behaves identically. Only the dialog stops moving.

## Why This Works

`position: absolute` resolves against the nearest **positioned** ancestor, and a plugin card cannot see its ancestors: they are host elements with hashed class names, and none of them is positioned. The chain here was

```
.dsh-raven-card__option   (label, display: inline-flex, position: static)
  → xb61fW_cards          (the plugin <ul>,        position: static)
  → nztFFW_options        (the scrolling pane,     position: static, overflow-y: auto)
  → nztFFW_panel          (the settings dialog,    position: relative, overflow: hidden)
```

so the radios' containing block was the dialog itself. Two consequences follow, and it takes both to produce the symptom:

1. **`overflow` only clips descendants whose containing block is inside the clipping element.** The radios' containing block was *outside* `nztFFW_options`, so the pane did not clip them. Their static positions — scattered down a 1663px-tall card inside a list scrolled to offset 299 — landed far below the dialog's 520px box, inflating its `scrollHeight` to 1503.
2. **Focusing an element scrolls its scrollable ancestors to reveal it.** Clicking a `<label>` focuses its radio, and the browser dutifully scrolled the dialog to bring a 1px transparent input into view.

The dialog is `overflow: hidden`, so it has no scrollbar — programmatically scrollable, but not scrollable *back* by any user gesture. That is why the damage was permanent and why it read as "the settings page broke" rather than "something scrolled".

Zero-size-in-flow avoids step 1 entirely: the control has no containing block of its own to escape to, and its rect is its label's rect, so step 2 scrolls to where the reader is already looking. `position: relative` on the card root is the belt to that braces — it bounds anything positioned in the future to the card.

## Prevention

`tests/unit/styles.test.ts` parses the shipped stylesheet and asserts three structural rules, none of which is visible in a screenshot of a card that looks correct:

- every selector is scoped to `.dsh-raven-card`, so the sheet cannot restyle the page around it;
- `.dsh-raven-card` declares `position: relative`, so it is the containing block for anything the card positions;
- the hidden radio declares no `position` at all, and is hidden by `width: 0; height: 0; opacity: 0` rather than by `display: none` (which would remove it from the focus order).

The general rule for any DSH client plugin that ships its own CSS: **a plugin renders into chrome it cannot see, so it owns two structural invariants, not just a visual one — its selectors may not reach out, and its layout may not reach out.** Positioning is layout reaching out.

One diagnostic note worth reusing: an accessibility-tree snapshot cannot see this bug, because the DOM is correct. What found it was reading `offsetParent`, `scrollTop`, `scrollHeight`, and `clientHeight` off the ancestor chain in the live page. Reach for those first when a page looks broken but reports healthy.

## Related Issues

- `docs/adr/0005-bundle-and-settings-card.md` — records the decision that a hand-drawn card owns containment, and why the chrome is hand-drawn at all.
- `docs/design/architecture.md` § "Browser half and the restated slot contract".
