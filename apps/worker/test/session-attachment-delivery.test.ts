import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import type { AgentKey, CommandId, ModelId, ProjectId, SessionId, Timestamp, WorkerId, WorkspaceId } from '@wemux/domain'
import type { CommandReceipt, WorkerCommand, WorkerToServer } from '@wemux/wire-protocol'
import type { EnqueueAuthorization } from '@wemux/wire-protocol/command-assertion'
import { authorizationBytes } from '@wemux/wire-protocol/command-assertion'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { WorkerRuntime } from '../src/application/runtime.js'
import { TestAgent } from '../src/agents/test-agent.js'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

interface Harness {
  directory: string
  store: SqliteWorkerStore
  workspaceRoot: string
  workerId: WorkerId
  sessionId: SessionId
  acks: CommandReceipt[]
  runtime: WorkerRuntime
}

async function harness(name: string, reuse?: { store: SqliteWorkerStore; directory: string; workspaceRoot: string }): Promise<Harness> {
  const directory = reuse?.directory ?? await mkdtemp(join('/var/tmp', `wemux-attachment-${name}-`))
  const store = reuse?.store ?? new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  const workspaceRoot = reuse?.workspaceRoot ?? await mkdtemp(join(directory, 'workspace-'))
  const workerId = `worker-${name}` as WorkerId
  const sessionId = `session-${name}` as SessionId
  const workspaceId = `workspace-${name}` as WorkspaceId
  const now = new Date().toISOString() as Timestamp
  if (!reuse) {
    await store.transaction(async tx => {
      await tx.workspaces.save({
        id: workspaceId,
        workerId,
        projectId: `project-${name}` as ProjectId,
        rootPath: workspaceRoot,
        spec: { kind: 'composite', memberWorkspaceIds: [] },
        status: 'ready',
        failureReason: null,
        updatedAt: now,
      })
      await tx.sessions.createSession(sessionId, {
        workspaceId,
        agent: { workerId, agentKey: 'test' as AgentKey },
        modelId: 'test' as ModelId,
      })
    })
    store.saveCapabilities([await new TestAgent().detect()])
  }
  const acks: CommandReceipt[] = []
  const runtime = new WorkerRuntime(store, { provision: async () => { throw new Error('provision not expected') } }, [new TestAgent()],
    { send: (message: WorkerToServer) => { if (message.type === 'ack') acks.push(message.receipt) } },
    workerId, `attachment-worker-${name}`)
  return { directory, store, workspaceRoot, workerId, sessionId, acks, runtime }
}

function deliverCommand(sessionId: SessionId, bytes: Buffer, overrides: Partial<{ subpath: string; size: number; sha256: string }> = {}) {
  const digest = sha256(bytes)
  return {
    kind: 'session.attachment.deliver' as const,
    sessionId,
    attachment: {
      attachmentId: 'attachment-1',
      filename: '笔记.txt',
      subpath: overrides.subpath ?? `attachments/${digest.slice(0, 12)}-note.txt`,
      size: overrides.size ?? bytes.length,
      sha256: overrides.sha256 ?? digest,
      base64Content: bytes.toString('base64'),
    },
  }
}

test('附件投递把原始字节写入工作区并回执 accepted', async t => {
  const h = await harness('happy')
  t.after(async () => { await h.runtime.shutdown(); h.store.close(); await rm(h.directory, { recursive: true, force: true }) })
  const bytes = Buffer.from('附件原始字节 attachment payload é中', 'utf8')
  const command = deliverCommand(h.sessionId, bytes)
  await h.runtime.receive({ type: 'command', commandId: 'cmd-attach-1' as CommandId, command })
  assert.equal(h.acks.at(-1)?.status, 'accepted')
  const written = await readFile(join(h.workspaceRoot, command.attachment.subpath))
  assert.deepEqual(written, bytes)
})

test('同一 commandId 重放回执持久化结果，不重复执行', async t => {
  const h = await harness('replay')
  t.after(async () => { await h.runtime.shutdown(); h.store.close(); await rm(h.directory, { recursive: true, force: true }) })
  const bytes = Buffer.from('replay-bytes', 'utf8')
  const command = deliverCommand(h.sessionId, bytes)
  await h.runtime.receive({ type: 'command', commandId: 'cmd-attach-1' as CommandId, command })
  const first = h.acks.at(-1)
  assert.equal(first?.status, 'accepted')
  const written = await readFile(join(h.workspaceRoot, command.attachment.subpath))
  await h.runtime.receive({ type: 'command', commandId: 'cmd-attach-1' as CommandId, command })
  assert.deepEqual(h.acks.at(-1), first)
  assert.deepEqual(await readFile(join(h.workspaceRoot, command.attachment.subpath)), written)
})

test('Worker 重启后按持久化回执重放，不重复写文件', async t => {
  const h = await harness('restart')
  t.after(async () => { h.store.close(); await rm(h.directory, { recursive: true, force: true }) })
  const bytes = Buffer.from('restart-bytes', 'utf8')
  const command = deliverCommand(h.sessionId, bytes)
  await h.runtime.receive({ type: 'command', commandId: 'cmd-attach-1' as CommandId, command })
  assert.equal(h.acks.at(-1)?.status, 'accepted')
  await h.runtime.shutdown()
  const second = await harness('restart', { store: h.store, directory: h.directory, workspaceRoot: h.workspaceRoot })
  await second.runtime.receive({ type: 'command', commandId: 'cmd-attach-1' as CommandId, command })
  assert.equal(second.acks.at(-1)?.status, 'accepted')
  assert.deepEqual(await readFile(join(h.workspaceRoot, command.attachment.subpath)), bytes)
})

test('sha256 不匹配拒绝投递且不落盘', async t => {
  const h = await harness('sha')
  t.after(async () => { await h.runtime.shutdown(); h.store.close(); await rm(h.directory, { recursive: true, force: true }) })
  const bytes = Buffer.from('tampered', 'utf8')
  const command = deliverCommand(h.sessionId, bytes, { sha256: '0'.repeat(64) })
  await h.runtime.receive({ type: 'command', commandId: 'cmd-attach-1' as CommandId, command })
  const receipt = h.acks.at(-1)
  assert.equal(receipt?.status, 'rejected')
  if (receipt?.status === 'rejected') assert.match(receipt.error.message, /sha256/i)
  await assert.rejects(readFile(join(h.workspaceRoot, command.attachment.subpath)))
})

test('声明大小与实际不符拒绝投递且不落盘', async t => {
  const h = await harness('size')
  t.after(async () => { await h.runtime.shutdown(); h.store.close(); await rm(h.directory, { recursive: true, force: true }) })
  const bytes = Buffer.from('size-mismatch', 'utf8')
  const command = deliverCommand(h.sessionId, bytes, { size: bytes.length + 1 })
  await h.runtime.receive({ type: 'command', commandId: 'cmd-attach-1' as CommandId, command })
  assert.equal(h.acks.at(-1)?.status, 'rejected')
  await assert.rejects(readFile(join(h.workspaceRoot, command.attachment.subpath)))
})

test('越界 subpath 拒绝投递', async t => {
  const h = await harness('escape')
  t.after(async () => { await h.runtime.shutdown(); h.store.close(); await rm(h.directory, { recursive: true, force: true }) })
  const bytes = Buffer.from('escape', 'utf8')
  const digest = sha256(bytes)
  const command = deliverCommand(h.sessionId, bytes, { subpath: `../${digest.slice(0, 12)}-escape.txt` })
  await h.runtime.receive({ type: 'command', commandId: 'cmd-attach-1' as CommandId, command })
  assert.equal(h.acks.at(-1)?.status, 'rejected')
})

test('投递到不存在的 Session 被拒绝', async t => {
  const h = await harness('missing-session')
  t.after(async () => { await h.runtime.shutdown(); h.store.close(); await rm(h.directory, { recursive: true, force: true }) })
  const bytes = Buffer.from('missing', 'utf8')
  const command = deliverCommand('session-does-not-exist' as SessionId, bytes)
  await h.runtime.receive({ type: 'command', commandId: 'cmd-attach-1' as CommandId, command })
  const receipt = h.acks.at(-1)
  assert.equal(receipt?.status, 'rejected')
  if (receipt?.status === 'rejected') assert.match(receipt.error.message, /Session/)
})

test('Test Agent 如实声明附件能力', async () => {
  const capability = await new TestAgent().detect()
  assert.equal(capability.attachments, true)
})

test('附件投递后 read-file fixture 由 Agent 真实读取原字节并回显摘要', async t => {
  const h = await harness('read-file')
  t.after(async () => { await h.runtime.shutdown(); h.store.close(); await rm(h.directory, { recursive: true, force: true }) })
  // 会话需要签名身份才能接受集群 enqueue（同 command-authorization.test 模式）。
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const keyId = createHash('sha256').update(publicKey).digest('hex')
  h.store.saveIdentity({ workerId: h.workerId, serverUrl: 'ws://localhost/worker/ws', credentialRef: 'credential', enrolledAt: new Date().toISOString() as Timestamp, commandSigningKey: { keyId, publicKey } })
  const launchable = new WorkerRuntime(h.store, { provision: async () => { throw new Error('provision not expected') } }, [new TestAgent()],
    { send: (message: WorkerToServer) => { if (message.type === 'ack') h.acks.push(message.receipt) } },
    h.workerId, 'attachment-worker-read-file', undefined, undefined, undefined, null, undefined, undefined, undefined, async () => true)
  const bytes = Buffer.from('read-file 附件原字节 payload\n', 'utf8')
  const attachment = deliverCommand(h.sessionId, bytes)
  await launchable.receive({ type: 'command', commandId: 'cmd-deliver-1' as CommandId, command: attachment })
  const enqueue: WorkerCommand = { kind: 'session.enqueue', sessionId: h.sessionId, message: { messageId: 'message-read-1' as never, content: `[test-agent:read-file] ${attachment.attachment.subpath}`, sentByAccountId: 'actor' as never } }
  const claims: EnqueueAuthorization = { version: 1, keyId, commandId: 'cmd-enqueue-1' as CommandId, workerId: h.workerId, sessionId: h.sessionId, projectId: 'project-read-file' as ProjectId, workspaceId: 'workspace-read-file' as never, taskId: null, actorId: 'actor' as never, actorAuthVersion: 1, commandDigest: createHash('sha256').update(JSON.stringify(enqueue)).digest('hex'), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString() }
  await launchable.receive({ type: 'command', commandId: 'cmd-enqueue-1' as CommandId, command: enqueue, authorization: { claims, signature: cryptoSign(null, authorizationBytes(claims), keys.privateKey).toString('base64url') } })
  for (let attempt = 0; attempt < 300; attempt++) {
    const page = await h.store.journal.read({ sessionId: h.sessionId, fromSeq: 1 as never, limit: 100 })
    if (page.events.some(event => event.payload.kind === 'turn.finished')) {
      const text = page.events.map(event => 'text' in event.payload ? event.payload.text : '').join('')
      assert.match(text, new RegExp(`sha256=${sha256(bytes)}`))
      assert.match(text, new RegExp(`size=${bytes.length}`))
      return
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('turn 未在期限内完成')
})
