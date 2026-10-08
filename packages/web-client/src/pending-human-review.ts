import type { HumanReviewSubmissionRequest, HumanReviewSubmissionResponse } from '@wemux/web-contract/task-platform'
import { randomId } from './random.ts'
import { ApiError } from './errors.ts'
import type { TaskRunScope } from './pending-task-run.ts'

type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const operations = new WeakMap<PendingStorage, Map<string, Promise<HumanReviewSubmissionResponse>>>()
// A definitive CAS rejection is only valid for this exact stored request and storage instance.
const rejected = new WeakMap<PendingStorage, Map<string, string>>()
const scoped = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 200 && !value.includes('\0')
function valid(value: unknown): value is HumanReviewSubmissionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).every(key => ['requestId', 'version', 'runId', 'summary', 'evidence'].includes(key)) && scoped(v.requestId)
    && Number.isSafeInteger(v.version) && Number(v.version) > 0 && scoped(v.runId)
    && typeof v.summary === 'string' && !!v.summary.trim() && !v.summary.includes('\0') && new TextEncoder().encode(v.summary).length <= 16000
    && Array.isArray(v.evidence) && v.evidence.length <= 20 && v.evidence.every(item => typeof item === 'string' && !!item.trim() && !item.includes('\0') && new TextEncoder().encode(item).length <= 2000)
}
function matches(result: HumanReviewSubmissionResponse, request: HumanReviewSubmissionRequest, projectId: string, taskId: string) {
  return result?.runId === request.runId && result.task?.id === taskId && result.task?.projectId === projectId
    && result.task?.status === 'in_review' && scoped(result.review?.id) && result.task?.currentReviewId === result.review?.id
    && result.review?.projectId === projectId && result.review?.taskId === taskId && result.review?.taskRunId === request.runId
    && result.review?.status === 'requested' && scoped(result.review?.actor) && result.review?.reviewer === null
    && result.review?.decidedAt === null && result.review?.closedAt === null
}
/** Unknown response keeps the exact request in this tab; a replay rechecks current server authority. */
export class ReviewVersionConflict extends Error { constructor(message: string) { super(message); this.name = 'ReviewVersionConflict' } }

export class PendingHumanReview {
  readonly key: string
  private readonly storage: () => PendingStorage
  private readonly projectId: string
  private readonly taskId: string
  private readonly mint: () => string
  constructor(storage: () => PendingStorage, scope: TaskRunScope, mint = randomId) {
    if (Object.values(scope).some(value => !scoped(value))) throw Error('人工审查需要完整的账号与任务范围。')
    this.storage = storage; this.mint = mint
    this.projectId = scope.projectId; this.taskId = scope.taskId
    this.key = `wemux.human-review:${JSON.stringify([new URL(scope.host).origin, scope.account, scope.teamId, scope.projectId, scope.taskId])}`
  }
  read(): Readonly<HumanReviewSubmissionRequest> | null {
    try {
      const raw = this.storage().getItem(this.key)
      if (raw === null) return null
      const request: unknown = JSON.parse(raw)
      if (!valid(request)) throw Error('invalid')
      return Object.freeze(request)
    } catch { throw Error('无法读取待确认的人工审查请求；请恢复浏览器存储，勿以新请求重试。') }
  }
  /** Explicit user reconfirmation after the authoritative server rejected this exact CAS version. */
  discardRejected(requestId: string): void {
    let storage: PendingStorage
    try { storage = this.storage() } catch { throw Error('无法读取审查请求存储；不能放弃原请求。') }
    if (operations.get(storage)?.has(this.key)) throw Error('审查请求仍在发送；不能放弃原请求。')
    const current = this.read()
    if (!current || current.requestId !== requestId) throw Error('原审查请求已变化；请重新核对。')
    const raw = storage.getItem(this.key)
    if (!raw || rejected.get(storage)?.get(this.key) !== raw) throw Error('原请求结果尚未确定；不能放弃原请求。')
    try {
      storage.removeItem(this.key)
      if (storage.getItem(this.key) !== null) throw Error('not cleared')
      rejected.get(storage)?.delete(this.key)
    } catch { throw Error('无法清除已拒绝的审查请求；请恢复浏览器存储后重试。') }
  }
  run(intent: () => Omit<HumanReviewSubmissionRequest, 'requestId'>, send: (body: HumanReviewSubmissionRequest) => Promise<HumanReviewSubmissionResponse>): Promise<HumanReviewSubmissionResponse> {
    let storage: PendingStorage
    try { storage = this.storage() } catch { return Promise.reject(Error('无法读取人工审查请求存储；未发送。')) }
    let active = operations.get(storage)
    if (!active) { active = new Map(); operations.set(storage, active) }
    const existing = active.get(this.key)
    if (existing) return existing
    const flight = Promise.resolve().then(() => this.execute(intent, send)).finally(() => {
      active.delete(this.key)
      if (!active.size) operations.delete(storage)
    })
    active.set(this.key, flight)
    return flight
  }
  private async execute(intent: () => Omit<HumanReviewSubmissionRequest, 'requestId'>, send: (body: HumanReviewSubmissionRequest) => Promise<HumanReviewSubmissionResponse>) {
    let request = this.read()
    if (!request) {
      request = Object.freeze({ ...intent(), requestId: this.mint() }) as HumanReviewSubmissionRequest
      if (!valid(request)) throw Error('审查成果或证据不符合限制；未发送。')
      try {
        const raw = JSON.stringify(request), storage = this.storage()
        storage.setItem(this.key, raw)
        if (storage.getItem(this.key) !== raw) throw Error('not persisted')
        rejected.get(storage)?.delete(this.key)
      } catch { throw Error('无法保存人工审查请求；未发送。') }
    }
    const storage = this.storage()
    // Never retain an older rejection after a later uncertain response to the same request.
    rejected.get(storage)?.delete(this.key)
    let result: HumanReviewSubmissionResponse
    try { result = await send(request) } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.code === 'version_conflict') {
        const raw = storage.getItem(this.key)
        if (raw && JSON.stringify(request) === raw) {
          let entries = rejected.get(storage)
          if (!entries) { entries = new Map(); rejected.set(storage, entries) }
          entries.set(this.key, raw)
        }
        throw new ReviewVersionConflict(cause.message)
      }
      throw cause
    }
    if (storage.getItem(this.key) !== JSON.stringify(request)) throw Error('审查请求身份已变化；保留原请求，请核对。')
    if (!matches(result, request, this.projectId, this.taskId)) throw Error('人工审查回执与原请求不符；保留原请求，请核对。')
    try {
      if (this.read()?.requestId === request.requestId) {
        storage.removeItem(this.key)
        if (this.read()?.requestId === request.requestId) throw Error('not cleared')
        rejected.get(storage)?.delete(this.key)
      }
    } catch { throw Error('人工审查已受理，但无法清除原请求；请恢复浏览器存储，勿新建请求。') }
    return result
  }
}
