import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AesGcmSecretCodec, PlaintextSecretCodec } from '@wemux/connector'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { WorkerProviderCredentialStore } from '../src/providers/credential-store.js'

const sentinel = 'provider-secret-sentinel-5367'
const key = 'isolated-provider-key-3257'
const input = { id: 'provider-ref', variableNames: ['OPENAI_API_KEY'], secret: { OPENAI_API_KEY: sentinel }, expectedRevision: 0 }

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-provider-credential-'))
  const path = join(dir, 'worker.sqlite')
  let db = new SqliteWorkerStore(path)
  return { dir, path, get db() { return db }, reopen() { db.close(); db = new SqliteWorkerStore(path); return db }, cleanup: async () => { db.close(); await rm(dir, { recursive: true, force: true }) } }
}

test('Worker model provider credential is encrypted with separate owner, persisted, rotated and revoked with CAS', async () => {
  const f = await fixture()
  try {
    let owner = new WorkerProviderCredentialStore(f.db, { key })
    assert.deepEqual(await owner.put(input), { id: input.id, variableNames: input.variableNames, revision: 1, availability: 'available' })
    assert.deepEqual(await owner.resolve(input.id, input.variableNames), input.secret)
    assert.deepEqual(await owner.list(), [{ id: input.id, variableNames: input.variableNames, revision: 1, availability: 'available' }])
    const raw = await readFile(f.path)
    assert.equal(raw.includes(Buffer.from(sentinel)), false, 'SQLite file must not contain the secret')
    const probe = new DatabaseSync(f.path)
    try {
      const row = probe.prepare('SELECT owner_kind, ciphertext FROM provider_credentials').get()!
      assert.equal(row.owner_kind, 'model-provider')
      assert.match(String(row.ciphertext), /^enc:v2:/)
      assert.equal(probe.prepare('SELECT count(*) AS count FROM connector_credentials').get()!.count, 0)
      assert.equal(probe.prepare('PRAGMA user_version').get()!.user_version, 7)
    } finally { probe.close() }
    owner = new WorkerProviderCredentialStore(f.reopen(), { key })
    assert.deepEqual(await owner.resolve(input.id, input.variableNames), input.secret)
    await assert.rejects(owner.put(input), /版本已变化/)
    const changed = await owner.put({ ...input, secret: { OPENAI_API_KEY: 'new-private-secret' }, expectedRevision: 1 })
    assert.equal(changed.revision, 2)
    await assert.rejects(owner.delete(input.id, 1), /版本已变化/)
    assert.deepEqual(await owner.resolve(input.id, input.variableNames), { OPENAI_API_KEY: 'new-private-secret' })
    await owner.delete(input.id, 2)
    await assert.rejects(owner.resolve(input.id, input.variableNames), /未配置/)
    assert.deepEqual(await owner.list(), [])
  } finally { await f.cleanup() }
})

test('Worker model provider credential fails closed on key loss, owner mismatch, altered fields and invalid input', async () => {
  const f = await fixture()
  try {
    const owner = new WorkerProviderCredentialStore(f.db, { key })
    await owner.put(input)
    const absent = new WorkerProviderCredentialStore(f.db)
    assert.equal(absent.available, false)
    assert.deepEqual(await absent.list(), [{ id: input.id, variableNames: input.variableNames, revision: 1, availability: 'unavailable' }])
    await assert.rejects(absent.put({ ...input, expectedRevision: 1 }), /未配置凭据加密密钥/)
    await assert.rejects(absent.resolve(input.id, input.variableNames), /不可用/)
    assert.throws(() => new WorkerProviderCredentialStore(f.db, { codec: new PlaintextSecretCodec() }), /必须加密/)
    const wrong = new WorkerProviderCredentialStore(f.db, { key: 'another encryption key' })
    const rekeyed = new WorkerProviderCredentialStore(f.db, { key: 'new-key', previousKeys: [key] })
    assert.deepEqual(await rekeyed.resolve(input.id, input.variableNames), input.secret)
    await rekeyed.put({ ...input, expectedRevision: 1 })
    assert.equal((await owner.list())[0]?.availability, 'unavailable', 'new writes use current key, not previous keys')
    assert.deepEqual(await rekeyed.resolve(input.id, input.variableNames), input.secret)
    assert.equal((await wrong.list())[0]?.availability, 'unavailable')
    await assert.rejects(wrong.resolve(input.id, input.variableNames), /不可解密/)
    await assert.rejects(owner.resolve(input.id, ['ANTHROPIC_API_KEY']), /字段不匹配/)
    const record = (await f.db.getProviderCredential(input.id))!
    await assert.rejects(new AesGcmSecretCodec({ currentKey: 'new-key', previousKeys: [key] }).decode(record.ciphertext, { owner: { kind: 'connector', id: input.id }, credentialId: input.id, authType: 'api_key', revision: 1 }), /authenticat|Unsupported state/)
    for (const name of ['WEMUX_SECRET', 'PATH', 'HOME', 'NODE_OPTIONS', 'PI_CODING_AGENT_DIR', 'LD_PRELOAD']) {
      await assert.rejects(owner.put({ ...input, variableNames: [name], secret: { [name]: sentinel }, expectedRevision: 2 }), /字段无效/)
    }
    await assert.rejects(owner.put({ ...input, variableNames: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'], expectedRevision: 1 }), /字段必须/)
    await assert.rejects(owner.put({ ...input, secret: { OPENAI_API_KEY: '' }, expectedRevision: 1 }), /字段必须/)
    await assert.rejects(owner.put({ ...input, secret: { OPENAI_API_KEY: sentinel, token: sentinel }, expectedRevision: 1 }), /字段必须/)
    const encrypted = (await f.db.getProviderCredential(input.id))!
    await f.db.saveProviderCredential({ ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -2) + 'zz', revision: 3 }, 2)
    assert.equal((await rekeyed.list())[0]?.availability, 'unavailable')
    await assert.rejects(rekeyed.resolve(input.id, input.variableNames), /不可解密/)
  } finally { await f.cleanup() }
})
