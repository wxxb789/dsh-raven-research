/**
 * The controller as the page drives it: staging, the write path, the read-back
 * that decides whether a Save landed, and disposal.
 *
 * `card-state.ts` decides every RULE and is covered on its own; nothing here
 * re-tests a rule. What is tested here is the half that cannot be pure — that a
 * Save issues the planned writes and no others, that it judges the outcome by
 * what the Host holds rather than by the absence of an exception, that a refused
 * write keeps the drafts so the user can correct them, and that a disposed
 * controller stops publishing.
 */

import { describe, expect, it, vi } from 'vitest'

import { RavenCardController } from '../../src/client/controller.js'

import type { RavenCardState } from '../../src/client/card-state.js'
import type {
  RavenSchemaNode,
  RavenSettingsDescribeFace,
  RavenSettingsSchemaService,
} from '../../src/client/slot-contract.js'

const NAMESPACE = 'raven-research'

/** A root node shaped like the one the Host registers, narrowed to two fields. */
const SCHEMA: RavenSchemaNode = {
  type: 'object',
  dict: {
    sourceVerification: {
      type: 'union',
      list: [
        { type: 'const', value: 'remote' },
        { type: 'const', value: 'structural-only' },
      ],
    },
    sourceCheckTimeoutMs: { type: 'number' },
  },
}

function schemaService(): RavenSettingsSchemaService {
  return {
    rehydrate: () => SCHEMA,
    // The Host's own rule, narrowed: a number field refuses anything that is not
    // one. The card must show THIS text rather than inventing its own.
    validate: (node, draft) => node.type === 'number' && typeof draft !== 'number'
      ? 'expect a number'
      : undefined,
    nodeAtPath: (root, path) => path.length === 1 ? root.dict?.[path[0] ?? ''] : root,
    hasPath: (value, path) => typeof value === 'object' && value !== null
      && Object.hasOwn(value as Record<string, unknown>, path[0] ?? ''),
  }
}

interface Harness {
  readonly controller: RavenCardController
  readonly face: ReturnType<RavenCardController['inject']>
  readonly snapshot: () => RavenCardState
  readonly writes: { name: string; value?: unknown; op: 'set' | 'clear' }[]
  readonly disposals: () => number
  readonly user: Record<string, unknown>
}

/**
 * A controller over stub Harness faces. `accept` decides whether a write lands,
 * which is the only way to exercise the read-back: the controller trusts the
 * snapshot, never the promise.
 */
function harness(options: { accept?: boolean; reject?: boolean } = {}): Harness {
  const accept = options.accept ?? true
  const user: Record<string, unknown> = {}
  const value: Record<string, unknown> = { sourceVerification: 'remote', sourceCheckTimeoutMs: 20_000 }
  const writes: { name: string; value?: unknown; op: 'set' | 'clear' }[] = []
  let disposals = 0
  const listeners: (() => void)[] = []
  const scope = {
    getSnapshot: () => ({ status: 'ready' as const, value, base: undefined, user, writable: true, mode: 'host' as const, revision: 1 }),
    subscribe: (listener: () => void) => {
      listeners.push(listener)
      return () => { disposals += 1 }
    },
    set: async (name: string, next: unknown) => {
      writes.push({ name, value: next, op: 'set' })
      if (options.reject === true) throw new Error('refused by the Host')
      if (accept) {
        user[name] = next
        value[name] = next
      }
    },
    unset: async (name: string) => {
      writes.push({ name, op: 'clear' })
      if (accept) delete user[name]
    },
  }
  const describe: RavenSettingsDescribeFace = {
    getSnapshot: () => ({ status: 'ready', view: { namespaces: [{ ns: NAMESPACE, schema: SCHEMA }] } }),
    subscribe: () => () => { disposals += 1 },
  }
  const controller = new RavenCardController({
    scope: scope as never,
    describe,
    schema: schemaService(),
    namespace: NAMESPACE,
  })
  const face = controller.inject()
  return {
    controller,
    face,
    snapshot: () => face.hooks.ravenCard.getSnapshot() as RavenCardState,
    writes,
    disposals: () => disposals,
    user,
  }
}

describe('RavenCardController', () => {
  it('stages an edit without writing, and only a Save crosses the wire', () => {
    const test = harness()
    test.face.edit('sourceVerification', 'structural-only')
    expect(test.writes).toHaveLength(0)
    expect(test.snapshot().dirty).toBe(true)
    expect(test.snapshot().fields[0]?.text).toBe('structural-only')
  })

  it('clears the staged edits once every write is confirmed in the Host snapshot', async () => {
    const test = harness()
    test.face.edit('sourceVerification', 'structural-only')
    test.face.save()
    await vi.waitFor(() => { expect(test.snapshot().saving).toBe(false) })
    expect(test.writes).toStrictEqual([{ name: 'sourceVerification', value: 'structural-only', op: 'set' }])
    expect(test.snapshot().dirty).toBe(false)
    expect(test.snapshot().failed).toBe(false)
    expect(test.user.sourceVerification).toBe('structural-only')
  })

  it('keeps the drafts and reports a failure when the Host does not hold what was written', async () => {
    const test = harness({ accept: false })
    test.face.edit('sourceVerification', 'structural-only')
    test.face.save()
    await vi.waitFor(() => { expect(test.snapshot().saving).toBe(false) })
    expect(test.snapshot().failed).toBe(true)
    // The draft survives: a user who has to retype a refused value learns
    // nothing and loses work.
    expect(test.snapshot().fields[0]?.text).toBe('structural-only')
    expect(test.snapshot().dirty).toBe(true)
  })

  it('treats a rejected write as a write that did not land rather than letting it escape', async () => {
    const test = harness({ reject: true })
    test.face.edit('sourceVerification', 'structural-only')
    test.face.save()
    await vi.waitFor(() => { expect(test.snapshot().failed).toBe(true) })
    expect(test.snapshot().saving).toBe(false)
  })

  it('refuses the whole Save when any staged draft is unacceptable, writing nothing at all', () => {
    const test = harness()
    test.face.edit('sourceVerification', 'structural-only')
    test.face.edit('sourceCheckTimeoutMs', 'not a number')
    expect(test.snapshot().invalid).toBe(true)
    test.face.save()
    expect(test.writes).toHaveLength(0)
  })

  it('discards every draft without writing, and does nothing when there is nothing to discard', () => {
    const test = harness()
    test.face.edit('sourceVerification', 'structural-only')
    test.face.discard()
    expect(test.snapshot().dirty).toBe(false)
    expect(test.writes).toHaveLength(0)
  })

  it('notifies every subscriber, isolates failures, and honors unsubscribe', () => {
    const test = harness()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = vi.fn(() => { throw new Error('subscriber failed') })
    const healthy = vi.fn()
    const unsubscribeBroken = test.face.hooks.ravenCard.subscribe(broken)
    const unsubscribeHealthy = test.face.hooks.ravenCard.subscribe(healthy)
    try {
      test.face.toggle()
      expect(test.snapshot().open).toBe(true)
      expect(broken).toHaveBeenCalledTimes(1)
      expect(healthy).toHaveBeenCalledTimes(1)
      expect(reported).toHaveBeenCalledTimes(1)

      unsubscribeHealthy()
      test.face.toggle()
      expect(test.snapshot().open).toBe(false)
      expect(broken).toHaveBeenCalledTimes(2)
      expect(healthy).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribeBroken()
      reported.mockRestore()
    }
  })

  it('releases both subscriptions on dispose', () => {
    const test = harness()
    test.controller.dispose()
    expect(test.disposals()).toBe(2)
  })

  it('does not publish after disposal, so a Save settling into a discarded card is inert', async () => {
    const test = harness()
    test.face.edit('sourceVerification', 'structural-only')
    test.face.save()
    test.controller.dispose()
    const after = test.snapshot()
    await vi.waitFor(() => { expect(test.writes).toHaveLength(1) })
    // Whatever the write did, a disposed controller must not have re-published:
    // the snapshot a discarded card leaves behind is the one it had at disposal.
    expect(test.snapshot()).toBe(after)
  })
})