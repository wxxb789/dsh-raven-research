/** Race an already-started operation against an optional AbortSignal. */
export function settleWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) {
    // The operation already exists; sink its later rejection before throwing.
    void operation.catch(() => undefined)
    signal.throwIfAborted()
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      callback()
    }
    const aborted = (): void => { finish(() => { reject(signal.reason) }) }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    void operation.then(
      value => { finish(() => { resolve(value) }) },
      error => { finish(() => { reject(error) }) },
    )
  })
}
