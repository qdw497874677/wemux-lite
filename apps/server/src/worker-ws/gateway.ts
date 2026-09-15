import type { Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { WorkerId } from '@wemux/domain'
import type { ServerToWorker } from '@wemux/wire-protocol'
import { AuthenticationService } from '../application/auth.js'
import { AppError } from '../application/errors.js'
import { Notifications } from '../application/notifications.js'
import { workerMessage } from '../application/validation.js'
import { envelope, WorkerService } from '../application/worker-service.js'

export class WorkerGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  private readonly connections = new Map<WorkerId, WebSocket>()
  private readonly upgrades = new Set<Duplex>()
  private readonly tasks = new Set<Promise<unknown>>()
  private closing = false
  constructor(private readonly server: Server, private readonly auth: AuthenticationService, private readonly service: WorkerService, private readonly notifications: Notifications) {
    server.on('upgrade', this.upgrade)
  }
  private track(task: Promise<unknown>): void {
    this.tasks.add(task)
    void task.finally(() => this.tasks.delete(task)).catch(() => undefined)
  }
  private readonly upgrade = (request: import('node:http').IncomingMessage, socket: Duplex, head: Buffer): void => {
    this.upgrades.add(socket)
    socket.on('error', () => socket.destroy())
    this.track((async () => {
      try {
        if (this.closing || new URL(request.url ?? '/', 'http://localhost').pathname !== '/worker/ws') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return }
        const header = request.headers.authorization
        const workerId = await this.auth.authenticateWorker(header?.startsWith('Bearer ') ? header.slice(7) : undefined)
        if (this.closing || socket.destroyed) { socket.destroy(); return }
        // A second live connection must not race writes/offline transitions from the first.
        if (this.connections.has(workerId)) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return }
        this.wss.handleUpgrade(request, socket, head, ws => { this.connections.set(workerId, ws); this.connected(workerId, ws) })
      } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n') }
      finally { this.upgrades.delete(socket) }
    })())
  }
  private connected(workerId: WorkerId, ws: WebSocket): void {
    let hello = false, lastSeen = Date.now(), chain = Promise.resolve(), flushing = false
    const sent = new Map<string, number>()
    const send = (message: ServerToWorker) => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.terminate(); return }
      ws.send(JSON.stringify(message))
    }
    const flush = async () => {
      if (!hello || flushing || ws.readyState !== WebSocket.OPEN) return
      flushing = true
      try {
        for (const message of await this.service.deliverable(workerId)) {
          if (message.type !== 'command') continue
          if (Date.now() - (sent.get(message.commandId) ?? 0) < 5000) continue
          send(message); sent.set(message.commandId, Date.now())
        }
      } catch { ws.terminate() }
      finally { flushing = false }
    }
    const unsubscribe = this.notifications.onCommands(workerId, () => { this.track(flush()) })
    const timer = setInterval(() => {
      if (Date.now() - lastSeen > (hello ? 60000 : 10000)) ws.terminate()
      else this.track(flush())
    }, 1000)
    timer.unref()
    ws.on('error', () => ws.terminate())
    ws.on('message', (data, binary) => {
      // Serialize messages on each connection: hello, events and ack retain wire order.
      chain = chain.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return
        try {
          if (binary) throw new AppError(400, 'JSON text frames required')
          const message = workerMessage(JSON.parse(data.toString()))
          if ((!hello && message.type !== 'hello') || (hello && message.type === 'hello')) throw new AppError(400, 'Expected exactly one initial hello')
          for (const reply of await this.service.receive(workerId, message)) send(reply)
          lastSeen = Date.now()
          if (message.type === 'hello') hello = true
          if (message.type === 'ack') sent.delete(message.receipt.commandId)
          await flush()
        } catch (error) {
          const status = error instanceof AppError ? error.status : 400
          send({ ...envelope(), type: 'error', error: { code: status === 426 ? 'unsupported-version' : status === 403 ? 'unauthorized' : status === 409 ? 'integrity-error' : 'invalid-message', message: error instanceof AppError ? error.message : 'Invalid message', retryable: false, relatedMessageId: null } })
          ws.close(1008, 'Protocol violation')
        }
      })
      this.track(chain)
    })
    ws.on('close', () => {
      clearInterval(timer); unsubscribe()
      const cleanup = chain.then(() => this.service.disconnected(workerId)).finally(() => this.connections.delete(workerId))
      this.track(cleanup)
    })
  }
  /** Terminate a worker connection (used by cluster management, e.g. revoke). */
  disconnect(workerId: WorkerId): void {
    this.connections.get(workerId)?.close(1008, 'Worker revoked')
  }
  async close(): Promise<void> {
    this.closing = true
    this.server.off('upgrade', this.upgrade)
    for (const socket of this.upgrades) socket.destroy()
    for (const ws of this.connections.values()) ws.terminate()
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
    while (this.tasks.size) await Promise.allSettled([...this.tasks])
  }
}
