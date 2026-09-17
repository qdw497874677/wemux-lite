import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MessageId, Timestamp, WorkerId } from '@wemux/domain'
import type {
  ServerDataFrame,
  ServerHelloFrame,
  ServerPayload,
  WorkerDataFrame,
  WorkerHelloFrame,
} from '@wemux/wire-protocol'
import { TRANSPORT_V2_MAJOR, TRANSPORT_V2_MINOR, WEMUX_ADK_PROFILE_V1 } from '@wemux/wire-protocol'

const now = () => new Date().toISOString() as Timestamp
export class ServerTransportStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (path === ':memory:') {
      this.db = new DatabaseSync(':memory:')
    } else {
      mkdirSync(dirname(path), { recursive: true })
      this.db = new DatabaseSync(path)
    }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS transport_meta (worker_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(worker_id,key));
      CREATE TABLE IF NOT EXISTS transport_outbox (
        worker_id TEXT NOT NULL, delivery_epoch TEXT NOT NULL, seq INTEGER NOT NULL,
        message_id TEXT NOT NULL UNIQUE, dedupe_key TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, last_sent_at TEXT,
        PRIMARY KEY(worker_id,delivery_epoch,seq), UNIQUE(worker_id,dedupe_key)
      );
      CREATE TABLE IF NOT EXISTS transport_inbox (
        worker_id TEXT NOT NULL, delivery_epoch TEXT NOT NULL, seq INTEGER NOT NULL,
        message_id TEXT NOT NULL UNIQUE, received_at TEXT NOT NULL,
        PRIMARY KEY(worker_id,delivery_epoch,seq)
      );
      CREATE TABLE IF NOT EXISTS transport_outbox_dedupe (
        worker_id TEXT NOT NULL, dedupe_key TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(worker_id,dedupe_key)
      );
    `)
    const columns = this.db.prepare('PRAGMA table_info(transport_outbox)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'dedupe_key')) this.db.exec('ALTER TABLE transport_outbox ADD COLUMN dedupe_key TEXT')
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS transport_outbox_dedupe_index ON transport_outbox(worker_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
      INSERT OR IGNORE INTO transport_outbox_dedupe(worker_id,dedupe_key,created_at)
        SELECT worker_id,dedupe_key,created_at FROM transport_outbox WHERE dedupe_key IS NOT NULL;
    `)
  }

  negotiate(workerId: WorkerId, hello: WorkerHelloFrame): ServerHelloFrame {
    if (hello.workerId !== workerId) throw new Error('Worker identity mismatch')
    if (!hello.transport.supportedMajors.includes(TRANSPORT_V2_MAJOR)) throw new Error('Unsupported transport major')
    if (!hello.adkProfiles.includes(WEMUX_ADK_PROFILE_V1)) throw new Error('Unsupported ADK profile')
    const logicalConnectionId = this.meta(workerId, 'logical_connection_id') ?? this.setMeta(workerId, 'logical_connection_id', randomUUID())
    const outboundEpoch = this.meta(workerId, 'outbound_epoch') ?? this.setMeta(workerId, 'outbound_epoch', randomUUID())
    const inboundEpoch = hello.resume.workerToServer?.deliveryEpoch ?? randomUUID()
    const storedInboundEpoch = this.meta(workerId, 'inbound_epoch')
    if (storedInboundEpoch !== inboundEpoch) {
      if (storedInboundEpoch && this.inboundAckThrough(workerId, storedInboundEpoch) > 0) throw new Error('transport integrity error: unknown worker delivery epoch')
      this.setMeta(workerId, 'inbound_epoch', inboundEpoch)
      this.setMeta(workerId, `inbound_ack:${inboundEpoch}`, '0')
    }
    if (hello.resume.serverToWorker && hello.resume.serverToWorker.deliveryEpoch !== outboundEpoch && hello.resume.serverToWorker.ackThrough > 0) throw new Error('transport integrity error: unknown server delivery epoch')
    return {
      frameType: 'transport.hello', side: 'server',
      selectedTransport: { major: TRANSPORT_V2_MAJOR, minor: TRANSPORT_V2_MINOR },
      selectedAdkProfile: WEMUX_ADK_PROFILE_V1,
      enabledFeatures: ['durable-ack', 'bounded-replay'],
      logicalConnectionId,
      connectionEpoch: randomUUID(),
      resumeAccepted: hello.resume.logicalConnectionId === null || hello.resume.logicalConnectionId === logicalConnectionId,
      authoritativeCursors: {
        workerToServer: { deliveryEpoch: inboundEpoch, ackThrough: this.inboundAckThrough(workerId, inboundEpoch) },
        serverToWorker: { deliveryEpoch: outboundEpoch, ackThrough: this.outboundAckThrough(workerId, outboundEpoch) },
      },
      acceptedAt: now(),
    }
  }

  enqueue(workerId: WorkerId, payload: ServerPayload): void {
    const epoch = this.meta(workerId, 'outbound_epoch') ?? this.setMeta(workerId, 'outbound_epoch', randomUUID())
    const dedupeKey = payload.type === 'command' ? `command:${payload.commandId}` : null
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (dedupeKey && this.db.prepare('SELECT 1 FROM transport_outbox_dedupe WHERE worker_id=? AND dedupe_key=?').get(workerId, dedupeKey)) {
        this.db.exec('COMMIT')
        return
      }
      const seq = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM transport_outbox WHERE worker_id=? AND delivery_epoch=?').get(workerId, epoch) as { seq: number }).seq)
      const createdAt = now()
      this.db.prepare('INSERT INTO transport_outbox(worker_id,delivery_epoch,seq,message_id,dedupe_key,payload_json,created_at) VALUES(?,?,?,?,?,?,?)').run(workerId, epoch, seq, randomUUID(), dedupeKey, JSON.stringify(payload), createdAt)
      if (dedupeKey) this.db.prepare('INSERT INTO transport_outbox_dedupe(worker_id,dedupe_key,created_at) VALUES(?,?,?)').run(workerId, dedupeKey, createdAt)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  pending(workerId: WorkerId, limit: number): readonly ServerDataFrame[] {
    const epoch = this.meta(workerId, 'outbound_epoch') ?? this.setMeta(workerId, 'outbound_epoch', randomUUID())
    const ack = this.outboundAckThrough(workerId, epoch)
    const rows = this.db.prepare('SELECT seq,message_id,payload_json FROM transport_outbox WHERE worker_id=? AND delivery_epoch=? AND seq>? ORDER BY seq LIMIT ?').all(workerId, epoch, ack, limit) as Array<{seq:number;message_id:string;payload_json:string}>
    return rows.map(row => ({ frameType: 'data', durability: 'durable', deliveryEpoch: epoch, directionSeq: row.seq, messageId: row.message_id as MessageId, lane: 'command', payloadVersion: 'wemux.server.payload.v1', expiresAt: null, payload: JSON.parse(row.payload_json) as ServerPayload }))
  }

  sent(workerId: WorkerId, frame: ServerDataFrame): void {
    if (frame.durability === 'durable') this.db.prepare('UPDATE transport_outbox SET last_sent_at=? WHERE worker_id=? AND delivery_epoch=? AND seq=?').run(now(), workerId, frame.deliveryEpoch, frame.directionSeq)
  }

  acknowledge(workerId: WorkerId, deliveryEpoch: string, ackThrough: number): void {
    const epoch = this.meta(workerId, 'outbound_epoch')
    if (epoch !== deliveryEpoch) return
    const current = this.outboundAckThrough(workerId, epoch)
    if (ackThrough <= current) return
    this.setMeta(workerId, `outbound_ack:${epoch}`, String(ackThrough))
    this.db.prepare('DELETE FROM transport_outbox WHERE worker_id=? AND delivery_epoch=? AND seq<=?').run(workerId, epoch, ackThrough)
  }

  accept(workerId: WorkerId, frame: Extract<WorkerDataFrame, {readonly durability:'durable'}>): { readonly isNew: boolean; readonly ackThrough: number } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const epoch = this.meta(workerId, 'inbound_epoch')
      if (epoch !== frame.deliveryEpoch) throw new Error('Unexpected delivery epoch')
      const current = this.inboundAckThrough(workerId, frame.deliveryEpoch)
      if (frame.directionSeq <= current) { this.db.exec('COMMIT'); return { isNew: false, ackThrough: current } }
      if (frame.directionSeq !== current + 1) throw new Error(`transport gap: expected ${current + 1}, received ${frame.directionSeq}`)
      if (this.db.prepare('SELECT 1 FROM transport_inbox WHERE message_id=?').get(frame.messageId)) throw new Error(`transport integrity error: message ${frame.messageId} reused`)
      this.db.prepare('INSERT INTO transport_inbox(worker_id,delivery_epoch,seq,message_id,received_at) VALUES(?,?,?,?,?)').run(workerId, frame.deliveryEpoch, frame.directionSeq, frame.messageId, now())
      this.setMeta(workerId, `inbound_ack:${frame.deliveryEpoch}`, String(frame.directionSeq))
      this.db.exec('COMMIT')
      return { isNew: true, ackThrough: frame.directionSeq }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  isOutboundAcked(workerId: WorkerId, messageId: MessageId): boolean {
    const row = this.db.prepare('SELECT 1 FROM transport_outbox WHERE worker_id=? AND message_id=?').get(workerId, messageId)
    return row === undefined
  }

  close(): void { this.db.close() }
  private outboundAckThrough(workerId: WorkerId, epoch: string): number { return Number(this.meta(workerId, `outbound_ack:${epoch}`) ?? '0') }
  private inboundAckThrough(workerId: WorkerId, epoch: string): number { return Number(this.meta(workerId, `inbound_ack:${epoch}`) ?? '0') }
  private meta(workerId: WorkerId, key: string): string | null {
    const row = this.db.prepare('SELECT value FROM transport_meta WHERE worker_id=? AND key=?').get(workerId, key) as {value:string}|undefined
    return row?.value ?? null
  }
  private setMeta(workerId: WorkerId, key: string, value: string): string {
    this.db.prepare('INSERT INTO transport_meta(worker_id,key,value) VALUES(?,?,?) ON CONFLICT(worker_id,key) DO UPDATE SET value=excluded.value').run(workerId,key,value)
    return value
  }
}
