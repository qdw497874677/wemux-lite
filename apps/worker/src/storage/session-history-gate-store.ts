import { DatabaseSync } from 'node:sqlite'
import type { HistoryGateState } from '../application/session-history-gate.ts'

const applicationId = 0x57484731

/** Dedicated, exclusively owned private fixture DB. Never pass a live Worker DB or connection.
 * Reopening is recovery, not a second concurrent gate owner; restore continuity is out of scope.
 */
export class SessionHistoryGateStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    try {
      const id = Number(this.db.prepare('PRAGMA application_id').get()?.application_id)
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version)
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()
      if (!((id === 0 && version === 0 && tables.length === 0) || (id === applicationId && version === 1))) {
        throw new Error('Not a supported private history gate database')
      }
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (id === 0) this.db.exec(`
          CREATE TABLE history_gate (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
          PRAGMA application_id=${applicationId}; PRAGMA user_version=1;
        `)
        const state = this.read()
        if (state) {
          for (const record of state.admissions) {
            if (record.state === 'reserved') record.state = 'unknown'
          }
          this.save(state)
        }
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    } catch (error) { this.db.close(); throw error }
  }

  close(): void { this.db.close() }

  initialize(initial: HistoryGateState): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.read()) this.save(initial)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private read(): HistoryGateState | undefined {
    const row = this.db.prepare('SELECT body FROM history_gate WHERE id=1').get()
    return row ? JSON.parse(String(row.body)) as HistoryGateState : undefined
  }

  private save(state: HistoryGateState): void {
    this.db.prepare('INSERT INTO history_gate (id,body) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(state))
  }

  /** Synchronous check+write only: callers run all effect I/O after this method commits. */
  transaction<T>(work: (state: HistoryGateState) => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const state = this.read()
      if (!state) throw new Error('Private history gate not initialized')
      const before = JSON.stringify(state)
      const result = work(state)
      if (result instanceof Promise) throw new Error('Private history transactions must be synchronous')
      if (JSON.stringify(state) !== before) this.save(state)
      this.db.exec('COMMIT')
      return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
