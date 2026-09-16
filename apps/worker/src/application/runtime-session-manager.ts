import type { ApprovalId, SessionId } from '@wemux/domain'
import type { AgentRuntimeSession, RuntimeCommand, RuntimeSessionAdapter, RuntimeSessionOpenInput } from './ports/runtime-session.js'

export interface RuntimeSessionLease {
  readonly generation: number
  readonly session: AgentRuntimeSession
  release(): Promise<void>
  fault(): Promise<void>
}

interface Entry {
  readonly session: AgentRuntimeSession
  readonly fingerprint: string
  readonly generation: number
  leases: number
  lastUsedAt: number
  timer: NodeJS.Timeout | null
  closing: Promise<void> | null
}

export interface RuntimeSessionManagerOptions {
  readonly idleTtlMs?: number
  readonly maxIdle?: number
  readonly now?: () => number
}

/**
 * Serializes lifecycle mutations per product Session. It never evicts a leased
 * instance, and a failed/changed instance is fully closed before replacement.
 */
export class RuntimeSessionManager {
  private readonly entries = new Map<SessionId, Entry>()
  private readonly locks = new Map<SessionId, Promise<void>>()
  private readonly idleTtlMs: number
  private readonly maxIdle: number
  private readonly now: () => number
  private generation = 0
  private stopped = false

  constructor(private readonly adapter: RuntimeSessionAdapter, options: RuntimeSessionManagerOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? 5 * 60_000
    this.maxIdle = options.maxIdle ?? 4
    this.now = options.now ?? Date.now
  }

  acquire(open: RuntimeSessionOpenInput, fingerprint: string): Promise<RuntimeSessionLease> {
    return this.serial(open.sessionId, async () => {
      if (this.stopped) throw new Error('Runtime session manager is closed')
      let entry = this.entries.get(open.sessionId)
      if (entry?.closing) { await entry.closing; entry = undefined }
      if (entry && entry.fingerprint !== fingerprint) {
        await this.closeEntry(open.sessionId, entry)
        entry = undefined
      }
      if (!entry) {
        entry = { session: await this.adapter.openSession(open), fingerprint, generation: ++this.generation, leases: 0, lastUsedAt: this.now(), timer: null, closing: null }
        this.entries.set(open.sessionId, entry)
      }
      if (entry.leases) throw new Error('Runtime session already has an active operation')
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
      entry.leases++
      let released = false
      const settle = async (faulted: boolean) => {
        if (released) return
        released = true
        await this.serial(open.sessionId, async () => {
          const current = this.entries.get(open.sessionId)
          if (!current || current.generation !== entry!.generation) return
          current.leases = Math.max(0, current.leases - 1)
          current.lastUsedAt = this.now()
          if (faulted || this.stopped) await this.closeEntry(open.sessionId, current)
          else if (!current.leases) this.arm(open.sessionId, current)
        })
        if (!faulted) await this.enforceIdleLimit()
      }
      return { generation: entry.generation, session: entry.session, release: () => settle(false), fault: () => settle(true) }
    })
  }

  has(sessionId: SessionId) { return this.entries.has(sessionId) }

  async command(sessionId: SessionId, command: RuntimeCommand): Promise<void> {
    await this.serial(sessionId, async () => {
      const entry = this.entries.get(sessionId)
      if (!entry) throw new Error('Runtime session is not active')
      await entry.session.command(command)
    })
  }

  async resolveApproval(sessionId: SessionId, approvalId: ApprovalId, decision: 'approve' | 'deny'): Promise<void> {
    await this.serial(sessionId, async () => {
      const entry = this.entries.get(sessionId)
      if (!entry) throw new Error('Runtime session is not active')
      await entry.session.resolveApproval(approvalId, decision)
    })
  }

  async closeSession(sessionId: SessionId): Promise<void> {
    await this.serial(sessionId, async () => {
      const entry = this.entries.get(sessionId)
      if (entry) await this.closeEntry(sessionId, entry)
    })
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    await Promise.all([...this.entries.keys()].map(id => this.closeSession(id)))
  }

  snapshot() {
    return [...this.entries].map(([sessionId, entry]) => ({ sessionId, generation: entry.generation, leases: entry.leases, fingerprint: entry.fingerprint }))
  }

  private arm(sessionId: SessionId, entry: Entry) {
    if (this.idleTtlMs <= 0) { void this.closeSession(sessionId); return }
    entry.timer = setTimeout(() => { void this.serial(sessionId, async () => {
      const current = this.entries.get(sessionId)
      if (current?.generation === entry.generation && current.leases === 0) await this.closeEntry(sessionId, current)
    }) }, this.idleTtlMs)
    entry.timer.unref()
  }

  private async enforceIdleLimit() {
    const idle = [...this.entries.entries()].filter(([, entry]) => entry.leases === 0 && !entry.closing).sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    for (const [id] of idle.slice(0, Math.max(0, idle.length - this.maxIdle))) await this.closeSession(id)
  }

  private async closeEntry(sessionId: SessionId, entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    if (!entry.closing) entry.closing = entry.session.close()
    try { await entry.closing }
    finally { if (this.entries.get(sessionId)?.generation === entry.generation) this.entries.delete(sessionId) }
  }

  private serial<T>(id: SessionId, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const result = previous.then(work, work)
    const tail = result.then(() => undefined, () => undefined)
    this.locks.set(id, tail)
    void tail.finally(() => { if (this.locks.get(id) === tail) this.locks.delete(id) })
    return result
  }
}
