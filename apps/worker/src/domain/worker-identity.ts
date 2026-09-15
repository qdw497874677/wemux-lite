import type { Timestamp, WorkerId } from '@wemux/domain'

/** The credential reference resolves only inside Worker-local secret storage. */
export interface WorkerIdentity {
  readonly workerId: WorkerId
  readonly serverUrl: string
  /** 全部候选连接地址（含 serverUrl）；旧身份没有此字段时退回 [serverUrl]。 */
  readonly serverUrls?: readonly string[]
  /** 注册时上报的名称；start 时优先使用，避免 hostname 覆盖。 */
  readonly name?: string
  readonly credentialRef: string
  readonly enrolledAt: Timestamp
}
