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
