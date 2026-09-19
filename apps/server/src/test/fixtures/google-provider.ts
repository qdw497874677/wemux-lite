/**
 * Google 登录/绑定的测试替身：真实的 PKCE 校验 + 真实的 RS256 签名 ID token + 真实 JWKS。
 * 只替换「Google 那一侧」，`createGoogleTokenVerifier` 仍是生产代码，信任边界不被桩绕过。
 * 登录（Ticket 07）与绑定（Ticket 08）共用同一份替身，避免两处各写一份假 Provider 而后走偏。
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { createGoogleTokenVerifier, googleIssuer } from '../../application/google-oidc.js'

export const googleClientId = 'wemux-test-client.apps.googleusercontent.com'
export const googleClientSecret = 'test-client-secret'

export interface FakeGoogle {
  readonly jwksUri: string
  readonly tokenEndpoint: string
  setBehavior: (next: 'ok' | 'http-500' | 'bad-audience' | 'bad-nonce') => void
  setAuthorization: (input: { codeChallenge: string; nonce: string; redirectUri: string }) => void
  close: () => Promise<void>
}

/** 替身 Google：/jwks 提供公钥，/token 做真实 PKCE 校验后换取签好名的 ID token。 */
export async function fakeGoogle(): Promise<FakeGoogle> {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(publicKey), kid: 'fake-google-key', alg: 'RS256', use: 'sig' }
  const pending: { codeChallenge?: string; nonce?: string; redirectUri?: string; verifier?: string } = {}
  let behavior: 'ok' | 'http-500' | 'bad-audience' | 'bad-nonce' = 'ok'
  const server = createServer((request, response) => {
    const send = (status: number, data: unknown): void => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(data))
    }
    if (request.method === 'GET' && request.url === '/jwks') return send(200, { keys: [jwk] })
    if (request.method !== 'POST' || request.url !== '/token') return send(404, {})
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      void (async () => {
        if (behavior === 'http-500') return send(500, { error: 'server_error' })
        if (form.get('client_id') !== googleClientId) return send(400, { error: 'invalid_client' })
        if (form.get('client_secret') !== googleClientSecret) return send(400, { error: 'invalid_client' })
        // 真实的 PKCE 校验：收到的 code_verifier 必须还原出授权请求里的 challenge。
        pending.verifier = form.get('code_verifier') ?? ''
        if (createHash('sha256').update(pending.verifier).digest('base64url') !== pending.codeChallenge) return send(400, { error: 'invalid_grant' })
        const now = Math.floor(Date.now() / 1000)
        const token = await new SignJWT({
          iss: `https://${googleIssuer}`, aud: behavior === 'bad-audience' ? 'other-client' : googleClientId, azp: googleClientId,
          sub: 'google-subject-1', email: 'ada@example.com', email_verified: true, name: 'Ada Lovelace',
          hd: 'example.com', nonce: behavior === 'bad-nonce' ? 'not-the-nonce' : pending.nonce, iat: now, exp: now + 600,
        }).setProtectedHeader({ alg: 'RS256', kid: 'fake-google-key', typ: 'JWT' }).sign(privateKey)
        send(200, { access_token: 'fake-access-token-1', id_token: token })
      })().catch(error => send(400, { error: String(error) }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    jwksUri: `http://127.0.0.1:${port}/jwks`, tokenEndpoint: `http://127.0.0.1:${port}/token`,
    setBehavior: next => { behavior = next },
    setAuthorization: input => { Object.assign(pending, input) },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

/** 把替身 Provider 接进真实 Server：返回可直接展开进 `createWemuxServer` 的选项。 */
export function googleProviderSettings(provider: FakeGoogle, publicUrl: string) {
  return {
    google: { WEMUX_GOOGLE_CLIENT_ID: googleClientId, WEMUX_GOOGLE_CLIENT_SECRET: googleClientSecret, WEMUX_PUBLIC_URL: publicUrl },
    googleVerifier: createGoogleTokenVerifier({ tokenEndpoint: provider.tokenEndpoint, jwksUri: provider.jwksUri }),
  }
}

export interface CallOptions {
  readonly method?: string
  readonly body?: unknown
  readonly bearer?: string
  readonly csrf?: string | null
  readonly origin?: string | null
  readonly cookie?: string | null
  readonly accept?: string
}

/** 最小浏览器：显式管理 Cookie，手动跟随 302，便于断言中间跳转与清除行为。 */
export function browser(base: string) {
  const jar = new Map<string, string>()
  let csrf = ''
  const cookieHeader = (override?: string | null): string | undefined => {
    if (override !== undefined) return override ?? undefined
    return jar.size === 0 ? undefined : [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }
  const call = async (path: string, init: CallOptions = {}) => {
    const headers: Record<string, string> = { Accept: init.accept ?? 'application/json' }
    const cookie = cookieHeader(init.cookie)
    if (cookie) headers.Cookie = cookie
    if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`
    const token = init.csrf === undefined ? csrf : init.csrf
    if (token) headers['X-CSRF-Token'] = token
    if (init.origin !== null) headers.Origin = init.origin ?? base
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), redirect: 'manual',
      headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(';')
      const separator = pair!.indexOf('=')
      const name = pair!.slice(0, separator).trim(), value = pair!.slice(separator + 1).trim()
      if (value.length === 0 || attributes.some(attribute => attribute.trim().toLowerCase() === 'max-age=0')) jar.delete(name)
      else jar.set(name, decodeURIComponent(value))
    }
    const text = await response.text()
    let data: unknown = null
    try { data = text.length === 0 ? null : JSON.parse(text) } catch { data = null }
    if (data && typeof data === 'object' && typeof (data as { csrfToken?: unknown }).csrfToken === 'string') csrf = (data as { csrfToken: string }).csrfToken
    return { status: response.status, headers: response.headers, location: response.headers.get('location'), data, text }
  }
  return {
    call,
    cookie: (name: string): string | undefined => jar.get(name),
    get: (path: string, init: CallOptions = {}) => call(path, { ...init, method: 'GET' }),
    post: (path: string, body: unknown, init: CallOptions = {}) => call(path, { ...init, method: 'POST', body }),
    errorCode: (response: { data: unknown }): string | undefined => (response.data as { error?: { code?: string } } | null)?.error?.code,
  }
}

/** 模拟 Google 收到授权请求：把 challenge/nonce/redirect_uri 交给替身 Provider。 */
export function handoff(provider: FakeGoogle, authorizeUrl: string) {
  const query = new URL(authorizeUrl).searchParams
  provider.setAuthorization({ codeChallenge: query.get('code_challenge')!, nonce: query.get('nonce')!, redirectUri: query.get('redirect_uri')! })
  return { state: query.get('state')!, nonce: query.get('nonce')!, challenge: query.get('code_challenge')!, redirectUri: query.get('redirect_uri')! }
}