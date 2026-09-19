import test from 'node:test'
import assert from 'node:assert/strict'
import { invalidEmailReason, maskEmail, normalizeEmail } from '../application/email-address.js'

test('规范化：去空白、域名转 ASCII、整体小写，同时保留展示值', () => {
  assert.deepEqual(normalizeEmail('  Ada.Lovelace@Example.COM '), { normalized: 'ada.lovelace@example.com', display: 'Ada.Lovelace@Example.COM', domain: 'example.com' })
  // IDN 走 WHATWG URL 的 ICU 行为转 punycode，不自己维护映射表。
  assert.equal(normalizeEmail('user@例子.测试')!.normalized, 'user@xn--fsqu00a.xn--0zwm56d')
  // 不做供应商别名合并：点和 +tag 都保留原样。
  assert.equal(normalizeEmail('first.last+tag@gmail.com')!.normalized, 'first.last+tag@gmail.com')
  assert.equal(normalizeEmail('a@b.co')!.domain, 'b.co')
})

test('非法地址给出可展示的原因，绝不静默接受', () => {
  assert.equal(invalidEmailReason(undefined), '请输入邮箱地址')
  assert.equal(invalidEmailReason('   '), '请输入邮箱地址')
  assert.equal(invalidEmailReason('nope'), '邮箱地址缺少 @ 或域名')
  assert.equal(invalidEmailReason('a@b@c.com'), '邮箱地址包含多个 @')
  assert.equal(invalidEmailReason('@example.com'), '邮箱地址缺少 @ 或域名')
  assert.equal(invalidEmailReason('a@'), '邮箱地址缺少 @ 或域名')
  assert.equal(invalidEmailReason('a b@example.com'), '邮箱地址包含非法字符')
  assert.equal(invalidEmailReason('a@example.com\nBcc: evil@example.com'), '邮箱地址包含非法字符')
  assert.equal(invalidEmailReason('Name <a@example.com>'), '邮箱地址包含非法字符')
  assert.equal(invalidEmailReason('.a@example.com'), '邮箱地址的本地部分格式不正确')
  assert.equal(invalidEmailReason('a..b@example.com'), '邮箱地址的本地部分格式不正确')
  assert.equal(invalidEmailReason('a@localhost'), '邮箱域名格式不正确')
  assert.equal(invalidEmailReason('a@example'), '邮箱域名格式不正确')
  assert.equal(invalidEmailReason('a@-example.com'), '邮箱域名格式不正确')
  assert.equal(invalidEmailReason('a@example..com'), '邮箱域名格式不正确')
  assert.equal(invalidEmailReason('a@127.0.0.1'), '邮箱域名格式不正确')
  assert.equal(invalidEmailReason(`${'a'.repeat(65)}@example.com`), '邮箱地址的本地部分过长')
  assert.equal(normalizeEmail('a@example.com\n')!.normalized, 'a@example.com')
  assert.equal(normalizeEmail('a@example.com\nBcc: evil@example.com'), null)
  assert.equal(normalizeEmail(42), null)
})

test('掩码只用于确有必要区分账号的场景', () => {
  assert.equal(maskEmail('ada@example.com'), 'a***@example.com')
  assert.equal(maskEmail('a@example.com'), 'a***@example.com')
  assert.equal(maskEmail('not-an-email'), '***')
})