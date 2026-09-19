import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CredentialId, Timestamp, UserId } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { AccountRecovery } from '../application/recovery.js'
import { AdministratorDirectory } from '../application/administrator-directory.js'
import { hashSecret } from '../application/auth.js'
import { seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple'
const username = 'owner'
const email = 'owner@example.com'
const cookieName = 'wemux_login_session'
const pat = 'wemux-pat-redaction-canary'
const run = promisify(execFile)

/** 秘密清单：任何一项出现在审计、落盘文件或 CLI 输出里都算验收失败（Ticket 04 验收项 7）。 */
interface Lifecycle {
  readonly password: string
  readonly sessionToken: string
  readonly csrfToken: string
  readonly pat: string
  readonly databasePath: string
  readonly directory: string
}

async function driveLifecycle(): Promise<{ lifecycle: Lifecycle; close: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-account-redaction-'))
  const databasePath = join(directory, 'server.sqlite')
  const app = createWemuxServer({ databasePath, administratorEmails: [email] })
  await seedLocalAccount(app.store, { username, email, password, administrator: true })
  const close = async () => { await app.close(); await rm(directory, { recursive: true, force: true }) }
  try {
  const base = await app.listen(0)
  const json = async (path: string, init: { method?: string; body?: unknown; bearer?: string; cookie?: string; csrf?: string; userAgent?: string }) => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`
    if (init.cookie) headers.Cookie = init.cookie
    if (init.csrf) headers['X-CSRF-Token'] = init.csrf
    if (init.userAgent) headers['User-Agent'] = init.userAgent
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    return { status: response.status, data: (text ? JSON.parse(text) : {}) as Record<string, unknown>, cookies: response.headers.getSetCookie() }
  }

  // 真实登录（旧会话）、失败登录、登出：这些路径都可能不小心把秘密写进审计或日志。
  const setup = await json('/auth/login', { method: 'POST', body: { login: username, password }, userAgent: 'Mozilla/5.0 (Redaction Setup)' })
  assert.equal(setup.status, 200)
  const cookie = setup.cookies.find(value => value.startsWith(`${cookieName}=`))!.split(';')[0]!
  const sessionToken = decodeURIComponent(cookie.slice(`${cookieName}=`.length))
  const csrfToken = setup.data.csrfToken as string
  assert.ok(sessionToken && csrfToken)

  const login = await json('/auth/login', { method: 'POST', body: { login: username, password }, userAgent: 'Mozilla/5.0 (Redaction Browser)' })
  assert.equal(login.status, 200)
  const secondCookie = login.cookies.find(value => value.startsWith(`${cookieName}=`))!.split(';')[0]!
  const secondToken = decodeURIComponent(secondCookie.slice(`${cookieName}=`.length))
  const secondCsrf = login.data.csrfToken as string
  assert.equal((await json('/auth/login', { method: 'POST', body: { login: username, password: 'definitely-not-the-password' } })).status, 401)
  assert.equal((await json('/auth/logout', { method: 'POST', cookie: secondCookie, csrf: secondCsrf })).status, 204)

  const store = new SqliteServerStore(databasePath)
  const user = await store.identity.getUserByLogin(username)
  assert.ok(user)
  await store.transaction(async tx => {
    await tx.identity.savePersonalAccessToken({ id: 'redaction-pat' as CredentialId, userId: user.id, tokenHash: hashSecret(pat), expiresAt: new Date(Date.now() + 60_000).toISOString() as Timestamp, revokedAt: null })
  })
  const recovery = new AccountRecovery(store, new AdministratorDirectory(store.identity, [email]))
  const report = await recovery.resetPassword({ login: email })
  assert.ok(report.password)
  assert.equal(await recovery.revokeCredentials({ login: email, tokens: true }).then(() => true), true)
  store.close()

  return {
    lifecycle: { password, sessionToken, csrfToken, pat, databasePath, directory },
    close,
  }
  } catch (error) {
    await close()
    throw error
  }
}

const secrets = (lifecycle: Lifecycle): readonly [string, string][] => [
  ['登录密码', lifecycle.password],
  ['恢复密码', lifecycle.pat],
  ['浏览器会话令牌', lifecycle.sessionToken],
  ['CSRF 令牌', lifecycle.csrfToken],
  ['PAT 明文', lifecycle.pat],
]

test('审计记录不含任何明文秘密', async () => {
  const { lifecycle, close } = await driveLifecycle()
  try {
    const store = new SqliteServerStore(lifecycle.databasePath)
    const audit = await store.identity.listAudit(200)
    store.close()
    assert.ok(audit.length >= 4, '认证生命周期必须留下审计')
    const serialized = JSON.stringify(audit)
    for (const [label, secret] of secrets(lifecycle)) assert.ok(!serialized.includes(secret), `审计不得包含${label}`)
    // 审计只应记录可归属的事实：键名不得是承载秘密的字段，值也不得是长字符串（那通常是明文承载）。
    const banned = /^(password|secret|token|sessionToken|csrfToken|accessToken|tokenHash|csrfTokenHash|hash|authorization|cookie)$/i
    for (const entry of audit) for (const [key, value] of Object.entries(entry.metadata as object)) {
      assert.ok(!banned.test(key), `审计字段名疑似承载秘密：${key}`)
      assert.ok(value === null || typeof value !== 'string' || value.length <= 120, `审计字段 ${key} 的值长度异常`)
    }
    assert.ok(audit.some(entry => entry.action === 'credentials.recovered'))
    assert.ok(audit.some(entry => entry.action === 'session.login'))
  } finally { await close() }
})

test('数据库落盘只保存派生值：明文秘密不出现在任何字节里', async () => {
  const { lifecycle, close } = await driveLifecycle()
  try {
    const files = await readdir(lifecycle.directory)
    const contents = await Promise.all(files.map(async file => ({ file, bytes: await readFile(join(lifecycle.directory, file)) })))
    for (const { file, bytes } of contents) {
      const text = bytes.toString('latin1')
      for (const [label, secret] of secrets(lifecycle)) assert.ok(!text.includes(secret), `${file} 不得包含${label}`)
    }
    // 反证：确实保存了派生值，否则"没有明文"只是因为没有落盘。
    const db = new DatabaseSync(lifecycle.databasePath)
    const credential = db.prepare("SELECT data FROM records WHERE kind='local-credential'").get() as { data?: string } | undefined
    const sessions = db.prepare('SELECT token_hash, csrf_token_hash, data FROM login_sessions').all() as { token_hash: string; csrf_token_hash: string; data: string }[]
    const pats = db.prepare("SELECT data FROM records WHERE kind='pat'").all() as { data: string }[]
    db.close()
    assert.match(String(credential?.data), /scrypt\$v1\$/, '密码必须以版本化派生值保存')
    assert.ok(sessions.length > 0, '必须存在登录会话行')
    for (const row of sessions) {
      assert.ok(sessions.some(candidate => candidate.token_hash === hashSecret(lifecycle.sessionToken)), '会话令牌索引必须是真实令牌的哈希')
      assert.ok(row.token_hash !== lifecycle.sessionToken && row.csrf_token_hash !== lifecycle.csrfToken, '会话索引不得是明文令牌')
      assert.ok(!row.data.includes(lifecycle.sessionToken) && !row.data.includes(lifecycle.csrfToken), '会话行不得包含明文令牌')
    }
    assert.ok(pats.some(row => row.data.includes(hashSecret(pat))), 'PAT 只保存哈希')
  } finally { await close() }
})

test('主机本地 CLI 只在 stdout 显示一次密码，不写文件也不进 stderr', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-account-cli-redaction-'))
  const databasePath = join(directory, 'server.sqlite')
  const app = createWemuxServer({ databasePath, administratorEmails: [email] })
  await seedLocalAccount(app.store, { username, email, password, administrator: true })
  const base = await app.listen(0)
  try {
    assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: username, password }) })).status, 200)
    const { stdout, stderr } = await run('npx', ['tsx', fileURLToPath(new URL('../cli.ts', import.meta.url)), 'credentials', 'reset-password', '--username', email, '--database', databasePath], {
      cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', WEMUX_ADMIN_EMAILS: email }, maxBuffer: 4 * 1024 * 1024,
    })
    const reset = JSON.parse(stdout) as { password: string }
    assert.equal(stdout.split(reset.password).length - 1, 1, '恢复密码只能在 stdout 出现一次')
    assert.ok(!stderr.includes(reset.password), 'stderr 不得回显恢复密码')
    for (const [label, secret] of [['会话令牌', pat], ['原密码', password]] as const) assert.ok(!stdout.includes(secret) && !stderr.includes(secret), `CLI 输出不得包含${label}`)
    // 恢复过程不得产出额外文件（日志、备份），只有数据库本身发生变化。
    const files = (await readdir(directory)).sort()
    assert.deepEqual(files.filter(file => !file.startsWith('server.sqlite')), [], `恢复过程不应生成额外文件：${files.join(', ')}`)
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})