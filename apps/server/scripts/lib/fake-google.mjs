// 验收脚本共用的 Google 替身：只有两个网络端点被替换，服务端仍跑真实 `createGoogleTokenVerifier`。
//   1. 授权页：Playwright 把 accounts.google.com 的请求改写到这里的 /authorize（自动同意）；
//   2. 令牌端点与 JWKS：ID token 由真实 RS256 密钥签名，PKCE / nonce / client 校验都保留。
// 使用方式见 `verify-google-login.mjs` 与 `verify-wave-ab.mjs`。
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

/**
 * 起一个替身 IdP。`state.next` 决定下一次授权使用的身份；默认身份只在用例忘了设置时兜底。
 */
export async function startFakeGoogle({ clientId, clientSecret }) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'verify-google-key', alg: 'RS256', use: 'sig' }
  const codes = new Map()
  const state = { next: null, exchanges: 0, authorizeQueries: [] }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (status, payload) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)) }
    if (request.method === 'GET' && url.pathname === '/jwks') return send(200, { keys: [jwk] })
    if (request.method === 'GET' && url.pathname === '/authorize') {
      state.authorizeQueries.push(Object.fromEntries(url.searchParams))
      const code = randomUUID()
      const identity = state.next ?? { subject: 'google-subject-default', email: 'google-default@gmail.com', emailVerified: true, name: 'Verify Google' }
      codes.set(code, { ...identity, challenge: url.searchParams.get('code_challenge') ?? '', nonce: url.searchParams.get('nonce') ?? '' })
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.searchParams.set('code', code)
      back.searchParams.set('state', url.searchParams.get('state') ?? '')
      response.writeHead(302, { location: back.toString(), 'cache-control': 'no-store' })
      return response.end()
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      const raw = await new Promise(resolve => { let text = ''; request.on('data', chunk => { text += chunk }); request.on('end', () => resolve(text)) })
      const body = new URLSearchParams(raw)
      const pending = codes.get(body.get('code') ?? '')
      if (!pending) return send(400, { error: 'invalid_grant' })
      if (createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== pending.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
      if ((body.get('client_id') ?? '') !== clientId || (body.get('client_secret') ?? '') !== clientSecret) return send(401, { error: 'invalid_client' })
      state.exchanges++
      const idToken = await new SignJWT({ email: pending.email, email_verified: pending.emailVerified, name: pending.name, nonce: pending.nonce, azp: clientId })
        .setProtectedHeader({ alg: 'RS256', kid: 'verify-google-key' }).setIssuer('accounts.google.com').setAudience(clientId)
        .setSubject(pending.subject).setIssuedAt().setExpirationTime('10m').sign(privateKey)
      return send(200, { access_token: 'verify-google-access-token', token_type: 'Bearer', expires_in: 3600, id_token: idToken })
    }
    return send(404, { error: 'not_found' })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, state, endpoint: `http://127.0.0.1:${server.address().port}` }
}

/** 浏览器侧把 accounts.google.com 的授权请求改写到替身 IdP，并记录每次真实授权参数。 */
export async function routeGoogleAuthorize(page, idp) {
  const authorizeUrls = []
  await page.route('https://accounts.google.com/**', async route => {
    const target = new URL(route.request().url())
    authorizeUrls.push(Object.fromEntries(target.searchParams))
    await route.fulfill({ status: 302, headers: { location: `${idp.endpoint}/authorize?${target.search}` } })
  })
  return authorizeUrls
}