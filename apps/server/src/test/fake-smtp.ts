/**
 * 测试用的脚本化 SMTP 服务器：真实 TCP + 真实 TLS 升级，用来验证我们自己的 SMTP 客户端。
 *
 * 不 mock socket：SMTP 的坑（点填充、能力协商、TLS 升级后的重新 EHLO、4xx/5xx 语义）只有在真连接上
 * 才能被证明。证书用 openssl 现场生成（自签），只在本机测试使用。
 */
import net from 'node:net'
import tls from 'node:tls'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type FakeStage = 'EHLO' | 'AUTH' | 'MAIL' | 'RCPT' | 'DATA' | 'DATA-END'

export interface FakeSmtpOptions {
  readonly greeting?: number
  /** 非常 ASCII 的能力行，例如 `STARTTLS`、`AUTH PLAIN LOGIN`、`SIZE 1000000`；首行默认是主机名问候。 */
  readonly capabilities?: readonly string[]
  /** 各阶段按出现顺序生效的失败码；用尽后恢复默认成功响应。 */
  readonly failures?: Partial<Record<FakeStage, readonly number[]>>
  readonly tls?: boolean
  /** 收到结束后延迟多少毫秒再回 250（用于验证命令超时）。 */
  readonly delayBeforeDataEnd?: number
}

export interface FakeTransaction {
  readonly mailFrom: string
  readonly recipients: readonly string[]
  /** 原始 DATA（已反转义点填充）；`.eml` 内容可断言。 */
  readonly data: string
  readonly authenticated: string | null
}

export interface FakeSmtpServer {
  readonly port: number
  readonly commands: string[]
  readonly transactions: readonly FakeTransaction[]
  readonly authAttempts: readonly { readonly mechanism: string; readonly username: string; readonly password: string }[]
  readonly tlsUpgrades: number
  stop(): Promise<void>
}

export function hasOpenssl(): boolean {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true } catch { return false }
}

function certificate(): { key: Buffer; cert: Buffer } {
  const directory = join(tmpdir(), 'wemux-fake-smtp-cert')
  const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem')
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(directory, { recursive: true })
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
  }
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

/** 可重新绑定到升级后套接字的行读取器。 */
class Wire {
  private buffer = ''
  private reader: ((line: string | null) => void) | null = null
  private ended = false
  private current: net.Socket

  constructor(socket: net.Socket) {
    this.current = socket
    this.bind(socket)
  }

  private bind(socket: net.Socket): void {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { this.buffer += chunk; this.pump() })
    socket.on('close', () => this.finish())
    socket.on('error', () => this.finish())
  }

  private finish(): void {
    this.ended = true
    this.pump()
  }

  private pump(): void {
    while (this.reader) {
      const line = this.take()
      if (line === null) { if (this.ended) { const resolve = this.reader; this.reader = null; resolve(null) } ; return }
      if (line === undefined) return
      const resolve = this.reader
      this.reader = null
      resolve(line)
    }
  }

  /** 返回完整行；undefined 表示还没有完整行；null 表示连接已结束。 */
  private take(): string | null | undefined {
    const index = this.buffer.indexOf('\r\n')
    if (index < 0) return undefined
    const line = this.buffer.slice(0, index)
    this.buffer = this.buffer.slice(index + 2)
    return line
  }

  readLine(): Promise<string | null> {
    const immediate = this.take()
    if (immediate !== undefined) return Promise.resolve(immediate)
    if (this.ended) return Promise.resolve(null)
    return new Promise(resolve => { this.reader = resolve; this.pump() })
  }

  write(text: string): void { this.current.write(text) }

  upgrade(context: tls.SecureContext): void {
    this.current.removeAllListeners('data'); this.current.removeAllListeners('close'); this.current.removeAllListeners('error')
    const secure = new tls.TLSSocket(this.current, { isServer: true, secureContext: context })
    this.buffer = ''
    this.ended = false
    this.current = secure
    this.bind(secure)
  }
}

export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtpServer> {
  const capabilities = options.capabilities ?? [options.tls ? 'STARTTLS' : null, 'AUTH PLAIN LOGIN', 'SIZE 1000000'].filter((line): line is string => line !== null)
  const counters = new Map<FakeStage, number>()
  const commands: string[] = []
  const transactions: FakeTransaction[] = []
  const authAttempts: { mechanism: string; username: string; password: string }[] = []
  let tlsUpgrades = 0
  const context = options.tls ? tls.createSecureContext(certificate()) : null

  const nextCode = (stage: FakeStage, fallback: number): number => {
    const script = options.failures?.[stage]
    const index = counters.get(stage) ?? 0
    if (!script || index >= script.length) return fallback
    counters.set(stage, index + 1)
    return script[index]!
  }

  const server = net.createServer(socket => {
    const wire = new Wire(socket)
    void (async () => {
      wire.write(`${nextCode('EHLO', options.greeting ?? 220)} fake.local ESMTP ready\r\n`)
      let authenticated: string | null = null
      let mailFrom = ''
      let recipients: string[] = []
      for (;;) {
        const line = await wire.readLine()
        if (line === null) return
        commands.push(line)
        const verb = line.split(/[ :]/)[0]!.toUpperCase()
        if (verb === 'EHLO' || verb === 'HELO') {
          const code = nextCode('EHLO', 250)
          if (code !== 250) { wire.write(`${code} ehlo refused\r\n`); continue }
          wire.write([`250-fake.local`, ...capabilities.map(capability => `250-${capability}`)].join('\r\n').replace(/-([^-]*)$/, ' $1') + '\r\n')
          continue
        }
        if (verb === 'STARTTLS') {
          if (!context) { wire.write('502 STARTTLS not supported\r\n'); continue }
          wire.write('220 ready to start TLS\r\n')
          wire.upgrade(context)
          tlsUpgrades += 1
          continue
        }
        if (verb === 'AUTH') {
          const code = nextCode('AUTH', 235)
          const mechanism = (line.split(' ')[1] ?? '').toUpperCase()
          if (mechanism === 'PLAIN') {
            const token = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8').split('\u0000')
            authAttempts.push({ mechanism: 'PLAIN', username: token[1] ?? '', password: token[2] ?? '' })
          } else if (mechanism === 'LOGIN') {
            wire.write('334 VXNlcm5hbWU6\r\n')
            const user = (await wire.readLine()) ?? ''
            wire.write('334 UGFzc3dvcmQ6\r\n')
            const pass = (await wire.readLine()) ?? ''
            authAttempts.push({ mechanism: 'LOGIN', username: Buffer.from(user, 'base64').toString('utf8'), password: Buffer.from(pass, 'base64').toString('utf8') })
          } else {
            wire.write('504 unsupported AUTH\r\n')
            continue
          }
          if (code !== 235) { wire.write(`${code} auth failed\r\n`); continue }
          authenticated = authAttempts[authAttempts.length - 1]!.username
          wire.write('235 authenticated\r\n')
          continue
        }
        if (verb === 'MAIL') {
          const code = nextCode('MAIL', 250)
          if (code === 250) mailFrom = /<(.*)>/.exec(line)?.[1] ?? ''
          wire.write(`${code} ${code === 250 ? 'sender ok' : 'sender rejected'}\r\n`)
          continue
        }
        if (verb === 'RCPT') {
          const code = nextCode('RCPT', 250)
          if (code === 250) recipients.push(/<(.*)>/.exec(line)?.[1] ?? '')
          wire.write(`${code} ${code === 250 ? 'recipient ok' : 'recipient rejected'}\r\n`)
          continue
        }
        if (verb === 'DATA') {
          const code = nextCode('DATA', 354)
          if (code !== 354) { wire.write(`${code} data refused\r\n`); continue }
          wire.write('354 end with .\r\n')
          const body: string[] = []
          for (;;) {
            const dataLine = await wire.readLine()
            if (dataLine === null) return
            if (dataLine === '.') break
            body.push(dataLine.startsWith('..') ? dataLine.slice(1) : dataLine)
          }
          if (options.delayBeforeDataEnd) await new Promise(resolve => setTimeout(resolve, options.delayBeforeDataEnd))
          const endCode = nextCode('DATA-END', 250)
          transactions.push({ mailFrom, recipients, data: body.length === 0 ? '' : `${body.join('\r\n')}\r\n`, authenticated })
          mailFrom = ''
          recipients = []
          wire.write(`${endCode} ${endCode === 250 ? 'queued' : 'message rejected'}\r\n`)
          continue
        }
        if (verb === 'QUIT') { wire.write('221 bye\r\n'); socket.end(); return }
        wire.write('502 command not implemented\r\n')
      }
    })().catch(() => socket.destroy())
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake SMTP server has no port')
  return {
    port: address.port,
    commands,
    transactions,
    authAttempts,
    get tlsUpgrades() { return tlsUpgrades },
    stop: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
  } as FakeSmtpServer
}