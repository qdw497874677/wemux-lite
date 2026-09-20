import type { ServerResponse } from 'node:http'
import type { SessionId, UserId } from '@wemux/domain'
import { ServerService } from '../application/server-service.js'

export class SessionStreams {
  private readonly clients = new Set<ServerResponse>()
  constructor(private readonly service: ServerService) {}
  open(response: ServerResponse, sessionId: SessionId, fromSeq: number, actor?: UserId): void {
    let cursor = fromSeq, pumping = false, dirty = true, closed = false
    this.clients.add(response)
    const write = (data: string): boolean => {
      if (closed) return false
      if (!response.write(data)) { response.destroy(); return false }
      return true
    }
    const pump = async () => {
      dirty = true
      if (pumping || closed) return
      pumping = true
      try {
        while (dirty && !closed) {
          dirty = false
          let page
          do {
            page = await this.service.events(sessionId, cursor, 500, actor)
            for (const event of page.events) {
              if (!write(`id: ${event.seq}\nevent: session.event\ndata: ${JSON.stringify(event)}\n\n`)) return
              cursor = event.seq + 1
            }
          } while (page.nextSeq && !closed)
          write(`event: freshness\ndata: ${JSON.stringify(page.freshness)}\n\n`)
        }
      } catch { response.destroy() }
      finally { pumping = false }
    }
    // Subscribe before reading history so no live event is lost during replay.
    const unsubscribe = this.service.notifications.onSession(sessionId, () => { void pump() })
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    response.flushHeaders()
    const timer = setInterval(() => { write(': heartbeat\n\n') }, 15000)
    timer.unref()
    response.on('close', () => { closed = true; clearInterval(timer); unsubscribe(); this.clients.delete(response) })
    void pump()
  }
  close(): void { for (const client of this.clients) client.destroy() }
}
