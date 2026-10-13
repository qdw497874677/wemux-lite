import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { CommandId, SessionId, Timestamp, WorkerId, WorkspaceProvisionSpec } from '@wemux/domain'
import type { WorkerCommand, WorkerPayload } from '@wemux/wire-protocol'
import { authorizationBytes, type EnqueueAuthorization, type SignedEnqueueAuthorization } from '@wemux/wire-protocol/command-assertion'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { WorkerRuntime } from '../src/application/runtime.js'
import { TestAgent } from '../src/agents/test-agent.js'
import { LocalProvisioner } from '../src/workspaces/local-provisioner.js'

const workerId = 'worker' as WorkerId
const sessionId = 'session' as SessionId
const projectId = 'project' as never
const binding = { workspaceId: 'workspace' as never, agent: { workerId, agentKey: 'test' as const }, modelId: 'test' as never }
const provision: WorkerCommand = { kind: 'workspace.provision', workspace: { workspace: { id: binding.workspaceId, workerId, projectId, name: 'test', spec: { kind: 'composite', memberWorkspaceIds: [] }, status: 'pending', failureReason: null }, repositories: [] } as WorkspaceProvisionSpec }
const provisionB: WorkerCommand = { kind: 'workspace.provision', workspace: { workspace: { ...(provision.workspace as WorkspaceProvisionSpec).workspace, id: 'workspace-b' as never }, repositories: [] } as WorkspaceProvisionSpec }

async function until(predicate: () => boolean | Promise<boolean>) { for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) } assert.fail('Timed out') }

interface Harness {
  store: SqliteWorkerStore
  runtime: WorkerRuntime
  events: WorkerPayload[]
  keys: ReturnType<typeof generateKeyPairSync>
  keyId: string
  online: { allowed: boolean; checks: number }
  send(id: string, command: WorkerCommand, authorization?: SignedEnqueueAuthorization): Promise<unknown>
  signed(id: string, command: WorkerCommand, overrides?: Partial<EnqueueAuthorization>): SignedEnqueueAuthorization
  restart(online: boolean): Promise<void>
  dispose(): Promise<void>
}

async function harness(home: string, options: { pin?: boolean } = {}): Promise<Harness> {
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const keyId = createHash('sha256').update(publicKey).digest('hex')
  const pin = options.pin !== false
  if (pin) store.saveIdentity({ workerId, serverUrl: 'ws://localhost/worker/ws', credentialRef: 'credential', enrolledAt: new Date().toISOString() as Timestamp, commandSigningKey: { keyId, publicKey } })
  else store.saveIdentity({ workerId, serverUrl: 'ws://localhost/worker/ws', credentialRef: 'credential', enrolledAt: new Date().toISOString() as Timestamp })
  const events: WorkerPayload[] = []
  const online = { allowed: false, checks: 0 }
  const makeRuntime = () => new WorkerRuntime(store, new LocalProvisioner(join(home, 'workspaces')), [new TestAgent(1)], { send: event => events.push(event) }, workerId, 'test', undefined, undefined, undefined, null, undefined, undefined, undefined, async () => { online.checks++; return online.allowed })
  let runtime = makeRuntime()
  const send = (id: string, command: WorkerCommand, authorization?: SignedEnqueueAuthorization) => runtime.receive({ type: 'command', commandId: id as CommandId, command, ...(authorization ? { authorization } : {}) })
  const signed = (id: string, command: WorkerCommand, overrides: Partial<EnqueueAuthorization> = {}): SignedEnqueueAuthorization => {
    const claims: EnqueueAuthorization = {
      version: 3,
      kind: command.kind,
      keyId,
      commandId: id as CommandId,
      workerId,
      sessionId: command.kind === 'session.create' ? command.session.sessionId : 'sessionId' in command ? command.sessionId : null,
      projectId,
      workspaceId: command.kind === 'session.create' ? command.session.binding.workspaceId : command.kind === 'workspace.provision' ? command.workspace.workspace.id : 'sessionId' in command ? binding.workspaceId : null,
      taskId: null,
      actorId: (command.kind === 'session.enqueue' ? command.message.sentByAccountId : command.kind === 'runtime.approval.resolve' ? command.decidedByAccountId : 'actor') as never,
      actorAuthVersion: 1,
      commandDigest: createHash('sha256').update(JSON.stringify(command)).digest('hex'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      ...overrides,
    }
    return { claims, signature: sign(null, authorizationBytes(claims), keys.privateKey).toString('base64url') }
  }
  return {
    store, get runtime() { return runtime }, events, keys, keyId, online, send, signed,
    async restart(onlineAllowed: boolean) {
      await runtime.shutdown()
      online.allowed = onlineAllowed
      runtime = makeRuntime()
      await runtime.initialize()
    },
    async dispose() { await runtime.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) },
  }
}

async function seedReadyWorkspace(h: Harness, workspaceId = binding.workspaceId) {
  const definition = (workspaceId === binding.workspaceId ? provision : provisionB).workspace.workspace
  await h.store.transaction(tx => tx.workspaces.save({ ...definition, rootPath: join(tmpdir(), 'unused'), status: 'ready', updatedAt: new Date().toISOString() as Timestamp } as never))
}

test('unsigned cluster side-effect commands are rejected without local effect and audited', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-t02-frame-'))
  const h = await harness(home)
  try {
    await h.runtime.initialize()
    await seedReadyWorkspace(h)
    await h.store.transaction(tx => tx.sessions.createSession(sessionId, binding))
    const commands: WorkerCommand[] = [
      provisionB,
      { kind: 'session.create', session: { sessionId: 'new-session' as never, binding: { workspaceId: binding.workspaceId, agent: { workerId, agentKey: 'test' as const }, modelId: 'test' as never } } },
      { kind: 'turn.stop', sessionId, turnId: 'turn-1' as never },
      { kind: 'session.cancel-queued', sessionId, submissionCommandId: 'other' as never },
      { kind: 'session.delete', sessionId },
      { kind: 'runtime.command', sessionId, operationId: 'op-1' as never, name: 'compact', arguments: {} },
      { kind: 'connector.definition.sync', requestId: 'req-1', definition: { projectId, id: 'connector-1' as never, revision: 1, allowedWorkerIds: [workerId] } as never },
    ]
    for (const [index, command] of commands.entries()) {
      const receipt = await h.send(`unsigned-${index}`, command) as { status: string }
      assert.equal(receipt.status, 'rejected', command.kind)
      assert.equal(await h.store.commands.get(`unsigned-${index}` as CommandId), null, command.kind)
    }
    assert.equal(await h.store.sessions.get('new-session' as SessionId), null)
    assert.equal(await h.store.workspaces.get('workspace-b' as never), null)
    const denials = await h.store.listAuthorizationDenials()
    assert.deepEqual(denials.map(item => item.reason), commands.map(() => 'authorization_missing'))
    assert.deepEqual(denials.map(item => item.stage), commands.map(() => 'receive'))
    assert.deepEqual([...new Set(denials.map(item => item.kind))].sort(), [...new Set(commands.map(command => command.kind))].sort())
    // The rejection receipt carries no internals.
    const events = h.events.filter(event => event.type === 'ack') as { receipt: { error: { message: string } } }[]
    assert.ok(events.every(event => event.receipt.error.message === 'Command authorization unavailable'))
  } finally { await h.dispose() }
})

test('tampered, wrong-audience, wrong-scope and expired assertions are rejected fail-closed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-t02-frame-'))
  const h = await harness(home)
  try {
    await h.runtime.initialize()
    await seedReadyWorkspace(h)
    await h.store.transaction(tx => tx.sessions.createSession(sessionId, binding))
    const stop: WorkerCommand = { kind: 'turn.stop', sessionId, turnId: 'turn-1' as never }
    // Tampered: valid signature over claims that no longer match the payload bytes.
    const tampered = h.signed('tampered', stop)
    await h.send('tampered', stop, { ...tampered, claims: { ...tampered.claims, workerId: 'another-worker' as WorkerId } })
    assert.equal(await h.store.commands.get('tampered' as CommandId), null)
    // Forged signature.
    const forgedKeys = generateKeyPairSync('ed25519')
    const forgedClaims = h.signed('forged', stop).claims
    await h.send('forged', stop, { claims: forgedClaims, signature: sign(null, authorizationBytes(forgedClaims), forgedKeys.privateKey).toString('base64url') })
    assert.equal(await h.store.commands.get('forged' as CommandId), null)
    // Wrong command kind bound in claims.
    const wrongKind = h.signed('wrong-kind', stop)
    await h.send('wrong-kind', stop, { ...wrongKind, claims: { ...wrongKind.claims, kind: 'session.enqueue' } })
    assert.equal(await h.store.commands.get('wrong-kind' as CommandId), null)
    // Wrong scope: claims reference another workspace for a session.create.
    const create: WorkerCommand = { kind: 'session.create', session: { sessionId: 'new-session' as never, binding } }
    const wrongScope = h.signed('wrong-scope', create)
    await h.send('wrong-scope', create, { ...wrongScope, claims: { ...wrongScope.claims, workspaceId: 'workspace-other' as never } })
    assert.equal(await h.store.sessions.get('new-session' as SessionId), null)
    // Expired window at receive.
    const expired = h.signed('expired-stop', stop)
    await h.send('expired-stop', stop, { ...expired, claims: { ...expired.claims, issuedAt: new Date(Date.now() - 360000).toISOString(), expiresAt: new Date(Date.now() - 300000).toISOString() } })
    assert.equal(await h.store.commands.get('expired-stop' as CommandId), null)
    // Legacy assertion versions are not accepted for other kinds.
    const v1 = h.signed('legacy-v1', stop)
    await h.send('legacy-v1', stop, { ...v1, claims: { ...v1.claims, version: 1, kind: undefined } })
    assert.equal(await h.store.commands.get('legacy-v1' as CommandId), null)
    const denials = await h.store.listAuthorizationDenials()
    assert.deepEqual(denials.map(item => item.reason).sort(), ['authorization_expired', 'authorization_invalid', 'authorization_invalid', 'authorization_invalid', 'authorization_invalid', 'authorization_invalid'])
  } finally { await h.dispose() }
})

test('unknown cluster command kind fails closed at the entrance', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-t02-frame-'))
  const h = await harness(home)
  try {
    await h.runtime.initialize()
    const receipt = await h.send('trojan', { kind: 'trojan.horse', payload: 'x' } as never as WorkerCommand) as { status: string; error: { message: string } }
    assert.equal(receipt.status, 'rejected')
    assert.equal(receipt.error.message, 'Command authorization unavailable')
    assert.equal(await h.store.commands.get('trojan' as CommandId), null)
    const denials = await h.store.listAuthorizationDenials()
    assert.equal(denials.length, 1)
    assert.equal(denials[0].reason, 'unknown_command_kind')
    assert.equal(denials[0].kind, 'trojan.horse')
  } finally { await h.dispose() }
})

test('signed cluster commands execute and the enqueue launch still needs the online check', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-t02-frame-'))
  const h = await harness(home)
  try {
    await h.runtime.initialize()
    await seedReadyWorkspace(h)
    await h.store.transaction(tx => tx.sessions.createSession(sessionId, binding))
    // session.create executes with a valid v3 assertion.
    const create: WorkerCommand = { kind: 'session.create', session: { sessionId: 'created' as never, binding } }
    const created = await h.send('create-session', create, h.signed('create-session', create)) as { status: string }
    assert.equal(created.status, 'accepted')
    assert.ok(await h.store.sessions.get('created' as SessionId))
    // session.enqueue v3 queues and defers to the online launch check.
    const enqueue: WorkerCommand = { kind: 'session.enqueue', sessionId: 'created' as never, message: { messageId: 'm1' as never, content: 'hi', sentByAccountId: 'actor' as never } }
    const queued = await h.send('enqueue-v3', enqueue, h.signed('enqueue-v3', enqueue)) as { status: string }
    assert.equal(queued.status, 'accepted')
    await until(async () => (await h.store.sessions.listQueued('created' as SessionId)).length === 1)
    assert.equal(h.online.allowed, false)
    assert.equal((await h.store.sessions.get('created' as SessionId))?.activeTurnId, null)
    h.online.allowed = true
    await h.runtime.connected()
    await until(async () => (await h.store.sessions.get('created' as SessionId))?.activeTurnId !== null)
    await until(async () => (await h.store.sessions.listQueued('created' as SessionId)).length === 0)
    // The Turn finishes asynchronously; wait for it to go idle before deleting.
    await until(async () => (await h.store.sessions.get('created' as SessionId))?.activeTurnId === null)
    // session.delete executes with a valid v3 assertion.
    const del: WorkerCommand = { kind: 'session.delete', sessionId: 'created' as never }
    const deleted = await h.send('delete-session', del, h.signed('delete-session', del)) as { status: string }
    assert.equal(deleted.status, 'accepted')
    assert.equal(await h.store.sessions.get('created' as SessionId), null)
    assert.equal((await h.store.listAuthorizationDenials()).length, 0)
  } finally { await h.dispose() }
})

test('provisioning waits for online authorization, defers offline, and recovers after restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-t02-frame-'))
  const h = await harness(home)
  try {
    await h.runtime.initialize()
    // Signed provision accepted durably, but the online check denies the side effect.
    const accepted = await h.send('provision-1', provision, h.signed('provision-1', provision)) as { status: string }
    assert.equal(accepted.status, 'accepted')
    const acceptedRecord = await h.store.commands.get('provision-1' as CommandId)
    assert.equal(acceptedRecord?.state, 'accepted')
    assert.ok(acceptedRecord?.authorization)
    assert.equal(await h.store.workspaces.get(binding.workspaceId), null)
    // Restart with the Server online: recovery re-checks and provisions.
    await h.restart(true)
    await until(async () => (await h.store.workspaces.get(binding.workspaceId))?.status === 'ready')
    assert.equal((await h.store.commands.get('provision-1' as CommandId))?.state, 'completed')
    // Offline deferral: online check fails, no provisioning side effect.
    h.online.allowed = false
    await h.send('provision-b', provisionB, h.signed('provision-b', provisionB))
    await until(() => h.online.checks > 0)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(await h.store.workspaces.get('workspace-b' as never), null)
    // Reconnection is a bounded event: once online, the deferred provision starts.
    h.online.allowed = true
    await h.runtime.connected()
    await until(async () => (await h.store.workspaces.get('workspace-b' as never))?.status === 'ready')
    assert.equal((await h.store.listAuthorizationDenials()).length, 0)
  } finally { await h.dispose() }
})

test('restart recovery does not provision unsigned or unverifiable commands', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-t02-frame-'))
  const h = await harness(home)
  try {
    // Unsigned historical provision record: must not start, audited as missing.
    await h.store.transaction(async tx => {
      await tx.commands.record({ commandId: 'legacy-provision' as CommandId, command: provisionB, payloadFingerprint: 'legacy' }, { commandId: 'legacy-provision' as CommandId, status: 'accepted' })
    })
    // Signed with a foreign key: must not start, audited as invalid.
    const foreign = generateKeyPairSync('ed25519')
    const foreignPublic = foreign.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const provisionC: WorkerCommand = { kind: 'workspace.provision', workspace: { workspace: { ...(provision.workspace as WorkspaceProvisionSpec).workspace, id: 'workspace-c' as never }, repositories: [] } as WorkspaceProvisionSpec }
    const claims = h.signed('foreign-provision', provisionC).claims
    const authorization = { claims, signature: sign(null, authorizationBytes(claims), foreign.privateKey).toString('base64url') }
    await h.store.transaction(async tx => {
      await tx.commands.record({ commandId: 'foreign-provision' as CommandId, command: provisionC, payloadFingerprint: 'foreign', authorization }, { commandId: 'foreign-provision' as CommandId, status: 'accepted' })
    })
    await h.runtime.initialize()
    h.online.allowed = true
    await h.runtime.connected()
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(await h.store.workspaces.get('workspace-b' as never), null)
    assert.equal(await h.store.workspaces.get('workspace-c' as never), null)
    const denials = await h.store.listAuthorizationDenials()
    assert.deepEqual(denials.map(item => item.reason).sort(), ['authorization_invalid', 'authorization_missing'])
    assert.ok(denials.every(item => item.stage === 'recovery'))
    assert.ok(denials.every(item => item.kind === 'workspace.provision'))
    // The historical records stay recoverable, never executed.
    assert.equal((await h.store.commands.get('legacy-provision' as CommandId))?.state, 'accepted')
    assert.equal((await h.store.commands.get('foreign-provision' as CommandId))?.state, 'accepted')
  } finally { await h.dispose() }
})

test('a historical unsigned record cannot be replaced by a signed replay of the same command id', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-t02-frame-'))
  const h = await harness(home)
  try {
    await h.runtime.initialize()
    await seedReadyWorkspace(h)
    await h.store.transaction(tx => tx.sessions.createSession(sessionId, binding))
    const stop: WorkerCommand = { kind: 'turn.stop', sessionId, turnId: 'turn-1' as never }
    await h.store.transaction(async tx => {
      await tx.commands.record({ commandId: 'legacy-stop' as CommandId, command: stop, payloadFingerprint: 'legacy' }, { commandId: 'legacy-stop' as CommandId, status: 'accepted' })
    })
    const receipt = await h.send('legacy-stop', stop, h.signed('legacy-stop', stop)) as { status: string }
    assert.equal(receipt.status, 'rejected')
    assert.equal((await h.store.commands.get('legacy-stop' as CommandId))?.state, 'accepted')
    const denials = await h.store.listAuthorizationDenials()
    assert.equal(denials.length, 1)
    assert.equal(denials[0].reason, 'authorization_missing')
  } finally { await h.dispose() }
})

test('local commands bypass cluster assertions; unsigned cluster frames still fail closed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-t02-frame-'))
  const h = await harness(home)
  try {
    await h.runtime.initialize()
    await seedReadyWorkspace(h)
    // A local installation hosts its own sessions with local authorization only.
    await h.store.saveLocalInstallation({ installationId: 'installation', name: 'local', createdAt: new Date().toISOString() as never })
    const localWorkerId = 'local-installation' as never
    await h.store.transaction(async tx => {
      await tx.workspaces.save({ id: 'local-workspace' as never, workerId: localWorkerId, projectId: 'local' as never, spec: { kind: 'composite', memberWorkspaceIds: [] }, rootPath: join(home, 'local'), status: 'ready', failureReason: null, updatedAt: new Date().toISOString() as never })
      await tx.sessions.createSession('local-session' as never, { workspaceId: 'local-workspace' as never, agent: { workerId: localWorkerId, agentKey: 'test' as never }, modelId: 'test' as never })
    })
    const enqueue: WorkerCommand = { kind: 'session.enqueue', sessionId: 'local-session' as never, message: { messageId: 'local-m1' as never, content: 'hi', sentByAccountId: 'local-owner' as never } }
    const receipt = await h.runtime.executeLocal('local-enqueue' as CommandId, enqueue)
    assert.equal(receipt.status, 'accepted')
    await until(async () => (await h.store.sessions.listQueued('local-session' as never)).length === 1)
    // Same-shaped command over the cluster transport without an assertion stays rejected.
    const rejected = await h.send('cluster-enqueue', { ...enqueue, sessionId, message: { ...enqueue.message, messageId: 'cluster-m1' as never } }) as { status: string }
    assert.equal(rejected.status, 'rejected')
    assert.equal((await h.store.listAuthorizationDenials()).filter(item => item.stage === 'receive').length, 1)
  } finally { await h.dispose() }
})

test('a valid v3 approval still gates on the online pre-execution check without persisting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-t02-frame-'))
  const h = await harness(home)
  try {
    await h.runtime.initialize()
    await seedReadyWorkspace(h)
    await h.store.transaction(tx => tx.sessions.createSession(sessionId, binding))
    const approval: WorkerCommand = { kind: 'runtime.approval.resolve', sessionId, turnId: 'turn-1' as never, approvalId: 'approval-1' as never, decision: 'approve', decidedByAccountId: 'actor' as never }
    const receipt = await h.send('approval-v3', approval, h.signed('approval-v3', approval)) as { status: string; error?: { message?: string } }
    assert.equal(receipt.status, 'rejected')
    assert.equal(receipt.error?.message, 'Command authorization unavailable')
    // No durable record: the transport may redeliver once the Server is reachable.
    assert.equal(await h.store.commands.get('approval-v3' as CommandId), null)
    assert.equal(h.events.filter(event => event.type === 'ack').length, 0)
    assert.equal((await h.store.listAuthorizationDenials()).length, 0)
  } finally { await h.dispose() }
})
