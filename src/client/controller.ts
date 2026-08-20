/**
 * Bridges the `raven-research` settings scope onto the card's staged form.
 *
 * All the rules live in `card-state.ts`, which is pure; this class owns only
 * the two things that cannot be pure — the staged edits and the writes.
 * @module
 */

import { createSnapshotStore, type SettingsScope, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

import {
  plannedWrites,
  projectCardState,
  type RavenCardState,
  type RavenScopeSnapshot,
} from './card-state.js'

/** The face the card's slot registration injects. */
export interface RavenCardFace {
  hooks: {
    /** Card snapshot, bound by the renderer as `useRavenCard`. */
    ravenCard: SnapshotStore<RavenCardState>
  }
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
}

export class RavenCardController {
  private readonly edits = new Map<string, string>()
  private readonly store: SnapshotStore<RavenCardState>
  private readonly unsubscribe: () => void

  constructor(private readonly scope: SettingsScope<Record<string, unknown>>) {
    this.store = createSnapshotStore(this.project())
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  private project(): RavenCardState {
    return projectCardState(this.scope.getSnapshot() as RavenScopeSnapshot, this.edits)
  }

  private publish(): void {
    this.store.set(this.project())
  }

  private write(operation: Promise<void>): void {
    // A settled write reloads Host state on failure, so republishing after it
    // settles is what makes the card show what the Host actually accepted
    // rather than the optimistic value the user typed.
    void operation.then(() => { this.publish() }, () => { this.publish() })
  }

  inject(): RavenCardFace {
    return {
      hooks: { ravenCard: this.store },
      edit: (field, text) => {
        this.edits.set(field, text)
        this.publish()
      },
      resetField: (field) => {
        // Clearing re-inherits the composition layer, so a staged edit for the
        // same field is meaningless once the field is cleared.
        this.edits.delete(field)
        this.publish()
        this.write(this.scope.unset(field))
      },
      save: () => {
        const writes = plannedWrites(this.edits)
        // Refused rather than partially applied: saving the valid half of a form
        // leaves the namespace in a state nobody asked for and nobody saw.
        if (writes === undefined) return
        this.edits.clear()
        this.publish()
        for (const entry of writes) this.write(this.scope.set(entry.name, entry.value))
      },
      discard: () => {
        this.edits.clear()
        this.publish()
      },
    }
  }

  dispose(): void {
    this.unsubscribe()
  }
}
