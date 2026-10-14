import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { agentCatalogEntries, agentInstallScript, agentManifestBody, serveAgentDownload } from '../http/agent-downloads.ts'
import { agentRuntimeCatalog } from '@wemux/domain'

/**
 * 固定版本安装脚本的离线契约测试：不访问真实 npm registry。
 * 覆盖「命中固定版本 → 装到指定目录 → sha512 校验 → 版本探测 → 记录托管选择」
 * 以及完整性不符、未知版本、非法目录（非绝对/符号链接/越出 Worker home）的拒绝路径。
 */

const FAKE_NAME = '@wemux-test/fake-pi'
const FAKE_VERSION = '1.2.3'
const FAKE_BIN = 'cli.js'

function sha512Base64(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

interface FakeRegistry {
  readonly origin: string
  readonly tarball: Buffer
  readonly filename: string
  close(): Promise<void>
}

/** 极简 npm registry：只提供 packument 与 tarball，便于断言离线安装链路。 */
async function startFakeRegistry(tarball: Buffer, filename: string, options: { readonly missing?: boolean } = {}): Promise<FakeRegistry> {
  const integrity = sha512Base64(tarball)
  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://registry.test').pathname)
    if (options.missing) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Not found' }))
      return
    }
    if (path.endsWith('.tgz')) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(tarball.byteLength) })
      response.end(tarball)
      return
    }
    if (path === `/${FAKE_NAME}` || path === `/${encodeURIComponent(FAKE_NAME)}`) {
      const body = JSON.stringify({
        name: FAKE_NAME,
        'dist-tags': { latest: FAKE_VERSION },
        versions: {
          [FAKE_VERSION]: {
            name: FAKE_NAME,
            version: FAKE_VERSION,
            bin: { pi: FAKE_BIN },
            dist: { tarball: `http://127.0.0.1:${(server.address() as { port: number }).port}/${FAKE_NAME}/-/${filename}`, integrity, shasum: createHash('sha1').update(tarball).digest('hex') },
          },
        },
      })
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) })
      response.end(body)
      return
    }
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'Not found' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { origin, tarball, filename, close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))) }
}

/** 构建一个与固定目录同形状的假包（bin 名为 pi，--version 输出固定版本）。 */
async function buildFakeTarball(directory: string) {
  const source = join(directory, 'fake-package')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: FAKE_NAME, version: FAKE_VERSION, bin: { pi: FAKE_BIN }, files: [FAKE_BIN] }))
  await writeFile(join(source, FAKE_BIN), `#!/usr/bin/env node\nprocess.stdout.write('${FAKE_VERSION}\\n')\n`)
  await chmod(join(source, FAKE_BIN), 0o755)
  const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: source, encoding: 'utf8' })
  assert.equal(packed.status, 0, `fake package pack failed: ${packed.stderr}`)
  const filename = (JSON.parse(packed.stdout) as { filename: string }[])[0].filename
  return { filename, bytes: await readFile(join(directory, filename)) }
}

function scriptFor(registryOrigin: string, integrity: string, bytes: Uint8Array) {
  return agentInstallScript({ registryOrigin, catalog: { pi: { name: FAKE_NAME, version: FAKE_VERSION, bin: FAKE_BIN, integrity: integrity || sha512Base64(bytes) } } })
}

function runScript(script: string, env: NodeJS.ProcessEnv, input?: Buffer) {
  const child = spawn('/bin/sh', ['-c', script], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  if (input) child.stdin.end(input)
  else child.stdin.end()
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => child.on('close', status => resolve({ status, stdout, stderr })))
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'wemux-agent-script-'))
  const home = join(root, 'worker-home')
  await mkdir(home, { recursive: true, mode: 0o700 })
  return { root, home, installDir: join(home, 'agents', 'pi') }
}

test('固定版本命中：脚本装到指定目录、校验 sha512、探测版本并记录托管选择', async () => {
  const space = await workspace()
  try {
    const built = await buildFakeTarball(space.root)
    const registry = await startFakeRegistry(built.bytes, built.filename)
    try {
      const script = scriptFor(registry.origin, '', built.bytes)
      const result = await runScript(script, { WEMUX_AGENT_KEY: 'pi', WEMUX_INSTALL_DIR: space.installDir, WEMUX_WORKER_HOME: space.home })
      assert.equal(result.status, 0, `script failed: ${result.stderr}`)
      assert.match(result.stdout, /\[1\/4\] 下载固定版本官方包/)
      assert.match(result.stdout, /\[2\/4\] 校验 sha512 完整性/)
      assert.match(result.stdout, /\[4\/4\] 探测版本/)
      assert.match(result.stdout, /选择已保存；正在运行的 Worker 不会热更新/)
      const settings = JSON.parse(await readFile(join(space.home, 'agents.json'), 'utf8'))
      assert.equal(settings.pi.source, 'managed')
      assert.equal(settings.pi.package, `${FAKE_NAME}@${FAKE_VERSION}`)
      // 安装落到指定目录下的独立子目录，入口可执行并真实通过版本探测。
      assert.ok(settings.pi.executable.startsWith(`${space.installDir}/`), settings.pi.executable)
      const version = spawnSync(settings.pi.executable, ['--version'], { encoding: 'utf8' })
      assert.equal(version.status, 0)
      assert.equal(version.stdout.trim(), FAKE_VERSION)
      // 不使用全局前缀：安装只发生在指定目录下的独立暂存目录内。
      const staged = (await readdir(space.installDir)).filter(name => name.startsWith(`${FAKE_VERSION}-`))
      assert.equal(staged.length, 1, `expected one staged runtime, got ${staged.join(',')}`)
      const marker = JSON.parse(await readFile(join(space.installDir, staged[0], '.wemux-managed-agent.json'), 'utf8'))
      assert.equal(marker.installRoot, space.installDir)
      assert.equal(marker.integrity, sha512Base64(built.bytes))
      assert.match(result.stderr, /不覆盖已有选择/)
    } finally { await registry.close() }
  } finally { await rm(space.root, { recursive: true, force: true }) }
})

test('完整性不符：拒绝安装且不改动任何已有选择或目录', async () => {
  const space = await workspace()
  try {
    const built = await buildFakeTarball(space.root)
    const registry = await startFakeRegistry(built.bytes, built.filename)
    try {
      const tampered = `sha512-${Buffer.alloc(64, 7).toString('base64')}`
      const script = scriptFor(registry.origin, tampered, built.bytes)
      const result = await runScript(script, { WEMUX_AGENT_KEY: 'pi', WEMUX_INSTALL_DIR: space.installDir, WEMUX_WORKER_HOME: space.home })
      assert.equal(result.status, 65, `expected integrity rejection, got ${result.status}: ${result.stderr}`)
      assert.match(result.stderr, /完整性校验失败/)
      await assert.rejects(readFile(join(space.home, 'agents.json'), 'utf8'))
      const listing = spawnSync('/bin/sh', ['-c', `ls -A ${JSON.stringify(space.installDir)} 2>/dev/null | wc -l`], { encoding: 'utf8' })
      assert.equal(listing.stdout.trim(), '0', 'integrity failure must not leave installed files behind')
    } finally { await registry.close() }
  } finally { await rm(space.root, { recursive: true, force: true }) }
})

test('固定版本未命中：registry 上没有该版本时安装失败且不落盘', async () => {
  const space = await workspace()
  try {
    const built = await buildFakeTarball(space.root)
    const registry = await startFakeRegistry(built.bytes, built.filename, { missing: true })
    try {
      const result = await runScript(scriptFor(registry.origin, '', built.bytes), { WEMUX_AGENT_KEY: 'pi', WEMUX_INSTALL_DIR: space.installDir, WEMUX_WORKER_HOME: space.home })
      assert.equal(result.status, 67, `expected fetch failure, got ${result.status}: ${result.stderr}`)
      await assert.rejects(readFile(join(space.home, 'agents.json'), 'utf8'))
    } finally { await registry.close() }
  } finally { await rm(space.root, { recursive: true, force: true }) }
})

test('安装目录必须是 Worker home 内的绝对路径：非绝对、越出 home、符号链接都拒绝', async () => {
  const space = await workspace()
  try {
    const built = await buildFakeTarball(space.root)
    const registry = await startFakeRegistry(built.bytes, built.filename)
    const script = scriptFor(registry.origin, '', built.bytes)
    try {
      const relative = await runScript(script, { WEMUX_AGENT_KEY: 'pi', WEMUX_INSTALL_DIR: 'agents/pi', WEMUX_WORKER_HOME: space.home })
      assert.equal(relative.status, 64)
      assert.match(relative.stderr, /WEMUX_INSTALL_DIR 必须是绝对路径/)

      const outside = await runScript(script, { WEMUX_AGENT_KEY: 'pi', WEMUX_INSTALL_DIR: join(space.root, 'outside'), WEMUX_WORKER_HOME: space.home })
      assert.equal(outside.status, 68)
      assert.match(outside.stderr, /安装目录必须位于 WEMUX_WORKER_HOME 内/)

      const linked = join(space.home, 'linked')
      await symlink(join(space.root, 'outside'), linked)
      const symlinked = await runScript(script, { WEMUX_AGENT_KEY: 'pi', WEMUX_INSTALL_DIR: join(linked, 'pi'), WEMUX_WORKER_HOME: space.home })
      assert.equal(symlinked.status, 68)
      assert.match(symlinked.stderr, /符号链接/)

      const missingHome = await runScript(script, { WEMUX_AGENT_KEY: 'pi', WEMUX_INSTALL_DIR: space.installDir })
      assert.equal(missingHome.status, 64)
      assert.match(missingHome.stderr, /缺少 WEMUX_WORKER_HOME/)

      // 显式覆盖后允许外部目录，但仍然不使用全局前缀（安装仅发生在该目录内）。
      const allowed = await runScript(script, { WEMUX_AGENT_KEY: 'pi', WEMUX_INSTALL_DIR: join(space.root, 'outside'), WEMUX_WORKER_HOME: space.home, WEMUX_ALLOW_EXTERNAL_INSTALL_DIR: 'yes' })
      assert.equal(allowed.status, 0, `override should install: ${allowed.stderr}`)
      assert.ok((await readFile(join(space.home, 'agents.json'), 'utf8')).includes(join(space.root, 'outside')))
    } finally { await registry.close() }
  } finally { await rm(space.root, { recursive: true, force: true }) }
})

test('环境变量只作数据：注入字符不会进入 shell 执行，未知 Agent 键被拒绝', async () => {
  const space = await workspace()
  try {
    const built = await buildFakeTarball(space.root)
    const registry = await startFakeRegistry(built.bytes, built.filename)
    const script = scriptFor(registry.origin, '', built.bytes)
    try {
      const injected = `$(touch ${join(space.root, 'pwned')})`
      const result = await runScript(script, { WEMUX_AGENT_KEY: 'pi', WEMUX_INSTALL_DIR: injected, WEMUX_WORKER_HOME: space.home })
      assert.equal(result.status, 64)
      await assert.rejects(readFile(join(space.root, 'pwned'), 'utf8'))
      const unknown = await runScript(script, { WEMUX_AGENT_KEY: 'pi; touch /tmp/wemux-pwned', WEMUX_INSTALL_DIR: space.installDir, WEMUX_WORKER_HOME: space.home })
      assert.equal(unknown.status, 64)
      assert.match(unknown.stderr, /不支持的 WEMUX_AGENT_KEY/)
    } finally { await registry.close() }
  } finally { await rm(space.root, { recursive: true, force: true }) }
})

test('生产脚本与清单内嵌共享固定版本目录（防止 Server/Worker 漂移）', () => {
  const script = agentInstallScript()
  for (const entry of agentCatalogEntries()) {
    assert.ok(script.includes(JSON.stringify(entry.packageIntegrity)), `script must embed integrity of ${entry.key}`)
    assert.ok(script.includes(entry.packageVersion), `script must embed pinned version of ${entry.key}`)
  }
  const manifest = JSON.parse(agentManifestBody())
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.registryOrigin, 'https://registry.npmjs.org')
  assert.equal(manifest.installerPath, '/downloads/install-agent.sh')
  assert.deepEqual(manifest.agents.map((entry: { key: string }) => entry.key), Object.keys(agentRuntimeCatalog))
  assert.equal(manifest.agents.find((entry: { key: string }) => entry.key !== 'pi').packageName, 'opencode-ai')
})

test('下载面只服务两个固定路径并带 no-store 头', async () => {
  const headers: Record<string, string> = {}
  let body = ''
  const response = { writeHead: (status: number, value: Record<string, string>) => { headers.status = String(status); for (const [name, item] of Object.entries(value)) headers[name.toLowerCase()] = item; return response }, end: (value: string) => { body = value } } as unknown as import('node:http').ServerResponse
  assert.equal(await serveAgentDownload(response, '/downloads/install-agent.sh'), true)
  assert.equal(headers['cache-control'], 'no-store')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.match(headers['content-type'], /x-shellscript/)
  assert.match(body, /^#!\/bin\/sh\n/)
  assert.equal(await serveAgentDownload(response, '/downloads/agent-manifest.json'), true)
  assert.match(headers['content-type'], /application\/json/)
  assert.equal(JSON.parse(body).schemaVersion, 1)
  assert.equal(await serveAgentDownload(response, '/downloads/install-worker.sh'), false)
})
