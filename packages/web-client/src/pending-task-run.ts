import type { LaunchRequest, LaunchResponse } from '@wemux/web-contract/task-platform'
import { randomId } from './random.ts'

export interface TaskRunScope { host: string; account: string; teamId: string; projectId: string; taskId: string }
export type TaskRunIntent = Omit<LaunchRequest, 'requestId'>
type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const operations = new WeakMap<PendingStorage, Map<string, Promise<LaunchResponse>>>()
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !value.includes('\0')
const validPrompt = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 100000 && !value.includes('\0') && new TextEncoder().encode(JSON.stringify(value)).length <= 200000
function valid(value: unknown): value is LaunchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>, a = v.assignment as Record<string, unknown> | null
  return Object.keys(v).every(key => ['requestId', 'prompt', 'mode', 'reuseSessionId', 'assignment'].includes(key))
    && text(v.requestId) && validPrompt(v.prompt)
    && (v.mode === 'new' ? v.reuseSessionId === null : v.mode === 'reuse' && text(v.reuseSessionId))
    && !!a && typeof a === 'object' && !Array.isArray(a)
    && Object.keys(a).every(key => ['workspaceId', 'workerId', 'agentKey', 'modelId'].includes(key))
    && ['workspaceId', 'workerId', 'agentKey'].every(key => text(a[key]))
    && text(a.modelId)
}
function validResponse(result: LaunchResponse, request: LaunchRequest, projectId: string, taskId: string): boolean {
  const run = result?.run
  return !!run && typeof run.id === 'string' && !!run.id && run.projectId === projectId && run.taskId === taskId
    && run.requestId === request.requestId && typeof run.sessionId === 'string' && !!run.sessionId
    && Number.isSafeInteger(run.attempt) && run.attempt > 0
    && ['pending', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(run.status)
    && !!run.request && run.request.requestId === request.requestId
    && run.request.mode === request.mode && run.request.prompt === request.prompt && run.request.reuseSessionId === request.reuseSessionId
    && !!run.request.assignment && ['workspaceId', 'workerId', 'agentKey', 'modelId'].every(key => (run.request.assignment as unknown as Record<string, unknown>)[key] === (request.assignment as unknown as Record<string, unknown>)[key])
    && !!run.snapshot && ['workspaceId', 'workerId', 'agentKey', 'modelId'].every(key => (run.snapshot as unknown as Record<string, unknown>)[key] === (request.assignment as unknown as Record<string, unknown>)[key])
}
/** A retained Run identity is a retry constraint, not an authorization grant.
 * Unknown responses keep the original request, even across a same-tab refresh.
 */
export class PendingTaskRun {
  readonly key: string
  private readonly projectId: string
  private readonly taskId: string
  private readonly storage: () => PendingStorage
  private readonly mint: () => string
  constructor(storage: () => PendingStorage, scope: TaskRunScope, mint = randomId) {
    if (Object.values(scope).some(value => !text(value))) throw Error('启动 Run 需要完整的账号与任务范围。')
    this.storage = storage; this.mint = mint
    this.projectId = scope.projectId; this.taskId = scope.taskId
    this.key = `wemux.task-run:${JSON.stringify([new URL(scope.host).origin, scope.account, scope.teamId, scope.projectId, scope.taskId])}`
  }
  read(): Readonly<LaunchRequest> | null {
    try {
      const raw = this.storage().getItem(this.key)
      if (raw === null) return null
      const value: unknown = JSON.parse(raw)
      if (!valid(value)) throw Error('invalid')
      return Object.freeze(value)
    } catch { throw Error('无法读取已保存的 Run 请求；请恢复浏览器存储后核对原请求，勿新建执行。') }
  }
  run(intent: () => TaskRunIntent | Promise<TaskRunIntent>, send: (body: LaunchRequest) => Promise<LaunchResponse>): Promise<LaunchResponse> {
    let storage: PendingStorage
    try { storage = this.storage() } catch { return Promise.reject(Error('无法读取已保存的 Run 请求；勿新建执行。')) }
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
  private async execute(intent: () => TaskRunIntent | Promise<TaskRunIntent>, send: (body: LaunchRequest) => Promise<LaunchResponse>) {
    let request = this.read()
    if (!request) {
      const selection = await intent()
      const retained = this.read()
      request = retained ?? Object.freeze({ ...selection, requestId: this.mint() }) as LaunchRequest
      if (!valid(request)) {
        if (retained) throw Error('已保存 Run 请求不符合当前限制；未发送。请核对原请求，勿创建新执行。')
        throw Error('Run 目标或执行环境不符合限制；尚未发送，也未保存请求。')
      }
      try {
        const storage = this.storage(), raw = JSON.stringify(request)
        storage.setItem(this.key, raw)
        if (storage.getItem(this.key) !== raw) throw Error('not persisted')
      } catch { throw Error('无法保存 Run 请求，尚未发送；请恢复浏览器存储。') }
    }
    const result = await send(request)
    if (!validResponse(result, request, this.projectId, this.taskId)) throw Error('Run 接收结果与原请求不符，已保留原身份，请核对。')
    try {
      if (this.read()?.requestId === request.requestId) {
        this.storage().removeItem(this.key)
        if (this.read()?.requestId === request.requestId) throw Error('not cleared')
      }
    } catch { throw Error('Run 已受理，但无法清除原请求；请恢复浏览器存储，勿新建执行。') }
    return result
  }
}
