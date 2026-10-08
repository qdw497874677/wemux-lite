import { WebSocket } from 'ws'
import { TransportV2Peer } from './transport-v2-peer.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, administratorToken, seedAdministrator } from './fixtures/administrator.ts'

test('task-local create is atomic, scoped, durable and replays without reapplying CAS or activity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-local-create-'))
  const options = { databasePath: join(root, 'db'), administratorEmails: [administratorEmail] }
  let app = createWemuxServer(options), origin = await app.listen(0)
  const call = async (path: string, body?: unknown, method?: string) => {
    const response = await fetch(`${origin}/api${path}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, data: await response.json() }
  }
  try {
    await seedAdministrator(app.store); await call('/bootstrap', {})
    const enrollment = await call('/enrollment-tokens', {})
    const worker = (await call('/workers/enroll', { token: enrollment.data.token, name: 'Private offline fixture' })).data
    const t = (await call('/projects/default-project/tasks', { title: 'Task' })).data
    const path = `/projects/default-project/tasks/${t.id}`
    const body = { name: 'Owned workspace', workerId: worker.workerId, source: 'empty', requestId: 'intent' }
    const all = await Promise.all(Array.from({ length: 5 }, () => call(`${path}/workspaces`, body)))
    assert.ok(all.every(value => value.status === 201)); assert.equal(new Set(all.map(value => value.data.workspace.id)).size, 1)
    assert.equal(new Set(all.map(value => value.data.commandId)).size, 1)
    const { source: _source, ...defaultSource } = body
    assert.deepEqual((await call(`${path}/workspaces`, defaultSource)).data, all[0].data)
    assert.equal((await call(`${path}/workspaces`, { ...body, source: null })).status, 409)
    const events = (await call(`${path}/activity`)).data.items
    assert.equal(events.filter((e: { type: string }) => e.type === 'workspace.created').length, 1)
    assert.deepEqual(await call(`${path}/workspaces`, { ...body, name: 'Other' }), { status: 409, data: { error: { code: 'request_id_conflict', message: 'requestId already belongs to a different create request' } } })
    await call(path, { status: 'todo', version: 1 }, 'PATCH')
    assert.deepEqual((await call(`${path}/workspaces`, body)).data, all[0].data)
    assert.equal((await call(path)).data.version, 2)
    const other = (await call('/projects/default-project/tasks', { title: 'Other' })).data
    const separate = await call(`/projects/default-project/tasks/${other.id}/workspaces`, body)
    assert.notEqual(separate.data.workspace.id, all[0].data.workspace.id)
    const count = (await call('/workspaces')).data.items.length
    const bad = await call(`${path}/workspaces`, { ...body, requestId: 'bad-cas', assignment: { agentKey: 'test', modelId: 'test' }, version: 1 })
    assert.equal(bad.data.error.code, 'version_conflict'); assert.equal((await call('/workspaces')).data.items.length, count)
    const invalid = await call(`${path}/workspaces`, { ...body, requestId: 'invalid-runtime', assignment: { agentKey: 'missing', modelId: 'missing' }, version: 2 })
    assert.equal(invalid.status, 409); assert.equal((await call('/workspaces')).data.items.length, count)
    const peer = new TransportV2Peer(new WebSocket(`${origin.replace('http', 'ws')}/worker/ws`, { headers: { Authorization: `Bearer ${worker.credential}` } }), worker.workerId)
    await peer.connect({ name: 'Private protocol fixture' })
    peer.send({ type: 'capability', detectedAt: new Date().toISOString(), workerId: worker.workerId, capabilities: [{ agentKey: 'test', displayName: 'Test', version: 'fixture', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test', displayName: 'Test', source: 'configured' }] }] })
    for (let i = 0; i < 100; i++) { if ((await call(`/workers/${worker.workerId}`)).data.capabilities.length) break; await new Promise(resolve => setTimeout(resolve, 10)) }
    const assignedBody = { ...body, requestId: 'assigned', assignment: { agentKey: 'test', modelId: 'test' }, version: 2 }
    const assigned = await call(`${path}/workspaces`, assignedBody)
    assert.equal(assigned.status, 201); assert.equal(assigned.data.task.version, 3)
    await call(`${path}/assignment`, { version: 3 }, 'DELETE')
    const activityBeforeReplay = (await call(`${path}/activity`)).data.items.length
    assert.deepEqual((await call(`${path}/workspaces`, assignedBody)).data, assigned.data)
    assert.equal((await call(path)).data.assignee, null)
    assert.equal((await call(`${path}/activity`)).data.items.length, activityBeforeReplay)
    await peer.close()
    await app.close(); app = createWemuxServer(options); origin = await app.listen(0)
    assert.deepEqual((await call(`${path}/workspaces`, assignedBody)).data, assigned.data)
    assert.deepEqual((await call(`${path}/workspaces`, body)).data, all[0].data)
    assert.equal((await call(`${path}/activity`)).data.items.filter((e: { type: string }) => e.type === 'workspace.created').length, 2)
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})
