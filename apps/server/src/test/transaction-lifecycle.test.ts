import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import type { ServerStoreTx } from '../application/ports/server-store.js'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { newId, now } from '../application/server-service.js'

for (const rollback of [false, true]) {
  test(`escaped tx rejects every method after ${rollback ? 'rollback' : 'commit'} and during the next transaction`, async t => {
    const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
    let escaped!: ServerStoreTx
    let capturedWrite!: ServerStoreTx['identity']['saveLocalAccountCredential']
    const userId = newId<'UserId'>()
    const first = store.transaction(async tx => {
      escaped = tx
      capturedWrite = tx.identity.saveLocalAccountCredential
      await tx.identity.saveLocalAccountCredential({ userId, passwordHash: 'first', updatedAt: now() })
      if (rollback) throw new Error('rollback')
    })
    if (rollback) await assert.rejects(first, /rollback/)
    else await first
    const rejectEveryMethod = async () => {
      // No arguments: lifecycle rejection must happen before any reader/writer body.
      for (const group of Object.values(escaped)) for (const method of Object.values(group)) {
        assert.ok(typeof method === 'function')
        await assert.rejects(method(), /Transaction is no longer active/)
      }
      await assert.rejects(capturedWrite({ userId, passwordHash: 'leaked', updatedAt: now() }), /Transaction is no longer active/)
    }
    await rejectEveryMethod()
    await store.transaction(async tx => {
      assert.notEqual(tx, escaped)
      assert.notEqual(tx.identity, escaped.identity)
      await tx.identity.saveLocalAccountCredential({ userId, passwordHash: 'next', updatedAt: now() })
      await rejectEveryMethod()
      assert.equal((await tx.identity.getLocalAccountCredential(userId))?.passwordHash, 'next')
    })
    assert.equal((await store.identity.getLocalAccountCredential(userId))?.passwordHash, 'next')
  })

  test(`derived async context becomes inactive after ${rollback ? 'rollback' : 'commit'}`, { timeout: 5000 }, async t => {
    const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
    let later!: Promise<void>
    const transaction = store.transaction(async () => {
      later = setImmediate().then(async () => {
        assert.deepEqual(await store.resources.listProjects(), [])
        await store.transaction(async tx => { assert.deepEqual(await tx.resources.listProjects(), []) })
      })
      await assert.rejects(store.resources.listProjects(), /Use tx readers/)
      await assert.rejects(store.transaction(async () => undefined), /Nested transactions/)
      if (rollback) throw new Error('rollback')
    })
    if (rollback) await assert.rejects(transaction, /rollback/)
    else await transaction
    await later
  })
}
