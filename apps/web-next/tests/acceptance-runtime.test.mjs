import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserConfiguration, recordAcceptanceFailure, finishAcceptance, registerCurrentLoginCleanup } from './acceptance-runtime.mjs'

test('browser configuration is explicit and missing configuration fails without paths', () => {
  assert.throws(() => browserConfiguration({}), { message: 'Browser acceptance configuration required (details withheld).' })
  const child = spawnSync(process.execPath, [new URL('./browser-safety.acceptance.mjs', import.meta.url).pathname], { encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_CORE_PATH: '', PLAYWRIGHT_CHROMIUM_PATH: '' } })
  assert.equal(child.status, 1)
  assert.equal(child.stderr.trim(), 'Browser acceptance configuration required (details withheld).')
})
for (const script of ['real-instance.mjs', 'real-legacy-regression.mjs']) test(`${script} initialization failure is fixed-output without browser facilities`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-init-'))
  try {
    const child = spawnSync(process.execPath, [new URL('./' + script, import.meta.url).pathname], { encoding: 'utf8', input: JSON.stringify({ login: 'SENTINEL_LOGIN', password: 'SENTINEL_PASSWORD' }), env: { ...process.env, WEMUX_NEXT_BASE_URL: 'http://127.0.0.1:1', WEMUX_NEXT_PROJECT_ID: 'fixture', WEMUX_NEXT_LOGIN_STDIN: '1', WEMUX_NEXT_LOGIN_FILE: '', WEMUX_NEXT_EVIDENCE: dir, PLAYWRIGHT_CORE_PATH: '', PLAYWRIGHT_CHROMIUM_PATH: '' } })
    assert.equal(child.status, 1)
    assert.equal(child.stderr.trim(), 'Acceptance failed (details withheld).')
    const result = await readFile(join(dir, 'result.json'), 'utf8')
    assert.equal(JSON.parse(result).passed, false)
    for (const text of [result, child.stderr, child.stdout]) assert.doesNotMatch(text, /SENTINEL_LOGIN|SENTINEL_PASSWORD/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('cleanup and write failures fail closed without serializing exceptions or replacing original error', async () => {
  const result = { passed: true }; let recorded
  recordAcceptanceFailure(result, 'initialize')
  const code = await finishAcceptance(result, [() => { throw Error('SENTINEL_PASSWORD') }], value => { recorded = JSON.stringify(value); throw Error('SENTINEL_LOGIN') })
  assert.equal(code, 1); assert.equal(result.failure.step, 'initialize'); assert.equal(result.cleanupFailed, true)
  assert.doesNotMatch(recorded, /SENTINEL/)
  const success = { passed: true }
  assert.equal(await finishAcceptance(success, [() => { throw Error('secret') }], () => {}), 1)
  assert.equal(success.failure.step, 'cleanup')
})
test('current login cleanup registered before later UI failure only revokes the own captured ID', async () => {
  const cleanups = [], revoked = [], order = []
  const id = await registerCurrentLoginCleanup({ get: async () => { order.push('current'); return { items: [{ id: 'other', current: false }, { id: 'own', current: true }] } }, revokeCurrent: async id => revoked.push(id) }, cleanups)
  assert.equal(id, 'own'); assert.equal(cleanups.length, 1)
  order.push('ui-failed')
  const result = { passed: false }; recordAcceptanceFailure(result, 'ui-wait')
  await finishAcceptance(result, cleanups, () => {})
  assert.deepEqual(order, ['current', 'ui-failed']); assert.deepEqual(revoked, ['own'])
})
test('missing or ambiguous current login never guesses another session', async () => {
  for (const items of [[{ id: 'other', current: false }], [{ id: 'a', current: true }, { id: 'b', current: true }]]) {
    const cleanups = []
    await assert.rejects(registerCurrentLoginCleanup({ get: async () => ({ items }), revokeCurrent: () => assert.fail('must not revoke') }, cleanups))
    assert.equal(cleanups.length, 0)
  }
})
