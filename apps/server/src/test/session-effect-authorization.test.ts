import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionEffectFixture, sessionEffects } from './fixtures/session-effect-fixture.ts'

test('HTTP viewer cannot dispatch file or terminal mutations', async t => {
  const f = await sessionEffectFixture(); t.after(() => f.close())
  await f.role('viewer')
  const observations = []
  for (const effect of sessionEffects) {
    const before = f.effects.length
    const response = await f.request(`/sessions/${f.sessionId}${effect.path}`, { token: f.accounts.member.token, body: effect.body })
    observations.push({ path: effect.path, status: response.status, dispatched: f.effects.length - before })
  }
  assert.deepEqual(observations, sessionEffects.map(effect => ({ path: effect.path, status: 403, dispatched: 0 })))
})

test('closed HTTP writes ignore Session visibility and Project role after platform authentication', async t => {
  const f = await sessionEffectFixture(); t.after(() => f.close())
  const base = `/sessions/${f.sessionId}`
  const matrix = [
    { name: 'owner', token: f.accounts.owner.token, scope: 'owner-only', role: 'viewer', expected: 403, code: 'write_channel_closed' },
    { name: 'readable contributor', token: f.accounts.member.token, scope: 'project', role: 'contributor', expected: 403, code: 'write_channel_closed' },
    { name: 'viewer', token: f.accounts.member.token, scope: 'project', role: 'viewer', expected: 403, code: 'write_channel_closed' },
    { name: 'readable manager', token: f.accounts.member.token, scope: 'project', role: 'manager', expected: 403, code: 'write_channel_closed' },
    { name: 'unreadable manager', token: f.accounts.member.token, scope: 'owner-only', role: 'manager', expected: 403, code: 'write_channel_closed' },
    { name: 'ungranted admin', token: f.accounts.admin.token, scope: 'owner-only', role: 'manager', expected: 403, code: 'write_channel_closed' },
    { name: 'anonymous', token: null, scope: 'project', role: 'viewer', expected: 401, code: 'authentication_required' },
    { name: 'insufficient PAT scope', token: 'synthetic-read-only', scope: 'project', role: 'manager', expected: 403, code: 'pat_scope_required' },
  ] as const
  await f.pat(f.accounts.owner.id, 'synthetic-read-only', ['read'])
  // Admin has Project visibility but no private Session grant: admin status must not bypass it.
  assert.equal((await f.request(`/projects/${f.project.id}/grants`, { body: { userId: f.accounts.admin.id, role: 'manager' } })).status, 201)
  for (const row of matrix) {
    await f.role(row.role); await f.scope(row.scope)
    for (const effect of sessionEffects) {
      const before = f.effects.length
      const stored = await f.snapshot(), forks = await f.app.store.resources.listSessionForks(f.project.id)
      const response = await f.request(`${base}${effect.path}`, { token: row.token, body: effect.body })
      assert.equal(response.status, row.expected, `${row.name} ${effect.path}`)
      assert.equal(response.data.error.code, row.code)
      assert.equal(f.effects.length - before, 0, `${row.name}: gateway dispatch`)
      assert.deepEqual(await f.snapshot(), stored)
      assert.deepEqual(await f.app.store.resources.listSessionForks(f.project.id), forks)
      const malformed = await fetch(`${f.origin}/api${base}${effect.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(row.token ? { Authorization: `Bearer ${row.token}` } : {}) }, body: '{' })
      assert.equal(malformed.status, row.expected, `${row.name}: authorize before parsing malformed JSON`)
      assert.equal((await malformed.json()).error.code, row.code)
      assert.equal(f.effects.length, before)
    }
  }
  await f.scope('project'); await f.role('contributor')
  // A contributor who owns a Session retains control, without changing the Project role.
  await f.app.store.transaction(async tx => { const session = (await tx.resources.getSession(f.sessionId as never))!; await tx.resources.saveSession({ ...session, ownerId: f.accounts.member.id as never }) })
  for (const effect of sessionEffects) {
    const stored = await f.snapshot(), forks = await f.app.store.resources.listSessionForks(f.project.id)
    const response = await f.request(`${base}${effect.path}`, { token: f.accounts.member.token, body: effect.body })
    assert.equal(response.status, 403); assert.equal(response.data.error.code, 'write_channel_closed')
    assert.deepEqual(await f.snapshot(), stored)
    assert.deepEqual(await f.app.store.resources.listSessionForks(f.project.id), forks)
  }
})

test('HTTP viewer file reads remain available with retained history; deleted Task terminal stream closes, writes stay policy-closed', async t => {
  const f = await sessionEffectFixture(); t.after(() => f.close())
  await f.role('viewer')
  const base = `/sessions/${f.sessionId}`
  for (const operation of ['list', 'read', 'diff']) {
    const response = await f.request(`${base}/fs/${operation}`, { token: f.accounts.member.token, body: { subpath: 'fixture.txt' } })
    assert.equal(response.status, 200)
  }
  const abort = new AbortController()
  const stream = await fetch(`${f.origin}/api${base}/terminal/stream`, { headers: { Authorization: `Bearer ${f.accounts.member.token}` }, signal: abort.signal })
  assert.equal(stream.status, 200); await stream.body?.cancel(); abort.abort()
  // The server injects terminalStreams; once the Task is tombstoned the route
  // must reject the stream before opening, not leak terminal output.
  await f.app.store.transaction(async tx => { const task = (await tx.tasks.get(f.task.id))!; await tx.tasks.save({ ...task, deletedAt: new Date().toISOString() }) })
  assert.equal((await f.request(`${base}/fs/list`, { token: f.accounts.member.token, body: { subpath: '.' } })).status, 200)
  const deletedStream = await fetch(`${f.origin}/api${base}/terminal/stream`, { headers: { Authorization: `Bearer ${f.accounts.member.token}` } })
  assert.equal(deletedStream.status, 404); await deletedStream.body?.cancel()
  for (const effect of sessionEffects) {
    const before = f.effects.length
    assert.equal((await f.request(`${base}${effect.path}`, { token: f.accounts.member.token, body: effect.body })).status, 403)
    assert.equal(f.effects.length, before)
    const response = await f.request(`${base}${effect.path}`, { body: effect.body })
    assert.equal(response.status, 403)
    assert.equal(response.data.error.code, 'write_channel_closed')
    assert.equal(f.effects.length - before, 0)
  }
  await f.scope('owner-only'); await f.role('manager')
  for (const effect of sessionEffects) assert.equal((await f.request(`${base}${effect.path}`, { token: f.accounts.member.token, body: effect.body })).status, 403)
})
