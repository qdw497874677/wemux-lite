import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { ProjectId, SessionId, UserId } from '@wemux/domain'
import { Notifications } from '../application/notifications.ts'
import type { ServerService } from '../application/server-service.ts'
import type { CanvasCollaborationService } from '../application/canvas-collaboration-service.ts'
import { SessionStreams } from '../http/sse.ts'
import { ProjectStreams } from '../http/project-sse.ts'
import { CanvasCollaborationStreams } from '../http/canvas-collaboration-sse.ts'

const actor = 'actor' as UserId, session = 'session' as SessionId, project = 'project' as ProjectId
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
class Response extends EventEmitter {
  text = ''; destroyed = false; ended = false
  write(frame: string) { this.text += frame; return true }
  writeHead() { return this }
  flushHeaders() {}
  destroy() { this.destroyed = true; this.emit('close') }
  end() { this.ended = true; this.emit('close') }
  get response() { return this as unknown as ServerResponse }
}

for (const kind of ['session', 'project', 'canvas'] as const) {
  test(`${kind}: notification invalidates in-flight credential and coalesces ticks, cleanup stops work`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const notifications = new Notifications(), response = new Response(), gate = barrier()
    let calls = 0, active = 0, maximumActive = 0, valid = true, blocked = false, subscriptions = 0
    const authorize = async () => {
      calls++; active++; maximumActive = Math.max(maximumActive, active)
      const snapshot = valid
      try { if (blocked) { blocked = false; await gate.promise } if (!snapshot) throw new Error('revoked') }
      finally { active-- }
    }
    const original = notifications.onAuthorization.bind(notifications)
    notifications.onAuthorization = (user, listener) => { subscriptions++; const off = original(user, listener); return () => { subscriptions--; off() } }
    if (kind === 'session') new SessionStreams({ notifications, events: async () => ({ events: [{ seq: 1, text: 'sensitive' }], nextSeq: null, freshness: {} }) } as unknown as ServerService).open(response.response, session, 1, actor, authorize, async () => {})
    if (kind === 'project') new ProjectStreams(notifications).open(response.response, project, actor, async () => {}, authorize)
    if (kind === 'canvas') await new CanvasCollaborationStreams({ snapshot: async () => ({ presence: [] }), subscribe: () => () => {}, leave: () => {} } as unknown as CanvasCollaborationService, notifications).open(response.response, actor, project, 0, authorize)
    await settle()
    response.text = ''
    blocked = true
    notifications.authorization(actor)
    await settle()
    const callsAtBarrier = calls
    t.mock.timers.tick(60_000)
    notifications.authorization(actor)
    notifications.authorization(actor)
    if (kind === 'project') notifications.project({ id: '1', projectId: project, taskId: 'sensitive', type: 'task.created' })
    assert.equal(calls, callsAtBarrier, 'only one credential check in flight')
    valid = false
    gate.release()
    await settle()
    assert.equal(maximumActive, 1)
    assert.equal(calls, callsAtBarrier + 1, 'dirty notifications coalesce but are not dropped')
    assert.equal(response.text.includes('sensitive'), false)
    assert.equal(response.destroyed, kind !== 'canvas')
    assert.equal(response.ended, kind === 'canvas')
    assert.equal(subscriptions, 0)
    const finalCalls = calls
    t.mock.timers.tick(60_000); notifications.authorization(actor)
    await settle()
    assert.equal(calls, finalCalls)
  })
}

test('Project bounds pending frames to 1MiB during authorization', async () => {
  const notifications = new Notifications(), response = new Response(), gate = barrier()
  new ProjectStreams(notifications).open(response.response, project, actor, () => gate.promise)
  notifications.project({ id: '1', projectId: project, taskId: 'x'.repeat(1024 * 1024), type: 'task.created' })
  assert.equal(response.destroyed, true)
  assert.equal(response.text.includes('project.event'), false)
  gate.release()
})

for (const kind of ['session', 'project', 'canvas'] as const) {
  test(`${kind}: resource read barrier cannot release a stale batch after notification`, async () => {
    const notifications = new Notifications(), response = new Response(), gate = barrier()
    let valid = true, blocked = false, readStarted = false
    const credential = async () => { if (!valid) throw new Error('revoked') }
    const resource = async () => { if (blocked) { readStarted = true; await gate.promise } }
    if (kind === 'session') new SessionStreams({ notifications, events: async () => { await resource(); return { events: [{ seq: 1, text: 'sensitive' }], nextSeq: null, freshness: {} } } } as unknown as ServerService).open(response.response, session, 1, actor, credential, resource)
    if (kind === 'project') new ProjectStreams(notifications).open(response.response, project, actor, resource, credential)
    if (kind === 'canvas') await new CanvasCollaborationStreams({ snapshot: async () => { await resource(); return { presence: blocked ? [{ userId: actor, displayName: 'sensitive' }] : [] } }, subscribe: () => () => {}, leave: () => {} } as unknown as CanvasCollaborationService, notifications).open(response.response, actor, project, 0, credential)
    await settle(); response.text = ''; blocked = true
    if (kind === 'project') notifications.project({ id: '1', projectId: project, taskId: 'sensitive', type: 'task.created' })
    else notifications.authorization(actor)
    await settle(); assert.equal(readStarted, true)
    valid = false; notifications.authorization(actor); gate.release()
    await settle()
    assert.equal(response.text.includes('sensitive'), false)
    assert.equal(response.destroyed || response.ended, true)
  })
}
