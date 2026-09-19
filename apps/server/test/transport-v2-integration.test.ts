import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { createWemuxServer } from '../src/server.js'
import { seedLocalAccount } from '../src/test/fixtures/administrator.js'

const tempPath = (name: string) => `/tmp/${randomUUID()}-${name}`
const administratorEmail = 'transport-v2-admin@example.com'
const administratorPassword = 'transport-v2-admin-password'
const httpJson = async (url: string, init: RequestInit) => {
  const response = await fetch(url, init)
  return { status: response.status, body: await response.json() as any, headers: response.headers }
}
const cookieHeader = (headers: Headers) => headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const nextFrame = async (ws: WebSocket) => JSON.parse((await once(ws, 'message'))[0].toString())

test('pure transport v2 rejects a v1 first frame', async () => {
  const app = createWemuxServer({ databasePath: tempPath('transport-v2.sqlite'), administratorEmails: [administratorEmail], capabilitySecret: 'capability-secret-with-32-characters' })
  try {
    await app.listen(0, '127.0.0.1')
    const address = app.server.address(); assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    // 授权根是部署声明的管理员邮箱：播种声明邮箱的账号后走普通登录，管理写操作走 Cookie 会话 + CSRF。
    await seedLocalAccount(app.store, { username: administratorEmail, email: administratorEmail, password: administratorPassword, administrator: true })
    const login = await httpJson(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: administratorEmail, password: administratorPassword }) })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    const cookie = cookieHeader(login.headers)
    const token = await httpJson(`${base}/api/enrollment-tokens`, { method: 'POST', headers: { cookie, 'x-csrf-token': login.body.csrfToken, 'content-type': 'application/json' }, body: '{}' })
    const enrolled = await httpJson(`${base}/api/workers/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token.body.token, name: 'worker' }) })
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body))
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/worker/ws`, { headers: { authorization: `Bearer ${enrolled.body.credential}` } })
    await once(ws, 'open')
    const frame = nextFrame(ws)
    ws.send(JSON.stringify({ protocolVersion: 1, type: 'hello', workerId: enrolled.body.workerId }))
    const error = await frame
    assert.equal(error.frameType, 'transport.error')
    assert.equal(error.retryable, false)
    const closed = ws.readyState === WebSocket.CLOSED ? Promise.resolve() : once(ws, 'close').then(() => undefined)
    await closed
  } finally { await app.close() }
})
