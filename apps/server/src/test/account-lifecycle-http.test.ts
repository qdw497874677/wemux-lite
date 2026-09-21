import test from 'node:test'
import assert from 'node:assert/strict'
import { createWemuxServer } from '../server.js'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct-horse-battery-staple'

function browser(base: string) {
  let cookie = '', csrf = ''
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (cookie) headers.set('cookie', cookie)
    if (csrf && init.method && !['GET', 'HEAD'].includes(init.method)) headers.set('x-csrf-token', csrf)
    headers.set('content-type', 'application/json')
    const response = await fetch(`${base}/api${path}`, { ...init, headers })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0] ?? ''
    const data = response.status === 204 ? null : await response.json()
    if (data && typeof data === 'object' && 'csrfToken' in data && typeof data.csrfToken === 'string') csrf = data.csrfToken
    return { response, data: data as any }
  }
  return {
    get: (path: string) => request(path),
    post: (path: string, body: unknown) => request(path, { method: 'POST', body: JSON.stringify(body) }),
    cookie: () => cookie,
  }
}

test('管理员可停用/恢复普通账号，普通用户只能看到自己的审计，销号确认清除 Cookie', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  t.after(() => app.close())
  await seedLocalAccount(app.store, { username: 'deployer', email: administratorEmail, password, administrator: true })
  const member = await seedLocalAccount(app.store, { username: 'member', email: 'member@example.com', password })
  const base = await app.listen(0)
  const admin = browser(base), user = browser(base)
  assert.equal((await admin.post('/auth/login', { login: administratorEmail, password })).response.status, 200)
  assert.equal((await user.post('/auth/login', { login: 'member@example.com', password })).response.status, 200)

  const accounts = await admin.get('/auth/account/users')
  assert.equal(accounts.response.status, 200)
  assert.equal(accounts.data.items.some((item: { id: string }) => item.id === member.id), true)
  assert.equal((await admin.post(`/auth/account/users/${member.id}/disable`, {})).response.status, 200)
  assert.equal((await user.get('/auth/me')).response.status, 401)
  assert.equal((await admin.post(`/auth/account/users/${member.id}/restore`, {})).response.status, 200)

  assert.equal((await user.post('/auth/login', { login: 'member@example.com', password })).response.status, 200)
  const audit = await user.get('/auth/account/audit?limit=20')
  assert.equal(audit.response.status, 200)
  assert.equal(audit.data.items.some((entry: { action: string }) => entry.action === 'account.disabled'), true)
  assert.equal((await user.get(`/auth/account/audit?actorId=${encodeURIComponent(accounts.data.items[0].id)}`)).response.status, 403)
  const exported = await fetch(`${base}/api/auth/account/audit/export?action=account.disabled`, { headers: { cookie: user.cookie() } })
  assert.equal(exported.status, 200)
  assert.equal(exported.headers.get('content-type')?.startsWith('application/x-ndjson'), true)
  assert.match(await exported.text(), /"action":"account.disabled"/)

  const deletion = await user.post('/auth/account/lifecycle', { action: 'confirm-deletion', confirmation: '删除我的账号' })
  assert.equal(deletion.response.status, 200)
  assert.equal((await user.get('/auth/me')).response.status, 401)
})
