import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectId, SessionId, UserId } from '@wemux/domain'
import { CanvasCollaborationService } from '../application/canvas-collaboration-service.js'
import { AppError } from '../application/errors.js'
import { Notifications } from '../application/notifications.ts'

function createBarrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const projectId = 'project-1' as ProjectId
const owner = 'user-owner' as UserId
const viewer = 'user-viewer' as UserId
const access = { async require(_actor: UserId, _projectId: ProjectId) { return {} as never } }
const sessions = { async require(_actor: UserId, _sessionId: SessionId) { return { projectId } as never } }

test('presence is readable, expires, and invalidates without publishing raw identities', async () => {
  let now = Date.parse('2026-03-25T00:00:00.000Z')
  const service = new CanvasCollaborationService(access, sessions, new Notifications(), () => now, 1_000)
  const notifications: unknown[][] = []
  service.subscribe(projectId, (...args) => { notifications.push(args) })
  await service.updatePresence(owner, projectId, { displayName: 'Owner', activeSessionId: 'session-1', typing: true })
  const visible = await service.snapshot(viewer, projectId)
  assert.equal(visible.presence[0]?.displayName, 'Owner'); assert.equal(visible.presence[0]?.activeSessionId, 'session-1'); assert.equal(visible.presence[0]?.typing, true)
  assert.equal('locks' in visible, false); assert.equal('viewport' in visible, false)
  now += 1_001
  assert.equal((await service.snapshot(viewer, projectId)).presence.length, 0)
  assert.deepEqual(notifications, [[], []])
})

test('private presence is omitted including roster and counters; lookup failures fail closed', async () => {
  let failure: Error | undefined = new AppError(404, 'Session not found')
  const service = new CanvasCollaborationService(access, { async require(actor) { if (actor === viewer && failure) throw failure; return { projectId } as never } }, new Notifications())
  const before = await service.snapshot(viewer, projectId)
  await service.updatePresence(owner, projectId, { displayName: 'Owner', activeSessionId: 'private', typing: true })
  assert.deepEqual(await service.snapshot(viewer, projectId), before)
  assert.equal((await service.snapshot(owner, projectId)).presence.length, 1)
  failure = new Error('storage unavailable')
  await assert.rejects(service.snapshot(viewer, projectId), /storage unavailable/)
  failure = undefined
  assert.equal((await service.snapshot(viewer, projectId)).presence.length, 1)
})

test('presence authorization is checked for every read and update', async () => {
  const allowed = new Set<UserId>([owner])
  const guarded = new CanvasCollaborationService({ async require(actor: UserId) { if (!allowed.has(actor)) throw new Error('revoked'); return {} as never } }, sessions, new Notifications())
  await guarded.updatePresence(owner, projectId, { displayName: 'Owner' })
  allowed.delete(owner)
  await assert.rejects(() => guarded.snapshot(owner, projectId), /revoked/)
  await assert.rejects(() => guarded.updatePresence(owner, projectId, { displayName: 'Owner' }), /revoked/)
})

test('presence rejects inaccessible and cross-project Session submissions', async () => {
  const service = new CanvasCollaborationService(access, { async require(_actor, id) {
    if (id === 'missing') throw new AppError(404, 'Session not found')
    return { projectId: 'other-project' } as never
  } }, new Notifications())
  for (const activeSessionId of ['missing', 'other-project-session']) {
    await assert.rejects(service.updatePresence(owner, projectId, { displayName: 'Owner', activeSessionId }), { status: 404 })
  }
  assert.deepEqual((await service.snapshot(owner, projectId)).presence, [])
})

for (const notification of ['authorization', 'session'] as const) {
  test(`snapshot discards accepted A when ${notification} invalidates while B is held`, async () => {
    const notifications = new Notifications()
    const acceptedB = createBarrier(), releaseB = createBarrier()
    let revoked = false, held = false, viewerReads = 0
    const service = new CanvasCollaborationService(access, { async require(actor, id) {
      if (actor === viewer) {
        viewerReads++
        if (id === 'A' && revoked) throw new AppError(404, 'Session not found')
        if (id === 'B' && !held) { held = true; acceptedB.resolve(); await releaseB.promise }
      }
      return { projectId } as never
    } }, notifications)
    await service.updatePresence(owner, projectId, { displayName: 'A secret', activeSessionId: 'A' })
    await service.updatePresence('other' as UserId, projectId, { displayName: 'B', activeSessionId: 'B' })
    await service.updatePresence('public' as UserId, projectId, { displayName: 'Public' })
    const pending = service.snapshot(viewer, projectId)
    await acceptedB.promise
    revoked = true
    if (notification === 'authorization') notifications.authorization(viewer)
    else notifications.session('A' as SessionId)
    releaseB.resolve()
    const snapshot = await pending
    assert.deepEqual(snapshot.presence.map(value => value.displayName), ['B', 'Public'])
    assert.equal(snapshot.revision, 0)
    assert.equal(viewerReads, 4, 'the entire read is retried, not only the held lookup')
  })
}

test('snapshot installs candidate listeners before project authorization and bounds unstable reads', async () => {
  const notifications = new Notifications()
  let unstable = false, reads = 0, active = 0
  const watched = {
    onSession: (id: SessionId, listener: () => void) => { active++; const off = notifications.onSession(id, listener); return () => { active--; off() } },
    onAuthorization: (id: UserId, listener: () => void) => { active++; const off = notifications.onAuthorization(id, listener); return () => { active--; off() } },
  }
  const service = new CanvasCollaborationService({ async require() {
    if (unstable) { reads++; notifications.session('A' as SessionId) }
    return {} as never
  } }, sessions, watched)
  await service.updatePresence(owner, projectId, { displayName: 'A', activeSessionId: 'A' })
  unstable = true
  await assert.rejects(service.snapshot(viewer, projectId), { status: 503, code: 'canvas_presence_changed' })
  assert.equal(reads, 8)
  assert.equal(active, 0, 'failed reads clean up all temporary listeners')
  unstable = false
  assert.equal((await service.snapshot(viewer, projectId)).presence.length, 1)
  assert.equal(active, 0, 'successful reads clean up all temporary listeners')
})

test('denied snapshots evict empty rooms without evicting presence or active subscribers', async () => {
  const service = new CanvasCollaborationService({ async require(actor) {
    if (actor === viewer) throw new AppError(404, 'Project not found')
    return {} as never
  } }, sessions, new Notifications())
  // Inspect retention without adding a public room/identity diagnostic API.
  const rooms = service['rooms']
  for (let i = 0; i < 20; i++) {
    await assert.rejects(service.snapshot(viewer, `forbidden-${i}` as ProjectId), { status: 404 })
    assert.equal(rooms.size, 0)
  }
  let invalidations = 0
  const unsubscribe = service.subscribe(projectId, () => { invalidations++ })
  const room = rooms.get(projectId)
  await assert.rejects(service.snapshot(viewer, projectId), { status: 404 })
  assert.equal(rooms.get(projectId), room, 'an empty room with a live subscriber must stay mapped')
  await service.updatePresence(owner, projectId, { displayName: 'Owner' })
  assert.equal(invalidations, 1, 'the subscriber still observes writes to the mapped room')
  unsubscribe()
  await assert.rejects(service.snapshot(viewer, projectId), { status: 404 })
  assert.equal(rooms.get(projectId), room, 'real presence survives the last subscriber leaving')
  assert.equal((await service.snapshot(owner, projectId)).presence.length, 1)
  service.leave(owner, projectId)
  assert.equal(rooms.size, 0)
  service.leave(owner, 'missing' as ProjectId)
  assert.equal(rooms.size, 0, 'leaving a missing room must not create one')
})

test('last subscriber evicts only its own mapped empty room', () => {
  const service = new CanvasCollaborationService(access, sessions, new Notifications())
  const rooms = service['rooms']
  const first = service.subscribe(projectId, () => {})
  const second = service.subscribe(projectId, () => {})
  first()
  assert.equal(rooms.size, 1)
  second()
  assert.equal(rooms.size, 0)
  const unsubscribe = service.subscribe(projectId, () => {})
  const replacement = rooms.get(projectId)
  first(); second()
  assert.equal(rooms.get(projectId), replacement, 'old cleanup must not delete a replacement room')
  unsubscribe()
  assert.equal(rooms.size, 0)
  // Isolate the identity guard from the nonempty-room guards above.
  const emptyReplacement = { presence: new Map(), listeners: new Set<() => void>() }
  rooms.set(projectId, emptyReplacement)
  first(); second()
  assert.equal(rooms.get(projectId), emptyReplacement, 'stale cleanup cannot delete even an empty replacement')
})

test('snapshot discards expired A when the clock advances while B authorization is held', async t => {
  let now = Date.parse('2026-03-25T00:00:00.000Z')
  const reachedB = createBarrier(), releaseB = createBarrier()
  t.after(() => releaseB.resolve())
  let held = false
  const reads: string[] = []
  const service = new CanvasCollaborationService(access, { async require(actor, id) {
    if (actor === viewer) {
      reads.push(id)
      if (id === 'B' && !held) { held = true; reachedB.resolve(); await releaseB.promise }
    }
    return { projectId } as never
  } }, new Notifications(), () => now, 1_000)
  await service.updatePresence(owner, projectId, { displayName: 'Expired A', activeSessionId: 'A' })
  now += 500
  await service.updatePresence('other' as UserId, projectId, { displayName: 'Live B', activeSessionId: 'B' })
  const pending = service.snapshot(viewer, projectId)
  await reachedB.promise
  assert.deepEqual(reads, ['A', 'B'])
  now += 500
  releaseB.resolve()
  const snapshot = await pending
  assert.deepEqual(snapshot.presence.map(value => value.activeSessionId), ['B'])
  assert.deepEqual(reads, ['A', 'B', 'B'], 'expiry invalidates and retries the authorized snapshot')
  assert.equal(snapshot.revision, 0)
})
