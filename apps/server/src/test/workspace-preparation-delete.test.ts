import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandId, Timestamp, WorkerId, WorkspaceId } from '@wemux/domain'
import type { WorkspacePlacement } from '@wemux/server-domain'
import { createWemuxServer } from '../server.ts'
import { WorkerService } from '../application/worker-service.ts'
import { Notifications } from '../application/notifications.ts'
import { administratorEmail, administratorToken, seedAdministrator } from './fixtures/administrator.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'preparation-delete-'))
  const options = { databasePath: join(root, 'server.sqlite'), administratorEmails: [administratorEmail] }
  let app = createWemuxServer(options), origin = await app.listen(0), tick = Date.now() + 1000
  const call = async (path: string, body?: unknown, method?: string, token = administratorToken) => {
    const response = await fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  await seedAdministrator(app.store); await call('/bootstrap', {})
  const enrollment = (await call('/enrollment-tokens', {})).data
  const workerId = (await call('/workers/enroll', { token: enrollment.token, name: 'Preparation deletion' })).data.workerId as WorkerId
  const create = async () => {
    const response = await call('/workspaces', { projectId: 'default-project', name: 'Attempts', workerId })
    assert.equal(response.status, 201)
    return { id: response.data.workspace.id as WorkspaceId, commandId: response.data.commandId as CommandId }
  }
  const report = async (id: WorkspaceId, commandId: CommandId | undefined, status: 'ready' | 'failed', preLedger = false) => {
    const transaction = app.store.transaction.bind(app.store)
    // Simulate persisted pre-ledger observations through the unchanged authenticated report path.
    if (preLedger) app.store.transaction = work => transaction(tx => work({ ...tx, resources: { ...tx.resources, recordWorkspacePreparationProof: async proof => proof } }))
    try { await new WorkerService(app.store, new Notifications()).receive(workerId, { type: 'event', scope: 'workspace', report: { workspaceId: id, commandId, status, reason: status === 'failed' ? 'genuine protocol failure' : null, location: null, occurredAt: new Date(tick++).toISOString() as Timestamp } }) }
    finally { app.store.transaction = transaction }
  }
  const receipt = async (commandId: CommandId) => new WorkerService(app.store, new Notifications()).receive(workerId, { type: 'ack', receipt: { commandId, status: 'accepted' } })
  const proof = (id: WorkspaceId, commandId: CommandId) => app.store.resources.getWorkspacePreparationProof({ workspaceId: id, workerId, commandId })
  const retry = (id: WorkspaceId, requestId = 'retry') => call(`/workspaces/${id}/reprovision`, { workerId, requestId })
  const state = async (id: WorkspaceId) => (await call(`/workspaces/${id}`)).data
  const confirmation = async (id: WorkspaceId, requestId = 'delete') => ({ expectedRevision: (await state(id)).revision, requestId })
  const remove = async (id: WorkspaceId, body?: unknown) => call(`/workspaces/${id}`, body ?? await confirmation(id), 'DELETE')
  const placement = async (id: WorkspaceId, mutate: (p: WorkspacePlacement) => WorkspacePlacement) => app.store.transaction(async tx => {
    const current = (await tx.resources.getWorkspace(id))!
    // Drop the compatibility single-placement projection rather than accidentally restoring it.
    const { workerId: _worker, status: _status, failureReason: _reason, location: _location, provisioning: _attempt, ...logical } = current
    await tx.resources.saveWorkspace({ ...logical, placements: current.placements.map(mutate) })
  })
  return { get app() { return app }, workerId, call, create, report, receipt, proof, retry, state, confirmation, remove, placement,
    restart: async () => { await app.close(); app = createWemuxServer(options); origin = await app.listen(0) },
    close: async () => { await app.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test('DELETE backfills only current correlated proof; failed retry preserves old proof, restart and idempotency retain both attempts', async () => {
  const f = await fixture()
  try {
    const w = await f.create(); await f.receipt(w.commandId); await f.report(w.id, w.commandId, 'failed', true)
    assert.equal(await f.proof(w.id, w.commandId), null)
    const failed = await f.state(w.id), next = await f.retry(w.id)
    assert.equal(next.status, 200); assert.equal((await f.proof(w.id, w.commandId))!.status, 'failed')
    assert.equal((await f.retry(w.id)).data.commandId, next.data.commandId)
    await f.receipt(next.data.commandId); await f.report(w.id, next.data.commandId, 'ready', true)
    assert.equal(await f.proof(w.id, next.data.commandId), null)
    const ready = await f.state(w.id), body = await f.confirmation(w.id)
    const persistedReady = (await f.app.store.resources.getWorkspace(w.id))!
    assert.notEqual(ready.revision, failed.revision)
    await f.restart()
    assert.equal((await f.state(w.id)).revision, ready.revision)
    const commands = await f.app.store.commands.listWorkspaceProvisions(w.id)
    const deletions = await Promise.all([f.remove(w.id, body), f.remove(w.id, body), f.remove(w.id, body)])
    const deleted = deletions[0]
    assert.deepEqual(deletions, [deleted, deleted, deleted])
    assert.equal(deleted.status, 200); assert.equal((await f.proof(w.id, next.data.commandId))!.status, 'ready')
    assert.deepEqual((await f.state(w.id)).placements, persistedReady.placements)
    assert.deepEqual(await f.app.store.commands.listWorkspaceProvisions(w.id), commands)
    assert.equal(commands.length, 2)
    await f.restart(); assert.deepEqual(await f.remove(w.id, body), deleted)
    assert.equal((await f.remove(w.id, { ...body, expectedRevision: '0'.repeat(64) })).data.error.code, 'request_id_conflict')
    assert.equal((await f.remove(w.id, { ...body, requestId: 'other' })).status, 410)
    await f.report(w.id, next.data.commandId, 'ready')
    assert.deepEqual((await f.state(w.id)).placements, persistedReady.placements)
  } finally { await f.close() }
})

test('missing historical proof stays blocked despite accepted receipt, legacy failure, retry ready and delayed old report', async () => {
  const f = await fixture()
  try {
    const w = await f.create(); await f.receipt(w.commandId); await f.report(w.id, undefined, 'failed')
    const next = await f.retry(w.id); assert.equal(next.status, 200)
    assert.equal(await f.proof(w.id, w.commandId), null)
    await f.receipt(next.data.commandId); await f.report(w.id, next.data.commandId, 'ready', true)
    const before = await f.state(w.id)
    await f.report(w.id, w.commandId, 'failed')
    assert.equal(await f.proof(w.id, w.commandId), null)
    assert.equal((await f.remove(w.id)).status, 409)
    assert.equal(await f.proof(w.id, next.data.commandId), null, 'eligible current backfill rolls back when historical attempt is unknown')
    assert.deepEqual(await f.state(w.id), before)
    await f.restart(); assert.equal((await f.remove(w.id)).status, 409)
    const pending = await f.create(); await f.report(pending.id, pending.commandId, 'ready', true)
    assert.equal((await f.remove(pending.id)).status, 409, 'terminal proof without accepted command still blocks')
    assert.equal(await f.proof(pending.id, pending.commandId), null)
    await f.receipt(pending.commandId); assert.equal((await f.remove(pending.id)).status, 200)
  } finally { await f.close() }
})

test('strict backfill rejects wrong Worker, Workspace, command, status, timestamp and location identities without manufacturing proof', async () => {
  const f = await fixture()
  try {
    const foreign = await f.create()
    const variants: { name: string; mutate: (p: WorkspacePlacement) => WorkspacePlacement }[] = [
      { name: 'proof-worker', mutate: p => ({ ...p, provisioning: { ...p.provisioning!, terminalReport: { ...p.provisioning!.terminalReport!, workerId: 'wrong-worker' as WorkerId } } }) },
      { name: 'proof-command', mutate: p => ({ ...p, provisioning: { ...p.provisioning!, terminalReport: { ...p.provisioning!.terminalReport!, commandId: foreign.commandId } } }) },
      { name: 'foreign-workspace-command', mutate: p => ({ ...p, provisioning: { ...p.provisioning!, commandId: foreign.commandId, terminalReport: { ...p.provisioning!.terminalReport!, commandId: foreign.commandId } } }) },
      { name: 'placement-worker', mutate: p => ({ ...p, workerId: 'wrong-worker' as WorkerId, provisioning: { ...p.provisioning!, terminalReport: { ...p.provisioning!.terminalReport!, workerId: 'wrong-worker' as WorkerId } } }) },
      { name: 'terminal-status', mutate: p => ({ ...p, provisioning: { ...p.provisioning!, terminalReport: { ...p.provisioning!.terminalReport!, status: 'ready' } } }) },
      { name: 'non-terminal-status', mutate: p => ({ ...p, status: 'unhealthy' }) },
      { name: 'invalid-time', mutate: p => ({ ...p, provisioning: { ...p.provisioning!, terminalReport: { ...p.provisioning!.terminalReport!, occurredAt: 'invalid' } } }) },
      { name: 'location-workspace', mutate: p => ({ ...p, location: { workerId: p.workerId, workspaceId: foreign.id, rootPath: '/unused', checkouts: [] } }) },
      { name: 'location-worker', mutate: p => ({ ...p, location: { workerId: 'wrong-worker' as WorkerId, workspaceId: foreign.id, rootPath: '/unused', checkouts: [] } }) },
    ]
    for (const variant of variants) {
      const w = await f.create(); await f.receipt(w.commandId); await f.report(w.id, w.commandId, 'failed', true)
      await f.placement(w.id, variant.mutate)
      assert.equal((await f.remove(w.id)).status, 409, variant.name)
      assert.equal(await f.proof(w.id, w.commandId), null, variant.name)
      if (variant.name !== 'placement-worker' && variant.name !== 'non-terminal-status') {
        assert.equal((await f.retry(w.id)).status, 200, 'retry remains available for failed placement but invalid observation is not evidence')
        assert.equal(await f.proof(w.id, w.commandId), null, variant.name)
      }
    }
    assert.equal(await f.proof(foreign.id, foreign.commandId), null)
  } finally { await f.close() }
})

test('proof backfill, Workspace deletion, audit and receipt roll back together; retry backfill also rolls back', async () => {
  const f = await fixture()
  try {
    for (const action of ['workspace.delete', 'workspace.reprovision', 'delete-receipt']) {
      const w = await f.create(); await f.receipt(w.commandId); await f.report(w.id, w.commandId, 'failed', true)
      const before = await f.state(w.id), body = await f.confirmation(w.id), commands = await f.app.store.commands.listWorkspaceProvisions(w.id)
      const transaction = f.app.store.transaction.bind(f.app.store)
      f.app.store.transaction = work => transaction(tx => work({ ...tx,
        audit: { append: async entry => { await tx.audit.append(entry); if (entry.action === action) throw Error('injected transaction failure') } },
        resources: { ...tx.resources, saveCreateRequest: async (key, record) => { await tx.resources.saveCreateRequest(key, record); if (action === 'delete-receipt') throw Error('injected receipt failure after write') } },
      }))
      assert.equal((await (action === 'workspace.reprovision' ? f.retry(w.id) : f.remove(w.id, body))).status, 500)
      f.app.store.transaction = transaction
      assert.equal(await f.proof(w.id, w.commandId), null)
      assert.deepEqual(await f.state(w.id), before)
      assert.deepEqual(await f.app.store.commands.listWorkspaceProvisions(w.id), commands)
      assert.equal((await (action === 'workspace.reprovision' ? f.retry(w.id) : f.remove(w.id, body))).status, 200)
      if (action === 'delete-receipt') assert.ok((await f.state(w.id)).deletedAt, 'rolled-back receipt cannot bypass the retried deletion')
      assert.ok(await f.proof(w.id, w.commandId))
    }
  } finally { await f.close() }
})

test('proof eligibility is transactionally separate from revision, current proof is required even with ledger, auth precedes replay', async () => {
  const f = await fixture()
  try {
    const w = await f.create(); await f.receipt(w.commandId); await f.report(w.id, w.commandId, 'failed', true)
    const body = await f.confirmation(w.id), raw = (await f.app.store.resources.getWorkspace(w.id))!
    await f.app.store.transaction(tx => tx.resources.recordWorkspacePreparationProof({ workspaceId: w.id, ...raw.placements[0].provisioning!.terminalReport! }))
    assert.equal((await f.state(w.id)).revision, body.expectedRevision, 'ledger-only write does not change state equivalence')
    const transaction = f.app.store.transaction.bind(f.app.store)
    f.app.store.transaction = work => transaction(tx => work({ ...tx, resources: { ...tx.resources, getWorkspacePreparationProof: async () => null } }))
    assert.equal((await f.remove(w.id, body)).data.error.code, 'workspace_in_use', 'same confirmed revision still checks ledger eligibility inside the deletion transaction')
    f.app.store.transaction = transaction
    await f.placement(w.id, p => ({ ...p, provisioning: { ...p.provisioning!, terminalReport: undefined } }))
    assert.equal((await f.remove(w.id, body)).data.error.code, 'workspace_revision_conflict')
    assert.equal((await f.remove(w.id)).status, 409, 'historical ledger cannot stand in for missing current proof')
    await f.app.store.transaction(tx => tx.resources.saveWorkspace(raw))
    const member = await seedAdministrator(f.app.store, { userId: 'proof-manager' as never, email: 'manager@example.test', username: 'manager', token: 'manager-token' })
    await f.app.store.transaction(tx => tx.identity.saveMembership({ userId: member.userId, teamId: 'default-team' as never, role: 'member', joinedAt: new Date().toISOString() as never }))
    await f.call('/projects/default-project/grants', { userId: member.userId, role: 'manager' })
    const remove = () => f.call(`/workspaces/${w.id}`, body, 'DELETE', 'manager-token')
    assert.equal((await remove()).status, 200)
    await f.call(`/projects/default-project/grants/${member.userId}`, undefined, 'DELETE')
    assert.equal((await remove()).status, 404, 'committed receipt not exposed after authorization is revoked')
  } finally { await f.close() }
})

test('failed-attempt DELETE and reprovision races serialize without cancellation or lost proof', async () => {
  const f = await fixture()
  try {
    for (const order of ['delete-first', 'retry-first', 'concurrent'] as const) {
      const w = await f.create(); await f.receipt(w.commandId); await f.report(w.id, w.commandId, 'failed', true)
      const body = await f.confirmation(w.id)
      if (order === 'concurrent') {
        const results = await Promise.all([f.remove(w.id, body), f.retry(w.id)])
        assert.equal(results.filter(value => value.status === 200).length, 1)
        assert.ok(results.some(value => value.status === 409 || value.status === 410))
      } else {
        assert.equal((await (order === 'delete-first' ? f.remove(w.id, body) : f.retry(w.id))).status, 200)
        assert.equal((await (order === 'delete-first' ? f.retry(w.id) : f.remove(w.id, body))).status, order === 'delete-first' ? 410 : 409)
      }
      assert.equal((await f.proof(w.id, w.commandId))!.status, 'failed')
      const current = await f.state(w.id), commands = await f.app.store.commands.listWorkspaceProvisions(w.id)
      assert.equal(commands.length, current.deletedAt ? 1 : 2)
      assert.equal((await f.app.store.commands.get(w.commandId))!.status, 'accepted')
      if (!current.deletedAt) {
        const next = current.placements[0].provisioning.commandId
        await f.receipt(next); await f.report(w.id, next, 'ready')
        assert.equal((await f.remove(w.id)).status, 200)
      }
    }
  } finally { await f.close() }
})
