import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { ownershipForHome, SessionOwnership } from '../src/application/session-ownership.js'

test('one Worker home has one ownership fence across lexical and symlink aliases', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wemux-ownership-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  await mkdir(home)
  await symlink(home, join(root, 'alias'))
  const owner = ownershipForHome(home)
  const token = owner.acquire('session' as never)
  assert.ok(token)
  for (const alias of [join(root, 'alias'), join(home, '..', 'home'), relative(process.cwd(), home)]) {
    const competing = ownershipForHome(alias)
    assert.equal(competing.acquire('session' as never), null, `${alias} cannot bypass ownership`)
    competing.release('session' as never, Symbol('not the owner'))
    assert.equal(owner.occupied('session' as never), true)
  }
  let wakes = 0
  const cancel = ownershipForHome(join(root, 'alias')).onRelease('session' as never, () => { wakes++ })
  const ignored = ownershipForHome(join(root, 'alias')).onRelease('session' as never, () => { throw new Error('cancelled waiter fired') })
  ignored()
  owner.release('session' as never, Symbol('wrong final token'))
  assert.equal(wakes, 0)
  owner.release('session' as never, token)
  assert.equal(wakes, 1, 'final alias token release wakes the waiter once')
  owner.release('session' as never, token)
  assert.equal(wakes, 1)
  cancel()
  assert.ok(ownershipForHome(join(root, 'alias')).acquire('session' as never))
})

test('throwing release listener cannot prevent later same-home waiters from waking', () => {
  const owner = new SessionOwnership()
  const session = 'listeners' as never
  const token = owner.acquire(session)!
  let wakes = 0
  const original = console.error
  console.error = () => {}
  try {
    owner.onRelease(session, () => { throw new Error('broken waiter') })
    owner.onRelease(session, () => { wakes++ })
    assert.doesNotThrow(() => owner.release(session, token))
    assert.equal(wakes, 1)
    assert.equal(owner.occupied(session), false)
  } finally { console.error = original }
})

test('nonexistent Worker home fails closed rather than creating an aliasable lexical fence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wemux-ownership-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.throws(() => ownershipForHome(join(root, 'missing')), /ENOENT/)
})
