import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentKey, ModelId, SessionId, UserId } from '@wemux/domain'
import { adminRouteFixture } from './fixtures/admin-route-fixture.ts'
import { seedLocalAccount } from './fixtures/administrator.js'

const outsiderEmail = 'lineage-outsider@example.test'
const outsiderPassword = 'private outsider password 123'
const outsiderId = 'lineage-outsider' as UserId
const outsiderToken = 'synthetic-lineage-outsider'

type Fixture = Awaited<ReturnType<typeof adminRouteFixture>>

/**
 * 画布与 Fork 验收需要一个真实可用的执行环境：Worker 上声明可执行的 Agent，
 * 工作区在该 Worker 上有就绪落点。fixture 只提供逻辑工作区，因此这里补上物理事实，
 * 让 Fork 走 createForkTargetInTx 的真实校验，而不是绕过它。
 */
async function makeForkTargetReady(fixture: Fixture) {
  await fixture.app.store.transaction(async tx => {
    const worker = (await tx.resources.getWorker(fixture.worker.workerId))!
    // Team 级共享：项目成员据此获得 Worker 使用权限（fixture 默认 owner 独占）。
    await tx.resources.saveWorker({
      ...worker, connectionState: 'online', shareScope: 'team',
      capabilities: [{ agentKey: 'fixture' as AgentKey, displayName: 'Fixture Agent', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'fixture' as ModelId, displayName: 'Fixture Model', source: 'detected' }] }],
    })
    const workspace = (await tx.resources.getWorkspace(fixture.workspace.id))!
    await tx.resources.saveWorkspace({ ...workspace, status: 'ready', placements: [{ workerId: fixture.worker.workerId, status: 'ready', failureReason: null, location: null }] })
  })
}

const forkBody = (fixture: Fixture, requestId: string) => ({
  requestId,
  sourceSessionId: fixture.sessionId,
  targetWorkspaceId: fixture.workspace.id,
  targetWorkerId: fixture.worker.workerId,
  targetAgentKey: 'fixture',
  targetModelId: 'fixture',
})

// 画布与 Fork 属于产品能力，不是实例管理员专属：项目成员按内容权限读图与 Fork。
test('Team 成员按会话权限读取画布、在同 Task 下固定 cursor Fork 并追溯血缘', async t => {
  const fixture = await adminRouteFixture()
  t.after(() => fixture.close())
  await makeForkTargetReady(fixture)
  const member = { token: fixture.accounts.member.token }
  const project = `/projects/${fixture.project.id}`

  const before = await fixture.app.store.transaction(async tx => ({
    session: await tx.resources.getSession(fixture.sessionId as SessionId),
    forks: await tx.resources.listSessionForks(fixture.project.id),
  }))
  assert.equal(before.forks.length, 0)

  const initial = await fixture.request(`${project}/session-graph`, member)
  assert.equal(initial.status, 200, JSON.stringify(initial.data))
  assert.deepEqual(initial.data.graph.nodes.map((node: any) => node.sessionId), [fixture.sessionId])
  assert.deepEqual(initial.data.graph.edges, [])

  const first = await fixture.request(`${project}/session-forks`, { ...member, body: forkBody(fixture, 'member-fork-1') })
  assert.equal(first.status, 201, JSON.stringify(first.data))
  const forkId = first.data.fork.forkId as string
  const targetId = first.data.fork.targetSessionId as string
  assert.equal(first.data.fork.sourceSessionId, fixture.sessionId)
  // 固定 cursor：来源尚无持久事件时边界为 0，且策略如实回报 through_cursor。
  assert.equal(first.data.fork.sourceEventCursor, 0)
  assert.equal(first.data.replayed, false)
  assert.notEqual(targetId, fixture.sessionId)

  // 幂等重放不重复创建目标，也不产生第二条边。
  const replay = await fixture.request(`${project}/session-forks`, { ...member, body: forkBody(fixture, 'member-fork-1') })
  assert.equal(replay.status, 201, JSON.stringify(replay.data))
  assert.equal(replay.data.replayed, true)
  assert.equal(replay.data.fork.forkId, forkId)
  assert.equal(replay.data.fork.targetSessionId, targetId)
  const afterFork = await fixture.app.store.transaction(async tx => ({
    forks: await tx.resources.listSessionForks(fixture.project.id),
    target: await tx.resources.getSession(targetId as never),
  }))
  assert.equal(afterFork.forks.length, 1)
  // 同 Task：目标继承来源 Task，且归属 Fork 操作者。
  assert.equal(afterFork.target!.taskId, before.session!.taskId)
  assert.equal(afterFork.target!.ownerId, fixture.accounts.member.id)
  const taskSessions = await fixture.request(`${project}/tasks/${fixture.task.id}/sessions`, member)
  assert.equal(taskSessions.status, 200, JSON.stringify(taskSessions.data))
  const taskSessionIds = taskSessions.data.items.map((item: any) => item.id)
  assert.ok(taskSessionIds.includes(fixture.sessionId), JSON.stringify(taskSessionIds))
  assert.ok(taskSessionIds.includes(targetId), JSON.stringify(taskSessionIds))

  // 血缘可追溯：来源侧出现子分支，目标侧出现祖先，边详情只在两端可读时返回。
  const sourceLineage = await fixture.request(`/sessions/${fixture.sessionId}/lineage`, member)
  assert.equal(sourceLineage.status, 200, JSON.stringify(sourceLineage.data))
  assert.deepEqual(sourceLineage.data.ancestors, [])
  assert.deepEqual(sourceLineage.data.children.map((point: any) => point.forkId), [forkId])
  assert.equal(sourceLineage.data.children[0].sourceEventCursor, 0)
  const targetLineage = await fixture.request(`/sessions/${targetId}/lineage`, member)
  assert.equal(targetLineage.status, 200)
  assert.deepEqual(targetLineage.data.ancestors.map((point: any) => point.forkId), [forkId])
  assert.deepEqual(targetLineage.data.children, [])
  const point = await fixture.request(`/session-forks/${forkId}`, member)
  assert.equal(point.status, 200)
  assert.equal(point.data.fork.targetSessionId, targetId)

  const memberGraph = await fixture.request(`${project}/session-graph`, member)
  assert.equal(memberGraph.status, 200)
  assert.deepEqual(memberGraph.data.graph.nodes.map((node: any) => node.sessionId).sort(), [fixture.sessionId, targetId].sort())
  assert.deepEqual(memberGraph.data.graph.edges.map((edge: any) => [edge.sourceSessionId, edge.targetSessionId]), [[fixture.sessionId, targetId]])
  assert.equal(memberGraph.data.graph.edges[0].relation.type, 'fork')
  const source = memberGraph.data.graph.nodes.find((node: any) => node.sessionId === fixture.sessionId)
  // branchCount 只统计当前 viewer 可见的出边。
  assert.equal(source.summary.branchCount, 1)
  assert.match(memberGraph.data.graph.revision, /^g[a-f0-9]{16}$/)
  assert.notEqual(memberGraph.data.graph.revision, initial.data.graph.revision)
  // 共享图内容不得进入任何中间缓存（成员凭 Bearer 直取原始响应核对头部）。
  const rawGraph = await fetch(`${fixture.origin}/api${project}/session-graph`, { headers: { Authorization: `Bearer ${member.token}` } })
  assert.equal(rawGraph.status, 200)
  assert.equal(rawGraph.headers.get('cache-control'), 'no-store')

  // Fork 不修改原会话历史：来源行逐字段不变，血缘是独立投影。
  const after = await fixture.app.store.transaction(async tx => ({
    session: await tx.resources.getSession(fixture.sessionId as SessionId),
    freshness: await tx.cache.getFreshness(fixture.sessionId as SessionId),
  }))
  assert.deepEqual(after.session, before.session)
  assert.equal(after.freshness?.contiguousSeq ?? 0, 0)
  assert.equal((await fixture.request(`/sessions/${fixture.sessionId}`, member)).status, 200)
})

test('非成员被拒；撤权后列表、血缘、边详情与图谱四个出口同步停止提供', async t => {
  const fixture = await adminRouteFixture()
  t.after(() => fixture.close())
  await makeForkTargetReady(fixture)
  const member = { token: fixture.accounts.member.token }
  const project = `/projects/${fixture.project.id}`

  await seedLocalAccount(fixture.app.store, { userId: outsiderId, username: outsiderEmail, email: outsiderEmail, password: outsiderPassword })
  await fixture.pat(outsiderId, outsiderToken, ['read', 'write', 'execute'])
  const outsider = { token: outsiderToken }
  const denied = [
    await fixture.request(`${project}/session-graph`, outsider),
    await fixture.request(`/sessions/${fixture.sessionId}/lineage`, outsider),
    await fixture.request('/session-forks/unknown-fork', outsider),
    await fixture.request(`${project}/session-forks`, { ...outsider, body: forkBody(fixture, 'outsider-fork') }),
  ]
  for (const response of denied) {
    assert.equal(response.status, 404, JSON.stringify(response.data))
    assert.equal(JSON.stringify(response.data).includes('Private Session'), false)
  }

  const fork = await fixture.request(`${project}/session-forks`, { ...member, body: forkBody(fixture, 'member-fork-2') })
  assert.equal(fork.status, 201, JSON.stringify(fork.data))
  const forkId = fork.data.fork.forkId as string
  const targetId = fork.data.fork.targetSessionId as string

  // 撤权前：成员看到两个节点与一条边；项目所有者看不到私有目标，因此也看不到这条边。
  const visible = await fixture.request(`${project}/session-graph`, member)
  assert.deepEqual(visible.data.graph.nodes.map((node: any) => node.sessionId).sort(), [fixture.sessionId, targetId].sort())
  const ownerGraph = await fixture.request(`${project}/session-graph`)
  assert.equal(ownerGraph.status, 200)
  assert.deepEqual(ownerGraph.data.graph.nodes.map((node: any) => node.sessionId), [fixture.sessionId])
  assert.deepEqual(ownerGraph.data.graph.edges, [])

  const revoke = await fixture.request(`${project}/grants/${fixture.accounts.member.id}`, { method: 'DELETE' })
  assert.equal(revoke.status, 204, JSON.stringify(revoke.data))
  fixture.app.service.notifications.authorization(fixture.accounts.member.id as UserId)

  const revoked = [
    await fixture.request(`${project}/session-graph`, member),
    await fixture.request(`/sessions/${fixture.sessionId}/lineage`, member),
    await fixture.request(`/sessions/${targetId}/lineage`, member),
    await fixture.request(`/session-forks/${forkId}`, member),
  ]
  for (const response of revoked) {
    assert.equal(response.status, 404, JSON.stringify(response.data))
    assert.equal(JSON.stringify(response.data).includes(fixture.sessionId), false)
    assert.equal(JSON.stringify(response.data).includes(targetId), false)
  }
  const list = await fixture.request('/sessions', member)
  assert.equal(list.status, 200)
  const ids = list.data.items.map((item: any) => item.id)
  assert.equal(ids.includes(fixture.sessionId), false, JSON.stringify(ids))
  assert.equal(ids.includes(targetId), false, JSON.stringify(ids))
  assert.equal(list.data.items.some((item: any) => item.projectId === fixture.project.id), false)
  // 撤权只影响被撤权者；项目所有者仍以同一权限投影读取来源。
  const ownerAfter = await fixture.request(`${project}/session-graph`)
  assert.deepEqual(ownerAfter.data.graph, ownerGraph.data.graph)
})
