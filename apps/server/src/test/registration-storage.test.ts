import test from 'node:test'
import assert from 'node:assert/strict'
import type { Timestamp, UserId } from '@wemux/domain'
import type { RegistrationAttempt, User, UserEmail, VerificationChallenge } from '@wemux/server-domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { ServerService } from '../application/server-service.js'
import { Notifications } from '../application/notifications.js'
import { hashSecret } from '../application/auth.js'
import { seedOperator } from './fixtures/administrator.js'

const at = (value: string): Timestamp => value as Timestamp

const user = (id: string, email: string | null): User => ({ id: id as UserId, username: id, email, createdAt: at('2026-01-01T00:00:00.000Z') })

const email = (userId: string, normalized: string, display: string): UserEmail => ({ emailNormalized: normalized, userId: userId as UserId, emailDisplay: display, createdAt: at('2026-01-01T00:00:00.000Z') })

const registration = (input: { id: string; email: string; status?: RegistrationAttempt['status']; consumedAt?: Timestamp | null }): RegistrationAttempt => ({
  id: input.id,
  emailNormalized: input.email,
  emailDisplay: input.email,
  username: `user-${input.id}`,
  passwordHash: 'scrypt$v1$N=16384,r=8,p=1$c2FsdA$hash',
  status: input.status ?? 'pending',
  createdAt: at('2026-01-01T00:00:00.000Z'),
  expiresAt: at('2026-01-02T00:00:00.000Z'),
  consumedAt: input.consumedAt ?? null,
  userId: input.status === 'verified' ? ('user-1' as UserId) : null,
})

test('主邮箱占用是原子唯一约束，且不静默改派既有归属', async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  const service = new ServerService(store, new Notifications())
  await seedOperator(store, service)
  await store.transaction(async tx => {
    await tx.identity.saveUser(user('user-1', 'one@example.com'))
    await tx.identity.saveUser(user('user-2', 'two@example.com'))
    await tx.identity.saveUserEmail(email('user-1', 'one@example.com', 'One@Example.com'))
  })
  assert.equal((await store.identity.getUserByEmail('one@example.com'))!.id, 'user-1')
  assert.equal((await store.identity.getUserEmail('user-1' as UserId))!.emailDisplay, 'One@Example.com')
  // 同一邮箱的第二个占用者被拒绝：升级或并发注册都不能悄悄改写归属。
  await assert.rejects(store.transaction(tx => tx.identity.saveUserEmail(email('user-2', 'one@example.com', 'one@example.com'))), /邮箱已被占用/)
  // 一个账号只有一个主邮箱。
  await assert.rejects(store.transaction(tx => tx.identity.saveUserEmail(email('user-1', 'other@example.com', 'other@example.com'))), /邮箱已被占用/)
  assert.equal((await store.identity.getUserEmail('user-2' as UserId)), null)
  // user_emails 通过复合外键引用 records：不存在的账号无法占位。
  await assert.rejects(store.transaction(tx => tx.identity.saveUserEmail(email('ghost', 'ghost@example.com', 'ghost@example.com'))), /FOREIGN KEY/)
})

test('同一邮箱最多一个待验证注册，过期与已验证记录不再占用', async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  await seedOperator(store, new ServerService(store, new Notifications()))
  await store.transaction(tx => tx.identity.saveRegistrationAttempt(registration({ id: 'reg-1', email: 'pending@example.com' })))
  assert.equal((await store.identity.findPendingRegistration('pending@example.com'))!.id, 'reg-1')
  await assert.rejects(store.transaction(tx => tx.identity.saveRegistrationAttempt(registration({ id: 'reg-2', email: 'pending@example.com' }))), /已有待验证注册/)
  // 旧的待验证注册被置为 superseded 后，同一邮箱可以重新提交注册。
  await store.transaction(async tx => {
    const current = (await tx.identity.getRegistrationAttempt('reg-1'))!
    await tx.identity.updateRegistrationAttempt({ ...current, status: 'superseded', consumedAt: at('2026-01-01T01:00:00.000Z') })
    await tx.identity.saveRegistrationAttempt(registration({ id: 'reg-2', email: 'pending@example.com' }))
  })
  assert.equal((await store.identity.findPendingRegistration('pending@example.com'))!.id, 'reg-2')
  // 已验证记录同样不占用 pending 槽位，但历史仍可查询。
  await store.transaction(async tx => {
    const current = (await tx.identity.getRegistrationAttempt('reg-2'))!
    await tx.identity.updateRegistrationAttempt({ ...current, status: 'verified', consumedAt: at('2026-01-01T02:00:00.000Z'), userId: 'user-1' as UserId })
  })
  assert.equal(await store.identity.findPendingRegistration('pending@example.com'), null)
  assert.equal((await store.identity.getRegistrationAttempt('reg-2'))!.status, 'verified')
})

test('待验证注册的身份字段不可改写，终态迁移只允许一次', async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  await seedOperator(store, new ServerService(store, new Notifications()))
  await store.transaction(tx => tx.identity.saveRegistrationAttempt(registration({ id: 'reg-1', email: 'lock@example.com' })))
  const current = (await store.identity.getRegistrationAttempt('reg-1'))!
  // 改密码哈希 = 换账号凭据，必须重建注册而不是改写已有记录。
  await assert.rejects(store.transaction(tx => tx.identity.updateRegistrationAttempt({ ...current, passwordHash: 'scrypt$v1$N=16384,r=8,p=1$c2FsdA$other' })), /immutable/)
  await store.transaction(tx => tx.identity.updateRegistrationAttempt({ ...current, status: 'verified', consumedAt: at('2026-01-01T03:00:00.000Z'), userId: 'user-1' as UserId }))
  // verified 之后不能再变成别的状态。
  const verified = (await store.identity.getRegistrationAttempt('reg-1'))!
  await assert.rejects(store.transaction(tx => tx.identity.updateRegistrationAttempt({ ...verified, status: 'superseded' })), /immutable/)
})

test('验证挑战只存哈希、用途不可互换、单次消费且已消费不可回退', async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  await seedOperator(store, new ServerService(store, new Notifications()))
  await store.transaction(tx => tx.identity.saveRegistrationAttempt(registration({ id: 'reg-1', email: 'verify@example.com' })))
  const challenge: VerificationChallenge = {
    id: 'challenge-1', tokenHash: hashSecret('token-1'), purpose: 'verify_email', targetEmail: 'verify@example.com',
    registrationId: 'reg-1', userId: null, createdAt: at('2026-01-01T00:00:00.000Z'), expiresAt: at('2026-01-02T00:00:00.000Z'), consumedAt: null,
  }
  await store.transaction(tx => tx.identity.saveVerificationChallenge(challenge))
  const found = (await store.identity.findVerificationChallengeByTokenHash(hashSecret('token-1')))!
  assert.equal(found.registrationId, 'reg-1')
  assert.equal(found.userId, null)
  assert.equal((await store.identity.listVerificationChallenges('verify@example.com', 'verify_email', at('2025-12-31T00:00:00.000Z'))).length, 1)
  // 用途是记录的一部分：同一邮箱的找回挑战与验证挑战互不匹配。
  assert.deepEqual(await store.identity.listVerificationChallenges('verify@example.com', 'reset_password', at('2025-12-31T00:00:00.000Z')), [])
  // 单次消费：第一次成功，第二次返回 null 而不是复用同一令牌。
  const consumed = await store.transaction(tx => tx.identity.consumeVerificationChallenge({ tokenHash: hashSecret('token-1'), consumedAt: at('2026-01-01T01:00:00.000Z') }))
  assert.equal(consumed!.consumedAt, '2026-01-01T01:00:00.000Z')
  assert.equal(await store.transaction(tx => tx.identity.consumeVerificationChallenge({ tokenHash: hashSecret('token-1'), consumedAt: at('2026-01-01T02:00:00.000Z') })), null)
  assert.equal((await store.identity.findVerificationChallengeByTokenHash(hashSecret('token-1')))!.consumedAt, '2026-01-01T01:00:00.000Z')
  // 重新插入同一 id 或同一 token 哈希都被拒绝，不会覆盖既有记录。
  await assert.rejects(store.transaction(tx => tx.identity.saveVerificationChallenge(challenge)), /already exists/)
  // 挑战必须要么属于待验证注册、要么属于既有账号：両边都空或都填都是非法状态。
  await assert.rejects(store.transaction(tx => tx.identity.saveVerificationChallenge({ ...challenge, id: 'challenge-2', tokenHash: hashSecret('token-2'), registrationId: null, userId: null })), /CHECK/)
  await assert.rejects(store.transaction(tx => tx.identity.saveVerificationChallenge({ ...challenge, id: 'challenge-3', tokenHash: hashSecret('token-3'), userId: 'user-1' as UserId })), /CHECK/)
  // 同一邮箱可以有多条历史挑战（重发即新建），列表按创建顺序返回。
  await store.transaction(async tx => {
    await tx.identity.saveVerificationChallenge({ ...challenge, id: 'challenge-4', tokenHash: hashSecret('token-4'), createdAt: at('2026-01-01T00:30:00.000Z'), expiresAt: at('2026-01-02T00:30:00.000Z') })
  })
  assert.deepEqual((await store.identity.listVerificationChallenges('verify@example.com', 'verify_email', at('2025-12-31T00:00:00.000Z'))).map(r => r.id), ['challenge-1', 'challenge-4'])
  // 已消费的挑战不可能被回退成未消费（触发器只允许写一次 consumedAt）。
  await assert.rejects(store.transaction(async tx => {
    const record = (await tx.identity.findVerificationChallengeByTokenHash(hashSecret('token-4')))!
    await tx.identity.consumeVerificationChallenge({ tokenHash: hashSecret('token-4'), consumedAt: at('2026-01-01T01:00:00.000Z') })
    await tx.identity.saveVerificationChallenge({ ...record, consumedAt: null })
  }), /already exists/)
})

test('未知注册、缺失挑战与索引不一致都明确失败', async t => {
  const store = new SqliteServerStore(':memory:'); t.after(() => store.close())
  await seedOperator(store, new ServerService(store, new Notifications()))
  assert.equal(await store.identity.getRegistrationAttempt('missing'), null)
  assert.equal(await store.identity.getUserByEmail('nobody@example.com'), null)
  assert.equal(await store.transaction(tx => tx.identity.consumeVerificationChallenge({ tokenHash: hashSecret('nope'), consumedAt: at('2026-01-01T00:00:00.000Z') })), null)
  // 待验证注册的身份字段不可改写，未知 id 直接拒绝。
  await assert.rejects(store.transaction(tx => tx.identity.updateRegistrationAttempt(registration({ id: 'ghost', email: 'ghost@example.com' }))), /Unknown registration attempt/)
})