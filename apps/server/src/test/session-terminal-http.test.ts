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

test('session terminal lifecycle routes stay policy-closed without contacting the owning Worker', async t => {
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

  for (const [path, body] of [
    ['/terminal', { cols: 80, rows: 24 }],
    ['/terminal/terminal-1/write', { data: 'ls\r' }],
    ['/terminal/terminal-1/resize', { cols: 120, rows: 40 }],
    ['/terminal/terminal-1/dispose', {}],
  ] as const) {
    assert.deepEqual(await call(base, `/sessions/${session.id}${path}`, body), {
      status: 403, data: { error: { code: 'write_channel_closed', message: '平台当前未开放文件和终端写入通道。' } },
    })
  }
  assert.equal(peer.frames.filter(frame => frame.frameType === 'data' && frame.payload.type === 'terminal.request').length, 0)
})
