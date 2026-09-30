import test from 'node:test'
import { administratorEmail, seedAdministrator, seedLocalAccount } from './fixtures/administrator.js'
import { migrationCount } from '../storage/sqlite/migrations.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { chmodSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { WebSocket } from 'ws'
import { createWemuxServer } from '../server.js'
import { TransportV2Peer } from './transport-v2-peer.js'

const realDateNow = Date.now

const capability = { agentKey: 'pi', displayName: 'Pi', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test-model', displayName: 'Test', source: 'configured' }] }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(20) }
  assert.fail('Timed out waiting for condition')
}

test('serves an installer and configured Worker tarball without exposing enrollment credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-lite-download-')), tarballPath = join(dir, 'wemux-lite-worker.tgz')
  await writeFile(tarballPath, Buffer.from('fake-worker-package'))
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail], workerPackagePath: tarballPath })
  const { token } = await seedAdministrator(app.store)
  const base = await app.listen(0)
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })
  const scriptResponse = await fetch(`${base}/downloads/install-worker.sh`)
  const script = await scriptResponse.text()
  assert.equal(scriptResponse.status, 200)
  assert.match(scriptResponse.headers.get('content-type') ?? '', /text\/x-shellscript/)
  assert.match(script, /WEMUX_SERVER_URL \(or WEMUX_SERVER_URLS\) is required/)
  assert.match(script, /\/downloads\/worker\.tgz/)
  assert.match(script, /server addresses must start with http:\/\/ or https:\//)
  assert.match(script, /--proto "\$candidate_protocol" --proto-redir "\$candidate_protocol" -fsS --connect-timeout 10/)
  assert.match(script, /https:\/\/\*\) candidate_protocol='=https'/)
  assert.match(script, /no_proxy_extra=.*100\.64\.0\.0\/10/, '内网/tailnet 网段默认绕过全局代理')
  assert.match(script, /for candidate in .*tr ',' ' /, '逐候选地址下载 worker 包')
  assert.equal(script.includes(token), false)
  const rootResponse = await fetch(`${base}/`)
  assert.equal(rootResponse.status, 401)
  const packageResponse = await fetch(`${base}/downloads/worker.tgz`)
  assert.equal(packageResponse.status, 200)
  assert.equal(await packageResponse.text(), 'fake-worker-package')
  assert.match(packageResponse.headers.get('content-disposition') ?? '', /attachment/)
  const manifestResponse = await fetch(`${base}/downloads/worker-manifest.json`)
  assert.equal(manifestResponse.status, 200)
  assert.deepEqual(await manifestResponse.json(), { schemaVersion: 1, filename: 'worker.tgz', bytes: 19, sha256: createHash('sha256').update('fake-worker-package').digest('hex') })
})

test('rejects a directory configured as the Worker package', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-lite-download-directory-'))
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail], workerPackagePath: dir })
  const { token } = await seedAdministrator(app.store)
  const base = await app.listen(0)
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })
  const response = await fetch(`${base}/downloads/worker.tgz`)
  assert.equal(response.status, 503)
  assert.match(await response.text(), /Worker package is unavailable/)
})

test('returns 503 when the Worker package was not configured', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const { token } = await seedAdministrator(app.store)
  const base = await app.listen(0)
  t.after(() => app.close())
  const response = await fetch(`${base}/downloads/worker.tgz`)
  assert.equal(response.status, 503)
  assert.match(await response.text(), /Worker package is not configured/)
})

test('serves the web UI bundle with SPA fallback without masking API 404s', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-lite-static-'))
  const root = join(dir, 'dist')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'index.html'), '<!doctype html><title>wemux</title>')
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)')
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail], webStaticPath: root })
  const { token } = await seedAdministrator(app.store)
  const base = await app.listen(0)
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })

  const host = await fetch(`${base}/api/host`)
  assert.equal(host.status, 200)
  assert.equal(host.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await host.json(), { hostKind: 'cluster', contractVersion: 1, capabilities: ['cluster-session', 'projects', 'workers'] })
  const index = await fetch(`${base}/`)
  assert.equal(index.status, 200)
  assert.match(index.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await index.text(), /wemux/)

  const asset = await fetch(`${base}/assets/app.js`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type') ?? '', /text\/javascript/)
  assert.equal(await asset.text(), 'console.log(1)')

  const deepLink = await fetch(`${base}/console/deep/link`, { headers: { accept: 'text/html,application/xhtml+xml' } })
  assert.equal(deepLink.status, 200)
  assert.match(await deepLink.text(), /wemux/)

  const apiMiss = await fetch(`${base}/no-such-endpoint`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` } })
  assert.equal(apiMiss.status, 404)
  assert.match(await apiMiss.text(), /Not found/)

  const prefixed = await fetch(`${base}/api/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  assert.equal(prefixed.status, 200)

  const traversal = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`, { headers: { accept: 'text/html' } })
  assert.equal(traversal.status, 200)
  assert.match(traversal.headers.get('content-type') ?? '', /text\/html/)
  assert.equal((await traversal.text()).includes('root:'), false)
})

test('installer downloads, installs, registers and starts with stubbed tools', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-lite-installer-'))
  const workerPackage = join(dir, 'worker.tgz')
  await writeFile(workerPackage, 'fake-worker-package')
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail], workerPackagePath: workerPackage })
  const { token } = await seedAdministrator(app.store)
  const base = await app.listen(0)
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })
  const script = await (await fetch(`${base}/downloads/install-worker.sh`)).text()
  const scriptPath = join(dir, 'install.sh')
  await writeFile(scriptPath, script)
  const log = join(dir, 'calls.log')
  const stub = (name: string, lines: string[]) => {
    const path = join(dir, name)
    writeFileSync(path, ['#!/bin/sh', ...lines].join('\n') + '\n')
    chmodSync(path, 0o755)
  }
  const path = () => `${dir}:${process.env.PATH ?? ''}`
  const fixtureHash = createHash('sha256').update('fake-tarball').digest('hex')
  stub('curl', [
    `printf 'curl\\n' >> '${log}'`,
    "previous=''", "url=''",
    'for argument in "$@"; do',
    `  if [ "$previous" = '-o' ]; then case "$url" in */worker-manifest.json) printf '%s' '{"schemaVersion":1,"filename":"worker.tgz","sha256":"${fixtureHash}","bytes":12}' > "$argument" ;; *) printf 'fake-tarball' > "$argument" ;; esac; fi`,
    '  case "$argument" in http://*|https://*) url="$argument" ;; esac; previous="$argument"',
    'done',
  ])
  stub('npm', [`printf 'npm %s\\n' "$*" >> '${log}'`])
  stub('wemux-lite-worker', [`[ "$1" = version ] && printf 'wemux-lite-worker 0.1.0\\n'`, `printf 'wemux-lite-worker %s\\n' "$*" >> '${log}'`])
  const run = (extra: Record<string, string> = {}) => spawnSync('sh', [scriptPath], {
    env: { ...process.env, PATH: path(), WEMUX_INSTALL_MODE: 'global', WEMUX_SERVER_URL: base, WEMUX_ENROLLMENT_TOKEN: 'stub-enrollment-token', WEMUX_WORKER_NAME: 'Stub node', ...extra },
  })
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)

  const completed = run()
  assert.equal(completed.status, 0, completed.stderr.toString())
  const executed = lines()
  assert.deepEqual(executed.slice(0, 2), ['curl', 'curl'])
  assert.match(executed[2] ?? '', /^npm install --global .+\/wemux-lite-worker\.[^/]+\/worker\.tgz$/)
  assert.match(executed[3] ?? '', /^wemux-lite-worker version$/)
  assert.equal(executed[4], `wemux-lite-worker register --server ${base} --servers ${base} --name Stub node`)
  assert.equal(executed[5], 'wemux-lite-worker start')

  writeFileSync(log, '')
  stub('curl', [`printf 'curl\\n' >> '${log}'`, "previous=''", 'for argument in "$@"; do', `if [ "$previous" = '-o' ]; then case "$argument" in */worker-manifest.json) printf '%s' '{"schemaVersion":1,"filename":"worker.tgz","sha256":"${'0'.repeat(64)}","bytes":12}' > "$argument" ;; *) printf 'fake-tarball' > "$argument" ;; esac; fi`, 'previous="$argument"', 'done'])
  const tampered = run()
  assert.equal(tampered.status, 65)
  assert.match(tampered.stderr.toString(), /integrity verification failed/)
  assert.equal(lines().some(line => line.startsWith('npm ')), false)
  // Restore the valid download stub for registration and manual-install cases.
  stub('curl', [ `printf 'curl\\n' >> '${log}'`, "previous=''", "url=''", 'for argument in "$@"; do', `if [ "$previous" = '-o' ]; then case "$url" in */worker-manifest.json) printf '%s' '{"schemaVersion":1,"filename":"worker.tgz","sha256":"${fixtureHash}","bytes":12}' > "$argument" ;; *) printf 'fake-tarball' > "$argument" ;; esac; fi`, 'case "$argument" in http://*|https://*) url="$argument" ;; esac; previous="$argument"', 'done' ])

  writeFileSync(log, '')
  stub('wemux-lite-worker', [`[ "$1" = version ] && printf 'wemux-lite-worker 0.1.0\\n'`, `printf 'wemux-lite-worker %s\\n' "$*" >> '${log}'`, '[ "$1" != register ]'])
  const failed = run()
  assert.notEqual(failed.status, 0)
  assert.equal(lines().includes('wemux-lite-worker start'), false)
  assert.match(lines().at(-1) ?? '', /wemux-lite-worker register --server/)

  writeFileSync(log, '')
  stub('wemux-lite-worker', ['exit 1'])
  const shadowed = run()
  assert.equal(shadowed.status, 70)
  assert.match(shadowed.stderr.toString(), /missing or shadowed/)

  writeFileSync(log, '')
  const manual = run({ WEMUX_ENROLLMENT_TOKEN: '' })
  assert.equal(manual.status, 0)
  assert.match(manual.stdout.toString(), /wemux-lite-worker register/)
  assert.equal(lines().includes('curl'), true)
  assert.equal(lines().some(line => line.includes('register')), false)

  const missingName = run({ WEMUX_WORKER_NAME: '' })
  assert.equal(missingName.status, 64)
  assert.match(missingName.stderr.toString(), /WEMUX_WORKER_NAME is required/)

  // nc 模式：下载不经 curl，改由 node 经 tailscale nc 隧道取包，注册/启动带 --transport nc
  writeFileSync(log, '')
  stub('tailscale', [`printf 'tailscale %s\\n' "$*" >> '${log}'`])
  stub('node', [
    'case "$1" in -e) ;; *) exit 1 ;; esac',
    'case "$5" in',
    `*/worker-manifest.json) printf '%s' '{"schemaVersion":1,"filename":"worker.tgz","sha256":"${fixtureHash}","bytes":12}' > "$6" ;;`,
    `*/worker.tgz) printf 'fake-tarball' > "$6" ;;`,
    `*) exec "${process.execPath}" "$@" ;;`,
    'esac',
    `printf 'node tunnel %s:%s%s \\n' "$3" "$4" "$5" >> '${log}'`,
  ])
  stub('wemux-lite-worker', [`[ "$1" = version ] && printf 'wemux-lite-worker 0.1.0\\n'`, `printf 'wemux-lite-worker %s\\n' "$*" >> '${log}'`])
  const viaNc = run({ WEMUX_TRANSPORT: 'nc' })
  assert.equal(viaNc.status, 0, viaNc.stderr.toString())
  const ncLines = lines()
  assert.equal(ncLines.some(line => line.startsWith('npm install --global')), true)
  assert.equal(ncLines.some(line => /^wemux-lite-worker register .+ --transport nc$/.test(line)), true, JSON.stringify(ncLines))
  assert.equal(ncLines.includes('wemux-lite-worker start --transport nc'), true)
  assert.equal(ncLines.some(line => line.startsWith('curl')), false)
})

test('managed installer stages immutable releases, preserves identity and rolls back failed service starts', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-managed-installer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const packageBody = { value: 'package-v1' }
  const workerPackage = join(dir, 'worker.tgz')
  await writeFile(workerPackage, packageBody.value)
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail], workerPackagePath: workerPackage })
  const base = await app.listen(0)
  t.after(() => app.close())
  const script = join(dir, 'install.sh')
  await writeFile(script, await (await fetch(`${base}/downloads/install-worker.sh`)).text())
  const log = join(dir, 'calls.log')
  const stub = (name: string, lines: string[]) => {
    const path = join(dir, name)
    writeFileSync(path, ['#!/bin/sh', ...lines].join('\n') + '\n')
    chmodSync(path, 0o755)
  }
  stub('npm', [
    `printf 'npm %s\\n' "$*" >> '${log}'`,
    'prefix="$3"; mkdir -p "$prefix/node_modules/@wemux/worker/dist"',
    `printf '%s\\n' 'const fs=require("node:fs"); const path=require("node:path"); const args=process.argv.slice(2); if(args[0]==="version")console.log("wemux-lite-worker 0.1.0"); else if(args[0]==="register"){ const home=args[args.indexOf("--home")+1]; fs.mkdirSync(home,{recursive:true}); fs.writeFileSync(path.join(home,"credential"),"fixture",{mode:0o600}); fs.appendFileSync("${log}","register\\n") }' > "$prefix/node_modules/@wemux/worker/dist/cli.js"`,
  ])
  stub('systemctl', [
    `printf 'systemctl %s\\n' "$*" >> '${log}'`,
    'if [ "$2" = is-active ] && [ "${WEMUX_STUB_FAIL_ACTIVE:-0}" = 1 ]; then exit 1; fi',
    'if [ "$2" = enable ] && [ "${WEMUX_STUB_FAIL_ENABLE:-0}" = 1 ]; then exit 1; fi',
    'exit 0',
  ])
  const root = join(dir, 'managed')
  const home = join(dir, 'worker-home')
  const config = join(dir, 'config')
  const run = (extra: Record<string, string> = {}) => new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn('sh', [script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, XDG_CONFIG_HOME: config, WEMUX_INSTALL_ROOT: root, WEMUX_WORKER_HOME: home, WEMUX_SERVER_URL: base, WEMUX_ENROLLMENT_TOKEN: 'fixture-token', WEMUX_WORKER_NAME: 'Node one', ...extra } })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject).on('close', status => resolve({ status, stderr }))
  })
  const first = await run()
  assert.equal(first.status, 0, first.stderr)
  const release1 = readlinkSync(join(root, 'current'))
  assert.match(release1, /^releases\/[a-f0-9]{64}$/)
  const unit = readFileSync(join(config, 'systemd/user/wemux-lite-worker.service'), 'utf8')
  assert.match(unit, /ExecStart=.*current\/node_modules\/@wemux\/worker\/dist\/cli.js.*start --home/)
  const unitFile = join(config, 'systemd/user/wemux-lite-worker.service')
  const verify = spawnSync('systemd-analyze', ['verify', unitFile], { encoding: 'utf8' })
  assert.equal(verify.status, 0, verify.stderr)
  assert.doesNotMatch(verify.stderr, /Unknown lvalue|Failed to parse|not an absolute path|unbalanced quoting/)
  assert.ok(readFileSync(log, 'utf8').includes('register\n'))
  const repeat = await run({ WEMUX_ENROLLMENT_TOKEN: '' })
  assert.equal(repeat.status, 0, repeat.stderr)
  assert.equal(readFileSync(log, 'utf8').split('register\n').length - 1, 1, 'upgrade never re-enrolls a registered identity')
  await writeFile(workerPackage, 'package-v2')
  const enableFailure = await run({ WEMUX_STUB_FAIL_ENABLE: '1', WEMUX_ENROLLMENT_TOKEN: '' })
  assert.notEqual(enableFailure.status, 0, 'a service enable failure must not report success')
  assert.equal(readlinkSync(join(root, 'current')), release1, 'enable failure restores previous release')
  assert.equal(readFileSync(unitFile, 'utf8'), unit)
  const broken = await run({ WEMUX_STUB_FAIL_ACTIVE: '1', WEMUX_ENROLLMENT_TOKEN: '' })
  assert.equal(broken.status, 70, broken.stderr)
  assert.equal(readlinkSync(join(root, 'current')), release1, 'service health failure restores previous release')
  assert.equal(readFileSync(unitFile, 'utf8'), unit, 'rollback restores the service unit')
  assert.ok(readFileSync(log, 'utf8').includes('systemctl --user restart wemux-lite-worker.service'), 'rollback restarts the previous release')

  // Exercise the Darwin branch on Linux with a launchctl stub. The plist must
  // encode arguments separately, preserve the release pointer and roll back.
  stub('uname', ['printf "Darwin\\n"'])
  stub('launchctl', [
    `printf 'launchctl %s\\n' "$*" >> '${log}'`,
    'if [ "$1" = bootstrap ] && [ "${WEMUX_STUB_FAIL_BOOTSTRAP:-0}" = 1 ]; then exit 1; fi',
    'if [ "$1" = bootout ]; then rm -f "${WEMUX_INSTALL_ROOT}/.stub-launchd-loaded"; fi',
    'if [ "$1" = bootstrap ]; then touch "${WEMUX_INSTALL_ROOT}/.stub-launchd-loaded"; fi',
    'if [ "$1" = print ] && [ "$2" != gui/$(id -u) ]; then',
    '  if [ ! -f "${WEMUX_INSTALL_ROOT}/.stub-launchd-loaded" ]; then exit 113; fi',
    '  if [ "${WEMUX_STUB_FAIL_ACTIVE:-0}" = 1 ]; then exit 1; fi',
    `  printf '    pid = %s\\n' '${process.pid}'`,
    'fi',
    'exit 0',
  ])
  const macConfig = join(dir, 'Library/LaunchAgents')
  const macUnit = join(macConfig, 'com.wemux.lite.worker.plist')
  const firstMac = await run({ WEMUX_INSTALL_ROOT: join(dir, 'mac-managed'), WEMUX_WORKER_HOME: join(dir, 'mac-home') })
  assert.equal(firstMac.status, 0, firstMac.stderr)
  const macRoot = join(dir, 'mac-managed')
  const macRelease = readlinkSync(join(macRoot, 'current'))
  const plist = readFileSync(macUnit, 'utf8')
  assert.match(plist, /<key>Label<\/key><string>com\.wemux\.lite\.worker<\/string>/)
  assert.match(plist, /<key>ProgramArguments<\/key><array>/)
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/)
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(plist, /mac-managed\/current\/node_modules\/@wemux\/worker\/dist\/cli\.js/)
  const oldRegisters = readFileSync(log, 'utf8').split('register\n').length
  const repeatMac = await run({ WEMUX_INSTALL_ROOT: macRoot, WEMUX_WORKER_HOME: join(dir, 'mac-home'), WEMUX_ENROLLMENT_TOKEN: '' })
  assert.equal(repeatMac.status, 0, repeatMac.stderr)
  assert.equal(readFileSync(log, 'utf8').split('register\n').length, oldRegisters)
  await writeFile(workerPackage, 'package-v3')
  const macFailure = await run({ WEMUX_INSTALL_ROOT: macRoot, WEMUX_WORKER_HOME: join(dir, 'mac-home'), WEMUX_ENROLLMENT_TOKEN: '', WEMUX_STUB_FAIL_BOOTSTRAP: '1' })
  assert.notEqual(macFailure.status, 0)
  assert.equal(readlinkSync(join(macRoot, 'current')), macRelease, 'failed launchd bootstrap restores previous release')
  assert.equal(readFileSync(macUnit, 'utf8'), plist, 'failed launchd bootstrap restores prior plist')
  const macCrash = await run({ WEMUX_INSTALL_ROOT: macRoot, WEMUX_WORKER_HOME: join(dir, 'mac-home'), WEMUX_ENROLLMENT_TOKEN: '', WEMUX_STUB_FAIL_ACTIVE: '1' })
  assert.equal(macCrash.status, 70, 'a loaded job without a live PID cannot pass health check')
  assert.equal(readlinkSync(join(macRoot, 'current')), macRelease)
  assert.equal(readFileSync(macUnit, 'utf8'), plist)
  const foreignPlist = plist.replace('com.wemux.lite.worker</string>', 'com.other.worker</string>')
  await writeFile(macUnit, foreignPlist)
  const beforeConflict = readFileSync(log, 'utf8')
  const conflict = await run({ WEMUX_INSTALL_ROOT: macRoot, WEMUX_WORKER_HOME: join(dir, 'mac-home'), WEMUX_ENROLLMENT_TOKEN: '' })
  assert.equal(conflict.status, 70)
  assert.match(conflict.stderr, /belongs to another installation/)
  assert.equal(readFileSync(macUnit, 'utf8'), foreignPlist)
  assert.equal(readlinkSync(join(macRoot, 'current')), macRelease)
  assert.equal(readFileSync(log, 'utf8').slice(beforeConflict.length).includes('launchctl bootout'), false, 'never unload a foreign job')
})

test('管理员登录会话持久化在服务端，并随空闲过期失效', async () => {
  // 用真实时钟而不用日期桩：窗口留出 CI 调度余量，过期后再真等待，避免登录后的默认环境初始化耗掉整个 TTL。
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail], adminSessionTtlMs: 250 })
  const password = 'correct horse battery staple'
  await seedLocalAccount(app.store, { username: 'owner', email: administratorEmail, password, administrator: true })
  const base = await app.listen(0)
  try {
    // 浏览器登录：会话令牌只以 HttpOnly Cookie 形式送达，响应体里没有令牌。
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'owner', password }) })
    assert.equal(login.status, 200, JSON.stringify(await login.clone().json()))
    const cookie = login.headers.getSetCookie().find(value => value.startsWith('wemux_login_session='))!.split(';')[0]!
    const account = await login.json() as { teamId: string; expiresAt: string; instanceAdministrator: boolean; token?: string }
    assert.equal(account.token, undefined, '代理令牌不再下发给浏览器')
    assert.equal(account.instanceAdministrator, true)
    assert.equal(typeof account.teamId, 'string')
    assert.equal(typeof account.expiresAt, 'string')
    assert.equal((await fetch(`${base}/workers`, { headers: { cookie } })).status, 200)
    await delay(320)
    assert.equal((await fetch(`${base}/workers`, { headers: { cookie } })).status, 401, '空闲过期后会话立即失效')
    assert.equal((await fetch(`${base}/auth/me`, { headers: { cookie } })).status, 401)
  } finally { await app.close() }
})

test('the test after admin session expiry has the real clock (no filesystem)', async () => {
  assert.equal(Date.now, realDateNow)
  const before = Date.now()
  await delay(5)
  assert.ok(Date.now() > before)
  assert.ok(Math.abs(Date.now() - new Date().getTime()) < 1000)
})

test('a new connection replaces the old socket without marking the worker offline', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const { token } = await seedAdministrator(app.store)
  const base = await app.listen(0)
  t.after(() => app.close())
  const request = async (path: string, method = 'GET', body?: unknown, bearer: string | null = token) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  await request('/bootstrap', 'POST', {})
  const enrollment = (await request('/enrollment-tokens', 'POST', {})).data
  const enrolled = await request('/workers/enroll', 'POST', { token: enrollment.token, name: 'Replaceable' }, null)
  assert.equal(enrolled.status, 201)
  const { workerId, credential } = enrolled.data
  const connect = async () => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/worker/ws', { headers: { Authorization: `Bearer ${credential}` } })
    await once(ws, 'open')
    const peer = new TransportV2Peer(ws, workerId)
    await peer.connect({ name: 'Replaceable' })
    return peer
  }

  const first = await connect()
  const firstClosed = once(first.ws, 'close')
  const second = await connect()
  await firstClosed
  await delay(50)
  const workers = await request('/workers')
  assert.equal(workers.data.items[0].connectionState, 'online')
  second.send({ type: 'heartbeat', nonce: 'replacement-alive', sentAt: new Date().toISOString() })
  await second.wait(message => message.type === 'heartbeat' && message.nonce === 'replacement-alive')
  await second.close()
})

test('HTTP + SQLite + Worker WS + SSE durable end-to-end loop', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-lite-server-')), databasePath = join(dir, 'server.sqlite')
  let app = createWemuxServer({ databasePath, administratorEmails: [administratorEmail] }), base = await app.listen(0)
  const { token } = await seedAdministrator(app.store)
  const peers: TransportV2Peer[] = []
  t.after(async () => { for (const p of peers) await p.close(); await app.close(); await rm(dir, { recursive: true, force: true }) })
  async function request(path: string, method = 'GET', body?: unknown, bearer: string | null = token) {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  async function connect(workerId: string, credential: string) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/worker/ws', { headers: { Authorization: `Bearer ${credential}` } })
    const p = new TransportV2Peer(ws, workerId); peers.push(p)
    await p.connect({ name: 'Test worker' })
    return p
  }
  assert.equal((await request('/health', 'GET', undefined, null)).status, 200)
  assert.equal((await request('/projects', 'GET', undefined, null)).status, 401)
  assert.equal((await request('/bootstrap', 'POST', {}, 'wrong')).status, 401)
  const bootstrap = await request('/bootstrap', 'POST', {})
  assert.equal(bootstrap.status, 200)
  assert.deepEqual((await request('/bootstrap', 'POST', {})).data, bootstrap.data)
  const enrollment = (await request('/enrollment-tokens', 'POST', {})).data
  const enrolled = await request('/workers/enroll', 'POST', { token: enrollment.token, name: 'Test' }, null)
  assert.equal(enrolled.status, 201)
  const { workerId, credential } = enrolled.data
  assert.equal((await request('/workers/enroll', 'POST', { token: enrollment.token, name: 'Replay' }, null)).status, 401)
  assert.equal((await request('/workers', 'GET', undefined, credential)).status, 401)
  const project = (await request('/projects', 'POST', { name: 'Integration' })).data
  const emptyProvision = await request('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Blank', source: 'empty' })
  assert.equal(emptyProvision.status, 201)
  assert.deepEqual(emptyProvision.data.workspace.spec, { kind: 'composite', memberWorkspaceIds: [] })
  const emptyWorkspace = emptyProvision.data.workspace

  const provision = await request('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Repo', repository: { gitUrl: 'https://example.com/repo.git', revision: 'main' } })
  assert.equal(provision.status, 201)
  const workspace = provision.data.workspace
  assert.equal((await request('/sessions', 'POST', { workspaceId: workspace.id, title: 'Chat', agentKey: 'pi', modelId: 'test-model' })).status, 409)
  let peer = await connect(workerId, credential)
  const emptyCommand = await peer.wait(m => m.type === 'command' && m.commandId === emptyProvision.data.commandId)
  if (emptyCommand.type === 'command' && emptyCommand.command.kind === 'workspace.provision') assert.deepEqual(emptyCommand.command.workspace.repositories, [])
  else assert.fail('expected empty workspace provision command')
  peer.send({ type: 'ack', receipt: { commandId: emptyProvision.data.commandId, status: 'accepted' } })
  peer.send({ type: 'event', scope: 'workspace', report: { workspaceId: emptyWorkspace.id, status: 'ready', reason: null, location: { workspaceId: emptyWorkspace.id, workerId, rootPath: '/tmp/blank', checkouts: [] }, occurredAt: new Date().toISOString() } })
  await eventually(async () => (await request(`/workspaces/${emptyWorkspace.id}`)).data.status === 'ready')
  const command = await peer.wait(m => m.type === 'command' && m.commandId === provision.data.commandId)
  assert.equal(command.type, 'command')
  if (command.type === 'command') {
    assert.equal(command.command.kind, 'workspace.provision')
    assert.equal(JSON.stringify(command).includes('rootPath'), false)
  }
  peer.send({ type: 'ack', receipt: { commandId: provision.data.commandId, status: 'accepted' } })
  peer.send({ type: 'capability', workerId, detectedAt: new Date().toISOString(), capabilities: [capability] })
  peer.send({ type: 'event', scope: 'workspace', report: { workspaceId: workspace.id, status: 'ready', reason: null, location: null, occurredAt: new Date().toISOString() } })
  await eventually(async () => (await request(`/workspaces/${workspace.id}`)).data.status === 'ready')
  assert.equal((await request(`/workers/${workerId}/capabilities`)).data.capabilities[0].agentKey, 'pi')
  peer.send({ type: 'heartbeat', nonce: 'ping', sentAt: new Date().toISOString() })
  await peer.wait(m => m.type === 'heartbeat' && m.nonce === 'ping')
  const createBody = { requestId: 'standalone-create', workspaceId: workspace.id, title: 'Chat', agentKey: 'pi', modelId: 'test-model' }
  const created = await request('/sessions', 'POST', createBody)
  assert.equal(created.status, 201)
  const replayedCreate = await request('/sessions', 'POST', createBody)
  assert.equal(replayedCreate.status, 201)
  assert.equal(replayedCreate.data.session.id, created.data.session.id)
  assert.equal(replayedCreate.data.commandId, created.data.commandId)
  assert.equal((await request('/sessions', 'POST', { ...createBody, title: 'Different' })).status, 409)
  assert.equal(created.data.session.storageMode, 'local')
  assert.equal(replayedCreate.data.session.storageMode, 'local')
  assert.equal((await request('/sessions', 'POST', { ...createBody, storageMode: 'local' })).data.session.id, created.data.session.id, '显式 local 与旧请求指纹兼容')
  assert.equal((await request('/sessions', 'POST', { ...createBody, requestId: 'unsupported-storage', storageMode: 'replicated' })).status, 409)
  assert.equal((await request('/sessions', 'POST', { ...createBody, requestId: 'unknown-storage', storageMode: 'mystery' })).status, 409)
  const unsupportedMode = await request('/sessions', 'POST', { ...createBody, requestId: 'unsupported-storage-error', storageMode: 'central' })
  assert.equal(unsupportedMode.status, 409)
  assert.equal(unsupportedMode.data.error.code, 'storage_mode_unavailable')
  assert.equal((await request(`/sessions/${created.data.session.id}`)).data.storageMode, 'local')
  assert.equal((await request('/sessions')).data.items.find((item: { id: string }) => item.id === created.data.session.id)?.storageMode, 'local')
  const session = created.data.session
  await peer.wait(m => m.type === 'command' && m.commandId === created.data.commandId)
  peer.send({ type: 'ack', receipt: { commandId: created.data.commandId, status: 'accepted' } })
  // Regression: omitted modelId must resolve to the Agent default on the Session binding
  const defaultModelCreate = await request('/sessions', 'POST', { requestId: 'default-model-create', workspaceId: workspace.id, title: 'Default model', agentKey: 'pi' })
  assert.equal(defaultModelCreate.status, 201)
  assert.equal(defaultModelCreate.data.session.binding.modelId, 'test-model')
  const defaultModelCommand = await peer.wait(m => m.type === 'command' && m.commandId === defaultModelCreate.data.commandId)
  if (defaultModelCommand.type === 'command' && defaultModelCommand.command.kind === 'session.create') {
    assert.equal(defaultModelCommand.command.session.binding.modelId, 'test-model')
    assert.equal(defaultModelCommand.command.session.storageMode, 'local')
  }
  else assert.fail('expected session.create command')
  peer.send({ type: 'ack', receipt: { commandId: defaultModelCreate.data.commandId, status: 'accepted' } })
  const assets = await request(`/projects/${project.id}/capability-assets`, 'PUT', { items: [
    { kind: 'instruction', name: 'team-rules', content: 'Always report test results.' },
    { kind: 'prompt', name: 'review', content: 'Review this change.' },
    { kind: 'skill', name: 'summarize', content: '# Summarize\nSummarize the current work.' },
  ] })
  assert.equal(assets.status, 200)
  assert.equal((await request(`/projects/${project.id}/capability-assets`)).data.items.length, 3)
  const enqueued = await request(`/sessions/${session.id}/messages`, 'POST', { commandId: 'stable-command', content: 'hello' })
  assert.equal(enqueued.status, 202)
  const repeated = await request(`/sessions/${session.id}/messages`, 'POST', { commandId: 'stable-command', content: 'hello' })
  assert.equal(repeated.status, 202, JSON.stringify(repeated.data))
  assert.equal((await request(`/sessions/${session.id}/messages`, 'POST', { commandId: 'stable-command', content: 'changed' })).status, 409)
  const enqueueCommand = await peer.wait(m => m.type === 'command' && m.commandId === 'stable-command')
  assert.equal(enqueueCommand.type, 'command')
  if (enqueueCommand.type !== 'command' || enqueueCommand.command.kind !== 'session.enqueue' || !enqueueCommand.command.capabilities) assert.fail('Expected capability launch contract')
  assert.equal(enqueueCommand.command.capabilities.snapshot.assets.length, 3)
  const capabilityInfo = await fetch(`${base}/agent-capabilities/session.info`, { method: 'POST', headers: { Authorization: `Bearer ${enqueueCommand.command.capabilities.token}`, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(capabilityInfo.status, 200)
  assert.equal((await capabilityInfo.json() as any).sessionId, session.id)
  const forbidden = await fetch(`${base}/agent-capabilities/agent.send`, { method: 'POST', headers: { Authorization: `Bearer ${enqueueCommand.command.capabilities.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ toAgentId: 'missing', content: 'hello', idempotencyKey: 'one' }) })
  assert.equal(forbidden.status, 404)
  peer.send({ type: 'ack', receipt: { commandId: 'stable-command', status: 'accepted' } })
  await eventually(async () => (await request('/commands/stable-command')).data.status === 'accepted')
  const event = (seq: number) => ({ sessionId: session.id, seq, occurredAt: '2026-01-01T00:00:00.000Z', payload: { kind: 'assistant.text.delta', turnId: 'turn-1', text: `delta-${seq}` } })
  peer.send({ type: 'event', scope: 'session', event: event(2) })
  await peer.wait(m => m.type === 'sync' && m.fromSeq === 1)
  const gap = (await request(`/sessions/${session.id}/events`)).data
  assert.equal(gap.freshness.status, 'gap'); assert.deepEqual(gap.events, [])
  peer.send({ type: 'sync', kind: 'batch', sessionId: session.id, throughSeq: 2, hasMore: false, events: [event(1), event(2)] })
  await eventually(async () => (await request(`/sessions/${session.id}/events`)).data.freshness.status === 'synced')
  peer.send({ type: 'event', scope: 'session', event: event(2) })
  const page = (await request(`/sessions/${session.id}/events?limit=1`)).data
  assert.equal(page.events.length, 1); assert.equal(page.nextSeq, 2)
  const controller = new AbortController()
  const stream = await fetch(`${base}/sessions/${session.id}/stream`, { headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': '1' }, signal: controller.signal })
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  const reader = stream.body!.getReader()
  let streamText = ''
  async function readUntil(needle: string) {
    while (!streamText.includes(needle)) {
      const result = await reader.read(); assert.equal(result.done, false)
      streamText += new TextDecoder().decode(result.value)
    }
  }
  await readUntil('id: 2\n')
  assert.equal(streamText.includes('id: 1\n'), false)
  peer.send({ type: 'event', scope: 'session', event: event(3) })
  await readUntil('id: 3\n')
  controller.abort(); await reader.cancel().catch(() => undefined)
  await peer.close()
  await eventually(async () => (await request('/workers')).data.items[0].connectionState === 'offline')
  assert.equal((await request(`/sessions/${session.id}/events`)).data.freshness.status, 'offline')
  assert.equal((await request(`/sessions/${session.id}/messages`, 'POST', { content: 'reject\0before-persist' })).status, 400)
  const offline = await request(`/sessions/${session.id}/messages`, 'POST', { content: 'persist across restart' })
  await app.close()
  app = createWemuxServer({ databasePath, administratorEmails: [administratorEmail] }); base = await app.listen(0)
  peer = await connect(workerId, credential)
  await peer.wait(m => m.type === 'command' && m.commandId === offline.data.commandId)
  assert.equal(peer.messages.some(m => m.type === 'command' && m.commandId === 'stable-command'), false)
  peer.send({ type: 'sync', kind: 'heads', complete: true, heads: [{ sessionId: session.id, lastSeq: 4 }] })
  await peer.wait(m => m.type === 'sync' && m.fromSeq === 4)
  peer.send({ type: 'sync', kind: 'batch', sessionId: session.id, throughSeq: 4, hasMore: false, events: [event(4)] })
  await eventually(async () => (await request(`/sessions/${session.id}/events`)).data.events.length === 4)
  assert.equal((await request(`/sessions/${session.id}/events`)).data.freshness.status, 'synced')
  assert.equal((await request(`/sessions/${session.id}`, 'PATCH', { title: 'Renamed' })).data.title, 'Renamed')
  assert.equal((await request(`/workspaces/${workspace.id}`, 'DELETE')).status, 501)
  // A durable enqueue not yet observed in Journal is not idle.
  assert.equal((await request(`/sessions/${session.id}`, 'DELETE')).status, 409)
  assert.equal((await request(`/sessions/${session.id}/events`)).status, 200)
  assert.equal((await request(`/workspaces/${workspace.id}`, 'DELETE')).status, 501)
  assert.equal((await request(`/projects/${project.id}`, 'DELETE')).status, 409)
  assert.equal((await request('/sessions')).data.items.length, 2)
  const db = new DatabaseSync(databasePath)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()!.count, migrationCount)
  const records = db.prepare('SELECT data FROM records').all().map(r => String(r.data)).join('\n')
  assert.equal(records.includes(credential), false); assert.equal(records.includes(enrollment.token), false)
  db.close()
})

test('reject unauthorized, malformed and cross-worker protocol writes; atomic enrollment', { timeout: 10000 }, async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] }), base = await app.listen(0)
  const { token } = await seedAdministrator(app.store)
  t.after(() => app.close())
  async function post(path: string, data: unknown) {
    const r = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    return { status: r.status, data: await r.json() }
  }
  await post('/bootstrap', {})
  const enrollment = (await post('/enrollment-tokens', {})).data
  const attempts = await Promise.all([post('/workers/enroll', { token: enrollment.token, name: 'One' }), post('/workers/enroll', { token: enrollment.token, name: 'Two' })])
  assert.deepEqual(attempts.map(r => r.status).sort(), [201, 401])
  const first = attempts.find(r => r.status === 201)!.data
  const secondToken = (await post('/enrollment-tokens', {})).data.token
  const second = (await post('/workers/enroll', { token: secondToken, name: 'Other' })).data
  const rejected = new WebSocket(base.replace('http:', 'ws:') + '/worker/ws', { headers: { Authorization: 'Bearer bad' } })
  const unauthorized = await new Promise<number>(resolve => {
    rejected.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.resume(); rejected.terminate() })
    rejected.on('error', () => undefined)
  })
  assert.equal(unauthorized, 401)
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/worker/ws', { headers: { Authorization: `Bearer ${first.credential}` } })
  // 关闭监听得先挂上：服务器可能在握手拒绝后很快关闭，错过事件会让断言永远等下去（假超时）。
  const closed = once(ws, 'close')
  const peer = new TransportV2Peer(ws, second.workerId)
  await peer.connect({ name: 'Spoof', workerVersion: '1' }).catch(() => undefined)
  assert.ok(peer.frames.some(frame => frame.frameType === 'transport.error'), '冒充其他 Worker 身份必须收到传输层错误')
  await closed
  await peer.close()
  const malformed = await fetch(base + '/projects', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{' })
  assert.equal(malformed.status, 400)
  assert.equal((await post('/enrollment-tokens', { ttlSeconds: -1 })).status, 400)
})
