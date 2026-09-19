import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AgentKey, ModelId, SessionForkId, SessionId, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import type { Session } from '@wemux/server-domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { ServerService, now } from '../application/server-service.js'
import { SessionLineageService } from '../application/session-lineage-service.js'
import { Notifications } from '../application/notifications.js'
import { AuthenticationService } from '../application/auth.js'
import { httpHandler } from '../http/handler.js'
import { SessionStreams } from '../http/sse.js'
import { seedOperator, administratorDirectory } from './fixtures/administrator.js'

/**
 * Ticket 17: Fork 与血缘权威。这里的断言针对后端持久事实，不涉及任何画布渲染类型；
 * 图端点的输出必须是领域 DTO，节点/边由服务端决定，客户端不参与拼装。
 */


async function fixture(path = ':memory:') {
  const store = new SqliteServerStore(path)
  const notifications = new Notifications()
  const service = new ServerService(store, notifications)
  const { project, user, token } = await seedOperator(store, service)
  const { worker } = await service.enroll({ token: (await service.createEnrollment({})).token, name: 'lineage-worker' })
  await store.transaction(tx => tx.resources.saveWorker({
    ...worker,
    capabilities: [{ agentKey: 'pi' as AgentKey, displayName: 'Pi', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'pi-model' as ModelId, displayName: 'Pi model', source: 'detected' }, { modelId: 'pi-model-2' as ModelId, displayName: 'Pi model 2', source: 'detected' }] }],
  }))
  const ready = async (workspaceId: WorkspaceId) => store.transaction(async tx => {
    const workspace = (await tx.resources.getWorkspace(workspaceId))!
    await tx.resources.saveWorkspace({ ...workspace, status: 'ready', placements: workspace.placements.map(placement => ({ ...placement, status: 'ready' as const })) })
  })
  const { workspace } = await service.createWorkspace({ projectId: project!.id, workerId: worker.id, name: 'main' })
  await ready(workspace.id)
  const create = (title: string) => service.createSession({ requestId: `create-${title}`, workspaceId: workspace.id, title, agentKey: 'pi', modelId: 'pi-model' })
  const { session: source } = await create('source')
  let seq = 0
  const append = (sessionId: SessionId, count: number) => store.transaction(tx => tx.cache.applyEvents(sessionId, Array.from({ length: count }, () => ({ sessionId, seq: ++seq as never, occurredAt: now(), payload: { kind: 'assistant.text.delta' as const, turnId: `turn-${seq}` as never, text: 'x' } }))))
  await append(source.id, 3)
  const lineage = new SessionLineageService(store, service, administratorDirectory(store), undefined, notifications)
  const fork = (command: Record<string, unknown>) => lineage.fork({ operator: user!.id, projectId: project!.id, command: { sourceSessionId: source.id, targetWorkspaceId: workspace.id, targetWorkerId: worker.id, targetAgentKey: 'pi', targetModelId: 'pi-model', requestId: 'fork-1', ...command } })
  const sessions = async () => store.transaction(tx => tx.resources.listSessions())
  const streams = new SessionStreams(service)
  const server = createServer(httpHandler(service, new AuthenticationService(store, administratorDirectory(store)), streams, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, lineage))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return {
    store, service, lineage, notifications, project: project!, user: user!, worker, workspace, source, ready, create, append, fork, sessions, request, baseUrl: `http://127.0.0.1:${address.port}`,
    /** 把目标 Session 转给另一个用户，用来构造“只能看见下游”的受试者。 */
    handOver: (session: Session, ownerId: UserId) => store.transaction(tx => tx.resources.saveSession({ ...session, ownerId })),
    other: async (id: string) => {
      await store.transaction(async tx => {
        await tx.identity.saveUser({ id: id as UserId, username: id, email: null, createdAt: now() })
        await tx.identity.saveMembership({ teamId: (await tx.identity.getTeam('default-team' as never))!.id, userId: id as UserId, role: 'member', joinedAt: now() })
      })
      return id as UserId
    },
    async close() { streams.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close() },
  }
}

test('fork creates the target Session, binding snapshot, durable cursor and audit in one transaction', async t => {
  const f = await fixture(); t.after(() => f.close())
  const result = await f.fork({ sourceEventCursor: 2 })
  assert.equal(result.replayed, false)
  assert.equal(result.fork.sourceSessionId, f.source.id)
  assert.equal(result.fork.sourceEventCursor, 2)
  assert.equal(result.fork.targetSessionId, result.targetSessionId)
  assert.match(result.graphRevision, /^g[0-9a-f]{16}$/)
  const target = (await f.sessions()).find(session => session.id === result.targetSessionId)!
  assert.deepEqual(target.binding, { workspaceId: f.workspace.id, agent: { workerId: f.worker.id, agentKey: 'pi' }, modelId: 'pi-model' })
  assert.equal(target.ownerId, f.user.id)
  assert.equal(target.title, 'source（分支）')
  const audit = await f.store.identity.listAudit(10)
  assert.equal(audit[0]!.action, 'session.fork')
  assert.equal(audit[0]!.resource.id, target.id)
  // 来源后续事件不移动已固定的边界。
  await f.append(f.source.id, 5)
  const forks = await f.store.transaction(tx => tx.resources.listSessionForks(f.project.id))
  assert.equal(forks[0]!.sourceEventCursor, 2)
  // 目标 Session 与来源相互独立：目标没有复制任何来源事件。
  const page = await f.store.transaction(tx => tx.cache.readEvents(result.targetSessionId, 1 as never, 10))
  assert.deepEqual(page.events, [])
})

test('replayed forks are idempotent and a changed payload under the same requestId is rejected', async t => {
  const f = await fixture(); t.after(() => f.close())
  const first = await f.fork({ sourceEventCursor: 1 })
  const replay = await f.fork({ sourceEventCursor: 1 })
  assert.equal(replay.replayed, true)
  assert.equal(replay.targetSessionId, first.targetSessionId)
  assert.equal(replay.fork.forkId, first.fork.forkId)
  assert.equal((await f.sessions()).length, 2, 'replay must not create a second Session')
  const conflict = await f.fork({ sourceEventCursor: 2 }).catch(error => error)
  assert.equal(conflict.status, 409)
  assert.equal(conflict.code, 'request_id_conflict')
  assert.equal((await f.sessions()).length, 2)
  // 不同 requestId 得到独立分支，且各自记录自己的边界。
  const other = await f.fork({ requestId: 'fork-2', sourceEventCursor: 3 })
  assert.notEqual(other.targetSessionId, first.targetSessionId)
  assert.equal(other.fork.sourceEventCursor, 3)
})

test('fork rejects a cursor ahead of the durable sequence, unsupported policies and unknown fields', async t => {
  const f = await fixture(); t.after(() => f.close())
  const ahead = await f.fork({ sourceEventCursor: 9 }).catch(error => error)
  assert.equal(ahead.status, 409)
  assert.equal(ahead.code, 'cursor_not_durable')
  for (const policy of ['summary', 'explicit_selection']) {
    const rejected = await f.fork({ requestId: `fork-${policy}`, contextPolicy: policy }).catch(error => error)
    assert.equal(rejected.status, 400)
    assert.equal(rejected.code, 'unsupported_context_policy')
  }
  const unknown = await f.fork({ requestId: 'fork-unknown', surprise: true }).catch(error => error)
  assert.equal(unknown.status, 400)
  const bogusPolicy = await f.fork({ requestId: 'fork-bogus', contextPolicy: 'nonsense' }).catch(error => error)
  assert.equal(bogusPolicy.status, 400)
  assert.equal((await f.sessions()).length, 1, 'no rejected request may leave a target Session')
})

test('failed forks leave no orphan Session or dangling edge', async t => {
  const f = await fixture(); t.after(() => f.close())
  const before = (await f.sessions()).length
  const otherProject = await f.service.createProject({ name: 'other' })
  const { session: foreign } = await f.service.createSession({ requestId: 'foreign', workspaceId: f.workspace.id, title: 'foreign', agentKey: 'pi', modelId: 'pi-model' })
  await f.store.transaction(tx => tx.resources.saveSession({ ...foreign, projectId: otherProject.id }))
  const crossProject = await f.fork({ requestId: 'fork-cross', sourceSessionId: foreign.id }).catch(error => error)
  assert.equal(crossProject.status, 404)
  const { workspace: otherWorkspace } = await f.service.createWorkspace({ projectId: otherProject.id, workerId: f.worker.id, name: 'other' })
  await f.ready(otherWorkspace.id)
  const scope = await f.fork({ requestId: 'fork-scope', targetWorkspaceId: otherWorkspace.id }).catch(error => error)
  assert.equal(scope.status, 409)
  assert.equal(scope.code, 'fork_target_scope')
  await f.store.transaction(tx => tx.resources.saveWorkspace({ ...(otherWorkspace), projectId: f.project.id, deletedAt: now() }))
  const deleted = await f.fork({ requestId: 'fork-deleted', targetWorkspaceId: otherWorkspace.id }).catch(error => error)
  assert.equal(deleted.status, 409)
  assert.equal(deleted.code, 'fork_target_deleted')
  const unavailable = await f.fork({ requestId: 'fork-agent', targetAgentKey: 'ghost' }).catch(error => error)
  assert.equal(unavailable.status, 409)
  assert.equal(unavailable.message, 'Agent unavailable')
  const noModel = await f.fork({ requestId: 'fork-model', targetModelId: 'ghost-model' }).catch(error => error)
  assert.equal(noModel.status, 409)
  assert.equal(noModel.message, 'Model unavailable')
  assert.equal((await f.sessions()).length, before + 1, 'only the deliberately foreign Session was added')
  assert.equal((await f.store.transaction(tx => tx.resources.listSessionForks(f.project.id))).length, 0, 'no dangling edge survives a rejected Fork')
})

test('lineage returns nearest-first ancestors, direct children and a revision that only moves on real change', async t => {
  const f = await fixture(); t.after(() => f.close())
  const first = await f.fork({ sourceEventCursor: 3 })
  const second = await f.lineage.fork({ operator: f.user.id, projectId: f.project.id, command: { sourceSessionId: first.targetSessionId, targetWorkspaceId: f.workspace.id, targetWorkerId: f.worker.id, targetAgentKey: 'pi', targetModelId: 'pi-model-2', requestId: 'fork-chain' } })
  const grandchild = await f.lineage.lineage({ operator: f.user.id, sessionId: second.targetSessionId })
  assert.deepEqual(grandchild.ancestors.map(point => point.sourceSessionId), [first.targetSessionId, f.source.id], 'ancestors are nearest-first')
  assert.deepEqual(grandchild.children, [])
  const root = await f.lineage.lineage({ operator: f.user.id, sessionId: f.source.id })
  assert.deepEqual(root.children.map(point => point.targetSessionId), [first.targetSessionId], 'only direct children are listed')
  const point = await f.lineage.getForkPoint({ operator: f.user.id, forkId: first.fork.forkId })
  assert.deepEqual(point.fork, first.fork)
  const graph = await f.lineage.getGraph({ operator: f.user.id, query: { projectId: f.project.id } })
  assert.equal(graph.nodes.length, 3)
  assert.deepEqual(graph.edges.map(edge => edge.key), [`fork:${first.fork.forkId}`, `fork:${second.fork.forkId}`])
  assert.equal(point.graphRevision, graph.revision)
  assert.deepEqual((await f.lineage.getGraph({ operator: f.user.id, query: { projectId: f.project.id } })).revision, graph.revision, 'reads do not move the revision')
  const branch = graph.nodes.find(node => node.sessionId === f.source.id)!
  assert.equal(branch.visibility, 'visible')
  assert.equal(branch.summary!.branchCount, 1)
  assert.equal(branch.summary!.modelId, 'pi-model')
  assert.ok(branch.summary!.lastActivityAt, 'durable events produce a real activity time')
  // Fork 不复制事件：目标 Session 没有持久事件时不得编造时间。
  const active = graph.nodes.find(node => node.sessionId === second.targetSessionId)!
  assert.equal(active.summary!.lastActivityAt, null)
  assert.equal(active.summary!.branchCount, 0)
  const moved = await f.fork({ requestId: 'fork-move', sourceEventCursor: 1 })
  assert.notEqual((await f.lineage.getGraph({ operator: f.user.id, query: { projectId: f.project.id } })).revision, graph.revision, 'a new edge moves the revision')
  const local = await f.lineage.getGraph({ operator: f.user.id, query: { projectId: f.project.id, rootSessionId: f.source.id, depth: 1 } })
  assert.deepEqual(local.nodes.map(node => node.sessionId).sort(), [f.source.id, first.targetSessionId, moved.targetSessionId].sort())
  assert.equal((await f.lineage.getGraph({ operator: f.user.id, query: { projectId: f.project.id, rootSessionId: 'ghost' as SessionId } }).catch(error => error)).status, 404)
  assert.equal((await f.lineage.getGraph({ operator: f.user.id, query: { projectId: f.project.id, depth: 99 } }).catch(error => error)).status, 400)
  assert.equal((await f.lineage.getGraph({ operator: f.user.id, query: { projectId: f.project.id, nodeLimit: 0 } }).catch(error => error)).status, 400)
})

test('hidden nodes are placeholders without content, unreadable Projects stay invisible, and deleting a source does not erase descendants', async t => {
  const f = await fixture(); t.after(() => f.close())
  const first = await f.fork({ sourceEventCursor: 2 })
  const stranger = await f.other('stranger')
  // 对 Project 一无所知的操作者拿到的是“不存在”，而不是空图或占位图（后者本身就是结构信号）。
  assert.equal((await f.lineage.getGraph({ operator: stranger, query: { projectId: f.project.id } }).catch(error => error)).status, 404)
  assert.equal((await f.lineage.lineage({ operator: stranger, sessionId: f.source.id }).catch(error => error)).status, 404)
  // 只拥有下游分支的操作者：自己的节点可见，上游退回无内容占位，但仍能看见边的存在。
  const target = (await f.sessions()).find(session => session.id === first.targetSessionId)!
  await f.handOver(target, stranger)
  const graph = await f.lineage.getGraph({ operator: stranger, query: { projectId: f.project.id } })
  assert.deepEqual(graph.nodes.map(node => node.sessionId).sort(), [f.source.id, target.id].sort())
  const hidden = graph.nodes.find(node => node.sessionId === f.source.id)!
  assert.equal(hidden.visibility, 'placeholder')
  assert.equal(hidden.summary, null, '占位节点不得携带部分摘要')
  assert.deepEqual(hidden, { sessionId: f.source.id, visibility: 'placeholder', summary: null }, '占位节点必须只有身份与可见性，任何额外字段都是泄漏面')
  const owned = graph.nodes.find(node => node.sessionId === target.id)!
  assert.equal(owned.visibility, 'visible')
  assert.equal(owned.summary!.title, 'source（分支）')
  assert.deepEqual(graph.edges.map(edge => edge.key), [`fork:${first.fork.forkId}`])
  assert.equal(graph.hiddenRelationCount, null, '隐藏计数会泄漏结构，必须为空')
  // 上游不可读时，下游自己的祖先列表退化为占位而不是 404。
  const partial = await f.lineage.lineage({ operator: stranger, sessionId: target.id })
  assert.deepEqual(partial.ancestors.map(point => point.sourceSessionId), [f.source.id])
  // 显式 Project 授权后同一节点转为可见。
  await f.store.transaction(async tx => {
    await tx.resources.saveSession({ ...(await tx.resources.getSession(f.source.id))!, shareScope: 'project' })
    await tx.identity.saveProjectGrant({ projectId: f.project.id, userId: stranger, role: 'viewer' })
  })
  const granted = await f.lineage.getGraph({ operator: stranger, query: { projectId: f.project.id } })
  assert.equal(granted.nodes.find(node => node.sessionId === f.source.id)!.visibility, 'visible')
  // 删除来源不级联删除后代：目标 Session 仍然存在，只是它的父边不再可见。
  await f.store.transaction(async tx => { const session = (await tx.resources.getSession(f.source.id))!; await tx.resources.saveSession({ ...session, deletedAt: now() }) })
  const descendants = (await f.sessions()).filter(session => session.id === first.targetSessionId)
  assert.equal(descendants.length, 1)
  assert.equal(descendants[0]!.deletedAt, null)
  const orphaned = await f.lineage.lineage({ operator: stranger, sessionId: target.id })
  assert.deepEqual(orphaned.ancestors, [])
  assert.equal((await f.lineage.getGraph({ operator: stranger, query: { projectId: f.project.id } })).edges.length, 0)
})

test('concurrent forks with one requestId converge and distinct requestIds never lose an edge', async t => {
  const f = await fixture(); t.after(() => f.close())
  // 存储层是串行的：同一个 requestId 的两个并发请求必须收敛到同一个目标，而不是两条分支。
  const [left, right] = await Promise.all([f.fork({ requestId: 'race', sourceEventCursor: 1 }), f.fork({ requestId: 'race', sourceEventCursor: 1 })])
  assert.equal(left.targetSessionId, right.targetSessionId)
  assert.equal(left.fork.forkId, right.fork.forkId)
  assert.deepEqual([left.replayed, right.replayed].sort(), [false, true], '恰好一个请求真正创建了目标')
  assert.equal((await f.sessions()).length, 2)
  assert.equal((await f.store.transaction(tx => tx.resources.listSessionForks(f.project.id))).length, 1)
  const raced = await Promise.all([f.fork({ requestId: 'race-a', sourceEventCursor: 2 }), f.fork({ requestId: 'race-b', sourceEventCursor: 3 })])
  assert.notEqual(raced[0]!.targetSessionId, raced[1]!.targetSessionId)
  assert.equal((await f.sessions()).length, 4)
  const forks = await f.store.transaction(tx => tx.resources.listSessionForks(f.project.id))
  assert.deepEqual(forks.map(fork => fork.sourceEventCursor).sort(), [1, 2, 3])
})

test('fork and lineage never cross a Team boundary, even for the same operator', async t => {
  const f = await fixture(); t.after(() => f.close())
  const foreignSession = { ...(await f.create('foreign') as { session: Session }).session }
  await f.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: 'team-b' as never, name: 'Team B', createdAt: now() })
    await tx.resources.saveProject({ id: 'project-b' as never, teamId: 'team-b' as never, ownerId: f.user.id, name: 'Team B project', shareScope: 'owner-only', deletedAt: null })
    await tx.resources.saveSession({ ...foreignSession, projectId: 'project-b' as never })
  })
  // 同一个管理员在两个 Team 里各自持有 Project：仍然不能把血缘跨过去。
  assert.equal((await f.lineage.lineage({ operator: f.user.id, sessionId: foreignSession.id }).catch(error => error)).status, 404)
  assert.equal((await f.fork({ requestId: 'cross-team', sourceSessionId: foreignSession.id }).catch(error => error)).status, 404)
  assert.equal((await f.lineage.getGraph({ operator: f.user.id, query: { projectId: 'project-b' as never } }).catch(error => error)).status, 404)
  await f.store.transaction(tx => tx.resources.saveSessionFork({ id: 'fork-b' as never, projectId: 'project-b' as never, sourceSessionId: f.source.id, sourceEventCursor: 0, targetSessionId: foreignSession.id, createdBy: f.user.id, createdAt: now(), contextPolicy: 'through_cursor', creation: { requestId: 'cross-team', fingerprint: 'x' } }))
  assert.equal((await f.lineage.getForkPoint({ operator: f.user.id, forkId: 'fork-b' as never }).catch(error => error)).status, 404)
  // 被拒的请求不得留下任何副作用：跨 Team 的边不在默认 Project 里，也不影响本 Team 的图。
  assert.deepEqual(await f.store.transaction(tx => tx.resources.listSessionForks(f.project.id)), [])
  assert.deepEqual((await f.lineage.getGraph({ operator: f.user.id, query: { projectId: f.project.id } })).edges, [])
})

test('HTTP routes expose fork, lineage, graph and fork point with the same authorization boundary', async t => {
  const f = await fixture(); t.after(() => f.close())
  const created = await f.request(`/projects/${f.project.id}/session-forks`, 'POST', { sourceSessionId: f.source.id, sourceEventCursor: 1, targetWorkspaceId: f.workspace.id, targetWorkerId: f.worker.id, targetAgentKey: 'pi', targetModelId: 'pi-model', requestId: 'http-fork' })
  assert.equal(created.status, 201)
  const body = await created.json() as { fork: { forkId: SessionForkId; targetSessionId: SessionId }; targetSessionId: SessionId; graphRevision: string; replayed: boolean }
  assert.equal(body.replayed, false)
  assert.equal(body.fork.targetSessionId, body.targetSessionId)
  const replayed = await f.request(`/projects/${f.project.id}/session-forks`, 'POST', { sourceSessionId: f.source.id, sourceEventCursor: 1, targetWorkspaceId: f.workspace.id, targetWorkerId: f.worker.id, targetAgentKey: 'pi', targetModelId: 'pi-model', requestId: 'http-fork' })
  assert.equal(replayed.status, 201)
  assert.equal(((await replayed.json()) as { targetSessionId: string }).targetSessionId, body.targetSessionId)
  const lineage = await f.request(`/sessions/${f.source.id}/lineage`)
  assert.equal(lineage.status, 200)
  const view = await lineage.json() as { sessionId: string; ancestors: unknown[]; children: { forkId: string }[]; graphRevision: string }
  assert.equal(view.sessionId, f.source.id)
  assert.deepEqual(view.ancestors, [])
  assert.equal(view.children[0]!.forkId, body.fork.forkId)
  assert.equal(view.graphRevision, body.graphRevision)
  const graph = await f.request(`/projects/${f.project.id}/session-graph?depth=1`)
  assert.equal(graph.status, 200)
  const snapshot = (await graph.json() as { graph: { nodes: unknown[]; edges: { key: string }[]; revision: string } }).graph
  assert.equal(snapshot.nodes.length, 2)
  assert.equal(snapshot.edges[0]!.key, `fork:${body.fork.forkId}`)
  assert.equal((await f.request(`/projects/${f.project.id}/session-graph?depth=99`)).status, 400)
  assert.equal((await f.request(`/projects/${f.project.id}/session-graph?rootSessionId=ghost`)).status, 404)
  const point = await f.request(`/session-forks/${body.fork.forkId}`)
  assert.equal(point.status, 200)
  assert.deepEqual((await point.json() as { fork: unknown }).fork, body.fork)
  assert.equal((await f.request('/session-forks/ghost')).status, 404)
  // 没有凭据的调用者在路由层就被拒，不会落到服务层的授权判定。
  const anonymous = await fetch(`${f.baseUrl}/api/projects/${f.project.id}/session-graph`)
  assert.equal(anonymous.status, 401)
})