import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TeamId, Timestamp, UserId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.js'

const ownerLogin = 'owner'
const password = 'correct horse battery staple'
const cookieName = 'wemux_login_session'

interface CallOptions {
  readonly method?: string
  readonly body?: unknown
  readonly bearer?: string
  readonly csrf?: string | null
  readonly origin?: string | null
  readonly cookie?: string | null
  readonly userAgent?: string
}

/** 一个最小浏览器：显式保存 Cookie 与 CSRF 令牌，避免测试替身掩盖真实握手。 */
function browser(base: string) {
  let cookie = ''
  let csrf = ''
  const call = async (path: string, init: CallOptions = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const sentCookie = init.cookie === undefined ? cookie : init.cookie
    if (sentCookie) headers.Cookie = sentCookie
    if (init.userAgent) headers['User-Agent'] = init.userAgent
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
    return { status: response.status, data, setCookie }
  }
  return {
    call,
    get cookie() { return cookie },
    get token() { return decodeURIComponent(cookie.slice(`${cookieName}=`.length)) },
    resetCookie() { cookie = '' },
  }
}

interface Account {
  readonly user: { id: string; username: string }
  readonly teamId: string | null
  readonly session: { id: string; current: boolean; client: string | null }
  readonly csrfToken: string
  readonly instanceAdministrator: boolean
}

const errorCode = (data: Record<string, unknown>): string | undefined => (data.error as { code?: string } | undefined)?.code

/**
 * 声明管理员的实例：部署者在启动配置里写下 `WEMUX_ADMIN_EMAILS`，
 * 账号由注册产生（测试里直接落盘账号 + 本机密码，跳过验证邮件）。
 */
async function fixture(databasePath = ':memory:', options: { adminSessionTtlMs?: number } = {}) {
  const app = createWemuxServer({ databasePath, administratorEmails: [administratorEmail], ...options })
  const owner = await seedLocalAccount(app.store, { username: ownerLogin, email: administratorEmail, password })
  const base = await app.listen(0)
  return { app, base, owner, close: () => app.close() }
}

/** 登录并返回已持有 Cookie 会话的浏览器。 */
async function signIn(base: string, login = ownerLogin, userAgent = 'Mozilla/5.0 (Test Browser)') {
  const client = browser(base)
  const response = await client.call('/auth/login', { method: 'POST', body: { login, password }, userAgent })
  assert.equal(response.status, 200, JSON.stringify(response.data))
  return { client, account: response.data as unknown as Account, response }
}

test('声明命中的账号登录即成为实例管理员并补齐默认环境，其他账号保持普通成员', async t => {
  const { app, base, close, owner } = await fixture()
  t.after(close)
  const anonymous = browser(base)
  // 公开状态如实报告：声明了管理员、该邮箱也有账号，但没有任何「认领」概念。
  const options = (await anonymous.call('/auth/options')).data as {
    administratorConfigured: boolean
    administratorRegistered: boolean
    passwordMinimumLength: number
    registration: { registrationPolicy: string; emailDelivery: boolean; emailDeliveryReason: string | null }
  }
  assert.equal(options.administratorConfigured, true)
  assert.equal(options.administratorRegistered, true)
  assert.equal(options.passwordMinimumLength, 15)
  // 实例默认只邀请，且未配置邮件投递时公开注册入口明确不可用（不假装可注册）。
  assert.equal(options.registration.registrationPolicy, 'invite_only')
  assert.equal(options.registration.emailDelivery, false)
  assert.match(options.registration.emailDeliveryReason ?? '', /WEMUX_SMTP_URL/)

  const { client, account, response } = await signIn(base)
  assert.equal(account.user.username, ownerLogin)
  assert.equal(account.instanceAdministrator, true)
  assert.equal(typeof account.teamId, 'string', '管理员首个会话补齐默认 Team/Project')
  // 秘密只以 Cookie 形式送达：响应体不包含登录令牌或其哈希。
  assert.equal('token' in response.data, false)
  assert.equal(JSON.stringify(response.data).includes('tokenHash'), false)
  assert.match(response.setCookie ?? '', /HttpOnly/)
  assert.match(response.setCookie ?? '', /SameSite=Lax/)
  assert.match(response.setCookie ?? '', /Path=\//)
  assert.equal((response.setCookie ?? '').includes('Secure'), false, '明文 HTTP 访问不设置 Secure，否则内网登录会静默失败')

  // 懒提升只写一次，且写明授权根来自启动配置声明。
  const roster = await app.store.identity.listInstanceAdministrators()
  assert.deepEqual(roster.map(record => ({ userId: record.userId, email: record.email, source: record.source })), [{ userId: owner.id, email: administratorEmail, source: 'declared' }])
  assert.ok((await app.store.identity.listAudit(20)).some(entry => entry.action === 'instance.administrator_assigned'))

  // 未声明的账号不会因为先注册、先登录而变成管理员，也不会分到默认 Team。
  await seedLocalAccount(app.store, { username: 'member', email: 'member@example.com', password })
  const member = await signIn(base, 'member')
  assert.equal(member.account.instanceAdministrator, false)
  assert.equal(member.account.teamId, null)
  const memberWorkers = await member.client.call('/workers')
  assert.equal(memberWorkers.status, 200)
  assert.deepEqual(memberWorkers.data, { items: [] }, '普通账号只能看到显式获权的 Worker，不因登录或实例存在节点而自动获得权限')
  assert.equal((await app.store.identity.listInstanceAdministrators()).length, 1, '普通成员不写管理员归属')

  // 退役入口：没有引导令牌，也没有首次认领表单；旧代理令牌入口仍是 410。
  assert.equal((await anonymous.call('/auth/setup', { method: 'POST', body: {} })).status, 401, '匿名调用退役入口不给任何提示')
  assert.equal((await client.call('/auth/setup', { method: 'POST', body: {} })).status, 404, '登录后确认该路由不存在')
  const legacy = await client.call('/auth/session', { method: 'POST', bearer: 'any-bootstrap-shaped-token' })
  assert.equal(legacy.status, 410)
  assert.equal(errorCode(legacy.data), 'retired_endpoint')
  // 伪造的引导令牌不再有任何在线权限。
  assert.equal((await anonymous.call('/workers', { bearer: 'identity-bootstrap-token-1234567890', cookie: null })).status, 401)

  // Cookie 会话可以读管理接口，并且能创建真实资源（写路径的 CSRF 已在别处覆盖）。
  assert.equal((await client.call('/workers')).status, 200)
  assert.equal((await client.call('/projects', { method: 'POST', body: { name: '登录后创建' } })).status, 201)
})

test('密码策略与未知账号不泄露信息：短密码按凭据错误处理，且不产生账号副作用', async t => {
  const { app, base, close } = await fixture()
  t.after(close)
  const client = browser(base)
  const short = await client.call('/auth/login', { method: 'POST', body: { login: ownerLogin, password: 'short' } })
  assert.equal(short.status, 401)
  assert.equal(errorCode(short.data), 'invalid_credentials', '策略细节不在登录响应里泄漏')
  const unknown = await client.call('/auth/login', { method: 'POST', body: { login: 'nobody@example.com', password } })
  assert.equal(unknown.status, 401)
  assert.equal(errorCode(unknown.data), 'invalid_credentials')
  assert.equal((await app.store.identity.listInstanceAdministrators()).length, 0, '失败登录不得写归属')
  // 默认策略是 invite_only：公开注册入口不会直接创建账号；未配置邮件投递时更不会假装可注册。
  const register = await client.call('/auth/register', { method: 'POST', body: { email: 'x@example.com', password: 'short', displayName: 'X' } })
  assert.equal(register.status, 403)
  assert.equal(errorCode(register.data), 'invitation_required')
})

test('登录表单、CSRF 保护与会话轮换构成浏览器闭环', async t => {
  const { base, close } = await fixture()
  t.after(close)
  const client = browser(base)
  const first = await client.call('/auth/login', { method: 'POST', body: { login: ownerLogin, password }, userAgent: 'Mozilla/5.0 (First Browser)' })
  assert.equal(first.status, 200, JSON.stringify(first.data))
  const firstCookie = client.cookie

  const wrong = await client.call('/auth/login', { method: 'POST', body: { login: ownerLogin, password: 'wrong password value here' } })
  assert.equal(wrong.status, 401)
  assert.equal(errorCode(wrong.data), 'invalid_credentials')
  const ok = await client.call('/auth/login', { method: 'POST', body: { login: ownerLogin, password }, userAgent: 'Mozilla/5.0 (Test Browser)' })
  assert.equal(ok.status, 200, JSON.stringify(ok.data))
  // 登录即轮换：旧令牌立即失效，避免会话固定攻击。
  assert.notEqual(client.cookie, firstCookie)
  assert.equal((await browser(base).call('/workers')).status, 401)
  assert.equal((ok.data as unknown as Account).session.client, 'Mozilla/5.0 (Test Browser)')

  // 无 CSRF 的写请求被拒绝；跨站 Origin 被拒绝；两者齐备才通过。
  const missing = await client.call('/projects', { method: 'POST', body: { name: '无令牌' }, csrf: null })
  assert.equal(missing.status, 403)
  assert.equal(errorCode(missing.data), 'csrf_rejected')
  const crossSite = await client.call('/projects', { method: 'POST', body: { name: '跨站' }, origin: 'https://attacker.example' })
  assert.equal(crossSite.status, 403)
  assert.equal(errorCode(crossSite.data), 'origin_rejected')
  assert.equal((await client.call('/projects', { method: 'POST', body: { name: '登录后创建' } })).status, 201)

  const me = await client.call('/auth/me')
  assert.equal(me.status, 200)
  assert.equal(JSON.stringify(me.data).includes('tokenHash'), false)
  assert.equal((me.data.session as { current: boolean }).current, true)
  // 其他标签页持有旧 CSRF 令牌时，/auth/me 轮换并只返回一次明文。
  const rotated = await client.call('/auth/me', { csrf: 'mismatched-token' })
  assert.equal(typeof rotated.data.csrfToken, 'string')
  assert.equal(rotated.data.csrfTokenRotated, true)
  assert.equal((await client.call('/projects', { method: 'POST', body: { name: '轮换后创建' } })).status, 201)
})

test('登录会话与 PAT、Worker 凭据互不冒充，旧会话前缀整体退役', async t => {
  const { base, close } = await fixture()
  t.after(close)
  const { client } = await signIn(base)
  assert.match(client.token, /^[A-Za-z0-9_-]{40,}$/)
  // 登录令牌不是 PAT：放进 Bearer 头没有权限。
  assert.equal((await client.call('/workers', { bearer: client.token, cookie: null })).status, 401)
  // 旧 wemux-session-* 凭证明确退役，并给出可诊断的错误码。
  const retired = await client.call('/workers', { bearer: 'wemux-session-legacy-token', cookie: null })
  assert.equal(retired.status, 401)
  assert.equal(errorCode(retired.data), 'retired_credential')
  // PAT 也不是 Cookie 会话。
  assert.equal((await client.call('/workers', { cookie: `${cookieName}=pat-shaped-token`, csrf: null })).status, 401)
  assert.equal((await client.call('/workers', { cookie: `${cookieName}=${encodeURIComponent(`${client.token}x`)}`, csrf: null })).status, 401)
  // 会话被撤销后同一个令牌立即失去权限。
  assert.equal((await client.call('/auth/logout', { method: 'POST' })).status, 204)
  assert.equal((await client.call('/workers', { cookie: `${cookieName}=${encodeURIComponent(client.token)}`, csrf: null })).status, 401)
})

test('登录失败被限流，而不是消耗哈希 CPU', async t => {
  const { base, close } = await fixture()
  t.after(close)
  const { client } = await signIn(base)
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await client.call('/auth/login', { method: 'POST', body: { login: ownerLogin, password: 'definitely-not-the-password' } })).status, 401)
  }
  const throttled = await client.call('/auth/login', { method: 'POST', body: { login: ownerLogin, password } })
  assert.equal(throttled.status, 429)
  assert.equal(errorCode(throttled.data), 'login_throttled')
})

test('空闲超时后 Cookie 会话失效，需要重新登录', async t => {
  // 用真实时钟等待：`new Date()` 不走 JS 的 Date.now，模拟时间只会骗过自己。
  // TTL 不能太短：全量测试里多个文件并行抢 CPU，落盘账号时的 scrypt 可能吃掉几十毫秒，
  // 40ms 会让「刚拿到的会话」在下一个请求前就过期（历史 flake）。
  const { base, close } = await fixture(':memory:', { adminSessionTtlMs: 400 })
  t.after(close)
  const { client } = await signIn(base)
  assert.equal((await client.call('/workers')).status, 200)
  await new Promise(resolve => setTimeout(resolve, 900))
  assert.equal((await client.call('/workers')).status, 401)
  assert.equal((await client.call('/auth/me')).status, 401)
  assert.equal((await client.call('/auth/login', { method: 'POST', body: { login: ownerLogin, password } })).status, 200)
  assert.equal((await client.call('/workers')).status, 200)
})

test('设备会话列表与撤销只暴露安全字段', async t => {
  const { base, close } = await fixture()
  t.after(close)
  const { client } = await signIn(base)
  const second = browser(base)
  await second.call('/auth/login', { method: 'POST', body: { login: ownerLogin, password }, userAgent: 'Second Device' })
  const sessions = await client.call('/auth/sessions')
  assert.equal(sessions.status, 200)
  const items = (sessions.data as { items: { id: string; current: boolean; client: string | null }[] }).items
  assert.equal(items.length, 2)
  assert.equal(items.filter(item => item.current).length, 1)
  assert.equal(JSON.stringify(items).includes('tokenHash'), false)
  const other = items.find(item => !item.current)!
  assert.equal((await client.call(`/auth/sessions/${other.id}`, { method: 'DELETE' })).status, 204)
  assert.equal((await second.call('/auth/me')).status, 401)
  // 撤销必须立即从活跃设备列表消失（否则界面会继续显示已撤销的设备）。
  const afterRevoke = (await client.call('/auth/sessions')).data as { items: { id: string }[] }
  assert.deepEqual(afterRevoke.items.map(item => item.id), items.filter(item => item.current).map(item => item.id))
  // 重复撤销同一条会话保持幂等（DELETE 语义），列表不变。
  assert.equal((await client.call(`/auth/sessions/${other.id}`, { method: 'DELETE' })).status, 204)
  assert.equal(((await client.call('/auth/sessions')).data as { items: unknown[] }).items.length, 1)
  // 别人的会话不可撤销。
  assert.equal((await second.call(`/auth/sessions/${other.id}`, { method: 'DELETE' })).status, 401)

  const third = browser(base)
  await third.call('/auth/login', { method: 'POST', body: { login: ownerLogin, password } })
  const logoutAll = await client.call('/auth/logout-all', { method: 'POST' })
  assert.equal(logoutAll.status, 200)
  assert.equal((logoutAll.data as { revoked: number }).revoked >= 1, true)
  const afterAll = (await client.call('/auth/sessions')).data as { items: { current: boolean }[] }
  assert.equal(afterAll.items.length, 1, 'logout-all 之后只剩当前设备')
  assert.equal(afterAll.items[0].current, true)
  assert.equal((await third.call('/auth/me')).status, 401)
  assert.equal((await client.call('/auth/me')).status, 200, '当前设备在 logout-all 后保持登录')
  const logout = await client.call('/auth/logout', { method: 'POST' })
  assert.equal(logout.status, 204)
  assert.match(logout.setCookie ?? '', /Max-Age=0/)
  assert.equal((await client.call('/auth/me')).status, 401)
})

test('既有实例：声明命中的历史账号在登录时被提升，未声明账号不会被静默提权', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-lite-identity-'))
  const databasePath = join(directory, 'server.sqlite')
  t.after(() => rm(directory, { recursive: true, force: true }))
  // 既有实例：两个历史账号 + 一个 Team 归属，先直接写入数据库再启动新版本。
  const store = new SqliteServerStore(databasePath)
  const at = new Date().toISOString() as Timestamp
  const legacyTeam = randomUUID() as TeamId
  const declared = { id: randomUUID() as UserId, username: 'legacy-one', email: administratorEmail, createdAt: at }
  const other = { id: randomUUID() as UserId, username: 'legacy-two', email: 'two@example.com', createdAt: at }
  await store.transaction(async tx => {
    await tx.identity.saveTeam({ id: legacyTeam, name: 'Legacy Team', createdAt: at })
    await tx.identity.saveUser(declared as never)
    await tx.identity.saveUser(other as never)
    await tx.identity.saveMembership({ teamId: legacyTeam, userId: declared.id, role: 'owner', joinedAt: at })
    // 历史账号还没有本机密码：升级后由部署者在主机本地重置（此处直接落盘等价状态）。
    await tx.identity.saveLocalAccountCredential({ userId: declared.id, passwordHash: await hashPasswordRef(password), updatedAt: at })
  })
  store.close()

  const app = createWemuxServer({ databasePath, administratorEmails: [administratorEmail] })
  t.after(() => app.close())
  const base = await app.listen(0)

  // 历史 Team 归属保持真实：登录不重写、不删除、不改派。
  assert.equal((await app.store.identity.getTeam(legacyTeam))?.name, 'Legacy Team')
  const { client, account } = await signIn(base, declared.email)
  assert.equal(account.user.username, 'legacy-one')
  assert.equal(account.instanceAdministrator, true, '声明命中的历史账号登录时被提升')
  assert.equal(account.teamId, legacyTeam, '已有 Team 归属优先，不重复建默认环境')
  const roster = await app.store.identity.listInstanceAdministrators()
  assert.deepEqual(roster.map(record => record.userId), [declared.id])
  assert.equal(await app.store.identity.getLocalAccountCredential(other.id), null, '未声明账号没有被写入凭据')
  assert.equal((await app.store.identity.listInstanceAdministrators()).length, 1, '歧义时不静默提权多个账号')
  assert.equal((await client.call('/workers')).status, 200)

  // 未声明账号即使先登录也不会成为管理员。
  const member = browser(base)
  const refused = await member.call('/auth/login', { method: 'POST', body: { login: other.username, password } })
  assert.equal(refused.status, 401, '历史账号没有本机密码，登录必须失败而不是自动提权')
})

async function hashPasswordRef(value: string): Promise<string> {
  const { hashPassword } = await import('../application/password.js')
  return await hashPassword(value)
}
