import WebSocket from 'ws'

export const DINGTALK_GATEWAY_OPEN_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open'
export const DINGTALK_BOT_MESSAGE_TOPIC = '/v1.0/im/bot/messages/get'

export interface DingTalkStreamCredential {
  clientId: string
  clientSecret: string
}

export interface DingTalkStreamFrame {
  specVersion?: string
  type?: string
  headers?: Record<string, string>
  data?: string
}

export interface DingTalkConnectionStatus {
  state: 'offline' | 'connecting' | 'online' | 'reconnecting' | 'error'
  connectedAt?: string
  lastFrameAt?: string
  lastError?: string
  reconnectAttempt: number
}

export interface DingTalkWebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'open', listener: () => void): this
  on(event: 'message', listener: (data: unknown) => void): this
  on(event: 'close', listener: (code: number, reason: unknown) => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

export interface DingTalkStreamClientOptions {
  credential: DingTalkStreamCredential
  subscriptions?: Array<{ type: 'EVENT' | 'CALLBACK'; topic: string }>
  fetch?: typeof fetch
  webSocketFactory?: (url: string) => DingTalkWebSocketLike
  gatewayOpenUrl?: string
  userAgent?: string
  localIp?: string
  now?: () => number
  random?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
  initialReconnectDelayMs?: number
  maxReconnectDelayMs?: number
  onFrame: (frame: DingTalkStreamFrame, ack: (data?: unknown) => void) => Promise<void> | void
  onStatus?: (status: DingTalkConnectionStatus) => void
}

interface GatewayOpenResponse {
  endpoint?: string
  ticket?: string
}

function asText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Buffer) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8')
  return String(data)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class DingTalkStreamClient {
  private readonly options: DingTalkStreamClientOptions
  private readonly fetchImpl: typeof fetch
  private readonly socketFactory: (url: string) => DingTalkWebSocketLike
  private readonly now: () => number
  private readonly random: () => number
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly cancelSchedule: (timer: ReturnType<typeof setTimeout>) => void
  private socket?: DingTalkWebSocketLike
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private stopped = true
  private generation = 0
  private reconnectAttempt = 0
  private status: DingTalkConnectionStatus = { state: 'offline', reconnectAttempt: 0 }

  constructor(options: DingTalkStreamClientOptions) {
    this.options = options
    this.fetchImpl = options.fetch ?? fetch
    this.socketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url) as DingTalkWebSocketLike)
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.schedule = options.setTimeout ?? setTimeout
    this.cancelSchedule = options.clearTimeout ?? clearTimeout
  }

  getStatus(): DingTalkConnectionStatus {
    return { ...this.status }
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    this.generation += 1
    this.reconnectAttempt = 0
    await this.connect(this.generation, false)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.generation += 1
    if (this.reconnectTimer) {
      this.cancelSchedule(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const socket = this.socket
    this.socket = undefined
    socket?.close(1000, 'channel disabled')
    this.updateStatus({ state: 'offline', reconnectAttempt: 0 })
  }

  async testConnection(timeoutMs = 10_000): Promise<DingTalkConnectionStatus> {
    return await new Promise<DingTalkConnectionStatus>((resolve, reject) => {
      const client = new DingTalkStreamClient({
        ...this.options,
        onStatus: (status) => {
          this.options.onStatus?.(status)
          if (status.state === 'online') {
            void client.stop().then(() => resolve(status))
          } else if (status.state === 'error') {
            void client.stop().then(() => reject(new Error(status.lastError ?? '钉钉 Stream 连接失败')))
          }
        },
      })
      const timeout = this.schedule(() => {
        void client.stop().then(() => reject(new Error('钉钉 Stream 连接测试超时')))
      }, timeoutMs)
      void client.start().catch((error) => {
        this.cancelSchedule(timeout)
        reject(error)
      })
    })
  }

  private async connect(generation: number, reconnecting: boolean): Promise<void> {
    if (this.stopped || generation !== this.generation) return
    this.updateStatus({
      state: reconnecting ? 'reconnecting' : 'connecting',
      reconnectAttempt: this.reconnectAttempt,
      lastError: undefined,
    })

    try {
      const connection = await this.openGatewayConnection()
      if (this.stopped || generation !== this.generation) return
      const url = new URL(connection.endpoint)
      url.searchParams.set('ticket', connection.ticket)
      const socket = this.socketFactory(url.toString())
      this.socket = socket
      let opened = false

      socket.on('open', () => {
        if (this.stopped || generation !== this.generation || this.socket !== socket) {
          socket.close(1000, 'stale connection')
          return
        }
        opened = true
        this.reconnectAttempt = 0
        this.updateStatus({
          state: 'online',
          connectedAt: new Date(this.now()).toISOString(),
          reconnectAttempt: 0,
          lastError: undefined,
        })
      })
      socket.on('message', (data) => {
        if (this.stopped || generation !== this.generation || this.socket !== socket) return
        this.updateStatus({ ...this.status, lastFrameAt: new Date(this.now()).toISOString() })
        void this.handleMessage(socket, data)
      })
      socket.on('error', (error) => {
        if (this.stopped || generation !== this.generation || this.socket !== socket) return
        this.updateStatus({ ...this.status, lastError: errorMessage(error) })
      })
      socket.on('close', (code, reason) => {
        if (this.socket === socket) this.socket = undefined
        if (this.stopped || generation !== this.generation) return
        const detail = `WebSocket 已断开 (${code}${reason ? `: ${asText(reason)}` : ''})`
        this.scheduleReconnect(generation, opened ? detail : `钉钉 Stream 鉴权失败: ${detail}`)
      })
    } catch (error) {
      if (this.stopped || generation !== this.generation) return
      const message = errorMessage(error)
      if (!reconnecting) {
        this.stopped = true
        this.updateStatus({ state: 'error', reconnectAttempt: 0, lastError: message })
        throw error
      }
      this.scheduleReconnect(generation, message)
    }
  }

  private async openGatewayConnection(): Promise<{ endpoint: string; ticket: string }> {
    const response = await this.fetchImpl(this.options.gatewayOpenUrl ?? DINGTALK_GATEWAY_OPEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        clientId: this.options.credential.clientId,
        clientSecret: this.options.credential.clientSecret,
        subscriptions: this.options.subscriptions ?? [
          { type: 'CALLBACK', topic: DINGTALK_BOT_MESSAGE_TOPIC },
        ],
        ua: this.options.userAgent ?? 'wemux-lite-server/1.0',
        localIp: this.options.localIp ?? '127.0.0.1',
      }),
    })
    const raw = await response.text()
    let body: GatewayOpenResponse = {}
    try {
      body = raw ? JSON.parse(raw) as GatewayOpenResponse : {}
    } catch {
      throw new Error(`钉钉 Stream 网关返回了无效 JSON (${response.status})`)
    }
    if (!response.ok) {
      throw new Error(`钉钉 Stream 鉴权失败 (${response.status}): ${raw.slice(0, 300)}`)
    }
    if (!body.endpoint || !body.ticket) {
      throw new Error('钉钉 Stream 网关响应缺少 endpoint 或 ticket')
    }
    return { endpoint: body.endpoint, ticket: body.ticket }
  }

  private async handleMessage(socket: DingTalkWebSocketLike, raw: unknown): Promise<void> {
    let frame: DingTalkStreamFrame
    try {
      frame = JSON.parse(asText(raw)) as DingTalkStreamFrame
    } catch {
      return
    }
    const messageId = frame.headers?.messageId
    const ack = (data?: unknown) => {
      if (!messageId || socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify({
        code: 200,
        headers: { messageId, contentType: 'application/json' },
        message: 'OK',
        data: JSON.stringify(data ?? { response: null }),
      }))
    }
    if (frame.type === 'SYSTEM' && frame.headers?.topic === 'ping') {
      ack()
      return
    }
    try {
      await this.options.onFrame(frame, ack)
    } catch (error) {
      this.updateStatus({ ...this.status, lastError: errorMessage(error) })
    }
  }

  private scheduleReconnect(generation: number, message: string): void {
    if (this.stopped || generation !== this.generation || this.reconnectTimer) return
    this.reconnectAttempt += 1
    const initial = this.options.initialReconnectDelayMs ?? 1_000
    const maximum = this.options.maxReconnectDelayMs ?? 60_000
    const base = Math.min(maximum, initial * 2 ** Math.max(0, this.reconnectAttempt - 1))
    const delay = Math.max(0, Math.round(base * (0.8 + this.random() * 0.4)))
    this.updateStatus({
      state: 'reconnecting',
      reconnectAttempt: this.reconnectAttempt,
      lastError: message,
    })
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = undefined
      void this.connect(generation, true)
    }, delay)
  }

  private updateStatus(status: DingTalkConnectionStatus): void {
    this.status = status
    this.options.onStatus?.({ ...status })
  }
}
