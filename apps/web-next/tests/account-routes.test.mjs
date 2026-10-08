import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication, resolveRoute } from '../src/application.ts'
import { readOauthError, readLinkError, readLinkNotice, withoutLinkParams } from '../src/lib/oauth-error.ts'
test('account, membership and explicit mail paths resolve in Next', () => {
  for (const [path, kind] of [['settings','settings'],['teams','teams'],['join','join'],['auth/verify-email','auth-link'],['auth/password/reset','auth-link'],['auth/confirm-email-change','auth-link']]) assert.equal(resolveRoute(`/next/${path}`).kind, kind)
  assert.equal(resolveRoute('/next/auth/unknown').kind, 'not-found')
})
test('Google callback results show actual failure classes and remove result parameters only', () => {
  assert.match(readOauthError('?oauth_error=google_unconfigured'), /未配置/)
  assert.match(readOauthError('?oauth_error=state_replayed'), /已被使用/)
  assert.match(readLinkError('?link_error=identity_taken'), /另一个账号/)
  assert.match(readLinkNotice('?linked=google&already=1'), /没有重复绑定/)
  assert.equal(withoutLinkParams('/next/settings','?linked=google&already=1&link_error=x&tab=security'), '/next/settings?tab=security')
})
test('team switch retires old transport and ignores late old-scope project results', async () => {
  const clients = []; let resolveOld
  const account = { user: { username: 'synthetic', email: null }, teamId: 'old', csrfToken: 'fixture', instanceAdministrator: false }
  const app = createApplication({ discover: async () => ({ hostKind: 'cluster' }), cluster: config => {
    const client = { currentAccount: async () => account, projects: async () => config?.teamId === 'old' ? new Promise(resolve => { resolveOld = resolve }) : [{ id: 'new-project' }], dispose() { this.disposed = true } }
    clients.push(client); return client
  } })
  const starting = app.start(); await new Promise(resolve => setImmediate(resolve))
  const old = clients.at(-1)
  await app.selectTeam('new')
  assert.equal(old.disposed, true); assert.equal(app.getSnapshot().account.teamId, 'new')
  resolveOld([{ id: 'stale-project' }]); await starting
  assert.deepEqual(app.getSnapshot().projects, [{ id: 'new-project' }])
  app.dispose()
})

test('membership recheck clears commands/projects immediately, retires revoked scope and ignores in-flight responses', async () => {
  let permitted = true, delayed = false, resolveOld
  const clients = []
  const account = { user: { username: 'synthetic', email: null }, teamId: 'revoked-team', csrfToken: 'fixture', instanceAdministrator: false }
  const app = createApplication({ discover: async () => ({ hostKind: 'cluster' }), cluster: config => {
    const client = { currentAccount: async () => account, teams: async () => permitted ? [{ id: 'revoked-team' }] : [], projects: async () => delayed && config?.teamId ? new Promise(resolve => { resolveOld = resolve }) : permitted ? [{ id: 'private-project' }] : [], dispose() { this.disposed = true } }
    clients.push(client); return client
  } })
  await app.start()
  assert.equal(app.getSnapshot().projects.length, 1)
  delayed = true; const pending = app.loadProjects(); const old = clients.at(-1)
  permitted = false; const checking = app.revalidateAccess()
  assert.deepEqual(app.getSnapshot().projects, [])
  await checking
  assert.equal(old.disposed, true); assert.equal(app.getSnapshot().account.teamId, '')
  resolveOld([{ id: 'private-project' }]); await pending
  assert.deepEqual(app.getSnapshot().projects, [])
  delayed = false
  await app.start()
  assert.deepEqual(app.getSnapshot().projects, [])
  app.dispose()
})
