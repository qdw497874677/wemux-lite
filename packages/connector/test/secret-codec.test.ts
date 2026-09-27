import assert from 'node:assert/strict'
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import test from 'node:test'
import { AesGcmSecretCodec, PlaintextSecretCodec, type SecretCodecContext } from '../src/index.js'

const context: SecretCodecContext = {
  owner: { kind: 'connector', id: 'connector-1' },
  credentialId: 'credential-1',
  authType: 'api_key',
  revision: 1,
}

test('enc:v2 round-trips with random salts and IVs', async () => {
  const codec = new AesGcmSecretCodec({ currentKey: 'correct horse battery staple' })
  const first = await codec.encode('secret value', context)
  const second = await codec.encode('secret value', context)
  assert.match(first, /^enc:v2:[0-9a-f]{12}:/u)
  assert.notEqual(first, second)
  assert.equal(await codec.decode(first, context), 'secret value')
  assert.equal(codec.encrypted, true)
})

test('tampered tag, wrong key, and changed authenticated context fail', async () => {
  const codec = new AesGcmSecretCodec({ currentKey: 'key one' })
  const stored = await codec.encode('secret', context)
  const parts = stored.split(':')
  parts[6] = `${parts[6]!.slice(0, -1)}${parts[6]!.endsWith('A') ? 'B' : 'A'}`
  await assert.rejects(codec.decode(parts.join(':'), context))
  await assert.rejects(new AesGcmSecretCodec({ currentKey: 'key two' }).decode(stored, context), /matches/)
  await assert.rejects(codec.decode(stored, { ...context, revision: 2 }))
})

test('empty keys and more than three previous keys are rejected', () => {
  assert.throws(() => new AesGcmSecretCodec({ currentKey: '' }), /must not be empty/)
  assert.throws(() => new AesGcmSecretCodec({ currentKey: 'a', previousKeys: ['b', 'c', 'd', 'e'] }), /three previous/)
})

test('new key writes while previous key remains readable', async () => {
  const oldCodec = new AesGcmSecretCodec({ currentKey: 'old key' })
  const oldValue = await oldCodec.encode('old secret', context)
  const rotated = new AesGcmSecretCodec({ currentKey: 'new key', previousKeys: ['old key'] })
  assert.equal(await rotated.decode(oldValue, context), 'old secret')
  const newValue = await rotated.encode('new secret', context)
  await assert.rejects(oldCodec.decode(newValue, context), /matches/)
})

test('enc:v1 is accepted only by the explicit migration entry point', async () => {
  const legacyKey = 'legacy key'
  const legacy = createLegacyV1('legacy secret', legacyKey)
  const codec = new AesGcmSecretCodec({ currentKey: 'new key' })
  await assert.rejects(codec.decode(legacy, context), /explicit migration/)
  const migrated = await codec.migrateV1(legacy, legacyKey, context)
  assert.ok(migrated.startsWith('enc:v2:'))
  assert.equal(await codec.decode(migrated, context), 'legacy secret')
})

test('plaintext codec has an explicit unencrypted shape for tests', async () => {
  const codec = new PlaintextSecretCodec()
  assert.equal(codec.encrypted, false)
  assert.equal(await codec.decode(await codec.encode('test secret', context), context), 'test secret')
})

function createLegacyV1(plaintext: string, passphrase: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, 'oomol-connect-local-secret-store-v1', 32), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
}
