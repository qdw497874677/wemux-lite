import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createWemuxServer } from '../server.js'

test('HTTP retry requestIds matching Object prototype names create and reuse string commandIds', async () => {
 const token = 'prototype-http-test', app = createWemuxServer({ databasePath: ':memory:', bootstrapToken: token }), base = await app.listen(0)
 const call = async (path: string, method: string, body?: unknown) => {
  const response = await fetch(`${base}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, data: await response.json() }
 }
 try {
  await call('/bootstrap', 'POST', {})
  const e = await call('/enrollment-tokens', 'POST', {})
  const worker = (await call('/workers/enroll', 'POST', { token: e.data.token, name: 'Offline' })).data
  for (const requestId of ['toString', 'constructor', '__proto__']) {
   const created = (await call('/workspaces', 'POST', { projectId: 'default-project', workerId: worker.workerId, name: requestId, source: 'empty' })).data
   const path = `/workspaces/${created.workspace.id}/reprovision`
   const first = await call(path, 'POST', { requestId })
   assert.equal(first.status, 200)
   assert.equal(typeof first.data.commandId, 'string')
   assert.equal(first.data.commandId, created.commandId)
   assert.equal((await call(path, 'POST', { requestId })).data.commandId, created.commandId)
   assert.equal((await call(`/commands/${created.commandId}`, 'DELETE')).status, 409)
   const socket = new WebSocket(`${base.replace('http', 'ws')}/worker/ws`, { headers: { Authorization: `Bearer ${worker.credential}` } })
   try {
    await once(socket, 'open')
    socket.send(JSON.stringify({ protocolVersion: 1, messageId: `hello-${requestId}`, type: 'hello', side: 'worker', workerId: worker.workerId, name: 'HTTP worker', workerVersion: 'test', platform: 'linux', architecture: 'x64' }))
    socket.send(JSON.stringify({ protocolVersion: 1, messageId: `failed-${requestId}`, type: 'event', scope: 'workspace', report: { workspaceId: created.workspace.id, commandId: created.commandId, status: 'failed', reason: 'retry test', location: null, occurredAt: new Date(Date.now() + 1000).toISOString() } }))
    for (let i = 0; i < 100; i++) { if ((await call(`/workspaces/${created.workspace.id}`, 'GET')).data.status === 'failed') break; await new Promise(r => setTimeout(r, 10)) }
    // Use another prototype name not yet recorded on this Workspace.
    const freshId = requestId === 'toString' ? 'constructor' : requestId === 'constructor' ? '__proto__' : 'toString'
    const replacement = await call(path, 'POST', { requestId: freshId })
    assert.equal(replacement.status, 200)
    assert.equal(replacement.data.created, true)
    assert.equal(typeof replacement.data.commandId, 'string')
    assert.notEqual(replacement.data.commandId, created.commandId)
    assert.equal((await call(path, 'POST', { requestId: freshId })).data.commandId, replacement.data.commandId)
   } finally { socket.terminate() }
  }
 } finally { await app.close() }
})

test('HTTP assignment rejects auth, scope, ownership and capability bypass with stable codes', async () => {
 const token = 'assignment-http-test', app = createWemuxServer({ databasePath: ':memory:', bootstrapToken: token }), base = await app.listen(0)
 let ws: WebSocket | undefined
 const call = async (path: string, method = 'GET', body?: unknown, bearer = token) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json() }
 }
 try {
  await call('/bootstrap', 'POST', {})
  const enroll = async () => { const e = await call('/enrollment-tokens', 'POST', {}); return (await call('/workers/enroll', 'POST', { token: e.data.token, name: 'HTTP worker' })).data }
  const worker = await enroll(), other = await enroll()
  ws = new WebSocket(`${base.replace('http', 'ws')}/worker/ws`, { headers: { Authorization: `Bearer ${worker.credential}` } })
  await once(ws, 'open')
  ws.send(JSON.stringify({ protocolVersion: 1, messageId: 'hello', type: 'hello', side: 'worker', workerId: worker.workerId, name: 'HTTP worker', workerVersion: 'test', platform: 'linux', architecture: 'x64' }))
  ws.send(JSON.stringify({ protocolVersion: 1, messageId: 'cap', type: 'capability', detectedAt: new Date().toISOString(), workerId: worker.workerId, capabilities: [
   { agentKey: 'test', displayName: 'Test', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test', displayName: 'Test', source: 'configured' }] },
   { agentKey: 'detect', displayName: 'Detect', version: '1', mode: 'detect-only', availability: { status: 'available' }, models: [] },
  ] }))
  for (let i = 0; i < 100; i++) { if ((await call(`/workers/${worker.workerId}`)).data.capabilities.length) break; await new Promise(r => setTimeout(r, 10)) }
  const task = (await call('/projects/default-project/tasks', 'POST', { title: 'HTTP assignment' })).data
  const path = `/projects/default-project/tasks/${task.id}`
  const workspace = (await call('/workspaces', 'POST', { projectId: 'default-project', workerId: worker.workerId, name: 'Target', source: 'empty' })).data.workspace
  const assignee = { workspaceId: workspace.id, workerId: worker.workerId, agentKey: 'test', modelId: 'test' }
  const check = async (expected: string, body: unknown, suffix = '/assignment', bearer = token) => { const r = await call(path + suffix, 'PUT', body, bearer); assert.equal(r.data.error?.code, expected, JSON.stringify(r)) }
  await check('unauthorized', { version: 1, assignee }, '/assignment', 'bad')
  await check('forbidden', { version: 1, assignee }, '/assignment?teamId=wrong')
  await check('invalid_request', { assignee })
  await check('runtime_unavailable', { version: 1, assignee: { ...assignee, workerId: other.workerId } })
  await check('runtime_unavailable', { version: 1, assignee: { ...assignee, agentKey: 'detect' } })
  await check('runtime_unavailable', { version: 1, assignee: { ...assignee, modelId: 'invented' } })
  assert.equal((await call(path + '/assignment', 'PUT', { version: 1, assignee })).status, 200)
  await check('version_conflict', { version: 1, assignee })
  const second = (await call('/projects/default-project/tasks', 'POST', { title: 'Occupied' })).data
  assert.equal((await call(`/projects/default-project/tasks/${second.id}/assignment`, 'PUT', { version: 1, assignee })).data.error.code, 'workspace_bound')
  const project = (await call('/projects', 'POST', { name: 'Other' })).data
  assert.equal((await call(`/projects/${project.id}/tasks/${task.id}/assignment`, 'PUT', { version: 2, assignee })).data.error.code, 'not_found')
  const foreign = (await call('/workspaces', 'POST', { projectId: project.id, workerId: worker.workerId, name: 'Foreign', source: 'empty' })).data.workspace
  await check('forbidden', { version: 2, assignee: { ...assignee, workspaceId: foreign.id } })
  await call(`/workers/${worker.workerId}/revoke`, 'POST', {})
  await check('runtime_unavailable', { version: 2, assignee })
 } finally { ws?.terminate(); await app.close() }
})
