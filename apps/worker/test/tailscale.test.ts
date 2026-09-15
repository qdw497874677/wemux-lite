import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyHost, isDefiniteTailnet, parsePingOutput, parseStatusJson, preflightServer, probeCli, reportTailscale, type TailscaleProbe } from '../src/transport/tailscale.js'

function fakeProbe(script: Record<string, { stdout?: string; stderr?: string; error?: Error }>): TailscaleProbe {
  return {
    run: async (command, args) => {
      const key = `${command} ${args.filter(a => !a.startsWith('--')).join(' ')}`.trim()
      const result = script[key] ?? script[args[0]]
      if (!result) throw Object.assign(new Error(`spawn tailscale ENOENT`), { code: 'ENOENT' })
      if (result.error) throw result.error
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    },
  }
}

test('classifyHost 识别 Tailscale 地址空间', () => {
  assert.equal(classifyHost('100.101.102.103'), 'cgnat-ip')
  assert.equal(classifyHost('100.64.0.1'), 'cgnat-ip')
  assert.equal(classifyHost('100.127.255.255'), 'cgnat-ip')
  assert.equal(classifyHost('100.63.0.1'), 'other', '低于 CGNAT 段')
  assert.equal(classifyHost('100.128.0.1'), 'other', '高于 CGNAT 段')
  assert.equal(classifyHost('myserver.tail1234.ts.net.'), 'magic-dns')
  assert.equal(classifyHost('MY-SOST.TS.NET'), 'magic-dns')
  assert.equal(classifyHost('myserver'), 'short-name')
  assert.equal(classifyHost('example.com'), 'other')
  assert.equal(classifyHost('192.168.1.5'), 'other')
  assert.ok(isDefiniteTailnet('cgnat-ip'))
  assert.ok(isDefiniteTailnet('magic-dns'))
  assert.ok(!isDefiniteTailnet('short-name'))
})

test('parseStatusJson 提取本机状态', () => {
  const info = parseStatusJson(JSON.stringify({ BackendState: 'Running', Self: { HostName: 'box-a', DNSName: 'box-a.tail1234.ts.net.', TailscaleIPs: ['100.1.2.3', 'fd7a::1'] } }))
  assert.equal(info.state, 'Running')
  assert.equal(info.hostname, 'box-a')
  assert.equal(info.dnsName, 'box-a.tail1234.ts.net')
  assert.deepEqual(info.selfIps, ['100.1.2.3', 'fd7a::1'])
  const minimal = parseStatusJson('{}')
  assert.equal(minimal.state, 'Unknown')
  assert.deepEqual(minimal.selfIps, [])
})

test('parsePingOutput 识别 pong 与失败', () => {
  assert.deepEqual(parsePingOutput('pong from box-a (100.101.102.103) via 10.0.0.5:41641 in 12ms\n', ''), { ok: true, detail: 'pong from box-a (100.101.102.103) via 10.0.0.5:41641 in 12ms' })
  assert.deepEqual(parsePingOutput('pong from box-a (100.101.102.103) via DERP(sfo) in 88ms\n', ''), { ok: true, detail: 'pong from box-a (100.101.102.103) via DERP(sfo) in 88ms' })
  const failed = parsePingOutput('', 'timeout waiting for ping reply')
  assert.equal(failed.ok, false)
})

test('probeCli 把 ENOENT 归结为未安装', async () => {
  const missing = await probeCli(fakeProbe({}))
  assert.equal(missing.available, false)
  assert.match(missing.error, /未安装/)
  const present = await probeCli(fakeProbe({ version: { stdout: '1.66.0\n go version: go1.22\n' } }))
  assert.equal(present.available, true)
  assert.equal(present.version, '1.66.0')
})

test('reportTailscale 汇总状态，CLI 缺失时标记 unavailable', async () => {
  const missing = await reportTailscale(fakeProbe({}))
  assert.equal(missing.available, false)
  assert.equal(missing.state, 'unavailable')
  const running = await reportTailscale(fakeProbe({
    version: { stdout: '1.66.0\n' },
    status: { stdout: JSON.stringify({ BackendState: 'Running', Self: { HostName: 'box-a', TailscaleIPs: ['100.1.2.3'] } }) },
  }))
  assert.equal(running.state, 'Running')
  assert.deepEqual(running.selfIps, ['100.1.2.3'])
})

test('preflightServer：普通地址跳过，不执行任何探测', async () => {
  let calls = 0
  const probe: TailscaleProbe = { run: async () => { calls++; throw new Error('unexpected') } }
  const result = await preflightServer(probe, 'http://example.com:8010')
  assert.equal(result.verdict, 'skip')
  assert.equal(calls, 0, '普通地址不应触发 CLI 调用')
})

test('preflightServer：tailnet 地址 + Tailscale 未运行 → error', async () => {
  const result = await preflightServer(fakeProbe({
    version: { stdout: '1.66.0\n' },
    status: { stdout: JSON.stringify({ BackendState: 'NeedsLogin' }) },
  }), 'http://100.101.102.103:8010')
  assert.equal(result.classification, 'cgnat-ip')
  assert.equal(result.verdict, 'error')
  assert.match(result.message, /NeedsLogin/)
})

test('preflightServer：tailnet 地址 + 未装 CLI → warning 不阻断', async () => {
  const result = await preflightServer(fakeProbe({}), 'https://box-a.tail1234.ts.net')
  assert.equal(result.verdict, 'warning')
  assert.match(result.message, /未检测到 tailscale/)
})

test('preflightServer：Running + ping 通 → ok', async () => {
  const result = await preflightServer(fakeProbe({
    version: { stdout: '1.66.0\n' },
    status: { stdout: JSON.stringify({ BackendState: 'Running', Self: { HostName: 'worker-1', TailscaleIPs: ['100.9.9.9'] } }) },
    ping: { stdout: 'pong from box-a (100.101.102.103) via DERP(sfo) in 20ms\n' },
  }), 'http://100.101.102.103:8010')
  assert.equal(result.verdict, 'ok')
  assert.equal(result.ping?.ok, true)
})

test('preflightServer：Running + ping 超时 → warning 且继续', async () => {
  const result = await preflightServer(fakeProbe({
    version: { stdout: '1.66.0\n' },
    status: { stdout: JSON.stringify({ BackendState: 'Running' }) },
    ping: { stderr: 'timeout waiting for ping reply' },
  }), 'http://box-a.tail1234.ts.net:8010')
  assert.equal(result.verdict, 'warning')
})

test('preflightServer：MagicDNS 短名仅在 Running 时才相关', async () => {
  const stopped = await preflightServer(fakeProbe({ version: { stdout: '1.66.0\n' }, status: { stdout: JSON.stringify({ BackendState: 'Stopped' }) } }), 'http://box-a:8010')
  assert.equal(stopped.relevant, false, '短名 + 非 Running 视为普通局域网主机名')
  const running = await preflightServer(fakeProbe({
    version: { stdout: '1.66.0\n' },
    status: { stdout: JSON.stringify({ BackendState: 'Running' }) },
    ping: { stdout: 'pong from box-a (100.101.102.103) via 10.0.0.5:41641 in 5ms\n' },
  }), 'http://box-a:8010')
  assert.equal(running.verdict, 'ok')
})


test('生产预检使用自定义 socket，与 nc 指向同一 daemon', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { defaultProbe } = await import('../src/transport/tailscale.js')
  const dir = await mkdtemp(join(tmpdir(), 'wemux-ts-probe-'))
  const previousPath = process.env.PATH
  const previousSocket = process.env.WEMUX_TS_SOCKET
  try {
    const socket = join(dir, 'custom daemon.sock')
    await writeFile(join(dir, 'tailscale'), `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes("version")){console.log("1.98.8");process.exit(0)}
if(args[0]!=="--socket"||args[1]!==process.env.WEMUX_TS_SOCKET){console.error("dial unix /var/run/tailscaled.socket: no such file or directory");process.exit(1)}
if(args[2]==="status")console.log(JSON.stringify({BackendState:"Running"}));
else if(args[2]==="ping")console.log("pong from server");
else process.exit(2);
`, { mode: 0o755 })
    process.env.PATH = `${dir}:${previousPath ?? ''}`
    process.env.WEMUX_TS_SOCKET = socket
    const result = await preflightServer(defaultProbe, 'http://100.125.233.50:8010')
    assert.equal(result.verdict, 'ok', result.message)
    assert.equal(result.report?.state, 'Running')
    assert.equal(result.ping?.ok, true)
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath
    if (previousSocket === undefined) delete process.env.WEMUX_TS_SOCKET; else process.env.WEMUX_TS_SOCKET = previousSocket
    await rm(dir, { recursive: true, force: true })
  }
})

test('状态读取失败不能认定未登录或阻止注册尝试', async () => {
  const result = await preflightServer(fakeProbe({
    version: { stdout: '1.98.8' },
    status: { error: new Error('localapi timeout') },
  }), 'http://100.125.233.50:8010')
  assert.equal(result.verdict, 'warning')
  assert.doesNotMatch(result.message, /请先执行 tailscale up/)
})
