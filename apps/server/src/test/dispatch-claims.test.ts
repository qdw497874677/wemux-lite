import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { SqliteServerStore } from '../storage/sqlite/store.ts'
import type { DispatchClaimRecord, DispatchIntentRecord } from '../application/ports/server-store-types.ts'

/**
 * 派发承接的持久化并发证据。这里刻意不用进程内单例：`SharedSqliteDatabase` 把同一实例的
 * 读写串行化，只有**跨连接/跨进程**才是真并发。因此断言分两层：
 *   1. 同进程两个连接争抢同一执行意图；
 *   2. 多个子进程在同一时刻争抢同一执行意图（唯一性由 SQLite 部分唯一索引裁决）。
 * 这正是「同一执行意图并发申领仅产生一个有效承接」的最小可复现证据。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const tempRoot = '/var/tmp'

async function seed(path: string): Promise<void> {
  const store = new SqliteServerStore(path)
  store.close()
  const db = new DatabaseSync(path)
  try {
    db.exec(`INSERT INTO tasks(id, project_id, data) VALUES('task-1','project-1','{"id":"task-1","projectId":"project-1","metadataJson":{"schemaVersion":1}}')`)
    db.exec(`INSERT INTO task_dispatch_intents(id, task_id, generation, queue_order, state, data) VALUES('intent-1','task-1',0,1,'pending','{"intentId":"intent-1","taskId":"task-1","kind":"dispatch","generation":0,"machineScope":{"kind":"any"},"queueOrder":1,"enqueuedAt":"2024-01-01T00:00:00.000Z","state":"pending","dispatchable":true}')`)
  } finally { db.close() }
}

const claim = (workerId: string, requestId: string): DispatchClaimRecord => ({
  claimId: `claim-${workerId}-${requestId}`,
  intentId: 'intent-1',
  taskId: 'task-1',
  workerId,
  generation: 0,
  state: 'reserved',
  requestId,
  createdAt: new Date().toISOString(),
})

/**
 * 同进程两个连接争抢时，败者可能拿到 UNIQUE（唯一索引裁决）也可能拿到 database is locked：
 * node:sqlite 的 BEGIN IMMEDIATE 是同步忙等，会阻塞事件循环，使同一进程内 FIFO 序列化的
 * 另一笔事务无法提交。两种败因都意味着「没有第二个承接成立」，本用例锁定这个不变量，
 * 并在跨进程用例中断言唯一索引这条清晰路径。
 */
test('同一执行意图并发申领：同一进程两个连接只有一个写入成功', async () => {
  const root = await mkdtemp(join(tempRoot, 'wemux-p01-claims-')), path = join(root, 'server.sqlite')
  try {
    await seed(path)
    const left = new SqliteServerStore(path), right = new SqliteServerStore(path)
    try {
      const results = await Promise.allSettled([
        left.transaction(tx => tx.tasks.saveDispatchClaim(claim('worker-a', 'req-a'))),
        right.transaction(tx => tx.tasks.saveDispatchClaim(claim('worker-b', 'req-b'))),
      ])
      const fulfilled = results.filter(entry => entry.status === 'fulfilled')
      assert.equal(fulfilled.length, 1, '有效承接必须唯一')
      const rejected = results.filter(entry => entry.status === 'rejected') as PromiseRejectedResult[]
      assert.equal(rejected.length, 1)
      assert.match(String(rejected[0].reason?.message ?? rejected[0].reason), /UNIQUE|constraint|database is locked/i)
      const active = await left.tasks.activeDispatchClaim('intent-1')
      assert.ok(active, '胜出者留下唯一有效承接')
      assert.equal(await left.tasks.dispatchClaimByRequest('intent-1', active.requestId === 'req-a' ? 'req-b' : 'req-a'), null, '败者不得留下承接记录')
    } finally { left.close(); right.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('多进程同时申领同一执行意图：恰好一个进程获得承接', async t => {
  const root = await mkdtemp(join(tempRoot, 'wemux-p01-claims-proc-')), path = join(root, 'server.sqlite')
  try {
    await seed(path)
    const script = join(root, 'claim.mjs')
    await writeFile(script, `import { SqliteServerStore } from ${JSON.stringify(join(repoRoot, 'apps/server/src/storage/sqlite/store.ts'))}
const [dbPath, workerId, requestId, startAt] = process.argv.slice(2)
const store = new SqliteServerStore(dbPath)
await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())))
try {
  await store.transaction(tx => tx.tasks.saveDispatchClaim({ claimId: 'claim-' + workerId, intentId: 'intent-1', taskId: 'task-1', workerId, generation: 0, state: 'reserved', requestId, createdAt: new Date().toISOString() }))
  console.log('CLAIMED')
} catch (error) {
  console.log('REJECTED ' + String(error?.message ?? error).slice(0, 120))
} finally { store.close() }
`, 'utf8')
    const startAt = Date.now() + 1200
    const children = ['worker-a', 'worker-b', 'worker-c', 'worker-d'].map(workerId => new Promise<{ workerId: string; stdout: string }>(resolve => {
      const child = spawn(process.execPath, ['--import', 'tsx', script, path, workerId, `req-${workerId}`, String(startAt)], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.on('close', () => resolve({ workerId, stdout: stdout.trim() }))
    }))
    const results = await Promise.all(children)
    const claimed = results.filter(entry => entry.stdout.includes('CLAIMED'))
    t.diagnostic(results.map(entry => `${entry.workerId}: ${entry.stdout}`).join('\n'))
    assert.equal(claimed.length, 1, '跨进程并发申领必须恰好一个成功')
    for (const entry of results.filter(item => item !== claimed[0])) assert.match(entry.stdout, /REJECTED/)
    const observer = new SqliteServerStore(path)
    try {
      const active = await observer.tasks.activeDispatchClaim('intent-1')
      assert.ok(active, '数据库中只留下一个有效承接')
      assert.equal(active?.workerId, claimed[0].workerId)
      assert.equal((await observer.tasks.dispatchClaimByRequest('intent-1', `req-${active!.workerId}`))?.claimId, active?.claimId, '胜出请求可按 requestId 幂等重放')
    } finally { observer.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('释放承接后可重新建立承接，且释放记录保留', async () => {
  const root = await mkdtemp(join(tempRoot, 'wemux-p01-claims-rel-')), path = join(root, 'server.sqlite')
  try {
    await seed(path)
    const store = new SqliteServerStore(path)
    try {
      await store.transaction(tx => tx.tasks.saveDispatchClaim(claim('worker-a', 'req-a')))
      const held = (await store.tasks.activeDispatchClaim('intent-1'))!
      await store.transaction(tx => tx.tasks.saveDispatchClaim({ ...held, state: 'released' }))
      assert.equal(await store.tasks.activeDispatchClaim('intent-1'), null, '释放后不再占用该执行意图')
      await store.transaction(tx => tx.tasks.saveDispatchClaim(claim('worker-b', 'req-b')))
      const active = (await store.tasks.activeDispatchClaim('intent-1'))!
      assert.equal(active.workerId, 'worker-b')
      assert.equal(active.requestId, 'req-b')
      assert.equal((await store.tasks.dispatchClaim(held.claimId))?.state, 'released', '释放记录保留可追溯')
    } finally { store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('结果未知的承接仍然占用执行意图，不凭超时释放', async () => {
  const root = await mkdtemp(join(tempRoot, 'wemux-p01-claims-unk-')), path = join(root, 'server.sqlite')
  try {
    await seed(path)
    const store = new SqliteServerStore(path)
    try {
      await store.transaction(tx => tx.tasks.saveDispatchClaim(claim('worker-a', 'req-a')))
      const held = (await store.tasks.activeDispatchClaim('intent-1'))!
      await store.transaction(tx => tx.tasks.saveDispatchClaim({ ...held, state: 'unknown' }))
      assert.equal((await store.tasks.activeDispatchClaim('intent-1'))?.state, 'unknown')
      await assert.rejects(store.transaction(tx => tx.tasks.saveDispatchClaim(claim('worker-b', 'req-b'))), /UNIQUE|constraint/i)
    } finally { store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('执行意图的身份与入队序号不可重写，状态可推进', async () => {
  const root = await mkdtemp(join(tempRoot, 'wemux-p01-intent-')), path = join(root, 'server.sqlite')
  try {
    await seed(path)
    const store = new SqliteServerStore(path)
    try {
      const intent = (await store.tasks.dispatchIntent('intent-1'))!
      assert.equal(intent.queueOrder, 1)
      assert.deepEqual(intent.machineScope, { kind: 'any' })
      assert.equal((await store.tasks.dispatchQueue()).length, 1, '待安排队列按持久入队序号暴露')
      await store.transaction(tx => tx.tasks.saveDispatchIntent({ ...intent, state: 'claimed' }))
      assert.equal((await store.tasks.dispatchIntent('intent-1'))?.state, 'claimed')
      await assert.rejects(store.transaction(tx => tx.tasks.saveDispatchIntent({ ...intent, queueOrder: 9 } as DispatchIntentRecord)), /Immutable dispatch intent identity/)
      // 排队期间允许改机器范围（启动前须重新核验），但身份与入队序号不可重写。
      await store.transaction(tx => tx.tasks.saveDispatchIntent({ ...intent, machineScope: { kind: 'fixed', workerId: 'worker-a' } }))
      assert.deepEqual((await store.tasks.dispatchIntent('intent-1'))?.machineScope, { kind: 'fixed', workerId: 'worker-a' })
    } finally { store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
