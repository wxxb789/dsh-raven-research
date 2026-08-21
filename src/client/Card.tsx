/**
 * Raven's card on the Settings › Plugins page.
 *
 * The chrome is hand-drawn because the client bundle-purity rule forbids
 * importing the shipped card chrome as values. It is not, for that reason,
 * allowed to look hand-drawn: the tab renders every card into one `<ul>`, so a
 * card that drew itself as an always-open `<section>` would read as a different
 * kind of object than its neighbours. The geometry, the disclosure header, and
 * the row layout therefore mirror the cards the Harness ships, and the
 * stylesheet in `styles.ts` carries the same design tokens.
 *
 * Every decision about which value is valid, which is overridden, and whether a
 * Save may proceed was already made in `card-state.ts`. Nothing here judges.
 * @module
 */

import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import { RAVEN_GROUPS, type RavenFieldGroup, type RavenFieldState } from './card-state.js'
import type { RavenCardFace } from './controller.js'
import type { RavenCardKey } from './locales.js'
import type {} from './slot-contract.js'

export type RavenCardProps =
  PropsRuntime<'settings.plugin.item'>
  & InjectFace<RavenCardFace>
  & PropsLocale<'settings.raven-research'>

/** Copy lookup bound to this card's dictionary namespace. */
type Copy = RavenCardProps['t']

/**
 * The dictionary key carrying one field's hint. A suffix rule rather than a
 * table, because a table would be a second list to keep in step with
 * `RAVEN_FIELDS`; `tests/unit/card-state.test.ts` asserts that every field the
 * card renders has a label, a hint, and an option label in the dictionary, so a
 * field added without copy fails the suite instead of rendering its own key at
 * a reader.
 */
function hintKey(name: string): RavenCardKey {
  return `${name}Hint` as RavenCardKey
}

/** The message a row shows in place of its hint while its draft is unacceptable. */
function failureText(field: RavenFieldState, t: Copy): string | undefined {
  if (field.failure === undefined) return undefined
  // The schema's own words name the actual bound it refused, which no local
  // string could restate without drifting from `config.ts`. The route rule is
  // this card's own, so it gets this card's copy.
  return field.failure.kind === 'schema' ? field.failure.message : t('invalidRoutes')
}

function Choices(props: {
  readonly id: string
  readonly field: RavenFieldState
  readonly disabled: boolean
  readonly t: Copy
  readonly onEdit: (text: string) => void
}) {
  // A radio group rather than a <select>: both policies are then visible at
  // once, and the exclusivity, arrow-key traversal, and Space activation come
  // from the native control instead of being re-implemented.
  return (
    <div
      id={props.id}
      className="dsh-raven-card__choices"
      role="radiogroup"
      aria-labelledby={`${props.id}-label`}
    >
      {props.field.choices.map(choice => (
        <label
          key={choice}
          className="dsh-raven-card__option"
          data-active={props.field.text === choice ? 'true' : undefined}
        >
          <input
            type="radio"
            className="dsh-raven-card__radio"
            name={props.id}
            value={choice}
            checked={props.field.text === choice}
            disabled={props.disabled}
            onChange={() => { props.onEdit(choice) }}
          />
          <span>{props.t(`choice.${choice}` as RavenCardKey)}</span>
        </label>
      ))}
    </div>
  )
}

function Row(props: {
  readonly field: RavenFieldState
  readonly disabled: boolean
  readonly t: Copy
  readonly onEdit: (text: string) => void
  readonly onReset: () => void
}) {
  const { field, t } = props
  const id = `dsh-raven-${field.name}`
  const choice = field.kind === 'choice'
  const failure = failureText(field, t)
  const invalid = failure !== undefined
  // A choice row's label names a radiogroup, which `for` cannot point at.
  const label = choice
    ? <span className="dsh-raven-card__label" id={`${id}-label`}>{t(field.name as RavenCardKey)}</span>
    : <label className="dsh-raven-card__label" htmlFor={id}>{t(field.name as RavenCardKey)}</label>
  return (
    <div className="dsh-raven-card__row">
      <div className="dsh-raven-card__head">
        {label}
        {field.overridden
          ? (
              <span className="dsh-raven-card__badges">
                <span className="dsh-raven-card__badge">{t('overridden')}</span>
                <button
                  type="button"
                  className="dsh-raven-card__reset"
                  disabled={props.disabled}
                  onClick={props.onReset}
                >
                  {t('reset')}
                </button>
              </span>
            )
          : null}
      </div>
      {choice
        ? (
            <Choices
              id={id}
              field={field}
              disabled={props.disabled}
              t={t}
              onEdit={props.onEdit}
            />
          )
        : field.kind === 'routes'
          ? (
              <textarea
                id={id}
                className={invalid ? 'dsh-raven-card__area--invalid' : 'dsh-raven-card__area'}
                rows={3}
                spellCheck={false}
                {...invalid ? { 'aria-invalid': true } : {}}
                value={field.text}
                disabled={props.disabled}
                onChange={(event) => { props.onEdit(event.target.value) }}
              />
            )
          : (
              <input
                id={id}
                className={invalid ? 'dsh-raven-card__input--invalid' : 'dsh-raven-card__input'}
                type="text"
                // `inputMode` only hints the keypad. Whether a draft is accepted
                // is decided by the Host's own schema, so the control never
                // silently rewrites what was typed.
                {...field.kind === 'number' ? { inputMode: 'numeric' as const } : {}}
                {...invalid ? { 'aria-invalid': true } : {}}
                value={field.text}
                disabled={props.disabled}
                onChange={(event) => { props.onEdit(event.target.value) }}
              />
            )}
      {/* The invalid line replaces the hint rather than stacking under it: a row
          that reports both says two things about one control. */}
      <p className={invalid ? 'dsh-raven-card__invalid' : 'dsh-raven-card__hint'}>
        {failure ?? t(hintKey(field.name))}
      </p>
    </div>
  )
}

export function RavenSettingsCard(props: RavenCardProps) {
  const { t } = props
  const state = props.useRavenCard(snapshot => snapshot)
  const title = t('title')
  // The label replaces the header's own contents for assistive technology, so
  // the unsaved marker has to be restated here or collapsing the card would
  // hide the fact that it holds edits.
  const name = state.dirty ? `${title} (${t('unsaved')})` : title
  const header = (
    <button
      type="button"
      className="dsh-raven-card__header"
      aria-expanded={state.open}
      aria-label={`${t(state.open ? 'collapse' : 'expand')}: ${name}`}
      onClick={props.toggle}
    >
      <span className="dsh-raven-card__headtext">
        <span className="dsh-raven-card__name">{title}</span>
        <span className="dsh-raven-card__description">{t('description')}</span>
      </span>
      {state.dirty ? <span className="dsh-raven-card__pending">{t('unsaved')}</span> : null}
      <IconChevronDownOutline14
        className={state.open ? 'dsh-raven-card__chevron--open' : 'dsh-raven-card__chevron'}
      />
    </button>
  )
  if (!state.open) return <li className="dsh-raven-card">{header}</li>
  const disabled = !state.writable || state.saving
  return (
    <li className="dsh-raven-card dsh-raven-card--open">
      {header}
      <div className="dsh-raven-card__body">
        {state.status === 'unavailable'
          ? <p className="dsh-raven-card__notice" role="status">{t('unavailable')}</p>
          : state.status === 'loading'
            ? <p className="dsh-raven-card__notice" role="status">{t('loading')}</p>
            : (
                <>
                  {state.writable
                    ? null
                    : (
                        <p className="dsh-raven-card__notice" role="status">
                          {t(state.memory ? 'memory' : 'readOnly')}
                        </p>
                      )}
                  {/* Only the groups the registered schema actually populated:
                      a heading over nothing would claim a setting that is not
                      served, and `other` exists precisely so a field this card
                      has no group for still renders. */}
                  {RAVEN_GROUPS
                    .map((group: RavenFieldGroup) => ({
                      group,
                      rows: state.fields.filter(field => field.group === group),
                    }))
                    .filter(entry => entry.rows.length > 0)
                    .map((entry, index) => (
                      <div key={entry.group}>
                        <p
                          className={index === 0
                            ? 'dsh-raven-card__group dsh-raven-card__group--first'
                            : 'dsh-raven-card__group'}
                        >
                          {t(`group.${entry.group}` as RavenCardKey)}
                        </p>
                        {entry.rows.map(field => (
                          <Row
                            key={field.name}
                            field={field}
                            disabled={disabled}
                            t={t}
                            onEdit={(text) => { props.edit(field.name, text) }}
                            onReset={() => { props.resetField(field.name) }}
                          />
                        ))}
                      </div>
                    ))}
                  <div className="dsh-raven-card__footer">
                    {state.failed
                      ? <p className="dsh-raven-card__error" role="status">{t('saveFailed')}</p>
                      : null}
                    <button
                      type="button"
                      className="dsh-raven-card__discard"
                      disabled={state.saving || !state.dirty}
                      onClick={props.discard}
                    >
                      {t('discard')}
                    </button>
                    <button
                      type="button"
                      className="dsh-raven-card__save"
                      disabled={disabled || !state.dirty || state.invalid}
                      onClick={props.save}
                    >
                      {t(state.saving ? 'saving' : 'save')}
                    </button>
                  </div>
                </>
              )}
      </div>
    </li>
  )
}
