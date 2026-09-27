import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import { AppError } from '../../application/errors.ts'

export interface FeishuVerificationSecrets {
  readonly verificationToken: string
  readonly encryptKey: string | null
}

export interface VerifiedFeishuEnvelope {
  readonly value: Record<string, unknown>
  readonly encrypted: boolean
}

/** Verify/decrypt only. Callers must persist before returning an event ACK. */
export function verifyFeishuEnvelope(body: Buffer, secrets: FeishuVerificationSecrets): VerifiedFeishuEnvelope {
  if (body.byteLength > 1024 * 1024) throw new AppError(413, 'Request too large')
  const outer = objectJson(body)
  const encrypted = typeof outer.encrypt === 'string'
  const value = encrypted ? decryptEnvelope(outer.encrypt as string, secrets.encryptKey) : outer
  const token = typeof value.token === 'string'
    ? value.token
    : isRecord(value.header) && typeof value.header.token === 'string' ? value.header.token : null
  if (!token || !safeEqual(token, secrets.verificationToken)) throw new AppError(401, 'Invalid Feishu verification token', 'invalid_channel_token')
  return { value, encrypted }
}

export function feishuChallenge(value: Record<string, unknown>): string | null {
  return typeof value.challenge === 'string' && (value.type === 'url_verification' || !('header' in value)) ? value.challenge : null
}

/** Feishu Encrypt Key protocol: AES-256-CBC, IV=first 16 bytes of SHA-256(encryptKey), PKCS#7 padding. */
function decryptEnvelope(encrypted: string, encryptKey: string | null): Record<string, unknown> {
  if (!encryptKey) throw new AppError(401, 'Feishu encrypted event is not configured', 'invalid_channel_token')
  try {
    const key = createHash('sha256').update(encryptKey).digest()
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()])
    return objectJson(plaintext)
  } catch {
    throw new AppError(401, 'Invalid Feishu encrypted event', 'invalid_channel_token')
  }
}

function objectJson(body: Buffer): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(body.toString('utf8')) } catch { throw new AppError(400, 'Invalid JSON') }
  if (!isRecord(value)) throw new AppError(400, 'Invalid Feishu event body')
  return value
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
