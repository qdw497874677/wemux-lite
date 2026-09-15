import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test, type TestContext } from 'node:test'
import { config } from '../src/config.js'
import { agentsForHome } from '../src/agents/detection.js'
import { agentCommand, agentSelections, readAgentSettings } from '../src/config/agent-settings.js'
import { installAgent, installCatalog, runRuntimeProcess, useAgent, type ProcessRequest, type RuntimeProcess } from '../src/runtimes/management.js'

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'wemux-runtimes-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}
async function executable(path: string) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '#!/usr/bin/env node\nconsole.log("1.0.0")\n', { mode: 0o755 })
}
function installer(calls: ProcessRequest[], fail?: 'npm' | 'version' | 'manifest'): RuntimeProcess {
  return async request => {
    calls.push(request)
    if (request.command !== 'npm') {
      if (fail === 'version') throw new Error('version timed out')
      return '1.0.0'
    }
    if (fail === 'npm') throw new Error('npm timed out')
    const spec = request.args.at(-1) === '@earendil-works/pi-coding-agent@0.85.1' ? installCatalog.pi : installCatalog['claude-code']
    const root = join(request.args[request.args.indexOf('--prefix') + 1], 'node_modules', spec.name)
    await executable(join(root, spec.bin))
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: spec.name, version: fail === 'manifest' ? '0.0.0' : spec.version, bin: { [spec === installCatalog.pi ? 'pi' : 'claude']: spec.bin } }))
    return ''
  }
}

test('CLI opt-in is explicit; aliases work; arbitrary packages and unsupported installs are rejected before spawn', async t => {
  const home = await fixture(t)
  assert.equal(config(['agent', 'install', 'pi'], {}).yes, false)
  assert.equal(config(['agent', 'install', 'claude', '--yes'], {}).yes, true)
  let count = 0
  const run: RuntimeProcess = async () => { count++; return '' }
  await assert.rejects(installAgent(home, 'pi', false, run), /--yes/)
  await assert.rejects(installAgent(home, '@evil/pkg', true, run), /Agent 可选/)
  await assert.rejects(installAgent(home, 'codex', true, run), /暂不支持/)
  assert.equal(count, 0)
  assert.deepEqual(await readdir(home), [])
})

test('absolute path reuse probes only the executable, persists across reload, never installs', async t => {
  const home = await fixture(t)
  const path = join(home, 'user install', 'claude')
  await executable(path)
  const calls: ProcessRequest[] = []
  await useAgent(home, 'claude', path, async request => { calls.push(request); return '2.0.0' })
  assert.deepEqual(calls, [{ command: path, args: ['--version'], timeout: 10_000 }])
  const settings = await readAgentSettings(home)
  assert.equal(agentCommand('claude-code', settings, { WEMUX_CLAUDE_COMMAND: '/other' }), path)
  assert.equal(agentSelections(settings, {})[1].source, 'local')
  await assert.rejects(useAgent(home, 'pi', 'pi --version'), /绝对路径/)
  await assert.rejects(useAgent(home, 'pi', home), /不是文件/)
  await assert.rejects(useAgent(home, 'pi', join(home, 'missing')), /ENOENT/)
  assert.equal((await readAgentSettings(home))['claude-code']?.executable, path)
})

for (const key of ['pi', 'claude'] as const) test(`managed ${key} install uses exact non-global npm args, validates and persists provenance`, async t => {
  const home = await fixture(t)
  const calls: ProcessRequest[] = []
  const result = await installAgent(home, key, true, installer(calls))
  const prefix = calls[0].cwd!
  const spec = key === 'pi' ? '@earendil-works/pi-coding-agent@0.85.1' : '@anthropic-ai/claude-code@2.1.34'
  assert.deepEqual(calls[0], { command: 'npm', args: ['install', '--global=false', '--prefix', prefix, '--no-save', '--package-lock=false', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--', spec], cwd: prefix, env: calls[0].env, timeout: 300_000 })
  assert.ok(prefix.startsWith(join(home, 'agents', result.key)))
  assert.deepEqual(calls[1], { command: result.executable, args: ['--version'], timeout: 10_000 })
  assert.equal((await readAgentSettings(home))[result.key]?.package, spec)
  assert.equal((await readAgentSettings(home))[result.key]?.source, 'managed')
  assert.match(result.message, /重启/)
})

for (const failure of ['npm', 'version', 'manifest'] as const) test(`${failure} failure preserves prior selection and removes only failed prefix`, async t => {
  const home = await fixture(t)
  const path = join(home, 'user-pi')
  await executable(path)
  await useAgent(home, 'pi', path, async () => '1')
  const before = await readFile(join(home, 'agents.json'), 'utf8')
  await assert.rejects(installAgent(home, 'pi', true, installer([], failure)))
  assert.equal(await readFile(join(home, 'agents.json'), 'utf8'), before)
  assert.deepEqual(await readdir(join(home, 'agents', 'pi')), [])
  assert.match(await readFile(path, 'utf8'), /console.log/)
  await assert.rejects(useAgent(home, 'pi', path, async () => { throw new Error('timeout') }), /timeout/)
  assert.equal(await readFile(join(home, 'agents.json'), 'utf8'), before)
})

test('reinstall uses a new prefix without changing old managed files; selections merge', async t => {
  const home = await fixture(t)
  const first = await installAgent(home, 'pi', true, installer([]))
  await installAgent(home, 'claude', true, installer([]))
  const second = await installAgent(home, 'pi', true, installer([]))
  assert.notEqual(first.executable, second.executable)
  assert.match(await readFile(first.executable, 'utf8'), /console.log/)
  assert.equal(Object.keys(await readAgentSettings(home)).length, 2)
})

test('managed npm resolves only official registries offline despite inherited scope and config overrides', async t => {
  const home = await fixture(t)
  const hostile = join(home, 'hostile.npmrc')
  await writeFile(hostile, 'registry=https://evil.invalid/\n@anthropic-ai:registry=https://evil.invalid/\n@earendil-works:registry=https://evil.invalid/\n@other:registry=https://evil.invalid/\n')
  const overrides = {
    NPM_CONFIG_USERCONFIG: hostile,
    npm_config_globalconfig: hostile,
    'npm_config_@anthropic-ai:registry': 'https://evil.invalid/',
    'NPM_CONFIG_@earendil-works:registry': 'https://evil.invalid/',
    npm_config_registry: 'https://evil.invalid/',
    npm_config_cache: join(home, 'untrusted-cache'),
    npm_config_https_proxy: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:10',
    NO_PROXY: 'localhost',
  }
  const original = { ...process.env }
  t.after(() => { process.env = original })
  Object.assign(process.env, overrides)
  const calls: ProcessRequest[] = []
  await installAgent(home, 'claude', true, async request => {
    if (request.command === 'npm') {
      assert.notEqual(request.env?.npm_config_userconfig, hostile)
      assert.notEqual(request.env?.npm_config_globalconfig, hostile)
      assert.equal(request.env?.npm_config_cache, undefined)
      assert.equal(request.env?.npm_config_https_proxy, overrides.npm_config_https_proxy)
      assert.equal(request.env?.HTTPS_PROXY, overrides.HTTPS_PROXY)
      assert.equal(request.env?.NO_PROXY, overrides.NO_PROXY)
      // Exercise npm's real config loader, without fetching or installing packages.
      const resolved = JSON.parse(await runRuntimeProcess({ ...request, args: ['config', 'list', '--json', '--registry=https://registry.npmjs.org', '--prefix', request.cwd!], timeout: 10_000 }))
      assert.equal(resolved.registry.replace(/\/$/, ''), 'https://registry.npmjs.org')
      for (const scope of ['@anthropic-ai', '@earendil-works', '@other']) assert.equal(resolved[`${scope}:registry`], undefined)
      assert.equal(resolved['https-proxy'], overrides.npm_config_https_proxy)
    }
    return installer(calls)(request)
  })
})

test('real process runner passes literal args, rejects nonzero exit and terminates on timeout', async () => {
  const literal = 'x; echo injected'
  assert.equal(await runRuntimeProcess({ command: process.execPath, args: ['-e', 'console.log(process.argv[1])', literal], timeout: 2000 }), literal)
  await assert.rejects(runRuntimeProcess({ command: '/nonexistent-wemux-runtime', args: [], timeout: 2000 }), { code: 'ENOENT' })
  await assert.rejects(runRuntimeProcess({ command: process.execPath, args: ['-e', 'process.exit(7)'], timeout: 2000 }), { code: 7 })
  await assert.rejects(runRuntimeProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeout: 100 }), { killed: true })
})

for (const mode of ['timeout', 'parent-exit', 'stdout', 'stderr'] as const) test(`process group ${mode} failure kills child/grandchild with inherited stdio and preserves selection`, { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
  const home = await fixture(t)
  const path = join(home, 'prior-pi')
  await executable(path)
  await useAgent(home, 'pi', path, async () => '1')
  const before = await readFile(join(home, 'agents.json'), 'utf8')
  const pids = join(home, 'pids')
  const ready = join(home, 'ready')
  const grandchild = `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `
  const child = `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio: 'inherit'});
    setInterval(() => {}, 1000);
  `
  const parent = `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio: 'inherit'});
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(ready)})) return;
      clearInterval(timer);
      if (${JSON.stringify(mode)} === 'parent-exit') process.exit(0);
      if (['stdout', 'stderr'].includes(${JSON.stringify(mode)})) process[${JSON.stringify(mode)}].write(Buffer.alloc(2 * 1024 * 1024));
    }, 10);
    setInterval(() => {}, 1000);
  `
  t.after(async () => {
    const ids = (await readFile(pids, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number)
    for (const pid of ids) { try { process.kill(pid, 'SIGKILL') } catch {} }
  })
  const start = Date.now()
  await assert.rejects(installAgent(home, 'pi', true, request => runRuntimeProcess({ ...request, command: process.execPath, args: ['-e', parent], timeout: 2000 })), {
    code: mode === 'stdout' || mode === 'stderr' ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : 'ETIMEDOUT',
    killed: true,
  })
  assert.ok(Date.now() - start < 5000, 'failure cleanup must be bounded even with inherited pipes')
  const ids = (await readFile(pids, 'utf8')).trim().split('\n').map(Number)
  assert.equal(ids.length, 3, 'parent, child and grandchild all started')
  const stopped = async (pid: number) => {
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
    // Orphans may remain as zombies until the host init reaps them.
    const result = await promisify(execFile)('ps', ['-o', 'stat=', '-p', String(pid)]).catch(() => ({ stdout: '' }))
    return !result.stdout.trim() || result.stdout.trim().startsWith('Z')
  }
  for (const pid of ids) {
    for (let attempt = 0; attempt < 50 && !(await stopped(pid)); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(await stopped(pid), `process ${pid} must no longer be running`)
  }
  assert.equal(await readFile(join(home, 'agents.json'), 'utf8'), before)
  assert.deepEqual(await readdir(join(home, 'agents', 'pi')), [])
  assert.match(await readFile(path, 'utf8'), /console.log/)
})

test('future detection uses saved paths and reports missing selections without throwing', async t => {
  const home = await fixture(t)
  const path = join(home, 'my-codex')
  await executable(path)
  await useAgent(home, 'codex', path)
  let agents = await agentsForHome(home)
  assert.equal((await agents.find(agent => agent.agentKey === 'codex')!.detect()).executablePath, path)
  await rm(path)
  agents = await agentsForHome(home)
  const detections = await Promise.all(agents.filter(agent => agent.agentKey === 'codex').map(agent => agent.detect()))
  assert.equal(detections[0].availability.status, 'unavailable')
})

test('CLI runs mock npm as a real child with literal fixed args and selects its validated executable', async t => {
  const home = await fixture(t)
  const bin = join(home, 'bin')
  await mkdir(bin)
  const log = join(home, 'npm-args.json')
  await writeFile(join(bin, 'npm'), `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
const prefix = args[args.indexOf('--prefix') + 1];
const root = path.join(prefix, 'node_modules/@anthropic-ai/claude-code'); fs.mkdirSync(root, {recursive:true});
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name:'@anthropic-ai/claude-code',version:'2.1.34',bin:{claude:'cli.js'}}));
fs.writeFileSync(path.join(root, 'cli.js'), '#!${process.execPath}\\nconsole.log("2.1.34")\\n', {mode:0o755});
`, { mode: 0o755 })
  const exec = promisify(execFile)
  const result = await exec(process.execPath, ['--import', 'tsx', new URL('../src/cli.ts', import.meta.url).pathname, 'agent', 'install', 'claude', '--yes', '--home', home], { env: { ...process.env, PATH: bin } })
  assert.match(result.stderr, /registry.npmjs.org/)
  const output = JSON.parse(result.stdout)
  const args = JSON.parse(await readFile(log, 'utf8'))
  assert.equal(args.at(-1), '@anthropic-ai/claude-code@2.1.34')
  assert.equal(args[1], '--global=false')
  assert.equal(output.version, '2.1.34')
  assert.equal((await readAgentSettings(home))['claude-code']?.executable, output.executable)
})

test('CLI installation without --yes does not launch npm or create a database', async t => {
  const home = await fixture(t)
  const exec = promisify(execFile)
  await assert.rejects(exec(process.execPath, ['--import', 'tsx', new URL('../src/cli.ts', import.meta.url).pathname, 'agent', 'install', 'pi', '--home', home]), error => {
    assert.match((error as { stderr: string }).stderr, /--yes/)
    return true
  })
  assert.deepEqual(await readdir(home), [])
})
