import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { AgentKey, ModelId, ProjectId, SessionForkId, SessionId, TeamId, Timestamp, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { administratorEmail, administratorToken, instanceOperatorId, seedAdministrator } from './fixtures/administrator.js'

const auth = { authorization: `Bearer ${administratorToken}` }

async function request(baseUrl: string, route: string) {
  const response = await fetch(`${baseUrl}${route}`, { headers: auth })
  return { response, body: await response.json() as any }
}

test('GET /api/projects/:projectId/session-graph returns authorized nodes and authoritative fork edges', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  await seedAdministrator(app.store)
  const teamId = randomUUID() as TeamId
  const projectId = randomUUID() as ProjectId
  const workspaceId = randomUUID() as WorkspaceId
  const workerId = randomUUID() as WorkerId
  const childId = 'child-session' as SessionId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: '画布团队', createdAt: new Date().toISOString() as never })
    await tx.identity.saveMembership({ teamId, userId: instanceOperatorId, role: 'owner', joinedAt: new Date().toISOString() as never })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: instanceOperatorId, name: '画布项目', shareScope: 'team', deletedAt: null })
    await tx.resources.saveWorkspace({ id: workspaceId, projectId, name: '主工作区', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [], deletedAt: null })
    await tx.resources.saveSession({ id: 'root-session' as never, projectId, ownerId: instanceOperatorId as UserId, workspaceId, title: '根会话', shareScope: 'project', binding: { workspaceId, agent: { workerId, agentKey: 'pi' as AgentKey }, modelId: 'gpt-5' as ModelId }, runtimeState: 'idle', archivedAt: null, deletedAt: null })
    await tx.resources.saveSession({ id: childId, projectId, ownerId: instanceOperatorId as UserId, workspaceId, title: '分支会话', shareScope: 'project', binding: { workspaceId, agent: { workerId, agentKey: 'pi' as AgentKey }, modelId: 'gpt-5-mini' as ModelId }, runtimeState: 'idle', archivedAt: null, deletedAt: null })
    await tx.resources.saveSessionFork({ id: 'fork-http-test' as SessionForkId, projectId, sourceSessionId: 'root-session' as SessionId, sourceEventCursor: 0, targetSessionId: childId, createdBy: instanceOperatorId, createdAt: new Date().toISOString() as Timestamp, contextPolicy: 'through_cursor', creation: { requestId: 'request-graph-fork', fingerprint: 'test-fingerprint' } })
  })
  const baseUrl = await app.listen(0)
  t.after(() => app.close())

  const graph = await request(baseUrl, `/api/projects/${projectId}/session-graph`)
  assert.equal(graph.response.status, 200, JSON.stringify(graph.body))
  assert.equal(graph.body.graph.nodes.some((node: any) => node.sessionId === 'root-session'), true)
  assert.equal(graph.body.graph.nodes.some((node: any) => node.sessionId === childId), true)
  const edge = graph.body.graph.edges.find((value: any) => value.sourceSessionId === 'root-session' && value.targetSessionId === childId)
  assert.ok(edge)
  assert.equal(edge.relation.type, 'fork')
  assert.match(graph.body.graph.revision, /^g[a-f0-9]{16}$/)
})


test('administrator HTTP graph and fork point omit content without a Session Grant and do not cache it', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  t.after(() => app.close())
  await seedAdministrator(app.store)
  const projectId = 'private-content-project' as ProjectId, teamId = 'private-content-team' as TeamId
  const sourceId = 'public-source' as SessionId, targetId = 'private-target' as SessionId
  const at = new Date().toISOString() as Timestamp
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Team', createdAt: at })
    await tx.identity.saveMembership({ teamId, userId: instanceOperatorId, role: 'owner', joinedAt: at })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: instanceOperatorId, name: 'Project', shareScope: 'team', deletedAt: null })
    for (const id of [sourceId, targetId]) await tx.resources.saveSession({ id, projectId, ownerId: 'other-owner' as UserId, workspaceId: 'workspace' as WorkspaceId, title: id, shareScope: id === sourceId ? 'project' : 'selected-members', binding: { workspaceId: 'workspace' as WorkspaceId, agent: { workerId: 'worker' as WorkerId, agentKey: 'pi' as AgentKey }, modelId: null }, runtimeState: 'idle', archivedAt: null, deletedAt: null })
    await tx.resources.saveSessionFork({ id: 'private-fork' as SessionForkId, projectId, sourceSessionId: sourceId, targetSessionId: targetId, sourceEventCursor: 0, createdBy: instanceOperatorId, createdAt: at, contextPolicy: 'through_cursor', creation: { requestId: 'private-request', fingerprint: 'private-fingerprint' } })
  })
  const base = await app.listen(0)
  const initial = await request(base, `/api/projects/${projectId}/session-graph`)
  assert.equal(initial.response.status, 200)
  assert.deepEqual(initial.body.graph.nodes.map((node: { sessionId: string }) => node.sessionId), [sourceId])
  assert.deepEqual(initial.body.graph.edges, [])
  assert.equal(initial.body.graph.nodes[0].summary.branchCount, 0)
  for (const path of [`/api/projects/${projectId}/session-graph`, `/api/sessions/${sourceId}/lineage`, '/api/session-forks/private-fork']) {
    const result = await request(base, path)
    assert.equal(result.response.status, path.endsWith('private-fork') ? 404 : 200)
    assert.equal(result.response.headers.get('cache-control'), 'no-store')
    assert.equal(JSON.stringify(result.body).includes(targetId), false)
    assert.equal(JSON.stringify(result.body).includes('private-fork'), false)
  }
  await app.store.transaction(tx => tx.identity.saveSessionGrant({ sessionId: targetId, userId: instanceOperatorId }))
  assert.equal((await request(base, '/api/session-forks/private-fork')).response.status, 200)
  await app.store.transaction(tx => tx.identity.removeSessionGrant(targetId, instanceOperatorId))
  assert.deepEqual((await request(base, `/api/projects/${projectId}/session-graph`)).body, initial.body)
  assert.equal((await request(base, '/api/session-forks/private-fork')).response.status, 404)
})
