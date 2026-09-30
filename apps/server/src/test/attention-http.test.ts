import assert from 'node:assert/strict'
import test from 'node:test'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, seedAdministrator, seedLocalAccount } from './fixtures/administrator.ts'

test('attention HTTP uses real migrations and projection limits for administrator and ordinary accounts', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  try {
    const { token } = await seedAdministrator(app.store)
    await seedLocalAccount(app.store, { username: 'attention-reader', email: 'reader@example.test', password: 'attention-reader-test-password' })
    const base = await app.listen(0)
    assert.equal((await fetch(`${base}/api/attention`)).status, 401)
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'attention-reader', password: 'attention-reader-test-password' }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    for (const headers of [new Headers({ authorization: `Bearer ${token}` }), new Headers({ cookie })]) {
      const response = await fetch(`${base}/api/attention`, { headers })
      assert.equal(response.status, 200, await response.clone().text())
      const result = await response.json() as { total: number; groups: { kind: string; count: number }[] }
      assert.equal(result.total, 0)
      assert.deepEqual(result.groups.map(group => [group.kind, group.count]), [['approval', 0], ['task_assignment', 0], ['run_problem', 0], ['channel_dead_letter', 0]])
    }
  } finally { await app.close() }
})
