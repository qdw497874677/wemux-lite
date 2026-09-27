import type { ChannelId } from '@wemux/connector'

export interface FeishuAppCredential { readonly appId: string; readonly appSecret: string; readonly revision: number }
interface TokenEntry { readonly token: string; readonly expiresAt: number }

export class FeishuTokenProvider {
  private readonly cache = new Map<string, TokenEntry>()
  private readonly flights = new Map<string, Promise<string>>()
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly baseUrl: string
  constructor(
    fetcher: typeof fetch = fetch,
    now: () => number = Date.now,
    sleep: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    baseUrl = 'https://open.feishu.cn/open-apis',
  ) {
    this.fetcher = fetcher
    this.now = now
    this.sleep = sleep
    this.baseUrl = baseUrl
  }

  async token(channelId: ChannelId, credential: FeishuAppCredential, force = false): Promise<string> {
    const key = `${channelId}:${credential.revision}`
    const cached = this.cache.get(key)
    if (!force && cached && cached.expiresAt - this.now() > 60_000) return cached.token
    const active = this.flights.get(key)
    if (active) return active
    const flight = this.fetchToken(key, credential).finally(() => this.flights.delete(key))
    this.flights.set(key, flight)
    return flight
  }

  async authorizedFetch(channelId: ChannelId, credential: FeishuAppCredential, input: string | URL, init: RequestInit): Promise<Response> {
    let token = await this.token(channelId, credential)
    let response = await this.withBackoff(input, withAuthorization(init, token))
    if (response.status !== 401) return response
    await response.body?.cancel().catch(() => undefined)
    this.cache.delete(`${channelId}:${credential.revision}`)
    token = await this.token(channelId, credential, true)
    return this.withBackoff(input, withAuthorization(init, token))
  }

  invalidate(channelId: ChannelId): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${channelId}:`)) this.cache.delete(key)
  }

  private async fetchToken(key: string, credential: FeishuAppCredential): Promise<string> {
    const response = await this.withBackoff(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ app_id: credential.appId, app_secret: credential.appSecret }) })
    const payload = await json(response)
    if (!response.ok || payload.code !== 0 || typeof payload.tenant_access_token !== 'string') throw new Error(`Feishu tenant token failed: HTTP ${response.status}, code ${String(payload.code ?? 'unknown')}`)
    const expire = typeof payload.expire === 'number' && payload.expire > 0 ? payload.expire : 7200
    this.cache.set(key, { token: payload.tenant_access_token, expiresAt: this.now() + expire * 1000 })
    return payload.tenant_access_token
  }

  private async withBackoff(input: string | URL, init: RequestInit): Promise<Response> {
    let response: Response | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await this.fetcher(input, init)
      if (response.status !== 429) return response
      if (attempt === 2) return response
      const delay = retryAfter(response) || 250 * 2 ** attempt
      await response.body?.cancel().catch(() => undefined)
      await this.sleep(delay)
    }
    return response!
  }
}

function withAuthorization(init: RequestInit, token: string): RequestInit { return { ...init, headers: { ...Object.fromEntries(new Headers(init.headers).entries()), authorization: `Bearer ${token}` } } }
async function json(response: Response): Promise<Record<string, unknown>> { try { const value = await response.json(); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} } catch { return {} } }
function retryAfter(response: Response): number { const value = response.headers.get('retry-after'); if (!value) return 0; const seconds = Number(value); return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - Date.now()) }
