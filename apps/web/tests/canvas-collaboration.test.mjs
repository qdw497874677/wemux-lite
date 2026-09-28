import assert from 'node:assert/strict'
import test from 'node:test'
import { applyCanvasCollaborationEvent, canvasCollaborationStreamUrl } from '../src/features/session-canvas/canvas-collaboration.ts'

test('canvas collaboration applies only low-sensitivity presence events', () => {
  const initial = { projectId: 'project-1', revision: 0, presence: [] }
  const member = { userId: 'user-1', displayName: '协作者', activeSessionId: 'session-1', typing: false, expiresAt: '2026-03-25T00:00:30.000Z' }
  const updated = applyCanvasCollaborationEvent(initial, 'presence.updated', { id: 1, payload: member })
  assert.deepEqual(updated, { projectId: 'project-1', revision: 1, presence: [member] })
  assert.equal('locks' in updated, false)
  assert.equal('viewport' in updated, false)
  assert.deepEqual(applyCanvasCollaborationEvent(updated, 'presence.left', { id: 2, payload: { userId: 'user-1' } }), { projectId: 'project-1', revision: 2, presence: [] })
})

test('canvas collaboration stream URL stays under the authenticated API namespace', () => {
  assert.equal(canvasCollaborationStreamUrl('project / 1'), '/api/projects/project%20%2F%201/canvas/collaboration/events')
})
