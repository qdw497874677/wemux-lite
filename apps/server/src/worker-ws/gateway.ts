import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { WorkerId } from '@wemux/domain'
import { requiresCommandAssertion } from '@wemux/wire-protocol/command-assertion'
import { FS_WRITE_ADMISSION_V1, isFileWriteAdmissionType, supportsFileWriteAdmission, parseWorkerTransportFrame, type ServerPayload, type ServerToWorkerFrame, type WorkerHelloFrame } from '@wemux/wire-protocol'
import { parseVerifiedWorkerFileWriteFrame } from '@wemux/wire-protocol/file-admission-node'
import { FileWriteResultUnavailableError, fileWriteWireAdmission } from '../application/file-write-results.ts'
import type { ServerFileResultIngress } from './file-result-ingress.ts'
import { AuthenticationService } from '../application/auth.ts'
import { AppError } from '../application/errors.ts'
import { Notifications } from '../application/notifications.ts'
import { workerMessage } from '../application/validation.ts'
import { WorkerService } from '../application/worker-service.ts'
import { ServerTransportStore } from './transport-store.ts'
import type { ServerService } from '../application/server-service.ts'

interface ActiveConnection { readonly epoch: symbol; readonly socket: WebSocket; readonly fileResults: boolean }

export class WorkerGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
  private readonly connections = new Map<WorkerId, ActiveConnection>()
  private readonly lifecycle = new Map<WorkerId, Promise<void>>()
  private readonly upgrades = new Set<Duplex>()
  private readonly tasks = new Set<Promise<unknown>>()
  private closing = false
  private readonly server: Server
  private readonly auth: AuthenticationService
  private readonly service: WorkerService
  private readonly notifications: Notifications
  private readonly transport: ServerTransportStore
  constructor(server: Server, auth: AuthenticationService, service: WorkerService, notifications: Notifications, transport: ServerTransportStore, private readonly fileResults?: ServerFileResultIngress, private readonly approvals?: ServerService) { this.server = server; this.auth = auth; this.service = service; this.notifications = notifications; this.transport = transport; server.on('upgrade', this.upgrade) }
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
    const approvalRetries = new Map<string, { timer: NodeJS.Timeout; delay: number }>()
    const retryApproval = (commandId: import('@wemux/domain').CommandId, delay = 2_000) => {
      if (!this.approvals || approvalRetries.has(commandId) || !current()) return
      const timer = setTimeout(() => {
        approvalRetries.delete(commandId)
        if (!current()) return
        this.track((async () => {
          const pending = await this.approvals!.getCommand(commandId).catch(() => null)
          if (!pending || pending.status !== 'pending') return
          if (await this.approvals!.refreshPendingApproval(workerId, commandId)) await flush(true)
          retryApproval(commandId, Math.min(delay * 2, 30_000))
        })().catch(() => { retryApproval(commandId, Math.min(delay * 2, 30_000)) }))
      }, delay)
      timer.unref()
      approvalRetries.set(commandId, { timer, delay })
    }
    const current = () => !this.closing && this.connections.get(workerId)?.epoch === epoch && ws.readyState === WebSocket.OPEN
    const fileNegotiated = () => supportsFileWriteAdmission(this.fileResults ? [FS_WRITE_ADMISSION_V1] : [], hello?.features)
    const send = (frame: ServerToWorkerFrame) => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (ws.bufferedAmount > 2 * 1024 * 1024) return ws.terminate()
      ws.send(JSON.stringify(frame), error => { if (error) ws.terminate() })
    }
    // 重新入队 deliverable 只在「新连接 / 新命令 / 状态变化」时发生。
    // 传输确认触发的 flush 只做 outbox 重放：否则每次 ack 都会重新入队未收据的 Command，
    // 形成 ack → 入队 → 发送 → ack 的忙循环（同一 Command 在一条连接上被无限重发）。
    const flush = async (enqueueDeliverable: boolean) => {
      if (!hello || this.connections.get(workerId)?.epoch !== epoch || flushing || ws.readyState !== WebSocket.OPEN) return
      flushing = true
      try {
        if (enqueueDeliverable) for (const command of await this.service.deliverable(workerId)) {
          if (command.type === 'command' && command.command.kind === 'runtime.approval.resolve') {
            if (!this.approvals || !(await this.approvals.refreshPendingApproval(workerId, command.commandId))) { retryApproval(command.commandId); continue }
            const updated = (await this.service.deliverable(workerId)).find(item => item.type === 'command' && item.commandId === command.commandId)
            if (updated) this.transport.enqueue(workerId, updated)
            retryApproval(command.commandId)
          } else if (command.type === 'command' && command.authorization && requiresCommandAssertion(command.command.kind)) {
            // 在线重授权：投递唤醒时窗口已过期的断言按当前主体权限重签，只换窗口不换身份。
            // 主体已停用、权限不再满足或 Worker 已撤销时按原样投递，由 Worker 终态拒收（诚实失败）。
            if (!(this.approvals && await this.approvals.refreshPendingCommandAuthorization(workerId, command.commandId))) { this.transport.enqueue(workerId, command); continue }
            const updated = (await this.service.deliverable(workerId)).find(item => item.type === 'command' && item.commandId === command.commandId)
            this.transport.enqueue(workerId, updated ?? command)
          } else this.transport.enqueue(workerId, command)
        }
        if (!current()) return
        if (!fileNegotiated() && this.transport.hasFileEnvelopes(workerId)) throw new Error('File result ingress needs attention: retained envelopes require negotiation')
        for (const frame of this.transport.pending(workerId, 64, true)) {
          if (frame.payload.type === 'command' && frame.payload.command.kind === 'runtime.approval.resolve') {
            const approvalId = frame.payload.commandId
            if (!this.approvals) break
            const projection = await this.approvals.getCommand(approvalId).catch(() => null)
            // An application receipt can commit before the transport ACK reaches us.
            // Replay ONLY an already-sent immutable frame to repair its sequence;
            // a settled decision must never be admitted or signed again.
            if (projection?.status === 'accepted' || projection?.status === 'rejected') {
              if (this.transport.sentApproval(workerId, frame) && frame.payload.authorization &&
                  await this.approvals.authorizeSettledApprovalReplay(workerId, approvalId, frame.payload.authorization)) {
                send(frame)
                continue
              }
              break
            }
            if (projection?.status !== 'pending' || !(await this.approvals.refreshPendingApproval(workerId, approvalId))) { retryApproval(approvalId); break }
            const updated = (await this.service.deliverable(workerId)).find(item => item.type === 'command' && item.commandId === approvalId)
            if (!updated) break
            if (JSON.stringify(updated) !== JSON.stringify(frame.payload)) {
              if (this.transport.refreshUnsentApproval(workerId, frame, updated)) {
                send({ ...frame, payload: updated }); this.transport.sent(workerId, frame)
                retryApproval(approvalId)
                continue
              }
              // A sent frame is immutable. Replay its original bytes to recover
              // a lost transport ACK; only the next sequence may carry fresh claims.
              if (this.transport.sentApproval(workerId, frame) && frame.payload.authorization && await this.approvals.authorizeApprovalReplay(workerId, approvalId, frame.payload.authorization)) send(frame)
              retryApproval(approvalId)
              break
            }
            const expires = Date.parse(frame.payload.authorization?.claims.expiresAt ?? '')
            if (!Number.isFinite(expires) || expires <= Date.now()) {
              if (this.transport.sentApproval(workerId, frame) && frame.payload.authorization && await this.approvals.authorizeApprovalReplay(workerId, approvalId, frame.payload.authorization)) send(frame)
              break
            }
            retryApproval(approvalId)
          }
          // 非审批命令的过期断言：重签成功则原位替换后重发（同序列同 messageId，Worker 按序号去重）；
          // 重签被拒（主体停用/权限丧失/Worker 撤销）时按原始字节重发，由 Worker 终态拒收。
          if (frame.payload.type === 'command' && requiresCommandAssertion(frame.payload.command.kind) && frame.payload.authorization) {
            const staleId = frame.payload.commandId
            const expiresAt = Date.parse(frame.payload.authorization.claims.expiresAt)
            if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
              if (this.approvals && await this.approvals.refreshPendingCommandAuthorization(workerId, staleId)) {
                const updated = (await this.service.deliverable(workerId)).find(item => item.type === 'command' && item.commandId === staleId)
                if (updated && JSON.stringify(updated) !== JSON.stringify(frame.payload) && this.transport.refreshStaleCommand(workerId, frame, updated)) {
                  send({ ...frame, payload: updated }); this.transport.sent(workerId, frame)
                  continue
                }
              }
            }
          }
          send(frame); this.transport.sent(workerId, frame)
        }
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
      const text = data.toString() // Snapshot caller-owned buffers before queueing.
      chain = chain.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return
        try {
          if (binary) throw new AppError(400, 'JSON text frames required')
          let frame: ReturnType<typeof parseWorkerTransportFrame>
          try { frame = parseWorkerTransportFrame(JSON.parse(text)) }
          catch { throw new AppError(400, 'Invalid Worker transport v2 frame') }
          if (!hello) {
            if (frame.frameType !== 'transport.hello') throw new AppError(400, 'Expected initial transport.hello')
            const negotiated = this.transport.negotiate(workerId, frame, Boolean(this.fileResults))
            await this.serializeLifecycle(workerId, async () => {
              const previous = this.connections.get(workerId)
              await this.service.connected(workerId, { workerVersion: frame.workerVersion, platform: frame.platform, name: frame.name })
              if (this.closing || ws.readyState !== WebSocket.OPEN) {
                if (!previous) await this.service.disconnected(workerId)
                return
              }
              this.connections.set(workerId, { epoch, socket: ws, fileResults: supportsFileWriteAdmission(this.fileResults ? [FS_WRITE_ADMISSION_V1] : [], frame.features) })
              if (previous && previous.epoch !== epoch) previous.socket.close(1012, 'Connection replaced')
            })
            if (!current()) return
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
            if (frame.payload.type === 'fs.write.result') {
              if (!this.fileResults || !fileNegotiated()) throw new Error('File write admission not negotiated')
              const admission = await this.fileResults.admissions.get(frame.payload.requestId)
              if (!current()) return
              if (!admission || admission.workerId !== workerId) throw new AppError(403, 'File result admission Worker mismatch')
              const verified = parseVerifiedWorkerFileWriteFrame(frame, { localFeatures: [FS_WRITE_ADMISSION_V1], peerFeatures: hello.features }, fileWriteWireAdmission(admission))
              const accepted = this.transport.acceptFileResult(workerId, verified)
              // Inbox commit is NOT application commit. Every replay re-enters the receiver,
              // including an original sequence accepted before interruption/failure.
              const ack = await this.fileResults.receiveFileWriteResult(workerId, verified.payload)
              if (!current()) return
              this.transport.enqueueFileResultAck(workerId, ack, verified.payload)
              send({ frameType: 'transport.ack', deliveryEpoch: verified.deliveryEpoch, ackThrough: accepted.ackThrough })
              await flush(false)
              return
            }
            if (frame.durability === 'volatile') { await this.service.receive(workerId, workerMessage(frame.payload)); return }
            const accepted = this.transport.accept(workerId, frame)
            if (accepted.isNew) {
              // 收据是应用层完成信号：收到后该 Command 不再需要传输重投，未重发的待发行随之清掉。
              const receipt = frame.payload.type === 'ack' ? frame.payload.receipt : null
              for (const reply of await this.service.receive(workerId, workerMessage(frame.payload))) this.transport.enqueue(workerId, reply)
              if (receipt) { this.transport.discardCommand(workerId, receipt.commandId); const retry = approvalRetries.get(receipt.commandId); if (retry) clearTimeout(retry.timer); approvalRetries.delete(receipt.commandId) }
            }
            send({ frameType: 'transport.ack', deliveryEpoch: frame.deliveryEpoch, ackThrough: accepted.ackThrough })
            await flush(true)
          }
        } catch (error) {
          if (hello && !current()) return
          const retryable = error instanceof FileWriteResultUnavailableError
          const code = retryable ? 'temporary-unavailable' : error instanceof AppError && error.status === 403 ? 'revoked' : error instanceof Error && error.message.includes('Unsupported transport') ? 'unsupported-transport-major' : error instanceof Error && error.message.includes('ADK') ? 'unsupported-adk-profile' : error instanceof Error && (error.message.includes('integrity') || error.message.includes('gap') || error.message.includes('epoch')) ? 'integrity-error' : 'invalid-frame'
          send({ frameType: 'transport.error', code, message: retryable ? 'File result storage temporarily unavailable' : error instanceof Error ? error.message : 'Invalid message', retryable })
          const close = () => { if (ws.readyState === WebSocket.OPEN) ws.close(retryable ? 1013 : 1008, retryable ? 'Temporary unavailable' : 'Protocol violation') }
          setTimeout(close, 100).unref()
        }
      })
      this.track(chain)
    })
    ws.on('close', () => {
      for (const { timer } of approvalRetries.values()) clearTimeout(timer)
      approvalRetries.clear()
      clearInterval(timer); unsubscribe()
      this.track(chain.then(() => this.serializeLifecycle(workerId, async () => {
        if (this.connections.get(workerId)?.epoch !== epoch) return
        this.connections.delete(workerId); await this.service.disconnected(workerId)
      })))
    })
  }
  disconnect(workerId: WorkerId): void { this.connections.get(workerId)?.socket.close(1008, 'Worker revoked') }
  async send(workerId: WorkerId, payload: ServerPayload): Promise<void> {
    if (isFileWriteAdmissionType(payload)) throw new Error('File traffic requires internal result ingress')
    const connection = this.connections.get(workerId)
    if (connection && !connection.fileResults && this.transport.hasFileEnvelopes(workerId)) throw new Error('File result ingress needs attention: retained envelopes require negotiation')
    if (payload.type === 'command' && payload.command.kind === 'runtime.approval.resolve') throw new Error('Approval commands require checked delivery')
    this.transport.enqueue(workerId, payload)
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) return
    for (const frame of this.transport.pending(workerId, 64)) {
      if (frame.payload.type === 'command' && frame.payload.command.kind === 'runtime.approval.resolve') break
      connection.socket.send(JSON.stringify(frame), error => { if (error) connection.socket.terminate() })
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
