import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../application/errors.ts'
import type { ApprovalView } from '@wemux/server-domain'
import type { Timestamp, UserId } from '@wemux/domain'
import type { ApprovalDecisionReceipt, ApprovalDecisionRepository } from '../../application/ports/approval-decision-repository.ts'
import { resolveSqliteDatabase, type SharedSqliteDatabase, type SqliteDatabaseSource } from './shared-database.ts'

export class SqliteApprovalDecisionRepository implements ApprovalDecisionRepository {
  private readonly db: DatabaseSync
  private readonly database: SharedSqliteDatabase
  private readonly ownsDatabase: boolean

  constructor(source: SqliteDatabaseSource) {
    const resolved = resolveSqliteDatabase(source)
    this.database = resolved.database
    this.ownsDatabase = resolved.owned
    this.db = this.database.connection
  }

  close(): void { if (this.ownsDatabase) this.database.close() }

  transaction<T>(work: () => Promise<T>): Promise<T> { return this.database.transaction(work) }

  private serial<T>(work: () => T): Promise<T> { return this.database.serial(work) }

  async getReceipt(actorId: UserId, requestId: string, now: Timestamp): Promise<ApprovalDecisionReceipt | null> {
    return this.serial(() => {
      this.purge(now)
      const row = this.db.prepare('SELECT data FROM approval_decision_receipts WHERE actor_id=? AND request_id=? AND expires_at>?').get(actorId, requestId, now)
      if (!row) return null
      try {
        const receipt = JSON.parse(String(row.data)) as ApprovalDecisionReceipt | null
        if (!receipt || receipt.actorId !== actorId || receipt.requestId !== requestId ||
          typeof receipt.fingerprint !== 'string' || !receipt.result?.approval) throw new Error('Invalid receipt')
        return receipt
      } catch {
        // A legacy/corrupt row must not become a cache miss and dispatch again.
        throw new AppError(409, 'Approval receipt cannot be replayed', 'idempotency_conflict')
      }
    })
  }

  async save(receipt: ApprovalDecisionReceipt, overlay: ApprovalView, expiresAt: Timestamp): Promise<void> {
    await this.database.transaction(() => {
      this.db.prepare('INSERT INTO approval_decision_receipts(actor_id,request_id,fingerprint,created_at,expires_at,data) VALUES(?,?,?,?,?,?)')
        .run(receipt.actorId, receipt.requestId, receipt.fingerprint, receipt.createdAt, expiresAt, JSON.stringify(receipt))
      this.db.prepare('INSERT INTO approval_decision_overlays(projection_key,expires_at,data) VALUES(?,?,?) ON CONFLICT(projection_key) DO UPDATE SET expires_at=excluded.expires_at,data=excluded.data')
        .run(overlay.projectionKey, expiresAt, JSON.stringify(overlay))
    })
  }

  async listOverlays(now: Timestamp): Promise<readonly ApprovalView[]> {
    return this.serial(() => {
      this.purge(now)
      return this.db.prepare('SELECT data FROM approval_decision_overlays WHERE expires_at>? ORDER BY projection_key').all(now)
        .map(row => JSON.parse(String(row.data)) as ApprovalView)
    })
  }

  async purgeExpired(now: Timestamp): Promise<number> { return this.serial(() => this.purge(now)) }

  private purge(now: Timestamp): number {
    const receipts = Number(this.db.prepare('DELETE FROM approval_decision_receipts WHERE expires_at<=?').run(now).changes)
    const overlays = Number(this.db.prepare('DELETE FROM approval_decision_overlays WHERE expires_at<=?').run(now).changes)
    return receipts + overlays
  }
}
