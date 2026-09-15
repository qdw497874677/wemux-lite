import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { buildWorkerInstallCommand } from '../src/lib/worker-install.ts'

test('single https command is a compact two-line pipeline (curl -fsSL … | env sh)', () => {
  const command = buildWorkerInstallCommand({ token: 'secret', serverUrl: 'https://wemux.example.com', workerName: 'box-a' })
  assert.equal(command, [
    `curl -fsSL --connect-timeout 5 'https://wemux.example.com/downloads/install-worker.sh' \\`,
    `  | WEMUX_SERVER_URL='https://wemux.example.com' WEMUX_SERVER_URLS='https://wemux.example.com' WEMUX_ENROLLMENT_TOKEN='secret' WEMUX_WORKER_NAME='box-a' sh`,
  ].join('\n'))
  assert.doesNotMatch(command, /--proto/, '不再携带 --proto 加固标志（保持 curl -fsSL 行业惯例长度）')
})

test('loopback development command gets --noproxy for proxy-hostile environments', () => {
  const command = buildWorkerInstallCommand({ token: 'secret', serverUrl: 'http://127.0.0.1:3001', workerName: 'Local' })
  assert.match(command, /curl -fsSL --connect-timeout 5 'http:\/\/127\.0\.0\.1:3001\/downloads\/install-worker\.sh' --noproxy '127\.0\.0\.1' \\/)
})

test('多候选地址：下载段为 fallback 组，私网/CGNAT 主机加 --noproxy，URLS 一行携带不再重复 SERVER_URL', () => {
  const command = buildWorkerInstallCommand({
    token: 'secret', serverUrl: 'http://192.168.1.10:8010', workerName: 'N',
    serverUrls: ['http://192.168.1.10:8010', 'http://100.101.102.103:8010', 'http://box-a.tail1234.ts.net:8010'],
  })
  const lines = command.split('\n')
  assert.match(lines[0], /^\{ curl -fsSL --connect-timeout 5 'http:\/\/192\.168\.1\.10:8010\/downloads\/install-worker\.sh' --noproxy '192\.168\.1\.10' \\$/)
  assert.match(lines[1], /^ {2}\|\| curl -fsSL --connect-timeout 5 'http:\/\/100\.101\.102\.103:8010\/downloads\/install-worker\.sh' --noproxy '100\.101\.102\.103' \\$/)
  assert.match(lines[2], /^ {2}\|\| curl -fsSL --connect-timeout 5 'http:\/\/box-a\.tail1234\.ts\.net:8010\/downloads\/install-worker\.sh' ; \} \\$/)
  assert.ok(!lines[2].includes('--noproxy'), '公网域名主机不加 --noproxy')
  assert.match(lines[3], /^ {2}\| WEMUX_SERVER_URLS='http:\/\/192\.168\.1\.10:8010,http:\/\/100\.101\.102\.103:8010,http:\/\/box-a\.tail1234\.ts\.net:8010' WEMUX_ENROLLMENT_TOKEN='secret' WEMUX_WORKER_NAME='N' sh$/)
  assert.doesNotMatch(command, /WEMUX_SERVER_URL=/)
  assert.doesNotMatch(command, /WEMUX_PREFER/)
})

test('prefer 连接方式写入 WEMUX_PREFER，auto 不写入', () => {
  const withPrefer = buildWorkerInstallCommand({ token: 'secret', serverUrl: 'http://192.168.1.10:8010', workerName: 'N', serverUrls: ['http://192.168.1.10:8010', 'http://box-a.tail1234.ts.net:8010'], prefer: 'tailnet' })
  assert.match(withPrefer, /WEMUX_PREFER='tailnet' /)
  const auto = buildWorkerInstallCommand({ token: 'secret', serverUrl: 'http://192.168.1.10:8010', workerName: 'N', prefer: 'any' })
  assert.doesNotMatch(auto, /WEMUX_PREFER/)
})

test('生成的多候选命令是合法 shell（sh -n 语法检查）', () => {
  const command = buildWorkerInstallCommand({
    token: 'sec"ret', serverUrl: 'http://10.0.0.5:8010', workerName: '节点 01',
    serverUrls: ['http://10.0.0.5:8010', 'http://100.101.102.103:8010'], prefer: 'direct',
  })
  execFileSync('sh', ['-n', '-c', command])
})

test('nc 传输：引导段换成 node 隧道下载器，写入 WEMUX_TRANSPORT，https 候选被剔除', () => {
  const command = buildWorkerInstallCommand({
    token: 'secret', serverUrl: 'http://192.168.1.10:8010', workerName: 'N',
    serverUrls: ['http://192.168.1.10:8010', 'https://wemux.example.com', 'http://100.101.102.103:8010'],
    transport: 'nc',
  })
  assert.match(command, /'192\.168\.1\.10' '8010' '\/downloads\/install-worker\.sh' "\$d\/install.sh"/)
  assert.match(command, /\|\| node -e .*'100\.101\.102\.103' '8010'/)
  assert.match(command, /WEMUX_SERVER_URLS='http:\/\/192\.168\.1\.10:8010,http:\/\/100\.101\.102\.103:8010' WEMUX_TRANSPORT='nc' WEMUX_ENROLLMENT_TOKEN='secret' WEMUX_WORKER_NAME='N' sh "\$d\/install.sh"/)
  assert.match(command, /\|\| exit 1/)
  assert.doesNotMatch(command, /\| WEMUX/)
  assert.doesNotMatch(command, /curl/)
  assert.doesNotMatch(command, /wemux\.example\.com/)
  execFileSync('sh', ['-n', '-c', command])
})

test('nc 传输：单地址且无端口时默认 80，仍是合法 shell', () => {
  const command = buildWorkerInstallCommand({ token: 's', serverUrl: 'http://box-a.tail1234.ts.net', workerName: 'N', transport: 'nc' })
  assert.match(command, /'box-a\.tail1234\.ts\.net' '80' '\/downloads\/install-worker\.sh' "\$d\/install.sh"/)
  assert.match(command, /WEMUX_SERVER_URL='http:\/\/box-a\.tail1234\.ts\.net' WEMUX_SERVER_URLS='http:\/\/box-a\.tail1234\.ts\.net' WEMUX_TRANSPORT='nc'/)
  execFileSync('sh', ['-n', '-c', command])
})

test('nc 传输：全部候选都是 https 时回退到 curl 引导（避免生成必败命令）', () => {
  const command = buildWorkerInstallCommand({ token: 's', serverUrl: 'https://wemux.example.com', workerName: 'N', serverUrls: ['https://wemux.example.com'], transport: 'nc' })
  assert.match(command, /curl -fsSL/)
  assert.doesNotMatch(command, /WEMUX_TRANSPORT/)
})
