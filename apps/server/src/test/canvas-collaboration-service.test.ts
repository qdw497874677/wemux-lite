import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectId, UserId } from '@wemux/domain'
import { CanvasCollaborationService } from '../application/canvas-collaboration-service.js'

const projectId = 'project-1' as ProjectId
const owner = 'user-owner' as UserId
const viewer = 'user-viewer' as UserId
const access = { async require(_actor: UserId, _projectId: ProjectId) { return {} as never } }

test('presence is readable, expires, and emits leave without shared governance state', async () => {
  let now = Date.parse('2026-03-25T00:00:00.000Z')
  const service = new CanvasCollaborationService(access, () => now, 1_000)
  const types: string[] = []; service.subscribe(projectId, event => types.push(event.type))
  await service.updatePresence(owner, projectId, { displayName: 'Owner', activeSessionId: 'session-1', typing: true })
  const visible = await service.snapshot(viewer, projectId)
  assert.equal(visible.presence[0]?.displayName, 'Owner'); assert.equal(visible.presence[0]?.activeSessionId, 'session-1'); assert.equal(visible.presence[0]?.typing, true)
  assert.equal('locks' in visible, false); assert.equal('viewport' in visible, false); assert.deepEqual(types, ['presence.updated'])
  now += 1_001
  assert.equal((await service.snapshot(viewer, projectId)).presence.length, 0)
  assert.deepEqual(types, ['presence.updated', 'presence.left'])
})

test('event replay distinguishes contiguous history from snapshot fallback', async () => {
  const service = new CanvasCollaborationService(access)
  await service.updatePresence(owner, projectId, { displayName: 'Owner' })
  assert.equal(service.eventsAfter(projectId, 0).contiguous, false)
  assert.equal(service.eventsAfter(projectId, 1).contiguous, true)
  assert.deepEqual(service.eventsAfter(projectId, 1).events, [])
})

test('presence authorization is checked for every read and update', async () => {
  const allowed = new Set<UserId>([owner])
  const guarded = new CanvasCollaborationService({ async require(actor: UserId) { if (!allowed.has(actor)) throw new Error('revoked'); return {} as never } })
  await guarded.updatePresence(owner, projectId, { displayName: 'Owner' })
  allowed.delete(owner)
  await assert.rejects(() => guarded.snapshot(owner, projectId), /revoked/)
  await assert.rejects(() => guarded.updatePresence(owner, projectId, { displayName: 'Owner' }), /revoked/)
})

test('presence events remain bounded to low-sensitivity fields', async () => {
  const service = new CanvasCollaborationService(access)
  let payload: unknown
  service.subscribe(projectId, event => { payload = event.payload })
  await service.updatePresence(owner, projectId, { displayName: 'Owner', activeSessionId: 'session-1', typing: true })
  assert.deepEqual(Object.keys(payload as Record<string, unknown>).sort(), ['activeSessionId', 'displayName', 'expiresAt', 'typing', 'userId'])
  assert.equal(JSON.stringify(payload).includes('draft'), false)
  assert.equal(JSON.stringify(payload).includes('title'), false)
})
