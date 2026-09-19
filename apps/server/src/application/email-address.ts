/**
 * 邮箱规范化与校验：整个产品唯一的一份规则。
 *
 * 规则（与 `docs/design/account-identity-system.md` 的顺序一致）：
 * 1. 去首尾空白；
 * 2. 域名转 ASCII（IDN → punycode，用 WHATWG URL 的 ICU 行为，不自己写映射表）；
 * 3. 产品级大小写不敏感：整个地址小写化（local part 也小写，避免 `A@x` 与 `a@x` 两个账号）；
 * 4. 保留原始显示值（`emailDisplay`），不静默改写用户输入的外观。
 *
 * 明确不做：Gmail 去点、去 `+tag` 的供应商别名合并——不同供应商规则不同，猜错会合并两个真实账号。
 */

/** 规范化结果：`normalized` 用于唯一约束与查询，`display` 是展示值。 */
export interface NormalizedEmail {
  readonly normalized: string
  readonly display: string
  readonly domain: string
}

const LOCAL_MAX = 64
const DOMAIN_MAX = 255
const ADDRESS_MAX = 254

/** 返回错误说明（面向用户的短句），null 表示合法。调用方不必先 trim。 */
export function invalidEmailReason(input: unknown): string | null {
  if (typeof input !== 'string' || input.trim().length === 0) return '请输入邮箱地址'
  // 规则第 1 步：去首尾空白；其后所有检查都基于去掉空白后的值。
  const trimmed = input.trim()
  if (trimmed.length > ADDRESS_MAX) return '邮箱地址过长'
  if (/[\s<>()[\],;:"\\]/.test(trimmed)) return '邮箱地址包含非法字符'
  // 控制字符与注释形式都可能导致头注入，一律拒绝。
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '邮箱地址包含非法字符'
  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return '邮箱地址缺少 @ 或域名'
  if (trimmed.indexOf('@') !== at) return '邮箱地址包含多个 @'
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  if (local.length > LOCAL_MAX) return '邮箱地址的本地部分过长'
  if (/^\.|\.\.|\.$/.test(local)) return '邮箱地址的本地部分格式不正确'
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local)) return '邮箱地址的本地部分格式不正确'
  const asciiDomain = asciiDomainOf(domain)
  if (!asciiDomain) return '邮箱域名格式不正确'
  if (asciiDomain.length > DOMAIN_MAX) return '邮箱域名过长'
  return null
}

/** 域名转 ASCII；无法转换（非法字符、空标签、无点）时返回 null。 */
export function asciiDomainOf(domain: string): string | null {
  const lowered = domain.trim().toLowerCase()
  if (lowered.length === 0 || lowered.includes('..') || lowered.startsWith('.') || lowered.endsWith('.')) return null
  let ascii: string
  try {
    // URL 只接受主机名，不接受路径/端口；任何路径字符都会让它落到 pathname，因此这里显式排除。
    if (/[/\\?#@:]/.test(lowered)) return null
    ascii = new URL(`http://${lowered}`).hostname
  } catch {
    return null
  }
  if (ascii.length === 0 || ascii.includes('..')) return null
  // 交付要求 FQDN：至少两个标签，且顶级标签不是纯数字（IP 字面量不做邮箱域）。
  const labels = ascii.split('.')
  if (labels.length < 2 || labels.some(label => label.length === 0 || label.length > 63)) return null
  if (!labels.every(label => /^[a-z0-9-]+$/.test(label) && !label.startsWith('-') && !label.endsWith('-'))) return null
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null
  return ascii
}

/** 规范化邮箱；非法输入返回 null，由调用方决定错误文案与状态码。 */
export function normalizeEmail(input: unknown): NormalizedEmail | null {
  if (typeof input !== 'string') return null
  const display = input.trim()
  if (invalidEmailReason(display) !== null) return null
  const at = display.lastIndexOf('@')
  const local = display.slice(0, at).toLowerCase()
  const domain = asciiDomainOf(display.slice(at + 1))
  if (!domain) return null
  return { normalized: `${local}@${domain}`, display, domain }
}

/** 用于展示的掩码形式：`a***@example.com`。星号数量固定，不泄漏本地部分长度。 */
export function maskEmail(normalized: string): string {
  const at = normalized.lastIndexOf('@')
  if (at <= 0) return '***'
  return `${normalized.slice(0, 1)}***${normalized.slice(at)}`
}