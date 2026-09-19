import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, ModelId } from '@wemux/domain'
import type { ServerStore, ServerStoreTx } from '../application/ports/server-store.js'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { ServerService, now } from '../application/server-service.js'
import { Notifications } from '../application/notifications.js'
import { CapabilityService } from '../application/capability-service.js'
import { CapabilityTokenService } from '../application/capability-token-service.js'
import { seedOperator } from './fixtures/administrator.js'

// Real SQLite with a transaction-boundary probe, not a mocked service.
test('creation primitives compose in one transaction; every failure rolls back without wakeups', { timeout: 5000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wemux-composition-'))
  const path = join(directory, 'server.sqlite')
  const db = new SqliteServerStore(path)
  const observer = new DatabaseSync(path)
  const auditCount = () => Number(observer.prepare("SELECT count(*) AS count FROM records WHERE kind='audit'").get()!.count)
  t.after(() => { observer.close(); db.close(); rmSync(directory, { recursive: true, force: true }) })
  let active = false, transactions = 0, failAudit = false, wakeups = 0
  const store: ServerStore = {
    tasks: db.tasks, identity: db.identity, resources: db.resources, commands: db.commands, cache: db.cache,
    async transaction<T>(work: (tx: ServerStoreTx) => Promise<T>): Promise<T> {
      assert.equal(active, false, 'nested transaction would wait forever')
      transactions++
      return db.transaction(async tx => {
        active = true
        try {
          return await work({ ...tx, audit: { append: async record => {
            await tx.audit.append(record)
            if (failAudit) throw new Error('injected audit failure')
          } } })
        } finally { active = false }
      })
    },
  }
  const notifications = new Notifications()
  const service = new ServerService(store, notifications, new CapabilityService(store, now, new CapabilityTokenService('test-secret'.repeat(4), now)))
  const { project } = await seedOperator(store, service)
  const enrolled = await service.enroll({ token: (await service.createEnrollment({})).token, name: 'test' })
  await store.transaction(tx => tx.resources.saveWorker({ ...enrolled.worker, capabilities: [{ agentKey: 'pi' as AgentKey, displayName: 'Pi', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test' as ModelId, displayName: 'Test', source: 'detected' }] }] }))
  notifications.onCommands(enrolled.workerId, () => { assert.equal(active, false); wakeups++ })
  const workspaceInput = { projectId: project!.id, workerId: enrolled.workerId, name: 'test', repository: { gitUrl: 'https://example.com/test.git' } }
  const before = transactions
  const initialAuditCount = auditCount()
  const result = await store.transaction(async tx => {
    const { workspace } = await service.createWorkspaceInTx(tx, workspaceInput)
    // Provisioning is not bypassed in production; simulate its ready report in this fixture.
    await tx.resources.saveWorkspace({ ...workspace, status: 'ready' })
    const { session } = await service.createSessionInTx(tx, { requestId: 'composed-session', workspaceId: workspace.id, title: 'test', agentKey: 'pi', modelId: 'test' })
    const message = await service.enqueueInTx(tx, session.id, { content: 'hello', commandId: 'stable' })
    const retry = await service.enqueueInTx(tx, session.id, { content: 'hello', commandId: 'stable' })
    assert.deepEqual(message, retry)
    assert.equal(wakeups, 0)
    assert.equal(auditCount(), initialAuditCount, 'separate connection sees no uncommitted audit')
    return { workspace, session }
  })
  assert.equal(transactions - before, 1)
  assert.equal((await db.commands.list({ limit: 100 })).length, 3)
  assert.equal(wakeups, 0, 'internal primitives leave notification ownership to caller')
  notifications.commands(enrolled.workerId)
  assert.equal(wakeups, 1)
  const committedAuditCount = auditCount()
  assert.equal(committedAuditCount, initialAuditCount + 4)
  for (const operation of [
    () => service.createWorkspace(workspaceInput),
    () => service.createSession({ requestId: 'failure-create', workspaceId: result.workspace.id, title: 'failure', agentKey: 'pi', modelId: 'test' }),
    () => service.enqueue(result.session.id, { content: 'failure', commandId: 'failed' }),
  ]) {
    const workspaces = await db.resources.listWorkspaces(), sessions = await db.resources.listSessions(), commands = await db.commands.list({ limit: 100 })
    failAudit = true
    await assert.rejects(operation(), /injected audit failure/)
    failAudit = false
    assert.deepEqual(await db.resources.listWorkspaces(), workspaces)
    assert.deepEqual(await db.resources.listSessions(), sessions)
    assert.deepEqual(await db.commands.list({ limit: 100 }), commands)
    assert.equal(wakeups, 1)
    assert.equal(auditCount(), committedAuditCount)
  }
  let rolledBackWorkspace: typeof result.workspace | undefined
  await assert.rejects(store.transaction(async tx => {
    const { workspace } = await service.createWorkspaceInTx(tx, workspaceInput)
    rolledBackWorkspace = workspace
    await tx.resources.saveWorkspace({ ...workspace, status: 'ready' })
    const { session } = await service.createSessionInTx(tx, { requestId: 'rollback-session', workspaceId: workspace.id, title: 'rollback', agentKey: 'pi', modelId: 'test' })
    await service.enqueueInTx(tx, session.id, { content: 'rollback' })
    throw new Error('outer failure')
  }), /outer failure/)
  assert.equal(await db.resources.getWorkspace(rolledBackWorkspace!.id), null)
  assert.equal(rolledBackWorkspace!.spec.kind, 'repository')
  if (rolledBackWorkspace!.spec.kind === 'repository') assert.equal(await db.resources.getRepository(rolledBackWorkspace!.spec.repositoryId), null)
  assert.equal(auditCount(), committedAuditCount)
  assert.equal((await db.resources.listSessions()).length, 1)
  assert.equal((await db.commands.list({ limit: 100 })).length, 3)
  assert.equal(wakeups, 1)
  const sent = await service.enqueue(result.session.id, { content: 'next', commandId: 'next' })
  assert.equal(sent.status, 'pending')
  assert.equal(wakeups, 2)
  await assert.rejects(service.enqueue(result.session.id, { content: 'changed', commandId: 'next' }), /Conflicting commandId/)
  assert.equal(wakeups, 2)
})
