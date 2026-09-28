import type { ApprovalDecisionResult, ApprovalView } from '@wemux/server-domain'
import type { Timestamp, UserId } from '@wemux/domain'

export interface ApprovalDecisionReceipt {
  readonly actorId: UserId
  readonly requestId: string
  readonly fingerprint: string
  readonly result: ApprovalDecisionResult
  readonly createdAt: Timestamp
}

export interface ApprovalDecisionRepository {
  getReceipt(actorId: UserId, requestId: string, now: Timestamp): Promise<ApprovalDecisionReceipt | null>
  save(receipt: ApprovalDecisionReceipt, overlay: ApprovalView, expiresAt: Timestamp): Promise<void>
  listOverlays(now: Timestamp): Promise<readonly ApprovalView[]>
  purgeExpired(now: Timestamp): Promise<number>
  close(): void
}
