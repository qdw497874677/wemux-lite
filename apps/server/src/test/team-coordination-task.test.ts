import test from 'node:test'
import assert from 'node:assert/strict'
import type { Timestamp, UserId, TeamId, AgentKey, ModelId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { ServerService } from '../application/server-service.js'
import { Notifications } from '../application/notifications.js'
import { TaskService } from '../application/task-service.js'
import { AppError } from '../application/errors.ts'
import { seedOperator } from './fixtures/administrator.js'
import { coordinationAnchor, coordinationActivityState, coordinationTaskId, teamCoordinationTask, assertTeamCoordinationCreator, coordinationQueryOperations } from '../application/team-coordination-task.ts'
import type { TaskDetail } from '@wemux/web-contract/task-platform'

const timestamp = '2026-10-07T00:00:00.000Z' as Timestamp
const context = { actor: 'deployer-user' as UserId, requestId: 'coordination-test' }

async function fixture() {
  const store = new SqliteServerStore(':memory:')
  const server = new ServerService(store, new Notifications())
  const operator = await seedOperator(store, server)
  const enrollment = await server.createEnrollment({})
  const { worker } = await server.enroll({ token: enrollment.token, name: 'Coord worker' })
  await store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }))
  await store.transaction(async tx => {
    await tx.identity.saveTeam({ id: 'other-team' as TeamId, name: '其他团队', createdAt: timestamp })
    await tx.identity.saveUser({ id: 'outsider' as UserId, username: 'outsider', email: 'outsider@wemux.test', createdAt: timestamp, status: 'active', authVersion: 0, statusChangedAt: timestamp, deletedAt: null })
  })
  const tasks = new TaskService(store, () => {}, server)
  return { store, server, tasks, operator, worker }
}

const identity = (teamId: string, ownerId = 'deployer-user') => ({ teamId, ownerId, workerId: 'worker-1', agentKey: 'test' })

test('同复用键并发创建幂等收敛到一个协调 Task', async () => {
  const f = await fixture()
  try {
    const teamId = f.operator.team.id
    const key = identity(teamId)
    const ids = await Promise.all([0, 1, 2].map(attempt => f.store.transaction(tx => teamCoordinationTask(tx, key, `request-${attempt}`))))
    assert.deepEqual(new Set(ids), new Set([coordinationTaskId(key)]))
    const stored = await f.store.transaction(tx => tx.tasks.get(ids[0]))
    assert.equal(stored?.teamCoordination?.teamId, teamId)
    assert.equal(stored?.projectId, coordinationAnchor(teamId))
    const activities = await f.store.transaction(tx => tx.tasks.activity(ids[0], 0))
    assert.equal(activities.filter(item => item.type === 'task.created').length, 1)
    // 复用（重开上下文 = 新 Session 事务）返回同一 Task，不产生第二行。
    const again = await f.store.transaction(tx => teamCoordinationTask(tx, key, 'request-reuse'))
    assert.equal(again, ids[0])
  } finally { f.store.close() }
})

test('Team 成员资格在创建事务内校验：非成员与跨 Team 拒绝', async () => {
  const f = await fixture()
  try {
    const teamId = f.operator.team.id
    await assert.rejects(f.store.transaction(tx => assertTeamCoordinationCreator(tx, identity('other-team'))), (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.status, 403)
      assert.equal(error.code, 'forbidden')
      return true
    })
    await assert.rejects(f.store.transaction(tx => teamCoordinationTask(tx, identity('other-team'), 'r1')), /Team membership required/)
    await assert.rejects(f.store.transaction(tx => teamCoordinationTask(tx, identity(teamId, 'outsider'), 'r2')), /Team membership required/)
    const created = await f.store.transaction(tx => teamCoordinationTask(tx, identity(teamId), 'r3'))
    assert.equal(created, coordinationTaskId(identity(teamId)))
  } finally { f.store.close() }
})

test('身份冲突 409 不泄漏已存 Task 元数据，删除后 410', async () => {
  const f = await fixture()
  try {
    const teamId = f.operator.team.id
    const plantedId = coordinationTaskId(identity(teamId))
    const planted: TaskDetail = {
      id: plantedId, projectId: coordinationAnchor(teamId), title: 'PLANTED-SECRET-TITLE',
      description: 'planted', acceptanceCriteria: null, priority: 'none', status: 'backlog', version: 1,
      assignee: null, origin: 'manual', teamCoordination: { teamId, ownerId: 'someone-else', workerId: 'worker-1', agentKey: 'test' },
      activeRun: null, currentReviewId: null, linkCount: 0, createdAt: timestamp, updatedAt: timestamp,
      lastActivityAt: timestamp, blockedFrom: null, cancelledFrom: null, workspaces: [], links: [],
      metadataJson: { schemaVersion: 1, values: {} },
    }
    await f.store.transaction(async tx => {
      await tx.tasks.save(planted)
      await assert.rejects(teamCoordinationTask(tx, identity(teamId), 'r1'), (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.status, 409)
        assert.equal(error.code, 'request_id_conflict')
        assert.equal(JSON.stringify(error).includes('PLANTED-SECRET-TITLE'), false)
        return true
      })
      await tx.tasks.save({ ...planted, deletedAt: timestamp, deletedBy: 'someone-else', teamCoordination: { teamId, ownerId: 'deployer-user', workerId: 'worker-1', agentKey: 'test' }, title: 'DELETED-COORDINATION' })
      await assert.rejects(teamCoordinationTask(tx, identity(teamId), 'r2'), (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.status, 410)
        assert.equal(JSON.stringify(error).includes('DELETED-COORDINATION'), false)
        return true
      })
    })
  } finally { f.store.close() }
})

test('浏览与列表零新建；普通 Project task.list 排除协调 Task', async () => {
  const f = await fixture()
  try {
    const teamId = f.operator.team.id, projectId = f.operator.project.id
    const before = (await f.tasks.list(projectId, context)).length
    const id = await f.store.transaction(tx => teamCoordinationTask(tx, identity(teamId), 'r1'))
    const after = (await f.tasks.list(projectId, context)).length
    assert.equal(after, before)
    const listed = await f.store.transaction(tx => tx.tasks.list(projectId))
    assert.equal(listed.some(task => task.id === id), false)
    for (let round = 0; round < 3; round++) await f.store.transaction(tx => tx.tasks.get(id))
    const anchored = await f.store.transaction(tx => tx.tasks.list(coordinationAnchor(teamId)))
    assert.equal(anchored.length, 1)
    // 协调 Task 不可作为普通 Project Task 读取：project() 或 task() 归属检查拒绝。
    await assert.rejects(f.tasks.get(projectId, id, context), /not found/i)
    await assert.rejects(f.tasks.get(coordinationAnchor(teamId), id, context), /not found/i)
    await assert.rejects(f.tasks.activity(projectId, id, 0, context), /not found/i)
  } finally { f.store.close() }
})

test('active/waiting 投影纯推导，不写普通审查字段', async () => {
  assert.equal(coordinationActivityState(['idle']), 'waiting')
  assert.equal(coordinationActivityState(['idle', 'queued']), 'active')
  assert.equal(coordinationActivityState(['running']), 'active')
  assert.equal(coordinationActivityState(['stopping']), 'active')
  assert.equal(coordinationActivityState(['failed', 'unavailable']), 'waiting')
  const f = await fixture()
  try {
    const teamId = f.operator.team.id
    const id = await f.store.transaction(tx => teamCoordinationTask(tx, identity(teamId), 'r1'))
    const projection = coordinationActivityState(['running'])
    const stored = await f.store.transaction(tx => tx.tasks.get(id))
    assert.equal(stored?.status, 'backlog')
    assert.equal(stored?.currentReviewId ?? null, null)
    assert.equal(stored?.activeRun ?? null, null)
    assert.notEqual(projection, stored?.status)
  } finally { f.store.close() }
})

test('协调 Task 不进入普通 Project 执行面：Session 溯源与写入通道拒绝', async () => {
  const f = await fixture()
  try {
    const teamId = f.operator.team.id, projectId = f.operator.project.id
    const id = await f.store.transaction(tx => teamCoordinationTask(tx, identity(teamId), 'r1'))
    const ordinary = await f.tasks.create(projectId, { title: '普通任务' }, context)
    const created = await f.tasks.createWorkspace(projectId, ordinary.id, { name: '对照工作区', workerId: f.worker.id, source: 'empty' }, context)
    // 普通 Project Session 不能把协调 Task 当溯源（projectId 锚不匹配）。
    await assert.rejects(
      f.store.transaction(tx => f.server.createSessionInTx(tx, { requestId: 'coord-1', title: '换绑尝试', workspaceId: created.workspace.id, workerId: f.worker.id, agentKey: 'test', modelId: 'model' }, { taskId: id, runId: null, ownerId: context.actor, shareScope: 'project' })),
      (error: unknown) => { assert.ok(error instanceof AppError); assert.equal(error.status, 404); return true },
    )
    // 普通 Task 写路径（patch/assignment/launch/completion）都经过 task() 守卫。
    await assert.rejects(f.tasks.patch(projectId, id, { status: 'done', version: 1 }, context), /not found/i)
    await assert.rejects(f.tasks.assignment(projectId, id, { version: 1, assignee: { workspaceId: created.workspace.id, workerId: f.worker.id, agentKey: 'test', modelId: 'model' } }, false, context), /not found/i)
    await assert.rejects(f.tasks.launch(projectId, id, { requestId: 'run-1', mode: 'new', reuseSessionId: null, prompt: 'x', assignment: { workspaceId: created.workspace.id, workerId: f.worker.id, agentKey: 'test', modelId: 'model' } }, context), /not found/i)
  } finally { f.store.close() }
})

test('协调身份 allowedTools 只含只读查询 operation', () => {
  const writeClass = ['mcp.call', 'http.call', 'mcp.list_tools', 'task.create', 'agent.send', 'delegation.accept', 'delegation.complete', 'file.write', 'terminal.write', 'channel.deliver']
  for (const operation of writeClass) assert.equal((coordinationQueryOperations as readonly string[]).includes(operation), false, `${operation} 不在协调 allowedTools`)
  for (const operation of coordinationQueryOperations) assert.match(operation, /^(session|project|task|agent)\.(info|list|get|resources|sessions|events)$/, `${operation} 应为只读查询`)
})
