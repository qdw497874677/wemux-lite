import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalSessionApi } from '../src/hosts/local-session.ts'

test('local adapter writes with Worker CSRF and stable caller message identities', async () => {
  const requests = []
  const api = createLocalSessionApi(async (url, init) => {
    requests.push({ url, ...init })
    if (url.endsWith('/status')) return Response.json({ csrf: 'worker-only-csrf', capabilities: [], installation: { name: 'local', installationId: 'one' } })
    if (url.endsWith('/messages')) return Response.json({ commandId: 'cmd', status: 'accepted' }, { status: 202 })
    if (url.endsWith('/journal?fromSeq=1&limit=500')) return Response.json({ events: [], throughSeq: 0, hasMore: false })
    throw new Error(`unexpected URL: ${url}`)
  })
  await api.status()
  const receipt = await api.send('session', '你好', { commandId: 'cmd', messageId: 'msg' })
  assert.deepEqual(receipt, { commandId: 'cmd', messageId: 'msg', status: 'accepted' })
  assert.equal(requests[1].url, '/api/local/workbench/sessions/session/messages')
  assert.equal(requests[1].headers['x-wemux-csrf'], 'worker-only-csrf')
  assert.deepEqual(JSON.parse(requests[1].body), { commandId: 'cmd', messageId: 'msg', content: '你好' })
  assert.equal(requests[1].credentials, 'same-origin')
  await api.journal('session', 1, 500)
  assert.ok(!('x-wemux-csrf' in requests[2].headers))
  assert.ok(requests.every(request => !request.url.startsWith('/api/auth/') && !request.url.startsWith('/api/projects')))
})
