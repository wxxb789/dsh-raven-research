/**
 * Bridges the `raven-research` settings scope onto the card's staged form.
 *
 * All the rules live in `card-state.ts`, which is pure; this class owns only
 * the things that cannot be pure — the staged edits, the writes, the disclosure
 * the reader controls, and the one piece of caching: the rehydrated schema.
 *
 * Every edit is staged and written only on Save, including a reset: a settings
 * write is a durable, revision-fenced document mutation, and a control that
 * committed as it settled would turn one click into a write the user never
 * asked for while a Save button sat next to it claiming otherwise.
 *
 * The Host is the only authority on whether a value was accepted, so a Save
 * reads the section back and reports whether the staged value is what the Host
 * now holds, rather than treating "no exception" as "landed".
 * @module
 */

import { createSnapshotStore, type SettingsScope, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

import {
  describeFields,
  inheritedText,
  plannedWrites,
  projectCardState,
  type RavenCardState,
  type RavenFieldSpec,
  type RavenScopeSnapshot,
  type RavenStagedEdit,
} from './card-state.js'
import type {
  RavenSettingsDescribeFace,
  RavenSettingsSchemaService,
} from './slot-contract.js'

/** The face the card's slot registration injects. */
export interface RavenCardFace {
  hooks: {
    /** Card snapshot, bound by the renderer as `useRavenCard`. */
    ravenCard: SnapshotStore<RavenCardState>
  }
  /** Disclose or collapse the card's controls. */
  toggle(): void
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
}

/** What the controller needs from the browser composition. */
export interface RavenCardDeps {
  /** The bound scope for Raven's own namespace. */
  readonly scope: SettingsScope<Record<string, unknown>>
  /** The shared describe mirror, which carries every namespace's schema. */
  readonly describe: RavenSettingsDescribeFace
  /** The Harness's own schema operations. */
  readonly schema: RavenSettingsSchemaService
  /** The namespace whose schema drives this card. */
  readonly namespace: string
}

export class RavenCardController {
  private readonly edits = new Map<string, RavenStagedEdit>()
  private readonly store: SnapshotStore<RavenCardState>
  private readonly disposers: (() => void)[] = []
  /**
   * Which card a reader has open is a reading gesture the Host has no stake in,
   * so it lives beside the drafts rather than in the document.
   */
  private open = false
  private saving = false
  private failed = false
  /**
   * Rehydrating parses a reference-preserving envelope, so it is cached against
   * the exact serialized value it came from. Identity is the right key: the
   * mirror replaces the row wholesale, and a namespace re-registered with a
   * different schema arrives as a different object.
   */
  private cached: { readonly serialized: unknown; readonly specs: readonly RavenFieldSpec[] } | undefined

  constructor(private readonly deps: RavenCardDeps) {
    this.store = createSnapshotStore(this.project())
    this.disposers.push(deps.scope.subscribe(() => { this.publish() }))
    // The schema arrives on the shared mirror rather than on the scope
    // snapshot, so the card has to observe both or it renders no fields until
    // something else happens to republish.
    this.disposers.push(deps.describe.subscribe(() => { this.publish() }))
  }

  private snapshot(): RavenScopeSnapshot {
    return this.deps.scope.getSnapshot() as RavenScopeSnapshot
  }

  /** The editable fields, read from the schema the Host registered. */
  private specs(): readonly RavenFieldSpec[] {
    const row = this.deps.describe.getSnapshot().view?.namespaces
      .find(entry => entry.ns === this.deps.namespace)
    if (row === undefined) return []
    const cached = this.cached
    if (cached !== undefined && cached.serialized === row.schema) return cached.specs
    let specs: readonly RavenFieldSpec[] = []
    try {
      specs = describeFields(this.deps.schema.rehydrate(row.schema))
    } catch {
      // An envelope this client cannot rehydrate describes no fields. The card
      // renders empty rather than guessing at a schema nobody could read.
      specs = []
    }
    this.cached = { serialized: row.schema, specs }
    return specs
  }

  private project(): RavenCardState {
    return projectCardState(this.deps.schema, this.specs(), this.snapshot(), this.edits, {
      open: this.open,
      saving: this.saving,
      failed: this.failed,
    })
  }

  private publish(): void {
    this.store.set(this.project())
  }

  private stage(field: string, edit: RavenStagedEdit): void {
    this.edits.set(field, edit)
    this.failed = false
    this.publish()
  }

  /**
   * Write every staged edit, then judge the outcome from what the Host holds.
   *
   * A save that did not land keeps its drafts, so the user can correct them
   * instead of retyping, and re-seeds nothing: the next scope publication tells
   * the truth.
   */
  private async commit(): Promise<void> {
    const writes = plannedWrites(this.deps.schema, this.specs(), this.snapshot(), this.edits)
    // Refused rather than partially applied: an unacceptable draft anywhere in
    // the form means no write at all.
    if (writes === undefined || writes.length === 0 || this.saving) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    // Writes are issued in field order; the scope fences each one with the
    // latest known revision and reloads Host state if the latest is refused.
    for (const write of writes) landed = await this.attempt(write) && landed
    if (landed) this.edits.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  /** Run one write, treating a rejection as a write that did not land. */
  private async attempt(write: { name: string; op: 'set' | 'clear'; value?: unknown }): Promise<boolean> {
    try {
      if (write.op === 'clear') {
        await this.deps.scope.unset(write.name)
        return !this.deps.schema.hasPath(this.snapshot().user, [write.name])
      }
      await this.deps.scope.set(write.name, write.value)
      // Compared structurally: `draftRoutes` is an array, and a reference
      // comparison would call every accepted route list a failed save.
      const stored = this.deps.schema.hasPath(this.snapshot().user, [write.name])
        ? (this.snapshot().user as Record<string, unknown>)[write.name]
        : undefined
      return JSON.stringify(stored) === JSON.stringify(write.value)
    } catch {
      return false
    }
  }

  private spec(field: string): RavenFieldSpec | undefined {
    return this.specs().find(entry => entry.name === field)
  }

  inject(): RavenCardFace {
    return {
      hooks: { ravenCard: this.store },
      toggle: () => {
        this.open = !this.open
        this.publish()
      },
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      resetField: (field) => {
        const spec = this.spec(field)
        if (spec === undefined) return
        // Seed the control with what the field will re-inherit, so a reset
        // previews the composition layer instead of blanking the control and
        // implying the setting is about to disappear.
        this.stage(field, { text: inheritedText(this.snapshot(), spec), clear: true })
      },
      save: () => { void this.commit() },
      discard: () => {
        if (this.edits.size === 0 && !this.failed) return
        this.edits.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose()
  }
}
