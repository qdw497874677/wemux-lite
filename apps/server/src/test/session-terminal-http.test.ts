import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocket } from 'ws'
import type { AgentKey, ModelId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { TransportV2Peer } from './transport-v2-peer.js'
import { administratorEmail, administratorToken, seedOperator } from './fixtures/administrator.js'

const call = async (base: string, path: string, body: unknown) => {
  const response = await fetch(`${base}/api${path}`, { method: 'POST', headers: { authorization: `Bearer ${administratorToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, data: await response.json() as any }
}

test('session terminal routes proxy lifecycle requests through the owning worker', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  await seedOperator(app.store, app.service)
  const base = await app.listen(0)
  t.after(() => app.close())
  const enrollment = await app.service.createEnrollment({})
  const enrolled = await app.service.enroll({ token: enrollment.token, name: 'terminal-worker' })
  await app.store.transaction(tx => tx.resources.saveWorker({ ...enrolled.worker, capabilities: [{ agentKey: 'pi' as AgentKey, displayName: 'Pi', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test' as ModelId, displayName: 'Test', source: 'detected' }] }] }))
  const project = await app.service.createProject({ name: 'terminal' })
  const { workspace } = await app.service.createWorkspace({ projectId: project.id, workerId: enrolled.worker.id, name: 'workspace' })
  await app.store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready', workerId: enrolled.worker.id, location: { workspaceId: workspace.id, workerId: enrolled.worker.id, rootPath: '/tmp/workspace', checkouts: [] }, placements: workspace.placements.map(placement => ({ ...placement, status: 'ready' as const, location: { workspaceId: workspace.id, workerId: enrolled.worker.id, rootPath: '/tmp/workspace', checkouts: [] } })) }))
  const { session } = await app.service.createSession({ requestId: 'terminal-session', workspaceId: workspace.id, title: 'Terminal', agentKey: 'pi', modelId: 'test' })
  const socket = new WebSocket(`${base.replace('http', 'ws')}/worker/ws`, { headers: { authorization: `Bearer ${enrolled.credential}` } })
  const peer = new TransportV2Peer(socket, enrolled.worker.id)
  await peer.connect({ name: 'terminal-worker' })
  t.after(() => peer.close())

  const creating = call(base, `/sessions/${session.id}/terminal`, { cols: 80, rows: 24 })
  const create = await peer.wait(message => message.type === 'terminal.request' && message.operation === 'create')
  assert.equal(create.type, 'terminal.request')
  peer.send({ type: 'terminal.response', requestId: create.requestId, ok: true, operation: 'create', terminalId: 'terminal-1', pid: 42 })
  assert.deepEqual(await creating, { status: 201, data: { type: 'terminal.response', requestId: create.requestId, ok: true, operation: 'create', terminalId: 'terminal-1', pid: 42 } })

  for (const [operation, body] of [['write', { data: 'ls\r' }], ['resize', { cols: 120, rows: 40 }], ['dispose', {}]] as const) {
    const pending = call(base, `/sessions/${session.id}/terminal/terminal-1/${operation}`, body)
    const message = await peer.wait(value => value.type === 'terminal.request' && value.operation === operation)
    assert.equal(message.type, 'terminal.request')
    peer.send({ type: 'terminal.response', requestId: message.requestId, ok: true, operation })
    assert.equal((await pending).status, 200)
  }
})
