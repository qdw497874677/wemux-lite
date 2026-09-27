import type { McpConnectorDefinition } from '@wemux/connector'

export interface SupervisedMcpProcess {
  readonly pid: number | null
  readonly stderrTail: string
  readonly startedAt: number
  touch(): void
  close(): Promise<void>
  forceClose(): void
  readonly crashed?: Promise<void>
}

export interface McpProcessSupervisorOptions {
  readonly maximumProcesses?: number
  readonly maximumProcessesPerSession?: number
  readonly idleTimeoutMs?: number
  readonly queueTimeoutMs?: number
  readonly shutdownGraceMs?: number
  readonly shutdownForceMs?: number
  readonly now?: () => number
  readonly crashBackoffMs?: readonly number[]
}

type Entry = SupervisedMcpProcess & { readonly key: string; readonly sessionId: string; lastUsedAt: number }

export class McpProcessSupervisor {
  private readonly entries = new Map<string, Entry>()
  private closing = false
  private readonly timer: NodeJS.Timeout
  private readonly options: Required<Omit<McpProcessSupervisorOptions, 'crashBackoffMs'>> & { readonly crashBackoffMs: readonly number[] }
  private readonly crashes = new Map<string, { count: number; retryAt: number }>()

  constructor(options: McpProcessSupervisorOptions = {}) {
    this.options = { maximumProcesses: options.maximumProcesses ?? 16, maximumProcessesPerSession: options.maximumProcessesPerSession ?? 2, idleTimeoutMs: options.idleTimeoutMs ?? 5 * 60_000, queueTimeoutMs: options.queueTimeoutMs ?? 30_000, shutdownGraceMs: options.shutdownGraceMs ?? 5_000, shutdownForceMs: options.shutdownForceMs ?? 2_000, now: options.now ?? Date.now, crashBackoffMs: options.crashBackoffMs ?? [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] }
    this.timer = setInterval(() => void this.reapIdle(), Math.min(30_000, this.options.idleTimeoutMs))
    this.timer.unref()
  }

  async acquire<T extends SupervisedMcpProcess>(sessionId: string, connector: McpConnectorDefinition, create: () => Promise<T>, instanceRevision = ''): Promise<T> {
    if (this.closing) throw new Error('MCP supervisor is shutting down')
    const connectorKey = `${sessionId}\0${connector.id}`
    const key = `${connectorKey}\0${connector.revision}\0${instanceRevision}`
    const existing = this.entries.get(key)
    if (existing) { existing.touch(); existing.lastUsedAt = this.options.now(); return existing as unknown as T }
    await Promise.all([...this.entries.values()].filter(entry => entry.key.startsWith(`${connectorKey}\0`)).map(entry => this.closeEntry(entry)))
    const crash = this.crashes.get(connectorKey)
    if (crash && crash.retryAt > this.options.now()) await delay(crash.retryAt - this.options.now())
    const deadline = this.options.now() + this.options.queueTimeoutMs
    while (this.entries.size >= this.options.maximumProcesses || [...this.entries.values()].filter(item => item.sessionId === sessionId).length >= this.options.maximumProcessesPerSession) {
      await this.reapIdle()
      if (this.options.now() >= deadline) throw new Error('MCP process capacity is unavailable')
      await new Promise(resolve => setTimeout(resolve, 20))
      if (this.closing) throw new Error('MCP supervisor is shutting down')
    }
    const process = await create()
    const entry: Entry = { ...process, key, sessionId, lastUsedAt: this.options.now(), touch: () => { process.touch(); entry.lastUsedAt = this.options.now() }, close: process.close.bind(process), forceClose: process.forceClose.bind(process) }
    this.entries.set(key, entry)
    void process.crashed?.finally(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      if (this.closing) return
      const previous = this.crashes.get(connectorKey)?.count ?? 0
      const count = previous + 1
      const delayMs = this.options.crashBackoffMs[Math.min(count - 1, this.options.crashBackoffMs.length - 1)] ?? 30_000
      this.crashes.set(connectorKey, { count, retryAt: this.options.now() + delayMs })
    })
    return entry as unknown as T
  }

  async releaseSession(sessionId: string): Promise<void> {
    await Promise.all([...this.entries.values()].filter(entry => entry.sessionId === sessionId).map(entry => this.closeEntry(entry)))
  }

  activePids(): readonly number[] { return [...this.entries.values()].flatMap(entry => entry.pid === null ? [] : [entry.pid]) }

  async shutdown(): Promise<void> {
    if (this.closing) return
    this.closing = true
    clearInterval(this.timer)
    const entries = [...this.entries.values()]
    const closing = Promise.all(entries.map(entry => this.closeEntry(entry)))
    const graceful = await Promise.race([closing.then(() => true), delay(this.options.shutdownGraceMs).then(() => false)])
    if (!graceful) {
      for (const entry of entries) entry.forceClose()
      await Promise.race([closing, delay(this.options.shutdownForceMs)])
    }
  }

  forceShutdown(): void {
    this.closing = true
    clearInterval(this.timer)
    for (const entry of this.entries.values()) entry.forceClose()
    this.entries.clear()
  }

  private async reapIdle(): Promise<void> {
    const cutoff = this.options.now() - this.options.idleTimeoutMs
    await Promise.all([...this.entries.values()].filter(entry => entry.lastUsedAt <= cutoff).map(entry => this.closeEntry(entry)))
  }

  private async closeEntry(entry: Entry) {
    if (this.entries.get(entry.key) !== entry) return
    this.entries.delete(entry.key)
    await entry.close().catch(() => undefined)
  }
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref())
