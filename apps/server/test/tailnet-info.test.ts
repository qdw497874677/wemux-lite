import assert from 'node:assert/strict'
import test from 'node:test'
import { readTailnetSelf, type TailnetRunner } from '../src/application/tailnet-info.js'

const statusJson = (self?: { DNSName?: string; TailscaleIPs?: string[] }, backendState = 'Running') =>
  JSON.stringify({ BackendState: backendState, Self: self })

test('readTailnetSelf：CLI 正常时解析自检信息', async () => {
  const runner: TailnetRunner = async () => ({ stdout: statusJson({ DNSName: 'box-a.tail1234.ts.net.', TailscaleIPs: ['100.1.2.3', 'fd7a::1'] }), stderr: '' })
  const info = await readTailnetSelf(runner, 0)
  assert.equal(info.available, true)
  assert.equal(info.state, 'Running')
  assert.equal(info.dnsName, 'box-a.tail1234.ts.net', '去掉尾部点号')
  assert.deepEqual(info.selfIps, ['100.1.2.3', 'fd7a::1'])
})

test('readTailnetSelf：未登录时仍返回结构化状态', async () => {
  const runner: TailnetRunner = async () => ({ stdout: statusJson(undefined, 'NeedsLogin'), stderr: '' })
  const info = await readTailnetSelf(runner, 0)
  assert.equal(info.available, true)
  assert.equal(info.state, 'NeedsLogin')
  assert.equal(info.dnsName, null)
})

test('readTailnetSelf：CLI 缺失时 available:false，不抛错', async () => {
  const runner: TailnetRunner = async () => { throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' }) }
  const info = await readTailnetSelf(runner, 0)
  assert.equal(info.available, false)
  assert.equal(info.state, 'unavailable')
  assert.deepEqual(info.selfIps, [])
  assert.match(info.error ?? '', /ENOENT/)
})

test('readTailnetSelf：坏 JSON 同样收敛为 unavailable', async () => {
  const runner: TailnetRunner = async () => ({ stdout: 'not json', stderr: '' })
  const info = await readTailnetSelf(runner, 0)
  assert.equal(info.available, false)
})

test('readTailnetSelf：ttl 内命中缓存不再执行子进程', async () => {
  let calls = 0
  const runner: TailnetRunner = async () => { calls++; return { stdout: statusJson(), stderr: '' } }
  await readTailnetSelf(runner, 60_000)
  await readTailnetSelf(runner, 60_000)
  assert.equal(calls, 1, '第二次应命中缓存')
})
