import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const launcher = fileURLToPath(new URL('../../../scripts/test-with-browser.mjs', import.meta.url))
const root = fileURLToPath(new URL('../../../', import.meta.url))
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-gate-'))
  try {
    const module = join(directory, 'browser module ; fixture.mjs')
    const executable = join(directory, 'chromium fixture')
    const log = join(directory, 'calls.jsonl')
    await writeFile(executable, 'fixture')
    await writeFile(module, `
      import { access, appendFile } from 'node:fs/promises'
      export const chromium = { async launch(options) {
        await access(options.executablePath)
        await appendFile(process.env.FIXTURE_LOG, JSON.stringify({ step: 'launch', options }) + '\\n')
        return { async close() { await appendFile(process.env.FIXTURE_LOG, '{"step":"close"}\\n') } }
      } }
    `)
    const env = { ...process.env, PLAYWRIGHT_CORE_PATH: module, PLAYWRIGHT_CHROMIUM_PATH: executable, FIXTURE_LOG: log }
    const childScript = `require('node:fs').appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({step:'child', core:process.env.PLAYWRIGHT_CORE_PATH, chromium:process.env.PLAYWRIGHT_CHROMIUM_PATH, dist:process.env.WEMUX_NEXT_DIST_PATH, cwd:process.cwd(), args:process.argv.slice(1)})+'\\n'); process.exit(7)`
    const invoke = (overrides = {}, args = ['--', process.execPath, '-e', childScript, 'literal ; $(not-a-command)']) => spawnSync(process.execPath, [launcher, ...args], { env: { ...env, ...overrides }, cwd: directory, encoding: 'utf8', timeout: 15000 })
    await run({ directory, module, executable, log, invoke })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

for (const [name, overrides] of [
  ['missing module', { PLAYWRIGHT_CORE_PATH: '' }],
  ['missing executable', { PLAYWRIGHT_CHROMIUM_PATH: '' }],
  ['relative module', { PLAYWRIGHT_CORE_PATH: './browser.mjs' }],
  ['relative executable', { PLAYWRIGHT_CHROMIUM_PATH: './chrome' }],
]) test(`browser gate rejects ${name} before starting tests`, () => fixture(async ({ invoke, log }) => {
  const child = invoke(overrides)
  assert.equal(child.status, 1)
  assert.match(child.stderr, /^Browser preflight failed:/)
  assert.equal(child.stdout, '')
  await assert.rejects(readFile(log), { code: 'ENOENT' })
}))

for (const kind of ['missing module file', 'invalid module', 'missing executable file', 'launch failure', 'close failure']) {
  test(`browser gate fails closed on ${kind}`, () => fixture(async ({ directory, module, log, invoke }) => {
    const overrides = {}
    if (kind === 'missing module file') overrides.PLAYWRIGHT_CORE_PATH = join(directory, 'absent.mjs')
    if (kind === 'invalid module') await writeFile(module, 'export const chromium = {}')
    if (kind === 'missing executable file') overrides.PLAYWRIGHT_CHROMIUM_PATH = join(directory, 'absent-chrome')
    if (kind === 'launch failure') await writeFile(module, `export const chromium = { launch() { throw Error('PRIVATE_SENTINEL') } }`)
    if (kind === 'close failure') await writeFile(module, `export const chromium = { launch() { return { close() { throw Error('PRIVATE_SENTINEL') } } } }`)
    const child = invoke(overrides)
    assert.equal(child.status, 1)
    assert.match(child.stderr, /^Browser preflight failed:/)
    assert.doesNotMatch(child.stderr, /PRIVATE_SENTINEL/)
    await assert.rejects(readFile(log), { code: 'ENOENT' })
  }))
}

test('browser gate closes preflight before child, preserves config/dist/argv and child failure', () => fixture(async ({ invoke, log, module, executable, directory }) => {
  const dist = join(directory, 'private dist')
  const child = invoke({ WEMUX_NEXT_DIST_PATH: dist })
  assert.equal(child.status, 7)
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(calls.map(call => call.step), ['launch', 'close', 'child'])
  assert.equal(calls[0].options.executablePath, executable)
  assert.equal(calls[0].options.headless, true)
  assert.deepEqual(calls[2], { step: 'child', core: module, chromium: executable, dist, cwd: root.replace(/\/$/, ''), args: ['literal ; $(not-a-command)'] })
}))

test('default browser gate runs npm test only after successful preflight', () => fixture(async ({ directory, invoke, log }) => {
  const npm = join(directory, 'npm')
  await writeFile(npm, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({step:'npm', args:process.argv.slice(2)})+'\\n')\n`)
  await chmod(npm, 0o700)
  const child = invoke({ PATH: directory }, [])
  assert.equal(child.status, 0, child.stderr)
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(calls.map(call => call.step), ['launch', 'close', 'npm'])
  assert.deepEqual(calls[2].args, ['test'])
}))
