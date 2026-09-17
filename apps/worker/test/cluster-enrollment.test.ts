import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enroll } from '../src/transport/enrollment.js'

for (const [server, expected] of [['ws://example.test:8080/worker/ws', 'http://example.test:8080/workers/enroll'], ['wss://example.test/worker/ws', 'https://example.test/workers/enroll']]) {
  test(`enrollment uses HTTP origin for ${server} and persists only socket identity`, async t => {
    t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
      assert.equal(input.href, expected)
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
      return Response.json({ workerId: 'worker-1', credential: 'credential-1' })
    })
    const result = await enroll({ server, token: 'one-time-token', name: 'node', enrollmentPath: '/workers/enroll', socketPath: '/worker/ws' })
    assert.equal(result.identity.serverUrl, server)
    assert.equal(result.credential, 'credential-1')
    assert.equal(JSON.stringify(result.identity).includes('one-time-token'), false)
  })
}
