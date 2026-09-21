import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AuditEntryId, ProjectId, Timestamp, UserId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { AccountLifecycleService } from '../application/account-lifecycle-service.js'
import { AuthenticationService, hashSecret } from '../application/auth.js'
import { IdentityService } from '../application/identity-service.js'
import { Notifications } from '../application/notifications.js'
import { administratorDirectory, administratorEmail, seedAdministrator, seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct-horse-battery-staple'

async function fixture() {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const administrator = await seedAdministrator(app.store)
  const user = await seedLocalAccount(app.store, { username: 'member', email: 'member@example.com', password })
  const directory = administratorDirectory(app.store)
  const identity = new IdentityService(app.store, directory)
  const lifecycle = new AccountLifecycleService(app.store, directory, identity, new Notifications())
  return { app, administrator, user, identity, lifecycle }
}

test('账号状态和 authVersion 立即使 Cookie 与 PAT 失效，恢复后旧凭据也不会复活', async t => {
  const f = await fixture(); t.after(() => f.app.close())
  const issued = await f.identity.issue(f.user, 'test')
  const token = 'wmx_pat_lifecycle'
  await f.app.store.transaction(tx => tx.identity.savePersonalAccessToken({
    id: randomUUID() as never, userId: f.user.id, name: 'lifecycle', scopes: ['read'], tokenHash: hashSecret(token), authVersion: 0,
    createdAt: new Date().toISOString() as Timestamp, expiresAt: '2099-01-01T00:00:00.000Z' as Timestamp, lastUsedAt: null, revokedAt: null,
  }))
  const auth = new AuthenticationService(f.app.store, administratorDirectory(f.app.store))
  assert.equal((await auth.actor({ loginSession: issued.session })).userId, f.user.id)
  assert.equal((await auth.actor({ bearer: token })).userId, f.user.id)

  await f.lifecycle.disable(f.administrator.userId, f.user.id)
  assert.equal(await f.identity.resolveSession(issued.token), null)
  await assert.rejects(() => auth.actor({ bearer: token }), /Unauthorized/)
  assert.equal((await f.app.store.identity.getUser(f.user.id))?.status, 'disabled')

  await f.lifecycle.restore(f.administrator.userId, f.user.id)
  assert.equal((await f.app.store.identity.getUser(f.user.id))?.status, 'active')
  assert.equal(await f.identity.resolveSession(issued.token), null)
  await assert.rejects(() => auth.actor({ bearer: token }), /Unauthorized/)
})

test('销号被所有权阻断，处理后进入 deletion_pending 并去标识；邮箱可复用但历史 actorId 保留', async t => {
  const f = await fixture(); t.after(() => f.app.close())
  const project = { id: randomUUID() as ProjectId, teamId: (await f.app.service.ensureDefaultEnvironment(f.administrator.userId)).team!.id, ownerId: f.user.id, name: 'Owned', shareScope: 'owner-only' as const, deletedAt: null }
  await f.app.store.transaction(tx => tx.resources.saveProject(project))
  await assert.rejects(() => f.lifecycle.requestDeletion(f.user.id), (error: unknown) => (error as { code?: string }).code === 'account_deletion_blocked')
  await f.app.store.transaction(tx => tx.resources.saveProject({ ...project, ownerId: f.administrator.userId }))

  const pending = await f.lifecycle.requestDeletion(f.user.id)
  assert.equal(pending.status, 'deletion_pending')
  await f.lifecycle.confirmDeletion(f.user.id)
  const deleted = await f.app.store.identity.getUser(f.user.id)
  assert.equal(deleted?.status, 'deleted')
  assert.equal(deleted?.email, null)
  assert.match(deleted?.username ?? '', /^已删除账号 /)
  assert.equal(await f.app.store.identity.getUserByEmail('member@example.com'), null)
  const replacement = await seedLocalAccount(f.app.store, { username: 'replacement', email: 'member@example.com', password })
  assert.notEqual(replacement.id, f.user.id)
  assert.equal((await f.app.store.identity.listLoginIdentities(f.user.id)).length, 0, '无外部身份时墓碑集合为空')
  const audit = await f.app.store.identity.queryAudit({ actorId: f.user.id, limit: 100 })
  assert.equal(audit.items.some(entry => entry.action === 'account.deleted' && entry.actorId === f.user.id), true)
})

test('审计筛选、复合游标分页与普通用户范围限制稳定且不泄露秘密', async t => {
  const f = await fixture(); t.after(() => f.app.close())
  const at = new Date().toISOString() as Timestamp
  await f.app.store.transaction(async tx => {
    for (const action of ['session.login', 'pat.created', 'account.disabled']) await tx.audit.append({
      id: randomUUID() as AuditEntryId, actorId: f.user.id, action, resource: { kind: 'user', id: f.user.id }, result: 'succeeded', occurredAt: at,
      metadata: { channel: 'test' },
    })
  })
  const first = await f.lifecycle.audit(f.user.id, { result: 'succeeded', limit: 2 })
  assert.equal(first.items.length, 2)
  assert.ok(first.nextCursor)
  const second = await f.lifecycle.audit(f.user.id, { result: 'succeeded', cursor: first.nextCursor!, limit: 2 })
  assert.equal(new Set([...first.items, ...second.items].map(entry => entry.id)).size, first.items.length + second.items.length)
  await assert.rejects(() => f.lifecycle.audit(f.user.id, { actorId: f.administrator.userId, limit: 10 }), (error: unknown) => (error as { code?: string }).code === 'audit_scope_forbidden')
  const administratorView = await f.lifecycle.audit(f.administrator.userId, { action: 'account.disabled', resourceKind: 'user', limit: 10 })
  assert.equal(administratorView.items.every(entry => entry.action === 'account.disabled'), true)
  assert.equal(JSON.stringify(administratorView).includes(password), false)
})
