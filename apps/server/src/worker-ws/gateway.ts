import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { WorkerId } from '@wemux/domain'
import { parseWorkerTransportFrame, type ServerPayload, type ServerToWorkerFrame, type WorkerHelloFrame } from '@wemux/wire-protocol'
import { AuthenticationService } from '../application/auth.js'
import { AppError } from '../application/errors.js'
import { Notifications } from '../application/notifications.js'
import { workerMessage } from '../application/validation.js'
import { WorkerService } from '../application/worker-service.js'
import { ServerTransportStore } from './transport-store.js'

interface ActiveConnection { readonly epoch: symbol; readonly socket: WebSocket }

export class WorkerGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
  private readonly connections = new Map<WorkerId, ActiveConnection>()
  private readonly lifecycle = new Map<WorkerId, Promise<void>>()
  private readonly upgrades = new Set<Duplex>()
  private readonly tasks = new Set<Promise<unknown>>()
  private closing = false
  constructor(private readonly server: Server, private readonly auth: AuthenticationService, private readonly service: WorkerService, private readonly notifications: Notifications, private readonly transport: ServerTransportStore) { server.on('upgrade', this.upgrade) }
  private track(task: Promise<unknown>): void { this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => undefined) }
  private serializeLifecycle<T>(workerId: WorkerId, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycle.get(workerId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation), settled = result.then(() => undefined, () => undefined)
    this.lifecycle.set(workerId, settled)
    void settled.finally(() => { if (this.lifecycle.get(workerId) === settled) this.lifecycle.delete(workerId) })
    return result
  }
  private readonly upgrade = (request: import('node:http').IncomingMessage, socket: Duplex, head: Buffer): void => {
    this.upgrades.add(socket); socket.on('error', () => socket.destroy())
    this.track((async () => {
      try {
        if (this.closing || new URL(request.url ?? '/', 'http://localhost').pathname !== '/worker/ws') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return }
        const header = request.headers.authorization
        const workerId = await this.auth.authenticateWorker(header?.startsWith('Bearer ') ? header.slice(7) : undefined)
        if (this.closing || socket.destroyed) return socket.destroy()
        this.wss.handleUpgrade(request, socket, head, ws => this.connected(workerId, ws))
      } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n') }
      finally { this.upgrades.delete(socket) }
    })())
  }
  private connected(workerId: WorkerId, ws: WebSocket): void {
    const epoch = Symbol('worker-connection')
    let hello: WorkerHelloFrame | null = null, lastSeen = Date.now(), chain = Promise.resolve(), flushing = false
    const send = (frame: ServerToWorkerFrame) => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (ws.bufferedAmount > 2 * 1024 * 1024) return ws.terminate()
      ws.send(JSON.stringify(frame))
    }
    // 重新入队 deliverable 只在「新连接 / 新命令 / 状态变化」时发生。
    // 传输确认触发的 flush 只做 outbox 重放：否则每次 ack 都会重新入队未收据的 Command，
    // 形成 ack → 入队 → 发送 → ack 的忙循环（同一 Command 在一条连接上被无限重发）。
    const flush = async (enqueueDeliverable: boolean) => {
      if (!hello || this.connections.get(workerId)?.epoch !== epoch || flushing || ws.readyState !== WebSocket.OPEN) return
      flushing = true
      try {
        if (enqueueDeliverable) for (const command of await this.service.deliverable(workerId)) this.transport.enqueue(workerId, command)
        for (const frame of this.transport.pending(workerId, 64)) { send(frame); this.transport.sent(workerId, frame) }
      } catch { ws.terminate() }
      finally { flushing = false }
    }
    const unsubscribe = this.notifications.onCommands(workerId, () => this.track(flush(true)))
    const timer = setInterval(() => {
      if (Date.now() - lastSeen > (hello ? 60_000 : 10_000)) ws.terminate()
      else if (hello) { send({ frameType: 'transport.ping', nonce: randomUUID(), sentAt: new Date().toISOString() as import('@wemux/domain').Timestamp }); this.track(flush(false)) }
    }, 15_000)
    timer.unref()
    ws.on('error', () => ws.terminate())
    ws.on('message', (data, binary) => {
      chain = chain.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return
        try {
          if (binary) throw new AppError(400, 'JSON text frames required')
          let frame: ReturnType<typeof parseWorkerTransportFrame>
          try { frame = parseWorkerTransportFrame(JSON.parse(data.toString())) }
          catch { throw new AppError(400, 'Invalid Worker transport v2 frame') }
          if (!hello) {
            if (frame.frameType !== 'transport.hello') throw new AppError(400, 'Expected initial transport.hello')
            const negotiated = this.transport.negotiate(workerId, frame)
            await this.serializeLifecycle(workerId, async () => {
              const previous = this.connections.get(workerId)
              await this.service.connected(workerId, { workerVersion: frame.workerVersion, platform: frame.platform, name: frame.name })
              this.connections.set(workerId, { epoch, socket: ws })
              if (previous && previous.epoch !== epoch) previous.socket.close(1012, 'Connection replaced')
            })
            hello = frame; send(negotiated); await flush(true); return
          }
          if (frame.frameType === 'transport.hello') throw new AppError(400, 'Duplicate transport.hello')
          if (this.connections.get(workerId)?.epoch !== epoch) return
          lastSeen = Date.now()
          if (frame.frameType === 'transport.ack') { this.transport.acknowledge(workerId, frame.deliveryEpoch, frame.ackThrough); await flush(false); return }
          if (frame.frameType === 'transport.ping') { send({ frameType: 'transport.pong', nonce: frame.nonce, sentAt: frame.sentAt }); return }
          if (frame.frameType === 'transport.pong') return
          if (frame.frameType === 'transport.error') throw new AppError(400, frame.message)
          if (frame.frameType === 'data') {
            if (frame.durability === 'volatile') { await this.service.receive(workerId, workerMessage(frame.payload)); return }
            const accepted = this.transport.accept(workerId, frame)
            if (accepted.isNew) {
              // 收据是应用层完成信号：收到后该 Command 不再需要传输重投，未重发的待发行随之清掉。
              const receipt = frame.payload.type === 'ack' ? frame.payload.receipt : null
              if (receipt) this.transport.discardCommand(workerId, receipt.commandId)
              for (const reply of await this.service.receive(workerId, workerMessage(frame.payload))) this.transport.enqueue(workerId, reply)
            }
            send({ frameType: 'transport.ack', deliveryEpoch: frame.deliveryEpoch, ackThrough: accepted.ackThrough })
            await flush(true)
          }
        } catch (error) {
          const code = error instanceof AppError && error.status === 403 ? 'revoked' : error instanceof Error && error.message.includes('Unsupported transport') ? 'unsupported-transport-major' : error instanceof Error && error.message.includes('ADK') ? 'unsupported-adk-profile' : error instanceof Error && (error.message.includes('integrity') || error.message.includes('gap') || error.message.includes('epoch')) ? 'integrity-error' : 'invalid-frame'
          send({ frameType: 'transport.error', code, message: error instanceof Error ? error.message : 'Invalid message', retryable: false })
          const close = () => { if (ws.readyState === WebSocket.OPEN) ws.close(1008, 'Protocol violation') }
          setTimeout(close, 100).unref()
        }
      })
      this.track(chain)
    })
    ws.on('close', () => {
      clearInterval(timer); unsubscribe()
      this.track(chain.then(() => this.serializeLifecycle(workerId, async () => {
        if (this.connections.get(workerId)?.epoch !== epoch) return
        this.connections.delete(workerId); await this.service.disconnected(workerId)
      })))
    })
  }
  disconnect(workerId: WorkerId): void { this.connections.get(workerId)?.socket.close(1008, 'Worker revoked') }
  async send(workerId: WorkerId, payload: ServerPayload): Promise<void> {
    this.transport.enqueue(workerId, payload)
    const connection = this.connections.get(workerId)
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) return
    for (const frame of this.transport.pending(workerId, 64)) {
      connection.socket.send(JSON.stringify(frame))
      this.transport.sent(workerId, frame)
    }
  }
  async close(): Promise<void> {
    this.closing = true; this.server.off('upgrade', this.upgrade)
    for (const socket of this.upgrades) socket.destroy()
    for (const ws of this.wss.clients) ws.terminate()
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
    while (this.tasks.size) await Promise.allSettled([...this.tasks])
    this.transport.close()
  }
}
