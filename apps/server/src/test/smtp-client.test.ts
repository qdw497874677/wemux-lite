import test from 'node:test'
import assert from 'node:assert/strict'
import { hasOpenssl, startFakeSmtp } from './fake-smtp.js'
import { SmtpError, dotStuff, parseCapabilities, sendSmtpMessage, type SmtpConfig } from '../application/mail/smtp-client.js'

const envelope = (data: string) => ({ from: 'no-reply@wemux.test', to: ['ada@example.com'], data: Buffer.from(data, 'utf8') })

function config(port: number, overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return { host: '127.0.0.1', port, security: 'plain', attempts: 1, commandTimeoutMs: 5_000, connectTimeoutMs: 5_000, rejectUnauthorized: false, ...overrides }
}

test('能力行解析：STARTTLS、AUTH 机制与 SIZE 上限', () => {
  assert.deepEqual(parseCapabilities(['250-fake.local', '250-STARTTLS', '250-AUTH PLAIN LOGIN', '250-SIZE 10240000', '250 8BITMIME']), { starttls: true, auth: ['PLAIN', 'LOGIN'], size: 10_240_000 })
  assert.deepEqual(parseCapabilities(['250 fake.local']), { starttls: false, auth: [], size: null })
  assert.deepEqual(parseCapabilities(['250-localhost', '250 AUTH LOGIN']), { starttls: false, auth: ['LOGIN'], size: null })
})

test('明文提交：EHLO/AUTH PLAIN/MAIL/RCPT/DATA 顺序正确，点填充可逆', async t => {
  const server = await startFakeSmtp(); t.after(() => server.stop())
  const body = 'Subject: hi\r\n\r\n第一行\r\n.line2\r\n.\r\n'
  await sendSmtpMessage(config(server.port, { username: 'mailer', password: 's3cret', allowInsecureAuth: true, heloDomain: 'wemux.test' }), envelope(body))
  assert.deepEqual(server.commands.filter(line => !line.startsWith('AUTH')), ['EHLO wemux.test', 'MAIL FROM:<no-reply@wemux.test>', 'RCPT TO:<ada@example.com>', 'DATA', 'QUIT'])
  assert.match(server.commands.find(line => line.startsWith('AUTH'))!, /^AUTH PLAIN /)
  assert.deepEqual(server.authAttempts, [{ mechanism: 'PLAIN', username: 'mailer', password: 's3cret' }])
  assert.equal(server.transactions.length, 1)
  assert.equal(server.transactions[0]!.authenticated, 'mailer')
  assert.equal(server.transactions[0]!.data, body.replace(/\r\n/g, '\r\n'))
  // 行首的 `.` 与 `.` 结束标记都被还原，未被截断。
  assert.ok(server.transactions[0]!.data.endsWith('.line2\r\n.\r\n'))
})

test('多收件人逐个 RCPT，未配置凭据时不发 AUTH', async t => {
  const server = await startFakeSmtp(); t.after(() => server.stop())
  await sendSmtpMessage(config(server.port, { username: null, password: null }), { from: 'no-reply@wemux.test', to: ['a@example.com', 'b@example.com'], data: Buffer.from('x', 'utf8') })
  assert.deepEqual(server.commands.filter(line => line.startsWith('RCPT')), ['RCPT TO:<a@example.com>', 'RCPT TO:<b@example.com>'])
  assert.equal(server.commands.some(line => line.startsWith('AUTH')), false)
  assert.deepEqual(server.transactions[0]!.recipients, ['a@example.com', 'b@example.com'])
})

test('4xx 是临时失败：重试后成功；5xx 永久失败：不重试', async t => {
  const transient = await startFakeSmtp({ failures: { MAIL: [451] } }); t.after(() => transient.stop())
  await sendSmtpMessage(config(transient.port, { attempts: 2 }), envelope('x'))
  assert.equal(transient.commands.filter(line => line.startsWith('MAIL')).length, 2)
  assert.equal(transient.transactions.length, 1)

  const permanent = await startFakeSmtp({ failures: { MAIL: [550, 550, 550] } }); t.after(() => permanent.stop())
  await assert.rejects(sendSmtpMessage(config(permanent.port, { attempts: 3 }), envelope('x')), (error: SmtpError) => error instanceof SmtpError && error.stage === 'mail' && error.code === 550 && error.permanent)
  assert.equal(permanent.commands.filter(line => line.startsWith('MAIL')).length, 1)
  assert.equal(permanent.transactions.length, 0)
})

test('AUTH 失败是可见的永久错误，不降级为匿名投递', async t => {
  const server = await startFakeSmtp({ failures: { AUTH: [535] } }); t.after(() => server.stop())
  await assert.rejects(sendSmtpMessage(config(server.port, { username: 'mailer', password: 'wrong', allowInsecureAuth: true }), envelope('x')), (error: SmtpError) => error instanceof SmtpError && error.stage === 'auth' && error.code === 535)
  assert.equal(server.commands.some(line => line.startsWith('MAIL')), false)
  assert.equal(server.transactions.length, 0)
})

test('明文连接上的凭据默认被拒绝，明确报配置问题', async t => {
  const server = await startFakeSmtp(); t.after(() => server.stop())
  await assert.rejects(sendSmtpMessage(config(server.port, { username: 'mailer', password: 's3cret' }), envelope('x')), /refusing to send credentials over a cleartext connection/)
  assert.equal(server.commands.some(line => line.startsWith('AUTH')), false)
})

test('STARTTLS：先升级再认证，升级后重新 EHLO', async t => {
  if (!hasOpenssl()) return t.skip('openssl 不可用')
  const server = await startFakeSmtp({ tls: true }); t.after(() => server.stop())
  await sendSmtpMessage(config(server.port, { security: 'starttls', username: 'mailer', password: 's3cret' }), envelope('over tls'))
  assert.equal(server.tlsUpgrades, 1)
  assert.equal(server.commands.filter(line => line.startsWith('EHLO')).length, 2)
  assert.deepEqual(server.transactions[0]!.recipients, ['ada@example.com'])
  assert.equal(server.transactions[0]!.data, 'over tls\r\n')
  // 升级前不得发送任何凭据或信件内容。
  assert.ok(server.commands.findIndex(line => line.startsWith('STARTTLS')) < server.commands.findIndex(line => line.startsWith('AUTH')))
  assert.ok(server.commands.findIndex(line => line.startsWith('AUTH')) < server.commands.findIndex(line => line.startsWith('MAIL')))
})

test('要求 STARTTLS 但服务器不广告：永久失败且不泄露凭据', async t => {
  const server = await startFakeSmtp({ capabilities: ['AUTH PLAIN LOGIN'] }); t.after(() => server.stop())
  await assert.rejects(sendSmtpMessage(config(server.port, { security: 'starttls', username: 'mailer', password: 's3cret', attempts: 2 }), envelope('x')), (error: SmtpError) => error instanceof SmtpError && error.stage === 'starttls' && error.permanent)
  assert.equal(server.commands.some(line => line.startsWith('AUTH')), false)
  assert.equal(server.commands.some(line => line.startsWith('MAIL')), false)
})

test('超过服务器 SIZE 上限时不发 DATA', async t => {
  const server = await startFakeSmtp({ capabilities: ['AUTH PLAIN LOGIN', 'SIZE 32'] }); t.after(() => server.stop())
  await assert.rejects(sendSmtpMessage(config(server.port), envelope('x'.repeat(200))), (error: SmtpError) => error instanceof SmtpError && error.stage === 'size' && error.permanent)
  assert.equal(server.commands.some(line => line === 'DATA'), false)
  assert.equal(server.transactions.length, 0)
})

test('命令超时是临时失败并可重试，不会静默当作成功', async t => {
  const server = await startFakeSmtp({ delayBeforeDataEnd: 400 }); t.after(() => server.stop())
  await assert.rejects(sendSmtpMessage(config(server.port, { commandTimeoutMs: 100, attempts: 2 }), envelope('x')), (error: SmtpError) => error instanceof SmtpError && error.stage === 'timeout')
  // 两次尝试都确实发出了 DATA（服务器对超时连接的收尾是异步的，不能用来计数）。
  assert.equal(server.commands.filter(line => line === 'DATA').length, 2)
})

test('点填充在传输层端到端可逆', () => {
  const stuffed = dotStuff(Buffer.from('Subject: x\r\n\r\n.\r\n..\r\n', 'utf8')).toString('utf8')
  assert.equal(stuffed, 'Subject: x\r\n\r\n..\r\n...\r\n.\r\n')
})