import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, administratorToken, seedAdministrator } from './fixtures/administrator.ts'

test('Workspace DELETE is a durable state-confirmed logical deletion without file cleanup commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-delete-'))
  const options = { databasePath: join(root, 'db'), administratorEmails: [administratorEmail] }
  let app = createWemuxServer(options), origin = await app.listen(0)
  const call = async (path: string, body?: unknown, method?: string, token = administratorToken) => {
    const r = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, data: r.status === 204 ? null : await r.json() }
  }
  try {
    await seedAdministrator(app.store); await call('/bootstrap', {})
    const project = (await call('/projects', { name: 'Retained Workspaces' })).data
    const workspace = (await call('/workspaces', { projectId: project.id, name: 'Logical', requestId: 'create' })).data.workspace
    const path = `/workspaces/${workspace.id}`
    let current = (await call(path)).data
    assert.match(current.revision, /^[a-f0-9]{64}$/)
    assert.equal((await call(path)).data.revision, current.revision)
    const body = { expectedRevision: current.revision, requestId: 'delete' }
    assert.equal((await call(path, {}, 'DELETE')).status, 400)
    await call(path, { name: 'Renamed' }, 'PATCH')
    assert.equal((await call(path, body, 'DELETE')).data.error.code, 'workspace_revision_conflict')
    current = (await call(path)).data
    body.expectedRevision = current.revision
    const before = await app.store.commands.list({ limit: 100 })
    const deleted = await call(path, body, 'DELETE')
    assert.equal(deleted.status, 200); assert.equal(deleted.data.workspaceId, workspace.id)
    assert.deepEqual(await app.store.commands.list({ limit: 100 }), before)
    assert.deepEqual(await call(path, body, 'DELETE'), deleted)
    assert.equal((await call(path, { ...body, expectedRevision: 'a'.repeat(64) }, 'DELETE')).data.error.code, 'request_id_conflict')
    assert.equal((await call(path, { ...body, requestId: 'new' }, 'DELETE')).status, 410)
    const history = (await call(path)).data
    assert.equal(history.deletedAt, deleted.data.deletedAt); assert.equal(history.name, 'Renamed')
    assert.equal((await call(`/workspaces?projectId=${project.id}`)).data.items.length, 0)
    assert.equal((await call('/workspaces', { projectId: project.id, name: 'Logical', requestId: 'create' })).status, 410)
    assert.equal((await call(path, { name: 'resurrect' }, 'PATCH')).status, 410)
    assert.equal((await call(`${path}/reprovision`, { requestId: 'retry' })).status, 410)
    assert.equal((await call(`/projects/${project.id}`, undefined, 'DELETE')).data.error.code, 'project_has_workspaces')
    await app.close(); app = createWemuxServer(options); origin = await app.listen(0)
    assert.deepEqual(await call(path, body, 'DELETE'), deleted)
    assert.equal((await call(path)).data.deletedAt, deleted.data.deletedAt)
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})

test('Workspace terminal proof is correlated, durable, never inferred from legacy/receipt and proved retries allow deletion', async () => {
  const { WorkerService } = await import('../application/worker-service.ts')
  const { Notifications } = await import('../application/notifications.ts')
  const root = await mkdtemp(join(tmpdir(), 'workspace-proof-'))
  const options = { databasePath: join(root, 'db'), administratorEmails: [administratorEmail] }
  let app = createWemuxServer(options), origin = await app.listen(0)
  let reports = new WorkerService(app.store, new Notifications())
  const call = async (path: string, body?: unknown, method?: string) => {
    const r = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, data: r.status === 204 ? null : await r.json() }
  }
  try {
    await seedAdministrator(app.store); await call('/bootstrap', {})
    const enrollment = (await call('/enrollment-tokens', {})).data
    const worker = (await call('/workers/enroll', { token: enrollment.token, name: 'Protocol proof fixture' })).data
    const create = async () => (await call('/workspaces', { projectId: 'default-project', name: 'Proof', workerId: worker.workerId })).data
    let tick = Date.now() + 1000
    const report = async (w: any, commandId: string | undefined, status: string, workerId = worker.workerId) => reports.receive(workerId, { type: 'event', scope: 'workspace', report: { workspaceId: w.workspace.id, ...(commandId ? { commandId } : {}), status, reason: status === 'failed' ? 'fixture failure' : null, location: null, occurredAt: new Date(tick++).toISOString() } } as never)
    const remove = async (w: any, requestId: string) => call(`/workspaces/${w.workspace.id}`, { expectedRevision: (await call(`/workspaces/${w.workspace.id}`)).data.revision, requestId }, 'DELETE')
    const w = await create()
    assert.equal((await remove(w, 'pending')).status, 409)
    await reports.receive(worker.workerId, { type: 'ack', receipt: { commandId: w.commandId, status: 'accepted' } })
    await report(w, undefined, 'ready')
    assert.equal((await app.store.resources.getWorkspace(w.workspace.id))!.placements[0].provisioning?.terminalReport, undefined)
    assert.equal((await remove(w, 'legacy')).status, 409)
    await report(w, 'wrong-attempt', 'ready')
    assert.equal((await remove(w, 'wrong')).status, 409)
    const otherEnrollment = (await call('/enrollment-tokens', {})).data
    const other = (await call('/workers/enroll', { token: otherEnrollment.token, name: 'Wrong Worker' })).data
    await assert.rejects(report(w, w.commandId, 'ready', other.workerId), /ownership/)
    await report(w, w.commandId, 'ready')
    const proved = (await app.store.resources.getWorkspace(w.workspace.id))!
    assert.equal(proved.placements[0].provisioning?.terminalReport?.commandId, w.commandId)
    const stable = (await call(`/workspaces/${w.workspace.id}`)).data.revision
    await report(w, undefined, 'ready')
    assert.equal((await call(`/workspaces/${w.workspace.id}`)).data.revision, stable, 'legacy report must not replace valid proof')
    await report(w, w.commandId, 'provisioning')
    assert.equal((await call(`/workspaces/${w.workspace.id}`)).data.revision, stable, 'contradictory terminal-to-active report ignored')
    const savedBody = { expectedRevision: stable, requestId: 'durable' }
    await app.close(); app = createWemuxServer(options); origin = await app.listen(0); reports = new WorkerService(app.store, new Notifications())
    const deleted = await call(`/workspaces/${w.workspace.id}`, savedBody, 'DELETE')
    assert.equal(deleted.status, 200, 'proof survives restart; transient offline health does not change revision')
    const tombstone = (await call(`/workspaces/${w.workspace.id}`)).data
    await report(w, w.commandId, 'ready')
    await reports.connected(worker.workerId, { name: 'Reconnect', platform: 'linux', workerVersion: 'fixture' })
    await report(w, w.commandId, 'ready')
    assert.deepEqual((await call(`/workspaces/${w.workspace.id}`)).data, tombstone, 'late/reconnect reports never revive or change metadata')
    const rejected = await create()
    await reports.receive(worker.workerId, { type: 'ack', receipt: { commandId: rejected.commandId, status: 'rejected', error: { code: 'invalid-input', message: 'pre-execution refusal', retryable: false } } })
    assert.equal((await app.store.resources.getWorkspace(rejected.workspace.id))!.placements[0].provisioning?.terminalReport, undefined)
    assert.equal((await remove(rejected, 'receipt-is-not-proof')).status, 409)
    const retried = await create()
    await reports.receive(worker.workerId, { type: 'ack', receipt: { commandId: retried.commandId, status: 'accepted' } })
    await report(retried, retried.commandId, 'failed')
    const next = (await call(`/workspaces/${retried.workspace.id}/reprovision`, { workerId: worker.workerId, requestId: 'next' })).data
    assert.equal((await app.store.resources.getWorkspace(retried.workspace.id))!.placements[0].provisioning?.terminalReport, undefined, 'new attempt resets proof')
    await report(retried, retried.commandId, 'ready')
    assert.equal((await app.store.resources.getWorkspace(retried.workspace.id))!.placements[0].provisioning?.terminalReport, undefined)
    await reports.receive(worker.workerId, { type: 'ack', receipt: { commandId: next.commandId, status: 'accepted' } })
    await report(retried, next.commandId, 'ready')
    assert.equal((await remove(retried, 'historical-accepted')).status, 200, 'each accepted attempt retains its own terminal proof')
    const failed = await create()
    await reports.receive(worker.workerId, { type: 'ack', receipt: { commandId: failed.commandId, status: 'accepted' } })
    await report(failed, failed.commandId, 'failed')
    assert.equal((await remove(failed, 'failed-original')).status, 200)
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})

test('Workspace deletion independently checks references, state equivalence, permissions, races and rollback', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] }), origin = await app.listen(0)
  const call = async (path: string, body?: unknown, method?: string, token = administratorToken) => {
    const r = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, data: r.status === 204 ? null : await r.json() }
  }
  try {
    await seedAdministrator(app.store); await call('/bootstrap', {})
    const member = await seedAdministrator(app.store, { userId: 'member' as never, email: 'member@example.test', username: 'member', token: 'member-token' })
    await app.store.transaction(tx => tx.identity.saveMembership({ userId: member.userId, teamId: 'default-team' as never, role: 'member', joinedAt: new Date().toISOString() as never }))
    const project = (await call('/projects', { name: 'Reference scope' })).data
    const create = async () => (await call('/workspaces', { projectId: project.id, name: 'Independent' })).data.workspace
    const w = await create(), path = `/workspaces/${w.id}`, state = (await call(path)).data
    const body = { expectedRevision: state.revision, requestId: 'delete' }
    for (const role of ['viewer', 'contributor']) {
      await call(`/projects/${project.id}/grants`, { userId: member.userId, role })
      const denied = await call(path, { ...body, expectedRevision: '0'.repeat(64) }, 'DELETE', 'member-token')
      assert.equal(denied.status, 404); assert.equal(denied.data.error?.details, undefined)
    }
    await call(`/projects/${project.id}/grants`, { userId: member.userId, role: 'manager' })
    const task = (await call(`/projects/${project.id}/tasks`, { title: 'Bound' })).data
    await call(`/projects/${project.id}/tasks/${task.id}/workspaces/${w.id}`, {}, 'PUT')
    assert.equal((await call(path)).data.revision, body.expectedRevision, 'bindings excluded from fingerprint but checked separately')
    assert.equal((await call(path, body, 'DELETE', 'member-token')).data.error.code, 'workspace_in_use')
    await call(`/projects/${project.id}/tasks/${task.id}/workspaces/${w.id}`, {}, 'DELETE')
    const transaction = app.store.transaction.bind(app.store)
    app.store.transaction = work => transaction(tx => work({ ...tx, audit: { append: async entry => { await tx.audit.append(entry); if (entry.action === 'workspace.delete') throw Error('injected audit failure') } } }))
    assert.equal((await call(path, body, 'DELETE', 'member-token')).status, 500)
    app.store.transaction = transaction
    assert.deepEqual((await call(path)).data, state)
    const responses = await Promise.all(Array.from({ length: 3 }, () => call(path, body, 'DELETE', 'member-token')))
    assert.ok(responses.every(r => r.status === 200)); assert.deepEqual(responses[0], responses[1])
    await call(`/projects/${project.id}/grants/${member.userId}`, undefined, 'DELETE')
    assert.equal((await call(path, body, 'DELETE', 'member-token')).status, 404)
    for (const deletingFirst of [true, false]) {
      const next = await create(), nextPath = `/workspaces/${next.id}`
      const confirmation = { expectedRevision: (await call(nextPath)).data.revision, requestId: 'race' }
      const remove = () => call(nextPath, confirmation, 'DELETE'), bind = () => call(`/projects/${project.id}/tasks/${task.id}/workspaces/${next.id}`, {}, 'PUT')
      assert.equal((await (deletingFirst ? remove() : bind())).status, 200)
      assert.equal((await (deletingFirst ? bind() : remove())).status, deletingFirst ? 404 : 409)
    }
    const concurrent = await create(), concurrentPath = `/workspaces/${concurrent.id}`, confirmation = { expectedRevision: (await call(concurrentPath)).data.revision, requestId: 'concurrent' }
    const raced = await Promise.all([call(concurrentPath, confirmation, 'DELETE'), call(`/projects/${project.id}/tasks/${task.id}/workspaces/${concurrent.id}`, {}, 'PUT')])
    assert.equal(raced.filter(result => result.status === 200).length, 1)
    const composite = await create(), memberWorkspace = await create()
    await app.store.transaction(async tx => { const value = (await tx.resources.getWorkspace(composite.id))!; await tx.resources.saveWorkspace({ ...value, spec: { kind: 'composite', memberWorkspaceIds: [memberWorkspace.id] } }) })
    for (const value of [composite, memberWorkspace]) assert.equal((await call(`/workspaces/${value.id}`, { requestId: 'composite', expectedRevision: (await call(`/workspaces/${value.id}`)).data.revision }, 'DELETE')).status, 409)
    const retained = await create()
    // Historical Run/Session references can exist independently of current Task binding.
    const originalTx = app.store.transaction.bind(app.store)
    for (const mode of ['assignee', 'run', 'session']) {
      app.store.transaction = work => originalTx(tx => work({ ...tx,
        tasks: { ...tx.tasks,
          list: async (id, includeDeleted) => (await tx.tasks.list(id, includeDeleted)).map(item => mode === 'assignee' && item.id === task.id ? { ...item, assignee: { workspaceId: retained.id } as never } : item),
          runs: async id => mode === 'run' && id === task.id ? [{ snapshot: { workspaceId: retained.id } } as never] : tx.tasks.runs(id),
        },
        resources: { ...tx.resources, listSessions: async () => mode === 'session' ? [{ workspaceId: retained.id, deletedAt: new Date().toISOString() } as never] : tx.resources.listSessions() },
      }))
      assert.equal((await call(`/workspaces/${retained.id}`, { expectedRevision: (await call(`/workspaces/${retained.id}`)).data.revision, requestId: mode }, 'DELETE')).status, 409, mode)
    }
    app.store.transaction = originalTx
    const { workspaceRevision } = await import('../application/workspace-revision.ts')
    const raw = (await app.store.resources.getWorkspace(memberWorkspace.id))!
    const a = { workerId: 'a', status: 'ready', failureReason: null, location: { workerId: 'a', workspaceId: raw.id, rootPath: '/a', checkouts: [] } } as const
    const b = { ...a, workerId: 'b', location: { ...a.location, workerId: 'b', rootPath: '/b' } }
    const first = { ...raw, placements: [a, b] } as never
    assert.equal(workspaceRevision(first), workspaceRevision({ ...raw, placements: [b, a] } as never))
    assert.notEqual(workspaceRevision(first), workspaceRevision({ ...raw, placements: [a, { ...b, location: { ...b.location, rootPath: '/changed' } }] } as never))
  } finally { await app.close() }
})

test('Workspace delete excludes concurrent provision and retained Session creation; no implicit cancellation', async () => {
  const { WorkerService } = await import('../application/worker-service.ts'), { Notifications } = await import('../application/notifications.ts')
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] }), origin = await app.listen(0)
  const call = async (path: string, body?: unknown, method?: string) => {
    const r = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${administratorToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, data: r.status === 204 ? null : await r.json() }
  }
  try {
    await seedAdministrator(app.store); await call('/bootstrap', {})
    const token = (await call('/enrollment-tokens', {})).data.token
    const worker = (await call('/workers/enroll', { token, name: 'Controlled fixture' })).data
    const reports = new WorkerService(app.store, new Notifications())
    await reports.connected(worker.workerId, { name: 'Controlled fixture', platform: 'linux', workerVersion: 'fixture' })
    await reports.receive(worker.workerId, { type: 'capability', workerId: worker.workerId, detectedAt: new Date().toISOString(), capabilities: [{ agentKey: 'test', displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test', displayName: 'Test', source: 'configured' }] }] } as never)
    const fresh = async (placed = false) => {
      const w = (await call('/workspaces', { projectId: 'default-project', name: 'Race', ...(placed ? { workerId: worker.workerId } : {}) })).data
      if (placed) {
        await reports.receive(worker.workerId, { type: 'ack', receipt: { commandId: w.commandId, status: 'accepted' } })
        await reports.receive(worker.workerId, { type: 'event', scope: 'workspace', report: { workspaceId: w.workspace.id, commandId: w.commandId, status: 'ready', reason: null, location: null, occurredAt: new Date(Date.now() + 1000).toISOString() } } as never)
      }
      return (await call(`/workspaces/${w.workspace.id}`)).data
    }
    for (const removeFirst of [true, false]) {
      const w = await fresh()
      const remove = () => call(`/workspaces/${w.id}`, { expectedRevision: w.revision, requestId: 'delete' }, 'DELETE')
      const prepare = () => call(`/workspaces/${w.id}/reprovision`, { workerId: worker.workerId, requestId: 'prepare' })
      assert.equal((await (removeFirst ? remove() : prepare())).status, 200)
      assert.equal((await (removeFirst ? prepare() : remove())).status, removeFirst ? 410 : 409)
    }
    const w = await fresh()
    const outcomes = await Promise.all([call(`/workspaces/${w.id}`, { expectedRevision: w.revision, requestId: 'delete' }, 'DELETE'), call(`/workspaces/${w.id}/reprovision`, { workerId: worker.workerId, requestId: 'prepare' })])
    assert.equal(outcomes.filter(r => r.status === 200).length, 1)
    for (const removeFirst of [true, false]) {
      const target = await fresh(true)
      const remove = () => call(`/workspaces/${target.id}`, { expectedRevision: target.revision, requestId: 'delete' }, 'DELETE')
      const session = () => call('/sessions', { workspaceId: target.id, workerId: worker.workerId, agentKey: 'test', modelId: 'test', title: 'Retained', requestId: `session-${target.id}` })
      const first = await (removeFirst ? remove() : session())
      assert.equal(first.status, removeFirst ? 200 : 201)
      assert.equal((await (removeFirst ? session() : remove())).status, removeFirst ? 410 : 409)
      if (!removeFirst) {
        await app.store.transaction(async tx => { const s = (await tx.resources.getSession(first.data.session.id))!; await tx.resources.saveSession({ ...s, archivedAt: new Date().toISOString() as never, deletedAt: new Date().toISOString() as never }) })
        assert.equal((await remove()).status, 409, 'retained deleted Session is not settled cleanup proof')
      }
    }
    for (const deleteFirst of [true, false]) {
      const project = (await call('/projects', { name: 'Project race' })).data
      const erase = () => call(`/projects/${project.id}`, undefined, 'DELETE')
      const create = () => call('/workspaces', { projectId: project.id, name: 'Concurrent logical Workspace' })
      const results = await Promise.all(deleteFirst ? [erase(), create()] : [create(), erase()])
      assert.equal(results.filter(value => value.status < 300).length, 1, 'Project deletion and Workspace creation are atomically exclusive')
    }
    const target = await fresh(true)
    const simultaneous = await Promise.all([call(`/workspaces/${target.id}`, { expectedRevision: target.revision, requestId: 'delete' }, 'DELETE'), call('/sessions', { workspaceId: target.id, workerId: worker.workerId, agentKey: 'test', modelId: 'test', title: 'Race', requestId: 'session-race' })])
    assert.equal(simultaneous.filter(r => r.status < 300).length, 1)
  } finally { await app.close() }
})
