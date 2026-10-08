import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient } from '../src/cluster-client.ts'
const config = { username: 'different-display-name', teamId: 'team', csrfToken: 'fixture', email: null, instanceAdministrator: false }
test('control identity binds only explicit account ID and existing transport lifetime', async () => {
 let release, consumed
 const bodyRead = new Promise(resolve => { consumed = resolve })
 const client = createClusterClient(config, () => {}, { origin: 'http://fixture.test', fetcher: async () => ({ ok: true, status: 202, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => { consumed(); await new Promise(resolve => { release = resolve }); return { commandId: 'control' } } }) }, 'server-account-id')
 assert.equal(client.controlIdentity.accountId, 'server-account-id'); assert.ok(Object.isFrozen(client.controlIdentity)); assert.equal(client.taskSessionScope.account, config.username)
 const pending = client.stopTurn('session', { commandId: 'control', turnId: 'original' })
 await bodyRead; client.dispose(); assert.equal(client.controlIdentity.signal.aborted, true); release()
 await assert.rejects(pending)
 for (const id of [undefined, '', ' ', 'x\0y', 'x'.repeat(201)]) { const c = createClusterClient(config, () => {}, { origin: 'http://fixture.test' }, id); assert.equal(c.controlIdentity.accountId, null); c.dispose() }
})
test('unauthorized transport retires control identity before notifying the owner', async () => {
 let notified = false, client
 client = createClusterClient(config, () => { assert.equal(client.controlIdentity.signal.aborted, true); notified = true }, { origin: 'http://fixture.test', fetcher: async () => new Response('{}', { status: 401 }) }, 'server-account-id')
 await assert.rejects(client.projects()); assert.equal(notified, true)
})
