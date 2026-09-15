import type { LaunchRequest, TaskDetail } from '@wemux/web-contract/task-platform'

export const taskPrompt = (task: Pick<TaskDetail, 'title' | 'description' | 'acceptanceCriteria'>) => `任务：${task.title}\n\n描述：\n${task.description}\n\n验收标准：\n${task.acceptanceCriteria ?? ''}`

export interface LaunchDraft { prompt: string; request: LaunchRequest | null; status: 'draft' | 'unknown' | 'confirmed' | 'rejected' }
/** Same-tab reload durable; never stores credentials. Unknown identities must be replayed before replacement. */
export class LaunchIdentity {
  value: LaunchDraft
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  private readonly key: string
  constructor(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, prompt: string) {
    this.storage = storage; this.key = key
    const saved = storage.getItem(key)
    this.value = saved ? JSON.parse(saved) : { prompt, request: null, status: 'draft' }
    if (!this.value || typeof this.value.prompt !== 'string' || !['draft', 'unknown', 'confirmed', 'rejected'].includes(this.value.status)) throw Error('保存的 Run 身份无法读取；请勿新建尝试')
  }
  private save(value: LaunchDraft) { this.storage.setItem(this.key, JSON.stringify(value)); this.value = value }
  edit(prompt: string) { this.save({ ...this.value, prompt }) }
  freeze(request: LaunchRequest) { this.save({ ...this.value, request: structuredClone(request), status: 'unknown' }); return this.value.request! }
  settle(status: 'confirmed' | 'rejected') { this.save({ ...this.value, status }) }
  reconfirm() {
    if (this.value.status === 'unknown') throw Error('原请求结果未知；请先重试核对原身份')
    this.save({ ...this.value, request: null, status: 'draft' })
  }
}

/** A response may persist identity after navigation, but may only navigate its original view generation. */
export class LaunchView {
  private generation = 0
  private route = ''
  update(route: string) { if (route !== this.route) { this.route = route; this.generation++ } }
  leave() { this.generation++ }
  capture() { const generation = this.generation; return () => generation === this.generation }
}
