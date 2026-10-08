import type { ServerResponse } from 'node:http'
import type { UserId } from '@wemux/domain'
import type { Notifications } from '../application/notifications.ts'

const maximumPendingBytes = 1024 * 1024

/** Project events are invalidations, never replayable Journal/activity facts. */
export class ProjectStreams {
  private readonly clients = new Set<ServerResponse>()
  private readonly notifications: Notifications
  constructor(notifications: Notifications) { this.notifications = notifications;}
  open(response: ServerResponse, projectId: string, actor: UserId, authorize: () => Promise<unknown>, credentialAuthorize: () => Promise<unknown> = authorize): void {
    let closed = false, checking = false, dirty = false, heartbeat = false, generation = 0
    let pending: string[] = [], pendingBytes = 0
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(timer); unsubscribe(); unsubscribeAuthorization()
      pending = []; pendingBytes = 0
      this.clients.delete(response)
    }
    const fail = () => { cleanup(); response.destroy() }
    const write = (data: string): boolean => {
      if (closed) return false
      if (!response.write(data)) { fail(); return false }
      return true
    }
    const pump = async () => {
      if (checking || closed) return
      checking = true
      try {
        while (!closed && (dirty || pending.length)) {
          dirty = false
          const started = generation, batchLength = pending.length
          await credentialAuthorize()
          if (closed) return
          if (started !== generation) continue
          await authorize()
          if (closed) return
          if (started !== generation) continue
          for (const frame of pending.splice(0, batchLength)) {
            pendingBytes -= Buffer.byteLength(frame)
            if (!write(frame)) return
          }
          if (heartbeat) { heartbeat = false; write(': heartbeat\n\n') }
        }
      } catch { fail() }
      finally { checking = false }
    }
    const unsubscribe = this.notifications.onProject(projectId, event => {
      if (closed) return
      const frame = `event: project.event\ndata: ${JSON.stringify(event)}\n\n`
      pendingBytes += Buffer.byteLength(frame)
      if (pendingBytes > maximumPendingBytes) { fail(); return }
      pending.push(frame)
      void pump()
    })
    const reauthorize = () => {
      if (closed) return
      generation++; dirty = true; heartbeat = true
      void pump()
    }
    const unsubscribeAuthorization = this.notifications.onAuthorization(actor, reauthorize)
    this.clients.add(response)
    const timer = setInterval(reauthorize, 15000)
    timer.unref()
    response.on('close', cleanup)
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    response.flushHeaders()
    // Every connection requires an authoritative query refresh; Last-Event-ID is ignored.
    write(': revalidate\n\n')
  }
  close(): void { for (const client of this.clients) client.destroy() }
}
