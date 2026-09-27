/**
 * RFC 5322 报文构造（纯函数，无 I/O）。
 *
 * 只做投递需要的最小正确集合：ASCII 头 + RFC 2047 编码的非常 ASCII 头、base64 正文、CRLF 行尾、
 * 长头折行。不做 HTML 邮件、不做附件、不做 DKIM 签名（自托管场景由上游 MTA 负责）。
 * 任何可能造成头注入的字符（CR/LF）都在这里被拒绝，而不是在 SMTP 层被“顺便”过滤掉。
 */
import { randomBytes } from 'node:crypto'
import { invalidEmailReason, normalizeEmail } from '../email-address.ts'

export interface Mailbox {
  readonly address: string
  readonly name?: string | null
}

export interface MailMessageInput {
  readonly from: Mailbox
  readonly to: readonly Mailbox[]
  readonly subject: string
  readonly text: string
  readonly date?: Date
  readonly messageId?: string
  readonly headers?: Readonly<Record<string, string>>
}

const CRLF = '\r\n'

function assertNoInjection(value: string, field: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${field} must not contain line breaks`)
}

/** 解析 `Name <a@b>` 或 `a@b`；地址必须是可规范化的合法邮箱。 */
export function parseMailbox(input: string): Mailbox {
  const trimmed = input.trim()
  const match = /^(?:"?([^"<>]*?)"?\s*)?<([^<>]+)>$/.exec(trimmed)
  const name = match?.[1]?.trim() ?? null
  const address = (match?.[2] ?? trimmed).trim()
  if (invalidEmailReason(address) !== null) throw new Error(`Invalid mailbox address: ${address}`)
  if (name !== null) assertNoInjection(name, 'Mailbox display name')
  return { address: normalizeEmail(address)!.normalized, name: name && name.length > 0 ? name : null }
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/

/** 头值编码：纯 ASCII 原样输出，非常 ASCII 走 RFC 2047 base64 编码字。 */
export function encodeHeaderValue(value: string, limit = 76): string {
  assertNoInjection(value, 'Header value')
  if (ASCII_PRINTABLE.test(value)) return value
  const encoded = Buffer.from(value, 'utf8').toString('base64')
  const chunkSize = Math.max(4, Math.floor(((limit - '=?UTF-8?B??='.length) / 4)) * 4)
  const words: string[] = []
  for (let index = 0; index < encoded.length; index += chunkSize) words.push(`=?UTF-8?B?${encoded.slice(index, index + chunkSize)}?=`)
  return words.join(`${CRLF} `)
}

function formatAddress(mailbox: Mailbox): string {
  assertNoInjection(mailbox.address, 'Mailbox address')
  if (!mailbox.name) return `<${mailbox.address}>`
  const name = ASCII_PRINTABLE.test(mailbox.name) ? (needsQuoting(mailbox.name) ? `"${mailbox.name}"` : mailbox.name) : encodeHeaderValue(mailbox.name)
  return `${name} <${mailbox.address}>`
}

function needsQuoting(name: string): boolean {
  return !/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~.]+$/.test(name)
}

/** 折行：按 `;`/`,` 边界折到 78 字符以内；没有边界时按空格折。 */
function foldHeader(name: string, value: string): string {
  const single = `${name}: ${value}`
  if (single.length <= 78 || value.includes(CRLF)) return single
  const parts = value.split(/(?<=[;,])\s*/)
  const lines: string[] = []
  let current = `${name}:`
  for (const part of parts) {
    if (current.length + 1 + part.length > 78 && current.length > name.length + 1) {
      lines.push(current)
      current = ` ${part}`
    } else current = `${current} ${part}`
  }
  lines.push(current)
  return lines.join(CRLF)
}

export function formatMailDate(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  // 邮件头固定用 UTC（+0000）：本地时区偏移会让测试与日志难以对齐。
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
}

/** 构造完整报文字节；返回的 Buffer 可直接进 SMTP DATA。 */
export function buildMailData(input: MailMessageInput): Buffer {
  if (input.to.length === 0) throw new Error('Mail message needs at least one recipient')
  assertNoInjection(input.subject, 'Subject')
  const domain = input.from.address.slice(input.from.address.lastIndexOf('@') + 1)
  const messageId = input.messageId ?? `<${randomBytes(12).toString('hex')}@${domain}>`
  assertNoInjection(messageId, 'Message-ID')
  const body = Buffer.from(input.text, 'utf8').toString('base64').replace(/(.{76})/g, `$1${CRLF}`).replace(/\r\n$/, '')
  const headers = [
    foldHeader('From', formatAddress(input.from)),
    foldHeader('To', input.to.map(formatAddress).join(', ')),
    foldHeader('Subject', encodeHeaderValue(input.subject)),
    `Date: ${formatMailDate(input.date ?? new Date())}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    ...Object.entries(input.headers ?? {}).map(([name, value]) => foldHeader(name, encodeHeaderValue(value))),
  ]
  return Buffer.from(`${headers.join(CRLF)}${CRLF}${CRLF}${body}${CRLF}`, 'utf8')
}