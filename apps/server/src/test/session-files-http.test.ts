import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocket } from 'ws'
import type { AgentKey, ModelId, Timestamp } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { TransportV2Peer } from './transport-v2-peer.js'
import { administratorEmail, administratorToken, seedOperator } from './fixtures/administrator.js'

const request = async (base: string, token: string, path: string, body: unknown) => {
  const response = await fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, data: await response.json() }
}

test('session file routes authorize the session and proxy list/read/diff responses through the owning Worker', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  await seedOperator(app.store, app.service)
  const base = await app.listen(0)
  t.after(() => app.close())
  const token = administratorToken
  const enrollment = await app.service.createEnrollment({})
  const enrolled = await app.service.enroll({ token: enrollment.token, name: 'files-worker' })
  await app.store.transaction(tx => tx.resources.saveWorker({
    ...enrolled.worker,
    capabilities: [{ agentKey: 'pi' as AgentKey, displayName: 'Pi', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test' as ModelId, displayName: 'Test', source: 'detected' }] }],
  }))
  const project = await app.service.createProject({ name: 'files' })
  const { workspace } = await app.service.createWorkspace({ projectId: project.id, workerId: enrolled.worker.id, name: 'workspace' })
  await app.store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready', workerId: enrolled.worker.id, location: { workspaceId: workspace.id, workerId: enrolled.worker.id, rootPath: '/tmp/workspace', checkouts: [] }, placements: workspace.placements.map(placement => ({ ...placement, status: 'ready' as const, location: { workspaceId: workspace.id, workerId: enrolled.worker.id, rootPath: '/tmp/workspace', checkouts: [] } })) }))
  const { session } = await app.service.createSession({ requestId: 'files-session', workspaceId: workspace.id, title: 'Files', agentKey: 'pi', modelId: 'test' })

  const socket = new WebSocket(`${base.replace('http', 'ws')}/worker/ws`, { headers: { authorization: `Bearer ${enrolled.credential}` } })
  const peer = new TransportV2Peer(socket, enrolled.worker.id)
  await peer.connect({ name: 'files-worker' })
  t.after(() => peer.close())

  const listRequest = request(base, token, `/sessions/${session.id}/fs/list`, { subpath: 'src' })
  const listMessage = await peer.wait(message => message.type === 'fs.request' && message.operation === 'list')
  assert.equal(listMessage.type, 'fs.request')
  peer.send({ type: 'fs.response', requestId: listMessage.requestId, ok: true, operation: 'list', entries: [{ name: 'index.ts', type: 'file', size: 12, mtime: new Date().toISOString() as Timestamp }] })
  const listed = await listRequest
  assert.equal(listed.status, 200)
  assert.equal(listed.data.entries[0].name, 'index.ts')

  const readRequest = request(base, token, `/sessions/${session.id}/fs/read`, { subpath: 'src/index.ts', maxBytes: 1024 })
  const readMessage = await peer.wait(message => message.type === 'fs.request' && message.operation === 'read')
  assert.equal(readMessage.type, 'fs.request')
  peer.send({ type: 'fs.response', requestId: readMessage.requestId, ok: true, operation: 'read', content: 'export {}\n', size: 10, truncated: false, binary: false })
  const read = await readRequest
  assert.equal(read.status, 200)
  assert.equal(read.data.content, 'export {}\n')

  const diffRequest = request(base, token, `/sessions/${session.id}/fs/diff`, { subpath: 'src/index.ts' })
  const diffMessage = await peer.wait(message => message.type === 'fs.request' && message.operation === 'diff')
  assert.equal(diffMessage.type, 'fs.request')
  peer.send({ type: 'fs.response', requestId: diffMessage.requestId, ok: true, operation: 'diff', supported: true, lines: [{ type: 'del', oldLine: 1, text: 'export {}' }, { type: 'add', newLine: 1, text: 'export const value = 1' }] })
  const diff = await diffRequest
  assert.equal(diff.status, 200)
  assert.deepEqual(diff.data.lines, [{ type: 'del', oldLine: 1, text: 'export {}' }, { type: 'add', newLine: 1, text: 'export const value = 1' }])

  assert.equal((await request(base, token, `/sessions/${session.id}/fs/read`, { subpath: 'x', maxBytes: 1024 * 1024 + 1 })).status, 400)
  assert.equal((await request(base, token, `/sessions/${session.id}/fs/diff`, { subpath: '' })).status, 400)
})
