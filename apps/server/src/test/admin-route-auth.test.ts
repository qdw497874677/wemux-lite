import test from 'node:test'
import assert from 'node:assert/strict'
import { adminRouteFixture } from './fixtures/admin-route-fixture.ts'
import { routes } from '../http/routes/index.ts'
import { findRoute } from '../http/routes/registry.ts'
import { adminRoutes } from '../http/routes/admin-routes.ts'
import { resourceRoutes } from '../http/routes/resource-routes.ts'

const patterns = [['GET', '/commands'], ['GET', '/commands/:commandId'], ['GET', '/cluster/tailnet'], ['PATCH', '/projects/:projectId'], ['DELETE', '/projects/:projectId'], ['PATCH', '/sessions/:sessionId'], ['DELETE', '/sessions/:sessionId']] as const

test('seven targeted declared-admin descriptors are reachable, not shadowed; scoped Session reads remain distinct', () => {
  for (const [method, pattern] of patterns) {
    const descriptor = [...adminRoutes, ...resourceRoutes].find(route => route.method === method && route.pattern === pattern)!
    assert.equal(descriptor.auth, 'admin')
    assert.equal(findRoute(routes, method, pattern.replace(/:[^/]+/g, 'owned-id'))?.route, descriptor)
    assert.equal(routes.filter(route => route.method === method && route.pattern === pattern).length, 1)
  }
  assert.equal(findRoute(routes, 'GET', '/sessions/owned-id')?.route.auth, 'authenticated')
  assert.equal(findRoute(routes, 'PATCH', '/sessions/owned-id/access')?.route.auth, 'authenticated')
})

test('reachable declared-admin routes reject missing/invalid/non-admin identities before lookup, mutation or tailnet subprocess', async () => {
  const f = await adminRouteFixture()
  try {
    const memberCookie = await f.login('member')
    const calls = [
      { method: 'GET', path: '/commands' }, { method: 'GET', path: '/commands/policy-command' }, { method: 'GET', path: '/commands/unknown' }, { method: 'GET', path: '/cluster/tailnet' },
      ...[f.project.id, 'unknown'].flatMap(id => [{ method: 'PATCH', path: `/projects/${id}`, body: { name: 'forbidden rename' } }, { method: 'DELETE', path: `/projects/${id}` }]),
      ...[f.sessionId, 'unknown'].flatMap(id => [{ method: 'PATCH', path: `/sessions/${id}`, body: { title: 'forbidden rename' } }, { method: 'DELETE', path: `/sessions/${id}` }]),
    ]
    const before = await f.snapshot()
    for (const credential of [{ token: null, status: 401 }, { token: 'invalid', status: 401 }, { token: f.accounts.member.token, status: 403 }, { ...memberCookie, status: 403 }]) {
      for (const call of calls) {
        const response = await f.request(call.path, { ...call, ...credential })
        assert.equal(response.status, credential.status, `${call.method} ${call.path}`)
        assert.deepEqual(Object.keys(response.data), ['error'])
        const serialized = JSON.stringify(response.data)
        for (const hidden of ['policy-command', 'Private policy project', 'Private Session', '100.64.0.1', 'private-fixture.invalid']) assert.ok(!serialized.includes(hidden))
      }
      assert.deepEqual(await f.snapshot(), before, 'denied mutations do not alter resources, task versions, audit or command queue')
      assert.equal(await f.tailnetCalls(), 0, 'denied read must not launch tailnet command')
    }
    // Even malformed mutation bodies are not read/validated ahead of admin identity.
    const malformed = await fetch(`${f.origin}/api/projects/${f.project.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${f.accounts.member.token}`, 'Content-Type': 'application/json' }, body: '{' })
    assert.equal(malformed.status, 403)
  } finally { await f.close() }
})

test('admin Project mutation also requires current Project owner/manager scope before retained-history constraints', async () => {
  const f = await adminRouteFixture()
  try {
    const sameTeam = f.accounts.admin.token
    const before = await f.snapshot()
    for (const method of ['PATCH', 'DELETE']) {
      const response = await f.request(`/projects/${f.project.id}`, { method, token: sameTeam, ...(method === 'PATCH' ? { body: { name: 'scope bypass' } } : {}) })
      assert.equal(response.status, 404, 'same-Team admin without Grant cannot mutate private Project')
      assert.equal(response.data.error.code, 'project_not_found')
    }
    assert.deepEqual(await f.snapshot(), before)
    const foreignTeam = (await f.request('/teams', { body: { name: 'Cross-Team fixture' } })).data
    const foreign = (await f.request('/projects', { body: { name: 'Cross-Team private', teamId: foreignTeam.id } })).data
    for (const method of ['PATCH', 'DELETE']) assert.equal((await f.request(`/projects/${foreign.id}`, { token: sameTeam, method, ...(method === 'PATCH' ? { body: { name: 'cross scope' } } : {}) })).status, 404)
    for (const role of ['viewer', 'contributor']) {
      assert.equal((await f.request(`/projects/${f.project.id}/grants`, { body: { userId: f.accounts.admin.id, role } })).status, 201)
      for (const method of ['PATCH', 'DELETE']) assert.equal((await f.request(`/projects/${f.project.id}`, { token: sameTeam, method, ...(method === 'PATCH' ? { body: { name: 'below manager' } } : {}) })).status, 404)
    }
    await f.request(`/projects/${f.project.id}/grants`, { body: { userId: f.accounts.admin.id, role: 'manager' } })
    assert.equal((await f.request(`/projects/${f.project.id}`, { token: sameTeam, method: 'PATCH', body: { name: 'Authorized admin manager' } })).status, 200)
    assert.equal((await f.request(`/projects/${f.project.id}`, { token: sameTeam, method: 'DELETE' })).data.error.code, 'project_has_workspaces')
    await f.request(`/projects/${f.project.id}/grants/${f.accounts.admin.id}`, { method: 'DELETE' })
    assert.equal((await f.request(`/projects/${f.project.id}`, { token: sameTeam, method: 'DELETE' })).data.error.code, 'project_not_found')
    const empty = (await f.request('/projects', { body: { name: 'Eligible empty project' } })).data
    await f.request(`/projects/${empty.id}/grants`, { body: { userId: f.accounts.admin.id, role: 'manager' } })
    assert.equal((await f.request(`/projects/${empty.id}`, { token: sameTeam, method: 'DELETE' })).status, 204)
    await f.request(`/projects/${empty.id}/grants/${f.accounts.admin.id}`, { method: 'DELETE' }) // deleted resource cannot be reauthorized
    assert.equal((await f.request(`/projects/${empty.id}`, { token: sameTeam, method: 'DELETE' })).status, 404)
  } finally { await f.close() }
})

test('admin cookie CSRF/PAT scopes and existing Session control remain enforced; legitimate idle cleanup succeeds', async () => {
  const f = await adminRouteFixture()
  try {
    await f.pat(f.accounts.owner.id, 'read-only', ['read'])
    await f.pat(f.accounts.owner.id, 'write-only', ['write'])
    for (const path of ['/commands', '/commands/policy-command', '/cluster/tailnet']) assert.equal((await f.request(path, { token: 'write-only' })).status, 403)
    for (const path of [`/projects/${f.project.id}`, `/sessions/${f.sessionId}`]) for (const method of ['PATCH', 'DELETE']) assert.equal((await f.request(path, { token: 'read-only', method, ...(method === 'PATCH' ? { body: path.startsWith('/projects') ? { name: 'no' } : { title: 'no' } } : {}) })).status, 403)
    const cookie = await f.login('owner')
    const before = await f.snapshot()
    for (const path of [`/projects/${f.project.id}`, `/sessions/${f.sessionId}`]) for (const method of ['PATCH', 'DELETE']) assert.equal((await f.request(path, { cookie: cookie.cookie, method, ...(method === 'PATCH' ? { body: path.startsWith('/projects') ? { name: 'no csrf' } : { title: 'no csrf' } } : {}) })).status, 403)
    assert.deepEqual(await f.snapshot(), before)
    assert.equal((await f.request('/commands', { token: 'read-only' })).status, 403)
    assert.equal((await f.request('/commands')).status, 200)
    assert.equal((await f.request('/commands/policy-command', cookie)).status, 200)
    assert.equal((await f.request('/commands/unknown', cookie)).status, 404)
    assert.equal((await f.request('/cluster/tailnet', cookie)).status, 200)
    assert.equal(await f.tailnetCalls(), 1, 'only authorized diagnostic invokes owned harmless CLI fixture')
    assert.equal((await f.request(`/sessions/${f.sessionId}`, { token: f.accounts.admin.token, method: 'PATCH', body: { title: 'out of scope' } })).status, 404)
    await f.request(`/projects/${f.project.id}/grants`, { body: { userId: f.accounts.admin.id, role: 'viewer' } })
    assert.equal((await f.request(`/sessions/${f.sessionId}`, { token: f.accounts.admin.token, method: 'DELETE' })).status, 403, 'canRead does not grant Session control')
    await f.request(`/projects/${f.project.id}/grants`, { body: { userId: f.accounts.admin.id, role: 'manager' } })
    assert.equal((await f.request(`/sessions/${f.sessionId}`, { token: f.accounts.admin.token, method: 'PATCH', body: { title: 'Admin manager controlled rename' } })).status, 200)
    await f.request(`/projects/${f.project.id}/grants/${f.accounts.admin.id}`, { method: 'DELETE' })
    const afterRevoke = await f.snapshot()
    for (const method of ['PATCH', 'DELETE']) assert.equal((await f.request(`/sessions/${f.sessionId}`, { token: f.accounts.admin.token, method, ...(method === 'PATCH' ? { body: { title: 'revoked control' } } : {}) })).status, 404)
    assert.deepEqual(await f.snapshot(), afterRevoke)
    // Non-admin manager retains existing authenticated GET control projection, but not generic admin mutation.
    assert.equal((await f.request(`/sessions/${f.sessionId}`, { token: f.accounts.member.token })).status, 200)
    const renamed = await f.request(`/sessions/${f.sessionId}`, { ...cookie, method: 'PATCH', body: { title: 'Owned renamed Session' } })
    assert.equal(renamed.status, 200); assert.equal(renamed.data.title, 'Owned renamed Session')
    assert.equal((await f.request(`/sessions/${f.sessionId}`, { ...cookie, method: 'DELETE' })).status, 204)
    assert.ok((await f.app.store.resources.getSession(f.sessionId as never))!.deletedAt)
    assert.ok((await f.app.store.commands.list({ limit: 1000 })).some(command => command.commandId === `session-delete:${f.sessionId}`))
    const mutations = (await f.app.store.identity.listAudit(1000)).filter(entry => entry.action === 'sessions.update' || entry.action === 'sessions.delete')
    assert.equal(mutations.length, 3)
    assert.equal(mutations.filter(entry => entry.actorId === f.accounts.admin.id && entry.action === 'sessions.update').length, 1)
    assert.equal(mutations.filter(entry => entry.actorId === f.accounts.owner.id).length, 2)
    const empty = (await f.request('/projects', { body: { name: 'Cookie owned project' } })).data
    assert.equal((await f.request(`/projects/${empty.id}`, { ...cookie, method: 'PATCH', body: { name: 'Renamed empty' } })).status, 200)
    assert.equal((await f.request(`/projects/${empty.id}`, { ...cookie, method: 'DELETE' })).status, 204)
  } finally { await f.close() }
})
