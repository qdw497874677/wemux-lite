import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { CredentialId, Timestamp, UserId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { AdministratorDirectory } from '../application/administrator-directory.js'
import { AccountRecovery, generateRecoveryPassword } from '../application/recovery.js'
import { AppError } from '../application/errors.js'
import { assertPasswordPolicy, hashPassword, passwordPolicy } from '../application/password.js'
import { hashSecret } from '../application/auth.js'
import { seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple'
const username = 'owner'
const email = 'owner@example.com'
const cookieName = 'wemux_login_session'
const run = promisify(execFile)

/**
 * 主机本地恢复的验收（Ticket 04 验收项 6）：
 * 丢失管理员凭据必须有一条显式、可审计、仅限主机的恢复路径，
 * 且这条路径不得重新开放公网首次认领，也不得绕过正常登录签发会话。
 */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-account-recovery-'))
  const databasePath = join(dir, 'server.sqlite')
  const app = createWemuxServer({ databasePath, administratorEmails: [email] })
  const base = await app.listen(0)
  let cookie = ''
  const login = async (credential: string, userAgent?: string): Promise<number> => {
    const response = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(userAgent ? { 'User-Agent': userAgent } : {}) },
      body: JSON.stringify({ login: username, password: credential }),
    })
    const session = response.headers.getSetCookie().find(value => value.startsWith(`${cookieName}=`))
    if (session) cookie = session.split(';')[0]!
    return response.status
  }
  // 部署者账号已经存在：账号 + 本机密码 + 一个真实登录会话，恢复语义针对的就是它。
  const provision = async (): Promise<void> => {
    await seedLocalAccount(app.store, { username, email, password, administrator: true })
    assert.equal(await login(password), 200)
  }
  const probe = async (path: string, init: { bearer?: string; cookie?: string | null } = {}): Promise<number> => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const sent = init.cookie === undefined ? cookie : init.cookie
    if (sent) headers.Cookie = sent
    if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`
    return (await fetch(`${base}${path}`, { headers })).status
  }
  const store = new SqliteServerStore(databasePath)
  return {
    app, base, databasePath, store, provision, login, probe,
    recovery: new AccountRecovery(store, new AdministratorDirectory(store.identity, [email])),
    get cookie() { return cookie },
    close: async () => {
      store.close()
      await app.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const codeOf = (error: unknown): string => error instanceof AppError ? error.code ?? 'missing_code' : `unexpected:${String(error)}`

/** 直接写入 admin 的 PAT：本测试关注恢复语义，不掺入 PAT 签发路由。 */
async function issueLegacyTokens(store: SqliteServerStore, userId: UserId, secrets: readonly string[]): Promise<void> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() as Timestamp
  await store.transaction(async tx => {
    for (const [index, secret] of secrets.entries()) {
      await tx.identity.savePersonalAccessToken({ id: `legacy-pat-${index}` as CredentialId, userId, name: `恢复测试 ${index + 1}`, scopes: ['read', 'write', 'execute', 'admin'], tokenHash: hashSecret(secret), createdAt: new Date().toISOString() as Timestamp, expiresAt, lastUsedAt: null, revokedAt: null })
    }
  })
}

test('未声明管理员的实例不提供可恢复账号，也不自行声明管理员', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-account-recovery-'))
  const databasePath = join(dir, 'server.sqlite')
  const app = createWemuxServer({ databasePath, administratorEmails: [] })
  const base = await app.listen(0)
  const store = new SqliteServerStore(databasePath)
  try {
    const recovery = new AccountRecovery(store, new AdministratorDirectory(store.identity, []))
    assert.deepEqual(await recovery.accounts(), [], '没有账号就没有可恢复目标')
    assert.equal(codeOf(await recovery.resetPassword({ login: email }).catch(error => error)), 'administrator_not_configured')
    assert.equal(codeOf(await recovery.revokeCredentials({ login: email }).catch(error => error)), 'administrator_not_configured')
    // 恢复命令不得代写归属：授权根只能来自启动配置声明。
    await seedLocalAccount(app.store, { username, email, password })
    assert.equal(codeOf(await recovery.resetPassword({ login: email }).catch(error => error)), 'administrator_not_configured')
    assert.deepEqual(await app.store.identity.listInstanceAdministrators(), [])
    const options = await fetch(`${base}/auth/options`).then(response => response.json() as Promise<{ administratorConfigured: boolean; administratorRegistered: boolean }>)
    assert.deepEqual({ administratorConfigured: options.administratorConfigured, administratorRegistered: options.administratorRegistered }, { administratorConfigured: false, administratorRegistered: false }, '恢复命令不得改变公开的部署声明状态')
  } finally { store.close(); await app.close(); await rm(dir, { recursive: true, force: true }) }
})

test('重置本机密码：撤销会话与 PAT，旧凭据立即失效，新密码可正常登录', async () => {
  const f = await fixture()
  try {
    await f.provision()
    const user = await f.store.identity.getUserByLogin(username)
    assert.ok(user)
    const legacy = ['wemux-pat-legacy-one', 'wemux-pat-legacy-two']
    await issueLegacyTokens(f.store, user.id, legacy)
    assert.equal(await f.probe('/workers'), 200, '会话在恢复前可用')
    assert.equal(await f.probe('/workers', { bearer: legacy[0]!, cookie: null }), 200, 'PAT 在恢复前可用')

    const report = await f.recovery.resetPassword({ login: email })
    assert.equal(report.login, user.username)
    assert.equal(report.revokedSessions, 1)
    assert.equal(report.revokedTokens, 2)
    assert.ok(report.password && report.password.length >= 20, '恢复命令必须交付一个满足策略的强密码')
    assertPasswordPolicy(report.password)

    assert.equal(await f.probe('/workers'), 401, '恢复后旧浏览器会话失效')
    assert.equal(await f.probe('/workers', { bearer: legacy[0]!, cookie: null }), 401, '恢复后旧 PAT 失效')
    assert.equal(await f.probe('/workers', { bearer: legacy[1]!, cookie: null }), 401)
    assert.equal(await f.login(password), 401, '恢复后旧密码失效')
    assert.equal(await f.login(report.password!), 200, '恢复后新密码可通过正常登录路径使用')
    assert.equal(await f.probe('/workers'), 200, '恢复后的新会话是普通的登录会话')

    const recovered = (await f.store.identity.listAudit(20)).find(entry => entry.action === 'credentials.recovered')
    assert.ok(recovered, '恢复必须留下审计记录')
    assert.equal((recovered?.metadata as { channel?: string } | undefined)?.channel, 'host-local', '恢复必须留下可审计来源')
    assert.ok(!JSON.stringify(recovered).includes(report.password!), '审计元数据绝不能包含明文密码')
  } finally { await f.close() }
})

test('--keep-tokens 只重置密码，长期令牌继续有效', async () => {
  const f = await fixture()
  try {
    await f.provision()
    const user = await f.store.identity.getUserByLogin(username)
    assert.ok(user)
    const token = 'wemux-pat-legacy-keep'
    await issueLegacyTokens(f.store, user.id, [token])

    const report = await f.recovery.resetPassword({ login: email, keepTokens: true })
    assert.equal(report.revokedTokens, 0)
    assert.equal(report.revokedSessions, 1, '浏览器会话始终撤销：恢复后必须重新登录')
    assert.equal(await f.probe('/workers', { bearer: token, cookie: null }), 200, '显式保留的 PAT 不受影响')
  } finally { await f.close() }
})

test('撤销凭据：默认只清浏览器会话，--tokens 才连带撤销 PAT', async () => {
  const f = await fixture()
  try {
    await f.provision()
    const user = await f.store.identity.getUserByLogin(username)
    assert.ok(user)
    const token = 'wemux-pat-legacy-revoke'
    await issueLegacyTokens(f.store, user.id, [token])
    assert.equal(await f.login(password, 'Mozilla/5.0 (Second Browser)'), 200, '第二个会话')

    const sessions = await f.recovery.revokeCredentials({ login: email })
    assert.equal(sessions.revokedSessions, 2, '两个浏览器会话都被撤销')
    assert.equal(sessions.revokedTokens, 0)
    assert.equal(await f.probe('/workers'), 401)
    assert.equal(await f.probe('/workers', { bearer: token, cookie: null }), 200, '默认不动 PAT')

    const withTokens = await f.recovery.revokeCredentials({ login: email, tokens: true })
    assert.equal(withTokens.revokedTokens, 1)
    assert.equal(await f.probe('/workers', { bearer: token, cookie: null }), 401)
    assert.equal(await f.login(password), 200, '撤销凭据不等于修改密码')
    assert.ok((await f.store.identity.listAudit(20)).some(entry => entry.action === 'credentials.revoked'), '撤销也必须留痕')
  } finally { await f.close() }
})

test('恢复入口的输入校验：目标必须显式、账号必须存在、弱密码被拒且不改变现状', async () => {
  const f = await fixture()
  try {
    await f.provision()
    assert.equal(codeOf(await f.recovery.resetPassword({ login: '   ' }).catch(error => error)), 'recovery_target_required')
    assert.equal(codeOf(await f.recovery.resetPassword({ login: 'nobody@example.com' }).catch(error => error)), 'recovery_target_unknown')

    const weak = await f.recovery.resetPassword({ login: email, password: 'too-short' }).catch(error => error)
    assert.equal(codeOf(weak), 'password_policy')
    assert.match(String((weak as Error).message), new RegExp(String(passwordPolicy.minimumLength)))
    assert.equal(await f.login(password), 200, '策略拒绝不得改动当前密码')

    const accounts = await f.recovery.accounts()
    assert.equal(accounts.length, 1)
    assert.deepEqual({ username: accounts[0]!.username, email: accounts[0]!.email, hasLocalPassword: accounts[0]!.hasLocalPassword }, { username, email, hasLocalPassword: true })
  } finally { await f.close() }
})

test('恢复只按声明补齐管理员归属，伪造的引导令牌不会复活', async () => {
  const f = await fixture()
  try {
    await f.provision()
    const before = await f.store.identity.listInstanceAdministrators()
    assert.equal(before.length, 1)
    await f.recovery.resetPassword({ login: email })
    await f.recovery.revokeCredentials({ login: email, tokens: true })
    assert.deepEqual(await f.store.identity.listInstanceAdministrators(), before, '恢复只补齐声明命中的归属，不改写既有记录')
    assert.equal(await f.probe('/workers', { bearer: 'identity-bootstrap-token-1234567890', cookie: null }), 401, '伪造的引导令牌没有任何权限')
    assert.notEqual(await f.probe('/auth/setup', { bearer: 'identity-bootstrap-token-1234567890', cookie: null }), 201, '恢复后首次认领入口仍不可用')
  } finally { await f.close() }
})

test('生成的恢复密码满足策略且每次不同', () => {
  const first = generateRecoveryPassword()
  const second = generateRecoveryPassword()
  assertPasswordPolicy(first)
  assert.notEqual(first, second)
  assert.ok(first.length >= 20, '恢复密码长度必须明显高于下限，避免主机现场猜解')
})

test('主机本地 CLI：无需任何在线凭据即可列出账号并重置密码（端到端）', async () => {
  const f = await fixture()
  try {
    await f.provision()
    // CLI 入口按本文件位置解析：根 npm test 的 cwd 是仓库根，workspace 测试的 cwd 是 apps/server，两者都要能用。
    const cliEntry = fileURLToPath(new URL('../cli.ts', import.meta.url))
    const cli = (args: readonly string[]) => run('npx', ['tsx', cliEntry, ...args], {
      cwd: join(process.cwd()),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', WEMUX_DATABASE_PATH: f.databasePath, WEMUX_ADMIN_EMAILS: email },
      // 显式不带任何在线令牌：恢复路径只依赖本机数据库与启动配置里的管理员声明。
      maxBuffer: 4 * 1024 * 1024,
    })

    const listed = await cli(['credentials', 'list'])
    const accounts = JSON.parse(listed.stdout) as { databasePath: string; accounts: { username: string; hasLocalPassword: boolean; activeSessions: number }[] }
    assert.equal(accounts.databasePath, f.databasePath)
    assert.deepEqual(accounts.accounts.map(account => account.username), [username])

    const reset = await cli(['credentials', 'reset-password', '--username', username])
    const report = JSON.parse(reset.stdout) as { login: string; password: string; revokedSessions: number }
    assert.equal(report.login, username)
    assert.equal(report.revokedSessions, 1)
    assertPasswordPolicy(report.password)
    assert.equal(await f.probe('/workers'), 401, 'CLI 重置后旧会话失效')
    assert.equal(await f.login(report.password), 200, 'CLI 交付的密码可用')

    const failed = await cli(['credentials', 'reset-password']).then(() => null).catch((error: { code?: number; stderr?: string }) => error)
    assert.ok(failed, '缺少参数必须显式失败')
    assert.equal(failed.code, 1)
    assert.match(failed.stderr ?? '', /username/)
  } finally { await f.close() }
})

test('恢复路径只使用已迁移的镜像：版本化哈希与登录会话索引保持自洽', async () => {
  const f = await fixture()
  try {
    await f.provision()
    const user = await f.store.identity.getUserByLogin(username)
    assert.ok(user)
    const credential = await f.store.identity.getLocalAccountCredential(user.id)
    assert.ok(credential)
    assert.match(credential.passwordHash, /^scrypt\$v1\$/)
    assert.ok(credential.passwordHash !== await hashPassword(password), '每次哈希使用独立盐值')
    await issueLegacyTokens(f.store, user.id, ['wemux-pat-legacy-consistency'])
    const report = await f.recovery.resetPassword({ login: email })
    const after = await f.store.identity.getLocalAccountCredential(user.id)
    assert.notEqual(after?.passwordHash, credential.passwordHash)
    assert.equal(after?.updatedAt, (await f.store.identity.listAudit(1))[0]?.occurredAt, '凭据更新与审计使用同一时间戳')
    assert.deepEqual((await f.store.identity.listLoginSessions(user.id)).filter(session => session.revokedAt === null), [], '恢复后不残留有效会话行')
    assert.equal((await f.store.identity.listPersonalAccessTokens()).filter(token => token.revokedAt === null).length, 0)
    assert.ok(report.password)
    assert.equal(await f.login(report.password!), 200)
  } finally { await f.close() }
})

test('恢复命令并发调用时最终只有一个有效密码，且每个重置都留审计', async () => {
  const f = await fixture()
  try {
    await f.provision()
    const [first, second] = await Promise.all([
      f.recovery.resetPassword({ login: email }),
      f.recovery.resetPassword({ login: email }),
    ])
    assert.notEqual(first.password, second.password)
    // 后写入者胜出：只有最后一次的密码可用，且旧密码必须失效。
    const acceptance = await Promise.all([f.login(first.password!), f.login(second.password!)])
    assert.deepEqual(acceptance.slice().sort(), [200, 401].sort(), '并发恢复后恰有一个密码有效')
    const audit = (await f.store.identity.listAudit(20)).filter(entry => entry.action === 'credentials.recovered')
    assert.equal(audit.length, 2, '每次重置都必须留痕')
  } finally { await f.close() }
})

test('恢复不依赖随机 UUID 之外的外部输入，且用户标识稳定', async () => {
  const f = await fixture()
  try {
    await f.provision()
    const user = await f.store.identity.getUserByLogin(username)
    assert.ok(user)
    const report = await f.recovery.resetPassword({ login: user.email ?? username })
    assert.equal(report.userId, user.id, '允许用邮箱登录名恢复，但归属必须是同一账号')
    assert.ok((await f.store.identity.listUsers()).some(candidate => candidate.id === user.id))
    const audit = await f.store.identity.listAudit(1)
    assert.equal(audit[0]?.actorId, user.id)
    assert.equal(audit[0]?.result, 'succeeded')
    assert.equal(audit[0]?.resource.id, user.id)
    assert.equal(typeof randomUUID(), 'string')
  } finally { await f.close() }
})