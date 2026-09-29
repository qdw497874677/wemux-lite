import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { serveWorkerDownload } from '../src/http/worker-downloads.js'
import { buildWorkerInstallCommand } from '../../web/src/lib/worker-install.ts'
import { ncDownloadScript } from '@wemux/web-contract'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-nc-test-'))
  const tarball = Buffer.alloc(256 * 1024, 137)
  await writeFile(join(dir, 'package.tgz'), tarball)
  // Model tailscale nc exiting as soon as stdin reaches EOF, even before a reply.
  await writeFile(join(dir, 'tailscale'), `#!${process.execPath}
const net=require('node:net');
const args=process.argv.slice(2);
if(args[0]!=='--socket'||args[1]!==process.env.WEMUX_TS_SOCKET)process.exit(9);
if(process.env.NC_EMPTY||args.at(-2)==='empty.test')process.exit(0);
const s=net.connect(Number(args.at(-1)),args.at(-2));
process.stdin.on('end',()=>process.exit(0));
process.stdin.pipe(s);s.pipe(process.stdout);
process.stdout.on('finish',()=>process.exit(0));s.on('error',e=>{console.error(e.message);process.exit(1)});
`, { mode: 0o755 })
  await writeFile(join(dir, 'npm'), `#!${process.execPath}
const fs=require('node:fs');
for(const flag of ['--ignore-scripts','--no-audit','--no-fund'])if(!process.argv.includes(flag)){console.error('missing install guard '+flag);process.exit(7)}
const b=fs.readFileSync(process.argv.at(-1));
if(!b.equals(fs.readFileSync(process.env.EXPECTED)))process.exit(8);
fs.writeFileSync(process.env.MARKER,'installed');
`, { mode: 0o755 })
  const server = createServer((req, res) => {
    if (req.url === '/truncated') { res.writeHead(200, { 'Content-Length': '200' }); res.end('partial'); return }
    if (req.url === '/zero') { res.writeHead(200, { 'Content-Length': '0' }); res.end(); return }
    if (req.url === '/chunked') { res.writeHead(200); res.write('partial'); res.end(); return }
    if (req.url === '/error') { res.writeHead(503); res.end('unavailable'); return }
    if (req.url === '/stall') { res.writeHead(200, { 'Content-Length': '200' }); res.write('partial'); return }
    void serveWorkerDownload(res, req.url!, { tarballPath: join(dir, 'package.tgz') })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, WEMUX_TS_SOCKET: '/custom/socket', EXPECTED: join(dir, 'package.tgz'), MARKER: join(dir, 'marker'), WEMUX_SERVER_URL: url, WEMUX_TRANSPORT: 'nc', WEMUX_ENROLLMENT_TOKEN: '', WEMUX_INSTALL_MODE: 'global' }
  async function run(command: string, extra = {}, timeout = 10000) {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('sh', ['-c', command], { env: { ...env, ...extra }, cwd: dir, detached: true })
      let stdout = '', stderr = ''
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; if (child.pid) process.kill(-child.pid, 'SIGKILL') }, timeout)
      child.stdout.on('data', c => { stdout += c }); child.stderr.on('data', c => { stderr += c })
      child.on('error', reject)
      child.on('close', code => { clearTimeout(timer); if (timedOut) reject(new Error('test timed out')); else resolve({ code, stdout, stderr }) })
    })
  }
  return { dir, url, run, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) } }
}

test('nc generated bootstrap executes installer only after a complete response; package reaches npm intact', async () => {
  const f = await fixture()
  try {
    const command = buildWorkerInstallCommand({ token: '', workerName: 'test', serverUrl: f.url, transport: 'nc' })
    const result = await f.run(command, { WEMUX_SERVER_URLS: 'http://stale.invalid' })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await readFile(join(f.dir, 'marker'), 'utf8'), 'installed')
    assert.match(result.stdout, /Wemux Worker installed/)
    assert.match(result.stderr, /Verified package SHA-256.*no Agent runtime/)
    assert.match(result.stderr, /Worker installed/)
  } finally { await f.close() }
})

test('nc installer writes to requested tgz path rather than literal -o', async () => {
  const f = await fixture()
  try {
    const installer = await (await fetch(`${f.url}/downloads/install-worker.sh`)).text()
    await writeFile(join(f.dir, 'install.sh'), installer)
    const result = await f.run('sh install.sh')
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await readFile(join(f.dir, 'marker'), 'utf8'), 'installed')
  } finally { await f.close() }
})

test('nc bootstrap empty successful child exit must fail visibly, not execute an empty shell', async () => {
  const f = await fixture()
  try {
    const command = buildWorkerInstallCommand({ token: '', workerName: 'test', serverUrl: f.url, transport: 'nc' })
    const result = await f.run(command, { NC_EMPTY: '1' })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /response|响应|下载/i)
  } finally { await f.close() }
})

for (const path of ['/truncated', '/error', '/zero', '/chunked', '/stall']) {
  test(`nc downloader rejects ${path} without publishing a partial file`, async () => {
    const f = await fixture()
    try {
      const url = new URL(f.url)
      assert.ok(!ncDownloadScript.includes("'"), 'embedded source must be shell-quotable')
      const result = await f.run(`node -e '${ncDownloadScript}' 127.0.0.1 ${url.port} ${path} output`, {}, 35000)
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /nc download:/)
      await assert.rejects(readFile(join(f.dir, 'output')), { code: 'ENOENT' })
      await assert.rejects(readFile(join(f.dir, 'output.part')), { code: 'ENOENT' })
    } finally { await f.close() }
  })
}

test('nc generated command retries empty first candidate then installs complete second response', async () => {
  const f = await fixture()
  try {
    const command = buildWorkerInstallCommand({ token: '', workerName: 'test', serverUrl: f.url, serverUrls: ['http://empty.test', f.url], transport: 'nc' })
    const result = await f.run(command)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /Incomplete HTTP response/)
    assert.equal(await readFile(join(f.dir, 'marker'), 'utf8'), 'installed')
  } finally { await f.close() }
})
