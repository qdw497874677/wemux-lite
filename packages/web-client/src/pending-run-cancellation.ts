import type { CancelRunResponse } from '@wemux/web-contract/task-platform'
import { randomId } from './random.ts'
import type { TaskRunScope } from './pending-task-run.ts'

type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export interface RunCancellationScope extends TaskRunScope { runId: string; sessionId: string }
const operations = new WeakMap<StoragePort, Map<string, Promise<CancelRunResponse>>>()
const bounded = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 200 && !value.includes('\0')
/** Keep an ambiguous cancellation identity across same-tab refresh; never grant authority from storage. */
export class PendingRunCancellation {
  readonly key: string
  private readonly storage: () => StoragePort
  private readonly mint: () => string
  private readonly scope: RunCancellationScope
  constructor(storage: () => StoragePort, scope: RunCancellationScope, mint = randomId) {
    if (Object.values(scope).some(value => !bounded(value))) throw Error('取消 Run 需要完整的账号与执行范围。')
    this.storage = storage; this.mint = mint; this.scope = scope
    this.key = `wemux.run-cancel:${JSON.stringify([new URL(scope.host).origin, scope.account, scope.teamId, scope.projectId, scope.taskId, scope.runId, scope.sessionId])}`
  }
  read(): string | null {
    try {
      const raw = this.storage().getItem(this.key)
      if (raw === null) return null
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !bounded((value as { requestId?: unknown }).requestId)) throw Error('invalid')
      return (value as { requestId: string }).requestId
    } catch { throw Error('无法读取原取消请求；请恢复浏览器存储并核对，勿创建新请求。') }
  }
  run(send: (requestId: string) => Promise<CancelRunResponse>): Promise<CancelRunResponse> {
    let storage: StoragePort
    try { storage = this.storage() } catch { return Promise.reject(Error('无法读取原取消请求；未发送。')) }
    let active = operations.get(storage)
    if (!active) { active = new Map(); operations.set(storage, active) }
    const existing = active.get(this.key)
    if (existing) return existing
    const flight = Promise.resolve().then(() => this.execute(send)).finally(() => {
      active.delete(this.key)
      if (!active.size) operations.delete(storage)
    })
    active.set(this.key, flight)
    return flight
  }
  private async execute(send: (requestId: string) => Promise<CancelRunResponse>) {
    let requestId = this.read()
    if (!requestId) {
      requestId = this.mint()
      if (!bounded(requestId)) throw Error('取消请求标识无效，未发送。')
      try {
        const storage = this.storage(), raw = JSON.stringify({ requestId })
        storage.setItem(this.key, raw)
        if (storage.getItem(this.key) !== raw) throw Error('not persisted')
      } catch { throw Error('无法保存取消请求，尚未发送；请恢复浏览器存储。') }
    }
    const result = await send(requestId)
    const run = result?.run, scope = this.scope
    const validTimestamp = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
    if (!run || run.id !== scope.runId || run.sessionId !== scope.sessionId || run.taskId !== scope.taskId || run.projectId !== scope.projectId
      || !(['cancelling', 'cancelled'].includes(run.status) && validTimestamp(run.cancelRequestedAt) || ['succeeded', 'failed'].includes(run.status) && (run.cancelRequestedAt === null || validTimestamp(run.cancelRequestedAt)))) throw Error('取消回执与原 Run 不符；已保留请求标识，请刷新记录后重试。')
    try {
      if (this.read() === requestId) {
        this.storage().removeItem(this.key)
        if (this.read() === requestId) throw Error('not cleared')
      }
    } catch { throw Error('取消回执已返回，但无法清除原请求；请恢复浏览器存储，勿新建请求。') }
    return result
  }
}
