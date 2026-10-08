import type { CreateTaskSessionRequest, CreateTaskSessionResponse } from '@wemux/web-contract/task-platform'
import { randomId } from './random.ts'

export interface TaskSessionScope { host: string; account: string; teamId: string; projectId: string; taskId: string }
export interface DedicatedSessionScope { host: string; account: string; teamId: string; projectId: string; scenario: 'quick-chat' | 'agent-test' }
type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
// Same JS realm and storage object only: no cross-tab exactly-once guarantee.
// Entries live from intent lookup through settlement, not for the lifetime of a view.
const operations = new WeakMap<PendingStorage, Map<string, Promise<CreateTaskSessionResponse>>>()
type WithoutRequestId<T> = T extends unknown ? Omit<T, 'requestId'> : never
export type TaskSessionIntent = WithoutRequestId<CreateTaskSessionRequest>
const text = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 200 && !value.includes('\0')
function valid(value: unknown): value is CreateTaskSessionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (!text(v.requestId) || !text(v.title) || Object.keys(v).some(k => !['requestId', 'title', 'workspaceId', 'workerId', 'agentKey', 'modelId'].includes(k))) return false
  const selection = ['workspaceId', 'workerId', 'agentKey', 'modelId'].some(k => k in v)
  return !selection || (['workspaceId', 'workerId', 'agentKey'].every(k => text(v[k])) && (v.modelId === undefined || v.modelId === null || text(v.modelId)))
}
/** Same-tab refresh durability, not authorization. Never replace an unknown request, even on HTTP errors.
 * Pass a lazy getter for the same storage object so denied storage fails before sending.
 */
export class PendingTaskSession {
  readonly key: string
  constructor(privateStorage: () => PendingStorage, scope: TaskSessionScope | DedicatedSessionScope, mint = randomId) {
    if (Object.values(scope).some(v => !v)) throw Error('创建会话需要完整的账号与任务范围。')
    this.storage = privateStorage; this.mint = mint
    const dedicated = 'scenario' in scope
    if (dedicated && (!['quick-chat', 'agent-test'].includes(scope.scenario) || 'taskId' in scope)) throw Error('专用会话需要有效场景。')
    this.key = `${dedicated ? 'wemux.dedicated-session' : 'wemux.task-session'}:${JSON.stringify([new URL(scope.host).origin, scope.account, scope.teamId, scope.projectId, dedicated ? scope.scenario : scope.taskId])}`
  }
  private readonly storage: () => PendingStorage
  private readonly mint: () => string
  read(): Readonly<CreateTaskSessionRequest> | null {
    try {
      const raw = this.storage().getItem(this.key)
      if (raw === null) return null
      const value: unknown = JSON.parse(raw)
      if (!valid(value)) throw Error('invalid')
      return Object.freeze(value)
    } catch { throw Error('无法读取已保存的创建请求；请恢复浏览器存储后重试，勿新建请求。') }
  }
  /** Duplicate clicks share the same in-flight operation; intent is evaluated only when no request exists. */
  run(intent: () => Promise<TaskSessionIntent> | TaskSessionIntent, send: (body: CreateTaskSessionRequest) => Promise<CreateTaskSessionResponse>): Promise<CreateTaskSessionResponse> {
    let storage: PendingStorage
    try { storage = this.storage() }
    catch { return Promise.reject(Error('无法读取已保存的创建请求；请恢复浏览器存储后重试，勿新建请求。')) }
    let active = operations.get(storage)
    if (!active) { active = new Map(); operations.set(storage, active) }
    const existing = active.get(this.key)
    if (existing) return existing
    // Register before invoking storage methods, intent or send: each can synchronously reenter.
    const flight = Promise.resolve().then(() => this.execute(intent, send)).finally(() => {
      active.delete(this.key)
      if (active.size === 0) operations.delete(storage)
    })
    active.set(this.key, flight)
    return flight
  }
  private async execute(intent: () => Promise<TaskSessionIntent> | TaskSessionIntent, send: (body: CreateTaskSessionRequest) => Promise<CreateTaskSessionResponse>) {
    let request = this.read()
    if (!request) {
      const selection = await intent()
      // Another view may have persisted the same intent while capability discovery was in flight.
      request = this.read() ?? Object.freeze({ ...selection, requestId: this.mint() }) as CreateTaskSessionRequest
      if (!valid(request)) throw Error('创建会话需要有效标题与完整执行环境。')
      try {
        const storage = this.storage(), raw = JSON.stringify(request)
        storage.setItem(this.key, raw)
        if (storage.getItem(this.key) !== raw) throw Error('not persisted')
      } catch { throw Error('无法保存创建请求，尚未发送；请恢复浏览器存储后重试。') }
    }
    const result = await send(request)
    try {
      // An older view's concurrent replay must not erase a newer explicit intent.
      if (this.read()?.requestId === request.requestId) {
        this.storage().removeItem(this.key)
        if (this.read()?.requestId === request.requestId) throw Error('not cleared')
      }
    }
    catch { throw Error('会话已创建，但无法清除原请求；请恢复浏览器存储后重试核对，勿新建请求。') }
    return result
  }
}
