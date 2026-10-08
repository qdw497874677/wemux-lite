import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandId, ProjectId, TeamId, Timestamp, UserId, WorkerId, WorkspaceId, WorkspaceStatus } from '@wemux/domain'
import type { Workspace } from '@wemux/server-domain'
import type { WorkspacePreparationProof } from '../application/ports/workspace-preparation-proof.ts'
import type { ServerResourceWriter } from '../application/ports/server-store-types.ts'
import { WorkerService } from '../application/worker-service.ts'
import { Notifications } from '../application/notifications.ts'
import { workspaceRevision } from '../application/workspace-revision.ts'
import { SqliteServerStore } from '../storage/sqlite/store.ts'

const workspaceId = 'proof-workspace' as WorkspaceId, workerId = 'proof-worker' as WorkerId
const commandId = 'proof-command' as CommandId, at = '2026-01-01T00:00:00.000Z' as Timestamp
const identity = { workspaceId, workerId, commandId }
const proof: WorkspacePreparationProof = { ...identity, status: 'failed', occurredAt: at }
const later = '2026-01-02T00:00:00.000Z' as Timestamp

async function fixture(path = ':memory:') {
  const store = new SqliteServerStore(path)
  const reports = new WorkerService(store, new Notifications())
  const workspace: Workspace = { id: workspaceId, projectId: 'proof-project' as ProjectId, name: 'Preparation proof', spec: { kind: 'composite', memberWorkspaceIds: [] }, deletedAt: null, placements: [] }
  const attempt = async (id: CommandId, replacedAttempt = false) => store.transaction(async tx => {
    await tx.commands.insertPending({ commandId: id, workerId, createdAt: at, payloadFingerprint: id, command: { kind: 'workspace.provision', workspace: { workspace, repositories: [] } } })
    await tx.resources.saveWorkspace({ ...workspace, placements: [{ workerId, status: 'stopped', failureReason: null, location: null, provisioning: { commandId: id, startedAt: at, requests: {}, replacedAttempt } }] })
  })
  await store.transaction(tx => tx.resources.saveWorker({ id: workerId, teamId: 'team' as TeamId, ownerId: 'owner' as UserId, name: 'Worker', shareScope: 'owner-only', connectionState: 'online', version: null, platform: null, capabilities: [], lastSeenAt: null }))
  await attempt(commandId)
  const report = (status: WorkspaceStatus = 'failed', id: CommandId | undefined = commandId, occurredAt = at, sender = workerId) => reports.receive(sender, { type: 'event', scope: 'workspace', report: { workspaceId, commandId: id, status, reason: status === 'failed' ? 'failure' : null, location: null, occurredAt } })
  const receipt = (id = commandId) => reports.receive(workerId, { type: 'ack', receipt: { commandId: id, status: 'accepted' } })
  return { store, reports, attempt, report, receipt }
}

test('preparation proof captures both report/receipt orders, retains first observation and survives retry/restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preparation-proof-'))
  const path = join(root, 'store.sqlite'), f = await fixture(path)
  let store = f.store
  try {
    await f.report()
    assert.deepEqual(await store.resources.getWorkspacePreparationProof(identity), proof)
    assert.equal((await store.commands.get(commandId))!.status, 'pending', 'report does not infer receipt')
    await f.receipt(); await f.receipt(); await f.report(); await f.report('failed', commandId, later)
    assert.deepEqual(await store.resources.getWorkspacePreparationProof(identity), proof, 'duplicate/later reports do not overwrite first evidence')
    assert.equal((await store.resources.getWorkspace(workspaceId))!.placements[0].provisioning?.terminalReport?.occurredAt, later, 'current placement compatibility still advances')
    const nextId = 'next-command' as CommandId
    await f.attempt(nextId, true)
    assert.equal((await store.resources.getWorkspace(workspaceId))!.placements[0].provisioning?.terminalReport, undefined)
    await f.report('ready', commandId, later)
    assert.deepEqual(await store.resources.getWorkspacePreparationProof(identity), proof, 'superseded report does not mutate historical evidence')
    await f.receipt(nextId)
    assert.equal(await store.resources.getWorkspacePreparationProof({ ...identity, commandId: nextId }), null)
    await f.report('ready', nextId, later)
    store.close(); store = new SqliteServerStore(path)
    assert.deepEqual(await store.resources.getWorkspacePreparationProof(identity), proof)
    assert.deepEqual(await store.resources.getWorkspacePreparationProof({ ...identity, commandId: nextId }), { ...identity, commandId: nextId, status: 'ready', occurredAt: later })
    assert.equal((await store.resources.getWorkspace(workspaceId))!.placements[0].provisioning?.terminalReport?.commandId, nextId)
  } finally { store.close(); await rm(root, { recursive: true, force: true }) }
})

test('legacy, stale, unknown, superseded, receipt-only and disconnected observations never manufacture proof', async () => {
  const f = await fixture()
  try {
    await f.receipt()
    await f.report('provisioning')
    await f.reports.disconnected(workerId)
    assert.equal(await f.store.resources.getWorkspacePreparationProof(identity), null)
    // Omit commandId explicitly: default arguments in report() would supply it.
    await f.reports.receive(workerId, { type: 'event', scope: 'workspace', report: { workspaceId, status: 'failed', reason: 'legacy', location: null, occurredAt: later } })
    await f.report('failed', commandId, at)
    assert.equal(await f.store.resources.getWorkspacePreparationProof(identity), null, 'stale correlated result cannot upgrade a newer legacy observation')
    const next = 'replacement' as CommandId
    await f.attempt(next, true)
    await f.report('failed', commandId, later)
    await f.report('ready', 'unknown-command' as CommandId, later)
    await f.reports.receive(workerId, { type: 'event', scope: 'workspace', report: { workspaceId, status: 'ready', reason: null, location: null, occurredAt: later } })
    assert.equal(await f.store.resources.getWorkspacePreparationProof(identity), null)
    assert.equal(await f.store.resources.getWorkspacePreparationProof({ ...identity, commandId: next }), null)
    await f.reports.receive(workerId, { type: 'ack', receipt: { commandId: next, status: 'rejected', error: { code: 'invalid-input', message: 'refused', retryable: false } } })
    assert.equal(await f.store.resources.getWorkspacePreparationProof({ ...identity, commandId: next }), null)
    const current = (await f.store.resources.getWorkspace(workspaceId))!
    await f.store.transaction(tx => tx.resources.saveWorkspace({ ...current, deletedAt: later }))
    await f.report('failed', next, later)
    assert.equal(await f.store.resources.getWorkspacePreparationProof({ ...identity, commandId: next }), null, 'tombstone report ignored')
  } finally { f.store.close() }
})

test('preparation observations reject worker/location/command ownership mismatch and revoked workers', async () => {
  const f = await fixture()
  try {
    const other = 'other-worker' as WorkerId
    await f.store.transaction(async tx => { const worker = (await tx.resources.getWorker(workerId))!; await tx.resources.saveWorker({ ...worker, id: other }) })
    await assert.rejects(f.report('ready', commandId, at, other), /ownership/)
    await assert.rejects(f.reports.receive(workerId, { type: 'event', scope: 'workspace', report: { workspaceId, commandId, status: 'ready', reason: null, location: { workerId: other, workspaceId, rootPath: '/fixture', checkouts: [] }, occurredAt: at } }), /ownership/)
    await f.store.transaction(async tx => {
      const current = (await tx.resources.getWorkspace(workspaceId))!
      await tx.resources.saveWorkspace({ ...current, provisioning: { ...current.placements[0].provisioning!, commandId: 'missing-command' }, placements: current.placements.map(p => ({ ...p, provisioning: { ...p.provisioning!, commandId: 'missing-command' } })) })
    })
    await assert.rejects(f.report('ready', 'missing-command' as CommandId), /command ownership/)
    await f.store.transaction(async tx => { const worker = (await tx.resources.getWorker(workerId))!; await tx.resources.saveWorker({ ...worker, connectionState: 'revoked' }) })
    await assert.rejects(f.report(), /Worker revoked/)
    assert.equal(await f.store.resources.getWorkspacePreparationProof(identity), null)
  } finally { f.store.close() }
})

test('proof and placement roll back together after a placement write fails; retry succeeds once', async () => {
  const f = await fixture(), transaction = f.store.transaction.bind(f.store)
  try {
    const before = await f.store.resources.getWorkspace(workspaceId), workerBefore = await f.store.resources.getWorker(workerId)
    f.store.transaction = work => transaction(tx => work({ ...tx, resources: { ...tx.resources, saveWorkspace: async workspace => { await tx.resources.saveWorkspace(workspace); throw Error('injected placement failure') } } }))
    await assert.rejects(f.report(), /injected placement failure/)
    assert.equal(await f.store.resources.getWorkspacePreparationProof(identity), null)
    assert.deepEqual(await f.store.resources.getWorkspace(workspaceId), before)
    assert.deepEqual(await f.store.resources.getWorker(workerId), workerBefore)
    f.store.transaction = transaction
    await f.report()
    assert.deepEqual(await f.store.resources.getWorkspacePreparationProof(identity), proof)
  } finally { f.store.close() }
})

test('conflicting stored proof rejects observation and rolls back placement and worker activity', async () => {
  const f = await fixture()
  try {
    await f.store.transaction(tx => tx.resources.recordWorkspacePreparationProof({ ...proof, status: 'ready' }))
    const before = await f.store.resources.getWorkspace(workspaceId), workerBefore = await f.store.resources.getWorker(workerId)
    await assert.rejects(f.report(), /Conflicting/)
    assert.deepEqual(await f.store.resources.getWorkspace(workspaceId), before)
    assert.deepEqual(await f.store.resources.getWorker(workerId), workerBefore)
    assert.equal((await f.store.resources.getWorkspacePreparationProof(identity))!.status, 'ready')
  } finally { f.store.close() }
})

test('store proof is insert-only, command-owned, transaction-leased and excluded from workspaceRevision', async () => {
  const f = await fixture()
  try {
    const before = (await f.store.resources.getWorkspace(workspaceId))!, revision = workspaceRevision(before)
    let escaped: ServerResourceWriter['recordWorkspacePreparationProof'] | undefined
    await assert.rejects(f.store.transaction(async tx => { await tx.resources.recordWorkspacePreparationProof(proof); throw Error('rollback') }), /rollback/)
    assert.equal(await f.store.resources.getWorkspacePreparationProof(identity), null)
    await Promise.all([at, later].map(occurredAt => f.store.transaction(async tx => { escaped = tx.resources.recordWorkspacePreparationProof; return tx.resources.recordWorkspacePreparationProof({ ...proof, occurredAt }) })))
    assert.deepEqual(await f.store.resources.getWorkspacePreparationProof(identity), proof)
    await assert.rejects(escaped!(proof), /no longer active/)
    await assert.rejects(f.store.transaction(tx => tx.resources.recordWorkspacePreparationProof({ ...proof, status: 'ready' })), /Conflicting/)
    for (const changed of [{ workerId: 'other' as WorkerId }, { workspaceId: 'other' as WorkspaceId }, { commandId: 'unknown' }]) {
      await assert.rejects(f.store.transaction(tx => tx.resources.recordWorkspacePreparationProof({ ...proof, ...changed })), /ownership/)
    }
    await assert.rejects(f.store.resources.getWorkspacePreparationProof({ ...identity, workspaceId: 'other' as WorkspaceId }), /conflicting/)
    assert.deepEqual(await f.store.resources.getWorkspacePreparationProof(identity), proof)
    assert.equal(workspaceRevision((await f.store.resources.getWorkspace(workspaceId))!), revision)
    assert.deepEqual(await f.store.resources.getWorkspace(workspaceId), before)
    await assert.rejects(f.store.transaction(async tx => { await tx.resources.saveWorkspace({ ...before, name: 'rollback on conflict' }); await tx.resources.recordWorkspacePreparationProof({ ...proof, status: 'ready' }) }), /Conflicting/)
    assert.deepEqual(await f.store.resources.getWorkspace(workspaceId), before)
    await assert.rejects(f.store.transaction(tx => tx.resources.recordWorkspacePreparationProof({ ...proof, occurredAt: 'not-a-time' })), /Invalid/)
    await f.store.putRecord('workspace-preparation-proof', commandId, { ...proof, workerId: 'corrupt-worker' })
    await assert.rejects(f.store.resources.getWorkspacePreparationProof(identity), /corrupt/)
    await assert.rejects(f.store.transaction(tx => tx.resources.recordWorkspacePreparationProof(proof)), /corrupt/)
  } finally { f.store.close() }
})
