/**
 * 邮件投递边界：Server 只认识 `EmailDelivery`，具体是 SMTP 还是本地出件箱由配置决定。
 *
 * 设计约束（`docs/design/account-identity-system.md`）：
 * - 没有邮件配置时**关闭**邮箱自助注册/找回，并明确告知；绝不模拟“发送成功”。
 * - 连接超时、有限重试与可见失败；失败必须能把原因带回接口层。
 * - 开发/测试需要一条可配置的本地投递路径，因此提供本地出件箱（写出 `.eml` 文件），
 *   它是真实投递到本机目录，不是把令牌写日志。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { WEB_CONSOLE_AUTH_PATHS } from '../web-console-routes.ts'
import { buildMailData, parseMailbox, type Mailbox } from './message.ts'
import { sendSmtpMessage, type SmtpConfig, type SmtpSecurity } from './smtp-client.ts'

export interface OutgoingMail {
  readonly to: string
  readonly subject: string
  readonly text: string
}

export interface EmailDelivery {
  readonly kind: 'smtp' | 'outbox'
  deliver(mail: OutgoingMail): Promise<void>
}

/** 没有可用投递路径时的显式状态：接口层据此返回“未开放”而不是“已发送”。 */
export class MailNotConfiguredError extends Error {
    readonly reason: string
  constructor(reason: string) {
    super(`Email delivery is not configured: ${reason}`); this.reason = reason;
    this.name = 'MailNotConfiguredError'
  }
}

export interface MailEnv {
  readonly [key: string]: string | undefined
}

export interface MailSettings {
  readonly from: Mailbox
  readonly publicUrl: string
  readonly delivery: EmailDelivery
  /** 出件箱目录（仅本地投递）；启动日志据此提示管理员去哪里取验证链接。 */
  readonly outboxDir: string | null
}

export class SmtpEmailDelivery implements EmailDelivery {
  readonly kind = 'smtp' as const
  private readonly config: SmtpConfig
  private readonly from: Mailbox
  private readonly clock: () => Date
  constructor(config: SmtpConfig, from: Mailbox, clock: () => Date = () => new Date()) { this.config = config; this.from = from; this.clock = clock;}

  async deliver(mail: OutgoingMail): Promise<void> {
    const data = buildMailData({ from: this.from, to: [parseMailbox(mail.to)], subject: mail.subject, text: mail.text, date: this.clock() })
    await sendSmtpMessage(this.config, { from: this.from.address, to: [parseMailbox(mail.to).address], data })
  }
}

export class OutboxEmailDelivery implements EmailDelivery {
  readonly kind = 'outbox' as const
  private readonly directory: string
  private readonly from: Mailbox
  private readonly clock: () => Date
  constructor(directory: string, from: Mailbox, clock: () => Date = () => new Date()) { this.directory = directory; this.from = from; this.clock = clock;}

  async deliver(mail: OutgoingMail): Promise<void> {
    const recipient = parseMailbox(mail.to)
    const data = buildMailData({ from: this.from, to: [recipient], subject: mail.subject, text: mail.text, date: this.clock() })
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const name = `${this.clock().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.eml`
    await writeFile(join(this.directory, name), data, { mode: 0o600 })
  }
}

function parseSecurity(url: URL): SmtpSecurity {
  const requested = url.searchParams.get('security')
  if (requested === null) return url.protocol === 'smtps:' ? 'implicit' : 'starttls'
  if (requested === 'implicit' || requested === 'starttls' || requested === 'plain') return requested
  throw new Error(`WEMUX_SMTP_URL security must be implicit, starttls or plain (got ${requested})`)
}

function parseSmtpUrl(raw: string): SmtpConfig {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('WEMUX_SMTP_URL is not a valid URL') }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') throw new Error('WEMUX_SMTP_URL must start with smtp:// or smtps://')
  const security = parseSecurity(url)
  const defaultPort = security === 'implicit' ? 465 : 587
  const port = url.port.length > 0 ? Number(url.port) : defaultPort
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('WEMUX_SMTP_URL port is invalid')
  const attempts = url.searchParams.get('attempts')
  const allowInsecureAuth = url.searchParams.get('allowInsecureAuth') === '1'
  if (security === 'plain' && url.password.length > 0 && !allowInsecureAuth) throw new Error('WEMUX_SMTP_URL uses cleartext with a password; switch to smtps:// or add ?security=starttls')
  return {
    host: url.hostname,
    port,
    security,
    username: url.username.length > 0 ? decodeURIComponent(url.username) : null,
    password: url.password.length > 0 ? decodeURIComponent(url.password) : null,
    heloDomain: url.searchParams.get('helo') ?? undefined,
    attempts: attempts === null ? undefined : Number(attempts),
    rejectUnauthorized: url.searchParams.get('tls') === 'insecure' ? false : true,
    allowInsecureAuth,
  }
}

/**
 * 解析邮件配置。返回 `settings: null` 时附带 `reason`，调用方必须据此关闭邮箱自助流程。
 * 配置错误（URL 非法、缺少 from）直接抛出：启动时就应该失败，而不是等第一封邮件静默失败。
 */
export function resolveMailSettings(env: MailEnv, clock: () => Date = () => new Date()): { settings: MailSettings | null; reason: string | null } {
  const publicUrl = (env.WEMUX_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
  const smtpUrl = (env.WEMUX_SMTP_URL ?? '').trim()
  const outbox = (env.WEMUX_MAIL_OUTBOX ?? '').trim()
  const fromValue = (env.WEMUX_SMTP_FROM ?? '').trim()
  if (smtpUrl.length === 0 && outbox.length === 0) return { settings: null, reason: '未配置 WEMUX_SMTP_URL，也未配置本地出件箱 WEMUX_MAIL_OUTBOX' }
  if (fromValue.length === 0) throw new Error('WEMUX_SMTP_FROM is required when email delivery is configured')
  const from = parseMailbox(fromValue)
  if (publicUrl.length === 0) throw new Error('WEMUX_PUBLIC_URL is required when email delivery is configured (verification links must not be built from request headers)')
  if (smtpUrl.length > 0) return { settings: { from, publicUrl, delivery: new SmtpEmailDelivery(parseSmtpUrl(smtpUrl), from, clock), outboxDir: null }, reason: null }
  return { settings: { from, publicUrl, delivery: new OutboxEmailDelivery(outbox, from, clock), outboxDir: outbox }, reason: null }
}

/** 验证链接指向 Web 确认页，不指向 API：邮件扫描器 GET 不能直接消费凭据。路径必须与前端路由一致（`WEB_CONSOLE_AUTH_PATHS.verifyEmail`），否则 HTTP 层会把它当 API 命名空间拒掉。 */
export function verificationLink(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${WEB_CONSOLE_AUTH_PATHS.verifyEmail}?token=${encodeURIComponent(token)}`
}

/** 重置链接同样指向前端页面，不能只写短路径。 */
export function passwordResetLink(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${WEB_CONSOLE_AUTH_PATHS.passwordReset}?token=${encodeURIComponent(token)}`
}

/** 邮箱变更确认链接（Ticket 06）：同样落在前端确认页，邮件扫描器 GET 不直接消费凭据。 */
export function changeEmailLink(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${WEB_CONSOLE_AUTH_PATHS.confirmEmailChange}?token=${encodeURIComponent(token)}`
}
