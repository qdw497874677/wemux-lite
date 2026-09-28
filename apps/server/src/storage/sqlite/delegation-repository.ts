import type { DatabaseSync } from 'node:sqlite'
import type { PageRequest, SessionId } from '@wemux/domain'
import { isActiveDelegationStatus, type Delegation, type DelegationRepository } from '@wemux/server-domain'
import { DelegationError } from '../../application/delegation-service.ts'
import { resolveSqliteDatabase, type SharedSqliteDatabase, type SqliteDatabaseSource } from './shared-database.ts'

export class SqliteDelegationRepository implements DelegationRepository {
  private readonly db: DatabaseSync
  private readonly database: SharedSqliteDatabase
  private readonly ownsDatabase: boolean

  constructor(source: SqliteDatabaseSource) {
    const resolved = resolveSqliteDatabase(source)
    this.database = resolved.database
    this.ownsDatabase = resolved.owned
    this.db = this.database.connection
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delegations (
        id TEXT PRIMARY KEY,
        dispatch_id TEXT NOT NULL UNIQUE,
        parent_session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS delegations_parent_status ON delegations(parent_session_id, status);
    `)
  }

  close(): void { if (this.ownsDatabase) this.database.close() }

  async getDelegation(id: string): Promise<Delegation | undefined> {
    return this.database.serial(() => rowDelegation(this.db.prepare('SELECT data FROM delegations WHERE id=?').get(id)))
  }

  async findDelegationByDispatchId(dispatchId: string): Promise<Delegation | undefined> {
    return this.database.serial(() => rowDelegation(this.db.prepare('SELECT data FROM delegations WHERE dispatch_id=?').get(dispatchId)))
  }

  async countActiveChildren(parentSessionId: SessionId): Promise<number> {
    return this.database.serial(() => this.db.prepare(`SELECT status FROM delegations WHERE parent_session_id=?`).all(parentSessionId)
      .filter(row => isActiveDelegationStatus(String(row.status) as Delegation['status'])).length)
  }

  async listDelegations(query: PageRequest = { offset: 0, limit: 100 }) { return this.database.serial(() => {
    const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM delegations').get()!.count)
    const items = this.db.prepare('SELECT data FROM delegations ORDER BY rowid LIMIT ? OFFSET ?').all(query.limit, query.offset)
      .map(row => JSON.parse(String(row.data)) as Delegation)
    return { items, total }
  }) }

  async saveDelegation(delegation: Delegation, expectedVersion?: number): Promise<void> { await this.database.serial(() => {
    if (expectedVersion === undefined) {
      try {
        this.db.prepare('INSERT INTO delegations(id,dispatch_id,parent_session_id,status,version,data) VALUES(?,?,?,?,?,?)')
          .run(delegation.id, delegation.dispatchId, delegation.source.sessionId, delegation.status, delegation.version, JSON.stringify(delegation))
      } catch (error) {
        if (String(error).includes('UNIQUE')) throw new DelegationError('conflict', 'delegation identity already exists')
        throw error
      }
      return
    }
    const result = this.db.prepare('UPDATE delegations SET status=?,version=?,data=? WHERE id=? AND version=?')
      .run(delegation.status, delegation.version, JSON.stringify(delegation), delegation.id, expectedVersion)
    if (Number(result.changes) !== 1) throw new DelegationError('conflict', 'delegation version conflict')
  }) }
}

function rowDelegation(row: Record<string, unknown> | undefined): Delegation | undefined {
  return row ? JSON.parse(String(row.data)) as Delegation : undefined
}
