import { describe, expect, it } from 'vitest'

import { runProcess } from '../../scripts/process.js'

describe('release process runner', () => {
  it('preserves the deadline reason while terminating a timed-out child', async () => {
    const started = Date.now()
    await expect(runProcess(process.execPath, [
      '--eval',
      'setInterval(() => undefined, 1000)',
    ], {
      cwd: process.cwd(),
      timeoutMs: 100,
      capture: true,
    })).rejects.toThrow('timed out after 100ms')
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
