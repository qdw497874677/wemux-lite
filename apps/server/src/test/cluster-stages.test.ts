import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import type { ServerToWorker } from '@wemux/wire-protocol'
import { createWemuxServer } from '../server.js'

const token = 'cluster-bootstrap-token-12345678'
const capability = { agentKey: 'pi', displayName: 'Pi', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test-model', displayName: 'Test', source: 'configured' }] }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await delay(20) }
  assert.fail('Timed out waiting for condition')
}
class Peer {
  readonly messages: ServerToWorker[] = []
  private counter = 0
  constructor(readonly ws: WebSocket) { ws.on('message', data => this.messages.push(JSON.parse(data.toString()) as ServerToWorker)) }
  send(message: Record<string, unknown>) { this.ws.send(JSON.stringify({ protocolVersion: 1, messageId: `worker-message-${++this.counter}`, ...message })) }
  async close() { if (this.ws.readyState === WebSocket.CLOSED) return; const done = once(this.ws, 'close'); this.ws.close(); await done }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-cluster-'))
  const app = createWemuxServer({ databasePath: join(dir, 'server.sqlite'), bootstrapToken: token })
  const base = await app.listen(0)
  async function request(path: string, method = 'GET', body?: unknown, bearer: string | null = token) {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  await request('/bootstrap', 'POST', {})
  const enrollment = (await request('/enrollment-tokens', 'POST', {})).data
  const enrolled = await request('/workers/enroll', 'POST', { token: enrollment.token, name: 'Cluster worker' }, null)
  const { workerId, credential } = enrolled.data
  const project = (await request('/projects', 'POST', { name: 'Cluster' })).data
  return { app, base, request, workerId, credential, projectId: project.id }
}

test('command stage list and protected provision cancellation: pending remains deliverable', { timeout: 15000 }, async t => {
  const { app, base, request, workerId, credential, projectId } = await setup()
  t.after(() => app.close())
  // Workspace command stays pending while the worker is offline.
  const provision = await request('/workspaces', 'POST', { projectId, workerId, name: 'Repo', repository: { gitUrl: 'https://example.com/repo.git', revision: 'main' } })
  assert.equal(provision.status, 201)
  const commandId = provision.data.commandId
  const listed = (await request('/commands')).data.items
  assert.equal(listed.length, 1)
  assert.equal(listed[0].status, 'pending')
  assert.equal(listed[0].workerId, workerId)
  assert.equal((await request('/commands?status=pending&workerId=' + workerId)).data.items.length, 1)
  assert.equal((await request('/commands?status=accepted')).data.items.length, 0)
  assert.equal((await request('/commands?status=bogus')).status, 400)
  // Current provision commands cannot be cancelled, including repeated attempts.
  const cancelled = await request(`/commands/${commandId}`, 'DELETE')
  assert.equal(cancelled.status, 409)
  assert.match(JSON.stringify(cancelled.data), /protected_command/)
  assert.equal((await request('/commands?status=pending')).data.items.length, 1)
  assert.equal((await request('/commands?status=cancelled')).data.items.length, 0)
  assert.equal((await request(`/commands/${commandId}`, 'DELETE')).status, 409)
  const retry = await request(`/workspaces/${provision.data.workspace.id}/reprovision`, 'POST', { requestId: 'offline' })
  assert.equal(retry.data.commandId, commandId)
  // Reconnect delivers the original protected attempt.
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/worker/ws', { headers: { Authorization: `Bearer ${credential}` } })
  const messages: ServerToWorker[] = []
  let counter = 0
  ws.on('message', data => messages.push(JSON.parse(data.toString()) as ServerToWorker))
  const send = (message: Record<string, unknown>) => ws.send(JSON.stringify({ protocolVersion: 1, messageId: `m-${++counter}`, ...message }))
  await once(ws, 'open')
  send({ type: 'hello', side: 'worker', workerId, workerVersion: 'test', name: 'Cluster worker', platform: 'linux', architecture: 'x64' })
  await eventually(async () => messages.some(m => m.type === 'hello'))
  await delay(300)
  assert.equal(messages.some(m => m.type === 'command' && m.commandId === commandId), true)
  // Normal receipt handling remains unchanged.
  send({ type: 'ack', receipt: { commandId, status: 'accepted' } })
  await eventually(async () => (await request(`/commands/${commandId}`)).data.status === 'accepted')
  ws.close()
})

test('workspace reprovision: only pending/failed, re-issues provision command deliverable to the worker', { timeout: 15000 }, async t => {
  const { app, base, request, workerId, credential, projectId } = await setup()
  t.after(() => app.close())
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/worker/ws', { headers: { Authorization: `Bearer ${credential}` } })
  const messages: ServerToWorker[] = []
  let counter = 0
  ws.on('message', data => messages.push(JSON.parse(data.toString()) as ServerToWorker))
  const send = (message: Record<string, unknown>) => ws.send(JSON.stringify({ protocolVersion: 1, messageId: `m-${++counter}`, ...message }))
  await once(ws, 'open')
  send({ type: 'hello', side: 'worker', workerId, workerVersion: 'test', name: 'Cluster worker', platform: 'linux', architecture: 'x64' })
  await eventually(async () => messages.some(m => m.type === 'hello'))
  send({ type: 'capability', workerId, detectedAt: new Date().toISOString(), capabilities: [capability] })
  const provision = await request('/workspaces', 'POST', { projectId, workerId, name: 'Repo', repository: { gitUrl: 'https://example.com/repo.git', revision: 'main' } })
  const workspace = provision.data.workspace
  await eventually(async () => messages.some(m => m.type === 'command' && m.commandId === provision.data.commandId))
  const first = messages.find(m => m.type === 'command' && m.commandId === provision.data.commandId)
  if (first?.type !== 'command') assert.fail('provision command not delivered')
  send({ type: 'ack', receipt: { commandId: provision.data.commandId, status: 'accepted' } })
  send({ type: 'event', scope: 'workspace', report: { workspaceId: workspace.id, status: 'provisioning', reason: null, location: null, occurredAt: new Date().toISOString() } })
  send({ type: 'event', scope: 'workspace', report: { workspaceId: workspace.id, status: 'failed', reason: 'clone failed', location: null, occurredAt: new Date().toISOString() } })
  await eventually(async () => (await request(`/workspaces/${workspace.id}`)).data.status === 'failed')
  // ready workspaces cannot be reprovisioned — use a second workspace driven to ready.
  assert.equal((await request(`/workspaces/${workspace.id}/reprovision`, 'POST')).status, 200)
  await eventually(async () => (await request(`/workspaces/${workspace.id}`)).data.status === 'pending')
  const reprovision = (await request('/commands?status=pending')).data.items
  assert.equal(reprovision.length, 1)
  const retryCommandId = reprovision[0].commandId
  assert.notEqual(retryCommandId, provision.data.commandId)
  await eventually(async () => messages.some(m => m.type === 'command' && m.commandId === retryCommandId))
  send({ type: 'ack', receipt: { commandId: retryCommandId, status: 'accepted' } })
  send({ type: 'event', scope: 'workspace', report: { commandId: retryCommandId, workspaceId: workspace.id, status: 'ready', reason: null, location: { workerId, workspaceId: workspace.id, rootPath: '/tmp/repo', checkouts: [] }, occurredAt: new Date().toISOString() } })
  await eventually(async () => (await request(`/workspaces/${workspace.id}`)).data.status === 'ready')
  assert.equal((await request(`/workspaces/${workspace.id}/reprovision`, 'POST')).status, 409)
  assert.equal((await request(`/commands/${retryCommandId}`, 'DELETE')).status, 409)
  ws.close()
})

test('worker revoke: blocks reconnect, disconnects live socket, blocks new commands; idempotent', { timeout: 15000 }, async t => {
  const { app, base, request, workerId, credential, projectId } = await setup()
  t.after(() => app.close())
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/worker/ws', { headers: { Authorization: `Bearer ${credential}` } })
  const messages: ServerToWorker[] = []
  let counter = 0
  ws.on('message', data => messages.push(JSON.parse(data.toString()) as ServerToWorker))
  const send = (message: Record<string, unknown>) => ws.send(JSON.stringify({ protocolVersion: 1, messageId: `m-${++counter}`, ...message }))
  await once(ws, 'open')
  send({ type: 'hello', side: 'worker', workerId, workerVersion: 'test', name: 'Cluster worker', platform: 'linux', architecture: 'x64' })
  await eventually(async () => messages.some(m => m.type === 'hello'))
  await eventually(async () => (await request(`/workers/${workerId}`)).data.connectionState === 'online')
  // Revoking while connected terminates the socket and the credential stops authenticating.
  const revoked = await request(`/workers/${workerId}/revoke`, 'POST')
  assert.equal(revoked.status, 200)
  assert.equal(revoked.data.connectionState, 'revoked')
  const again = await request(`/workers/${workerId}/revoke`, 'POST')
  assert.equal(again.status, 200)
  await eventually(async () => ws.readyState === WebSocket.CLOSED)
  const retry = new WebSocket(base.replace('http:', 'ws:') + '/worker/ws', { headers: { Authorization: `Bearer ${credential}` } })
  const failed = once(retry, 'unexpected-response').then(() => true).catch(() => false)
  const opened = once(retry, 'open').then(() => true).catch(() => false)
  assert.equal(await Promise.race([failed.then(v => v || opened.then(v => !v))]), true)
  retry.terminate()
  // A revoked worker can no longer host new workspaces.
  const denied = await request('/workspaces', 'POST', { projectId, workerId, name: 'Nope', repository: { gitUrl: 'https://example.com/x.git', revision: 'main' } })
  assert.equal(denied.status, 403)
  assert.equal((await request('/commands')).data.items.length, 0)
})
