import type { ServerResponse } from 'node:http'
import type { SessionId, UserId } from '@wemux/domain'
import type { Notifications } from '../application/notifications.ts'

const maximumPendingBytes = 1024 * 1024
const authorizationIntervalMs = 1_000

export class TerminalStreams {
  private readonly clients = new Set<() => void>()
  private readonly notifications: Notifications
  constructor(notifications: Notifications) { this.notifications = notifications; }
  open(response: ServerResponse, sessionId: SessionId, actor: UserId, projectId: string, authorize: () => Promise<unknown>): void {
    let closed = false, pumping = false, dirty = true, epoch = 0
    let pending: string[] = [], pendingBytes = 0
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      unsubscribe(); unsubscribeAuthorization(); unsubscribeSession(); unsubscribeProject()
      pending = []; pendingBytes = 0
      this.clients.delete(close)
    }
    const close = () => { cleanup(); response.end() }
    const write = (frame: string): boolean => {
      if (closed) return false
      if (!response.write(frame)) { cleanup(); response.destroy(new Error('Terminal stream backpressure')); return false }
      return true
    }
    // One authorization query per batch, never concurrent per client. A batch is
    // frozen before the query so newly arriving output cannot use an older check.
    const pump = async () => {
      if (pumping || closed) return
      pumping = true
      try {
        while (!closed && (dirty || pending.length)) {
          dirty = false
          const generation = epoch, batchLength = pending.length
          await authorize()
          if (closed) return
          if (generation !== epoch) continue
          const batch = pending.splice(0, batchLength)
          for (const frame of batch) {
            pendingBytes -= Buffer.byteLength(frame)
            if (!write(frame)) return
          }
        }
      } catch { close() }
      finally { pumping = false }
    }
    const enqueue = (event: string, data: unknown) => {
      if (closed) return
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      pendingBytes += Buffer.byteLength(frame)
      if (pendingBytes > maximumPendingBytes) {
        cleanup(); response.destroy(new Error('Terminal stream authorization buffer exceeded 1048576 bytes')); return
      }
      pending.push(frame)
      void pump()
    }
    const revalidate = () => { if (!closed) { epoch++; dirty = true; void pump() } }
    const unsubscribe = this.notifications.onTerminal(sessionId, event => enqueue(event.type, event))
    const unsubscribeAuthorization = this.notifications.onAuthorization(actor, revalidate)
    const unsubscribeSession = this.notifications.onSession(sessionId, revalidate)
    const unsubscribeProject = this.notifications.onProject(projectId, revalidate)
    // Credential expiry and mutation paths without notifications are checked at
    // most one second apart even on an idle stream. No unbounded query backlog.
    let heartbeatTicks = 0
    const timer = setInterval(() => {
      revalidate()
      if (++heartbeatTicks === 15) { heartbeatTicks = 0; enqueue('heartbeat', {}) }
    }, authorizationIntervalMs)
    timer.unref()
    response.once('close', cleanup)
    this.clients.add(close)
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    response.flushHeaders()
    enqueue('ready', { sessionId })
  }
  close(): void { for (const close of this.clients) close() }
}
