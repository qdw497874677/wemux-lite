import type { ServerResponse } from 'node:http'
import type { SessionId, UserId } from '@wemux/domain'
import { ServerService } from '../application/server-service.ts'

export class SessionStreams {
  private readonly clients = new Set<ServerResponse>()
  private readonly service: ServerService
  constructor(service: ServerService) { this.service = service;}
  open(response: ServerResponse, sessionId: SessionId, fromSeq: number, actor?: UserId, credentialAuthorize?: () => Promise<unknown>, resourceAuthorize?: () => Promise<unknown>, credentialActor = actor): void {
    let cursor = fromSeq, pumping = false, dirty = true, replay = true, heartbeat = false, closed = false, generation = 0
    this.clients.add(response)
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(timer); unsubscribe(); unsubscribeAuthorization(); this.clients.delete(response)
    }
    const fail = () => { cleanup(); response.destroy() }
    const write = (data: string): boolean => {
      if (closed) return false
      if (!response.write(data)) { fail(); return false }
      return true
    }
    const pump = async () => {
      if (pumping || closed) return
      pumping = true
      try {
        while (dirty && !closed) {
          dirty = false
          const started = generation, readEvents = replay, sendHeartbeat = heartbeat
          replay = false; heartbeat = false
          await credentialAuthorize?.()
          if (closed) return
          if (started !== generation) { replay ||= readEvents; heartbeat ||= sendHeartbeat; dirty = true; continue }
          if (readEvents) {
            const page = await this.service.events(sessionId, cursor, 500, actor)
            if (closed) return
            if (started !== generation) { replay = true; heartbeat ||= sendHeartbeat; dirty = true; continue }
            for (const event of page.events) {
              if (!write(`id: ${event.seq}\nevent: session.event\ndata: ${JSON.stringify(event)}\n\n`)) return
              cursor = event.seq + 1
            }
            if (page.nextSeq) { replay = true; dirty = true }
            else if (!write(`event: freshness\ndata: ${JSON.stringify(page.freshness)}\n\n`)) return
          } else {
            // Idle authorization must not query Journal or manufacture freshness.
            await resourceAuthorize?.()
            if (closed) return
            if (started !== generation) { heartbeat ||= sendHeartbeat; dirty = true; continue }
          }
          if (sendHeartbeat) write(': heartbeat\n\n')
        }
      } catch { fail() }
      finally { pumping = false }
    }
    const schedule = (readEvents: boolean, tick = false) => {
      if (closed) return
      generation++; dirty = true; replay ||= readEvents; heartbeat ||= tick
      void pump()
    }
    // Subscribe before reading history so no live event is lost during replay.
    const unsubscribe = this.service.notifications.onSession(sessionId, () => schedule(true))
    const unsubscribeAuthorization = credentialActor === undefined ? () => undefined : this.service.notifications.onAuthorization(credentialActor, () => schedule(true))
    const timer = setInterval(() => schedule(false, true), 15000)
    timer.unref()
    response.on('close', cleanup)
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    response.flushHeaders()
    void pump()
  }
  close(): void { for (const client of this.clients) client.destroy() }
}
