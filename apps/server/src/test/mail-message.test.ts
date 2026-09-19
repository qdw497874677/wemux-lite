import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMailData, encodeHeaderValue, formatMailDate, parseMailbox } from '../application/mail/message.js'
import { dotStuff } from '../application/mail/smtp-client.js'

const from = { address: 'no-reply@wemux.test', name: 'Wemux Lite' }

test('报文头与正文：ASCII 头原样、非常 ASCII 头编码、正文 base64 折行', () => {
  const data = buildMailData({ from, to: [parseMailbox('Ada <ada@example.com>')], subject: '验证你的邮箱', text: '点击链接完成验证。', date: new Date('2026-01-01T00:00:00Z'), messageId: '<fixed@wemux.test>' }).toString('utf8')
  const [headers, body] = data.split('\r\n\r\n')
  assert.ok(headers!.startsWith('From: Wemux Lite <no-reply@wemux.test>\r\nTo: Ada <ada@example.com>\r\n'))
  // 中文主题必须编码成 RFC 2047 编码字，不能裸奔。
  assert.match(headers!, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m)
  assert.ok(!/验证/.test(headers!))
  assert.match(headers!, /^Date: Thu, 01 Jan 2026 00:00:00 \+0000$/m)
  assert.match(headers!, /^Message-ID: <fixed@wemux.test>$/m)
  assert.match(headers!, /^Content-Transfer-Encoding: base64$/m)
  assert.equal(data.endsWith('\r\n'), true)
  assert.equal(Buffer.from(body!.replace(/\r\n/g, ''), 'base64').toString('utf8'), '点击链接完成验证。')
  assert.ok(body!.split('\r\n').every(line => line.length <= 76))
})

test('头注入与非法输入被拒绝，而不是被“顺便过滤”', () => {
  assert.throws(() => buildMailData({ from, to: [parseMailbox('a@example.com')], subject: 'x\r\nBcc: evil@example.com', text: 'x' }), /line breaks/)
  assert.throws(() => buildMailData({ from, to: [parseMailbox('"Ada\r\nBcc: evil@example.com" <ada@example.com>')], subject: 'x', text: 'x' }), /line breaks/)
  assert.throws(() => buildMailData({ from, to: [], subject: 'x', text: 'x' }), /at least one recipient/)
  assert.throws(() => buildMailData({ from, to: [parseMailbox('a@example.com')], subject: 'x', text: 'x', messageId: 'x\r\nBcc: y' }), /line breaks/)
  assert.throws(() => parseMailbox('Ada <not-an-email>'), /Invalid mailbox address/)
  assert.throws(() => buildMailData({ from, to: [parseMailbox('a@example.com')], subject: 'x', text: 'x', headers: { 'X-Trace': 'a\nb' } }), /line breaks/)
})

test('长头在边界处折行，非 ASCII 名与地址一起编码', () => {
  const recipients = Array.from({ length: 6 }, (_, index) => parseMailbox(`User ${index} <user${index}@example.com>`))
  const data = buildMailData({ from, to: recipients, subject: 'plain ascii', text: 'x', date: new Date('2026-01-01T00:00:00Z') }).toString('utf8')
  const header = data.split('\r\n\r\n')[0]!
  assert.ok(header.split('\r\n').every(line => line.length <= 78), header)
  assert.match(header, /^To: User 0 <user0@example.com>, User 1 <user1@example.com>,$/m)
  assert.match(header, /^ User 4 <user4@example.com>, User 5 <user5@example.com>$/m)
  assert.equal(encodeHeaderValue('plain'), 'plain')
  assert.equal(formatMailDate(new Date('2026-03-05T06:07:08Z')), 'Thu, 05 Mar 2026 06:07:08 +0000')
})

test('点填充只转义行首点，并统一 CRLF 与结束标记', () => {
  assert.equal(dotStuff(Buffer.from('line1\n.line2\n', 'utf8')).toString('utf8'), 'line1\r\n..line2\r\n.\r\n')
  assert.equal(dotStuff(Buffer.from('a\r\n.\r\n', 'utf8')).toString('utf8'), 'a\r\n..\r\n.\r\n')
  // 末尾缺少 CRLF 时补齐，否则结束标记会粘在正文最后一行。
  assert.equal(dotStuff(Buffer.from('tail', 'utf8')).toString('utf8'), 'tail\r\n.\r\n')
})
test('验证与重置链接必须指向前端页面路由，而不是未定义的短路径', async () => {
  const { verificationLink, passwordResetLink } = await import('../application/mail/email-delivery.js')
  assert.equal(verificationLink('https://wemux.example.com/', 'abc-123'), 'https://wemux.example.com/auth/verify-email?token=abc-123')
  assert.equal(passwordResetLink('https://wemux.example.com', 'xyz 456'), 'https://wemux.example.com/auth/password/reset?token=xyz%20456')
})
