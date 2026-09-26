import assert from 'node:assert/strict'
import test from 'node:test'

import { createPanelLifetime } from '../src/lib/panel-lifetime.ts'

function manualClock() {
  let nextId = 0
  const timers = new Map()
  return {
    setTimeout(callback) { const id = ++nextId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()) },
  }
}

test('panel leases count references and delay the final unmount', async () => {
  const clock = manualClock()
  const events = []
  const lifetime = createPanelLifetime({
    closeDelayMs: 30_000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onOpen: key => events.push(`open:${key}`),
    onClose: key => events.push(`close:${key}`),
  })

  const first = lifetime.acquire('session:one')
  const second = lifetime.acquire('session:one')
  await Promise.all([first.ready, second.ready])
  assert.deepEqual(events, ['open:session:one'])
  assert.equal(lifetime.references('session:one'), 2)

  first.release()
  clock.flush()
  assert.deepEqual(events, ['open:session:one'])
  assert.equal(lifetime.references('session:one'), 1)

  second.release()
  assert.deepEqual(lifetime.retainedKeys(), ['session:one'])
  clock.flush()
  await lifetime.whenIdle('session:one')
  assert.deepEqual(events, ['open:session:one', 'close:session:one'])
  assert.deepEqual(lifetime.retainedKeys(), [])
})

test('reacquiring before expiry preserves the mounted panel', async () => {
  const clock = manualClock()
  let mounts = 0
  let unmounts = 0
  const lifetime = createPanelLifetime({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onOpen: () => { mounts++ },
    onClose: () => { unmounts++ },
  })

  const first = lifetime.acquire('session:one')
  await first.ready
  first.release()
  const returning = lifetime.acquire('session:one')
  clock.flush()
  await returning.ready

  assert.equal(mounts, 1)
  assert.equal(unmounts, 0)
  returning.release()
})

test('non keep-alive leases close immediately after release', async () => {
  const events = []
  const lifetime = createPanelLifetime({ onOpen: key => events.push(`open:${key}`), onClose: key => events.push(`close:${key}`) })
  const lease = lifetime.acquire('temporary', { keepAlive: false })
  await lease.ready
  lease.release()
  await lifetime.whenIdle('temporary')
  assert.deepEqual(events, ['open:temporary', 'close:temporary'])
})

test('returning to a retained surface does not remount it', () => {
  const clock = manualClock()
  let mounts = 0
  const lifetime = createPanelLifetime({ closeDelayMs: 30_000, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  const renderSurface = () => {
    if (!lifetime.retainedKeys().includes('session-a')) mounts++
    return lifetime.acquire('session-a')
  }
  const first = renderSurface()
  first.release()
  const second = renderSurface()
  assert.equal(mounts, 1)
  second.release()
  clock.flush()
  const third = renderSurface()
  assert.equal(mounts, 2)
  third.release()
})

test('open and close operations for one key are serialized', async () => {
  const clock = manualClock()
  const events = []
  let finishOpen
  const openGate = new Promise(resolve => { finishOpen = resolve })
  const lifetime = createPanelLifetime({
    closeDelayMs: 0,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onOpen: async () => { events.push('open:start'); await openGate; events.push('open:end') },
    onClose: async () => { events.push('close') },
  })

  const lease = lifetime.acquire('terminal')
  lease.release()
  clock.flush()
  await Promise.resolve()
  assert.deepEqual(events, ['open:start'])
  finishOpen()
  await lifetime.whenIdle('terminal')
  assert.deepEqual(events, ['open:start', 'open:end', 'close'])
})
