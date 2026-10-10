import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { enroll } from '../src/transport/enrollment.js'

const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString()
const commandSigningKey = { publicKey, keyId: createHash('sha256').update(publicKey).digest('hex') }

for (const [server, expected] of [['ws://example.test:8080/worker/ws', 'http://example.test:8080/workers/enroll'], ['wss://example.test/worker/ws', 'https://example.test/workers/enroll']]) {
  test(`enrollment uses HTTP origin for ${server} and persists only socket identity`, async t => {
    t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
      assert.equal(input.href, expected)
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
      return Response.json({ workerId: 'worker-1', credential: 'credential-1', commandSigningKey })
    })
    const result = await enroll({ server, token: 'one-time-token', name: 'node', enrollmentPath: '/workers/enroll', socketPath: '/worker/ws' })
    assert.equal(result.identity.serverUrl, server)
    assert.equal(result.credential, 'credential-1')
    assert.equal(JSON.stringify(result.identity).includes('one-time-token'), false)
  })
}

test('enrollment rejects a missing or invalid pinned signing key', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ workerId: 'worker', credential: 'credential' }))
  await assert.rejects(enroll({ server: 'http://localhost', token: 'token', name: 'node', enrollmentPath: '/workers/enroll', socketPath: '/worker/ws' }), /missing Server command signing key/)
})
