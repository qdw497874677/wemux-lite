import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../worker/src/config.ts'
import { parseCandidateUrls } from '../worker/src/transport/endpoints.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'

test('owned Worker pins register/start/restart despite hostile ambient endpoint and transport overrides', () => {
  const ambient = { PATH: '/test/bin', WEMUX_SERVER_URL: 'https://outside.invalid', WEMUX_SERVER_URLS: 'https://other.invalid', WEMUX_TRANSPORT: 'nc', WEMUX_PREFER: 'tailnet', WEMUX_TS_SOCKET: '/outside/socket', WEMUX_WORKER_HOME: '/outside/home', WEMUX_WORKER_HOST: '0.0.0.0', WEMUX_WORKER_PORT: '8004', HTTPS_PROXY: 'http://proxy.invalid', http_proxy: 'http://proxy.invalid', ALL_PROXY: 'socks5://proxy.invalid' }
  const before = structuredClone(ambient), origin = 'http://127.0.0.1:12345'
  for (const command of ['register', 'start', 'start']) {
    const launch = ownedWorkerLaunch([command, '--home', '/tmp/owned-worker'], origin, ambient)
    const parsed = config(launch.args, launch.env)
    assert.equal(parsed.server, origin)
    assert.equal(parsed.servers, origin)
    assert.equal(parsed.transport, 'direct')
    assert.equal(parsed.prefer, 'direct')
    assert.equal(parsed.host, '127.0.0.1')
    assert.equal(parsed.port, 0)
    assert.equal(parsed.home, '/tmp/owned-worker')
    assert.deepEqual(Object.keys(launch.env), ['PATH'])
    assert.equal(launch.env.PATH, ambient.PATH)
    assert.deepEqual(parseCandidateUrls(parsed.servers, parsed.server), [origin])
  }
  assert.deepEqual(ambient, before, 'parent environment must not be mutated')
})

test('owned cleanup removes main and transport databases and companions but preserves evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-owned-cleanup-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const database = join(directory, 'server.sqlite')
  const files = ['', '-wal', '-shm', '.transport', '.transport-wal', '.transport-shm'].map(suffix => `${database}${suffix}`)
  for (const path of files) await writeFile(path, 'fixture')
  const evidence = join(directory, 'result.json'); await writeFile(evidence, '{}')
  await removeOwnedServerDatabases(database)
  for (const path of files) await assert.rejects(access(path), { code: 'ENOENT' })
  await access(evidence)
  await removeOwnedServerDatabases(database)
})
