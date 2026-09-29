import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverHost, hostContractVersion, parseHostBootstrap } from '../src/hosts/bootstrap.ts'

const cluster = { hostKind: 'cluster', contractVersion: hostContractVersion, capabilities: ['cluster-session'] }
const local = { hostKind: 'local-worker', contractVersion: hostContractVersion, capabilities: ['local-session'] }

test('host bootstrap accepts only known hosts and compatible versions', () => {
  assert.deepEqual(parseHostBootstrap(cluster), cluster)
  assert.deepEqual(parseHostBootstrap(local), local)
  assert.throws(() => parseHostBootstrap({ ...local, contractVersion: 9 }), /版本与服务端不兼容/)
  assert.throws(() => parseHostBootstrap({ ...local, hostKind: 'unknown' }), /宿主类型不受支持/)
  assert.throws(() => parseHostBootstrap({ ...cluster, capabilities: ['ok', 3] }), /能力合同无效/)
})

test('host discovery never mistakes HTML SPA fallback for a trusted bootstrap', async t => {
  const previous = globalThis.fetch
  t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/host')
    assert.equal(options.cache, 'no-store')
    return new Response('<html>fallback</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
  }
  await assert.rejects(discoverHost(), /宿主发现响应无效/)
})
