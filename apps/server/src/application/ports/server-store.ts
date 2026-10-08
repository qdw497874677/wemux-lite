import type {
  ServerAuditWriter,
  ServerCacheReader,
  ServerCacheWriter,
  ServerCommandReader,
  ServerCommandWriter,
  ServerIdentityReader,
  ServerIdentityWriter,
  ServerResourceReader,
  ServerResourceWriter,
} from './server-store-types.ts'

/**
 * Server persistence seam. Transactions must not perform network, Agent, or
 * filesystem work and must not be nested. A resolved transaction is committed;
 * a rejected transaction must have no partial effects. Public readers expose only
 * committed state and may wait behind writes. Inside callbacks use tx readers;
 * awaiting public readers or nested transactions is rejected, never self-blocked.
 */
export interface ServerStore {
  readonly fileWrites: import('./file-write-admission.ts').FileWriteReader
  readonly tasks: import('./server-store-types.ts').ServerTaskReader
  readonly identity: ServerIdentityReader
  readonly resources: ServerResourceReader
  readonly commands: ServerCommandReader
  readonly cache: ServerCacheReader

  transaction<T>(work: (tx: ServerStoreTx) => Promise<T>): Promise<T>
}

/** Per-transaction lease: await all operations inside the callback. Every escaped
 * reader/writer rejects after commit/rollback, including during later transactions.
 * Derived async contexts become inactive on completion; start background work outside.
 */
export interface ServerStoreTx {
  readonly fileWrites: import('./file-write-admission.ts').FileWriteReader & import('./file-write-admission.ts').FileWriteWriter
  readonly tasks: import('./server-store-types.ts').ServerTaskReader & import('./server-store-types.ts').ServerTaskWriter
  readonly identity: ServerIdentityReader & ServerIdentityWriter
  readonly resources: ServerResourceReader & ServerResourceWriter
  readonly commands: ServerCommandReader & ServerCommandWriter
  readonly cache: ServerCacheReader & ServerCacheWriter
  readonly audit: ServerAuditWriter
}

/**
 * Required atomic groups include resource + pending command + audit, membership
 * removal + grant invalidation, and cached events + contiguous sequence cursor.
 */
