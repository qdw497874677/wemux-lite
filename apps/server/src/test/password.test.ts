import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PasswordPolicyError,
  assertPasswordPolicy,
  defaultPasswordHashParameters,
  hashPassword,
  passwordPolicy,
  verifyPassword,
} from '../application/password.js'

// Ticket 04：密码哈希必须带版本与参数、带盐、可升级，并在畸形/超限输入上失败关闭。

test('password policy enforces the frozen minimum and maximum without composition rules', () => {
  assert.equal(passwordPolicy.minimumLength, 15)
  assert.throws(() => assertPasswordPolicy('short-password'), PasswordPolicyError)
  assert.doesNotThrow(() => assertPasswordPolicy('correct horse battery staple'))
  assert.doesNotThrow(() => assertPasswordPolicy('a'.repeat(64)))
  assert.throws(() => assertPasswordPolicy('x'.repeat(passwordPolicy.maximumLength + 1)), PasswordPolicyError)
})

test('hashes are salted, versioned and parameterized', async () => {
  const first = await hashPassword('correct horse battery staple')
  const second = await hashPassword('correct horse battery staple')
  assert.notEqual(first, second)
  assert.match(first, /^scrypt\$v1\$N=16384,r=8,p=1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{88}$/)
  assert.equal((await verifyPassword('correct horse battery staple', first)).ok, true)
  assert.equal((await verifyPassword('correct horse battery stapl3', first)).ok, false)
})

test('verification reports when a legacy parameter set should be upgraded', async () => {
  const legacy = await hashPassword('correct horse battery staple', { N: 4096, r: 8, p: 1 })
  const result = await verifyPassword('correct horse battery staple', legacy)
  assert.equal(result.ok, true)
  assert.equal(result.needsRehash, true)
  const current = await verifyPassword('correct horse battery staple', await hashPassword('correct horse battery staple'))
  assert.equal(current.ok, true)
  assert.equal(current.needsRehash, false)
})

test('verification fails closed on unknown algorithms, versions, malformed and oversized parameters', async () => {
  const valid = await hashPassword('correct horse battery staple')
  const tampered = [
    valid.replace(/^scrypt/, 'argon2'),
    valid.replace(/\$v1\$/, '$v9$'),
    valid.replace('N=16384', 'N=1073741824'),
    valid.replace('N=16384', 'N=3'),
    valid.replace('r=8', 'r=1024'),
    valid.replace('p=1', 'p=999'),
    valid.replace('scrypt$v1$N=16384,r=8,p=1$', 'scrypt$v1$N=16384,r=8,p=1$AAAA$'),
    'not-a-hash',
    '',
  ]
  for (const encoded of tampered) assert.equal((await verifyPassword('correct horse battery staple', encoded)).ok, false, encoded)
  // 超长输入不进入哈希计算，避免用请求耗尽 CPU。
  assert.equal((await verifyPassword('x'.repeat(passwordPolicy.maximumLength + 1), valid)).ok, false)
})

test('concurrent hashing is bounded but every request still completes', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => hashPassword(`concurrent password number ${index}`)))
  assert.equal(results.length, 12)
  assert.equal(new Set(results).size, 12)
  assert.deepEqual(defaultPasswordHashParameters, { N: 16384, r: 8, p: 1 })
})