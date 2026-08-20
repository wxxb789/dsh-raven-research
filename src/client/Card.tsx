/**
 * Raven's card on the Settings › Plugins page.
 *
 * The chrome is hand-drawn because the client bundle-purity rule forbids
 * importing the shipped card chrome as values. It stays deliberately plain: the
 * card renders what the Host serves and writes what the user chooses, and every
 * decision about which value is valid, which is overridden, and whether a Save
 * may proceed was already made in `card-state.ts`.
 * @module
 */

import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import type { RavenFieldState } from './card-state.js'
import type { RavenCardFace } from './controller.js'
import type {} from './slot-contract.js'

export type RavenCardProps = PropsRuntime<'settings.plugin.item'> & InjectFace<RavenCardFace>

/**
 * Copy for every field, spelled here rather than pulled from the Host schema
 * descriptions: the Host descriptor carries no title, order, or group, and the
 * schema description is written for an operator reading YAML, not for a form row.
 */
const LABELS: Record<string, { readonly label: string; readonly hint: string }> = {
  sourceVerification: {
    label: 'Source verification',
    hint: 'Whether recorded Sources are re-fetched to confirm their excerpts. "structural-only" makes every Source unverifiable, so a Checkpoint carrying Sources is refused rather than published unchecked.',
  },
  sourceCheckTimeoutMs: {
    label: 'Source check deadline (ms)',
    hint: '0 means no deadline. An exceeded deadline reports that one Source as unverifiable instead of holding the Checkpoint open.',
  },
  sourceDiscovery: {
    label: 'Lead discovery',
    hint: 'Whether raven_task action=discover may run queries through the Harness web search seam. "disabled" reports discovery as unavailable and records a Limitation; it never makes the agent believe it searched.',
  },
  searchMaxQueries: { label: 'Queries per discovery batch', hint: '0 means the built-in bound.' },
  searchMaxResults: { label: 'Candidates per query', hint: '0 means the built-in bound.' },
  searchTimeoutMs: {
    label: 'Discovery query deadline (ms)',
    hint: '0 means no deadline. A query that exceeds it is recorded as a failed query; its siblings still return their Leads.',
  },
  proseLayout: {
    label: 'Prose layout',
    hint: 'How every stored Artifact is laid out. "sentence-per-line" makes a LINE the smallest edit unit, so a revision diffs as the sentences that changed. Markdown structure is never reflowed.',
  },
  proseFormat: {
    label: 'Artifact format',
    hint: 'Markdown is the default final output format and is what makes the layout structure-aware. "plain" treats every line as prose.',
  },
  draftRoutes: {
    label: 'Draft Variant routes',
    hint: 'One "provider/model" per line. This list is the whole universe: the agent may select a subset and nothing else. Empty disables Draft Variants and says so.',
  },
  draftMaxTokens: { label: 'Draft length bound (tokens)', hint: '0 means the built-in bound.' },
  draftTimeoutMs: {
    label: 'Draft deadline (ms)',
    hint: '0 means no deadline. A route that exceeds it produces no variant; its siblings still return theirs.',
  },
}

function Field(props: {
  readonly field: RavenFieldState
  readonly disabled: boolean
  readonly onEdit: (text: string) => void
  readonly onReset: () => void
}) {
  const { field } = props
  const copy = LABELS[field.name] ?? { label: field.name, hint: '' }
  const id = `raven-research-${field.name}`
  return (
    <div className="raven-field" data-invalid={field.invalid ? 'true' : undefined}>
      <label htmlFor={id}>
        {copy.label}
        {field.overridden ? <span className="raven-field-badge">overridden</span> : null}
      </label>
      {field.kind === 'choice'
        ? (
            <select
              id={id}
              value={field.text}
              disabled={props.disabled}
              onChange={(event) => { props.onEdit(event.target.value) }}
            >
              {field.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
            </select>
          )
        : field.kind === 'routes'
          ? (
              <textarea
                id={id}
                rows={3}
                value={field.text}
                disabled={props.disabled}
                spellCheck={false}
                onChange={(event) => { props.onEdit(event.target.value) }}
              />
            )
          : (
              <input
                id={id}
                type="text"
                inputMode="numeric"
                value={field.text}
                disabled={props.disabled}
                onChange={(event) => { props.onEdit(event.target.value) }}
              />
            )}
      <p className="raven-field-hint">{copy.hint}</p>
      {field.invalid ? <p className="raven-field-error">This value is not accepted; the setting is not saved.</p> : null}
      {field.overridden
        ? (
            <button type="button" disabled={props.disabled} onClick={props.onReset}>
              Reset to default
            </button>
          )
        : null}
    </div>
  )
}

export function RavenSettingsCard(props: RavenCardProps) {
  const state = props.useRavenCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <section className="raven-settings-card">
      <header>
        <h3>Raven research</h3>
        <p>
          Progressive, source-grounded research, writing, and learning. Every field here is a decision
          about the environment a Raven Task runs in, never about one Task. The evidence floor belongs
          to the Outcome and no setting can lower it.
        </p>
      </header>
      {state.status === 'unavailable'
        ? <p>These settings are not exposed to this client.</p>
        : state.status === 'loading'
          ? <p>Loading…</p>
          : (
              <>
                {state.memory
                  ? <p>This connection keeps preferences process-local, so changes cannot be saved.</p>
                  : null}
                {state.fields.map(field => (
                  <Field
                    key={field.name}
                    field={field}
                    disabled={disabled}
                    onEdit={(text) => { props.edit(field.name, text) }}
                    onReset={() => { props.resetField(field.name) }}
                  />
                ))}
                <footer>
                  <button type="button" disabled={disabled || !state.dirty || state.invalid} onClick={props.save}>
                    Save
                  </button>
                  <button type="button" disabled={!state.dirty} onClick={props.discard}>
                    Discard
                  </button>
                </footer>
              </>
            )}
    </section>
  )
}
