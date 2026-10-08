import assert from 'node:assert/strict'
import test from 'node:test'
import { sseCredentialFixture, consumeStream, until } from './fixtures/sse-credential.ts'

// Real login Cookies and a real device-revocation API; no authorization stub.
test('four SSE streams revalidate the original Cookie on the real idle interval', async t => {
  const f = await sseCredentialFixture()
  t.after(() => f.app.close())
  const original = await f.login(), other = await f.login()
  const streams = await Promise.all(Object.entries(f.paths).map(async ([kind, path]) => ({ kind, path, stream: await consumeStream(f.base, path, { cookie: original.cookie }) })))
  t.after(() => streams.forEach(({ stream }) => stream.stop()))
  await until(() => streams.every(({ stream }) => stream.text().length > 0))
  const revoked = await fetch(`${f.base}/api/auth/sessions/${original.id}`, { method: 'DELETE', headers: { cookie: other.cookie, origin: f.base, 'x-csrf-token': other.csrf } })
  assert.equal(revoked.status, 204)
  await until(() => streams.every(({ stream }) => stream.ended()), 19_000)
  for (const { kind, path, stream } of streams) {
    assert.equal(stream.failed(), kind === 'session' || kind === 'project', `${kind} termination contract`)
    assert.equal((await fetch(`${f.base}${path}`, { headers: { cookie: original.cookie } })).status, 401)
    if (kind === 'canvas') assert.equal(stream.text().match(/event: authorization/g)?.length, 1)
  }
  assert.equal((await fetch(`${f.base}/api/auth/me`, { headers: { cookie: other.cookie } })).status, 200)
})

for (const kind of ['cookie', 'pat'] as const) {
  for (const change of ['authVersion', 'expiry', 'revocation', ...(kind === 'pat' ? ['identity', 'scope'] : [])]) {
    test(`${kind} ${change}: authorization wakeup rechecks all four streams without sensitive output`, async t => {
      const f = await sseCredentialFixture(kind === 'cookie' && change === 'expiry' ? 1200 : undefined)
      t.after(() => f.app.close())
      const original = await f.login()
      const headers: Record<string, string> = kind === 'cookie' ? { cookie: original.cookie, authorization: 'Bearer test-administrator-pat' } : { authorization: 'Bearer test-administrator-pat' }
      const streams = await Promise.all(Object.entries(f.paths).map(async ([name, path]) => ({ name, stream: await consumeStream(f.base, path, headers) })))
      t.after(() => streams.forEach(({ stream }) => stream.stop()))
      await until(() => streams.every(({ stream }) => stream.text().length > 0))
      if (kind === 'cookie' && change === 'expiry') await new Promise(resolve => setTimeout(resolve, 1300))
      await f.app.store.transaction(async tx => {
        if (change === 'identity') await tx.identity.saveUser({ ...(await tx.identity.getUser(f.actor))!, id: 'other-user' as never, username: 'other-user' })
        if (change === 'authVersion') {
          const user = (await tx.identity.getUser(f.actor))!
          await tx.identity.saveUser({ ...user, authVersion: (user.authVersion ?? 0) + 1 })
        } else if (kind === 'cookie') {
          if (change === 'revocation') await tx.identity.revokeLoginSession(original.id, new Date().toISOString() as never)
        } else {
          const row = (await tx.identity.listPersonalAccessTokens())[0]!
          await tx.identity.savePersonalAccessToken({ ...row, ...(change === 'expiry' ? { expiresAt: '2000-01-01T00:00:00Z' as never } : change === 'identity' ? { userId: 'other-user' as never } : change === 'scope' ? { scopes: [] } : { revokedAt: new Date().toISOString() as never }) })
        }
      })
      // Explicitly tests notification consumption, not #59 emission from APIs.
      f.app.service.notifications.authorization(f.actor)
      f.app.service.notifications.project({ id: 'late', projectId: f.project.id, taskId: 'sensitive-after-revocation', type: 'task.created' })
      f.app.service.notifications.terminal({ type: 'terminal.output', sessionId: f.session.id, terminalId: 'test', data: 'sensitive-after-revocation' })
      await until(() => streams.every(({ stream }) => stream.ended()))
      for (const { name, stream } of streams) {
        assert.equal(stream.failed(), name === 'session' || name === 'project')
        assert.equal(stream.text().includes('sensitive-after-revocation'), false)
        if (name === 'canvas') assert.match(stream.text(), /event: authorization\ndata: {"status":"revoked"}/)
      }
    })
  }
}

test('idle valid Cookie retains heartbeat without touching expiry or adding Session freshness', async t => {
  const f = await sseCredentialFixture()
  t.after(() => f.app.close())
  const original = await f.login()
  const stream = await consumeStream(f.base, f.paths.session, { cookie: original.cookie })
  t.after(() => stream.stop())
  await until(() => stream.text().includes('event: freshness'))
  const before = (await f.app.store.identity.getLoginSession(original.id))!
  await new Promise(resolve => setTimeout(resolve, 20_100))
  assert.equal(stream.ended(), false)
  assert.equal(stream.text().match(/event: freshness/g)?.length, 1)
  assert.equal(stream.text().match(/: heartbeat/g)?.length, 1)
  const after = (await f.app.store.identity.getLoginSession(original.id))!
  assert.equal(after.idleExpiresAt, before.idleExpiresAt)
  assert.equal(after.lastSeenAt, before.lastSeenAt)
})

for (const change of ['authVersion', 'pat-revoke', 'pat-expiry', 'cookie-expiry', 'resource'] as const) {
  test(`silent ${change}: real interval closes four streams with no authorization notification`, async t => {
    const f = await sseCredentialFixture(change === 'cookie-expiry' ? 2000 : undefined)
    t.after(() => f.app.close())
    const original = await f.login()
    const headers: Record<string, string> = change.startsWith('pat') ? { authorization: 'Bearer test-administrator-pat' } : { cookie: original.cookie }
    const streams = await Promise.all(Object.values(f.paths).map(path => consumeStream(f.base, path, headers)))
    t.after(() => streams.forEach(stream => stream.stop()))
    await until(() => streams.every(stream => stream.text().length > 0))
    if (change === 'pat-revoke') {
      const token = (await f.app.store.identity.listPersonalAccessTokens())[0]!
      assert.equal((await fetch(`${f.base}/api/auth/personal-access-tokens/${token.id}`, { method: 'DELETE', headers: { cookie: original.cookie, origin: f.base, 'x-csrf-token': original.csrf } })).status, 204)
    } else await f.app.store.transaction(async tx => {
      if (change === 'authVersion') await tx.identity.saveUser({ ...(await tx.identity.getUser(f.actor))!, authVersion: 1 })
      if (change === 'pat-expiry') await tx.identity.savePersonalAccessToken({ ...(await tx.identity.listPersonalAccessTokens())[0]!, expiresAt: new Date(Date.now() + 1000).toISOString() as never })
      if (change === 'resource') await tx.resources.saveProject({ ...f.project, deletedAt: new Date().toISOString() as never })
    })
    await until(() => streams.every(stream => stream.ended()), 19_000)
    for (const path of Object.values(f.paths)) assert.equal((await fetch(`${f.base}${path}`, { headers })).status, change === 'resource' ? 404 : 401)
  })
}
