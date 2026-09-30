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
    // deliveryEpoch 是单方向 durable 世代：Worker 在持久 cursor 无法证明连续性或本地数据库重建时才开启新世代。
    // 恢复被拒绝时双方不得把对端声明的 cursor 当作权威，接收方只回本地水位并以长期 messageId 去重
    // （docs/design/worker-reliable-connection.md 第 6 节）；未知世代因此是握手的正常输入，不是拒绝理由。
    // 旧世代的水位记录保留，便于诊断和审计。
    if (storedInboundEpoch !== inboundEpoch) {
      this.setMeta(workerId, 'inbound_epoch', inboundEpoch)
      if (this.meta(workerId, `inbound_ack:${inboundEpoch}`) === null) this.setMeta(workerId, `inbound_ack:${inboundEpoch}`, '0')
    }
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
    const dedupeKey = payload.type === 'command' ? `command:${payload.commandId}`
      : payload.type === 'resource.set.notify' ? `resource-set:${payload.setRevision}:${payload.fingerprint}`
        : null
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 去重只对「仍在 outbox 里等传输确认」的帧生效：帧被传输确认后必须允许按同一 commandId 重新入队，
      // 否则应用层收据丢失的 Command 永远不会再投递（docs/design/worker-reliable-connection.md 第 6 节）。
      if (dedupeKey) {
        const inFlight = this.db.prepare('SELECT 1 FROM transport_outbox WHERE worker_id=? AND dedupe_key=?').get(workerId, dedupeKey)
        if (inFlight) { this.db.exec('COMMIT'); return }
        // 陈旧去重记录（老版本写入或崩溃残留）自行清理，不让它永久屏蔽重投。
        this.db.prepare('DELETE FROM transport_outbox_dedupe WHERE worker_id=? AND dedupe_key=?').run(workerId, dedupeKey)
      }
      // 序号必须单调，不能对现存行取 MAX：已确认的行会被删除，MAX 会把序号重新从 1 开始，
      // 新帧就会落在已经确认过的水位之下，永远不再发送（下游 Command 永远 pending）。
      const seq = this.outboundLastSeq(workerId, epoch) + 1
      const createdAt = now()
      this.db.prepare('INSERT INTO transport_outbox(worker_id,delivery_epoch,seq,message_id,dedupe_key,payload_json,created_at) VALUES(?,?,?,?,?,?,?)').run(workerId, epoch, seq, randomUUID(), dedupeKey, JSON.stringify(payload), createdAt)
      this.setMeta(workerId, `outbound_last_seq:${epoch}`, String(seq))
      if (dedupeKey) this.db.prepare('INSERT INTO transport_outbox_dedupe(worker_id,dedupe_key,created_at) VALUES(?,?,?)').run(workerId, dedupeKey, createdAt)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  pending(workerId: WorkerId, limit: number): readonly Extract<ServerDataFrame, { readonly durability: 'durable' }>[] {
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
    // 传输确认只证明帧已送达，不等于应用层收据。水位推进、删行、清去重记录必须原子完成：
    // 否则丢收据的 Command 会被残留的去重记录永久挡住，无法按同一 commandId 重投。
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 确认水位不得超前于已入队序号：越界的确认会跳过还没发送的帧。
      if (ackThrough > this.outboundLastSeq(workerId, epoch)) { this.db.exec('ROLLBACK'); return }
      this.setMeta(workerId, `outbound_ack:${epoch}`, String(ackThrough))
      this.clearOutboxThrough(workerId, epoch, ackThrough)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  accept(workerId: WorkerId, frame: Extract<WorkerDataFrame, {readonly durability:'durable'}>): { readonly isNew: boolean; readonly ackThrough: number } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const epoch = this.meta(workerId, 'inbound_epoch')
      if (epoch !== frame.deliveryEpoch) throw new Error('Unexpected delivery epoch')
      const current = this.inboundAckThrough(workerId, frame.deliveryEpoch)
      if (frame.directionSeq <= current) { this.db.exec('COMMIT'); return { isNew: false, ackThrough: current } }
      // 水位为 0 时本端没有该世代任何可信前缀，首帧就是唯一可证明的基准：Worker 换世代后从 1 重排，
      // 而服务端自身数据库重建后 Worker 会从自己的水位继续。缺口判定只在基准建立后生效。
      if (current > 0 && frame.directionSeq !== current + 1) throw new Error(`transport gap: expected ${current + 1}, received ${frame.directionSeq}`)
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
  /** 已入队最高序号；老库缺少水位记录时用现存行与已确认水位初始化，避免升级后重号或倒退。 */
  private outboundLastSeq(workerId: WorkerId, epoch: string): number {
    const stored = this.meta(workerId, `outbound_last_seq:${epoch}`)
    if (stored !== null) return Number(stored)
    const ackThrough = this.outboundAckThrough(workerId, epoch)
    const maxRow = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM transport_outbox WHERE worker_id=? AND delivery_epoch=?').get(workerId, epoch) as { seq: number }).seq)
    // 水位之内残留的行永远不会再发送（pending 只取 seq>水位），随初始化一并清理，
    // 连同它们的去重记录一起删，避免老库升级后同 commandId 无法重投。
    if (ackThrough > 0) this.clearOutboxThrough(workerId, epoch, ackThrough)
    return Math.max(maxRow, ackThrough)
  }
  /** 删除已确认水位内的 outbox 行与对应去重记录；只允许在事务内调用。 */
  private clearOutboxThrough(workerId: WorkerId, epoch: string, ackThrough: number): void {
    const keys = this.db.prepare('SELECT dedupe_key FROM transport_outbox WHERE worker_id=? AND delivery_epoch=? AND seq<=? AND dedupe_key IS NOT NULL').all(workerId, epoch, ackThrough) as Array<{ dedupe_key: string }>
    this.db.prepare('DELETE FROM transport_outbox WHERE worker_id=? AND delivery_epoch=? AND seq<=?').run(workerId, epoch, ackThrough)
    const dropDedupe = this.db.prepare('DELETE FROM transport_outbox_dedupe WHERE worker_id=? AND dedupe_key=?')
    for (const row of keys) dropDedupe.run(workerId, row.dedupe_key)
  }
  /**
   * An application receipt cannot remove an unacknowledged transport frame:
   * the transport ACK can be lost while the receipt arrives on the reverse
   * stream. Deleting the frame would leave a permanent sequence hole on
   * replay. The receiver deduplicates the original message and re-ACKs it;
   * acknowledge() eventually removes both the frame and its dedupe key.
   */
  discardCommand(_workerId: WorkerId, _commandId: string): void {
    // Kept as the receipt boundary; no outbox mutation until transport ACK.
  }
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
