/**
 * 最小 SMTP 提交客户端（node:net + node:tls，无第三方依赖）。
 *
 * 为什么自己写：Server 的生产依赖刻意保持极小（`node:http` + `node:sqlite`），而投递只需要
 * 提交路径的一个子集。替代方案是引入 `nodemailer`（约 40 个间接依赖、自带连接池与 DKIM 等我们
 * 不用的能力），运维成本高于这 300 行；将来若需要 DKIM/批量投递再评估替换。
 *
 * 覆盖范围：EHLO 能力协商、STARTTLS/隐式 TLS、AUTH PLAIN/LOGIN、单收件人多收件人、SIZE 上限、
 * 点填充、连接与命令超时、有限重试、永久/临时失败区分（5xx 不重试）。
 * 不覆盖：DKIM 签名、连接池、DSN、pipelining、8BITMIME（正文始终 base64 7bit 安全）。
 */
import net from 'node:net'
import tls from 'node:tls'

export type SmtpSecurity = 'plain' | 'starttls' | 'implicit'

export interface SmtpConfig {
  readonly host: string
  readonly port: number
  readonly security: SmtpSecurity
  readonly username?: string | null
  readonly password?: string | null
  readonly heloDomain?: string
  readonly connectTimeoutMs?: number
  readonly commandTimeoutMs?: number
  /** 总尝试次数（含首次）；仅对连接失败与 4xx 临时失败生效。 */
  readonly attempts?: number
  readonly rejectUnauthorized?: boolean
  /** 允许在明文连接上发送凭据；默认关闭，避免把密码交给未加密的中间人。 */
  readonly allowInsecureAuth?: boolean
}

export interface SmtpEnvelope {
  readonly from: string
  readonly to: readonly string[]
  readonly data: Buffer
}

export class SmtpError extends Error {
    readonly stage: string
    readonly code: number | null
    readonly detail: string
    readonly permanent: boolean
  constructor(
    stage: string,
    code: number | null,
    detail: string,
    permanent = code !== null && code >= 500,
  ) {
    super(`SMTP ${stage} failed${code === null ? '' : ` (${code})`}: ${detail}`); this.stage = stage; this.code = code; this.detail = detail; this.permanent = permanent;
    this.name = 'SmtpError'
  }
}

interface Response {
  readonly code: number
  readonly lines: readonly string[]
}

interface Capabilities {
  readonly starttls: boolean
  readonly auth: readonly string[]
  readonly size: number | null
}

const CRLF = '\r\n'
const DEFAULT_CONNECT_TIMEOUT = 10_000
const DEFAULT_COMMAND_TIMEOUT = 15_000

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

class SmtpSession {
  private buffer = ''
  private waiters: { resolve: (response: Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = []
  private closed: Error | null = null

  private socket: net.Socket | tls.TLSSocket

  private readonly timeoutMs: number

  constructor(socket: net.Socket | tls.TLSSocket, timeoutMs: number) { this.socket = socket; this.timeoutMs = timeoutMs;
    this.attach(socket)
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { this.buffer += chunk; this.service() })
    socket.on('error', error => this.fail(error instanceof Error ? error : new Error(String(error))))
    socket.on('close', () => this.fail(new Error('SMTP connection closed unexpectedly')))
  }

  private detach(socket: net.Socket | tls.TLSSocket): void {
    socket.removeAllListeners('data'); socket.removeAllListeners('error'); socket.removeAllListeners('close'); socket.removeAllListeners('connect')
  }

  private fail(error: Error): void {
    this.closed ??= error
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error) }
  }

  private take(): Response | null {
    let index = 0
    const lines: string[] = []
    for (;;) {
      const end = this.buffer.indexOf(CRLF, index)
      if (end < 0) return null
      const line = this.buffer.slice(index, end)
      lines.push(line)
      index = end + 2
      if (/^\d{3} /.test(line)) {
        this.buffer = this.buffer.slice(index)
        return { code: Number(line.slice(0, 3)), lines }
      }
      if (lines.length > 200) { this.buffer = this.buffer.slice(index); throw new SmtpError('protocol', null, 'response exceeded 200 lines', true) }
    }
  }

  private service(): void {
    for (;;) {
      let response: Response | null
      try { response = this.take() } catch (error) { this.fail(error as Error); return }
      if (!response) return
      const waiter = this.waiters.shift()
      if (!waiter) { this.buffer = ''; continue }
      clearTimeout(waiter.timer)
      waiter.resolve(response)
    }
  }

  readResponse(): Promise<Response> {
    const immediate = this.take()
    if (immediate) return Promise.resolve(immediate)
    if (this.closed) return Promise.reject(this.closed)
    return new Promise<Response>((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new SmtpError('timeout', null, `no response within ${this.timeoutMs}ms`, false))
      }, this.timeoutMs) }
      this.waiters.push(waiter)
    })
  }

  async expect(codes: readonly number[], stage: string, wire: string): Promise<Response> {
    const response = await this.command(wire)
    if (!codes.includes(response.code)) throw new SmtpError(stage, response.code, response.lines.join(' | '))
    return response
  }

  async command(wire: string): Promise<Response> {
    await this.write(Buffer.from(`${wire}${CRLF}`, 'utf8'))
    return this.readResponse()
  }

  startData(): Response | Promise<Response> {
    return this.command('DATA')
  }

  private write(chunk: Buffer): Promise<void> {
    if (this.closed) return Promise.reject(this.closed)
    return new Promise<void>((resolve, reject) => {
      this.socket.write(chunk, error => (error ? reject(error) : resolve()))
    })
  }

  async sendBody(body: Buffer): Promise<Response> {
    await this.write(body)
    return this.readResponse()
  }

  async upgrade(config: SmtpConfig): Promise<void> {
    const plain = this.socket
    this.detach(plain)
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const options: tls.ConnectionOptions = { socket: plain, rejectUnauthorized: config.rejectUnauthorized ?? true }
      // IP 字面量不能做 SNI（会触发 Node 警告），此时只做证书链校验。
      if (!net.isIP(config.host)) options.servername = config.host
      const socket = tls.connect(options, () => resolve(socket))
      socket.once('error', reject)
    })
    // 明文阶段的残留字节不能混入 TLS 会话。
    this.buffer = ''
    this.closed = null
    this.attach(secure)
  }

  destroy(): void {
    this.detach(this.socket)
    this.socket.destroy()
  }
}

export function parseCapabilities(lines: readonly string[]): Capabilities {
  let starttls = false; let size: number | null = null
  const auth: string[] = []
  for (const line of lines) {
    // 去掉 `250-`/`250 ` 前缀与可选的主机名问候行。
    const text = line.slice(4).trim()
    const [keyword, ...rest] = text.split(/\s+/)
    const upper = keyword?.toUpperCase()
    if (upper === 'STARTTLS') starttls = true
    else if (upper === 'AUTH') for (const mechanism of rest) auth.push(mechanism.toUpperCase())
    else if (upper === 'SIZE' && rest[0] && /^\d+$/.test(rest[0])) size = Number(rest[0])
  }
  return { starttls, auth, size }
}

/** 点填充：正文里以 `.` 开头的行必须转义，行尾统一为 CRLF，并以单独一行 `.` 结束。 */
export function dotStuff(data: Buffer): Buffer {
  const normalised = data.toString('utf8').replace(/\r\n|\r|\n/g, CRLF)
  const terminated = normalised.endsWith(CRLF) ? normalised : normalised + CRLF
  return Buffer.from(`${terminated.replace(/^\./gm, '..')}.${CRLF}`, 'utf8')
}

async function openSocket(config: SmtpConfig): Promise<net.Socket | tls.TLSSocket> {
  const timeout = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { socket.destroy(); reject(new SmtpError('connect', null, error.message, false)) }
    const options: tls.ConnectionOptions = { host: config.host, port: config.port, rejectUnauthorized: config.rejectUnauthorized ?? true }
    if (!net.isIP(config.host)) options.servername = config.host
    const socket = config.security === 'implicit' ? tls.connect(options) : net.connect({ host: config.host, port: config.port })
    const timer = setTimeout(() => onError(new Error(`connect timeout after ${timeout}ms`)), timeout)
    socket.once('error', onError)
    socket.once('connect', () => { clearTimeout(timer); socket.removeListener('error', onError); socket.setTimeout(0); resolve(socket) })
  })
}

async function negotiate(session: SmtpSession, config: SmtpConfig): Promise<Capabilities> {
  const greeting = await session.readResponse()
  if (greeting.code !== 220) throw new SmtpError('greeting', greeting.code, greeting.lines.join(' | '))
  const ehlo = await session.command(`EHLO ${config.heloDomain ?? 'localhost'}`)
  // 老服务器可能不支持 EHLO（500/502），此时退回 HELO 且没有扩展能力。
  let capabilities: Capabilities
  if (ehlo.code === 250) capabilities = parseCapabilities(ehlo.lines)
  else {
    const helo = await session.expect([250], 'helo', `HELO ${config.heloDomain ?? 'localhost'}`)
    if (helo.code !== 250) throw new SmtpError('helo', helo.code, helo.lines.join(' | '))
    capabilities = { starttls: false, auth: [], size: null }
  }
  if (config.security === 'starttls') {
    if (!capabilities.starttls) throw new SmtpError('starttls', null, 'server does not advertise STARTTLS', true)
    await session.expect([220], 'starttls', 'STARTTLS')
    await session.upgrade(config)
    const second = await session.expect([250], 'ehlo-after-starttls', `EHLO ${config.heloDomain ?? 'localhost'}`)
    capabilities = parseCapabilities(second.lines)
  }
  return capabilities
}

async function authenticate(session: SmtpSession, config: SmtpConfig, capabilities: Capabilities): Promise<void> {
  const username = config.username ?? null
  const password = config.password ?? null
  if (username === null || password === null) return
  if (config.security === 'plain' && !config.allowInsecureAuth) throw new SmtpError('auth', null, 'refusing to send credentials over a cleartext connection; use STARTTLS/smtps or set allowInsecureAuth', true)
  if (capabilities.auth.length === 0) throw new SmtpError('auth', null, 'server advertises no AUTH mechanism', true)
  if (capabilities.auth.includes('PLAIN')) {
    const token = Buffer.from(`\u0000${username}\u0000${password}`, 'utf8').toString('base64')
    await session.expect([235], 'auth', `AUTH PLAIN ${token}`)
    return
  }
  if (capabilities.auth.includes('LOGIN')) {
    await session.expect([334], 'auth', 'AUTH LOGIN')
    await session.expect([334], 'auth-username', Buffer.from(username, 'utf8').toString('base64'))
    await session.expect([235], 'auth-password', Buffer.from(password, 'utf8').toString('base64'))
    return
  }
  throw new SmtpError('auth', null, `unsupported AUTH mechanisms: ${capabilities.auth.join(' ')}`, true)
}

async function transaction(config: SmtpConfig, envelope: SmtpEnvelope): Promise<void> {
  const timeout = config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT
  const socket = await openSocket(config)
  const session = new SmtpSession(socket, timeout)
  try {
    const capabilities = await negotiate(session, config)
    await authenticate(session, config, capabilities)
    if (capabilities.size !== null && envelope.data.length > capabilities.size) throw new SmtpError('size', null, `message is ${envelope.data.length} bytes, server limit is ${capabilities.size}`, true)
    await session.expect([250], 'mail', `MAIL FROM:<${envelope.from}>`)
    for (const recipient of envelope.to) await session.expect([250, 251], 'rcpt', `RCPT TO:<${recipient}>`)
    await session.expect([354], 'data', 'DATA')
    const completed = await session.sendBody(dotStuff(envelope.data))
    if (completed.code !== 250) throw new SmtpError('data-end', completed.code, completed.lines.join(' | '))
    await session.command('QUIT').catch(() => undefined)
  } finally {
    session.destroy()
  }
}

/** 投递一封邮件；永久失败立刻抛出，临时失败重试到 `attempts` 用尽。 */
export async function sendSmtpMessage(config: SmtpConfig, envelope: SmtpEnvelope): Promise<void> {
  const attempts = Math.max(1, config.attempts ?? 2)
  let lastError: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { await transaction(config, envelope); return }
    catch (error) {
      lastError = error
      if (error instanceof SmtpError && error.permanent) throw error
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 200 * attempt))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}