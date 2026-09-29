import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ResourceSetSnapshot, Turn, WorkerId } from '@wemux/domain'
import { FilesystemAgentLaunchContextProvider } from '../src/application/agent-launch-context-provider.ts'
import type { WorkerPayload } from '@wemux/wire-protocol'
import { ResourceReconciler } from '../src/resources/resource-reconciler.ts'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const workerId = 'worker-resource-test' as WorkerId
function snapshot(revision: number, revisionId: string, content: string): ResourceSetSnapshot {
  return {
    workerId, revision, fingerprint: sha(`set-${revision}`), createdAt: '2026-01-01T00:00:00.000Z' as never,
    bindings: [{ bindingId: 'binding-1', bindingRevision: revision, agentKey: null, projectId: null, resourceRevisionId: revisionId, resourceId: 'skill-1', kind: 'skill', contentSha256: sha(`manifest-${revisionId}`), files: [{ path: 'SKILL.md', size: Buffer.byteLength(content), mediaType: 'text/markdown', sha256: sha(content), blobSha256: sha(content) }] }],
  }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'wemux-resource-reconciler-'))
  const sent: WorkerPayload[] = []
  let reconciler!: ResourceReconciler
  const blobs = new Map<string, Buffer>()
  const transport = { send: async (payload: WorkerPayload) => {
    sent.push(payload)
    if (payload.type === 'resource.blob.fetch') queueMicrotask(() => reconciler.receive(blobs.has(payload.sha256)
      ? { type: 'resource.blob.fetch', action: 'response', requestId: payload.requestId, sha256: payload.sha256, mediaType: 'text/markdown', size: blobs.get(payload.sha256)!.length, base64Content: blobs.get(payload.sha256)!.toString('base64') }
      : { type: 'resource.blob.fetch', action: 'not-found', requestId: payload.requestId, sha256: payload.sha256 }))
  } }
  reconciler = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources.sqlite'), transport, now: () => '2026-01-01T00:00:00.000Z' as never })
  return { home, sent, blobs, reconciler, close: async () => { await reconciler.close(); await rm(home, { recursive: true, force: true }) } }
}

test('reconcile 差异矩阵：缺失下载，已收敛不重复下载，磁盘漂移重新物化', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# skill')
    f.blobs.set(sha('# skill'), Buffer.from('# skill'))
    await f.reconciler.reconcile(desired)
    assert.equal(f.sent.filter(item => item.type === 'resource.blob.fetch').length, 1)
    assert.equal(f.sent.filter(item => item.type === 'resource.reconcile.report' && item.report.phase === 'ready').length, 1)
    await f.reconciler.reconcile(desired)
    assert.equal(f.sent.filter(item => item.type === 'resource.blob.fetch').length, 1)
    await readFile(join(f.home, 'resources', 'skill', 'skill-1', 'current', 'SKILL.md'))
    await import('node:fs/promises').then(fs => fs.writeFile(join(f.home, 'resources', 'skill', 'skill-1', 'current', 'SKILL.md'), '# drift'))
    await f.reconciler.reconcile(desired)
    assert.equal(f.sent.filter(item => item.type === 'resource.blob.fetch').length, 2)
    assert.equal(await readFile(join(f.home, 'resources', 'skill', 'skill-1', 'current', 'SKILL.md'), 'utf8'), '# skill')
  } finally { await f.close() }
})

test('期望态持久化后重启先本地恢复，并请求完整 snapshot', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# restart')
    f.blobs.set(sha('# restart'), Buffer.from('# restart'))
    await f.reconciler.reconcile(desired)
    await f.reconciler.close()
    const sent: WorkerPayload[] = []
    let restarted!: ResourceReconciler
    const transport = { send: async (payload: WorkerPayload) => {
      sent.push(payload)
      if (payload.type === 'resource.set.pull') queueMicrotask(() => restarted.receive({ type: 'resource.set.pull', action: 'snapshot', requestId: payload.requestId, resourceSet: desired }))
    } }
    restarted = new ResourceReconciler({ workerId, home: f.home, databasePath: join(f.home, 'resources.sqlite'), transport })
    await restarted.connected()
    assert.equal(sent.some(item => item.type === 'resource.set.pull' && item.knownSetRevision === 1), true)
    assert.equal(sent.some(item => item.type === 'resource.blob.fetch'), false)
    assert.equal(sent.some(item => item.type === 'resource.reconcile.report' && item.report.phase === 'ready'), true)
    await restarted.close()
    await rm(f.home, { recursive: true, force: true })
  } catch (error) { await rm(f.home, { recursive: true, force: true }); throw error }
})

test('无响应的 snapshot pull 不阻塞关闭', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-resource-close-'))
  const reconciler = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources.sqlite'), transport: { send: async () => {} } })
  try {
    void reconciler.connected().catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    await Promise.race([reconciler.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('close blocked by pending pull')), 500))])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('Invocation 固定已授权 revision，撤销后新 Invocation 不注入', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# old')
    const scoped = { ...desired, bindings: [{ ...desired.bindings[0]!, projectId: 'project-1' as never, agentKey: 'pi' as never }] }
    f.blobs.set(sha('# old'), Buffer.from('# old'))
    await f.reconciler.reconcile(scoped)
    const provider = new FilesystemAgentLaunchContextProvider(f.home, null, undefined,
      (projectId, agentKey) => f.reconciler.skillsForLaunch(projectId, agentKey),
      async () => ({ projectId: 'project-1' as never, agentKey: 'pi' as never }))
    const turn = (id: string, projectId = 'project-1') => ({
      id, sessionId: id, capabilitySnapshot: { id, sessionId: id, projectId, workspaceId: 'workspace-1', version: 1, assets: [], allowedTools: [], allowedConnectorIds: [], createdAt: new Date().toISOString() }, capabilityToken: null,
    }) as Turn
    const denied = await f.reconciler.skillsForLaunch('project-2' as never, 'pi' as never)
    const wrongAgent = await f.reconciler.skillsForLaunch('project-1' as never, 'claude-code' as never)
    assert.deepEqual(denied, []); assert.deepEqual(wrongAgent, [])
    const first = await provider.prepare(turn('turn-old'))
    assert.equal(await readFile(join(first.context!.skillsRoot!, 'skill-1', 'SKILL.md'), 'utf8'), '# old')
    const updated = snapshot(2, 'rev-2', '# new')
    f.blobs.set(sha('# new'), Buffer.from('# new'))
    await f.reconciler.reconcile({ ...updated, bindings: [{ ...updated.bindings[0]!, projectId: 'project-1' as never, agentKey: 'pi' as never }] })
    assert.equal(await readFile(join(first.context!.skillsRoot!, 'skill-1', 'SKILL.md'), 'utf8'), '# old', '活跃 Invocation 不热替换')
    const next = await provider.prepare(turn('turn-new'))
    assert.equal(await readFile(join(next.context!.skillsRoot!, 'skill-1', 'SKILL.md'), 'utf8'), '# new')
    await f.reconciler.reconcile({ workerId, revision: 3, fingerprint: sha('revoked'), bindings: [], createdAt: '2026-01-02T00:00:00.000Z' as never })
    const revoked = await provider.prepare(turn('turn-revoked'))
    assert.equal(revoked.context!.skillsRoot, null, '撤权后新 Invocation 不注入')
    assert.equal(await readFile(join(first.context!.skillsRoot!, 'skill-1', 'SKILL.md'), 'utf8'), '# old')
    const state = new (await import('../src/resources/resource-state-store.ts')).ResourceStateStore(join(f.home, 'resources.sqlite'))
    try {
      const gc = new (await import('../src/resources/skill-materializer.ts')).SkillMaterializer(f.home, state)
      // 运行中 Invocation 的 Skill 是隔离副本；GC 只能清理缓存，不能改变已固定的视图。
      await gc.collectGarbage('skill-1', { maxRetainedRevisions: 0 })
    } finally { state.close() }
    assert.equal(await readFile(join(first.context!.skillsRoot!, 'skill-1', 'SKILL.md'), 'utf8'), '# old')
    await revoked.cleanup(); await next.cleanup(); await first.cleanup()
  } finally { await f.close() }
})

test('撤销旧绑定后重新绑定相同 revision，更新绑定身份且新 Invocation 可用', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# authorized')
    f.blobs.set(sha('# authorized'), Buffer.from('# authorized'))
    await f.reconciler.reconcile(desired)
    await f.reconciler.reconcile({ ...desired, revision: 2, fingerprint: sha('revoked'), bindings: [] })
    const replacement = { ...desired, revision: 3, fingerprint: sha('replacement'), bindings: [{ ...desired.bindings[0]!, bindingId: 'binding-new' }] }
    await f.reconciler.reconcile(replacement)
    assert.equal((await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never)).length, 1)
    assert.equal(f.sent.filter(item => item.type === 'resource.blob.fetch').length, 1, '同一不可变 revision 不需重复下载')
  } finally { await f.close() }
})

test('断线或过时通知期间禁止用旧期望态注入，重新获取快照后才恢复', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# authorized')
    f.blobs.set(sha('# authorized'), Buffer.from('# authorized'))
    await f.reconciler.reconcile(desired)
    assert.equal((await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never)).length, 1)
    f.reconciler.disconnected()
    assert.deepEqual(await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never), [])
    await f.reconciler.reconcile(desired)
    assert.equal((await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never)).length, 1)
    f.reconciler.receive({ type: 'resource.set.notify', workerId, setRevision: 2, fingerprint: sha('revoked'), resources: [] })
    assert.deepEqual(await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never), [])
    const pull = await (async () => { for (let i = 0; i < 100; i++) { const request = f.sent.findLast(item => item.type === 'resource.set.pull'); if (request?.type === 'resource.set.pull') return request; await new Promise(resolve => setTimeout(resolve, 1)) } throw new Error('snapshot pull not sent') })()
    f.reconciler.receive({ type: 'resource.set.pull', action: 'snapshot', requestId: pull.requestId, resourceSet: desired })
    await f.reconciler.reconcile(desired)
    assert.deepEqual(await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never), [], '旧快照不能解除较新通知的隔离')
    await f.reconciler.reconcile({ ...desired, revision: 2, fingerprint: sha('revoked'), bindings: [] })
    assert.deepEqual(await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never), [])
  } finally { await f.close() }
})

test('本地缓存 hash 漂移时新 Invocation 不注入且已有隔离视图不变', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# trusted')
    f.blobs.set(sha('# trusted'), Buffer.from('# trusted'))
    await f.reconciler.reconcile(desired)
    const pinned = await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never)
    assert.equal(Buffer.from(pinned[0]!.content).toString('utf8'), '# trusted')
    const entry = join(f.home, 'resources', 'skill', 'skill-1', 'current', 'SKILL.md')
    await import('node:fs/promises').then(fs => fs.writeFile(entry, '# tampered'))
    assert.deepEqual(await f.reconciler.skillsForLaunch('project-1' as never, 'pi' as never), [], '校验失败不可注入')
    assert.equal(Buffer.from(pinned[0]!.content).toString('utf8'), '# trusted', '运行中的内容仍固定')
  } finally { await f.close() }
})

test('期望态移除时上报 pending-gc', async () => {
  const f = await fixture()
  try {
    const desired = snapshot(1, 'rev-1', '# remove')
    f.blobs.set(sha('# remove'), Buffer.from('# remove'))
    await f.reconciler.reconcile(desired)
    await f.reconciler.reconcile({ workerId, revision: 2, fingerprint: sha('empty'), bindings: [], createdAt: '2026-01-02T00:00:00.000Z' as never })
    assert.equal(f.sent.some(item => item.type === 'resource.reconcile.report' && item.report.result === 'pending-gc'), true)
  } finally { await f.close() }
})
