import type { WorkerPayload } from '@wemux/wire-protocol'

export type ConnectionState = 'stopped' | 'connecting' | 'open' | 'backoff' | 'needs-attention'

export interface StateChange {
  readonly previous: ConnectionState
  readonly current: ConnectionState
  readonly reason: string
  readonly attempt: number
  readonly retryInMs?: number
}

export interface WorkerTransport {
  start(): void
  stop(): void
  send(payload: WorkerPayload): Promise<void>
}
