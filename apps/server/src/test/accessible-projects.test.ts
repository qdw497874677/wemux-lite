import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectId, UserId } from '@wemux/domain'
import { ProjectAccessService } from '../application/project-access-service.ts'
import { SharedSqliteDatabase } from '../storage/sqlite/shared-database.ts'
import { SqliteServerStore } from '../storage/sqlite/store.ts'

const actor = 'actor' as UserId

test('accessible Project IDs match key-based roleFrom and JavaScript truthiness, without retaining revoked membership', async () => {
  const database = new SharedSqliteDatabase(':memory:')
  const store = new SqliteServerStore(database)
  const projects = new ProjectAccessService(store)
  const expected: string[] = []
  const project = async (id: string, fields: Record<string, unknown>, visible: boolean) => {
    await store.putRecord('project', id, { id, ownerId: 'other', teamId: 'team', shareScope: 'owner-only', ...fields })
    if (visible) expected.push(id)
  }
  try {
    // Lookup keys, not embedded IDs/roles, establish membership in the existing reader.
    await store.putRecord('membership', `team:${actor}`, { teamId: 'historical-team', userId: 'historical-user', role: 'member' })
    await project('owner', { ownerId: actor, teamId: 'no-membership' }, true)
    await project('team', { shareScope: 'team' }, true)
    await project('private', {}, false)
    await project('selected-no-grant', { shareScope: 'selected-members' }, false)
    await project('missing-scope', { shareScope: undefined }, false)
    for (const role of ['viewer', 'contributor', 'manager']) {
      await project(role, { shareScope: 'selected-members' }, true)
      await store.putRecord('project-grant', `${role}:${actor}`, { projectId: 'historical-project', userId: 'historical-user', role })
    }
    await project('private-grant', {}, true)
    await store.putRecord('project-grant', `private-grant:${actor}`, { role: 'viewer' })
    await project('grant-without-membership', { teamId: 'removed', shareScope: 'team' }, false)
    await store.putRecord('project-grant', `grant-without-membership:${actor}`, { role: 'manager' })
    for (const [i, deletedAt] of [undefined, null, '', false, 0, '0', 'false', 1, [], {}].entries()) {
      await project(`deleted-${i}`, { ownerId: actor, deletedAt }, !deletedAt)
    }
    for (const [i, role] of [undefined, null, '', false, 0, '0', 'historical-role', [], {}].entries()) {
      await project(`role-${i}`, { shareScope: 'team' }, Boolean(role))
      await store.putRecord('project-grant', `role-${i}:${actor}`, { role })
    }
    for (const [i, grant] of [null, false, 0, '', {}, []].entries()) {
      await project(`grant-${i}`, { shareScope: 'team' }, !grant)
      await store.putRecord('project-grant', `grant-${i}:${actor}`, grant)
    }
    for (const [i, membership] of [null, false, 0, '', {}, []].entries()) {
      await project(`membership-${i}`, { teamId: `team-${i}`, shareScope: 'team' }, Boolean(membership))
      await store.putRecord('membership', `team-${i}:${actor}`, membership)
    }
    await project('empty-team', { teamId: '', shareScope: 'team' }, true)
    await store.putRecord('membership', `:${actor}`, {})
    assert.deepEqual((await projects.list(actor)).map(value => value.id), expected)
    assert.deepEqual(await store.resources.listAccessibleProjectIds(actor), expected)
    for (const id of (await store.resources.listProjects()).map(value => value.id)) {
      assert.deepEqual(await store.resources.listAccessibleProjectIds(actor, id), expected.includes(id) ? [id] : [])
    }
    await store.putRecord('project', 'revocable', { id: 'revocable', teamId: 'revocable-team', shareScope: 'selected-members' })
    await store.putRecord('membership', `revocable-team:${actor}`, {})
    await store.putRecord('project-grant', `revocable:${actor}`, { role: 'manager' })
    assert.deepEqual(await store.resources.listAccessibleProjectIds(actor, 'revocable' as ProjectId), ['revocable'])
    database.connection.prepare("DELETE FROM records WHERE kind='membership' AND id=?").run(`revocable-team:${actor}`)
    assert.deepEqual(await store.resources.listAccessibleProjectIds(actor, 'revocable' as ProjectId), [])
  } finally { database.close() }
})

test('bounded authorization fails closed on corrupt Project identities without exposing another Project', async () => {
  const database = new SharedSqliteDatabase(':memory:')
  const store = new SqliteServerStore(database)
  try {
    await store.putRecord('project', 'hidden', { id: 'hidden', ownerId: 'other' })
    await store.putRecord('project', 'alias', { id: 'hidden', ownerId: actor })
    await store.putRecord('project', 'missing-id', { ownerId: actor })
    await store.putRecord('project', 'numeric-id', { id: 42, ownerId: actor })
    for (const [i, teamId] of [undefined, null, 42, {}, []].entries()) {
      await store.putRecord('project', `bad-team-${i}`, { id: `bad-team-${i}`, teamId, shareScope: 'team' })
      await store.putRecord('membership', `${teamId}:${actor}`, { role: 'member' })
    }
    // Deliberate bounded-only divergence: legacy list trusts JSON IDs and coerces
    // malformed team IDs. Neither may become a new authorization identity here.
    assert.ok((await new ProjectAccessService(store).list(actor)).length > 0)
    assert.deepEqual(await store.resources.listAccessibleProjectIds(actor), [])
    for (const id of ['hidden', 'alias', 'missing-id', 'numeric-id', 'bad-team-0', 'missing']) {
      assert.deepEqual(await store.resources.listAccessibleProjectIds(actor, id as ProjectId), [])
    }
  } finally { database.close() }
})

for (const count of [1, 100]) {
  test(`accessible Project IDs use one SELECT for N=${count}; scoped lookup uses records primary key`, async t => {
    const database = new SharedSqliteDatabase(':memory:')
    const store = new SqliteServerStore(database)
    try {
      await store.putRecord('membership', `team:${actor}`, {})
      for (let i = 0; i < count; i++) await store.putRecord('project', `p-${i}`, { id: `p-${i}`, teamId: 'team', shareScope: 'team' })
      const prepare = t.mock.method(database.connection, 'prepare')
      const all = await store.resources.listAccessibleProjectIds(actor)
      assert.equal(all.length, count, 'returned IDs remain proportional to authorized Projects')
      assert.equal(prepare.mock.callCount(), 1, 'one authorization SELECT, no per-Project queries')
      assert.match(String(prepare.mock.calls[0].arguments[0]), /^SELECT p.id FROM records p/)
      prepare.mock.resetCalls()
      assert.deepEqual(await store.resources.listAccessibleProjectIds(actor, 'p-0' as ProjectId), ['p-0'])
      assert.equal(prepare.mock.callCount(), 1)
      const sql = String(prepare.mock.calls[0].arguments[0])
      prepare.mock.restore()
      const plan = database.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ $actorId: actor, $projectId: 'p-0' }).map(row => String(row.detail))
      assert.ok(plan.some(detail => /SEARCH p USING INDEX sqlite_autoindex_records_1 \(kind=\? AND id=\?\)/.test(detail)), plan.join('\n'))
      for (const alias of ['m', 'g']) assert.ok(plan.some(detail => detail.includes(`SEARCH ${alias} USING INDEX sqlite_autoindex_records_1 (kind=? AND id=?)`)), plan.join('\n'))
      t.diagnostic(`N=${count}: one authorization SELECT; ${all.length} IDs returned; scoped plan: ${plan.join('; ')}`)
    } finally { database.close() }
  })
}
