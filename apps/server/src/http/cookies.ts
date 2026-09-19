import type { IncomingMessage } from 'node:http'

/**
 * Cookie 解析与写头。登录会话 Cookie 为 HttpOnly + SameSite=Lax + host-only；
 * 名称可按安装隔离，避免同主机多套部署互相误收会话（设计第 5 节）。
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    try { return decodeURIComponent(value) } catch { return value }
  }
  return undefined
}

/** 仅在确实走 HTTPS（含前置代理）时加 Secure，纯内网 HTTP 模式保持可用。 */
export function isSecureRequest(request: IncomingMessage): boolean {
  const forwarded = request.headers['x-forwarded-proto']
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (proto?.split(',')[0]?.trim() === 'https') return true
  return Boolean((request.socket as { encrypted?: boolean }).encrypted)
}

export function sessionCookie(input: { name: string; value: string; expiresAt: string; secure: boolean }): string {
  const attributes = [`${input.name}=${encodeURIComponent(input.value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Expires=${new Date(input.expiresAt).toUTCString()}`]
  if (input.secure) attributes.push('Secure')
  return attributes.join('; ')
}

export function clearedSessionCookie(input: { name: string; secure: boolean }): string {
  const attributes = [`${input.name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (input.secure) attributes.push('Secure')
  return attributes.join('; ')
}