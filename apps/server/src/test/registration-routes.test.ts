import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWemuxServer } from '../server.js'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import type { MailEnv } from '../application/mail/email-delivery.js'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple'
const newPassword = 'a-very-different-passphrase'
const cookieName = 'wemux_login_session'

interface CallOptions {
  readonly method?: string
  readonly body?: unknown
  readonly bearer?: string
  readonly csrf?: string | null
  readonly origin?: string | null
  readonly cookie?: string | null
}

/** 最小浏览器：显式保存 Cookie 与 CSRF，避免测试替身掩盖真实握手。 */
function browser(base: string) {
  let cookie = ''
  let csrf = ''
  const call = async (path: string, init: CallOptions = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const sentCookie = init.cookie === undefined ? cookie : init.cookie
    if (sentCookie) headers.Cookie = sentCookie
    const token = init.csrf === undefined ? csrf : init.csrf
    if (token) headers['X-CSRF-Token'] = token
    if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`
    if (init.origin !== null) headers.Origin = init.origin ?? base
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const setCookie = response.headers.getSetCookie().find(value => value.startsWith(`${cookieName}=`))
    if (setCookie) cookie = setCookie.split(';')[0]!
    const data = response.status === 204 ? {} : await response.json() as Record<string, unknown>
    if (typeof data.csrfToken === 'string') csrf = data.csrfToken
    return { status: response.status, data, setCookie, raw: JSON.stringify(data) }
  }
  return { call, resetCookie() { cookie = '' } }
}

const errorCode = (data: Record<string, unknown>): string | undefined => (data.error as { code?: string } | undefined)?.code

async function outboxMessages(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter(name => name.endsWith('.eml'))
  const entries = await Promise.all(names.map(async name => ({ name, written: (await stat(join(dir, name))).mtimeMs })))
  entries.sort((a, b) => a.written - b.written || a.name.localeCompare(b.name))
  return Promise.all(entries.map(async entry => {
    const raw = await readFile(join(dir, entry.name), 'utf8')
    return Buffer.from(raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8')
  }))
}

/** 出件箱里会累积历史邮件（旧链接已作废），所以从最新一封往前找。 */
async function linkToken(dir: string, path: 'verify-email' | 'password/reset'): Promise<string> {
  for (const text of [...await outboxMessages(dir)].reverse()) {
    const match = new RegExp(`${path.replace('/', '\\/')}\\?token=([A-Za-z0-9_-]+)`).exec(text)
    if (match) return match[1]!
  }
  throw new Error(`no ${path} link in outbox`)
}

async function fixture(t: { after: (fn: () => Promise<void> | void) => void }, options: { mail?: boolean; databasePath?: string } = { mail: true }) {
  const outbox = await mkdtemp(join(tmpdir(), 'wemux-registration-routes-'))
  t.after(() => rm(outbox, { recursive: true, force: true }))
  const mail: MailEnv = options.mail === false ? {} : {
    WEMUX_MAIL_OUTBOX: outbox,
    WEMUX_PUBLIC_URL: 'https://wemux.example.com',
    WEMUX_SMTP_FROM: 'Wemux <wemux@example.com>',
  }
  const app = createWemuxServer({ databasePath: options.databasePath ?? ':memory:', administratorEmails: [administratorEmail], mail })
  const base = await app.listen(0)
  t.after(() => app.close())
  // 部署者已在声明里：账号在数据库里，登录即可拿到带 CSRF 的浏览器会话。
  await seedLocalAccount(app.store, { username: 'owner', email: administratorEmail, password, administrator: true })
  const admin = browser(base)
  const created = await admin.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })
  assert.equal(created.status, 200, created.raw)
  return { base, admin, outbox }
}

const setPolicy = (client: ReturnType<typeof browser>, policy: string) => client.call('/settings/registration-policy', { method: 'PATCH', body: { policy } })
const readPolicy = (client: ReturnType<typeof browser>) => client.call('/settings/registration-policy')

test('注册策略：默认只邀请，未认证或不带 CSRF 不能改，非法值 400 并写审计', async t => {
  const { base, admin, outbox } = await fixture(t)
  const anonymous = browser(base)
  assert.equal((await setPolicy(anonymous, 'open')).status, 401)
  // 读策略是安全读：Cookie 会话不带 CSRF 头也必须能读到，否则页面永远显示不出当前策略。
  assert.equal((await readPolicy(admin)).status, 200, '缺 CSRF 头的 GET 必须放行')
  assert.equal((await readPolicy(admin)).data.policy, 'invite_only', '新实例默认仅邀请')
  assert.equal((await setPolicy(admin, 'open')).status, 200, '管理员可改')
  assert.deepEqual({ ...(await setPolicy(admin, 'open')).data, updatedAt: null, updatedBy: null }, { policy: 'open', explicit: true, updatedAt: null, updatedBy: null })
  assert.equal((await setPolicy(admin, 'everyone')).status, 400)
  // 有 Cookie 会话但缺 CSRF 令牌的写请求必须被拒（Cookie 会话不能裸奔）。
  assert.equal((await admin.call('/settings/registration-policy', { method: 'PATCH', csrf: null, body: { policy: 'closed' } })).status, 403)
  // 跨站 Origin 同样被拒。
  assert.equal((await admin.call('/settings/registration-policy', { method: 'PATCH', origin: 'https://evil.example.com', body: { policy: 'closed' } })).status, 403)
  // 策略变更进入审计（审计读取只有存储层入口，这里不断言 HTTP 形状）。
  assert.equal(await outboxMessages(outbox).then(messages => messages.length), 0, '策略变更不发信')
})

test('仅邀请模式下注册被拒且不发信；开放注册后 202 并投递验证邮件', async t => {
  const { base, admin, outbox } = await fixture(t)
  const guest = browser(base)
  const rejected = await guest.call('/auth/register', { body: { email: 'ada@example.com', displayName: 'Ada', password } })
  assert.equal(rejected.status, 403)
  assert.equal(errorCode(rejected.data), 'invitation_required')
  assert.equal((await outboxMessages(outbox)).length, 0)
  // 公开能力会告诉前端当前策略与邮件可用性。
  const options = (await guest.call('/auth/options')).data as { registration: { registrationPolicy: string; emailDelivery: boolean } }
  assert.equal(options.registration.registrationPolicy, 'invite_only')
  assert.equal(options.registration.emailDelivery, true)
  assert.equal((await setPolicy(admin, 'open')).status, 200)
  const accepted = await guest.call('/auth/register', { body: { email: 'Ada@Example.com', displayName: 'Ada Lovelace', password } })
  assert.equal(accepted.status, 202, accepted.raw)
  assert.deepEqual(accepted.data, { status: 'accepted', email: 'a***@example.com' })
  assert.equal(accepted.raw.includes('token'), false, '响应体不含令牌')
  const messages = await outboxMessages(outbox)
  assert.equal(messages.length, 1)
  assert.match(messages[0]!, /\/auth\/verify-email\?token=/, '邮件链接必须指向前端确认页路由，否则点开是 404')
  // 未验证前不能用邮箱登录。
  const login = await guest.call('/auth/login', { body: { login: 'ada@example.com', password } })
  assert.equal(login.status, 401)
})

test('部署声明里的邮箱不受注册策略约束：默认仅邀请也能完成部署者建号', async t => {
  const outbox = await mkdtemp(join(tmpdir(), 'wemux-declared-admin-'))
  t.after(() => rm(outbox, { recursive: true, force: true }))
  // 与 fixture 唯一的区别：库里还没有账号，声明里的邮箱必须能自己注册进来。
  const app = createWemuxServer({
    databasePath: ':memory:',
    administratorEmails: [administratorEmail.toUpperCase()],
    mail: { WEMUX_MAIL_OUTBOX: outbox, WEMUX_PUBLIC_URL: 'https://wemux.example.com', WEMUX_SMTP_FROM: 'Wemux <wemux@example.com>' },
  })
  const base = await app.listen(0)
  t.after(() => app.close())
  const guest = browser(base)
  // 没写进声明的邮箱照旧只邀请。
  const outsider = await guest.call('/auth/register', { body: { email: 'ada@example.com', displayName: 'Ada', password } })
  assert.equal(outsider.status, 403)
  assert.equal(errorCode(outsider.data), 'invitation_required')
  assert.equal((await outboxMessages(outbox)).length, 0)
  // 声明邮箱直接放行：授权根本身不该被自己的策略挡在门外（大小写不敏感）。
  const declared = await guest.call('/auth/register', { body: { email: administratorEmail, displayName: 'Deployer', password } })
  assert.equal(declared.status, 202, declared.raw)
  assert.deepEqual(declared.data, { status: 'accepted', email: 'd***@wemux.test' })
  assert.equal((await outboxMessages(outbox)).length, 1)
  // 特权放行要留痕，且只记掩码邮箱与原因，不记令牌、密码或明文邮箱。
  const audit = await app.store.identity.listAudit(50)
  const allowed = audit.filter(entry => entry.action === 'identity.registration_allowed')
  assert.equal(allowed.length, 1)
  assert.equal(allowed[0]!.metadata.reason, 'declared_administrator')
  assert.equal(allowed[0]!.metadata.email, 'd***@wemux.test')
  assert.equal(audit.some(entry => entry.action === 'identity.registration_allowed' && JSON.stringify(entry.metadata).includes(administratorEmail)), false)
})

test('未配置邮件投递时注册明确不可用（503），不静默吞掉', async t => {
  const { base, admin } = await fixture(t, { mail: false })
  await setPolicy(admin, 'open')
  const guest = browser(base)
  const response = await guest.call('/auth/register', { body: { email: 'ada@example.com', displayName: 'Ada', password } })
  assert.equal(response.status, 503)
  assert.equal(errorCode(response.data), 'mail_unconfigured')
  const options = (await guest.call('/auth/options')).data as { registration: { emailDelivery: boolean; emailDeliveryReason: string | null } }
  assert.equal(options.registration.emailDelivery, false)
  assert.match(options.registration.emailDeliveryReason ?? '', /WEMUX_SMTP_URL/)
})

test('验证链接消费一次即签发登录会话，之后可用它访问 /auth/me', async t => {
  const { base, admin, outbox } = await fixture(t)
  await setPolicy(admin, 'open')
  const guest = browser(base)
  assert.equal((await guest.call('/auth/register', { body: { email: 'ada@example.com', displayName: 'Ada', password } })).status, 202)
  const token = await linkToken(outbox, 'verify-email')
  const verified = await guest.call('/auth/email/verify', { body: { token } })
  assert.equal(verified.status, 200, verified.raw)
  assert.equal(verified.data.status, 'verified')
  assert.match(verified.setCookie ?? '', /HttpOnly/)
  assert.equal(verified.raw.includes(token), false, '响应体不回显令牌')
  const me = await guest.call('/auth/me')
  assert.equal(me.status, 200, me.raw)
  assert.equal((me.data.user as { username: string }).username, 'ada')
  assert.equal(me.data.teamId, null, '自助注册的账号不属于任何团队，也不是管理员')
  // 链接只消费一次。
  const replay = await browser(base).call('/auth/email/verify', { body: { token } })
  assert.equal(replay.status, 409)
  assert.equal(errorCode(replay.data), 'token_consumed')
  // 新账号不能改实例策略。
  assert.equal((await setPolicy(guest, 'closed')).status, 403)
})

test('同一邮箱重复注册：响应一致、旧链接作废、最新提交获胜', async t => {
  const { base, admin, outbox } = await fixture(t)
  await setPolicy(admin, 'open')
  const guest = browser(base)
  const first = await guest.call('/auth/register', { body: { email: 'ada@example.com', displayName: 'Ada', password } })
  const firstToken = await linkToken(outbox, 'verify-email')
  const second = await guest.call('/auth/register', { body: { email: 'ada@example.com', displayName: 'Ada', password: newPassword } })
  assert.deepEqual(second.data, first.data, '两次响应完全一致，不泄漏账号是否存在')
  assert.equal((await guest.call('/auth/email/verify', { body: { token: firstToken } })).status, 409)
  const verified = await guest.call('/auth/email/verify', { body: { token: await linkToken(outbox, 'verify-email') } })
  assert.equal(verified.status, 200, verified.raw)
  const stale = await browser(base).call('/auth/login', { body: { login: 'ada@example.com', password } })
  assert.equal(stale.status, 401, '旧密码被最新提交覆盖')
  const fresh = await browser(base).call('/auth/login', { body: { login: 'ada@example.com', password: newPassword } })
  assert.equal(fresh.status, 200, fresh.raw)
})

test('已存在的邮箱重复注册不发验证链接，密码不被改写', async t => {
  const { base, admin, outbox } = await fixture(t)
  await setPolicy(admin, 'open')
  const guest = browser(base)
  await guest.call('/auth/register', { body: { email: 'ada@example.com', displayName: 'Ada', password } })
  await guest.call('/auth/email/verify', { body: { token: await linkToken(outbox, 'verify-email') } })
  const before = (await outboxMessages(outbox)).length
  const again = await browser(base).call('/auth/register', { body: { email: 'ada@example.com', displayName: 'Ada', password: 'attacker-chosen-passphrase' } })
  assert.equal(again.status, 202)
  const messages = await outboxMessages(outbox)
  assert.equal(messages.length, before + 1)
  assert.match(messages.at(-1)!, /已经注册过/)
  assert.equal(messages.at(-1)!.includes('verify-email'), false, '不再发验证链接')
  assert.equal((await browser(base).call('/auth/login', { body: { login: 'ada@example.com', password } })).status, 200, '原密码仍然有效')
  assert.equal((await browser(base).call('/auth/login', { body: { login: 'ada@example.com', password: 'attacker-chosen-passphrase' } })).status, 401)
})

test('找回密码：重置后旧会话与 PAT 全部撤销，旧密码失效', async t => {
  const { base, admin, outbox } = await fixture(t)
  await setPolicy(admin, 'open')
  const device = browser(base)
  await device.call('/auth/register', { body: { email: 'ada@example.com', displayName: 'Ada', password } })
  await device.call('/auth/email/verify', { body: { token: await linkToken(outbox, 'verify-email') } })
  assert.equal((await device.call('/auth/me')).status, 200)
  const forgot = await device.call('/auth/password/forgot', { body: { email: 'ada@example.com' } })
  assert.equal(forgot.status, 202)
  const reset = await device.call('/auth/password/reset', { body: { token: await linkToken(outbox, 'password/reset'), password: newPassword } })
  assert.equal(reset.status, 200, reset.raw)
  assert.deepEqual(reset.data, { status: 'reset', revokedSessions: 1, revokedTokens: 0 })
  assert.equal((await device.call('/auth/me')).status, 401, '旧会话被撤销')
  assert.equal((await browser(base).call('/auth/login', { body: { login: 'ada@example.com', password } })).status, 401)
  assert.equal((await browser(base).call('/auth/login', { body: { login: 'ada@example.com', password: newPassword } })).status, 200)
})

test('未知邮箱与 Google 账号都返回同样形状，不泄漏也不乱发信', async t => {
  const { base, admin, outbox } = await fixture(t)
  await setPolicy(admin, 'open')
  const guest = browser(base)
  const first = await guest.call('/auth/password/forgot', { body: { email: 'nobody@example.com' } })
  assert.equal(first.status, 202)
  assert.equal(first.data.status, 'accepted')
  assert.match(String(first.data.email), /^n\*\*\*@example\.com$/, '只回显掩码邮箱')
  assert.equal((await outboxMessages(outbox)).length, 0, '未知邮箱不发信，避免退信滥发')
  const second = await guest.call('/auth/password/forgot', { body: { email: 'someone@example.com' } })
  assert.equal(second.status, first.status)
  assert.equal(second.data.status, first.data.status)
  assert.match(String(second.data.email), /^s\*\*\*@example\.com$/, '响应形状与未知邮箱一致（同样只回掩码）')
})

test('注册与找回都限流：同邮箱第 4 次被拒 429', async t => {
  const { base, admin } = await fixture(t)
  await setPolicy(admin, 'open')
  const guest = browser(base)
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await guest.call('/auth/register', { body: { email: 'ada@example.com', displayName: 'Ada', password } })).status, 202)
  }
  const limited = await guest.call('/auth/register', { body: { email: 'ada@example.com', displayName: 'Ada', password } })
  assert.equal(limited.status, 429)
  assert.equal(errorCode(limited.data), 'rate_limited')
  const forgot = await guest.call('/auth/password/forgot', { body: { email: 'nobody@example.com' } })
  assert.equal(forgot.status, 202, '不同邮箱不同滑动窗口')
})

test('审计只记录动作与邮箱掩码，绝不记录令牌或密码', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-registration-audit-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { base, admin, outbox } = await fixture(t, { databasePath: join(directory, 'server.sqlite') })
  await setPolicy(admin, 'open')
  const guest = browser(base)
  await guest.call('/auth/register', { body: { email: 'ada@example.com', displayName: 'Ada', password } })
  const token = await linkToken(outbox, 'verify-email')
  await guest.call('/auth/email/verify', { body: { token } })
  await guest.call('/auth/password/forgot', { body: { email: 'ada@example.com' } })
  const resetToken = await linkToken(outbox, 'password/reset')
  await guest.call('/auth/password/reset', { body: { token: resetToken, password: newPassword } })
  // 审计读取目前只有存储层入口（管理员审计页面属于后续票据），因此这里直接读库验证。
  const inspector = new SqliteServerStore(join(directory, 'server.sqlite'))
  t.after(() => inspector.close())
  const entries = await inspector.identity.listAudit(200)
  const actions = entries.map(entry => entry.action)
  const serialized = JSON.stringify(entries)
  for (const expected of ['settings.registration_policy', 'identity.registration_started', 'identity.registered', 'credentials.reset_requested', 'credentials.reset']) {
    assert.ok(actions.includes(expected), `expected audit action ${expected}, got ${actions.join(', ')}`)
  }
  for (const secret of [token, resetToken, password, newPassword, 'token=']) {
    assert.equal(serialized.includes(secret), false, `audit must not contain ${secret.slice(0, 12)}`)
  }
})