import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyEndpoint, orderEndpoints, parseCandidateUrls, parsePreference, resolveAutoPreference } from '../src/transport/endpoints.js'
import type { TailscaleProbe } from '../src/transport/tailscale.js'

const fakeProbe = (behavior: 'ok' | 'missing'): TailscaleProbe => ({
  run: async (command, args) => {
    if (behavior === 'ok' && command === 'tailscale' && args[0] === 'version') return { stdout: '1.66.0\ngo version: go1.22\n', stderr: '' }
    throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' })
  },
})

test('parseCandidateUrls：逗号分隔、去重、去尾斜杠', () => {
  assert.deepEqual(parseCandidateUrls('http://a:8010, https://b:8010/ ,, http://a:8010'), ['http://a:8010', 'https://b:8010'])
  assert.deepEqual(parseCandidateUrls(undefined, 'http://fallback:8010'), ['http://fallback:8010'])
  assert.deepEqual(parseCandidateUrls(null), [])
  assert.throws(() => parseCandidateUrls('ftp://x'), /协议不支持/)
  assert.throws(() => parseCandidateUrls('http://user:pw@x'), /非法部分/)
})

test('classifyEndpoint：tailnet 与 direct 分类', () => {
  assert.equal(classifyEndpoint('http://100.101.102.103:8010').kind, 'tailnet')
  assert.equal(classifyEndpoint('https://box-a.tail1234.ts.net').kind, 'tailnet')
  assert.equal(classifyEndpoint('http://box-a:8010').kind, 'tailnet')
  assert.equal(classifyEndpoint('http://192.168.1.5:8010').kind, 'direct')
  assert.equal(classifyEndpoint('https://wemux.example.com').kind, 'direct')
  assert.equal(classifyEndpoint('http://localhost:8010').kind, 'direct')
})

test('orderEndpoints：prefer=tailnet 时 tailnet 优先，any 保持顺序', () => {
  const urls = ['http://192.168.1.5:8010', 'http://100.101.102.103:8010']
  assert.deepEqual(orderEndpoints(urls, 'tailnet').map(e => e.kind), ['tailnet', 'direct'])
  assert.deepEqual(orderEndpoints(urls, 'direct').map(e => e.kind), ['direct', 'tailnet'])
  assert.deepEqual(orderEndpoints(urls, 'any').map(e => e.kind), ['direct', 'tailnet'])
  assert.deepEqual(orderEndpoints(urls, 'tailnet').map(e => e.url), ['http://100.101.102.103:8010', 'http://192.168.1.5:8010'])
})

test('parsePreference：非法输入回退 any', () => {
  assert.equal(parsePreference('tailnet'), 'tailnet')
  assert.equal(parsePreference('direct'), 'direct')
  assert.equal(parsePreference('any'), 'any')
  assert.equal(parsePreference(undefined), 'any')
  assert.equal(parsePreference('nonsense'), 'any')
})

test('resolveAutoPreference：无 tailnet 候选不探测 CLI，保持 any', async () => {
  let probed = 0
  const counting: TailscaleProbe = { run: async () => { probed += 1; throw new Error('should not probe') } }
  const result = await resolveAutoPreference(counting, ['http://192.168.1.5:8010', 'https://wemux.example.com'])
  assert.equal(result.prefer, 'any')
  assert.equal(probed, 0)
})

test('resolveAutoPreference：有 tailnet 候选且 CLI 可用 → 自动 tailnet', async () => {
  const result = await resolveAutoPreference(fakeProbe('ok'), ['http://192.168.1.5:8010', 'http://100.101.102.103:8010'])
  assert.equal(result.prefer, 'tailnet')
  assert.match(result.reason, /tailscale CLI/)
})

test('resolveAutoPreference：有 tailnet 候选但 CLI 缺失 → 保持 any', async () => {
  const result = await resolveAutoPreference(fakeProbe('missing'), ['http://100.101.102.103:8010'])
  assert.equal(result.prefer, 'any')
  assert.match(result.reason, /未检测到/)
})
