import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

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
    execFileSync(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', 'status', '--home', home], { timeout: 10000, killSignal: 'SIGKILL', stdio: 'pipe', env: { ...process.env, PATH: '/nonexistent' } })
    assert.equal(await digest(), before)
    assert.equal((await stat(file)).mode, mode)
  } finally { await rm(home, { recursive: true, force: true }) }
})
