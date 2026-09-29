import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ResourceSetSnapshot, WorkerId } from '@wemux/domain'
import type { WorkerPayload } from '@wemux/wire-protocol'
import { ResourceReconciler } from '../src/resources/resource-reconciler.ts'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const workerId = 'worker-resource-test' as WorkerId
function snapshot(revision: number, revisionId: string, content: string): ResourceSetSnapshot {
  return {
    workerId, revision, fingerprint: sha(`set-${revision}`), createdAt: '2026-01-01T00:00:00.000Z' as never,
    bindings: [{ bindingId: 'binding-1', bindingRevision: revision, resourceRevisionId: revisionId, resourceId: 'skill-1', kind: 'skill', contentSha256: sha(`manifest-${revisionId}`), files: [{ path: 'SKILL.md', size: Buffer.byteLength(content), mediaType: 'text/markdown', sha256: sha(content), blobSha256: sha(content) }] }],
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
