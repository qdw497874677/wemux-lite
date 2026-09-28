import type { ServerResponse } from 'node:http'
import type { ProjectId, UserId } from '@wemux/domain'
import type { CanvasCollaborationService, CanvasCollaborationEvent } from '../application/canvas-collaboration-service.ts'
import type { Notifications } from '../application/notifications.ts'

export class CanvasCollaborationStreams {
  private readonly clients = new Set<ServerResponse>()
  private readonly collaboration: CanvasCollaborationService
  private readonly notifications: Notifications
  constructor(collaboration: CanvasCollaborationService, notifications: Notifications) {
    this.collaboration = collaboration; this.notifications = notifications
  }
  async open(response: ServerResponse, actor: UserId, projectId: ProjectId, after: number): Promise<void> {
    const snapshot = await this.collaboration.snapshot(actor, projectId)
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    response.flushHeaders()
    this.clients.add(response)
    const send = (event: string, data: unknown, id?: number) => { if (id !== undefined) response.write(`id: ${id}\n`); response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
    let authorized = true
    const sendAuthorized = (event: CanvasCollaborationEvent) => { if (authorized) sendEvent(send, event) }
    const replay = this.collaboration.eventsAfter(projectId, after)
    if (replay.contiguous) replay.events.forEach(sendAuthorized); else send('snapshot', snapshot, snapshot.revision)
    let closed = false
    const unsubscribe = this.collaboration.subscribe(projectId, sendAuthorized)
    let close = (): void => undefined
    const unsubscribeAuthorization = this.notifications.onAuthorization(actor, async () => {
      try { await this.collaboration.snapshot(actor, projectId) }
      catch { authorized = false; send('authorization', { status: 'revoked' }); close() }
    })
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
    heartbeat.unref()
    close = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); unsubscribeAuthorization(); this.collaboration.leave(actor, projectId); this.clients.delete(response); response.end() }
    response.once('close', close); response.once('error', close)
    response.socket?.once('close', close)
  }
  close(): void { for (const client of this.clients) client.destroy() }
}

function sendEvent(send: (event: string, data: unknown, id?: number) => void, event: CanvasCollaborationEvent): void { send(event.type, event, event.id) }
