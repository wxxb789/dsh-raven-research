/**
 * The card as the page actually renders it, and the controller as the page
 * actually drives it.
 *
 * `card-state.ts` is pure and already well covered, so this file deliberately
 * tests the half that is not: the element tree the card actually draws — which
 * branch it takes, what it exposes to assistive technology, and which control
 * is disabled.
 *
 * It runs with no DOM and no React renderer, because it needs neither: the card
 * is a function of its props (its one hook arrives as `useRavenCard`, a prop),
 * so calling it returns the element tree directly. A jsdom environment would add
 * a dependency and a second way for this suite to fail without testing one more
 * line of Raven.
 */

import { describe, expect, it, vi } from 'vitest'

// The icon is chrome, and importing it for real drags the shipped primitives
// bundle — and the KaTeX stylesheet it re-exports — into a Node test run that
// has no CSS pipeline. Stubbing it keeps this file about the card's own tree.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}))

import { RavenSettingsCard } from '../../src/client/Card.js'
import type { RavenCardState, RavenFieldState } from '../../src/client/card-state.js'

interface Element {
  readonly type: unknown
  readonly props: Record<string, unknown>
}

function isElement(value: unknown): value is Element {
  return typeof value === 'object' && value !== null && 'props' in value && 'type' in value
}

/**
 * Every element in the tree, depth first, expanding this module's own function
 * components as it goes.
 *
 * Expansion is what makes this a test of the card rather than of its outline:
 * a row is a component, so without invoking it the tree stops at `<Row/>` and
 * every control the row draws — the reset button, the invalid marker, the
 * control's own `aria-invalid` — is invisible. None of these components call a
 * hook, so calling one is exactly what React would do with it.
 */
function walk(node: unknown, seen: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, seen)
    return seen
  }
  if (!isElement(node)) return seen
  seen.push(node)
  if (typeof node.type === 'function') {
    walk((node.type as (props: unknown) => unknown)(node.props), seen)
    return seen
  }
  return walk(node.props.children, seen)
}

function byClass(tree: unknown, className: string): Element[] {
  return walk(tree).filter(element => element.props.className === className)
}

function field(overrides: Partial<RavenFieldState> = {}): RavenFieldState {
  return {
    name: 'sourceVerification',
    kind: 'choice',
    group: 'evidence',
    choices: ['remote', 'structural-only'],
    text: 'remote',
    overridden: false,
    edited: false,
    failure: undefined,
    ...overrides,
  }
}

function state(overrides: Partial<RavenCardState> = {}): RavenCardState {
  return {
    status: 'ready',
    writable: true,
    memory: false,
    dirty: false,
    invalid: false,
    open: true,
    saving: false,
    failed: false,
    fields: [field()],
    ...overrides,
  }
}

/** The card's props, with every injected face recorded so wiring can be asserted. */
function props(cardState: RavenCardState) {
  const calls = {
    toggle: vi.fn(),
    edit: vi.fn(),
    resetField: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  }
  return {
    calls,
    // The copy function is identity-by-key on purpose: a test that asserted
    // rendered English would fail on a copy edit while proving nothing about
    // which key the card chose, and the key is the thing under test.
    element: RavenSettingsCard({
      t: (key: string) => key,
      useRavenCard: (select: (snapshot: RavenCardState) => unknown) => select(cardState),
      ...calls,
    } as never),
  }
}

describe('RavenSettingsCard', () => {
  it('draws only its header while collapsed, so a closed card cannot leak controls', () => {
    const { element } = props(state({ open: false }))
    expect(byClass(element, 'dsh-raven-card__body')).toHaveLength(0)
    expect(byClass(element, 'dsh-raven-card__header')).toHaveLength(1)
  })

  it('tells assistive technology the disclosure state and restates the unsaved marker in the label', () => {
    const closed = props(state({ open: false, dirty: true })).element
    const header = byClass(closed, 'dsh-raven-card__header')[0]
    expect(header?.props['aria-expanded']).toBe(false)
    expect(String(header?.props['aria-label'])).toContain('unsaved')

    const open = props(state({ open: true })).element
    expect(byClass(open, 'dsh-raven-card__header')[0]?.props['aria-expanded']).toBe(true)
  })

  it('wires every control to the injected face rather than to local state', () => {
    const { calls, element } = props(state({ dirty: true, fields: [field({ overridden: true })] }))
    const click = (className: string) => {
      const button = byClass(element, className)[0]
      if (button === undefined) throw new Error(`no ${className} in the rendered card`)
      ;(button.props.onClick as () => void)()
    }
    click('dsh-raven-card__header')
    click('dsh-raven-card__reset')
    click('dsh-raven-card__discard')
    click('dsh-raven-card__save')
    expect(calls.toggle).toHaveBeenCalledOnce()
    expect(calls.resetField).toHaveBeenCalledWith('sourceVerification')
    expect(calls.discard).toHaveBeenCalledOnce()
    expect(calls.save).toHaveBeenCalledOnce()
  })

  it('replaces the hint with the schema\'s own refusal and marks the control invalid', () => {
    const { element } = props(state({
      invalid: true,
      dirty: true,
      fields: [field({ name: 'searchMaxQueries', kind: 'number', group: 'discovery', text: 'x', failure: { kind: 'schema', message: 'expect a natural number' } })],
    }))
    const input = walk(element).find(node => node.props.id === 'dsh-raven-searchMaxQueries')
    expect(input?.props['aria-invalid']).toBe(true)
    expect(byClass(element, 'dsh-raven-card__invalid')[0]?.props.children).toBe('expect a natural number')
    expect(byClass(element, 'dsh-raven-card__hint')).toHaveLength(0)
  })

  it('refuses Save while a draft is invalid, while nothing is dirty, and while a save is in flight', () => {
    const disabled = (cardState: RavenCardState) =>
      byClass(props(cardState).element, 'dsh-raven-card__save')[0]?.props.disabled
    expect(disabled(state({ dirty: false }))).toBe(true)
    expect(disabled(state({ dirty: true, invalid: true }))).toBe(true)
    expect(disabled(state({ dirty: true, saving: true }))).toBe(true)
    expect(disabled(state({ dirty: true }))).toBe(false)
  })

  it('reports a non-writable scope and disables its controls instead of pretending a Save would land', () => {
    const memory = props(state({ writable: false, memory: true, dirty: true })).element
    expect(byClass(memory, 'dsh-raven-card__notice')[0]?.props.children).toBe('memory')
    expect(byClass(memory, 'dsh-raven-card__save')[0]?.props.disabled).toBe(true)

    const readOnly = props(state({ writable: false, memory: false })).element
    expect(byClass(readOnly, 'dsh-raven-card__notice')[0]?.props.children).toBe('readOnly')
  })

  it('renders a status notice instead of controls until the namespace is served', () => {
    for (const status of ['loading', 'unavailable'] as const) {
      const element = props(state({ status })).element
      expect(byClass(element, 'dsh-raven-card__notice')[0]?.props.children).toBe(status)
      expect(byClass(element, 'dsh-raven-card__save')).toHaveLength(0)
    }
  })

  it('draws a group heading only for groups that actually have rows', () => {
    const element = props(state({
      fields: [field(), field({ name: 'proseLayout', group: 'prose', choices: ['sentence-per-line', 'as-written'], text: 'as-written' })],
    })).element
    const headings = walk(element)
      .filter(node => String(node.props.className ?? '').startsWith('dsh-raven-card__group'))
      .map(node => node.props.children)
    expect(headings).toStrictEqual(['group.evidence', 'group.prose'])
  })
})