import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilitySnapshot, Turn } from '@wemux/domain'
import type { McpConnectorDefinition } from '@wemux/connector'
import { WorkerConnectorRuntime } from '../src/connectors/runtime.js'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'

const timestamp = '2026-01-01T00:00:00.000Z' as never
/** 协调身份 capability snapshot：只读查询面 + 空连接器授权，写类 operation 一律不在集合内。 */
const coordinationAllowedTools = ['session.info', 'project.list', 'project.get', 'task.list', 'task.get', 'task.sessions', 'session.get', 'session.events', 'agent.list'] as const

function mcp(): McpConnectorDefinition {
  return { id: 'mcp-1' as never, projectId: 'project-1' as never, kind: 'mcp', name: 'MCP', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: true }, config: { transport: 'stdio', command: process.execPath, args: ['--version'], cwd: null, publicEnvironment: {}, secretEnvironmentNames: [] }, createdAt: timestamp, updatedAt: timestamp }
}

function turn(id: string, snapshot: CapabilitySnapshot, token: string): Turn {
  return { id, sessionId: snapshot.sessionId, commandId: `command-${id}`, message: { messageId: `message-${id}`, content: 'coordination gate' }, state: 'queued', requestedAt: timestamp, startedAt: null, finishedAt: null, capabilitySnapshot: snapshot, capabilityToken: token } as Turn
}

const coordinationSnapshot = (sessionId: string): CapabilitySnapshot => ({
  id: `coordination-${sessionId}`, projectId: 'team:team-1' as never, workspaceId: 'workspace-coordination' as never, sessionId: sessionId as never, version: 1, assets: [],
  allowedTools: [...coordinationAllowedTools], allowedConnectorIds: [], connectors: [], createdAt: timestamp,
})
const ordinarySnapshot = (sessionId: string, connectorId: string): CapabilitySnapshot => ({
  id: `ordinary-${sessionId}`, projectId: 'project-1' as never, workspaceId: 'workspace-1' as never, sessionId: sessionId as never, version: 1, assets: [],
  allowedTools: ['mcp.list_tools', 'mcp.call', 'http.call'], allowedConnectorIds: [connectorId], connectors: [], createdAt: timestamp,
})

test('协调 Session 绑定被接受：受限快照可注册且不授予连接器', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-coordination-gate-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  const runtime = new WorkerConnectorRuntime(store)
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const registered = await runtime.registerTurn(turn('turn-coord-1', coordinationSnapshot('session-coord-1'), 'coordination-token'), 'worker-1')
  assert.deepEqual(registered.snapshot.allowedConnectorIds, [])
  assert.deepEqual(new Set(registered.snapshot.allowedTools), new Set(coordinationAllowedTools))
  await registered.release()
})

test('写类 operation 不属于协调身份 allowedTools：连接器调用被拒', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-coordination-write-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  const runtime = new WorkerConnectorRuntime(store)
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const definition = mcp()
  await store.saveConnectorDefinition(definition)
  const registered = await runtime.registerTurn(turn('turn-coord-2', coordinationSnapshot('session-coord-2'), 'coordination-token-2'), 'worker-1')
  for (const operation of ['mcp.call', 'http.call'] as const) {
    const result = await runtime.handle(operation, 'coordination-token-2', { connectorId: definition.id, connectorRevision: 1, toolName: 'tool', requestId: `req-${operation}`, toolCallId: `call-${operation}`, arguments: {} })
    assert.ok(result, `${operation} 必须有本地判定`)
    assert.notEqual(result.status, 401)
    const body = result.body as { ok?: boolean; error?: { code?: string } }
    assert.equal(body.ok, false, `${operation} 在协调身份下不得成功`)
    assert.equal(body.error?.code, 'scope_denied')
  }
  await registered.release()
})

test('只读查询 operation 直通上游且不落入本地写面', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-coordination-read-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  const runtime = new WorkerConnectorRuntime(store)
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const registered = await runtime.registerTurn(turn('turn-coord-3', coordinationSnapshot('session-coord-3'), 'coordination-token-3'), 'worker-1')
  for (const operation of coordinationAllowedTools) {
    assert.equal(await runtime.handle(operation, 'coordination-token-3', {}), null, `${operation} 非本地能力，应直通 Server 查询面`)
  }
  assert.equal(await runtime.handle('task.create', 'coordination-token-3', {}), null, '写类 platform operation 也不在 Worker 本地面，Server 侧按 allowedTools 拒绝')
  await registered.release()
})

test('协调身份与普通 Project 身份的 allowedTools 集合互不串用', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-coordination-mix-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  const runtime = new WorkerConnectorRuntime(store)
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }) })
  const definition = mcp()
  await store.saveConnectorDefinition(definition)
  const coordination = await runtime.registerTurn(turn('turn-mix-coord', coordinationSnapshot('session-mix-coord'), 'token-coordination'), 'worker-1')
  const ordinary = await runtime.registerTurn(turn('turn-mix-ord', ordinarySnapshot('session-mix-ord', definition.id), 'token-ordinary'), 'worker-1')
  // 两个身份的 allowedTools 交集为空。
  assert.deepEqual(coordination.snapshot.allowedTools.filter(tool => (ordinary.snapshot.allowedTools as readonly string[]).includes(tool)), [])
  // 同一连接器、同一输入：协调令牌被 capability 快照拒绝，普通令牌走自己的授权面（不是 scope_denied）。
  const input = { connectorId: definition.id, connectorRevision: 1, toolName: 'tool', requestId: 'req-mix', toolCallId: 'call-mix', arguments: {} }
  const denied = await runtime.handle('mcp.call', 'token-coordination', input)
  const coordinationBody = denied!.body as { ok?: boolean; error?: { code?: string } }
  assert.equal(coordinationBody.ok, false)
  assert.equal(coordinationBody.error?.code, 'scope_denied')
  const ordinaryResult = await runtime.handle('mcp.call', 'token-ordinary', input)
  const ordinaryBody = ordinaryResult!.body as { ok?: boolean; error?: { code?: string } }
  assert.notEqual(ordinaryBody.error?.code, 'scope_denied', '普通身份对同一连接器有自己的授权判定，不受协调快照污染')
  assert.notEqual(ordinaryBody.error?.code, coordinationBody.error?.code)
  // 令牌无法借用他人 Turn 身份：handle 只从令牌自身的 claims 推导 currentTurn，伪造不了。
  // 无效令牌一律 401。
  assert.deepEqual(await runtime.handle('mcp.call', 'unknown-token', {}), { status: 401, body: { error: 'Invalid capability token' } })
  await coordination.release()
  await ordinary.release()
})
