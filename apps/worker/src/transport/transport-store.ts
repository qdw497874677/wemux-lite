import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MessageId, Timestamp, WorkerId } from '@wemux/domain'
import type {
  ServerDataFrame,
  ServerHelloFrame,
  ServerTransportAckFrame,
  WorkerDataFrame,
  WorkerHelloFrame,
  WorkerPayload,
  WorkerTransportAckFrame,
} from '@wemux/wire-protocol'

const now = () => new Date().toISOString() as Timestamp

export class WorkerTransportStore {
  private readonly database: DatabaseSync
  private readonly outboundEpoch: string

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS transport_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transport_outbox (
        seq INTEGER PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_sent_at TEXT
      );
      CREATE TABLE IF NOT EXISTS transport_inbox (
        delivery_epoch TEXT NOT NULL,
        seq INTEGER NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        received_at TEXT NOT NULL,
        PRIMARY KEY (delivery_epoch, seq)
      );
    `)
    this.outboundEpoch = this.meta('outbound_epoch') ?? this.setMeta('outbound_epoch', randomUUID())
  }

  workerHello(input: Omit<WorkerHelloFrame, 'frameType' | 'side' | 'transport' | 'features' | 'resume'>): WorkerHelloFrame {
    const inboundEpoch = this.meta('inbound_epoch')
    const logicalConnectionId = this.meta('logical_connection_id')
    return {
      frameType: 'transport.hello', side: 'worker',
      transport: { supportedMajors: [2], preferredMinorByMajor: { '2': 0 } },
      features: ['durable-ack', 'bounded-replay'],
      ...input,
      resume: {
        logicalConnectionId,
        workerToServer: { deliveryEpoch: this.outboundEpoch, ackThrough: this.outboundAckThrough() },
        serverToWorker: inboundEpoch ? { deliveryEpoch: inboundEpoch, ackThrough: this.inboundAckThrough(inboundEpoch) } : null,
      },
    }
  }

  async acceptServerHello(frame: ServerHelloFrame): Promise<void> {
    const serverCursor = frame.authoritativeCursors.workerToServer
    const inbound = frame.authoritativeCursors.serverToWorker
    if (serverCursor.deliveryEpoch !== this.outboundEpoch && serverCursor.ackThrough > 0) throw new Error('transport integrity error: server acknowledged unknown worker delivery epoch')
    const lastOutbound = Number(this.meta('outbound_last_seq') ?? '0')
    if (serverCursor.deliveryEpoch === this.outboundEpoch && serverCursor.ackThrough > lastOutbound) throw new Error('transport integrity error: server cursor ahead of enqueued worker outbound')
    // The receive cursor records locally committed durable frames. A Server
    // cursor may lag when its ACK from us was lost; rolling this cursor back
    // makes replay of the same messageId look like an integrity violation.
    // Only a genuinely new epoch starts from the Server's advertised base.
    const storedInbound = this.meta(`inbound_ack:${inbound.deliveryEpoch}`)
    if (storedInbound !== null && inbound.ackThrough > Number(storedInbound)) throw new Error('transport integrity error: server cursor ahead of committed worker inbound cursor')
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.setMeta('logical_connection_id', frame.logicalConnectionId)
      this.database.prepare('UPDATE transport_outbox SET last_sent_at = NULL').run()
      if (serverCursor.deliveryEpoch === this.outboundEpoch) this.setOutboundAckThrough(serverCursor.ackThrough)
      if (this.meta('inbound_epoch') !== inbound.deliveryEpoch) {
        this.setMeta('inbound_epoch', inbound.deliveryEpoch)
        if (storedInbound === null) this.setMeta(`inbound_ack:${inbound.deliveryEpoch}`, String(inbound.ackThrough))
      }
      this.database.exec('COMMIT')
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  async enqueue(payload: WorkerPayload): Promise<MessageId> {
    const lastSequence = Number(this.meta('outbound_last_seq') ?? '0')
    const sequence = lastSequence + 1
    const messageId = randomUUID() as MessageId
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare('INSERT INTO transport_outbox(seq, message_id, payload_json, created_at) VALUES (?, ?, ?, ?)').run(sequence, messageId, JSON.stringify(payload), now())
      this.setMeta('outbound_last_seq', String(sequence))
      this.database.exec('COMMIT')
      return messageId
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async pendingOutbound(limit: number): Promise<readonly WorkerDataFrame[]> {
    const ackThrough = this.outboundAckThrough()
    const rows = this.database.prepare('SELECT seq, message_id, payload_json FROM transport_outbox WHERE seq > ? AND last_sent_at IS NULL ORDER BY seq LIMIT ?').all(ackThrough, limit) as Array<{ seq: number; message_id: string; payload_json: string }>
    return rows.map((row) => ({
      frameType: 'data', durability: 'durable', deliveryEpoch: this.outboundEpoch,
      directionSeq: row.seq, messageId: row.message_id as MessageId, lane: 'journal',
      payloadVersion: 'wemux.worker.payload.v1', expiresAt: null,
      payload: JSON.parse(row.payload_json) as WorkerPayload,
    }))
  }

  async markOutboundSent(frame: WorkerDataFrame): Promise<void> {
    if (frame.durability === 'durable') this.database.prepare('UPDATE transport_outbox SET last_sent_at = ? WHERE seq = ?').run(now(), frame.directionSeq)
  }

  async acknowledgeOutbound(frame: ServerTransportAckFrame): Promise<void> {
    if (frame.deliveryEpoch !== this.outboundEpoch) return
    this.setOutboundAckThrough(frame.ackThrough)
    this.database.prepare('DELETE FROM transport_outbox WHERE seq <= ?').run(frame.ackThrough)
  }

  /**
   * A non-retryable data rejection refers to the oldest unacknowledged frame because
   * Worker sends durable frames in order and Server rejects at that sequence boundary.
   * Advance the durable cursor together with deletion so the next reconnect cannot
   * recreate a gap behind the discarded frame.
   */
  async dropOldestUnacked(): Promise<{ readonly seq: number; readonly payload: WorkerPayload } | null> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.database.prepare('SELECT seq, payload_json FROM transport_outbox WHERE seq > ? ORDER BY seq LIMIT 1').get(this.outboundAckThrough()) as { seq: number; payload_json: string } | undefined
      if (!row) { this.database.exec('COMMIT'); return null }
      this.database.prepare('DELETE FROM transport_outbox WHERE seq = ?').run(row.seq)
      this.setOutboundAckThrough(row.seq)
      this.database.exec('COMMIT')
      return { seq: row.seq, payload: JSON.parse(row.payload_json) as WorkerPayload }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async acceptInbound(frame: Extract<ServerDataFrame, { readonly durability: 'durable' }>): Promise<{ readonly isNew: boolean; readonly ack: WorkerTransportAckFrame }> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const epoch = this.meta('inbound_epoch')
      if (epoch !== frame.deliveryEpoch) throw new Error('Unexpected delivery epoch')
      const current = this.inboundAckThrough(frame.deliveryEpoch)
      if (frame.directionSeq <= current) {
        this.database.exec('COMMIT')
        return { isNew: false, ack: { frameType: 'transport.ack', deliveryEpoch: frame.deliveryEpoch, ackThrough: current } }
      }
      if (frame.directionSeq !== current + 1) throw new Error(`transport gap: expected ${current + 1}, received ${frame.directionSeq}`)
      const existing = this.database.prepare('SELECT 1 FROM transport_inbox WHERE message_id = ?').get(frame.messageId)
      if (existing) throw new Error(`transport integrity error: message ${frame.messageId} reused`)
      this.database.prepare('INSERT INTO transport_inbox(delivery_epoch, seq, message_id, received_at) VALUES (?, ?, ?, ?)').run(frame.deliveryEpoch, frame.directionSeq, frame.messageId, now())
      this.setMeta(`inbound_ack:${frame.deliveryEpoch}`, String(frame.directionSeq))
      const isNew = true
      this.database.exec('COMMIT')
      return { isNew, ack: { frameType: 'transport.ack', deliveryEpoch: frame.deliveryEpoch, ackThrough: this.inboundAckThrough(frame.deliveryEpoch) } }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  close(): void { this.database.close() }

  private outboundAckThrough(): number { return Number(this.meta(`outbound_ack:${this.outboundEpoch}`) ?? '0') }
  private setOutboundAckThrough(value: number): void {
    const current = this.outboundAckThrough()
    if (value > current) this.setMeta(`outbound_ack:${this.outboundEpoch}`, String(value))
  }
  private inboundAckThrough(epoch: string): number { return Number(this.meta(`inbound_ack:${epoch}`) ?? '0') }
  private meta(key: string): string | null {
    const row = this.database.prepare('SELECT value FROM transport_meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }
  private setMeta(key: string, value: string): string {
    this.database.prepare('INSERT INTO transport_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
    return value
  }
}
