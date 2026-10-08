import type { ServerResponse } from 'node:http'
import type { ProjectId, UserId } from '@wemux/domain'
import type { CanvasCollaborationService, CanvasCollaborationEvent, CanvasPresence } from '../application/canvas-collaboration-service.ts'
import type { Notifications } from '../application/notifications.ts'
import { AppError } from '../application/errors.ts'

export class CanvasCollaborationStreams {
  private readonly clients = new Set<ServerResponse>()
  constructor(private readonly collaboration: CanvasCollaborationService, private readonly notifications: Notifications) {}

  async open(response: ServerResponse, actor: UserId, projectId: ProjectId, _after: number, credentialAuthorize?: () => Promise<unknown>): Promise<void> {
    let revision = 0, generation = 0, closed = false, opened = false
    let visible = new Map<UserId, CanvasPresence>()
    let refreshing = false, dirty = false, heartbeatPending = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const write = (frame: string) => {
      if (closed) return
      if (!response.write(frame)) { response.destroy(); throw new Error('Canvas stream backpressure') }
    }
    const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    const sendPresence = (type: CanvasCollaborationEvent['type'], userId: UserId, payload: unknown) => {
      const event: CanvasCollaborationEvent = { id: ++revision, type, projectId, actorId: userId, payload, at: new Date().toISOString() }
      send(type, event)
    }
    const refresh = async () => {
      for (let attempt = 0; attempt < 8 && !closed; attempt++) {
        const started = generation
        await credentialAuthorize?.()
        if (closed) return
        if (started !== generation) continue
        const current = await this.collaboration.snapshot(actor, projectId)
        if (closed) return
        // Invalidation is synchronous, not just a queued refresh. This also
        // guards the await between the service's final check and stream output.
        if (started !== generation) continue
        const next = new Map(current.presence.map(value => [value.userId, value]))
        if (!opened) {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
          response.flushHeaders()
          // Reconnect uses current authorized state, never shared history.
          send('snapshot', current)
          opened = true
        } else {
          for (const userId of visible.keys()) if (!next.has(userId)) sendPresence('presence.left', userId, { userId })
          for (const [userId, value] of next) {
            if (JSON.stringify(visible.get(userId)) !== JSON.stringify(value)) sendPresence('presence.updated', userId, value)
          }
        }
        visible = next
        return
      }
      if (!closed) throw new AppError(503, 'Canvas presence changed during authorization; retry', 'canvas_presence_changed')
    }
    const pump = async () => {
      if (refreshing || closed || !opened) return
      refreshing = true
      try {
        while (dirty && !closed) {
          dirty = false
          const sendHeartbeat = heartbeatPending
          heartbeatPending = false
          await refresh()
          if (sendHeartbeat && !closed) write(': heartbeat\n\n')
        }
      } catch {
        // Fail closed on revocation, unstable reads and unexpected failures.
        if (!closed) {
          try { send('authorization', { status: 'revoked' }) } catch { /* connection already failed */ } finally { close() }
        }
      } finally { refreshing = false }
    }
    const schedule = () => {
      generation++; dirty = true
      void pump()
    }
    // Register before any authorization await. The service subscription covers
    // every candidate Session, including hidden and newly published presence.
    const unsubscribe = this.collaboration.subscribe(projectId, schedule)
    const unsubscribeAuthorization = this.notifications.onAuthorization(actor, schedule)
    const close = (end = true) => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe(); unsubscribeAuthorization()
      response.off('close', onClose); response.off('error', onClose)
      response.socket?.off('close', onClose)
      if (opened) this.collaboration.leave(actor, projectId)
      this.clients.delete(response)
      if (end) response.end()
    }
    const onClose = () => close()
    response.once('close', onClose); response.once('error', onClose)
    response.socket?.once('close', onClose)
    this.clients.add(response)
    refreshing = true
    try { await refresh() }
    catch (error) { close(false); throw error }
    finally { refreshing = false }
    if (closed) return
    if (dirty) void pump()
    heartbeat = setInterval(() => { if (!closed) { heartbeatPending = true; schedule() } }, 15_000)
    heartbeat.unref()
  }
  close(): void { for (const client of this.clients) client.destroy() }
}
