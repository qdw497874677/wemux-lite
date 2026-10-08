import type { HumanReviewDecisionRequest, HumanReviewDecisionResponse } from '@wemux/web-contract/task-platform'
import { ApiError } from './errors.ts'

/** Only a definitive CAS rejection permits explicit retirement of a persisted decision. */
export class DecisionVersionConflict extends Error { constructor() { super('任务版本已变化；请放弃被拒绝的决定、重新核对并明确重新决定。') } }
import { randomId } from './random.ts'
import type { TaskRunScope } from './pending-task-run.ts'

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const flights = new WeakMap<Store, Map<string, Promise<HumanReviewDecisionResponse>>>()
// Joined flights and remounts share evidence only for this storage, scope and exact payload.
const rejected = new WeakMap<Store, Map<string, string>>()
const validString = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 200 && !value.includes('\0')
function valid(value: unknown): value is HumanReviewDecisionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  return Object.keys(body).every(key => ['version', 'requestId', 'reviewId', 'status', 'reason'].includes(key))
    && Number.isSafeInteger(body.version) && Number(body.version) > 0 && validString(body.requestId) && validString(body.reviewId)
    && (body.status === 'approved' || body.status === 'changes_requested')
    && (body.reason === undefined || typeof body.reason === 'string' && new TextEncoder().encode(body.reason).length <= 2000 && !body.reason.includes('\0'))
    && (body.status !== 'changes_requested' || typeof body.reason === 'string' && !!body.reason.trim())
}

const timestamp = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
function matches(result: HumanReviewDecisionResponse, body: HumanReviewDecisionRequest, scope: TaskRunScope, reviewerId: string) {
  const task = result?.task, review = result?.review
  if (!(task?.id === scope.taskId && task.projectId === scope.projectId
    && Number.isSafeInteger(task.version) && task.version === body.version + 1
    && review?.id === body.reviewId && review.taskId === scope.taskId && review.projectId === scope.projectId
    && validString(review.taskRunId) && validString(review.actor) && review.actor !== reviewerId
    && review.reviewer === reviewerId && review.status === body.status
    && timestamp(review.requestedAt) && timestamp(review.decidedAt) && timestamp(review.closedAt)
    && Date.parse(review.requestedAt) <= Date.parse(review.decidedAt) && review.closedAt === review.decidedAt
    && timestamp(task.createdAt) && timestamp(task.updatedAt) && timestamp(task.lastActivityAt)
    && Date.parse(task.createdAt) <= Date.parse(review.requestedAt)
    && task.updatedAt === review.decidedAt && task.lastActivityAt === review.decidedAt)) return false
  if (body.status === 'approved' && task.status === 'in_review') {
    // Staged advance: the decided stage closes and an unread successor review becomes current.
    return validString(task.currentReviewId) && task.currentReviewId !== review.id
  }
  return task.currentReviewId === null && task.status === (body.status === 'approved' ? 'done' : 'in_progress')
}

/** A decision is persisted before sending. Unknown outcomes must replay the same reviewer, review and CAS version. */
export class PendingHumanDecision {
  readonly key: string
  private readonly storage: () => Store
  private readonly scope: TaskRunScope
  private readonly mint: () => string
  private readonly reviewerId: string
  constructor(storage: () => Store, scope: TaskRunScope, reviewerId: string, mint = randomId) {
    this.storage = storage; this.scope = scope; this.reviewerId = reviewerId; this.mint = mint
    if (!validString(reviewerId)) throw Error('审查决定需要已验证的用户身份。')
    if (Object.values(scope).some(value => !validString(value))) throw Error('审查决定需要完整的账号与任务范围。')
    this.key = `wemux.human-decision:${JSON.stringify([new URL(scope.host).origin, scope.account, scope.teamId, scope.projectId, scope.taskId])}`
  }
  read(): Readonly<HumanReviewDecisionRequest> | null {
    try {
      const storage = this.storage(), raw = storage.getItem(this.key)
      if (rejected.get(storage)?.get(this.key) !== raw) rejected.get(storage)?.delete(this.key)
      if (raw === null) return null
      const body: unknown = JSON.parse(raw)
      if (!valid(body)) throw Error('invalid')
      return Object.freeze(body)
    } catch { throw Error('无法读取待确认的审查决定；请恢复存储，勿发起新决定。') }
  }
  discardRejected(): void {
    const storage = this.storage()
    if (flights.get(storage)?.has(this.key)) throw Error('审查决定正在发送；不能放弃。')
    const body = this.read()
    if (!body || JSON.stringify(body) !== rejected.get(storage)?.get(this.key)) throw Error('只有明确因版本冲突被拒绝的原决定可放弃。')
    storage.removeItem(this.key)
    if (storage.getItem(this.key) !== null) throw Error('无法清除被拒绝的决定；请恢复存储。')
    rejected.get(storage)?.delete(this.key)
  }
  run(intent: () => Omit<HumanReviewDecisionRequest, 'requestId'>, send: (body: HumanReviewDecisionRequest) => Promise<HumanReviewDecisionResponse>): Promise<HumanReviewDecisionResponse> {
    let storage: Store
    try { storage = this.storage() } catch { return Promise.reject(Error('无法读取审查决定存储；未发送。')) }
    let active = flights.get(storage)
    if (!active) { active = new Map(); flights.set(storage, active) }
    const existing = active.get(this.key)
    if (existing) return existing
    const flight = Promise.resolve().then(() => this.execute(intent, send)).finally(() => {
      active.delete(this.key)
      if (!active.size) flights.delete(storage)
    })
    active.set(this.key, flight)
    return flight
  }
  private async execute(intent: () => Omit<HumanReviewDecisionRequest, 'requestId'>, send: (body: HumanReviewDecisionRequest) => Promise<HumanReviewDecisionResponse>) {
    let body = this.read()
    if (!body) {
      body = Object.freeze({ ...intent(), requestId: this.mint() }) as HumanReviewDecisionRequest
      if (!valid(body)) throw Error('审查决定格式不正确；未发送。')
      try {
        const raw = JSON.stringify(body)
        this.storage().setItem(this.key, raw)
        if (this.storage().getItem(this.key) !== raw) throw Error('not persisted')
      } catch { throw Error('无法保存审查决定；未发送。') }
    }
    const storage = this.storage()
    // A later uncertain retry must not inherit an earlier definitive rejection.
    rejected.get(storage)?.delete(this.key)
    let result: HumanReviewDecisionResponse
    try { result = await send(body) } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.code === 'version_conflict') {
        const raw = storage.getItem(this.key)
        if (raw !== JSON.stringify(body)) throw Error('审查决定身份已变化；保留原请求，重新核对后重试。')
        let entries = rejected.get(storage)
        if (!entries) { entries = new Map(); rejected.set(storage, entries) }
        entries.set(this.key, raw)
        throw new DecisionVersionConflict()
      }
      // Other conflicts may be receipt mismatches or concurrent outcomes. Preserve original identity.
      if (cause instanceof ApiError && cause.status === 409) throw Error(`审查决定未确认（${cause.code}）；请刷新核对，必要时重试原请求。`)
      throw cause
    }
    if (this.storage().getItem(this.key) !== JSON.stringify(body)) throw Error('审查决定身份已变化；保留原请求。')
    if (!matches(result, body, this.scope, this.reviewerId)) throw Error('审查决定回执与原请求不符；保留原请求。')
    try {
      this.storage().removeItem(this.key)
      if (this.storage().getItem(this.key) !== null) throw Error('not removed')
    } catch { throw Error('审查决定已受理，但无法清除原请求；请恢复存储，勿新建决定。') }
    return result
  }
}
