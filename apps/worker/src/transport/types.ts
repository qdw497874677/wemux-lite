import type { WorkerPayload } from '@wemux/wire-protocol'

export type ConnectionState = 'stopped' | 'connecting' | 'open' | 'backoff' | 'needs-attention'

export interface StateChange {
  readonly previous: ConnectionState
  readonly current: ConnectionState
  readonly reason: string
  readonly attempt: number
  readonly retryInMs?: number
  /** 本次转换对应的地址：一个 transport 绑定一个地址，多候选目前只用于预检排序，不做运行期轮换。 */
  readonly endpoint?: string
}

export interface WorkerTransport {
  start(): void
  stop(): void
  send(payload: WorkerPayload): Promise<void>
}
