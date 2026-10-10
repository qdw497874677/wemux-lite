import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { CommandId, SessionId, Timestamp, WorkerId, WorkspaceProvisionSpec } from '@wemux/domain'
import type { WorkerCommand, WorkerPayload } from '@wemux/wire-protocol'
import { authorizationBytes, type EnqueueAuthorization } from '@wemux/wire-protocol/command-assertion'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { WorkerRuntime } from '../src/application/runtime.js'
import { TestAgent } from '../src/agents/test-agent.js'
import { LocalProvisioner } from '../src/workspaces/local-provisioner.js'

const workerId = 'worker' as WorkerId
const sessionId = 'session' as SessionId
const binding = { workspaceId: 'workspace' as never, agent: { workerId, agentKey: 'test' as const }, modelId: 'test' as never }
const provision: WorkerCommand = { kind: 'workspace.provision', workspace: { workspace: { id: binding.workspaceId, workerId, projectId: 'project' as never, name: 'test', spec: { kind: 'composite', memberWorkspaceIds: [] }, status: 'pending', failureReason: null }, repositories: [] } as WorkspaceProvisionSpec }
const enqueue = (id: string): Extract<WorkerCommand, { kind: 'session.enqueue' }> => ({ kind: 'session.enqueue', sessionId, message: { messageId: id as never, content: id, sentByAccountId: 'actor' as never } })
async function until(predicate: () => boolean | Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) } assert.fail('Timed out') }

test('cluster queue is signed, pinned and online checked; unsigned restored and local fallback never start', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-authorization-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const keyId = createHash('sha256').update(publicKey).digest('hex')
  store.saveIdentity({ workerId, serverUrl: 'ws://localhost/worker/ws', credentialRef: 'credential', enrolledAt: new Date().toISOString() as Timestamp, commandSigningKey: { keyId, publicKey } })
  let online = false, checks = 0
  const events: WorkerPayload[] = []
  const makeRuntime = () => new WorkerRuntime(store, new LocalProvisioner(join(home, 'workspaces')), [new TestAgent(1)], { send: event => events.push(event) }, workerId, 'test', undefined, undefined, undefined, null, undefined, undefined, undefined, async () => { checks++; return online })
  let runtime = makeRuntime()
  const send = (id: string, command: WorkerCommand, authorization?: { claims: EnqueueAuthorization; signature: string }) => runtime.receive({ type: 'command', commandId: id as CommandId, command, ...(authorization ? { authorization } : {}) })
  const signed = (id: string, command: Extract<WorkerCommand, { kind: 'session.enqueue' }>) => {
    const claims: EnqueueAuthorization = { version: 1, keyId, commandId: id as CommandId, workerId, sessionId, projectId: 'project' as never, workspaceId: binding.workspaceId, taskId: null, actorId: 'actor' as never, actorAuthVersion: 1, commandDigest: createHash('sha256').update(JSON.stringify(command)).digest('hex'), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString() }
    return { claims, signature: sign(null, authorizationBytes(claims), keys.privateKey).toString('base64url') }
  }
  try {
    await runtime.initialize()
    // Provisioning currently belongs to a different ticket slice; fixture sets up a ready workspace without trusting its authorization.
    await store.transaction(tx => tx.workspaces.save({ ...provision.workspace.workspace, rootPath: join(home, 'workspaces'), status: 'ready', updatedAt: new Date().toISOString() as Timestamp } as never))
    await store.transaction(tx => tx.sessions.createSession(sessionId, binding))
    await send('unsigned', enqueue('unsigned'))
    assert.equal(await store.commands.get('unsigned' as CommandId), null)
    const wrong = signed('wrong-worker', enqueue('wrong-worker'))
    await send('wrong-worker', enqueue('wrong-worker'), { ...wrong, claims: { ...wrong.claims, workerId: 'another-worker' as WorkerId } })
    assert.equal(await store.commands.get('wrong-worker' as CommandId), null)
    const expired = signed('expired', enqueue('expired'))
    await send('expired', enqueue('expired'), { ...expired, claims: { ...expired.claims, expiresAt: new Date(Date.now() - 1000).toISOString() } })
    assert.equal(await store.commands.get('expired' as CommandId), null)
    assert.equal((await store.sessions.listQueued(sessionId)).length, 0)
    const valid = enqueue('valid')
    await send('valid', valid, signed('valid', valid))
    await until(() => checks > 0)
    assert.equal((await store.sessions.listQueued(sessionId)).length, 1)
    assert.equal((await store.sessions.get(sessionId))?.activeTurnId, null)
    await runtime.shutdown()
    store.saveLocalInstallation({ installationId: 'installation', name: 'local', createdAt: new Date().toISOString() as Timestamp })
    store.clearIdentity()
    const localRuntime = new WorkerRuntime(store, new LocalProvisioner(join(home, 'workspaces')), [new TestAgent(1)], { send: event => events.push(event) }, 'local-installation' as WorkerId, 'local')
    await localRuntime.initialize()
    await localRuntime.connected()
    assert.equal((await store.sessions.listQueued(sessionId)).length, 1)
    // A queue entry without any command record is not a local queue merely because identity was cleared.
    await store.transaction(tx => tx.sessions.enqueue({ sessionId, submissionCommandId: 'legacy' as CommandId, message: { messageId: 'legacy' as never, content: 'unsigned historical queue' }, queuedAt: new Date().toISOString() as Timestamp }))
    await localRuntime.connected()
    assert.equal((await store.sessions.listQueued(sessionId)).length, 2)
    assert.equal((await store.sessions.get(sessionId))?.activeTurnId, null)
    await localRuntime.shutdown()
    store.saveIdentity({ workerId, serverUrl: 'ws://localhost/worker/ws', credentialRef: 'credential', enrolledAt: new Date().toISOString() as Timestamp, commandSigningKey: { keyId, publicKey } })
    runtime = makeRuntime()
    await runtime.initialize()
    assert.equal((await store.sessions.get(sessionId))?.activeTurnId, null)
    online = true
    await runtime.connected()
    await until(async () => (await store.sessions.listQueued(sessionId))[0]?.submissionCommandId === 'legacy')
    assert.equal((await store.sessions.listQueued(sessionId)).length, 1)
    assert.ok(checks > 1)
  } finally { await runtime.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) }
})
