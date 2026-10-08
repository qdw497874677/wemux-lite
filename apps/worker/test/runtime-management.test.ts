import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test, type TestContext } from 'node:test'
import { config } from '../src/config.js'
import { agentsForHome } from '../src/agents/detection.js'
import { agentCommand, agentSelections, readAgentSettings, removeAgentSelection } from '../src/config/agent-settings.js'
import { installAgent, installCatalog, matchesRuntimeVersion, runRuntimeProcess, useAgent, type ProcessRequest, type RuntimeProcess } from '../src/runtimes/management.js'

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'wemux-runtimes-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}
async function executable(path: string) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '#!/usr/bin/env node\nconsole.log("1.0.0")\n', { mode: 0o755 })
}
const fixtureIntegrity = `sha512-${createHash('sha512').update('fixture-artifact').digest('base64')}`
function installFixture(home: string, key: string, run: RuntimeProcess) {
  return installAgent(home, key, true, run, fixtureIntegrity)
}
function installer(calls: ProcessRequest[], fail?: 'npm' | 'version' | 'manifest' | 'integrity'): RuntimeProcess {
  let selected = installCatalog.pi as (typeof installCatalog)[keyof typeof installCatalog]
  return async request => {
    calls.push(request)
    if (request.command !== 'npm') {
      if (fail === 'version') throw new Error('version timed out')
      return selected.version
    }
    if (fail === 'npm') throw new Error('npm timed out')
    if (request.args[0] === 'pack') {
      const requested = request.args.at(-1)
      selected = requested === '@earendil-works/pi-coding-agent@0.85.1' ? installCatalog.pi : requested === 'opencode-ai@1.18.31' ? installCatalog.opencode : installCatalog['claude-code']
      const filename = `${selected.name.replace(/^@/, '').replace('/', '-')}-${selected.version}.tgz`
      await writeFile(join(request.cwd!, filename), fail === 'integrity' ? 'tampered-artifact' : 'fixture-artifact')
      return JSON.stringify([{ filename }])
    }
    const root = join(request.args[request.args.indexOf('--prefix') + 1], 'node_modules', selected.name)
    await executable(join(root, selected.bin))
    const binName = selected === installCatalog.pi ? 'pi' : selected === installCatalog.opencode ? 'opencode' : 'claude'
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: selected.name, version: fail === 'manifest' ? '0.0.0' : selected.version, bin: { [binName]: selected.bin } }))
    return ''
  }
}

test('Pi managed version probe ignores parent package metadata but rejects a real mismatched binary', async t => {
  const home = await fixture(t)
  const previous = process.env.PI_PACKAGE_DIR
  const parent = join(home, 'parent-pi')
  await mkdir(parent)
  await writeFile(join(parent, 'package.json'), JSON.stringify({ version: '0.87.1' }))
  process.env.PI_PACKAGE_DIR = parent
  try {
    const runInstall = (version: string): RuntimeProcess => {
      const setup = installer([])
      return async request => {
        if (request.command === 'npm') return setup(request)
        await writeFile(request.command, `#!/usr/bin/env node\nimport fs from 'node:fs'; console.log(process.env.PI_PACKAGE_DIR ? JSON.parse(fs.readFileSync(process.env.PI_PACKAGE_DIR+'/package.json','utf8')).version : ${JSON.stringify(version)});\n`)
        assert.equal((request.env ?? process.env).HOME, process.env.HOME)
        assert.equal((request.env ?? process.env).PATH, process.env.PATH)
        return runRuntimeProcess(request)
      }
    }
    const installed = await installFixture(home, 'pi', runInstall('0.85.1'))
    assert.equal(installed.version, '0.85.1')
    const before = await readFile(join(home, 'agents.json'), 'utf8')
    await assert.rejects(installFixture(home, 'pi', runInstall('0.85.10')), /does not match pinned artifact/)
    assert.equal(await readFile(join(home, 'agents.json'), 'utf8'), before)
    assert.equal(process.env.PI_PACKAGE_DIR, parent)
  } finally {
    if (previous === undefined) delete process.env.PI_PACKAGE_DIR
    else process.env.PI_PACKAGE_DIR = previous
  }
})

test('pinned runtime probe rejects a different patch version', () => {
  assert.equal(matchesRuntimeVersion('pi 0.85.1', '0.85.1'), true)
  assert.equal(matchesRuntimeVersion('pi 0.85.10', '0.85.1'), false)
  assert.equal(matchesRuntimeVersion('pi 10.85.1', '0.85.1'), false)
})

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

test('environment overrides cover Pi, OpenCode and Claude runtime paths', () => {
  const environment = { WEMUX_PI_COMMAND: '/env/pi', WEMUX_OPENCODE_COMMAND: '/env/opencode', WEMUX_CLAUDE_COMMAND: '/env/claude' }
  assert.equal(agentCommand('pi', {}, environment), '/env/pi')
  assert.equal(agentCommand('opencode', {}, environment), '/env/opencode')
  assert.equal(agentCommand('claude-code', {}, environment), '/env/claude')
  assert.equal(agentSelections({}, environment).find(item => item.key === 'opencode')?.source, 'environment')
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

for (const key of ['pi', 'opencode', 'claude'] as const) test(`managed ${key} install uses exact non-global npm args, validates and persists provenance`, async t => {
  const home = await fixture(t)
  const calls: ProcessRequest[] = []
  const result = await installFixture(home, key, installer(calls))
  const prefix = calls[0].cwd!
  const spec = key === 'pi' ? '@earendil-works/pi-coding-agent@0.85.1' : key === 'opencode' ? 'opencode-ai@1.18.31' : '@anthropic-ai/claude-code@2.1.34'
  assert.deepEqual(calls[0], { command: 'npm', args: ['pack', '--json', '--ignore-scripts', '--pack-destination', prefix, '--registry=https://registry.npmjs.org', '--', spec], cwd: prefix, env: calls[0].env, timeout: 300_000 })
  const artifact = join(prefix, `${installCatalog[result.key].name.replace(/^@/, '').replace('/', '-')}-${installCatalog[result.key].version}.tgz`)
  assert.deepEqual(calls[1], { command: 'npm', args: ['install', '--global=false', '--prefix', prefix, '--no-save', '--package-lock=false', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--', artifact], cwd: prefix, env: calls[1].env, timeout: 300_000 })
  assert.ok(prefix.startsWith(join(home, 'agents', result.key)))
  assert.deepEqual(calls[2], { command: result.executable, args: ['--version'], timeout: 10_000, ...(result.key === 'pi' ? { env: calls[2].env } : {}) })
  if (result.key === 'pi') assert.equal(calls[2].env?.PI_PACKAGE_DIR, undefined)
  assert.equal((await readAgentSettings(home))[result.key]?.package, spec)
  assert.equal((await readAgentSettings(home))[result.key]?.source, 'managed')
  assert.match(result.message, /重启/)
})

for (const failure of ['npm', 'version', 'manifest', 'integrity'] as const) test(`${failure} failure preserves prior selection and removes only failed prefix`, async t => {
  const home = await fixture(t)
  const path = join(home, 'user-pi')
  await executable(path)
  await useAgent(home, 'pi', path, async () => '1')
  const before = await readFile(join(home, 'agents.json'), 'utf8')
  const calls: ProcessRequest[] = []
  await assert.rejects(installFixture(home, 'pi', installer(calls, failure)))
  if (failure === 'integrity') assert.equal(calls.filter(call => call.command === 'npm').length, 1, 'tampered archive must never reach npm install')
  assert.equal(await readFile(join(home, 'agents.json'), 'utf8'), before)
  assert.deepEqual(await readdir(join(home, 'agents', 'pi')), [])
  assert.match(await readFile(path, 'utf8'), /console.log/)
  await assert.rejects(useAgent(home, 'pi', path, async () => { throw new Error('timeout') }), /timeout/)
  assert.equal(await readFile(join(home, 'agents.json'), 'utf8'), before)
})

test('malformed npm pack metadata is rejected before install and leaves the selected Agent untouched', async t => {
  const home = await fixture(t)
  const path = join(home, 'prior-pi')
  await executable(path)
  await useAgent(home, 'pi', path, async () => '1')
  const before = await readFile(join(home, 'agents.json'), 'utf8')
  for (const metadata of ['{}', '[]', '[{"filename":"../escape.tgz"}]', '[{"filename":"archive.zip"}]']) {
    const calls: ProcessRequest[] = []
    await assert.rejects(installFixture(home, 'pi', async request => {
      calls.push(request)
      return metadata
    }), /npm artifact metadata invalid/)
    assert.equal(calls.length, 1, 'untrusted metadata must not reach installation')
    assert.equal(await readFile(join(home, 'agents.json'), 'utf8'), before)
    assert.deepEqual(await readdir(join(home, 'agents', 'pi')), [])
  }
})

test('reinstall uses a new prefix without changing old managed files; selections merge', async t => {
  const home = await fixture(t)
  const first = await installFixture(home, 'pi', installer([]))
  await installFixture(home, 'claude', installer([]))
  const second = await installFixture(home, 'pi', installer([]))
  assert.notEqual(first.executable, second.executable)
  assert.match(await readFile(first.executable, 'utf8'), /console.log/)
  assert.equal(Object.keys(await readAgentSettings(home)).length, 2)
})

test('reset removes only an explicit override and reports PATH candidates as unselected', async t => {
  const home = await fixture(t)
  const path = join(home, 'user-pi')
  await executable(path)
  await useAgent(home, 'pi', path, async () => '1')
  assert.equal(agentSelections(await readAgentSettings(home), {})[0].executable, path)
  await removeAgentSelection(home, 'pi')
  const settings = await readAgentSettings(home)
  assert.equal(settings.pi, undefined)
  assert.equal(agentSelections(settings, {})[0].source, 'PATH')
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
  const mockNpm = installer(calls)
  await installFixture(home, 'claude', async request => {
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
    return mockNpm(request)
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

test('CLI runs mock npm as a real child with literal fixed args and rejects a tampered official artifact', async t => {
  const home = await fixture(t)
  const bin = join(home, 'bin')
  await mkdir(bin)
  const log = join(home, 'npm-args.json')
  await writeFile(join(bin, 'npm'), `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
if (args[0] === 'pack') {
  const filename = 'anthropic-ai-claude-code-2.1.34.tgz';
  fs.writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], filename), 'tampered');
  process.stdout.write(JSON.stringify([{filename}]));
} else { process.stderr.write('unexpected install after tampered archive'); process.exitCode = 7; }
`, { mode: 0o755 })
  const exec = promisify(execFile)
  await assert.rejects(exec(process.execPath, ['--import', 'tsx', new URL('../src/cli.ts', import.meta.url).pathname, 'agent', 'install', 'claude', '--yes', '--home', home], { env: { ...process.env, PATH: bin } }), /artifact integrity mismatch/)
  const args = JSON.parse(await readFile(log, 'utf8'))
  assert.equal(args[0], 'pack')
  assert.equal(args.at(-1), '@anthropic-ai/claude-code@2.1.34')
  assert.equal((await readAgentSettings(home))['claude-code'], undefined)
  assert.deepEqual(await readdir(join(home, 'agents', 'claude-code')), [])
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
