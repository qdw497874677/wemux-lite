import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, administratorToken, seedAdministrator } from './fixtures/administrator.ts'

test('HTTP Task deletion is a durable CAS tombstone, not Workspace deletion or executable archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-delete-'))
  const options = { databasePath: join(root, 'db'), administratorEmails: [administratorEmail] }
  let app = createWemuxServer(options), origin = await app.listen(0)
  const call = async (path: string, body?: unknown, method?: string) => {
    const response = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  try {
    await seedAdministrator(app.store); await call('/bootstrap', {})
    const list = '/projects/default-project/tasks'
    const task = (await call(list, { title: 'Delete me', requestId: 'create' })).data
    const path = `${list}/${task.id}`, body = { version: 1, requestId: 'delete' }
    const workspace = (await call('/workspaces', { projectId: 'default-project', name: 'Independent' })).data.workspace
    await call(`${path}/workspaces/${workspace.id}`, {}, 'PUT')
    await call(`${path}/links`, { url: 'https://github.com/example/repo/issues/1' })
    assert.equal((await call(`${path}?teamId=wrong`, body, 'DELETE')).status, 403)
    const commandsBefore = await app.store.commands.list({ limit: 100 })
    const deleted = await call(path, body, 'DELETE')
    assert.deepEqual(await app.store.commands.list({ limit: 100 }), commandsBefore, 'deletion issues no Worker command')
    assert.equal(deleted.status, 200)
    assert.equal(deleted.data.version, 2)
    assert.equal(deleted.data.taskId, task.id)
    assert.ok(deleted.data.deletedAt)
    assert.deepEqual(await call(path, body, 'DELETE'), deleted)
    assert.equal((await call(path, { ...body, version: 2 }, 'DELETE')).data.error.code, 'request_id_conflict')
    assert.equal((await call(path, { version: 2, requestId: 'another' }, 'DELETE')).status, 410)
    const tombstone = (await call(path)).data
    assert.equal(tombstone.deletedAt, deleted.data.deletedAt); assert.equal(tombstone.links.length, 1)
    assert.deepEqual(tombstone.workspaces, []); assert.equal(tombstone.assignee, null)
    assert.equal(tombstone.capabilities.launchNew.allowed, false)
    assert.ok(Object.values(tombstone.capabilities.transitions).every((value: any) => value.reasonCode === 'task_deleted'))
    const newTask = (await call(list, { title: 'Workspace independent reuse' })).data
    assert.equal((await call(`${list}/${newTask.id}/workspaces/${workspace.id}`, {}, 'PUT')).status, 200)
    assert.equal((await call('/workspaces/' + workspace.id)).status, 200)
    assert.ok(!(await call(list)).data.items.some((t: { id: string }) => t.id === task.id))
    assert.equal((await call(`${path}/activity`)).data.items.at(-1).type, 'task.deleted')
    for (const [suffix, method, input] of [
      ['', 'PATCH', { title: 'resurrect', version: 2 }], ['/transition', 'POST', { status: 'todo', version: 2 }],
      ['/move', 'POST', { status: 'todo', version: 2 }], ['/links', 'POST', { url: 'https://github.com/example/repo/issues/2' }],
      ['/assignment', 'DELETE', { version: 2 }], [`/workspaces/${workspace.id}`, 'PUT', {}],
      ['/workspaces', 'POST', { name: 'no', requestId: 'no' }], [`/workspaces/${workspace.id}/retry`, 'POST', { requestId: 'retry' }], [`/workspaces/${workspace.id}`, 'DELETE', { version: 2 }], ['/links/retained', 'DELETE', {}], ['/runs/missing/cancel', 'POST', {}], ['/runs/missing/review', 'POST', {}], ['/launch', 'POST', {}], ['/sessions', 'POST', {}],
    ] as const) assert.equal((await call(path + suffix, input, method)).status, 410, suffix)
    assert.equal((await call(list, { title: 'Delete me', requestId: 'create' })).status, 410)
    await app.close(); app = createWemuxServer(options); origin = await app.listen(0)
    assert.deepEqual(await call(path, body, 'DELETE'), deleted)
    assert.equal((await call(`${path}/activity`)).data.items.filter((e: { type: string }) => e.type === 'task.deleted').length, 1)
    const race = (await call(list, { title: 'Race' })).data
    const results = await Promise.all([call(`${list}/${race.id}`, { title: 'Winner', version: 1 }, 'PATCH'), call(`${list}/${race.id}`, { version: 1, requestId: 'race' }, 'DELETE')])
    assert.equal(results.filter(r => r.status === 200).length, 1)
    assert.ok(results.some(r => [409, 410].includes(r.status)))
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})

test('Task deletion rejects all Session histories, active inconsistent Runs/reviews and serializes Task Session creation', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] }), origin = await app.listen(0)
  const call = async (path: string, body?: unknown, method?: string) => {
    const response = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  try {
    await seedAdministrator(app.store); await call('/bootstrap', {})
    const { token } = (await call('/enrollment-tokens', {})).data
    const worker = (await call('/workers/enroll', { token, name: 'Private controlled worker' })).data
    // Controlled backend state for deterministic active/offline/history cases; no Agent invocation.
    await app.store.transaction(async tx => {
      const w = (await tx.resources.getWorker(worker.workerId))!
      await tx.resources.saveWorker({ ...w, connectionState: 'online', capabilities: [{ agentKey: 'test' as never, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test' as never, displayName: 'Test', source: 'configured' }] }] })
    })
    const make = async () => {
      const task = (await call('/projects/default-project/tasks', { title: 'Session protected' })).data
      const path = `/projects/default-project/tasks/${task.id}`
      const created = (await call(`${path}/workspaces`, { name: 'Bound', workerId: worker.workerId, source: 'empty', assignment: { agentKey: 'test', modelId: 'test' }, version: 1 })).data
      await app.store.transaction(async tx => { const w = (await tx.resources.getWorkspace(created.workspace.id))!; await tx.resources.saveWorkspace({ ...w, placements: w.placements.map(p => ({ ...p, status: 'ready' })), status: 'ready' }) })
      return { path, task: (await call(path)).data }
    }
    const f = await make()
    const created = await call(`${f.path}/sessions`, { title: 'Protected Session', requestId: 'protected-session' })
    assert.equal(created.status, 201)
    const sessionsBefore = await app.store.resources.listSessions()
    await app.store.transaction(async tx => { const w = (await tx.resources.getWorker(worker.workerId))!; await tx.resources.saveWorker({ ...w, connectionState: 'offline' }) })
    assert.equal((await call(f.path, { version: f.task.version, requestId: 'offline-unsynced' }, 'DELETE')).data.error.code, 'task_has_sessions')
    await app.store.transaction(async tx => { const w = (await tx.resources.getWorker(worker.workerId))!; await tx.resources.saveWorker({ ...w, connectionState: 'online' }) })
    for (const mode of ['idle', 'archived', 'queued', 'deleted-unsettled'] as const) {
      await app.store.transaction(async tx => { const session = (await tx.resources.listSessions())[0]; await tx.resources.saveSession({ ...session, runtimeState: mode === 'queued' ? 'queued' : 'idle', archivedAt: mode === 'archived' ? new Date().toISOString() as never : null, deletedAt: mode === 'deleted-unsettled' ? new Date().toISOString() as never : null }) })
      const before = await app.store.resources.listSessions()
      const rejected = await call(f.path, { version: f.task.version, requestId: mode }, 'DELETE')
      assert.equal(rejected.data.error.code, 'task_has_sessions', mode)
      assert.deepEqual(await app.store.resources.listSessions(), before)
    }
    assert.equal(sessionsBefore.length, 1)
    for (const deleteFirst of [true, false]) {
      const next = await make()
      const requests = [() => call(next.path, { version: next.task.version, requestId: 'race' }, 'DELETE'), () => call(`${next.path}/sessions`, { title: 'Concurrent Session', requestId: `ordered-session-${deleteFirst ? 'delete-first' : 'create-first'}` })]
      const first = await requests[deleteFirst ? 0 : 1]()
      const second = await requests[deleteFirst ? 1 : 0]()
      assert.equal(first.status, deleteFirst ? 200 : 201)
      assert.equal(second.data.error.code, deleteFirst ? 'task_deleted' : 'task_has_sessions')
    }
    const concurrent = await make()
    const outcomes = await Promise.all([call(concurrent.path, { version: concurrent.task.version, requestId: 'concurrent' }, 'DELETE'), call(`${concurrent.path}/sessions`, { title: 'Concurrent Session', requestId: 'concurrent-session' })])
    assert.equal(outcomes.filter(value => value.status < 300).length, 1)
    const inconsistent = await make()
    await app.store.transaction(async tx => { const t = (await tx.tasks.get(inconsistent.task.id))!; await tx.tasks.save({ ...t, activeRun: { status: 'pending' } as never }) })
    for (const status of ['pending', 'running', 'cancelling']) {
      await app.store.transaction(async tx => { const t = (await tx.tasks.get(inconsistent.task.id))!; await tx.tasks.save({ ...t, activeRun: { status } as never }) })
      assert.equal((await call(inconsistent.path, { version: inconsistent.task.version, requestId: status }, 'DELETE')).data.error.code, 'active_run')
    }
    await app.store.transaction(async tx => { const t = (await tx.tasks.get(inconsistent.task.id))!; await tx.tasks.save({ ...t, activeRun: null, currentReviewId: 'missing-review' }) })
    assert.equal((await call(inconsistent.path, { version: inconsistent.task.version, requestId: 'review' }, 'DELETE')).data.error.code, 'task_has_review')
  } finally { await app.close() }
})

test('delete authorizes owner/manager before CAS/replay, rejects revoked rights and rolls back tombstone activity', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] }), origin = await app.listen(0)
  const { userId } = await seedAdministrator(app.store)
  const manager = await seedAdministrator(app.store, { userId: 'member' as never, username: 'member', email: 'member@example.test', token: 'member-token' })
  const call = async (path: string, body?: unknown, method?: string, token = administratorToken) => {
    const response = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  try {
    await call('/bootstrap', {})
    await app.store.transaction(tx => tx.identity.saveMembership({ userId: manager.userId, teamId: 'default-team' as never, role: 'member', joinedAt: new Date().toISOString() as never }))
    const project = (await call('/projects', { name: 'Private delete scope' })).data
    const task = (await call(`/projects/${project.id}/tasks`, { title: 'Manager delete' })).data
    const path = `/projects/${project.id}/tasks/${task.id}`
    for (const role of ['viewer', 'contributor']) {
      await call(`/projects/${project.id}/grants`, { userId: manager.userId, role })
      const result = await call(path, { version: 999, requestId: 'manager-delete' }, 'DELETE', 'member-token')
      assert.equal(result.status, 403); assert.equal(result.data.error.details, undefined)
    }
    await call(`/projects/${project.id}/grants`, { userId: manager.userId, role: 'manager' })
    const receipt = await call(path, { version: 1, requestId: 'manager-delete' }, 'DELETE', 'member-token')
    assert.equal(receipt.status, 200)
    await call(`/projects/${project.id}/grants/${manager.userId}`, undefined, 'DELETE')
    const denied = await call(path, { version: 1, requestId: 'manager-delete' }, 'DELETE', 'member-token')
    assert.equal(denied.status, 403); assert.equal(denied.data.error.details, undefined)
    assert.equal((await call(`/projects/${project.id}`, undefined, 'DELETE')).data.error.code, 'project_has_tasks')
    const rollback = (await call(`/projects/${project.id}/tasks`, { title: 'Rollback' })).data
    const rollbackPath = `/projects/${project.id}/tasks/${rollback.id}`
    const workspace = (await call('/workspaces', { projectId: project.id, name: 'Retained binding' })).data.workspace
    await call(`${rollbackPath}/workspaces/${workspace.id}`, {}, 'PUT')
    const before = (await call(rollbackPath)).data, events = (await call(`${rollbackPath}/activity`)).data
    const original = app.store.transaction.bind(app.store)
    app.store.transaction = work => original(tx => work({ ...tx, audit: { append: async value => { await tx.audit.append(value); if (value.action === 'task.delete') throw Error('injected deletion audit failure') } } }))
    assert.equal((await call(rollbackPath, { version: 1, requestId: 'rollback' }, 'DELETE')).status, 500)
    app.store.transaction = original
    assert.deepEqual((await call(rollbackPath)).data, before); assert.deepEqual((await call(`${rollbackPath}/activity`)).data, events)
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => call(rollbackPath, { version: 1, requestId: 'rollback' }, 'DELETE')))
    assert.ok(concurrent.every(value => value.status === 200)); assert.ok(concurrent.every(value => value.data.deletedAt === concurrent[0].data.deletedAt))
    assert.equal((await call(`${rollbackPath}/activity`)).data.items.filter((e: { type: string }) => e.type === 'task.deleted').length, 1)
    assert.ok(userId)
  } finally { await app.close() }
})
