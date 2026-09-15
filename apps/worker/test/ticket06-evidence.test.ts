import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import type { SessionId } from '@wemux/domain'

test('Ticket06 Worker tombstone direct SQLite matrix enforces SQL protection across restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket06-worker-matrix-')), path = join(dir, 'worker.db')
  const id = 'deleted-evidence' as SessionId
  let store = new SqliteWorkerStore(path)
  try {
    await store.transaction(tx => tx.sessions.deleteSession(id))
    store.close()
    for (let restart = 0; restart < 2; restart++) {
      store = new SqliteWorkerStore(path)
      assert.equal(await store.sessions.get(id), null)
      assert.deepEqual(await store.sessions.listQueued(id), [])
      assert.deepEqual(await store.journal.listHeads(), [])
      store.close()
      const db = new DatabaseSync(path)
      try {
        const snapshot = () => ({ documents: db.prepare('SELECT * FROM documents ORDER BY bucket,id').all(), journal: db.prepare('SELECT * FROM journal ORDER BY session_id,seq').all() })
        const before = snapshot()
        assert.equal(db.prepare("SELECT count(*) AS n FROM documents WHERE bucket='deleted-sessions' AND id=?").get(id)!.n, 1)
        for (const [name, sql, args, expected] of [
          ['duplicate tombstone INSERT', 'INSERT INTO documents VALUES(?,?,?)', ['deleted-sessions', id, '{}'], 'Worker tombstone is immutable'],
          ['tombstone DELETE', 'DELETE FROM documents WHERE bucket=? AND id=?', ['deleted-sessions', id], 'Worker tombstone is retained'],
          ['tombstone identity UPDATE', 'UPDATE documents SET id=? WHERE bucket=?', ['changed', 'deleted-sessions'], 'Worker tombstone is immutable'],
          ['deleted Session resurrection INSERT', 'INSERT INTO documents VALUES(?,?,?)', ['sessions', id, '{}'], 'Session deleted'],
          ['deleted Session queue INSERT', 'INSERT INTO documents VALUES(?,?,?)', ['queue', 'q', JSON.stringify({ sessionId: id })], 'Session deleted'],
          ['deleted Session Turn INSERT', 'INSERT INTO documents VALUES(?,?,?)', ['turns', 't', JSON.stringify({ sessionId: id })], 'Session deleted'],
          ['deleted Session Journal INSERT', 'INSERT INTO journal VALUES(?,?,?)', [id, 1, '{}'], 'Session deleted'],
          // Command receipts may outlive their deleted Session; cleanup retains idempotency.
          ['retained command INSERT', 'INSERT INTO documents VALUES(?,?,?)', ['commands', 'cancel', JSON.stringify({ sessionId: id })], null],
        ] as const) {
          db.exec('BEGIN IMMEDIATE')
          try {
            let actual: string | null = null
            try { db.prepare(sql).run(...args) } catch (error) { actual = (error as Error).message }
            assert.equal(actual, expected, name)
            if (actual) assert.deepEqual(snapshot(), before)
            t.diagnostic(JSON.stringify({ restart, name, result: actual ?? 'ALLOWED_RETENTION', rollback: 'all tables restored' }))
          } finally { db.exec('ROLLBACK') }
          assert.deepEqual(snapshot(), before)
        }
        assert.deepEqual(db.prepare('PRAGMA foreign_key_list(documents)').all(), [])
        assert.deepEqual(db.prepare('PRAGMA foreign_key_list(journal)').all(), [])
      } finally { db.close() }
    }
  } finally { try { store.close() } catch {} await rm(dir, { recursive: true, force: true }) }
})
