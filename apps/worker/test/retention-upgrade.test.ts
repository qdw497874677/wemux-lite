import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'

test('Worker v1 retention upgrade rolls back failed backfill, cleans deleted payloads, and survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-retention-')), path = join(dir, 'worker.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE documents(bucket TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(bucket,id));
      CREATE TABLE journal(session_id TEXT NOT NULL,seq INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session_id,seq)); PRAGMA user_version=1;
      INSERT INTO documents VALUES('deleted-sessions','gone','{"deletedAt":"then"}'),('sessions','gone','{"sessionId":"gone"}'),('queue','q','{"sessionId":"gone"}'),('turns','t','{"sessionId":"gone"}');
      INSERT INTO journal VALUES('gone',1,'{}');
      CREATE TRIGGER fail_cleanup BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT,'injected cleanup failure'); END;`)
    const snapshot = () => ({ schema: db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), docs: db.prepare('SELECT * FROM documents').all(), journal: db.prepare('SELECT * FROM journal').all(), version: db.prepare('PRAGMA user_version').get() })
    const before = snapshot()
    for (let i = 0; i < 2; i++) { assert.throws(() => new SqliteWorkerStore(path), /injected cleanup failure/); assert.deepEqual(snapshot(), before) }
    db.exec('DROP TRIGGER fail_cleanup')
    for (let i = 0; i < 2; i++) {
      const store = new SqliteWorkerStore(path); store.close()
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3)
      assert.deepEqual(db.prepare('SELECT bucket,id,body FROM documents').all().map(r => ({ ...r })), [{ bucket: 'deleted-sessions', id: 'gone', body: '{"deletedAt":"then"}' }])
      assert.deepEqual(db.prepare('SELECT * FROM journal').all(), [])
      assert.throws(() => db.exec("UPDATE documents SET bucket='sessions'"), /Session deleted/)
      for (const sql of ["UPDATE documents SET body='{}'", "INSERT OR REPLACE INTO documents VALUES('deleted-sessions','gone','{}')"]) assert.throws(() => db.exec(sql), /Worker tombstone is immutable/)
      assert.throws(() => db.exec("DELETE FROM documents"), /Worker tombstone is retained/)
      db.exec("INSERT INTO documents VALUES('queue','live','{\"sessionId\":\"live\"}'); INSERT INTO journal VALUES('live',1,'{}')")
      assert.throws(() => db.exec("UPDATE documents SET body='{\"sessionId\":\"gone\"}' WHERE bucket='queue'"), /Session deleted/)
      assert.throws(() => db.exec("UPDATE journal SET session_id='gone'"), /Session deleted/)
      db.exec("DELETE FROM documents WHERE bucket='queue'; DELETE FROM journal")
    }
  } finally { db.close(); await rm(dir, { recursive: true, force: true }) }
})
