import type { ServerResponse } from 'node:http'
import type { SessionId } from '@wemux/domain'
import type { Notifications } from '../application/notifications.ts'

export class TerminalStreams {
  private readonly clients = new Set<ServerResponse>()
  private readonly notifications: Notifications
  constructor(notifications: Notifications) { this.notifications = notifications;}
  open(response: ServerResponse, sessionId: SessionId): void {
    let closed = false
    const write = (event: string, data: unknown) => {
      if (closed) return
      if (!response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) response.destroy()
    }
    const unsubscribe = this.notifications.onTerminal(sessionId, event => write(event.type, event))
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    response.flushHeaders()
    const timer = setInterval(() => write('heartbeat', {}), 15_000)
    timer.unref()
    response.on('close', () => { closed = true; clearInterval(timer); unsubscribe(); this.clients.delete(response) })
    this.clients.add(response)
    write('ready', { sessionId })
  }
  close(): void { for (const client of this.clients) client.destroy() }
}
