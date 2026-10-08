import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, administratorToken, seedAdministrator } from './fixtures/administrator.ts'

test('HTTP explicit create identities persist, isolate operations, serialize duplicates and preserve legacy trace reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wemux-create-idempotency-'))
  const options = { databasePath: join(root, 'db.sqlite'), administratorEmails: [administratorEmail] }
  let server = createWemuxServer(options), origin = await server.listen(0)
  const call = async (path: string, body?: unknown, method?: string) => {
    const response = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json', 'X-Request-ID': 'trace-reused-across-operations' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  try {
    await seedAdministrator(server.store)
    assert.equal((await call('/bootstrap', {})).status, 200)
    const body = { name: 'Idempotent project', teamId: 'default-team', requestId: 'same-intent' }
    const projects = await Promise.all(Array.from({ length: 6 }, () => call('/projects', body)))
    assert.ok(projects.every(p => p.status === 201))
    const project = projects[0].data
    assert.equal(new Set(projects.map(p => p.data.id)).size, 1)
    assert.equal((await call('/projects', { ...body, name: 'Different' })).status, 409)
    const enroll = await call('/enrollment-tokens', {})
    const worker = await call('/workers/enroll', { token: enroll.data.token, name: 'Private offline fixture' })
    const workspaceBody = { projectId: project.id, name: 'Workspace', workerId: worker.data.workerId, source: 'empty', requestId: 'same-intent' }
    const workspaces = await Promise.all(Array.from({ length: 6 }, () => call('/workspaces', workspaceBody)))
    assert.ok(workspaces.every(w => w.status === 201))
    assert.equal(new Set(workspaces.map(w => w.data.workspace.id)).size, 1)
    assert.equal(new Set(workspaces.map(w => w.data.commandId)).size, 1)
    assert.equal((await call('/workspaces', { ...workspaceBody, name: 'Changed' })).status, 409)
    const taskPath = `/projects/${project.id}/tasks`, taskBody = { title: 'Task', requestId: 'same-intent' }
    const tasks = await Promise.all(Array.from({ length: 6 }, () => call(taskPath, taskBody)))
    assert.ok(tasks.every(t => t.status === 201))
    assert.equal(new Set(tasks.map(t => t.data.id)).size, 1)
    assert.deepEqual(await call(taskPath, { ...taskBody, title: 'Changed' }), { status: 409, data: { error: { code: 'request_id_conflict', message: 'requestId already belongs to a different create request' } } })
    assert.equal((await call(`${taskPath}/${tasks[0].data.id}/activity`)).data.items.length, 1)
    // A tracing header never changes compatibility creation semantics.
    const a = await call(taskPath, { title: 'No body identity' }), b = await call(taskPath, { title: 'No body identity' })
    assert.notEqual(a.data.id, b.data.id)
    assert.equal((await call(taskPath, { title: 'Bad identity', requestId: 'bad id' })).status, 400)
    const workspaceCount = (await call(`/workspaces?projectId=${project.id}`)).data.items.length
    assert.equal(workspaceCount, 1)
    const commands = await server.store.commands.list({ limit: 100 })
    assert.equal(commands.filter(command => command.commandId === workspaces[0].data.commandId).length, 1)
    await server.close(); server = createWemuxServer(options); origin = await server.listen(0)
    assert.equal((await call('/projects', body)).data.id, project.id)
    assert.equal((await call('/workspaces', workspaceBody)).data.commandId, workspaces[0].data.commandId)
    assert.equal((await call(taskPath, taskBody)).data.id, tasks[0].data.id)
    assert.equal((await call(`/workspaces/${workspaces[0].data.workspace.id}`, undefined, 'DELETE')).status, 400)
    assert.equal((await call(`${taskPath}/${tasks[0].data.id}`, {}, 'DELETE')).status, 400)
  } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('create request index failure rolls back domain record, activity and command atomically', async () => {
  const server = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const origin = await server.listen(0)
  const call = async (path: string, body: unknown) => {
    const response = await fetch(`${origin}/api${path}`, { method: 'POST', headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  try {
    await seedAdministrator(server.store); await call('/bootstrap', {})
    const enrollment = await call('/enrollment-tokens', {})
    const worker = await call('/workers/enroll', { token: enrollment.data.token, name: 'Private rollback fixture' })
    const transaction = server.store.transaction.bind(server.store)
    let fail = false
    server.store.transaction = work => transaction(tx => work({ ...tx, resources: { ...tx.resources, saveCreateRequest: async (key, record) => { await tx.resources.saveCreateRequest(key, record); if (fail) throw Error('Injected create index write failure') } } }))
    const bodies = [
      ['/projects', { name: 'Rollback', teamId: 'default-team', requestId: 'rollback' }],
      ['/workspaces', { name: 'Rollback', projectId: 'default-project', workerId: worker.data.workerId, source: 'git', repository: { gitUrl: 'file:///private-fixture-not-executed' }, requestId: 'rollback' }],
      ['/projects/default-project/tasks', { title: 'Rollback', requestId: 'rollback' }],
    ] as const
    for (const [path, body] of bodies) {
      const snapshot = async () => JSON.stringify({ projects: await server.store.resources.listProjects(), workspaces: await server.store.resources.listWorkspaces(), tasks: await server.store.tasks.list('default-project'), commands: await server.store.commands.list({ limit: 100 }), activity: await server.store.tasks.projectActivity('default-project', 0) })
      const before = await snapshot()
      fail = true
      assert.equal((await call(path, body)).status, 500)
      assert.equal(await snapshot(), before)
      fail = false
      const created = await call(path, body), replayed = await call(path, body)
      assert.equal(created.status, 201); assert.deepEqual(replayed.data, created.data)
    }
  } finally { await server.close() }
})
