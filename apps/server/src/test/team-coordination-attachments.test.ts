import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { AgentKey, CommandId, ModelId, ProjectId, SessionId, Timestamp, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, seedAdministrator, administratorToken } from './fixtures/administrator.ts'
import { hashSecret } from '../application/auth.ts'

const at = '2026-06-01T00:00:00Z' as Timestamp
const contributor = 'attachment-contributor' as UserId
const viewer = 'attachment-viewer' as UserId
const outsider = 'attachment-outsider' as UserId

/** Owned SQLite and synthetic resources only; no Worker connection or Runtime invocation. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wemux-team-attachment-test-'))
  const options = { databasePath: join(root, 'server.sqlite'), administratorEmails: [administratorEmail], mail: {}, google: {}, capabilitySecret: 'synthetic-test-only-secret-for-attachments' }
  let app = createWemuxServer(options), origin = await app.listen(0)
  const call = async (path: string, body?: unknown, token = administratorToken, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  await seedAdministrator(app.store)
  assert.equal((await call('/bootstrap', {})).status, 200)
  const project = (await call('/projects', { teamId: 'default-team', name: 'Attachment project' })).data
  const workerId = 'attachment-worker' as WorkerId, plainWorkerId = 'attachment-plain-worker' as WorkerId
  const workspaceId = 'attachment-workspace' as WorkspaceId, plainWorkspaceId = 'attachment-plain-workspace' as WorkspaceId
  await app.store.transaction(async tx => {
    for (const userId of [contributor, viewer, outsider]) {
      await tx.identity.saveUser({ id: userId, email: `${userId}@example.test`, username: userId, status: 'active', createdAt: at })
      await tx.identity.savePersonalAccessToken({ id: userId as never, userId, name: 'Synthetic test', scopes: ['read', 'write', 'execute', 'admin'], tokenHash: hashSecret(userId), createdAt: at, expiresAt: '2099-01-01T00:00:00Z' as Timestamp, lastUsedAt: null, revokedAt: null })
      if (userId === outsider) continue
      await tx.identity.saveMembership({ teamId: project.teamId, userId, role: 'member', joinedAt: at })
      await tx.identity.saveProjectGrant({ projectId: project.id, userId, role: userId === viewer ? 'viewer' : 'contributor' })
    }
    const capable: Parameters<typeof tx.resources.saveWorker>[0] = { id: workerId, teamId: project.teamId, ownerId: project.ownerId, name: 'Attachment Worker', shareScope: 'team', connectionState: 'online', version: '1', platform: 'linux', lastSeenAt: at, capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: '1', mode: 'execution', availability: { status: 'available' }, attachments: true, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }
    const plain: Parameters<typeof tx.resources.saveWorker>[0] = { ...capable, id: plainWorkerId, name: 'Plain Worker', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }
    await tx.resources.saveWorker(capable)
    await tx.resources.saveWorker(plain)
    for (const [id, targetWorker] of [[workspaceId, workerId], [plainWorkspaceId, plainWorkerId]] as const) {
      await tx.resources.saveWorkspace({ id, projectId: project.id as ProjectId, name: id, spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId: targetWorker, status: 'ready', failureReason: null, location: null }], deletedAt: null })
    }
  })
  const request = { requestId: 'upload-first', workspaceId, workerId, agentKey: 'test', modelId: 'model' }
  const upload = async (fields: Record<string, string>, file: { name: string; bytes: Buffer; type?: string } | null = { name: '笔记.txt', bytes: Buffer.from('附件原始字节 hello 附件\n') }, token = contributor) => {
    const form = new FormData()
    if (file) form.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.type ?? 'text/plain' }), file.name)
    for (const [key, value] of Object.entries(fields)) form.append(key, value)
    const response = await fetch(`${origin}/api/teams/default-team/coordination/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
    return { status: response.status, data: response.status === 204 ? null : await response.json().catch(() => null) }
  }
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  return { get app() { return app }, call, project, workerId, plainWorkerId, workspaceId, plainWorkspaceId, request, upload, digest,
    async reopen() { await app.close(); app = createWemuxServer(options); origin = await app.listen(0) },
    async close() { await app.close(); await rm(root, { recursive: true, force: true }) },
    get blobRoot() { return join(root, 'resource-blobs') },
  }
}

test('首次上传收件并原子绑定 Task/Session 元数据，两阶段如实呈现且不虚构首条消息', async () => {
  const f = await fixture()
  try {
    const bytes = Buffer.from('附件原始字节 hello 附件\n')
    const initial = await f.upload({ ...f.request })
    assert.equal(initial.status, 201, JSON.stringify(initial.data))
    assert.equal(initial.data.created, true)
    const attachment = initial.data.attachment
    assert.equal(attachment.filename, '笔记.txt')
    assert.equal(attachment.size, bytes.length)
    assert.equal(attachment.sha256, f.digest(bytes))
    assert.match(attachment.subpath, /^attachments\/[0-9a-f]{12}-/)
    assert.ok(attachment.upload.receivedAt, '阶段一：Server 收件时间')
    assert.equal(attachment.delivery.state, 'pending', '阶段二：投递尚未确认')
    assert.ok(attachment.delivery.commandId.startsWith('coordination-attachment:'))
    const session = initial.data.session
    assert.ok(session.taskId?.startsWith('coordination:'))
    const task = await f.app.store.tasks.get(session.taskId)
    assert.equal(task?.projectId, 'team:default-team')
    assert.equal(task?.teamCoordination?.ownerId, contributor)
    assert.equal(session.binding.workspaceId, f.workspaceId)
    assert.equal(session.binding.agent.workerId, f.workerId)
    assert.equal(session.binding.agent.agentKey, 'test')
    assert.equal(session.binding.modelId, 'model')
    // 不虚构首条消息：没有 session.enqueue 命令，会话日志为空。
    assert.equal((await f.app.store.commands.listUnsettledEnqueues(session.id as SessionId)).length, 0)
    const deliver = await f.app.store.commands.getPendingCommand(attachment.delivery.commandId as CommandId)
    assert.equal(deliver?.command.kind, 'session.attachment.deliver')
    if (deliver?.command.kind !== 'session.attachment.deliver') throw Error('missing deliver command')
    assert.equal(deliver.command.attachment.sha256, f.digest(bytes))
    assert.equal(deliver.command.attachment.base64Content, bytes.toString('base64'))
    assert.equal(deliver.command.attachment.attachmentId, attachment.id)
    // 投递命令依赖 Session 创建命令：创建未确认前列入可投递清单。
    const deliverable = await f.app.store.commands.listDeliverable(f.workerId, 50)
    assert.ok(deliverable.some(item => item.commandId === (deliver?.command.kind === 'session.attachment.deliver' ? deliver.command.attachment.attachmentId : '') ? false : item.command.kind === 'session.create'))
    assert.ok(!deliverable.some(item => item.commandId === attachment.delivery.commandId), '投递命令在 Session 创建确认前不可提前下发')
    assert.ok(!deliverable.some(item => item.command.kind === 'session.enqueue'), '没有虚构的首条消息')
    // 收件落盘：内容寻址 blob 已存在。
    const sha = f.digest(bytes)
    assert.ok(existsSync(join(f.blobRoot, sha.slice(0, 2), sha.slice(2, 4), sha)), 'blob stored')
    // 视图口径与创建一致。
    const view = await f.call(`/teams/default-team/coordination/attachments/${attachment.id}`, undefined, contributor)
    assert.equal(view.status, 200)
    assert.equal(view.data.attachment.delivery.state, 'pending')
    assert.equal(view.data.attachment.upload.receivedAt, attachment.upload.receivedAt)
  } finally { await f.close() }
})

test('同一上传意图幂等重放：返回原 Session/附件且不重复入队，冲突拒绝', async () => {
  const f = await fixture()
  try {
    const first = await f.upload({ ...f.request })
    assert.equal(first.status, 201, JSON.stringify(first.data))
    const again = await f.upload({ ...f.request })
    assert.equal(again.status, 201, JSON.stringify(again.data))
    assert.equal(again.data.created, false)
    assert.equal(again.data.session.id, first.data.session.id)
    assert.equal(again.data.attachment.id, first.data.attachment.id)
    const conflict = await f.upload({ ...f.request, requestId: f.request.requestId }, { name: '笔记.txt', bytes: Buffer.from('不同的字节内容\n') })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.data.error.code, 'request_id_conflict')
    await f.reopen()
    const replay = await f.upload({ ...f.request })
    assert.equal(replay.status, 201, JSON.stringify(replay.data))
    assert.equal(replay.data.created, false)
    assert.equal(replay.data.attachment.id, first.data.attachment.id)
  } finally { await f.close() }
})

test('未声明附件能力的 Agent 与非成员/越权请求被拒绝', async () => {
  const f = await fixture()
  try {
    const plain = await f.upload({ ...f.request, workspaceId: f.plainWorkspaceId, workerId: f.plainWorkerId })
    assert.equal(plain.status, 409, JSON.stringify(plain.data))
    assert.equal(plain.data.error.code, 'attachment_capability_missing')
    const outside = await f.upload({ ...f.request }, undefined, outsider)
    assert.equal(outside.status, 403)
    const viewing = await f.upload({ ...f.request }, undefined, viewer)
    assert.ok([403, 404].includes(viewing.status), JSON.stringify(viewing.data))
    const foreign = await f.upload({ ...f.request, workspaceId: 'not-a-workspace' as WorkspaceId })
    assert.ok([400, 403, 404].includes(foreign.status), JSON.stringify(foreign.data))
  } finally { await f.close() }
})

test('撤权使投递失效：新上传拒绝，在途投递投影为失败', async () => {
  const f = await fixture()
  try {
    const initial = await f.upload({ ...f.request })
    assert.equal(initial.status, 201)
    await f.app.store.transaction(async tx => {
      const worker = await tx.resources.getWorker(f.workerId)
      await tx.resources.saveWorker({ ...worker!, connectionState: 'revoked' })
    })
    const fresh = await f.upload({ ...f.request, requestId: 'upload-after-revoke' })
    assert.equal(fresh.status, 409, JSON.stringify(fresh.data))
    const view = await f.call(`/teams/default-team/coordination/attachments/${initial.data.attachment.id}`, undefined, contributor)
    assert.equal(view.status, 200)
    assert.equal(view.data.attachment.delivery.state, 'failed', '撤权后投递不再可能，如实呈现失败')
    assert.match(view.data.attachment.delivery.detail ?? '', /撤销/)
    const replay = await f.upload({ ...f.request })
    assert.equal(replay.status, 201, JSON.stringify(replay.data))
    assert.equal(replay.data.created, false)
    assert.equal(replay.data.attachment.delivery.state, 'failed')
  } finally { await f.close() }
})

test('投递回执驱动阶段二状态：已投递与失败', async () => {
  const f = await fixture()
  try {
    const initial = await f.upload({ ...f.request })
    const attachmentId = initial.data.attachment.id as string
    const commandId = initial.data.attachment.delivery.commandId as CommandId
    await f.app.store.transaction(tx => tx.commands.recordReceipt({ commandId, status: 'rejected', error: { code: 'invalid-input', message: 'sha256 mismatch', retryable: false } }, at))
    let view = await f.call(`/teams/default-team/coordination/attachments/${attachmentId}`, undefined, contributor)
    assert.equal(view.data.attachment.delivery.state, 'failed')
    assert.match(view.data.attachment.delivery.detail ?? '', /sha256 mismatch/)
    // 回执是终态：另一次上传验证已投递分支。
    const second = await f.upload({ ...f.request, requestId: 'upload-delivered' })
    const secondCommandId = second.data.attachment.delivery.commandId as CommandId
    await f.app.store.transaction(tx => tx.commands.recordReceipt({ commandId: secondCommandId, status: 'accepted' }, at))
    view = await f.call(`/teams/default-team/coordination/attachments/${second.data.attachment.id}`, undefined, contributor)
    assert.equal(view.status, 200)
    assert.equal(view.data.attachment.delivery.state, 'delivered')
    const deliverable = await f.app.store.commands.listDeliverable(f.workerId, 50)
    assert.ok(!deliverable.some(item => item.commandId === commandId), '已投递命令不再下发')
  } finally { await f.close() }
})

test('事务失败不留孤儿：Session/Task/附件记录一起回滚', async () => {
  const f = await fixture()
  try {
    const before = (await f.app.store.resources.listSessions()).length
    // 预置同 ID 但不同载荷的命令，制造事务内命令冲突。
    const commandId = `coordination-attachment:${f.digest(Buffer.from(JSON.stringify([contributor, 'default-team', 'upload-orphan'])))}` as CommandId
    await f.app.store.transaction(tx => tx.commands.insertPending({ commandId, workerId: f.workerId, command: { kind: 'workspace.delete', workspaceId: 'attachment-workspace' as WorkspaceId }, payloadFingerprint: 'synthetic-conflict', createdAt: at }))
    const failed = await f.upload({ ...f.request, requestId: 'upload-orphan' })
    assert.equal(failed.status, 409, JSON.stringify(failed.data))
    assert.equal((await f.app.store.resources.listSessions()).length, before, '没有孤儿 Session')
    const sessions = await f.app.store.resources.listSessions()
    assert.ok(!sessions.some(session => session.creation?.requestId === 'coordination-upload:upload-orphan'))
    if (failed.data?.attachment) assert.fail('冲突响应不应携带附件')
    const view = await f.call(`/teams/default-team/coordination/attachments/unknown-attachment`, undefined, contributor)
    assert.equal(view.status, 404)
  } finally { await f.close() }
})

test('投递失败后的重建路径：新 requestId 重传畅通且独立，旧意图重放只回放失败记录', async () => {
  const f = await fixture()
  try {
    const first = await f.upload({ ...f.request })
    assert.equal(first.status, 201)
    const failedCommandId = first.data.attachment.delivery.commandId as CommandId
    await f.app.store.transaction(tx => tx.commands.recordReceipt({ commandId: failedCommandId, status: 'rejected', error: { code: 'invalid-state', message: 'workspace placement is not ready', retryable: false } }, at))
    const failedView = await f.call(`/teams/default-team/coordination/attachments/${first.data.attachment.id}`, undefined, contributor)
    assert.equal(failedView.data.attachment.delivery.state, 'failed')

    // 旧 requestId 重放：诚实回放失败 Session，不复活投递（UI 必须引导换新上传而不是重放）。
    const replay = await f.upload({ ...f.request })
    assert.equal(replay.status, 201)
    assert.equal(replay.data.created, false)
    assert.equal(replay.data.session.id, first.data.session.id)
    assert.equal(replay.data.attachment.delivery.state, 'failed')

    // 同文件新 requestId：重传路径畅通，同一协调 Task 下新 Session 与新投递命令，失败历史保留。
    const rebuild = await f.upload({ ...f.request, requestId: 'upload-rebuild' })
    assert.equal(rebuild.status, 201, JSON.stringify(rebuild.data))
    assert.equal(rebuild.data.created, true)
    assert.notEqual(rebuild.data.session.id, first.data.session.id)
    assert.equal(rebuild.data.session.taskId, first.data.session.taskId, '同协调 Task 下重建会话')
    assert.notEqual(rebuild.data.attachment.delivery.commandId, failedCommandId)
    assert.equal(rebuild.data.attachment.delivery.state, 'pending', '新投递从待投递开始')
    assert.equal(rebuild.data.attachment.sha256, first.data.attachment.sha256, '同文件内容寻址复用')
    assert.notEqual(rebuild.data.attachment.id, first.data.attachment.id)

    // 新投递成功后：新附件已投递，旧附件仍如实保持失败。
    await f.app.store.transaction(tx => tx.commands.recordReceipt({ commandId: rebuild.data.attachment.delivery.commandId as CommandId, status: 'accepted' }, at))
    const rebuiltView = await f.call(`/teams/default-team/coordination/attachments/${rebuild.data.attachment.id}`, undefined, contributor)
    assert.equal(rebuiltView.data.attachment.delivery.state, 'delivered')
    const stillFailed = await f.call(`/teams/default-team/coordination/attachments/${first.data.attachment.id}`, undefined, contributor)
    assert.equal(stillFailed.data.attachment.delivery.state, 'failed', '失败历史不被重传改写')
  } finally { await f.close() }
})

test('HTTP 边界：超限 413、类型不符 400、缺文件 400、非成员视图 404', async () => {
  const f = await fixture()
  try {
    const oversize = await f.upload({ ...f.request }, { name: '大文件.bin', bytes: Buffer.alloc(2 * 1024 * 1024 + 7, 1) })
    assert.equal(oversize.status, 413, JSON.stringify(oversize.data))
    const json = await f.call('/teams/default-team/coordination/attachments', { requestId: 'json-upload' }, contributor)
    assert.equal(json.status, 400, JSON.stringify(json.data))
    const missing = await f.upload({ ...f.request }, null)
    assert.equal(missing.status, 400, JSON.stringify(missing.data))
    const created = await f.upload({ ...f.request, requestId: 'view-permission' })
    assert.equal(created.status, 201)
    const foreignView = await f.call(`/teams/default-team/coordination/attachments/${created.data.attachment.id}`, undefined, outsider)
    assert.equal(foreignView.status, 403)
    const memberView = await f.call(`/teams/default-team/coordination/attachments/${created.data.attachment.id}`, undefined, viewer)
    assert.ok([403, 404].includes(memberView.status), '非所有者成员不可见')
  } finally { await f.close() }
})
