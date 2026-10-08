import WebSocket from 'ws'
import {
  WEMUX_ADK_PROFILE_V1,
  FS_WRITE_ADMISSION_V1,
  supportsFileWriteAdmission,
  parseServerTransportFrame,
  type ServerPayload,
  type ServerToWorkerFrame,
  type WorkerPayload,
  type WorkerToServerFrame,
} from '@wemux/wire-protocol'
import { parseVerifiedServerFileWriteFrame } from '@wemux/wire-protocol/file-admission-node'
import { fileResultIdentity } from './transport-store.js'
import type { ConnectionState, StateChange, WorkerTransport, FileWriteIngress } from './types.js'
import type { WorkerTransportStore } from './transport-store.js'

export interface WebSocketTransportOptions {
  readonly url: string
  readonly authToken: string
  readonly workerId: import('@wemux/domain').WorkerId
  readonly workerVersion: string
  readonly name: string
  readonly platform: string
  readonly architecture: string
  readonly store: WorkerTransportStore
  readonly onMessage: (payload: ServerPayload) => void | Promise<void>
  readonly onConnected: () => void | Promise<void>
  /** Internal embedding only; default does not advertise or consume file admission. */
  readonly fileWriteIngress?: FileWriteIngress
  readonly onDisconnected?: () => void
  /** User-visible diagnostic notice that does not itself change transport state. */
  readonly onNotice?: (message: string) => void
  readonly onStateChange?: (change: StateChange) => void
  readonly random?: () => number
  /** Test/embedding override; production defaults preserve bounded exponential backoff. */
  readonly retry?: {
    readonly baseDelayMs?: number
    readonly maxDelayMs?: number
    readonly jitterRatio?: number
    readonly stableConnectionMs?: number
  }
}

const defaultBaseDelayMs = 1_000
const defaultMaxDelayMs = 30_000
const defaultJitterRatio = 0.2
const defaultStableConnectionMs = 30_000
const connectTimeoutMs = 10_000
const idleTimeoutMs = 45_000

export class WebSocketTransport implements WorkerTransport {
  private negotiatedGeneration: number | undefined
  private fileWriteNegotiated = false
  private readonly projectedResults = new Set<string>()
  private socket: WebSocket | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private connectTimer: NodeJS.Timeout | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private stableTimer: NodeJS.Timeout | undefined
  private flushing = false
  private flushRequested = false
  private processingMessages: Promise<void> = Promise.resolve()
  private stopped = true
  private attempts = 0
  private generation = 0
  private lastConnectedAt = 0
  private state: ConnectionState = 'stopped'

  constructor(private readonly options: WebSocketTransportOptions) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.transition('connecting', 'start')
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    this.clearTimers()
    this.socket?.close()
    this.socket = undefined
    this.transition('stopped', 'stop')
  }

  async send(payload: WorkerPayload): Promise<void> {
    if (payload.type === 'fs.write.result') throw new Error('File results require committed ingress publication')
    await this.options.store.enqueue(payload)
    this.flush().catch(error => this.processingFailure(error))
  }

  private connect(): void {
    if (this.stopped) return
    this.negotiatedGeneration = undefined
    this.fileWriteNegotiated = false
    this.projectedResults.clear()
    const generation = ++this.generation
    const socket = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.authToken}` },
      handshakeTimeout: connectTimeoutMs,
      perMessageDeflate: false,
      maxPayload: 16 * 1024 * 1024,
    })
    this.socket = socket
    this.connectTimer = setTimeout(() => socket.terminate(), connectTimeoutMs)
    socket.on('open', () => this.handleOpen(socket, generation))
    socket.on('message', (data) => {
      const raw = data.toString() // Immutable snapshot before the asynchronous raw-frame queue.
      this.processingMessages = this.processingMessages
        .then(() => this.handleMessage(socket, generation, raw))
        .catch((error) => {
          this.options.onNotice?.(`传输消息处理失败：${error instanceof Error ? error.message : String(error)}`)
          if (this.isCurrent(socket, generation)) socket.close(1002, 'transport processing failed')
        })
    })
    socket.on('pong', () => this.armIdleTimer(socket, generation))
    socket.on('error', () => undefined)
    socket.on('close', () => this.handleClose(socket, generation))
  }

  private handleOpen(socket: WebSocket, generation: number): void {
    if (!this.isCurrent(socket, generation)) return socket.close()
    this.clearTimer('connect')
    this.lastConnectedAt = Date.now()
    const hello = this.options.store.workerHello({
      workerId: this.options.workerId,
      workerVersion: this.options.workerVersion,
      name: this.options.name,
      platform: this.options.platform,
      architecture: this.options.architecture,
      adkProfiles: [WEMUX_ADK_PROFILE_V1],
    })
    socket.send(JSON.stringify(this.options.fileWriteIngress ? { ...hello, features: [...hello.features, FS_WRITE_ADMISSION_V1] } : hello))
    this.armIdleTimer(socket, generation)
    // The transport hello is authoritative. The first connected callback waits
    // for Server negotiation; raw WS acceptance alone never means online.
  }

  private async handleMessage(socket: WebSocket, generation: number, raw: string): Promise<void> {
    if (!this.isCurrent(socket, generation)) return
    this.armIdleTimer(socket, generation)
    let frame: ServerToWorkerFrame
    try { frame = parseServerTransportFrame(JSON.parse(raw)) }
    catch { return socket.close(1002, 'invalid transport v2 frame') }

    if (frame.frameType === 'transport.hello') {
      if (this.negotiatedGeneration === generation) throw new Error('Duplicate transport hello')
      if (frame.selectedTransport.major !== 2 || frame.selectedAdkProfile !== WEMUX_ADK_PROFILE_V1) {
        this.transition('needs-attention', 'incompatible transport or ADK profile')
        this.stopped = true
        return socket.close(1002, 'incompatible transport or ADK profile')
      }
      await this.options.store.acceptServerHello(frame)
      if (!this.isCurrent(socket, generation)) return
      this.negotiatedGeneration = generation
      this.fileWriteNegotiated = supportsFileWriteAdmission(this.options.fileWriteIngress ? [FS_WRITE_ADMISSION_V1] : [], frame.enabledFeatures)
      if (!this.fileWriteNegotiated && this.options.store.hasOutstandingFileResults()) return this.stopForFileDowngrade(socket)
      this.transition('open', 'handshake accepted')
      await this.options.onConnected()
      if (!this.isCurrent(socket, generation)) return
      if (this.fileWriteNegotiated) await this.options.fileWriteIngress!.replay(result => this.publishFileResult(socket, generation, result))
      if (!this.isCurrent(socket, generation)) return
      this.stableTimer = setTimeout(() => { this.attempts = 0 }, this.options.retry?.stableConnectionMs ?? defaultStableConnectionMs)
      return this.flush()
    }
    if (frame.frameType === 'transport.error' && this.negotiatedGeneration !== generation) {
      // Negotiation may reject instead of accepting hello. This structurally
      // validated control frame is not a rejection/receipt of any outbox data.
      this.options.onNotice?.(`Transport handshake rejected (${frame.code}): ${frame.message}`)
      if (!frame.retryable) {
        this.stopped = true
        this.transition('needs-attention', frame.message)
      }
      // Retryable handshake errors retain all data and use normal close/backoff.
      return socket.close(frame.code === 'revoked' ? 1008 : 1002, frame.code)
    }
    if (this.negotiatedGeneration !== generation) throw new Error('Transport hello not accepted')
    if (frame.frameType === 'transport.ack') {
      await this.options.store.acknowledgeOutbound(frame)
      return this.flush()
    }
    if (frame.frameType === 'transport.error') {
      if (!frame.retryable) {
        // A permanent rejection is not a receipt for a file-result envelope.
        // Preserve sequence continuity and the application obligation for inspection.
        if (this.options.store.hasOutstandingFileResults()) {
          const notice = `File result transport rejected (${frame.code}); connection stopped: ${frame.message}`
          this.options.onNotice?.(notice)
          this.stopped = true
          this.transition('needs-attention', notice)
          return socket.close(1002, 'file result transport rejected')
        }
        const dropped = await this.options.store.dropOldestUnacked()
        if (dropped) {
          const notice = `丢弃服务器永久拒绝的消息（序号 ${dropped.seq}，${dropped.payload.type}，${frame.code}）：${frame.message}`
          this.options.onNotice?.(notice)
          console.warn(`[wemux-worker] ${notice}`)
        } else {
          this.transition('needs-attention', frame.message)
          this.stopped = true
        }
      }
      return socket.close(frame.code === 'revoked' ? 1008 : 1002, frame.code)
    }
    if (frame.frameType === 'transport.ping') {
      return void socket.send(JSON.stringify({ frameType: 'transport.pong', nonce: frame.nonce, sentAt: frame.sentAt } satisfies WorkerToServerFrame))
    }
    if (frame.frameType === 'transport.pong') return
    if (frame.frameType === 'data') {
      if (frame.payload.type === 'fs.write.admit' || frame.payload.type === 'fs.write.result.ack') {
        const negotiation = { localFeatures: this.options.fileWriteIngress ? [FS_WRITE_ADMISSION_V1] : [], peerFeatures: this.fileWriteNegotiated ? [FS_WRITE_ADMISSION_V1] : [] }
        const retained = frame.payload.type === 'fs.write.result.ack' ? await this.options.fileWriteIngress?.retainedResult(frame.payload.requestId) : undefined
        const verified = parseVerifiedServerFileWriteFrame(frame, negotiation, retained)
        if (!this.isCurrent(socket, generation)) return
        const accepted = await this.options.store.acceptInbound(verified)
        // Transport receipt is not application processing; Server intent must redeliver after a crash gap.
        if (this.isCurrent(socket, generation)) socket.send(JSON.stringify(accepted.ack))
        if (accepted.isNew) await this.options.fileWriteIngress!.receive(verified, negotiation, result => this.publishFileResult(socket, generation, result))
        return
      }
      if (frame.durability === 'volatile') {
        await this.options.onMessage(frame.payload)
        return
      }
      const accepted = await this.options.store.acceptInbound(frame)
      socket.send(JSON.stringify(accepted.ack))
      if (accepted.isNew) await this.options.onMessage(frame.payload)
    }
  }

  private async publishFileResult(socket: WebSocket, generation: number, result: import('@wemux/wire-protocol').FileWriteResultPayload): Promise<void> {
    if (!this.isCurrent(socket, generation) || !this.fileWriteNegotiated || this.negotiatedGeneration !== generation) return
    const key = fileResultIdentity(result)
    if (this.projectedResults.has(key)) return
    await this.options.store.enqueueFileResult(result)
    this.projectedResults.add(key)
    await this.flush()
  }

  private stopForFileDowngrade(socket: WebSocket): void {
    const notice = 'File result transport replay requires fs-write-admission-v1; connection stopped'
    this.options.onNotice?.(notice)
    this.stopped = true
    this.transition('needs-attention', notice)
    socket.close(1002, 'file admission feature unavailable')
  }

  private processingFailure(error: unknown): void {
    this.options.onNotice?.(`传输消息处理失败：${error instanceof Error ? error.message : String(error)}`)
    this.socket?.close(1002, 'transport processing failed')
  }

  private handleClose(socket: WebSocket, generation: number): void {
    if (this.socket !== socket || this.generation !== generation) return
    this.socket = undefined
    this.negotiatedGeneration = undefined
    this.fileWriteNegotiated = false
    this.clearTimers()
    this.options.onDisconnected?.()
    if (this.stopped) return this.transition(this.state === 'needs-attention' ? 'needs-attention' : 'stopped', 'closed')
    const uptimeMs = this.lastConnectedAt === 0 ? 0 : Date.now() - this.lastConnectedAt
    if (uptimeMs < (this.options.retry?.stableConnectionMs ?? defaultStableConnectionMs)) this.attempts += 1
    else this.attempts = 0
    const delayMs = this.retryDelay(this.attempts)
    this.transition('backoff', 'closed', delayMs)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.stopped) return
      this.transition('connecting', 'retry')
      this.connect()
    }, delayMs)
  }

  private async flush(): Promise<void> {
    this.flushRequested = true
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.flushRequested) {
        this.flushRequested = false
        const socket = this.socket
        const generation = this.generation
        if (!socket || socket.readyState !== WebSocket.OPEN || this.state !== 'open') return
        if (!this.fileWriteNegotiated && this.options.store.hasOutstandingFileResults()) return this.stopForFileDowngrade(socket)
        const pending = await this.options.store.pendingOutbound(64)
        if (!pending.length) continue
        this.flushRequested = true
        for (const frame of pending) {
          if (socket.readyState !== WebSocket.OPEN || !this.isCurrent(socket, generation) || this.negotiatedGeneration !== generation) return
          await this.options.store.markOutboundSent(frame)
          if (!this.isCurrent(socket, generation) || this.negotiatedGeneration !== generation) return
          await new Promise<void>((resolve, reject) => socket.send(JSON.stringify(frame), error => error ? reject(error) : resolve()))
        }
      }
    } catch (error) {
      this.flushRequested = false
      throw error
    } finally {
      this.flushing = false
      // Only an overlapping bounded flush request can schedule another pass.
      if (this.flushRequested && !this.stopped && this.state === 'open') void this.flush().catch(error => this.processingFailure(error))
    }
  }

  private armIdleTimer(socket: WebSocket, generation: number): void {
    this.clearTimer('idle')
    this.idleTimer = setTimeout(() => {
      if (this.isCurrent(socket, generation)) socket.terminate()
    }, idleTimeoutMs)
  }

  private isCurrent(socket: WebSocket, generation: number): boolean {
    return !this.stopped && this.socket === socket && this.generation === generation
  }

  private retryDelay(attempt: number): number {
    const baseDelayMs = this.options.retry?.baseDelayMs ?? defaultBaseDelayMs
    const maxDelayMs = this.options.retry?.maxDelayMs ?? defaultMaxDelayMs
    const jitterRatio = this.options.retry?.jitterRatio ?? defaultJitterRatio
    const exponential = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs)
    const random = this.options.random ?? Math.random
    return Math.round(exponential * (1 + ((random() * 2) - 1) * jitterRatio))
  }

  private transition(current: ConnectionState, reason: string, retryInMs?: number): void {
    const previous = this.state
    if (previous === current && retryInMs === undefined) return
    this.state = current
    this.options.onStateChange?.({ previous, current, reason, attempt: this.attempts, retryInMs })
  }

  private clearTimer(kind: 'connect' | 'idle'): void {
    const timer = kind === 'connect' ? this.connectTimer : this.idleTimer
    if (timer) clearTimeout(timer)
    if (kind === 'connect') this.connectTimer = undefined
    else this.idleTimer = undefined
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.connectTimer) clearTimeout(this.connectTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.reconnectTimer = this.connectTimer = this.idleTimer = this.stableTimer = undefined
  }
}
