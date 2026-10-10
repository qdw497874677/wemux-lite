import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { ownershipForHome } from '../src/application/session-ownership.js'

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
  owner.release('session' as never, token)
  assert.ok(ownershipForHome(join(root, 'alias')).acquire('session' as never))
})

test('nonexistent Worker home fails closed rather than creating an aliasable lexical fence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wemux-ownership-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.throws(() => ownershipForHome(join(root, 'missing')), /ENOENT/)
})
