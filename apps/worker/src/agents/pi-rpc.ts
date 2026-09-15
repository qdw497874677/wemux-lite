import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants, readdirSync, readFileSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'

export async function findPi(command = 'pi'): Promise<string> {
  const candidates = command.includes('/') || command.includes('\\') ? [resolve(command)] : (process.env.PATH ?? '').split(delimiter).map(dir => resolve(dir, command))
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path } catch { /* next PATH entry */ }
  }
  throw new Error(`Pi executable not found: ${command}; install and authenticate Pi separately`)
}

type Packet = Record<string, any>

/** One JSONL connection, with bounded requests and deterministic subprocess teardown. */
export class PiRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private sequence = 0
  private buffer = ''
  private stderr = ''
  private failure: Error | undefined
  private closing: Promise<void> | undefined
  private exited: Promise<void>
  private readonly descendants = new Map<number, string>()
  private readonly tracking: NodeJS.Timeout
  onEvent: (event: Packet) => void = () => {}
  onFailure: (error: Error) => void = () => {}

  constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, private readonly timeout: number) {
    this.child = spawn(executable, ['--mode', 'rpc', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()))
    this.tracking = setInterval(() => this.trackDescendants(), 100)
    this.tracking.unref()
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (text: string) => { this.stderr = (this.stderr + text).slice(-8192) })
    this.child.stdout.on('data', (text: string) => {
      this.buffer += text
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, '')
        this.buffer = this.buffer.slice(newline + 1)
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as Packet
          if (!event || typeof event.type !== 'string') throw new Error('Missing RPC event type')
          if (event.type === 'response') {
            const request = this.pending.get(event.id)
            if (request) {
              clearTimeout(request.timer); this.pending.delete(event.id)
              if (event.success) request.resolve(event.data)
              else request.reject(new Error(`Pi ${event.command} failed: ${event.error ?? 'unknown error'}`))
            }
          } else this.onEvent(event)
        } catch (cause) { this.fail(new Error(`Invalid Pi RPC output: ${cause instanceof Error ? cause.message : cause}`)) }
      }
      if (this.buffer.length > 16 * 1024 * 1024) this.fail(new Error('Pi RPC record exceeds 16 MiB'))
    })
    this.child.on('error', error => this.fail(error))
    this.child.stdin.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => {
      if (!this.closing) this.fail(new Error(`Pi RPC exited before completion (${code ?? signal})${this.stderr ? `: ${this.stderr}` : ''}`))
    })
  }

  request(type: string, fields: Packet = {}): Promise<any> {
    if (this.failure || this.closing) return Promise.reject(this.failure ?? new Error('Pi RPC is closed'))
    const id = `wemux-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Pi RPC ${type} timed out after ${this.timeout}ms`)), this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ ...fields, type, id }) + '\n')
    })
  }

  private fail(error: Error) {
    if (this.failure || this.closing) return
    this.failure = error
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
    this.onFailure(error)
    void this.close()
  }

  // Linux /proc is best-effort, not an OS containment boundary. Remember start times
  // to avoid signalling a recycled PID, including descendants that later detach.
  private trackDescendants() {
    if (process.platform !== 'linux' || !this.child.pid) return
    try {
      const processes = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
        try {
          const fields = readFileSync(`/proc/${name}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' ')
          return [{ pid: Number(name), parent: Number(fields[1]), start: fields[19]! }]
        } catch { return [] }
      })
      const parents = new Set<number>()
      if (this.child.exitCode === null && this.child.signalCode === null) parents.add(this.child.pid)
      for (const item of processes) if (this.descendants.get(item.pid) === item.start) parents.add(item.pid)
      let changed = true
      while (changed) {
        changed = false
        for (const item of processes) if (parents.has(item.parent) && !parents.has(item.pid)) {
          parents.add(item.pid); this.descendants.set(item.pid, item.start); changed = true
        }
      }
    } catch { /* /proc unavailable: original process group is still terminated */ }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Pi RPC closed')) }
      this.pending.clear()
      this.trackDescendants()
      clearInterval(this.tracking)
      const kill = (signal: NodeJS.Signals) => {
        for (const [pid, start] of this.descendants) {
          try {
            const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' ')
            if (fields[19] === start) process.kill(pid, signal)
          } catch { /* exited or no longer ours */ }
        }
        try {
          if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal)
          else this.child.kill(signal)
        } catch { /* already exited */ }
      }
      kill('SIGTERM')
      let timer: NodeJS.Timeout | undefined
      await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 500) })])
      if (timer) clearTimeout(timer)
      kill('SIGKILL')
      // Detached, already reparented children may hold these pipes forever.
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy()
      this.child.unref()
    })()
    return this.closing
  }
}
