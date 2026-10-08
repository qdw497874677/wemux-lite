import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { ensureLocalInstallation } from '../src/application/local-installation.js'
import { createLocalWorkbenchService } from '../src/application/local-workbench.js'
import { WorkerRuntime } from '../src/application/runtime.js'
import { LocalProvisioner } from '../src/workspaces/local-provisioner.js'
import { TestAgent } from '../src/agents/test-agent.js'
import type { CommandId, ProjectId, SessionId, WorkerId, WorkspaceId } from '@wemux/domain'
import type { WorkerToServer } from '@wemux/wire-protocol'

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition timed out')
}

test('local workbench authorizes a canonical directory and runs a durable session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-workbench-'))
  const directory = await mkdtemp(join(tmpdir(), 'wemux-authorized-directory-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const installation = ensureLocalInstallation(store, 'local-node')
  const workerId = `local-${installation.installationId}` as WorkerId
  const runtime = new WorkerRuntime(store, new LocalProvisioner(join(home, 'workspaces')), [new TestAgent(1)], { send: () => {} }, workerId, installation.name)
  try {
    await runtime.initialize()
    const workbench = createLocalWorkbenchService(store, runtime)
    const allowed = await workbench.addDirectory(directory)
    assert.equal(allowed.path, directory)
    assert.deepEqual(await workbench.listDirectories(), [allowed])
    assert.deepEqual(await workbench.addDirectory(join(directory, '.')), allowed)
    await assert.rejects(workbench.addDirectory(join(directory, 'missing')), /目录不存在或不可访问/)

    const createInput = { workspaceId: allowed.workspaceId, agentKey: 'test', modelId: 'test', requestId: 'stable-session' }
    const session = await workbench.createSession(createInput)
    assert.equal((await createLocalWorkbenchService(store, runtime).createSession(createInput)).sessionId, session.sessionId)
    await assert.rejects(workbench.createSession({ ...createInput, modelId: 'changed' }), /different payload/)
    const identity = { commandId: 'stable-command', messageId: 'stable-message' }
    const receipt = await workbench.enqueue(session.sessionId, '你好 local', identity)
    assert.deepEqual(await workbench.enqueue(session.sessionId, '你好 local', identity), receipt)
    await assert.rejects(workbench.enqueue(session.sessionId, 'changed', identity), /different payload/)
    assert.deepEqual(await workbench.supportedCommands(session.sessionId), ['compact'])
    await assert.rejects(workbench.resolveApproval(session.sessionId, 'missing', 'approve', undefined, ''), /Explicit turnId/)
    assert.equal(receipt.status, 'accepted')
    await waitFor(async () => (await workbench.journal(session.sessionId, 1, 200) as { events: readonly { payload: { kind: string } }[] }).events.some(event => event.payload.kind === 'turn.finished'))
    const page = await workbench.journal(session.sessionId, 1, 200) as { events: readonly { payload: { kind: string; text?: string; outcome?: string } }[] }
    assert.ok(page.events.some(event => event.payload.kind === 'message.queued'))
    assert.ok(page.events.some(event => event.payload.kind === 'assistant.text.delta' && event.payload.text?.includes('Echo')))
    assert.ok(page.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed'))
    assert.equal(page.events.filter(event => event.payload.kind === 'message.queued').length, 1)
    assert.deepEqual(await workbench.queue(session.sessionId), [])
    assert.deepEqual(await workbench.approvals(session.sessionId), [])
    const recent = await workbench.journal(session.sessionId, 0, 2)
    assert.equal(recent.events.length, 2)
    assert.ok(recent.events[0].seq > 1)
    const older = await workbench.journal(session.sessionId, 1, Number(recent.events[0].seq) - 1)
    assert.equal(older.events.length + recent.events.length, page.events.length)
    await workbench.deleteSession(session.sessionId)
    assert.deepEqual(await workbench.listSessions(), [])
  } finally {
    await runtime.shutdown()
    store.close()
    await Promise.all([rm(home, { recursive: true, force: true }), rm(directory, { recursive: true, force: true })])
  }
})

test('dual-host runtime rejects cross-scope commands and never publishes local state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-dual-host-'))
  const localDirectory = await mkdtemp(join(tmpdir(), 'wemux-local-scope-'))
  const clusterDirectory = await mkdtemp(join(tmpdir(), 'wemux-cluster-scope-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const installation = ensureLocalInstallation(store, 'dual-host')
  const clusterWorkerId = 'cluster-worker' as WorkerId
  const sent: WorkerToServer[] = []
  const runtime = new WorkerRuntime(store, new LocalProvisioner(join(home, 'workspaces')), [new TestAgent(1)], { send: message => sent.push(message) }, clusterWorkerId, 'dual-host')
  try {
    await runtime.initialize()
    const workbench = createLocalWorkbenchService(store, runtime)
    const local = await workbench.addDirectory(localDirectory)
    const localSession = await workbench.createSession({ workspaceId: local.workspaceId, agentKey: 'test', modelId: 'test' })
    await workbench.enqueue(localSession.sessionId, 'local secret')
    await waitFor(async () => (await workbench.journal(localSession.sessionId, 1, 200)).events.some(event => event.payload.kind === 'turn.finished'))

    const clusterWorkspaceId = 'cluster-workspace' as WorkspaceId
    const clusterSessionId = 'cluster-session' as SessionId
    await store.transaction(async tx => {
      await tx.workspaces.save({ id: clusterWorkspaceId, workerId: clusterWorkerId, projectId: 'cluster-project' as ProjectId, spec: { kind: 'composite', memberWorkspaceIds: [] }, rootPath: clusterDirectory, status: 'ready', failureReason: null, updatedAt: new Date().toISOString() as import('@wemux/domain').Timestamp })
      await tx.sessions.createSession(clusterSessionId, { workspaceId: clusterWorkspaceId, agent: { workerId: clusterWorkerId, agentKey: 'test' }, modelId: 'test' })
    })

    await assert.rejects(workbench.journal(clusterSessionId, 1, 20), /本地会话不存在/)
    await assert.rejects(workbench.queue(clusterSessionId), /本地会话不存在/)
    await assert.rejects(workbench.approvals(clusterSessionId), /本地会话不存在/)
    await assert.rejects(workbench.resolveApproval(clusterSessionId, 'a', 'approve', undefined, 'turn'), /本地会话不存在/)
    await assert.rejects(workbench.command(clusterSessionId, 'compact'), /本地会话不存在/)
    const localAgainstCluster = await runtime.executeLocal('local-cross-scope' as CommandId, { kind: 'session.enqueue', sessionId: clusterSessionId, message: { messageId: 'local-cross-message' as import('@wemux/domain').MessageId, content: 'blocked' } })
    assert.equal(localAgainstCluster.status, 'rejected')

    await runtime.receive({ messageId: 'server-message' as import('@wemux/domain').MessageId, sentAt: new Date().toISOString() as import('@wemux/domain').Timestamp, type: 'command', commandId: 'cluster-cross-scope' as CommandId, command: { kind: 'session.enqueue', sessionId: localSession.sessionId, message: { messageId: 'cluster-cross-message' as import('@wemux/domain').MessageId, content: 'blocked' } } })
    await runtime.connected()
    const serialized = JSON.stringify(sent)
    assert.equal(serialized.includes(localSession.sessionId), false)
    assert.equal(serialized.includes(local.workspaceId), false)
    assert.equal(serialized.includes('local secret'), false)
    assert.ok(sent.some(message => message.type === 'sync' && message.kind === 'heads' && message.complete))
  } finally {
    await runtime.shutdown()
    store.close()
    await Promise.all([rm(home, { recursive: true, force: true }), rm(localDirectory, { recursive: true, force: true }), rm(clusterDirectory, { recursive: true, force: true })])
  }
})

test('local queue, approval and compact commands use authoritative state and stable identities', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-local-controls-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const installation = ensureLocalInstallation(store, 'controls')
  const workerId = `local-${installation.installationId}` as WorkerId
  const sessionId = 'controls-session' as SessionId
  const workspaceId = 'controls-workspace' as WorkspaceId
  const timestamp = new Date().toISOString() as import('@wemux/domain').Timestamp
  const seen = new Map<string, string>()
  const commands: import('@wemux/wire-protocol').WorkerCommand[] = []
  const runtime = { executeLocal: async (commandId: CommandId, command: import('@wemux/wire-protocol').WorkerCommand) => {
    const fingerprint = JSON.stringify(command)
    if (seen.has(commandId)) {
      assert.equal(seen.get(commandId), fingerprint)
      return { commandId, status: 'accepted' as const }
    }
    seen.set(commandId, fingerprint); commands.push(command)
    await store.transaction(async tx => {
      await tx.commands.record({ commandId, command, payloadFingerprint: fingerprint }, { commandId, status: 'accepted' })
      await tx.commands.setExecutionState({ commandId, state: 'completed', result: null, updatedAt: timestamp })
      if (command.kind === 'session.cancel-queued') await tx.sessions.cancelQueued(command.sessionId, command.submissionCommandId)
      if (command.kind === 'runtime.approval.resolve') await tx.appendJournal(command.sessionId, [{ occurredAt: timestamp, payload: { kind: 'approval.resolved', turnId: command.turnId, approvalId: command.approvalId, decision: command.decision } }])
    })
    return { commandId, status: 'accepted' as const }
  } }
  try {
    store.saveCapabilities([{ agentKey: 'pi', displayName: 'Pi', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test', displayName: 'test', source: 'detected' }], version: null }])
    await store.transaction(async tx => {
      await tx.workspaces.save({ id: workspaceId, workerId, projectId: 'local' as ProjectId, spec: { kind: 'composite', memberWorkspaceIds: [] }, rootPath: home, status: 'ready', failureReason: null, updatedAt: timestamp })
      await tx.sessions.createSession(sessionId, { workspaceId, agent: { workerId, agentKey: 'pi' }, modelId: 'test' })
      for (const id of ['first', 'second']) await tx.sessions.enqueue({ sessionId, submissionCommandId: id as CommandId, message: { messageId: id as import('@wemux/domain').MessageId, content: id }, queuedAt: timestamp })
      const turn = await tx.sessions.claimNext(sessionId)
      await tx.appendJournal(sessionId, [{ occurredAt: timestamp, payload: { kind: 'approval.requested', turnId: turn!.id, approvalId: 'approval' as import('@wemux/domain').ApprovalId, action: { tool: 'shell' } } }])
    })
    const service = createLocalWorkbenchService(store, runtime)
    assert.deepEqual((await service.queue(sessionId)).map(item => item.message.content), ['second'])
    await service.cancelQueued(sessionId, 'second')
    assert.deepEqual(await service.queue(sessionId), [])
    assert.equal((await service.approvals(sessionId)).length, 1)
    const turnId = (await store.sessions.get(sessionId))!.activeTurnId!
    await service.resolveApproval(sessionId, 'approval', 'approve', 'first-attempt', turnId)
    await service.resolveApproval(sessionId, 'approval', 'approve', 'first-attempt', turnId)
    assert.equal(commands.filter(command => command.kind === 'runtime.approval.resolve').length, 1)
    assert.deepEqual(await service.approvals(sessionId), [])
    assert.deepEqual(await service.supportedCommands(sessionId), ['compact'])
    await service.command(sessionId, 'compact', 'compact-id')
    await service.command(sessionId, 'compact', 'compact-id')
    assert.equal(commands.filter(command => command.kind === 'runtime.command').length, 1)
    await assert.rejects(service.command(sessionId, 'set_model'), /不支持/)
  } finally { store.close(); await rm(home, { recursive: true, force: true }) }
})
