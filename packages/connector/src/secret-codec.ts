// Derived from oomol-lab/open-connector (Apache-2.0).

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'

const v2Prefix = 'enc:v2:'
const v1Prefix = 'enc:v1:'
const legacyV1Salt = 'oomol-connect-local-secret-store-v1'

export interface SecretCodecContext {
  readonly owner:
    | { readonly kind: 'connector'; readonly id: string }
    | { readonly kind: 'channel'; readonly id: string }
  readonly credentialId: string
  readonly authType: 'api_key' | 'custom_credential'
  readonly revision: number
}

export interface SecretCodec {
  readonly encrypted: boolean
  encode(plaintext: string, context: SecretCodecContext): Promise<string>
  decode(stored: string, context: SecretCodecContext): Promise<string>
}

export interface RotatingSecretCodecOptions {
  readonly currentKey: string
  readonly previousKeys?: readonly string[]
}

export class AesGcmSecretCodec implements SecretCodec {
  readonly encrypted = true
  private readonly current: KeyMaterial
  private readonly keys: ReadonlyMap<string, KeyMaterial>

  constructor(options: RotatingSecretCodecOptions) {
    const passphrases = [options.currentKey, ...(options.previousKeys ?? [])]
    if (passphrases.length > 4) throw new Error('At most three previous encryption keys are supported.')
    if (passphrases.some((value) => value.trim() === '')) throw new Error('Encryption key must not be empty.')
    const materials = passphrases.map(toKeyMaterial)
    this.current = materials[0]!
    this.keys = new Map(materials.map((material) => [material.keyId, material]))
  }

  async encode(plaintext: string, context: SecretCodecContext): Promise<string> {
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const key = deriveKey(this.current.passphrase, salt)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(additionalAuthenticatedData(context), 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [v2Prefix.slice(0, -1), this.current.keyId, salt, iv, ciphertext, tag]
      .map((part) => (Buffer.isBuffer(part) ? part.toString('base64url') : part))
      .join(':')
  }

  async decode(stored: string, context: SecretCodecContext): Promise<string> {
    if (!stored.startsWith(v2Prefix)) {
      throw new Error('Stored secret is not an enc:v2 payload; use an explicit migration entry point.')
    }
    const parts = stored.split(':')
    if (parts.length !== 7 || parts[0] !== 'enc' || parts[1] !== 'v2') throw new Error('Encrypted secret payload is malformed.')
    const [, , keyId, saltText, ivText, ciphertextText, tagText] = parts
    if (!keyId || !saltText || !ivText || ciphertextText === undefined || !tagText) {
      throw new Error('Encrypted secret payload is malformed.')
    }
    const material = this.keys.get(keyId)
    if (!material) throw new Error('No configured encryption key matches this secret.')
    const salt = decodeBase64Url(saltText, 16)
    const iv = decodeBase64Url(ivText, 12)
    const tag = decodeBase64Url(tagText, 16)
    const ciphertext = decodeBase64Url(ciphertextText)
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(material.passphrase, salt), iv)
    decipher.setAAD(Buffer.from(additionalAuthenticatedData(context), 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }

  /** Explicitly decrypt an upstream enc:v1 value and re-encrypt it as enc:v2. */
  async migrateV1(stored: string, legacyPassphrase: string, context: SecretCodecContext): Promise<string> {
    if (legacyPassphrase.trim() === '') throw new Error('Legacy encryption key must not be empty.')
    if (!stored.startsWith(v1Prefix)) throw new Error('Stored secret is not an enc:v1 payload.')
    const [ivText, tagText, ciphertextText, extra] = stored.slice(v1Prefix.length).split('.')
    if (!ivText || !tagText || ciphertextText === undefined || extra !== undefined) {
      throw new Error('Encrypted enc:v1 secret payload is malformed.')
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      scryptSync(legacyPassphrase, legacyV1Salt, 32),
      decodeBase64Url(ivText, 12),
    )
    decipher.setAuthTag(decodeBase64Url(tagText, 16))
    const plaintext = Buffer.concat([decipher.update(decodeBase64Url(ciphertextText)), decipher.final()]).toString('utf8')
    return this.encode(plaintext, context)
  }

  /** Explicitly encrypt a legacy plaintext value. Normal decode never accepts plaintext. */
  async migratePlaintext(plaintext: string, context: SecretCodecContext): Promise<string> {
    if (plaintext.startsWith('enc:')) throw new Error('Plaintext migration accepts only unprefixed values.')
    return this.encode(plaintext, context)
  }
}

/** Test-only codec. Production composition must never instantiate this class by default. */
export class PlaintextSecretCodec implements SecretCodec {
  readonly encrypted = false

  async encode(plaintext: string, _context: SecretCodecContext): Promise<string> {
    return plaintext
  }

  async decode(stored: string, _context: SecretCodecContext): Promise<string> {
    return stored
  }
}

interface KeyMaterial {
  readonly passphrase: string
  readonly keyId: string
}

function toKeyMaterial(passphrase: string): KeyMaterial {
  return { passphrase, keyId: createHash('sha256').update(passphrase, 'utf8').digest('hex').slice(0, 12) }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 16_384, r: 8, p: 1 })
}

function additionalAuthenticatedData(context: SecretCodecContext): string {
  if (!Number.isSafeInteger(context.revision) || context.revision < 1) throw new Error('Credential revision must be a positive safe integer.')
  return JSON.stringify({
    ownerKind: context.owner.kind,
    ownerId: context.owner.id,
    credentialId: context.credentialId,
    authType: context.authType,
    revision: context.revision,
  })
}

function decodeBase64Url(value: string, expectedBytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error('Encrypted secret payload is malformed.')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value || (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)) {
    throw new Error('Encrypted secret payload is malformed.')
  }
  return decoded
}
