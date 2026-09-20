import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWemuxServer } from '../server.js'
import { seedLocalAccount } from './fixtures/administrator.js'

const password = 'correct horse battery staple'

test('创建团队邀请会向指定邮箱投递仅含一次性链接的邮件', async t => {
  const outbox = await mkdtemp(join(tmpdir(), 'wemux-team-mail-'))
  t.after(() => rm(outbox, { recursive: true, force: true }))
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: ['admin@example.com'], mail: { WEMUX_MAIL_OUTBOX: outbox, WEMUX_PUBLIC_URL: 'https://wemux.example.com', WEMUX_SMTP_FROM: 'Wemux <wemux@example.com>' } })
  await seedLocalAccount(app.store, { username: 'owner', email: 'owner@example.com', password })
  const base = await app.listen(0)
  t.after(() => app.close())
  const headers = { 'content-type': 'application/json', Origin: base }
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ login: 'owner', password }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const loginPayload = await login.json() as { csrfToken: string }
  const authenticated = { ...headers, cookie, 'x-csrf-token': loginPayload.csrfToken }
  const team = await (await fetch(`${base}/api/teams`, { method: 'POST', headers: authenticated, body: JSON.stringify({ name: 'Agent Network' }) })).json() as { id: string }
  const issued = await fetch(`${base}/api/teams/${team.id}/invitations`, { method: 'POST', headers: authenticated, body: JSON.stringify({ email: 'invitee@example.com' }) })
  assert.equal(issued.status, 201)
  const payload = await issued.json() as { token: string }
  assert.equal(typeof payload.token, 'string')
  assert.equal(payload.token.length > 30, true)

  const names = (await readdir(outbox)).filter(name => name.endsWith('.eml'))
  const entries = await Promise.all(names.map(async name => ({ name, written: (await stat(join(outbox, name))).mtimeMs })))
  entries.sort((a, b) => b.written - a.written || b.name.localeCompare(a.name))
  const mail = await readFile(join(outbox, entries[0]!.name), 'utf8')
  const text = Buffer.from(mail.slice(mail.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8')
  assert.match(mail, /To:.*invitee@example\.com/)
  assert.match(mail, /Subject:/)
  assert.match(text, new RegExp(`https://wemux\\.example\\.com/join\\?token=${payload.token}`))
  assert.doesNotMatch(text, /owner@example\.com|correct horse|password/i)
})
