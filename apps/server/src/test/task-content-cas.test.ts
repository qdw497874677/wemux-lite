import test from 'node:test'
import assert from 'node:assert/strict'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, administratorToken, seedAdministrator } from './fixtures/administrator.ts'

test('HTTP Task content CAS includes legacy writes, concurrent writers, mixed PATCH and no-ops atomically', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const origin = await app.listen(0)
  const call = async (path: string, body?: unknown, method?: string, token = administratorToken) => {
    const response = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  try {
    await seedAdministrator(app.store); await call('/bootstrap', {})
    const task = (await call('/projects/default-project/tasks', { title: 'Initial', description: 'first\nsecond', acceptanceCriteria: null })).data
    const path = `/projects/default-project/tasks/${task.id}`
    const patch = (body: unknown) => call(path, body, 'PATCH')
    const activity = async () => (await call(`${path}/activity`)).data.items
    // Old callers omit version but their actual content mutation invalidates versioned snapshots.
    assert.equal((await patch({ description: 'legacy\nchange' })).status, 200)
    const stale = await patch({ title: 'stale overwrite', version: task.version })
    assert.equal(stale.status, 409)
    assert.equal(stale.data.error.code, 'version_conflict')
    assert.equal(stale.data.error.details.currentVersion, 2)
    assert.equal((await call(path)).data.title, 'Initial')
    assert.equal((await activity()).length, 2)
    const outcomes = await Promise.all([patch({ title: 'winner A', version: 2 }), patch({ title: 'winner B', version: 2 })])
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409])
    let current = (await call(path)).data
    assert.equal(current.version, 3); assert.equal((await activity()).length, 3)
    // Exact no-op with current version or without version does not advance/activity; stale no-op rejects.
    assert.equal((await patch({ title: current.title, version: 2 })).status, 409)
    assert.equal((await patch({ title: current.title, version: 3 })).data.version, 3)
    assert.equal((await patch({ title: current.title })).data.version, 3)
    assert.deepEqual((await call(path)).data, current)
    assert.equal((await activity()).length, 3)
    for (const version of [0, -1, 1.5, '3', null]) assert.equal((await patch({ title: 'invalid', version })).status, 400)
    assert.equal((await patch({ version: 3 })).status, 400)
    assert.equal((await patch({ status: 'todo' })).status, 400)
    assert.equal((await call(`${path}?teamId=wrong`, { title: 'forbidden', version: 1 }, 'PATCH')).status, 403)
    assert.equal((await call(path, { title: 'anonymous', version: 1 }, 'PATCH', 'invalid')).status, 401)
    const combined = await patch({ status: 'todo', description: 'combined\ncontent', version: 3 })
    assert.equal(combined.status, 200); assert.equal(combined.data.version, 4)
    assert.equal((await activity()).length, 4)
    assert.equal((await activity()).at(-1).type, 'task.transitioned')
    assert.equal((await patch({ status: 'todo', description: 'combined\ncontent', version: 4 })).data.version, 4)
    assert.equal((await patch({ status: 'todo', acceptanceCriteria: '', version: 4 })).data.version, 5)
    assert.equal((await patch({ acceptanceCriteria: null, version: 5 })).data.version, 6)
    assert.equal((await patch({ priority: 'high', version: 6 })).data.version, 7)
    assert.equal((await patch({ metadataJson: { schemaVersion: 1, values: { key: 'value' } }, version: 7 })).data.version, 8)
    current = (await call(path)).data
    assert.equal((await patch({ metadataJson: { values: { key: 'value' }, schemaVersion: 1 }, version: 8 })).data.version, 8)
    const before = await activity()
    // Fault after save/append must roll back content, version and activity together.
    const transaction = app.store.transaction.bind(app.store)
    app.store.transaction = work => transaction(tx => work({ ...tx, tasks: { ...tx.tasks, append: async (...args) => { await tx.tasks.append(...args); throw Error('injected activity failure') } } }))
    assert.equal((await patch({ title: 'rollback', version: 8 })).status, 500)
    app.store.transaction = transaction
    assert.deepEqual((await call(path)).data, current)
    assert.deepEqual(await activity(), before)
  } finally { await app.close() }
})
