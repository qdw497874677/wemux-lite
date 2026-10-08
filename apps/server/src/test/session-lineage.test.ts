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
  const server = createServer(httpHandler({ service, auth: new AuthenticationService(store, administratorDirectory(store)), streams, lineage }))
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
  assert.equal(target.storageMode, 'local', 'Fork 继承来源的存储模式')
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

test('fork keeps the source Task when selecting another Workspace', async t => {
  const f = await fixture(); t.after(() => f.close())
  const { workspace } = await f.service.createWorkspace({ projectId: f.project.id, workerId: f.worker.id, name: 'branch' })
  await f.ready(workspace.id)
  const result = await f.fork({ targetWorkspaceId: workspace.id })
  const target = (await f.sessions()).find(session => session.id === result.targetSessionId)!
  assert.ok(f.source.taskId)
  assert.equal(target.taskId, f.source.taskId)
  assert.equal(target.runId, null)
  assert.equal(target.workspaceId, workspace.id)
})

test('replayed forks are idempotent and a changed payload under the same requestId is rejected', async t => {
  const f = await fixture(); t.after(() => f.close())
  await f.store.putRecord('session', f.source.id, (({ storageMode: _mode, ...legacy }) => legacy)(f.source))
  const first = await f.fork({ sourceEventCursor: 1 })
  assert.equal((await f.sessions()).find(session => session.id === first.targetSessionId)?.storageMode, 'local', '旧来源缺省 local')
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
  const { workspace: otherWorkspace } = await f.service.createWorkspace({ projectId: otherProject.id, workerId: f.worker.id, name: 'other' })
  await f.ready(otherWorkspace.id)
  const { session: foreign } = await f.service.createSession({ requestId: 'foreign', workspaceId: otherWorkspace.id, title: 'foreign', agentKey: 'pi', modelId: 'pi-model' })
  const crossProject = await f.fork({ requestId: 'fork-cross', sourceSessionId: foreign.id }).catch(error => error)
  assert.equal(crossProject.status, 404)
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

test('hidden Sessions leave no nodes, edges, counts or ancestry and visible revisions agree', async t => {
  const f = await fixture(); t.after(() => f.close())
  const first = await f.fork({ sourceEventCursor: 2 })
  const stranger = await f.other('stranger')
  assert.equal((await f.lineage.getGraph({ operator: stranger, query: { projectId: f.project.id } }).catch(error => error)).status, 404)
  const target = (await f.sessions()).find(session => session.id === first.targetSessionId)!
  await f.handOver(target, stranger)
  await f.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: f.project.id, userId: stranger, role: 'viewer' }))
  const graph = await f.lineage.getGraph({ operator: stranger, query: { projectId: f.project.id } })
  assert.deepEqual(graph.nodes.map(node => node.sessionId), [target.id])
  assert.deepEqual(graph.edges, [])
  assert.equal(graph.hiddenRelationCount, null)
  assert.equal(graph.nodes[0]!.summary!.branchCount, 0)
  const partial = await f.lineage.lineage({ operator: stranger, sessionId: target.id })
  assert.deepEqual(partial.ancestors, [])
  assert.deepEqual(partial.children, [])
  assert.equal(partial.graphRevision, graph.revision)
  assert.equal(await f.lineage.graphRevisionFor(stranger, f.project.id), graph.revision)
  assert.equal((await f.lineage.getForkPoint({ operator: stranger, forkId: first.fork.forkId }).catch(error => error)).status, 404)
  assert.equal(JSON.stringify({ graph, partial }).includes(f.source.id), false)
  // 删除不可读来源不能改变 viewer 的 revision，也不能删除后代。
  await f.store.transaction(tx => tx.resources.saveSession({ ...f.source, deletedAt: now() }))
  assert.equal((await f.lineage.getGraph({ operator: stranger, query: { projectId: f.project.id } })).revision, graph.revision)
  assert.equal(await f.lineage.graphRevisionFor(stranger, f.project.id), graph.revision)
  assert.equal((await f.sessions()).find(session => session.id === target.id)!.deletedAt, null)
})

test('hidden creation, deletion and grants do not move visible revisions; revocation drops cached projections', async t => {
  const f = await fixture(); t.after(() => f.close())
  const viewer = await f.other('viewer'), other = await f.other('other')
  await f.store.transaction(async tx => {
    await tx.identity.saveProjectGrant({ projectId: f.project.id, userId: viewer, role: 'viewer' })
    await tx.resources.saveSession({ ...f.source, shareScope: 'project' })
  })
  const graph = () => f.lineage.getGraph({ operator: viewer, query: { projectId: f.project.id } })
  const before = await graph()
  const hidden = await f.fork({ requestId: 'hidden-branch' })
  const hiddenSession = (await f.sessions()).find(session => session.id === hidden.targetSessionId)!
  const hiddenTask = await f.create('hidden-task-session')
  // A separate Workspace creates a dedicated Task not referenced by any visible Session.
  const { workspace: hiddenWorkspace } = await f.service.createWorkspace({ projectId: f.project.id, workerId: f.worker.id, name: 'hidden-task' })
  await f.ready(hiddenWorkspace.id)
  const { session: taskSession } = await f.service.createSession({ requestId: 'hidden-task-session', workspaceId: hiddenWorkspace.id, title: 'hidden-task', agentKey: 'pi', modelId: 'pi-model' })
  assert.notEqual(taskSession.taskId, f.source.taskId)
  for (const id of [hiddenTask.session.id, taskSession.id, taskSession.taskId!, hiddenWorkspace.id]) assert.equal(JSON.stringify(await graph()).includes(id), false)
  assert.deepEqual(await graph(), before)
  assert.equal((await f.lineage.lineage({ operator: viewer, sessionId: f.source.id })).graphRevision, before.revision)
  assert.equal(await f.lineage.graphRevisionFor(viewer, f.project.id), before.revision)
  await f.store.transaction(async tx => {
    await tx.resources.saveSession({ ...hiddenSession, shareScope: 'selected-members' })
    await tx.identity.saveSessionGrant({ sessionId: hiddenSession.id, userId: other })
    await tx.identity.removeSessionGrant(hiddenSession.id, other)
  })
  assert.deepEqual(await graph(), before)
  await f.store.transaction(tx => tx.identity.saveSessionGrant({ sessionId: hiddenSession.id, userId: viewer }))
  const visible = await graph()
  assert.equal(visible.nodes.length, 2)
  assert.equal(visible.nodes.find(node => node.sessionId === f.source.id)!.summary!.branchCount, 1)
  assert.equal((await f.lineage.getForkPoint({ operator: viewer, forkId: hidden.fork.forkId })).graphRevision, visible.revision)
  assert.equal((await f.lineage.getGraph({ operator: viewer, query: { projectId: f.project.id, nodeLimit: 1, depth: 0 } })).revision, visible.revision)
  await f.store.transaction(tx => tx.identity.removeSessionGrant(hiddenSession.id, viewer))
  assert.deepEqual(await graph(), before)
  assert.equal((await f.lineage.getForkPoint({ operator: viewer, forkId: hidden.fork.forkId }).catch(error => error)).status, 404)
  await f.store.transaction(tx => tx.resources.saveSession({ ...hiddenSession, deletedAt: now() }))
  assert.deepEqual(await graph(), before)
})

test('instance administrator has no implicit Session content access', async t => {
  const f = await fixture(); t.after(() => f.close())
  const owner = await f.other('private-owner')
  await f.store.transaction(tx => tx.resources.saveSession({ ...f.source, ownerId: owner, shareScope: 'selected-members' }))
  const graph = await f.lineage.getGraph({ operator: f.user.id, query: { projectId: f.project.id } })
  assert.deepEqual(graph.nodes, [])
  assert.equal((await f.lineage.lineage({ operator: f.user.id, sessionId: f.source.id }).catch(error => error)).status, 404)
  assert.equal((await f.fork({ requestId: 'admin-private' }).catch(error => error)).status, 404)
})

test('Session Fork replay is actor scoped and rechecks both current endpoints', async t => {
  const f = await fixture(); t.after(() => f.close())
  const first = await f.fork({})
  const actor = await f.other('replay-actor')
  await f.store.transaction(async tx => {
    await tx.identity.saveProjectGrant({ projectId: f.project.id, userId: actor, role: 'contributor' })
    await tx.resources.saveSession({ ...f.source, shareScope: 'project' })
  })
  const command = { sourceSessionId: f.source.id, targetWorkspaceId: f.workspace.id, targetWorkerId: f.worker.id, targetAgentKey: 'pi', targetModelId: 'pi-model', requestId: 'fork-1' }
  const denied = await f.lineage.fork({ operator: actor, projectId: f.project.id, command }).catch(error => error)
  assert.ok([404, 409].includes(denied.status))
  assert.equal(JSON.stringify(denied).includes(first.targetSessionId), false)
  assert.equal((await f.sessions()).length, 2)
  const record = (await f.store.resources.listSessionForks(f.project.id))[0]!
  assert.match(record.creation.requestId, /^fork-actor:[a-f0-9]{64}$/)
  assert.deepEqual((await f.fork({})).fork, first.fork)
  // Existing unscoped rows remain replayable only by their original actor.
  await f.store.transaction(tx => tx.resources.saveSessionFork({ ...record, creation: { ...record.creation, requestId: 'fork-1' } }))
  assert.deepEqual((await f.fork({})).fork, first.fork)
  const target = (await f.sessions()).find(session => session.id === first.targetSessionId)!
  await f.handOver(target, actor)
  assert.equal((await f.fork({}).catch(error => error)).status, 404)
  await f.handOver(target, f.user.id)
  await f.store.transaction(tx => tx.resources.saveSession({ ...f.source, ownerId: actor, shareScope: 'owner-only' }))
  assert.equal((await f.fork({}).catch(error => error)).status, 404)
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

test('multi-Team users can read each authorized Project but Fork edges never cross Projects', async t => {
  const f = await fixture(); t.after(() => f.close())
  // Insert an explicitly legacy fixture, rather than moving a Task-bound Session.
  const { taskId: _task, runId: _run, creation: _creation, ...legacy } = f.source
  const foreignSession = { ...legacy, id: 'foreign-team-session' as SessionId }
  await f.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: 'team-b' as never, name: 'Team B', createdAt: now() })
    await tx.identity.saveMembership({ teamId: 'team-b' as never, userId: f.user.id, role: 'owner', joinedAt: now() })
    await tx.resources.saveProject({ id: 'project-b' as never, teamId: 'team-b' as never, ownerId: f.user.id, name: 'Team B project', shareScope: 'owner-only', deletedAt: null })
    await tx.resources.saveSession({ ...foreignSession, projectId: 'project-b' as never })
  })
  // 多 Team 用户按目标 Project 授权查询，不取 memberships[0]；关系仍不跨 Project。
  assert.deepEqual((await f.lineage.lineage({ operator: f.user.id, sessionId: foreignSession.id })).ancestors, [])
  assert.equal((await f.fork({ requestId: 'cross-team', sourceSessionId: foreignSession.id }).catch(error => error)).status, 404)
  assert.deepEqual((await f.lineage.getGraph({ operator: f.user.id, query: { projectId: 'project-b' as never } })).nodes.map(node => node.sessionId), [foreignSession.id])
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

test('HTTP cross-Task Fork parameters are rejected without target identities or Session/Fork/command residue', async t => {
  const f = await fixture(); t.after(() => f.close())
  const { workspace } = await f.service.createWorkspace({ projectId: f.project.id, workerId: f.worker.id, name: 'other-task-workspace' })
  await f.ready(workspace.id)
  const { session: other } = await f.service.createSession({ requestId: 'other-task', workspaceId: workspace.id, title: 'other-task', agentKey: 'pi', modelId: 'pi-model' })
  assert.notEqual(other.taskId, f.source.taskId)
  const before = { sessions: await f.sessions(), forks: await f.store.resources.listSessionForks(f.project.id), commands: await f.store.commands.list({ limit: 1000 }) }
  for (const field of ['taskId', 'targetTaskId']) {
    const response = await f.request(`/projects/${f.project.id}/session-forks`, 'POST', {
      sourceSessionId: f.source.id, targetWorkspaceId: f.workspace.id, targetWorkerId: f.worker.id,
      targetAgentKey: 'pi', targetModelId: 'pi-model', requestId: `cross-task-${field}`, [field]: other.taskId,
    })
    assert.equal(response.status, 400)
    const body = await response.text()
    for (const identity of [other.id, other.taskId!, f.source.id]) assert.equal(body.includes(identity), false)
    assert.deepEqual({ sessions: await f.sessions(), forks: await f.store.resources.listSessionForks(f.project.id), commands: await f.store.commands.list({ limit: 1000 }) }, before)
  }
})
