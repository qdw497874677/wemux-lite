import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { CommandId, SessionId, Timestamp, WorkerId, WorkspaceProvisionSpec } from '@wemux/domain'
import type { WorkerCommand } from '@wemux/wire-protocol'
import { authorizationBytes, type EnqueueAuthorization } from '@wemux/wire-protocol/command-assertion'
import { clusterCommandAssertion } from './fixtures/cluster-signing.ts'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { WorkerRuntime } from '../src/application/runtime.js'
import { TestAgent } from '../src/agents/test-agent.js'
import { LocalProvisioner } from '../src/workspaces/local-provisioner.js'

async function until(predicate: () => boolean | Promise<boolean>, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)) }
  assert.fail('Timed out waiting for launch')
}

test('online authorization retries transient HTTP errors and stays closed on revocation without reconnect', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-launch-retry-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const workerId = 'worker' as WorkerId, sessionId = 'session' as SessionId, commandId = 'turn' as CommandId
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const keyId = createHash('sha256').update(publicKey).digest('hex')
  store.saveIdentity({ workerId, serverUrl: 'ws://localhost/ws', credentialRef: 'credential', enrolledAt: new Date().toISOString() as Timestamp, commandSigningKey: { keyId, publicKey } })
  let checks = 0, allowed = false
  const runtime = new WorkerRuntime(store, new LocalProvisioner(join(home, 'workspaces')), [new TestAgent(1)], { send: () => undefined }, workerId, 'test', undefined, undefined, undefined, null, undefined, undefined, undefined, async id => { if (id === 'provision') return true; checks++; if (checks === 1) throw new Error('transient HTTP'); return allowed })
  const binding = { workspaceId: 'workspace' as never, agent: { workerId, agentKey: 'test' as const }, modelId: 'test' as never }
  const provision: WorkerCommand = { kind: 'workspace.provision', workspace: { workspace: { id: binding.workspaceId, workerId, projectId: 'project' as never, name: 'test', spec: { kind: 'composite', memberWorkspaceIds: [] }, status: 'pending', failureReason: null }, repositories: [] } as WorkspaceProvisionSpec }
  try {
    await runtime.initialize()
    await runtime.receive({ type: 'command', commandId: 'provision' as CommandId, command: provision, authorization: clusterCommandAssertion(keys.privateKey, keyId, { workerId, projectId: 'project' as never, workspaceId: binding.workspaceId }, 'provision', provision) })
    await until(async () => (await store.workspaces.get(binding.workspaceId))?.status === 'ready')
    const create: WorkerCommand = { kind: 'session.create', session: { sessionId, binding, storageMode: 'local' } }
    await runtime.receive({ type: 'command', commandId: 'create' as CommandId, command: create, authorization: clusterCommandAssertion(keys.privateKey, keyId, { workerId, projectId: 'project' as never, workspaceId: binding.workspaceId }, 'create', create) })
    const command: WorkerCommand = { kind: 'session.enqueue', sessionId, message: { messageId: 'message' as never, content: 'hello', sentByAccountId: 'actor' as never } }
    const claims: EnqueueAuthorization = { version: 1, keyId, commandId, workerId, sessionId, projectId: 'project' as never, workspaceId: binding.workspaceId, taskId: null, actorId: 'actor' as never, actorAuthVersion: 1, commandDigest: createHash('sha256').update(JSON.stringify(command)).digest('hex'), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString() }
    await runtime.receive({ type: 'command', commandId, command, authorization: { claims, signature: sign(null, authorizationBytes(claims), keys.privateKey).toString('base64url') } })
    await until(() => checks >= 2)
    assert.equal((await store.sessions.listQueued(sessionId)).length, 1, 'revocation response must not claim queue')
    allowed = true
    await until(async () => (await store.sessions.listQueued(sessionId)).length === 0)
    assert.ok(checks >= 3, 'transient failure recovers without reconnect')
    allowed = false
    const revokedId = 'revoked' as CommandId
    const revoked: WorkerCommand = { kind: 'session.enqueue', sessionId, message: { messageId: 'revoked-message' as never, content: 'must wait', sentByAccountId: 'actor' as never } }
    const revokedClaims = { ...claims, commandId: revokedId, commandDigest: createHash('sha256').update(JSON.stringify(revoked)).digest('hex') }
    await runtime.receive({ type: 'command', commandId: revokedId, command: revoked, authorization: { claims: revokedClaims, signature: sign(null, authorizationBytes(revokedClaims), keys.privateKey).toString('base64url') } })
    await until(() => checks >= 9, 5000)
    // The first Turn now has post-claim checks as well; wait until the
    // bounded four-attempt launch retry window has drained.
    await new Promise(resolve => setTimeout(resolve, 2200))
    const bounded = checks
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.equal(checks, bounded, 'revocation does not create a busy polling loop')
    assert.equal((await store.sessions.listQueued(sessionId)).length, 1)
    allowed = true
    await runtime.connected()
    await until(async () => (await store.sessions.listQueued(sessionId)).length === 0)
    assert.ok(checks > bounded, 'explicit connection event wakes an exhausted queue')
  } finally { await runtime.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) }
})
