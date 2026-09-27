import assert from 'node:assert/strict'
import type { ServerStore } from '../server/src/application/ports/server-store.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'

/**
 * E2E 管理员会话助手（Ticket 04）。
 * 授权根是启动配置里声明的管理员邮箱（`WEMUX_ADMIN_EMAILS`）：部署者用该邮箱注册或登录即成管理员。
 * 这里直接播种「声明邮箱 + 本机密码 + 管理员归属」再走 HTTP 登录，跳过邮件环节但保留真实的密码校验与会话发放。
 */
export interface AdminSession {
  readonly username: string
  readonly password: string
  readonly cookie: string
  readonly csrfToken: string
  api<T = any>(path: string, method?: string, body?: unknown): Promise<T>
}

const cookieFrom = (response: Response): string => {
  const values = response.headers.getSetCookie?.() ?? []
  const pairs = values.map(value => value.split(';')[0]).filter(Boolean)
  assert.ok(pairs.length > 0, '认领应下发 HttpOnly 会话 Cookie')
  return pairs.join('; ')
}

export async function provisionAdministrator(input: { readonly store: ServerStore; readonly baseUrl: string; readonly email?: string; readonly password?: string }): Promise<AdminSession> {
  const email = input.email ?? 'e2e-owner@example.com'
  const password = input.password ?? 'e2e-owner-password-value'
  await seedLocalAccount(input.store, { username: email, email, password, administrator: true })
  return await login(input.baseUrl, email, password)
}

/** 用账号密码换一个新的 Cookie 会话，验证“首屏登录”路径而不是复用认领时的会话。 */
export async function login(baseUrl: string, username: string, password: string): Promise<AdminSession> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: username, password }),
  })
  const payload = await response.json() as { csrfToken?: string }
  assert.equal(response.status, 200, `登录失败：${JSON.stringify(payload)}`)
  const cookie = cookieFrom(response)
  const csrfToken = payload.csrfToken!
  return { username, password, cookie, csrfToken, api: async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const unsafe = method !== 'GET' && method !== 'HEAD'
    const result = await fetch(baseUrl + '/api' + path, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(unsafe ? { 'X-CSRF-Token': csrfToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = result.status === 204 ? null : await result.json()
    if (!result.ok) throw new Error(`${method} ${path}: ${result.status} ${JSON.stringify(data)}`)
    return data as T
  } }
}