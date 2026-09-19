/**
 * Google OIDC 的信任边界：授权码换令牌与 ID token 验证都必须发生在 Server。
 *
 * 设计（`docs/design/account-identity-system.md` 第 2.1 节与 Ticket 07）：
 * - 只信任本地用 Google 公钥验证过的 ID token；客户端提交的邮箱、姓名一律不可信。
 * - 未知密钥、网络故障、算法不符都关闭本次认证，绝不降级为“信任客户端资料”。
 * - 身份主键是规范 `(issuer, subject)`；邮箱只用于首次建号的人性化命名与冲突判定。
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { normalizeEmail, invalidEmailReason } from './email-address.js'

/** Google 的两种等价写法；规范化后统一为 `accounts.google.com`，避免同一个人被当成两个身份。 */
export const googleIssuer = 'accounts.google.com'

/** ID token 验证后的可信声明。字段缺失即为 null，不猜测。 */
export interface GoogleIdentityClaims {
  readonly issuer: string
  readonly subject: string
  /** Provider 声明的邮箱（已本地规范化）；无效格式视为 null。 */
  readonly email: string | null
  /** Google 是否声明该邮箱已验证；未声明的第三方邮箱不允许作为本站主邮箱。 */
  readonly emailVerified: boolean
  readonly hostedDomain: string | null
  readonly displayName: string | null
}

export interface GoogleTokenVerificationInput {
  readonly code: string
  readonly redirectUri: string
  readonly codeVerifier: string
  readonly expectedNonce: string
  readonly expectedIssuer: string
  readonly clientId: string
  readonly clientSecret: string
}

/**
 * 授权码换令牌 + ID token 验证的唯一入口。实现必须：
 * 校验签名/算法/issuer/audience/azp/nonce/时间，任何一步失败都抛错而不是返回部分资料。
 */
export interface GoogleTokenVerifier {
  verify(input: GoogleTokenVerificationInput): Promise<GoogleIdentityClaims>
}

export class GoogleVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleVerificationError'
  }
}

/** 令牌交换失败（网络/HTTP/缺少 id_token）：与“验签不通过”区分开，便于如实归因而不是误报 401。 */
export class GoogleExchangeError extends GoogleVerificationError {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleExchangeError'
  }
}

export function normalizeGoogleIssuer(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.replace(/^https?:\/\//i, '').toLowerCase()
}

/** 回调后允许返回的站内路径；协议相对、绝对 URL、反斜杠与控制字符一律拒绝，避免开放重定向。 */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim()
  if (candidate.length === 0 || candidate.length > 200) return null
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return null
  if (candidate.includes('\\') || /[\u0000-\u001f\u007f]/.test(candidate)) return null
  return candidate
}

function readClaims(payload: JWTPayload, expected: { issuer: string; nonce: string; clientId: string }): GoogleIdentityClaims {
  const issuer = normalizeGoogleIssuer(String(payload.iss ?? ''))
  if (issuer !== googleIssuer) throw new GoogleVerificationError(`Unexpected ID token issuer: ${issuer}`)
  if (issuer !== expected.issuer) throw new GoogleVerificationError(`ID token issuer ${issuer} does not match the configured provider ${expected.issuer}`)
  if (payload.nonce !== expected.nonce) throw new GoogleVerificationError('ID token nonce does not match the login transaction')
  // 多客户端场景下 azp 必须是自己；缺失时 audience 已被 jwtVerify 约束为自己，仍然安全。
  const azp = payload.azp
  if (typeof azp === 'string' && azp !== expected.clientId) throw new GoogleVerificationError('ID token was issued to a different client')
  const subject = payload.sub
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > 255) throw new GoogleVerificationError('ID token subject is missing')
  const rawEmail = typeof payload.email === 'string' ? payload.email.trim() : ''
  const email = rawEmail.length > 0 && !invalidEmailReason(rawEmail) ? normalizeEmail(rawEmail)?.normalized ?? null : null
  const hostedDomain = typeof payload.hd === 'string' && payload.hd.trim().length > 0 ? payload.hd.trim().slice(0, 255) : null
  const displayName = typeof payload.name === 'string' && payload.name.trim().length > 0 ? payload.name.trim().slice(0, 64) : null
  return { issuer, subject, email, emailVerified: payload.email_verified === true, hostedDomain, displayName }
}

/**
 * 生产实现：授权码 + PKCE 换 ID token，再用 Google 的公钥验证。
 * JWKS 按 jose 默认策略缓存并在未知 kid 时刷新一次（支持密钥轮换）；网络故障直接失败。
 */
export function createGoogleTokenVerifier(options: { readonly tokenEndpoint?: string; readonly jwksUri?: string; readonly fetch?: typeof fetch } = {}): GoogleTokenVerifier {
  const tokenEndpoint = options.tokenEndpoint ?? 'https://oauth2.googleapis.com/token'
  const jwks = createRemoteJWKSet(new URL(options.jwksUri ?? 'https://www.googleapis.com/oauth2/v3/certs'))
  return {
    async verify(input) {
      let response: Response
      try {
        response = await (options.fetch ?? fetch)(tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({
            code: input.code,
            client_id: input.clientId,
            client_secret: input.clientSecret,
            redirect_uri: input.redirectUri,
            grant_type: 'authorization_code',
            code_verifier: input.codeVerifier,
          }).toString(),
        })
      } catch (error) {
        throw new GoogleExchangeError(`Google token endpoint is unreachable: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!response.ok) throw new GoogleExchangeError(`Google token endpoint rejected the authorization code (HTTP ${response.status})`)
      let payload: { id_token?: unknown }
      try {
        payload = await response.json() as { id_token?: unknown }
      } catch {
        throw new GoogleExchangeError('Google token endpoint returned a malformed response')
      }
      if (typeof payload.id_token !== 'string' || payload.id_token.length === 0) throw new GoogleExchangeError('Google token endpoint returned no ID token')
      let verified: Awaited<ReturnType<typeof jwtVerify>>
      try {
        verified = await jwtVerify(payload.id_token, jwks, { issuer: [googleIssuer, `https://${googleIssuer}`], audience: input.clientId, algorithms: ['RS256'], clockTolerance: 60 })
      } catch (error) {
        throw new GoogleVerificationError(`ID token verification failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return readClaims(verified.payload, { issuer: input.expectedIssuer, nonce: input.expectedNonce, clientId: input.clientId })
    },
  }
}