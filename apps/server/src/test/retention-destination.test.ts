import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Deliberately load the built production adapters, not a hand-built trigger schema.
for (const side of ['server', 'worker'] as const) test(`built ${side} UPDATE OR REPLACE destination retention, upgrade and restart`, async () => {
  const modulePath = side === 'server' ? '../../dist/storage/sqlite/store.js' : '../../../worker/dist/storage/sqlite-store.js'
  const adapter = await import(new URL(modulePath, import.meta.url).href)
  const Store = side === 'server' ? adapter.SqliteServerStore : adapter.SqliteWorkerStore
  const dir = await mkdtemp(join(tmpdir(), 'destination-retention-')), path = join(dir, 'store.db')
  const table = side === 'server' ? 'records' : 'documents', kind = side === 'server' ? 'kind' : 'bucket', body = side === 'server' ? 'data' : 'body'
  const protectedKind = side === 'server' ? 'session' : 'deleted-sessions'
  const error = side === 'server' ? 'Session identity and provenance are retained' : 'Worker tombstone is immutable'
  try {
    new Store(path).close()
    const db = new DatabaseSync(path)
    try {
      db.prepare(`INSERT INTO ${table}(${kind},id,${body}) VALUES(?,?,?)`).run(protectedKind, 'target', JSON.stringify({ id: 'target', deletedAt: 'then' }))
      db.prepare(`INSERT INTO ${table}(${kind},id,${body}) VALUES(?,?,?)`).run('generic', 'source', '{}')
      db.prepare(`INSERT INTO ${table}(${kind},id,${body}) VALUES(?,?,?)`).run('generic', 'target', '{}')
      if (side === 'server') db.prepare("INSERT INTO records(kind,id,data) VALUES('session','live',?)").run(JSON.stringify({ id: 'live', deletedAt: null }))
      // Reconstruct the previous version to exercise upgrade installation too.
      db.exec(`DROP TRIGGER IF EXISTS ${side === 'server' ? 'session_record_destination' : 'tombstone_destination'}`)
      db.exec(side === 'server' ? 'DELETE FROM schema_migrations WHERE version=10' : 'PRAGMA user_version=2')
      for (let restart = 0; restart < 2; restart++) {
        new Store(path).close()
        assert.equal(db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers, 0)
        const snapshot = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => ({ name: row.name, rows: db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all() }))
        for (const [source, destination] of [['source', 'target'], ['target', 'target'], ['source', 'absent'], ...(side === 'server' ? [['source', 'live']] : [])]) {
          const before = snapshot()
          assert.throws(() => db.prepare(`UPDATE OR REPLACE ${table} SET ${kind}=?,id=?,${body}=? WHERE ${kind}='generic' AND id=?`).run(protectedKind, destination!, JSON.stringify({ id: destination, deletedAt: null }), source!), { message: error })
          assert.deepEqual(snapshot(), before)
        }
        // Ordinary updates and same-identity writes still work.
        db.prepare(`UPDATE ${table} SET ${body}=? WHERE ${kind}='generic' AND id='source'`).run(JSON.stringify({ restart }))
        db.exec(`UPDATE OR REPLACE ${table} SET ${body}=${body} WHERE ${kind}='${protectedKind}' AND id='target'`)
        if (side === 'server') db.exec("UPDATE records SET data=json_set(data,'$.title','normal update') WHERE kind='session' AND id='target'")
        assert.equal(JSON.parse(String(db.prepare(`SELECT ${body} AS body FROM ${table} WHERE ${kind}=? AND id='target'`).get(protectedKind)!.body)).deletedAt, 'then')
      }
    } finally { db.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
