import { spawn, type ChildProcess } from 'node:child_process'

export interface ProcessOptions {
  readonly cwd: string
  readonly timeoutMs: number
  readonly env?: NodeJS.ProcessEnv
  readonly capture?: boolean
}

export interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const exited = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    const timeout = setTimeout(() => {
      child.removeListener('close', exited)
      resolve(false)
    }, timeoutMs)
    child.once('close', exited)
  })
}

async function requireExit(child: ChildProcess, timeoutMs: number, label: string): Promise<void> {
  if (await waitForExit(child, timeoutMs)) return
  throw new Error(`${label} did not exit within ${timeoutMs}ms`)
}

async function terminateTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || hasExited(child)) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (!(await waitForExit(killer, 10_000))) {
      killer.kill()
      await requireExit(killer, 2_000, 'taskkill')
    }
    if (await waitForExit(child, 5_000)) return
    child.kill()
    await requireExit(child, 2_000, `process tree ${child.pid}`)
    return
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  if (await waitForExit(child, 2_000)) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  await requireExit(child, 5_000, `process group ${child.pid}`)
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: process.platform !== 'win32',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk })

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error(`${command} timed out after ${options.timeoutMs}ms`))
  }, options.timeoutMs)
  const interrupt = () => controller.abort(new Error(`${command} interrupted by SIGINT`))
  const terminate = () => controller.abort(new Error(`${command} interrupted by SIGTERM`))
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)

  try {
    return await new Promise<ProcessResult>((resolve, reject) => {
      let settled = false
      let terminating = false
      const settle = (callback: () => void) => {
        if (settled) return
        settled = true
        callback()
      }
      child.once('error', error => {
        if (!terminating) settle(() => reject(error))
      })
      child.once('close', (code) => {
        if (terminating) return
        settle(() => {
          if (code === 0) resolve({ stdout, stderr })
          else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}\n${stdout}\n${stderr}`))
        })
      })
      controller.signal.addEventListener('abort', () => {
        terminating = true
        const reason = controller.signal.reason
        void terminateTree(child).then(
          () => settle(() => reject(reason)),
          error => settle(() => reject(new AggregateError([reason, error], `failed to terminate ${command}`))),
        )
      }, { once: true })
    })
  } finally {
    clearTimeout(timeout)
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}
