import type { ServerResponse } from 'node:http'
import type { UserId } from '@wemux/domain'
import type { Notifications } from '../application/notifications.js'

/** Project events are invalidations, never replayable Journal/activity facts. */
export class ProjectStreams {
  private readonly clients = new Set<ServerResponse>()
  constructor(private readonly notifications: Notifications) {}
  open(response: ServerResponse, projectId: string, actor: UserId, authorize: () => Promise<unknown>): void {
    let closed = false, checking = false
    const write = (data: string) => {
      if (!closed && !response.write(data)) response.destroy()
    }
    const unsubscribe = this.notifications.onProject(projectId, event => {
      write(`event: project.event\ndata: ${JSON.stringify(event)}\n\n`)
    })
    const reauthorize = () => {
      if (checking || closed) return
      checking = true
      void authorize().then(() => write(': heartbeat\n\n'), () => response.destroy()).finally(() => { checking = false })
    }
    const unsubscribeAuthorization = this.notifications.onAuthorization(actor, reauthorize)
    this.clients.add(response)
    const timer = setInterval(reauthorize, 15000)
    timer.unref()
    response.on('close', () => {
      closed = true
      clearInterval(timer)
      unsubscribe()
      unsubscribeAuthorization()
      this.clients.delete(response)
    })
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    response.flushHeaders()
    // Every connection requires an authoritative query refresh; Last-Event-ID is ignored.
    write(': revalidate\n\n')
  }
  close(): void { for (const client of this.clients) client.destroy() }
}
