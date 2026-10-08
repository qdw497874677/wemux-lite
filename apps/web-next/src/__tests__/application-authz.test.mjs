import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '@wemux/web-client'
import { createApplication } from '../application.ts'

const account = { user: { id: 'authz-user', username: '授权用户', email: null }, teamId: 'team', csrfToken: 'synthetic', instanceAdministrator: false }
const project = { id: 'authorized', name: '已撤权项目', teamId: 'team', ownerId: 'owner', accessRole: 'viewer', shareScope: 'team' }
function fixture() {
  let resolveProjects = async () => [project]
  const clients = []
  const app = createApplication({ discover: async () => ({ hostKind: 'cluster' }), cluster: (config, expired) => {
    const client = { expired, disposed: false, dispose() { this.disposed = true }, currentAccount: async () => account, projects: () => resolveProjects(), teams: async () => [{ id: 'team' }], logout: async () => {} }
    clients.push(client)
    return client
  } })
  return { app, clients, projects: fn => { resolveProjects = fn } }
}

test('application authz: invalid session clears account/client/cache and explains expiry or invalidation in Chinese', async () => {
  const { app, projects } = fixture()
  await app.start()
  const client = app.getClient()
  projects(async () => { throw new ApiError('rejected', 401) })
  await app.loadProjects()
  assert.equal(app.getSnapshot().phase, 'login')
  assert.equal(app.getSnapshot().account, null)
  assert.deepEqual(app.getSnapshot().projects, [])
  assert.equal(app.getClient(), undefined)
  assert.equal(client.disposed, true)
  assert.match(app.getSnapshot().notice, /登录会话已过期或已失效/)
  assert.match(app.getSnapshot().notice, /重新核验当前页面的访问权限/)
  app.dispose()
})

test('application authz: late authorized project response cannot undo a successful permission recheck', async () => {
  const { app, projects } = fixture()
  await app.start()
  let release
  projects(() => new Promise(resolve => { release = resolve }))
  const inFlight = app.loadProjects()
  projects(async () => [])
  await app.revalidateAccess()
  release([project])
  await inFlight
  assert.equal(app.getSnapshot().phase, 'ready')
  assert.deepEqual(app.getSnapshot().projects, [])
  assert.equal(app.getSnapshot().account.username, '授权用户')
  assert.equal(app.getSnapshot().notice, '')
  app.dispose()
})
