import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.ts'
import { ApiError } from '@wemux/web-client'
test('verified account binding survives only same-account team replacement; late login cannot restore retired binding', async () => {
 const clients = []; let nextId = 'server-1', hold, release
 const app = createApplication({ discover: async () => ({ hostKind: 'cluster' }), cluster: (config, expired, options, accountId) => {
  const client = { accountId, config, expired, disposed: false, dispose() { this.disposed = true }, projects: async () => [], logout: async () => {}, currentAccount: async () => { throw new ApiError('anonymous', 401) }, login: async () => { if (hold) await new Promise(resolve => { release = resolve }); return { user: { id: nextId, username: 'same-name', email: null }, teamId: 't', csrfToken: 'fixture', instanceAdministrator: false } } }
  clients.push(client); return client
 } })
 await app.start(); await app.login('x', 'x'); const first = app.getClient(); assert.equal(first.accountId, 'server-1')
 await app.selectTeam('other'); assert.equal(first.disposed, true); assert.equal(app.getClient().accountId, 'server-1')
 app.getClient().expired(); assert.equal(app.getClient(), undefined)
 nextId = 'server-2'; await app.login('x', 'x'); assert.equal(app.getClient().accountId, 'server-2')
 await app.logout(); assert.equal(app.getClient(), undefined)
 hold = true; const pending = app.login('x', 'x'); app.dispose(); release(); await pending
 assert.equal(app.getClient(), undefined); assert.equal(clients.at(-1).disposed, true)
})
