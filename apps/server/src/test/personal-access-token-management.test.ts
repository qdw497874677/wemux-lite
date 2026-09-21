import test from 'node:test'
import assert from 'node:assert/strict'
import type { CredentialId, Timestamp } from '@wemux/domain'
import { createWemuxServer } from '../server.js'
import { PersonalAccessTokenService } from '../application/personal-access-token-service.js'
import { systemClock } from '../application/identity-service.js'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple'
const cookieName = 'wemux_login_session'

function browser(base: string) {
  let cookie = '', csrf = ''
  const call = async (path: string, input: { method?: string; body?: unknown; bearer?: string; cookie?: string | null; csrf?: string | null } = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json', Origin: base }
    const selectedCookie = input.cookie === undefined ? cookie : input.cookie
    if (selectedCookie) headers.Cookie = selectedCookie
    if (input.bearer) headers.Authorization = `Bearer ${input.bearer}`
    const selectedCsrf = input.csrf === undefined ? csrf : input.csrf
    if (selectedCsrf) headers['X-CSRF-Token'] = selectedCsrf
    if (input.body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(`${base}${path}`, { method: input.method ?? (input.body === undefined ? 'GET' : 'POST'), headers, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) })
    const setCookie = response.headers.getSetCookie().find(value => value.startsWith(`${cookieName}=`))
    if (setCookie) cookie = setCookie.split(';')[0]!
    const data = response.status === 204 ? {} : await response.json() as Record<string, unknown>
    if (typeof data.csrfToken === 'string') csrf = data.csrfToken
    return { status: response.status, data }
  }
  return { call }
}

async function fixture() {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  await seedLocalAccount(app.store, { username: 'owner', email: administratorEmail, password })
  const base = await app.listen(0), client = browser(base)
  const login = await client.call('/auth/login', { method: 'POST', body: { login: 'owner', password } })
  assert.equal(login.status, 200, JSON.stringify(login.data))
  return { app, base, client }
}

const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

test('PAT 明文只显示一次，列表只显示元数据，撤销后立即失效', async t => {
  const f = await fixture(); t.after(() => f.app.close())
  const created = await f.client.call('/auth/personal-access-tokens', { method: 'POST', body: { name: '只读 CLI', scopes: ['read'], expiresAt: tomorrow() } })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const token = created.data.token as string, id = created.data.id as string
  assert.match(token, /^wmx_pat_[A-Za-z0-9_-]+$/)

  const listed = await f.client.call('/auth/personal-access-tokens')
  assert.equal(listed.status, 200)
  assert.equal(JSON.stringify(listed.data).includes(token), false)
  assert.equal(JSON.stringify(listed.data).includes('tokenHash'), false)
  const first = (listed.data.items as { name: string; scopes: string[] }[])[0]!
  assert.equal(first.name, '只读 CLI')
  assert.deepEqual(first.scopes, ['read'])

  assert.equal((await f.client.call('/projects', { bearer: token, cookie: null, csrf: null })).status, 200)
  const storedAfterUse = (await f.app.store.identity.listPersonalAccessTokens()).find(record => record.id === id)
  assert.equal(typeof storedAfterUse?.lastUsedAt, 'string')
  assert.ok((await f.app.store.identity.listAudit(100)).some(entry => entry.action === 'pat.used' && entry.metadata.tokenId === id))
  assert.equal((await f.client.call('/projects', { method: 'POST', body: { name: '不允许写' }, bearer: token, cookie: null, csrf: null })).status, 403)
  assert.ok((await f.app.store.identity.listAudit(100)).some(entry => entry.action === 'pat.authentication_failed' && entry.metadata.tokenId === id))
  assert.equal((await f.client.call(`/auth/personal-access-tokens/${id}`, { method: 'DELETE' })).status, 204)
  assert.equal((await f.client.call('/projects', { bearer: token, cookie: null, csrf: null })).status, 401)
})

test('PAT scope 是能力上限且仍与资源 Grant 取交集', async t => {
  const f = await fixture(); t.after(() => f.app.close())
  const member = await seedLocalAccount(f.app.store, { username: 'member', email: 'member@example.com', password })
  const memberBrowser = browser(f.base)
  assert.equal((await memberBrowser.call('/auth/login', { method: 'POST', body: { login: 'member', password } })).status, 200)
  const issued = await memberBrowser.call('/auth/personal-access-tokens', { method: 'POST', body: { name: '执行器', scopes: ['read', 'execute'], expiresAt: tomorrow() } })
  const token = issued.data.token as string
  assert.equal((await memberBrowser.call('/projects', { bearer: token, cookie: null, csrf: null })).status, 200)
  assert.deepEqual((await memberBrowser.call('/projects', { bearer: token, cookie: null, csrf: null })).data, { items: [] }, 'scope 不能凭空扩大资源 Grant')
  assert.equal(typeof member.id, 'string')
})

test('PAT 轮换原子退役旧令牌并返回一次性新明文，旧无 scope PAT 不可用', async t => {
  const f = await fixture(); t.after(() => f.app.close())
  const created = await f.client.call('/auth/personal-access-tokens', { method: 'POST', body: { name: '自动化', scopes: ['read', 'write'], expiresAt: tomorrow() } })
  const oldToken = created.data.token as string, id = created.data.id as string
  const rotated = await f.client.call(`/auth/personal-access-tokens/${id}/rotate`, { method: 'POST', body: { expiresAt: tomorrow() } })
  assert.equal(rotated.status, 201, JSON.stringify(rotated.data))
  const newToken = rotated.data.token as string
  assert.notEqual(newToken, oldToken)
  assert.equal((await f.client.call('/projects', { bearer: oldToken, cookie: null, csrf: null })).status, 401)
  assert.equal((await f.client.call('/projects', { bearer: newToken, cookie: null, csrf: null })).status, 200)

  const account = await f.app.store.identity.getUserByLogin('owner')
  const legacy = 'legacy-no-scope-token'
  const { hashSecret } = await import('../application/auth.js')
  await f.app.store.transaction(tx => tx.identity.savePersonalAccessToken({ id: 'legacy-no-scope' as CredentialId, userId: account!.id, tokenHash: hashSecret(legacy), expiresAt: tomorrow() as Timestamp, revokedAt: null }))
  assert.equal((await f.client.call('/projects', { bearer: legacy, cookie: null, csrf: null })).status, 401)
  const audit = await f.app.store.identity.listAudit(100)
  assert.ok(audit.some(entry => entry.action === 'pat.created'))
  assert.ok(audit.some(entry => entry.action === 'pat.rotated'))
})

test('并发轮换只有一个赢家，失败者不能留下第二个有效替代令牌', async t => {
  const f = await fixture(); t.after(() => f.app.close())
  const created = await f.client.call('/auth/personal-access-tokens', { method: 'POST', body: { name: '并发轮换', scopes: ['read'], expiresAt: tomorrow() } })
  const id = created.data.id as CredentialId
  const service = new PersonalAccessTokenService(f.app.store, systemClock)
  const outcomes = await Promise.allSettled([service.rotate((await f.app.store.identity.getUserByLogin('owner'))!.id, id, tomorrow()), service.rotate((await f.app.store.identity.getUserByLogin('owner'))!.id, id, tomorrow())])
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  const live = (await f.app.store.identity.listPersonalAccessTokens()).filter(record => record.revokedAt === null && record.name === '并发轮换')
  assert.equal(live.length, 1)
})
