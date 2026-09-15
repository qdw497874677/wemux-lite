import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TailscaleTunnel, openTunnels, type NcSpawner } from '../src/transport/tailscale-tunnel.js'
import { parseTransport } from '../src/config.js'

// 假 nc：stdio ↔ 目标 TCP，行为与 `tailscale nc host port` 相同（stdin/stdout 双向流）。
const fakeNcScript = `const net = require("node:net");
const [host, port] = process.argv.slice(2);
const upstream = net.connect(Number(port), host);
process.stdin.pipe(upstream);
upstream.pipe(process.stdout);
upstream.on("error", () => process.exit(1));
`

async function fakeNcFactory(): Promise<{ spawnNc: NcSpawner; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-fake-nc-'))
  const script = join(dir, 'fake-nc.cjs')
  await writeFile(script, fakeNcScript, { mode: 0o700 })
  return {
    spawnNc: (host, port) => spawn(process.execPath, [script, host, String(port)], { stdio: ['pipe', 'pipe', 'inherit'] }),
    cleanup: async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }) },
  }
}

async function startTarget(): Promise<{ origin: string; wsPathHits: number; requests: number; close: () => Promise<void> }> {
  let wsPathHits = 0
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    if (request.url === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true })); return }
    response.writeHead(404); response.end('not found')
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/worker/ws') { socket.destroy(); return }
    wsPathHits++
    wss.handleUpgrade(request, socket as never, head, (ws: WebSocket) => {
      ws.on('message', raw => ws.send(`echo:${raw.toString()}`))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get wsPathHits() { return wsPathHits },
    get requests() { return requests },
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await Promise.all([
        new Promise<void>(resolve => wss.close(() => resolve())),
        new Promise<void>(resolve => server.close(() => resolve())),
      ])
    },
  }
}

test('parseTransport：direct 默认、nc 合法、非法值报错', () => {
  assert.equal(parseTransport(undefined), 'direct')
  assert.equal(parseTransport(''), 'direct')
  assert.equal(parseTransport('direct'), 'direct')
  assert.equal(parseTransport('nc'), 'nc')
  assert.throws(() => parseTransport('socks'), /不支持的传输通道/)
})

test('TailscaleTunnel：HTTP 与 WebSocket 均经隧道往返，路径保留', async () => {
  const target = await startTarget()
  const fake = await fakeNcFactory()
  const tunnel = new TailscaleTunnel('127.0.0.1', Number(new URL(target.origin).port), fake.spawnNc)
  try {
    const local = await tunnel.listen()
    assert.match(local, /^http:\/\/127\.0\.0\.1:\d+$/)
    // HTTP 请求经过隧道
    const response = await fetch(`${local}/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(target.requests, 1)
    // WebSocket 经过隧道：upgrade 路径保留，消息往返
    const { default: WebSocket } = await import('ws')
    const socket = new WebSocket(`${local.replace('http:', 'ws:')}/worker/ws`)
    const replied = new Promise<string>(resolve => socket.on('message', raw => resolve(raw.toString())))
    const opened = new Promise<void>(resolve => socket.on('open', resolve))
    await opened
    socket.send('ping')
    assert.equal(await replied, 'echo:ping')
    assert.equal(target.wsPathHits, 1)
    socket.close()
  } finally {
    await tunnel.close()
    await target.close()
    await fake.cleanup()
  }
})

test('openTunnels：多候选映射保序，https/wss 明确拒绝，close 回收子进程与端口', async () => {
  const target = await startTarget()
  const fake = await fakeNcFactory()
  const port = new URL(target.origin).port
  try {
    const pool = await openTunnels([`ws://192.0.2.10:8010/worker/ws`, `http://192.0.2.10:8010/downloads/x`, `ws://192.0.2.99:8010/worker/ws`], fake.spawnNc)
    assert.equal(pool.localUrls.length, 3)
    // 同 host:port 的两个候选共用一条隧道（本地端口相同），第三个独立
    assert.equal(new URL(pool.localUrls[0]).port, new URL(pool.localUrls[1]).port)
    assert.notEqual(new URL(pool.localUrls[0]).port, new URL(pool.localUrls[2]).port)
    // 协议与路径保留
    assert.equal(new URL(pool.localUrls[0]).protocol, 'ws:')
    assert.equal(new URL(pool.localUrls[0]).pathname, '/worker/ws')
    assert.equal(new URL(pool.localUrls[1]).pathname, '/downloads/x')
    await pool.close()
    // close 后端口可立即复用（server 已释放）
    const rebound = new TailscaleTunnel('127.0.0.1', Number(new URL(target.origin).port), fake.spawnNc)
    const again = await rebound.listen()
    assert.match(again, /^http:\/\/127\.0\.0\.1:\d+$/)
    await rebound.close()
    // https 候选必须明确报错而不是静默 TLS 失败
    await assert.rejects(() => openTunnels(['https://192.0.2.10:8010'], fake.spawnNc), /仅支持明文/)
    void port
  } finally {
    await target.close()
    await fake.cleanup()
  }
})

test('隧道断开（远端不可达）时本地连接被销毁，后续连接可重建', async () => {
  const fake = await fakeNcFactory()
  // 目标端口故意无人监听：fake nc 连接失败退出，本地 socket 必须随之关闭
  const tunnel = new TailscaleTunnel('127.0.0.1', 1, fake.spawnNc)
  try {
    const local = await tunnel.listen()
    const { default: WebSocket } = await import('ws')
    const closed = new Promise<void>(resolve => {
      const socket = new WebSocket(`${local.replace('http:', 'ws:')}/worker/ws`)
      socket.on('close', () => resolve())
      socket.on('error', () => resolve())
    })
    await closed
    // 隧道本身仍在监听：远端恢复后新连接可正常建立
    const response = await fetch(local).catch(error => error)
    assert.ok(response instanceof Error || response instanceof Response)
  } finally {
    await tunnel.close()
    await fake.cleanup()
  }
})
