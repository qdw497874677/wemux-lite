import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '@wemux/web-client'
import { createApplication, errorPresentation, resolveRoute, safeReturnTarget } from '../src/application.ts'

const host = { hostKind: 'cluster', contractVersion: 1, capabilities: [] }
const account = { user: { username: '测试用户', email: null }, teamId: 'team', csrfToken: 'fixture', instanceAdministrator: false }
const project = { id: 'p1', name: '真实合同项目', teamId: 'team', ownerId: 'u', accessRole: 'owner', shareScope: 'owner-only' }
function setup(overrides = {}) {
  const clients = []
  const dependencies = { discover: async () => host, cluster: (config, expired) => {
    const client = { currentAccount: async () => { throw new ApiError('anonymous', 401) }, login: async () => account, projects: async () => [project], logout: async () => {}, dispose() { this.disposed = true }, expired, ...overrides }
    clients.push(client); return client
  } }
  return { app: createApplication(dependencies), clients, dependencies }
}
test('restore anonymous, inline login, authorized project list and logout clear identity', async () => {
  const { app, clients } = setup()
  await app.start(); assert.equal(app.getSnapshot().phase, 'login')
  await app.login('user', 'password'); assert.equal(app.getSnapshot().phase, 'ready'); assert.deepEqual(app.getSnapshot().projects, [project])
  assert.equal(clients[0].disposed, true)
  await app.logout(); assert.equal(app.getSnapshot().phase, 'login'); assert.deepEqual(app.getSnapshot().projects, [])
  app.dispose()
})
test('empty list is success; permission error retry keeps account and never invents a project', async () => {
  let failed = true
  const { app } = setup({ projects: async () => { if (failed) throw new ApiError('denied', 403); return [] } })
  await app.start(); await app.login('u', 'p')
  assert.equal(app.getSnapshot().error.kind, 'forbidden'); assert.equal(app.getSnapshot().account.username, '测试用户')
  failed = false; await app.loadProjects(); assert.equal(app.getSnapshot().phase, 'ready'); assert.deepEqual(app.getSnapshot().projects, [])
})
test('expired identity clears content; late old project response cannot reappear after new login', async () => {
  let release
  const { app, clients } = setup({ projects: () => new Promise(resolve => { release = resolve }) })
  await app.start(); const login = app.login('u', 'p')
  await new Promise(resolve => setImmediate(resolve)); clients.at(-1).expired()
  assert.equal(app.getSnapshot().phase, 'login'); assert.match(app.getSnapshot().notice, /过期/)
  release([project]); await login; assert.deepEqual(app.getSnapshot().projects, [])
})
test('logout during pending project load clears content and ignores late results', async () => {
  let resolveProjects, resolveLogout, calls = 0
  const { app } = setup({
    projects: () => new Promise(resolve => { resolveProjects = resolve }),
    logout: () => { calls++; return new Promise(resolve => { resolveLogout = resolve }) },
  })
  await app.start()
  const login = app.login('u', 'p')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(app.getSnapshot().busy, true)
  const logout = app.logout()
  assert.equal(calls, 1)
  assert.equal(app.getSnapshot().loggingOut, true)
  assert.deepEqual(app.getSnapshot().projects, [])
  resolveProjects([project]); await login
  assert.deepEqual(app.getSnapshot().projects, [])
  resolveLogout(); await logout
  assert.equal(app.getSnapshot().phase, 'login')
  assert.deepEqual(app.getSnapshot().projects, [])
  app.dispose()
})
test('failed logout during pending load keeps identity but never accepts stale results', async () => {
  let resolveProjects, rejectLogout
  const { app } = setup({
    projects: () => new Promise(resolve => { resolveProjects = resolve }),
    logout: () => new Promise((_, reject) => { rejectLogout = reject }),
  })
  await app.start()
  const login = app.login('u', 'p')
  await new Promise(resolve => setImmediate(resolve))
  const logout = app.logout()
  resolveProjects([project]); await login
  rejectLogout(new ApiError('offline', undefined, 'network')); await logout
  assert.equal(app.getSnapshot().phase, 'ready')
  assert.equal(app.getSnapshot().error.kind, 'network')
  assert.deepEqual(app.getSnapshot().projects, [])
  app.dispose()
})
test('login failure can retry; logout network failure does not falsely claim cookie logout', async () => {
  let fail = true
  const { app } = setup({ login: async () => { if (fail) throw new ApiError('wrong', 401); return account }, logout: async () => { throw new ApiError('offline', undefined, 'network') } })
  await app.start(); await app.login('u', 'p'); assert.equal(app.getSnapshot().error.kind, 'unauthorized')
  fail = false; await app.login('u', 'p'); await app.logout()
  assert.equal(app.getSnapshot().phase, 'ready'); assert.equal(app.getSnapshot().error.kind, 'network')
})
test('Worker boundary does not instantiate cluster credentials or claim local Task support', async () => {
  let calls = 0
  const app = createApplication({ discover: async () => ({ ...host, hostKind: 'local-worker' }), cluster: () => { calls++; throw Error('must not call') } })
  await app.start(); assert.equal(app.getSnapshot().phase, 'local-worker'); assert.equal(calls, 0)
})
test('routes and safe return targets retain next query/hash but reject external and legacy targets', () => {
  assert.deepEqual(resolveRoute('/next/projects/p1'), { kind: 'project', projectId: 'p1' })
  assert.equal(resolveRoute('/next/missing').kind, 'not-found')
  assert.equal(resolveRoute('/next/projects/%ZZ').kind, 'not-found')
  for (const unsafe of ['https://evil.test/next/', '//evil.test/next/', '/next/../api', '/nextish', '/next/\\evil']) assert.equal(safeReturnTarget(unsafe), '/next/projects')
  assert.equal(safeReturnTarget('/next/projects/p1?q=one#details'), '/next/projects/p1?q=one#details')
})
test('404, forbidden, network, server, contract and rendering errors have separate recovery copy', () => {
  const values = [new ApiError('x', 404), new ApiError('x', 403), new ApiError('x', undefined, 'network'), new ApiError('x', 503), new ApiError('x', undefined, 'contract'), Error('render')].map(errorPresentation)
  assert.equal(new Set(values.map(value => value.title)).size, 6)
})
test('host discovery failure retries without retaining identity', async () => {
  const { app, dependencies } = setup()
  let offline = true
  dependencies.discover = async () => { if (offline) throw new ApiError('offline', undefined, 'network'); return host }
  await app.start(); assert.equal(app.getSnapshot().phase, 'error'); assert.equal(app.getSnapshot().error.kind, 'network')
  offline = false; await app.start(); assert.equal(app.getSnapshot().phase, 'login'); assert.deepEqual(app.getSnapshot().projects, [])
})
test('dispose during host discovery never creates a credential client', async () => {
  let resolve, calls = 0
  const app = createApplication({ discover: () => new Promise(done => { resolve = done }), cluster: () => { calls++; throw Error('late identity') } })
  const pending = app.start(); app.dispose(); resolve(host); await pending
  assert.equal(calls, 0)
})

function tabStorage(t, unavailable = false) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const values = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() {
    if (unavailable) throw new Error('Storage blocked')
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else delete globalThis.sessionStorage })
  return values
}

test('fresh anonymous bootstrap has no expiry warning', async t => {
  tabStorage(t)
  const { app } = setup()
  await app.start()
  assert.equal(app.getSnapshot().phase, 'login')
  assert.equal(app.getSnapshot().notice, '')
  app.dispose()
})

test('signed-in tab reload after cookie expiry warns and fresh login recovers', async t => {
  const values = tabStorage(t)
  const first = setup().app
  await first.start(); await first.login('user', 'password'); first.dispose()
  assert.deepEqual([...values.values()], ['1'], 'Only a non-identifying bit may be persisted')
  const reloaded = setup().app
  await reloaded.start()
  assert.equal(reloaded.getSnapshot().phase, 'login')
  assert.match(reloaded.getSnapshot().notice, /登录会话已过期/)
  assert.equal(reloaded.getSnapshot().account, null)
  assert.deepEqual(reloaded.getSnapshot().projects, [])
  await reloaded.login('user', 'password')
  assert.equal(reloaded.getSnapshot().notice, '')
  assert.deepEqual(reloaded.getSnapshot().projects, [project])
  reloaded.dispose()
})

test('restored authenticated cookie also remembers identity presence for expired reload', async t => {
  tabStorage(t)
  const first = setup({ currentAccount: async () => account }).app
  await first.start(); first.dispose()
  const reloaded = setup().app
  await reloaded.start()
  assert.match(reloaded.getSnapshot().notice, /登录会话已过期/)
  reloaded.dispose()
})

test('explicit successful logout then reload does not warn about expiry', async t => {
  const values = tabStorage(t)
  const first = setup().app
  await first.start(); await first.login('user', 'password'); await first.logout(); first.dispose()
  assert.equal(values.size, 0)
  const reloaded = setup().app
  await reloaded.start()
  assert.equal(reloaded.getSnapshot().phase, 'login')
  assert.equal(reloaded.getSnapshot().notice, '')
  reloaded.dispose()
})

test('unavailable session storage never blocks bootstrap, login, expiry or logout', async t => {
  tabStorage(t, true)
  const { app, clients } = setup()
  await app.start(); assert.equal(app.getSnapshot().notice, '')
  await app.login('user', 'password'); assert.equal(app.getSnapshot().phase, 'ready')
  clients.at(-1).expired(); assert.match(app.getSnapshot().notice, /登录会话已过期/)
  await app.login('user', 'password'); await app.logout()
  assert.equal(app.getSnapshot().phase, 'login')
  app.dispose()
})

test('failed logout retains expiry context across a later anonymous reload', async t => {
  tabStorage(t)
  const first = setup({ logout: async () => { throw new ApiError('offline', undefined, 'network') } }).app
  await first.start(); await first.login('user', 'password'); await first.logout()
  assert.equal(first.getSnapshot().phase, 'ready'); first.dispose()
  const reloaded = setup().app
  await reloaded.start(); assert.match(reloaded.getSnapshot().notice, /登录会话已过期/)
  reloaded.dispose()
})
