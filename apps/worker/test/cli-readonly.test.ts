import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
import { execFileSync, spawnSync } from 'node:child_process'

for (const existingHome of [false, true]) test(`status reports missing database without initializing ${existingHome ? 'existing' : 'missing'} home`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-empty-status-'))
  const home = join(root, 'home')
  try {
    if (existingHome) await mkdir(home)
    const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, 'status', '--home', home], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: '/nonexistent' } })
    assert.equal(result.status, 0, result.stderr)
    const status = JSON.parse(result.stdout)
    assert.equal(status.initialized, false)
    assert.equal(status.identity, null)
    assert.deepEqual(status.sessions, [])
    if (existingHome) assert.deepEqual(await readdir(home), [])
    else await assert.rejects(stat(home), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const invalid of ['corrupt', 'directory']) test(`status refuses ${invalid} database instead of reporting uninitialized`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'worker-invalid-status-'))
  try {
    const file = join(home, 'worker.sqlite')
    if (invalid === 'corrupt') await writeFile(file, 'not a sqlite database')
    else await mkdir(file)
    const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, 'status', '--home', home], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: '/nonexistent' } })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.ok(result.stderr.trim())
    if (invalid === 'corrupt') assert.equal(await readFile(file, 'utf8'), 'not a sqlite database')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('status reads a legacy Worker database without migration, identity writes or permission changes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'worker-readonly-'))
  const file = join(home, 'worker.sqlite')
  try {
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE documents(bucket TEXT,id TEXT,body TEXT,PRIMARY KEY(bucket,id)); CREATE TABLE journal(session_id TEXT,seq INTEGER,body TEXT,PRIMARY KEY(session_id,seq)); PRAGMA user_version=1;')
    db.close()
    const digest = async () => createHash('sha256').update(await readFile(file)).digest('hex')
    const before = await digest()
    const mode = (await stat(file)).mode
    execFileSync(process.execPath, ['--import', 'tsx', cliPath, 'status', '--home', home], { timeout: 10000, killSignal: 'SIGKILL', stdio: 'pipe', env: { ...process.env, PATH: '/nonexistent' } })
    assert.equal(await digest(), before)
    assert.equal((await stat(file)).mode, mode)
  } finally { await rm(home, { recursive: true, force: true }) }
})
