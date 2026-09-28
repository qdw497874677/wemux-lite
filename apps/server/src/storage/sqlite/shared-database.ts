import { AsyncLocalStorage } from 'node:async_hooks'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrations.ts'

/**
 * Server 进程内主数据库的唯一连接与 FIFO 调度器。
 *
 * DatabaseSync 的 busy_timeout 会同步阻塞事件循环；若另一个连接正被跨 await 的事务持有，
 * 等待方会阻止持锁方恢复并提交。共享连接和队列让跨仓储操作按进入顺序执行，避免这种互锁。
 */
export class SharedSqliteDatabase {
  readonly connection: DatabaseSync
  private queue: Promise<unknown> = Promise.resolve()
  private readonly transactionContext = new AsyncLocalStorage<{ active: boolean }>()
  private closed = false

  constructor(path: string) {
    this.connection = new DatabaseSync(path)
    this.connection.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    try { migrate(this.connection) } catch (error) { this.connection.close(); throw error }
  }

  serial<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()?.active) return Promise.resolve().then(work)
    const result = this.queue.then(work)
    this.queue = result.catch(() => undefined)
    return result
  }

  transaction<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()?.active) return Promise.resolve().then(work)
    return this.serial(() => {
      const token = { active: true }
      return this.transactionContext.run(token, async () => {
        this.connection.exec('BEGIN IMMEDIATE')
        try {
          const result = await work()
          this.connection.exec('COMMIT')
          return result
        } catch (error) {
          this.connection.exec('ROLLBACK')
          throw error
        } finally {
          token.active = false
        }
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.connection.close()
  }
}

export type SqliteDatabaseSource = string | SharedSqliteDatabase

export function resolveSqliteDatabase(source: SqliteDatabaseSource): { database: SharedSqliteDatabase; owned: boolean } {
  return typeof source === 'string'
    ? { database: new SharedSqliteDatabase(source), owned: true }
    : { database: source, owned: false }
}
