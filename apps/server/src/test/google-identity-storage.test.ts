import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Timestamp, UserId } from '@wemux/domain'
import type { ExternalLoginIdentity, OAuthTransaction, User } from '@wemux/server-domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { migrate } from '../storage/sqlite/migrations.js'
import { ServerService } from '../application/server-service.js'
import { Notifications } from '../application/notifications.js'
import { hashSecret } from '../application/auth.js'
import { seedOperator } from './fixtures/administrator.js'

const at = (value: string): Timestamp => value as Timestamp
const GOOGLE_ISSUER = 'accounts.google.com'

const user = (id: string, email: string | null): User => ({ id: id as UserId, username: id, email, createdAt: at('2026-01-01T00:00:00.000Z') })

const identity = (input: { id: string; subject: string; userId: string; issuer?: string; email?: string | null; lastSignInAt?: Timestamp }): ExternalLoginIdentity => ({
  id: input.id,
  provider: 'google',
  issuer: input.issuer ?? GOOGLE_ISSUER,
  subject: input.subject,
  userId: input.userId as UserId,
  emailAtSignIn: input.email ?? 'someone@example.com',
  emailVerified: true,
  createdAt: at('2026-01-01T00:00:00.000Z'),
  lastSignInAt: input.lastSignInAt ?? at('2026-01-01T00:00:00.000Z'),
})

const oauthTransaction = (input: { id: string; state: string; intent?: OAuthTransaction['intent']; userId?: string | null; sessionId?: string | null; expiresAt?: Timestamp; nonce?: string; returnTo?: string | null }): OAuthTransaction => ({
  id: input.id,
  provider: 'google',
  issuer: GOOGLE_ISSUER,
  stateHash: hashSecret(input.state),
  nonce: input.nonce ?? `nonce-${input.id}`,
  codeVerifier: `verifier-${input.id}`,
  intent: input.intent ?? 'login',
  userId: (input.userId ?? null) as UserId | null,
  sessionId: input.sessionId ?? null,
  returnTo: input.returnTo ?? '/workbench',
  createdAt: at('2026-01-01T00:00:00.000Z'),
  expiresAt: input.expiresAt ?? at('2026-01-01T00:10:00.000Z'),
  consumedAt: null,
})

test('外部身份以 (provider, issuer, subject) 唯一绑定，重复绑定与改派都被拒绝', async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  await seedOperator(store, new ServerService(store, new Notifications()))
  await store.transaction(async tx => {
    await tx.identity.saveUser(user('user-1', 'one@example.com'))
    await tx.identity.saveUser(user('user-2', 'two@example.com'))
    await tx.identity.saveLoginIdentity(identity({ id: 'li-1', subject: 'google-subject-1', userId: 'user-1' }))
  })
  assert.equal((await store.identity.findLoginIdentity('google', GOOGLE_ISSUER, 'google-subject-1'))!.userId, 'user-1')
  assert.deepEqual((await store.identity.listLoginIdentities('user-1' as UserId)).map(r => r.subject), ['google-subject-1'])
  // 同一身份不能改派给第二个账号：同邮箱不代表同一个人。
  await assert.rejects(store.transaction(tx => tx.identity.saveLoginIdentity(identity({ id: 'li-2', subject: 'google-subject-1', userId: 'user-2' }))), /已被占用/)
  // 同一 id 也不能被改写成另一个身份。
  await assert.rejects(store.transaction(tx => tx.identity.saveLoginIdentity(identity({ id: 'li-1', subject: 'google-subject-2', userId: 'user-2' }))), /已被占用/)
  // issuer 不同即是不同身份：规范化由调用方负责，存储层不做猜测性合并。
  assert.equal(await store.identity.findLoginIdentity('google', 'https://accounts.google.com', 'google-subject-1'), null)
  assert.equal(await store.identity.findLoginIdentity('google', GOOGLE_ISSUER, 'google-subject-2'), null)
  assert.deepEqual(await store.identity.listLoginIdentities('user-2' as UserId), [])
  // 不存在的账号不能占位：跨表外键拦住幽灵绑定。
  await assert.rejects(store.transaction(tx => tx.identity.saveLoginIdentity(identity({ id: 'li-3', subject: 'google-subject-3', userId: 'ghost' }))), /FOREIGN KEY/)
})

test('绑定只记录提供方声明，最近登录时间只能前进', async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  await seedOperator(store, new ServerService(store, new Notifications()))
  await store.transaction(async tx => {
    await tx.identity.saveUser(user('user-1', 'one@example.com'))
    await tx.identity.saveLoginIdentity(identity({ id: 'li-1', subject: 'google-subject-1', userId: 'user-1', email: 'declared@example.com' }))
  })
  const bound = (await store.identity.findLoginIdentity('google', GOOGLE_ISSUER, 'google-subject-1'))!
  // 提供方声明的邮箱原样保留，且不改变本地主邮箱归属。
  assert.equal(bound.emailAtSignIn, 'declared@example.com')
  assert.equal(bound.emailVerified, true)
  assert.equal(await store.identity.getUserEmail('user-1' as UserId), null)
  await store.transaction(tx => tx.identity.touchLoginIdentity({ id: 'li-1', lastSignInAt: at('2026-01-02T00:00:00.000Z') }))
  const touched = (await store.identity.findLoginIdentity('google', GOOGLE_ISSUER, 'google-subject-1'))!
  assert.equal(touched.lastSignInAt, '2026-01-02T00:00:00.000Z')
  assert.equal(touched.createdAt, '2026-01-01T00:00:00.000Z')
  // 时间倒流会被拒：单调递增才有审计意义。
  await assert.rejects(store.transaction(tx => tx.identity.touchLoginIdentity({ id: 'li-1', lastSignInAt: at('2026-01-01T12:00:00.000Z') })), /must not move backwards/)
  await assert.rejects(store.transaction(tx => tx.identity.touchLoginIdentity({ id: 'li-missing', lastSignInAt: at('2026-01-02T00:00:00.000Z') })), /Unknown login identity/)
})

test('OAuth 事务只存 state 哈希，单次消费且过期重放都拿不到第二张门票', async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  await seedOperator(store, new ServerService(store, new Notifications()))
  await store.transaction(tx => tx.identity.saveOAuthTransaction(oauthTransaction({ id: 'oauth-1', state: 'state-1' })))
  const found = (await store.identity.findOAuthTransactionByStateHash(hashSecret('state-1')))!
  assert.equal(found.intent, 'login')
  assert.equal(found.userId, null)
  assert.equal(found.returnTo, '/workbench')
  assert.equal(found.consumedAt, null)
  // state 只以哈希入库：明文永远查不到，日志或数据库泄露都不能重放。
  assert.equal(await store.identity.findOAuthTransactionByStateHash('state-1'), null)
  const consumed = await store.transaction(tx => tx.identity.consumeOAuthTransaction({ stateHash: hashSecret('state-1'), consumedAt: at('2026-01-01T00:05:00.000Z') }))
  assert.equal(consumed!.consumedAt, '2026-01-01T00:05:00.000Z')
  assert.equal(consumed!.nonce, 'nonce-oauth-1')
  assert.equal(await store.transaction(tx => tx.identity.consumeOAuthTransaction({ stateHash: hashSecret('state-1'), consumedAt: at('2026-01-01T00:06:00.000Z') })), null)
  assert.equal((await store.identity.findOAuthTransactionByStateHash(hashSecret('state-1')))!.consumedAt, '2026-01-01T00:05:00.000Z')
  // 过期但未消费的事务不会被消费：调用方必须重新发起，而不是复用旧 state。
  await store.transaction(tx => tx.identity.saveOAuthTransaction(oauthTransaction({ id: 'oauth-2', state: 'state-2' })))
  assert.equal(await store.transaction(tx => tx.identity.consumeOAuthTransaction({ stateHash: hashSecret('state-2'), consumedAt: at('2026-01-01T00:11:00.000Z') })), null)
  assert.equal((await store.identity.findOAuthTransactionByStateHash(hashSecret('state-2')))!.consumedAt, null)
  // 同一 state 不能发第二张事务。
  await assert.rejects(store.transaction(tx => tx.identity.saveOAuthTransaction(oauthTransaction({ id: 'oauth-3', state: 'state-1' }))), /已发出/)
  // 未知 state 静默失败，不泄露 state 是否存在。
  assert.equal(await store.identity.findOAuthTransactionByStateHash(hashSecret('nope')), null)
  assert.equal(await store.transaction(tx => tx.identity.consumeOAuthTransaction({ stateHash: hashSecret('nope'), consumedAt: at('2026-01-01T00:00:00.000Z') })), null)
  // 意图与绑定的账号/会话必须一致，nonce 与 PKCE verifier 不能为空。
  await assert.rejects(store.transaction(tx => tx.identity.saveOAuthTransaction(oauthTransaction({ id: 'oauth-4', state: 'state-4', intent: 'login', userId: 'user-1', sessionId: 'session-1' }))), /CHECK/)
  await assert.rejects(store.transaction(tx => tx.identity.saveOAuthTransaction(oauthTransaction({ id: 'oauth-5', state: 'state-5', intent: 'link' }))), /CHECK/)
  await assert.rejects(store.transaction(tx => tx.identity.saveOAuthTransaction(oauthTransaction({ id: 'oauth-6', state: 'state-6', nonce: '' }))), /CHECK/)
  await assert.rejects(store.transaction(tx => tx.identity.saveOAuthTransaction(oauthTransaction({ id: 'oauth-7', state: 'state-7', expiresAt: at('2025-12-31T23:00:00.000Z') }))), /CHECK/)
})

test('绑定关系与一次性材料在数据库层不可改写', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-google-identity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const db = new DatabaseSync(join(dir, 'server.sqlite'))
  migrate(db)
  t.after(() => db.close())
  db.prepare('INSERT INTO records VALUES(?,?,?)').run('user', 'user-1', JSON.stringify(user('user-1', 'one@example.com')))
  db.prepare('INSERT INTO records VALUES(?,?,?)').run('user', 'user-2', JSON.stringify(user('user-2', 'two@example.com')))
  const bound = identity({ id: 'li-1', subject: 'google-subject-1', userId: 'user-1' })
  db.prepare('INSERT INTO login_identities(id,provider,issuer,subject,user_id,last_sign_in_at,data) VALUES(?,?,?,?,?,?,?)')
    .run(bound.id, bound.provider, bound.issuer, bound.subject, bound.userId, bound.lastSignInAt, JSON.stringify(bound))
  const transaction = oauthTransaction({ id: 'oauth-1', state: 'state-1' })
  db.prepare('INSERT INTO oauth_transactions(id,state_hash,provider,intent,user_id,session_id,created_at,expires_at,consumed_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(transaction.id, transaction.stateHash, transaction.provider, transaction.intent, transaction.userId, transaction.sessionId, transaction.createdAt, transaction.expiresAt, transaction.consumedAt, JSON.stringify(transaction))
  // 即使绕过端口直接写库，改绑也会被触发器拒绝。
  assert.throws(() => db.prepare("UPDATE login_identities SET user_id='user-2',data=json_set(json_set(data,'$.userId','user-2'),'$.emailAtSignIn','other@example.com') WHERE id='li-1'").run(), /immutable/)
  assert.throws(() => db.prepare("UPDATE login_identities SET subject='google-subject-2',data=json_set(data,'$.subject','google-subject-2') WHERE id='li-1'").run(), /immutable/)
  assert.throws(() => db.prepare("UPDATE login_identities SET last_sign_in_at=?,data=json_set(data,'$.lastSignInAt',?) WHERE id='li-1'").run(at('2025-12-31T00:00:00.000Z'), at('2025-12-31T00:00:00.000Z')), /must not move backwards/)
  // 一次性材料同样不可改写：state 与 nonce 是 OIDC 的安全根。
  assert.throws(() => db.prepare("UPDATE oauth_transactions SET state_hash=?,data=json_set(data,'$.stateHash',?) WHERE id='oauth-1'").run(hashSecret('state-x'), hashSecret('state-x')), /immutable/)
  assert.throws(() => db.prepare("UPDATE oauth_transactions SET data=json_set(data,'$.nonce','nonce-x') WHERE id='oauth-1'").run(), /immutable/)
  db.prepare("UPDATE oauth_transactions SET consumed_at=?,data=json_set(data,'$.consumedAt',?) WHERE id='oauth-1'").run(at('2026-01-01T00:01:00.000Z'), at('2026-01-01T00:01:00.000Z'))
  // 已消费的记录不能被回退成未消费。
  assert.throws(() => db.prepare("UPDATE oauth_transactions SET consumed_at=NULL,data=json_set(data,'$.consumedAt',NULL) WHERE id='oauth-1'").run(), /immutable/)
})