import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAcceptanceCredentials } from './real-instance-credentials.mjs'
const fixture = { login: 'fixture@example.test', password: 'fixture-only' }
test('acceptance credentials support a real stdin pipe without echoing values', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { readAcceptanceCredentials } from ${JSON.stringify(new URL('./real-instance-credentials.mjs', import.meta.url).href)}; const c=await readAcceptanceCredentials({WEMUX_NEXT_LOGIN_STDIN:'1'}); if(c.login && c.password)console.log('valid');`], { input: JSON.stringify(fixture), encoding: 'utf8' })
  assert.equal(result.status, 0); assert.equal(result.stdout, 'valid\n'); assert.equal(result.stderr, '')
})
test('credential file compatibility remains supported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'next-credential-test-'))
  try { const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(fixture), { mode: 0o600 }); assert.deepEqual(await readAcceptanceCredentials({ WEMUX_NEXT_LOGIN_FILE: path }), fixture) }
  finally { await rm(dir, { recursive: true, force: true }) }
})
test('ambiguous, empty, malformed, oversized and invalid credential inputs fail without content', async () => {
  for (const text of ['', 'SECRET-NOT-JSON', 'x'.repeat(65537), '{}', '{"login":1,"password":"secret"}', '{"login":" ","password":"secret"}']) {
    await assert.rejects(readAcceptanceCredentials({ WEMUX_NEXT_LOGIN_STDIN: '1' }, Readable.from([text])), { message: 'Invalid acceptance credential input (contents withheld).' })
  }
  for (const env of [{}, { WEMUX_NEXT_LOGIN_STDIN: '1', WEMUX_NEXT_LOGIN_FILE: '/private' }]) await assert.rejects(readAcceptanceCredentials(env, Readable.from([])), { message: 'Invalid acceptance credential input (contents withheld).' })
})
