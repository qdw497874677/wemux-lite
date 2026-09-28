import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteDelegationRepository } from '../storage/sqlite/delegation-repository.ts'
import { SharedSqliteDatabase } from '../storage/sqlite/shared-database.ts'
import { SqliteServerStore } from '../storage/sqlite/store.ts'

const at = '2026-04-01T00:00:00.000Z'
const delegation = {
  id: 'delegation-concurrent', dispatchId: 'dispatch-concurrent', objective: '验证并发写排队',
  source: { projectId: 'project-1', sessionId: 'session-source', agentId: 'agent-source', userId: 'user-1', canonicalSessionId: 'session-source' },
  target: { projectId: 'project-1', sessionId: 'session-target', workerId: 'worker-1', agentId: 'agent-target' },
  authority: { capabilities: [], allowedProjectIds: ['project-1'] }, ancestorAgentIds: [], depth: 1,
  status: 'dispatched', version: 1, childRunId: null, resultSummary: null, createdAt: at, updatedAt: at,
} as never

test('共享 Server 数据库连接会把跨仓储写排在异步事务之后', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-sqlite-concurrency-'))
  const database = new SharedSqliteDatabase(join(directory, 'server.sqlite'))
  const store = new SqliteServerStore(database)
  const delegations = new SqliteDelegationRepository(database)
  try {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const transactionEntered = new Promise<void>(resolve => { entered = resolve })
    const transaction = store.transaction(async tx => {
      await tx.audit.append({
        id: 'audit-concurrent', actorId: null, action: 'sqlite.concurrent',
        resource: { kind: 'project', id: 'project-1' }, result: 'succeeded',
        occurredAt: at, metadata: {},
      } as never)
      entered()
      await gate
    })
    await transactionEntered

    const delegationWrite = delegations.saveDelegation(delegation)
    await new Promise(resolve => setTimeout(resolve, 10))
    release()

    await transaction
    await delegationWrite
    assert.equal((await delegations.getDelegation('delegation-concurrent'))?.id, 'delegation-concurrent')
  } finally {
    delegations.close()
    store.close()
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})
