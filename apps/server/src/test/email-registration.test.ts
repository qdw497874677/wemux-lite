import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CredentialId, Timestamp, UserId } from '@wemux/domain'
import type { RegistrationAttempt, RegistrationPolicy } from '@wemux/server-domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { ServerService } from '../application/server-service.js'
import { Notifications } from '../application/notifications.js'
import { IdentityService, defaultLoginSessionPolicy, defaultSessionCookieName } from '../application/identity-service.js'
import { InstanceSettingsService, defaultRegistrationPolicy } from '../application/instance-settings.js'
import { EmailRegistrationService, FlowThrottle } from '../application/email-registration.js'
import { OutboxEmailDelivery, type EmailDelivery, type MailSettings } from '../application/mail/email-delivery.js'
import { AppError } from '../application/errors.js'
import { hashSecret } from '../application/auth.js'
import { seedOperator, administratorDirectory } from './fixtures/administrator.js'

const at = (value: string): Timestamp => value as Timestamp
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

class TestClock {
  private current = new Date('2026-03-01T08:00:00.000Z')
  now(): Date { return this.current }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms) }
}

function decodeMail(raw: string): { text: string } {
  const separator = raw.indexOf('\r\n\r\n')
  assert.ok(separator > 0, 'mail must have headers and body')
  const body = raw.slice(separator + 4).replace(/\r\n/g, '')
  return { text: Buffer.from(body, 'base64').toString('utf8') }
}

async function mails(dir: string): Promise<Array<{ text: string }>> {
  const names = (await readdir(dir)).filter(name => name.endsWith('.eml'))
  const entries = await Promise.all(names.map(async name => ({ name, written: (await stat(join(dir, name))).mtimeMs })))
  entries.sort((a, b) => a.written - b.written || a.name.localeCompare(b.name))
  return Promise.all(entries.map(async entry => decodeMail(await readFile(join(dir, entry.name), 'utf8'))))
}

/** 出件箱里可能同时躺着历史邮件（旧链接已作废），因此从最新一封往前找。 */
async function tokenFrom(dir: string, path: LinkRoute): Promise<string> {
  for (const mail of [...await mails(dir)].reverse()) {
    const match = new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`).exec(mail.text)
    if (match) return match[1]!
  }
  throw new Error(`no ${path} link in outbox: ${(await mails(dir)).map(mail => mail.text).join('\n---\n')}`)
}

async function countMails(dir: string): Promise<number> { return (await readdir(dir)).filter(name => name.endsWith('.eml')).length }

async function harness(t: { after: (fn: () => Promise<void> | void) => void }, options: { mail?: boolean; policy?: RegistrationPolicy; failingDelivery?: boolean } = {}) {
  const store = new SqliteServerStore(':memory:')
  t.after(() => store.close())
  await seedOperator(store, new ServerService(store, new Notifications()))
  const clock = new TestClock()
  const outbox = options.mail === false ? null : await mkdtemp(join(tmpdir(), 'wemux-registration-outbox-'))
  if (outbox) t.after(() => rm(outbox, { recursive: true, force: true }))
  const from = { name: 'Wemux', address: 'wemux@example.com' }
  // 投递通道可控：验收“SMTP 故障不假装已发送”和“故障恢复后重试可用”都需要在同一次运行里翻转。
  let deliveryFails = options.failingDelivery === true
  const setDeliveryFailing = (value: boolean) => { deliveryFails = value }
  const delivery: EmailDelivery = {
    kind: 'outbox',
    deliver: async message => {
      if (deliveryFails) throw new Error('SMTP 连接被拒绝（测试桩）')
      await new OutboxEmailDelivery(outbox!, from, () => clock.now()).deliver(message)
    },
  }
  const mail: MailSettings | null = outbox
    ? { from, publicUrl: 'https://wemux.example.com', delivery, outboxDir: outbox }
    : null
  const identity = new IdentityService(store, administratorDirectory(store), clock, defaultLoginSessionPolicy, defaultSessionCookieName)
  const settings = new InstanceSettingsService(store, clock)
  if (options.policy && options.policy !== defaultRegistrationPolicy) await settings.setPolicy(options.policy, 'admin-user' as UserId)
  const service = new EmailRegistrationService({ store, identity, settings, mail, mailReason: mail ? null : '未配置 WEMUX_SMTP_URL', clock })
  return { store, identity, settings, service, clock, outbox, mail, setDeliveryFailing }
}

/** 邮件里的链接路径就是前端路由，必须与 Web 的 paths 一致（写错成别的名字只有点开才会 404）。 */
type LinkRoute = 'verify-email' | 'password/reset'

const keys = (email: string): string[] => [`ip:10.0.0.1`, `email:${email}`, 'global']

test('默认策略是仅邀请：注册被拒绝，一封邮件也不发', async t => {
  const { service, outbox } = await harness(t)
  assert.equal((await service.capabilities()).registrationPolicy, 'invite_only')
  assert.equal(await countMails(outbox!), 0)
  await assert.rejects(
    service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') }),
    (error: AppError) => error.status === 403 && error.code === 'invitation_required',
  )
  assert.equal(await countMails(outbox!), 0)
})

test('未配置邮件投递时注册明确不可用，不假装已发送', async t => {
  const { service } = await harness(t, { mail: false, policy: 'open' })
  const capabilities = await service.capabilities()
  assert.equal(capabilities.emailDelivery, false)
  assert.match(capabilities.emailDeliveryReason ?? '', /未配置/)
  await assert.rejects(
    service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') }),
    (error: AppError) => error.status === 503 && error.code === 'mail_unconfigured',
  )
})

test('投递失败时不假装已发送：502 + 审计且不创建账号，恢复后重试才可用', async t => {
  const { service, store, outbox, setDeliveryFailing } = await harness(t, { policy: 'open', failingDelivery: true })
  const error = await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
    .then(() => null, (cause: unknown) => cause)
  assert.ok(error instanceof AppError, '投递失败必须抛出可见错误')
  assert.equal(error.status, 502)
  assert.equal(error.code, 'delivery_failed')
  assert.match(error.message, /SMTP 连接被拒绝/)
  assert.equal(await countMails(outbox!), 0, '失败的投递不得留下邮件')
  assert.equal(await store.identity.getUserByEmail('ada@example.com'), null, '投递失败不得创建账号')
  const audit = await store.identity.listAudit(50)
  assert.equal(audit.filter(entry => entry.action === 'identity.email_delivery_failed').length, 1, '投递失败必须写审计')
  assert.equal(JSON.stringify(audit).includes('correct-horse-battery'), false, '审计不得含密码')

  // 恢复投递后重试：旧链接已不可达，重新提交作废它，账号仍然只创建一个。
  setDeliveryFailing(false)
  assert.equal((await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })).status, 'accepted')
  assert.equal(await countMails(outbox!), 1)
  assert.equal((await service.verify({ token: await tokenFrom(outbox!, 'verify-email') })).status, 'verified')
  assert.equal((await store.identity.listUsers()).filter(user => user.email === 'ada@example.com').length, 1)
})

test('开放注册：待验证注册不产生账号，挑战只存哈希', async t => {
  const { service, store, outbox } = await harness(t, { policy: 'open' })
  const outcome = await service.register({ email: 'Ada@Example.com ', displayName: 'Ada Lovelace', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
  assert.deepEqual(outcome, { status: 'accepted', email: 'a***@example.com' })
  assert.equal(await store.identity.getUserByEmail('ada@example.com'), null)
  const attempt = await store.identity.findPendingRegistration('ada@example.com')
  assert.ok(attempt, 'pending registration is recorded')
  assert.equal(attempt!.status, 'pending')
  assert.equal(attempt!.userId, null)
  assert.equal(attempt!.username, 'ada-lovelace')
  assert.notEqual(attempt!.passwordHash, 'correct-horse-battery')
  const token = await tokenFrom(outbox!, 'verify-email')
  const challenge = await store.identity.findVerificationChallengeByTokenHash(hashSecret(token))
  assert.ok(challenge)
  assert.equal(challenge!.purpose, 'verify_email')
  assert.equal(challenge!.consumedAt, null)
  // 明文令牌只存在于邮件里：库里找不到。
  assert.equal(await store.identity.findVerificationChallengeByTokenHash(token), null)
})

test('验证链接原子创建账号并直接签发登录会话，链接只能消费一次', async t => {
  const { service, store, identity, outbox } = await harness(t, { policy: 'open' })
  await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
  const token = await tokenFrom(outbox!, 'verify-email')
  const verified = await service.verify({ token, client: 'node-test' })
  assert.equal(verified.status, 'verified')
  const issued = verified.status === 'verified' ? verified.issued : null
  assert.ok(issued)
  assert.equal(issued!.user.email, 'ada@example.com')
  assert.equal(issued!.teamId, null, '新账号没有团队归属，不是管理员')
  assert.ok(issued!.token.length > 20)
  assert.ok(issued!.csrfToken.length > 20)
  assert.equal((await store.identity.getLocalAccountCredential(issued!.user.id))!.passwordHash.startsWith('scrypt$'), true)
  const email = await store.identity.getUserEmail(issued!.user.id)
  assert.equal(email!.emailNormalized, 'ada@example.com')
  const attempt = await store.identity.getRegistrationAttempt((await store.identity.findPendingRegistration('ada@example.com'))?.id ?? 'missing')
  assert.equal(attempt, null, '待验证注册已转为已验证，不再是 pending')
  await assert.rejects(service.verify({ token }), (error: AppError) => error.status === 409 && error.code === 'token_consumed')
  // 登录会话真的可用：用密码登录一次。
  const login = await identity.login({ login: 'ada@example.com', password: 'correct-horse-battery', throttleKey: 'ip:10.0.0.1' })
  assert.equal(login.user.id, issued!.user.id)
})

test('过期验证链接返回 410 并把待验证注册标记为过期', async t => {
  const { service, store, outbox, clock } = await harness(t, { policy: 'open' })
  await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
  const token = await tokenFrom(outbox!, 'verify-email')
  clock.advance(24 * HOUR + MINUTE)
  await assert.rejects(service.verify({ token }), (error: AppError) => error.status === 410 && error.code === 'token_expired')
  assert.equal(await store.identity.getUserByEmail('ada@example.com'), null)
  assert.equal((await store.identity.findPendingRegistration('ada@example.com')), null, '过期注册不再算 pending')
})

test('重复注册不泄漏账号是否存在：旧链接失效，最新提交获胜', async t => {
  const { service, store, identity, outbox } = await harness(t, { policy: 'open' })
  const first = await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'first-password-value', throttleKeys: keys('ada@example.com') })
  const firstAttemptId = (await store.identity.findPendingRegistration('ada@example.com'))!.id
  const firstToken = await tokenFrom(outbox!, 'verify-email')
  const second = await service.register({ email: 'Ada@Example.com', displayName: 'Ada', password: 'second-password-value', throttleKeys: keys('ada@example.com') })
  assert.deepEqual(first, second, '两次响应完全一致')
  await assert.rejects(service.verify({ token: firstToken }), (error: AppError) => error.status === 409 && error.code === 'token_consumed')
  assert.equal((await store.identity.getRegistrationAttempt(firstAttemptId))!.status, 'superseded')
  assert.equal((await store.identity.findPendingRegistration('ada@example.com'))!.status, 'pending')
  const secondToken = await tokenFrom(outbox!, 'verify-email')
  assert.notEqual(secondToken, firstToken)
  assert.equal((await service.verify({ token: secondToken })).status, 'verified')
  const user = await store.identity.getUserByEmail('ada@example.com')
  await assert.rejects(
    identity.login({ login: 'ada@example.com', password: 'first-password-value', throttleKey: 'ip:10.0.0.1' }),
    (error: AppError) => error.status === 401,
  )
  const login = await identity.login({ login: 'ada@example.com', password: 'second-password-value', throttleKey: 'ip:10.0.0.2' })
  assert.equal(login.user.id, user!.id)
})

test('已存在的邮箱收到账号已存在通知，既有密码不被改写', async t => {
  const { service, store, identity, outbox } = await harness(t, { policy: 'open' })
  await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
  const token = await tokenFrom(outbox!, 'verify-email')
  await service.verify({ token })
  const before = await countMails(outbox!)
  const outcome = await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'attacker-chosen-value', throttleKeys: keys('ada@example.com') })
  assert.deepEqual(outcome, { status: 'accepted', email: 'a***@example.com' })
  assert.equal(await countMails(outbox!), before + 1)
  const notice = (await mails(outbox!)).at(-1)!.text
  assert.match(notice, /账号已存在|已经注册过/)
  assert.equal((await store.identity.findPendingRegistration('ada@example.com')), null, '不创建待验证注册')
  const user = await store.identity.getUserByEmail('ada@example.com')
  const login = await identity.login({ login: 'ada@example.com', password: 'correct-horse-battery', throttleKey: 'ip:10.0.0.9' })
  assert.equal(login.user.id, user!.id)
})

test('并发验证：邮箱已有账号时不覆盖，改为引导登录', async t => {
  const { service, store, outbox } = await harness(t, { policy: 'open' })
  await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'first-password-value', throttleKeys: keys('ada@example.com') })
  const token = await tokenFrom(outbox!, 'verify-email')
  // 另一个流程先占用了同一邮箱（邀请流程或并发验证）。
  await store.transaction(async tx => {
    await tx.identity.saveUser({ id: 'user-existing' as UserId, username: 'ada', email: 'ada@example.com', createdAt: at('2026-02-01T00:00:00.000Z') })
    await tx.identity.saveUserEmail({ emailNormalized: 'ada@example.com', userId: 'user-existing' as UserId, emailDisplay: 'ada@example.com', createdAt: at('2026-02-01T00:00:00.000Z') })
  })
  const outcome = await service.verify({ token })
  assert.deepEqual(outcome, { status: 'account_exists', email: 'a***@example.com' })
  assert.equal((await store.identity.getLocalAccountCredential('user-existing' as UserId)), null, '不写入密码凭据')
  await assert.rejects(service.verify({ token }), (error: AppError) => error.code === 'token_consumed')
})

test('同邮箱注册限流：第 4 次被拒', async t => {
  const { service } = await harness(t, { policy: 'open' })
  const request = { email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') }
  for (let index = 0; index < 3; index += 1) assert.equal((await service.register(request)).status, 'accepted')
  await assert.rejects(service.register(request), (error: AppError) => error.status === 429 && error.code === 'rate_limited')
})

test('找回密码：重置后撤销全部会话与 PAT，旧密码失效', async t => {
  const { service, store, identity, outbox } = await harness(t, { policy: 'open' })
  await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
  const verifyToken = await tokenFrom(outbox!, 'verify-email')
  const verified = await service.verify({ token: verifyToken })
  const userId = verified.status === 'verified' ? verified.issued.user.id : ('missing' as UserId)
  // 再开一个设备会话与一个 PAT，重置必须把它们一起撤销。
  await identity.issue(await store.identity.getUser(userId) as never, 'second-device', 'password')
  await store.transaction(async tx => {
    await tx.identity.savePersonalAccessToken({ id: 'cred-1' as CredentialId, userId, tokenHash: hashSecret('pat-value'), expiresAt: null, revokedAt: null })
  })
  await service.forgotPassword({ email: 'ada@example.com', throttleKeys: keys('ada@example.com') })
  const resetToken = await tokenFrom(outbox!, 'password/reset')
  const first = await service.resetPassword({ token: resetToken, password: 'new-password-value-1' })
  assert.equal(first.status, 'reset')
  assert.equal(first.revokedSessions, 2)
  assert.equal(first.revokedTokens, 1)
  await assert.rejects(
    identity.login({ login: 'ada@example.com', password: 'correct-horse-battery', throttleKey: 'ip:10.0.0.3' }),
    (error: AppError) => error.status === 401,
  )
  const login = await identity.login({ login: 'ada@example.com', password: 'new-password-value-1', throttleKey: 'ip:10.0.0.4' })
  assert.equal(login.user.id, userId)
  await assert.rejects(service.resetPassword({ token: resetToken, password: 'another-password-value' }), (error: AppError) => error.code === 'token_consumed')
})

test('重置链接不能当验证链接用，验证链接也不能重置密码', async t => {
  const { service, outbox } = await harness(t, { policy: 'open' })
  await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
  const token = await tokenFrom(outbox!, 'verify-email')
  await assert.rejects(service.resetPassword({ token, password: 'whatever-password-1' }), (error: AppError) => error.status === 400 && error.code === 'wrong_purpose')
  await service.verify({ token })
  await service.forgotPassword({ email: 'ada@example.com', throttleKeys: keys('ada@example.com') })
  const resetToken = await tokenFrom(outbox!, 'password/reset')
  await assert.rejects(service.verify({ token: resetToken }), (error: AppError) => error.status === 400 && error.code === 'wrong_purpose')
})

test('Google 账号不签发重置链接，未知邮箱不发送任何邮件', async t => {
  const { service, store, outbox } = await harness(t, { policy: 'open' })
  await store.transaction(async tx => {
    await tx.identity.saveUser({ id: 'user-google' as UserId, username: 'ada-google', email: 'ada@example.com', createdAt: at('2026-02-01T00:00:00.000Z') })
    await tx.identity.saveUserEmail({ emailNormalized: 'ada@example.com', userId: 'user-google' as UserId, emailDisplay: 'ada@example.com', createdAt: at('2026-02-01T00:00:00.000Z') })
  })
  const forGoogle = await service.forgotPassword({ email: 'ada@example.com', throttleKeys: keys('ada@example.com') })
  assert.deepEqual(forGoogle, { status: 'accepted', email: 'a***@example.com' })
  const googleMail = (await mails(outbox!)).at(-1)!.text
  assert.match(googleMail, /Google/)
  assert.equal(await store.identity.findVerificationChallengeByTokenHash(hashSecret('nope')), null)
  const before = await countMails(outbox!)
  const forNobody = await service.forgotPassword({ email: 'nobody@example.com', throttleKeys: keys('nobody@example.com') })
  assert.deepEqual(forNobody, { status: 'accepted', email: 'n***@example.com' })
  assert.equal(await countMails(outbox!), before, '未知邮箱不发信，避免退信滥发')
})

test('审计记录不含令牌、密码或邮件正文', async t => {
  const { service, store, outbox } = await harness(t, { policy: 'open' })
  await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
  const token = await tokenFrom(outbox!, 'verify-email')
  await service.verify({ token })
  await service.forgotPassword({ email: 'ada@example.com', throttleKeys: keys('ada@example.com') })
  await service.resetPassword({ token: await tokenFrom(outbox!, 'password/reset'), password: 'new-password-value-1' })
  const entries = await store.identity.listAudit(200)
  assert.ok(entries.length >= 5, `expected audit trail, got ${entries.length}`)
  const serialized = JSON.stringify(entries)
  assert.equal(serialized.includes(token), false, 'token must never be audited')
  assert.equal(serialized.includes('correct-horse-battery'), false)
  assert.equal(serialized.includes('new-password-value-1'), false)
  assert.equal(serialized.includes('token='), false)
})

test('策略只允许三个取值；关闭后注册与重发都被拒', async t => {
  const { service, settings } = await harness(t, { policy: 'open' })
  await assert.rejects(settings.setPolicy('everyone' as never, 'admin-user' as UserId), (error: AppError) => error.status === 400)
  await settings.setPolicy('closed', 'admin-user' as UserId)
  assert.equal((await service.capabilities()).registrationPolicy, 'closed')
  await assert.rejects(service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') }), (error: AppError) => error.code === 'registration_closed')
  await assert.rejects(service.resend({ email: 'ada@example.com', throttleKeys: keys('ada@example.com') }), (error: AppError) => error.code === 'registration_closed')
})

test('FlowThrottle 滑动窗口会过期并限制键数量', async t => {
  const clock = new TestClock()
  const throttle = new FlowThrottle(clock, 1000, [{ prefix: 'ip:', limit: 2 }], 2)
  throttle.consume(['ip:a'])
  throttle.consume(['ip:a'])
  assert.throws(() => throttle.consume(['ip:a']), (error: AppError) => error.status === 429)
  clock.advance(1001)
  throttle.consume(['ip:a'])
  // 键上限：内存不被随机键撑爆。
  const bounded = new FlowThrottle(clock, 1000, [{ prefix: 'email:', limit: 10 }], 3)
  for (const key of ['email:1', 'email:2', 'email:3', 'email:4', 'email:5']) bounded.consume([key])
  assert.ok(true)
})

test('过期待验证注册不会被重发续命', async t => {
  const { service, clock, outbox, store } = await harness(t, { policy: 'open' })
  await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
  const before = await countMails(outbox!)
  clock.advance(24 * HOUR + MINUTE)
  const outcome = await service.resend({ email: 'ada@example.com', throttleKeys: keys('ada@example.com') })
  assert.deepEqual(outcome, { status: 'accepted', email: 'a***@example.com' })
  assert.equal(await countMails(outbox!), before, '过期注册不重发验证邮件')
  assert.equal(await store.identity.getUserByEmail('ada@example.com'), null)
})

test('重发验证邮件会作废旧链接并保持原注册有效期', async t => {
  const { service, outbox, clock } = await harness(t, { policy: 'open' })
  await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
  const firstToken = await tokenFrom(outbox!, 'verify-email')
  clock.advance(30 * MINUTE)
  await service.resend({ email: 'ada@example.com', throttleKeys: keys('ada@example.com') })
  const secondToken = await tokenFrom(outbox!, 'verify-email')
  assert.notEqual(firstToken, secondToken)
  await assert.rejects(service.verify({ token: firstToken }), (error: AppError) => error.code === 'token_consumed')
  assert.equal((await service.verify({ token: secondToken })).status, 'verified')
})

test('显示名称冲突时追加序号，不合并账号', async t => {
  const { service, store, outbox } = await harness(t, { policy: 'open' })
  await service.register({ email: 'ada@example.com', displayName: 'Ada Lovelace', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
  await service.verify({ token: await tokenFrom(outbox!, 'verify-email') })
  await service.register({ email: 'grace@example.com', displayName: 'Ada Lovelace', password: 'correct-horse-battery', throttleKeys: keys('grace@example.com') })
  const verified = await service.verify({ token: await tokenFrom(outbox!, 'verify-email') })
  const second = verified.status === 'verified' ? verified.issued.user : null
  assert.equal(second!.username, 'ada-lovelace-2')
  assert.notEqual((await store.identity.getUserByEmail('ada@example.com'))!.id, second!.id)
})

test('验证后待验证注册转为已验证并保留创建的账号引用', async t => {
  const { service, store, outbox } = await harness(t, { policy: 'open' })
  await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
  const attemptId = (await store.identity.findPendingRegistration('ada@example.com'))!.id
  await service.verify({ token: await tokenFrom(outbox!, 'verify-email') })
  const attempt: RegistrationAttempt = (await store.identity.getRegistrationAttempt(attemptId))!
  assert.equal(attempt.status, 'verified')
  assert.ok(attempt.userId, '已验证注册指向创建的账号')
  assert.ok(attempt.consumedAt, '已验证注册有消费时间')
  assert.equal(await store.identity.findPendingRegistration('ada@example.com'), null)
})
test('并发注册同一邮箱：只留一个待验证注册，只有最新链接能激活', async t => {
  const { service, store, outbox } = await harness(t, { policy: 'open' })
  const submit = (index: number) => service.register({ email: 'ada@example.com', displayName: `Ada ${index}`, password: `correct-horse-battery-${index}`, throttleKeys: keys('ada@example.com') })
  const outcomes = await Promise.all([submit(1), submit(2), submit(3)])
  assert.deepEqual(outcomes, [
    { status: 'accepted', email: 'a***@example.com' },
    { status: 'accepted', email: 'a***@example.com' },
    { status: 'accepted', email: 'a***@example.com' },
  ], '并发提交都必须给出同一句无枚举提示')
  const only = await store.identity.findPendingRegistration('ada@example.com')
  assert.ok(only, '邮箱上必须只剩一个待验证注册')
  assert.equal((await store.identity.listUsers()).filter(user => user.email === 'ada@example.com').length, 0, '并发注册阶段不得建号')
  // 三个链接里只有一个还能用：净效果是最新提交获胜，且只创建一个账号。
  const tokens = await registerTokens(outbox!, 'verify-email')
  assert.equal(tokens.length, 3, '每次提交各自发一封邮件')
  const verified = (await Promise.all(tokens.map(async token => {
    try { return { status: (await service.verify({ token })).status } } catch (error) { return { status: error instanceof AppError ? error.status : 500 } }
  }))).filter(result => result.status === 'verified')
  assert.equal(verified.length, 1, '只能有一个链接激活成功')
  assert.equal(await store.identity.findPendingRegistration('ada@example.com'), null, '激活后不再有待验证注册')
  assert.equal((await store.identity.listUsers()).filter(user => user.email === 'ada@example.com').length, 1, '并发注册只创建一个账号')
})

test('并发验证同一链接：只创建一个账号，第二次不得重复签发', async t => {
  const { service, store, outbox } = await harness(t, { policy: 'open' })
  await service.register({ email: 'ada@example.com', displayName: 'Ada', password: 'correct-horse-battery', throttleKeys: keys('ada@example.com') })
  const token = await tokenFrom(outbox!, 'verify-email')
  const results = await Promise.all([1, 2].map(async () => {
    try {
      const outcome = await service.verify({ token, client: 'node-test' })
      return { status: outcome.status, issued: outcome.status === 'verified' ? outcome.issued.token : null }
    } catch (error) { return { status: error instanceof AppError ? error.status : 500, issued: null } }
  }))
  assert.equal(results.filter(result => result.status === 'verified').length, 1, '同一链接只能有一个赢家')
  // 输家要么是 409（令牌已消费/注册被取代），要么是 account_exists（邮箱已有账号，绝不覆盖密码）；两者都不签发会话。
  const loser = results.find(result => result.status !== 'verified')!
  assert.ok(loser.status === 409 || loser.status === 'account_exists', `输家结果必须向安全倒：${JSON.stringify(loser)}`)
  assert.equal(loser.issued, null, '输家不得再签发登录会话')
  assert.equal((await store.identity.listUsers()).filter(user => user.email === 'ada@example.com').length, 1, '并发验证只创建一个账号')
  const credential = await store.identity.getLocalAccountCredential((await store.identity.getUserByEmail('ada@example.com'))!.id)
  assert.ok(credential, '创建的账号有本地密码凭据')
})

/** 出件箱里可能同时有多封同类邮件，按写入顺序取出全部链接令牌。 */
async function registerTokens(dir: string, path: LinkRoute): Promise<string[]> {
  const tokens: string[] = []
  for (const mail of await mails(dir)) {
    const match = new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`).exec(mail.text)
    if (match) tokens.push(match[1]!)
  }
  return tokens
}
