import WebSocket from 'ws'
import type { ServerToWorker, WorkerToServer } from '@wemux/wire-protocol'
import type { Timestamp } from '@wemux/domain'
import { envelope } from '../domain/envelope.js'
import { parseServerMessage } from './validation.js'

export interface ConnectionOptions {
  url: string
  /** 多候选地址（含 url）：连接失败时自动轮换，恢复后自动切回优先地址。 */
  urls?: readonly string[]
  credential: string
  heartbeatMs?: number
  reconnectMs?: number
}
export class WebSocketTransport {
  private socket?: WebSocket
  private timer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private stopped = true
  private attempt = 0
  private urlIndex = 0
  private urlNeverOpened = 0
  private readonly urls: readonly string[]
  constructor(private readonly options: ConnectionOptions, private readonly onMessage: (message: ServerToWorker) => Promise<void>, private readonly onOpen: () => Promise<void>, private readonly onError: (error: unknown) => void = console.error, private readonly onRotate: (url: string, reason: 'connect-failed' | 'repeated-failures') => void = () => {}) {
    this.urls = options.urls && options.urls.length > 0 ? options.urls : [options.url]
  }
  start() { if (!this.stopped) return; this.stopped = false; this.connect() }
  send(message: WorkerToServer) {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    // The journal is the offline outbox; slow sockets reconnect and request replay.
    if (this.socket.bufferedAmount > 4 * 1024 * 1024) { this.socket.terminate(); return }
    this.socket.send(JSON.stringify(message), error => { if (error) this.onError(error) })
  }
  private connect() {
    if (this.stopped) return
    const url = this.urls[this.urlIndex] ?? this.options.url
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.options.credential}` }, maxPayload: 1024 * 1024, handshakeTimeout: 10000 })
    this.socket = socket
    let alive = true
    let opened = false
    socket.on('pong', () => { alive = true })
    socket.on('open', () => {
      opened = true
      this.attempt = 0
      this.urlNeverOpened = 0
      this.urlIndex = 0
      void this.onOpen().catch(this.onError)
      this.heartbeat = setInterval(() => {
        if (!alive) { socket.terminate(); return }
        alive = false
        socket.ping()
        this.send({ ...envelope(), type: 'heartbeat', nonce: crypto.randomUUID(), sentAt: new Date().toISOString() as Timestamp })
      }, this.options.heartbeatMs ?? 15000)
    })
    socket.on('message', (data, binary) => {
      try {
        if (binary) throw new Error('Binary protocol frames are not supported')
        const message = parseServerMessage(data.toString())
        if (message.type === 'error' && !message.error.retryable) { this.stop(); return }
        void this.onMessage(message).catch(this.onError)
      } catch (error) {
        this.onError(error)
        this.send({ ...envelope(), type: 'error', error: { code: 'invalid-message', message: 'Invalid protocol v1 message', retryable: false, relatedMessageId: null } })
        socket.close(1002, 'Invalid protocol')
      }
    })
    socket.on('error', this.onError)
    socket.on('close', () => {
      clearInterval(this.heartbeat)
      if (this.stopped) return
      const delay = Math.min(30000, (this.options.reconnectMs ?? 500) * 2 ** Math.min(this.attempt++, 8))
      if (this.urls.length > 1) {
        if (!opened) {
          // 连接从未建立成功：立刻轮换到下一个候选
          this.urlIndex = (this.urlIndex + 1) % this.urls.length
          this.onRotate(this.urls[this.urlIndex], 'connect-failed')
        } else if (++this.urlNeverOpened >= 3) {
          // 曾连上但连续 3 轮重连失败：切换候选，成功后 open 会归位回优先地址
          this.urlNeverOpened = 0
          this.urlIndex = (this.urlIndex + 1) % this.urls.length
          this.onRotate(this.urls[this.urlIndex], 'repeated-failures')
        }
      }
      this.timer = setTimeout(() => this.connect(), delay)
    })
  }
  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    clearInterval(this.heartbeat)
    this.socket?.terminate()
  }
}
