import type { SendMessageDTO } from '../../api/dto'
import { randomId } from '../../lib/random.ts'
import type { Api } from '../../api/client'

export interface SubmissionState {
  draft: string; version: number; pending: boolean; error: string
  echoes: SendMessageDTO[];
  attempt: SendMessageDTO | null; receipt: { id: string; status: string } | null
}
/** Connection-owned uncertain submissions survive view unmounts; abort is not retraction. */
export class SubmissionController {
  state: SubmissionState = { echoes: [], draft: '', version: 0, pending: false, error: '', attempt: null, receipt: null }
  private listeners = new Set<() => void>()
  private observer?: AbortController
  private generation = 0
  private disposed = false
  private api: Pick<Api, 'send' | 'command'>
  private sessionId: string
  private uuid: () => string
  constructor(api: Pick<Api, 'send' | 'command'>, sessionId: string, uuid = () => randomId()) { this.api = api; this.sessionId = sessionId; this.uuid = uuid }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  private update(patch: Partial<SubmissionState>) { if (!this.disposed) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()) } }
  edit = (draft: string) => this.update({ draft, version: this.state.version + 1, error: '' })
  confirm(ids: string[]) {
    const echoes = this.state.echoes.filter(item => !ids.includes(item.messageId))
    if (echoes.length !== this.state.echoes.length) this.update({ echoes })
 if ((this.state.attempt && ids.includes(this.state.attempt.messageId)) || (this.state.receipt && ids.includes(this.state.receipt.id))) {
      this.generation++; this.observer?.abort()
      this.update({ attempt: null, receipt: null, pending: false, error: '' })
    } }
  dispose() { this.disposed = true; this.generation++; this.observer?.abort(); this.listeners.clear(); this.state = { echoes: [], draft: '', version: 0, pending: false, error: '', attempt: null, receipt: null } }
  async send() {
    if (this.disposed || this.state.pending || !this.state.draft.trim()) return
    this.observer?.abort()
    const controller = new AbortController(); this.observer = controller
    const generation = ++this.generation
    const current = () => !this.disposed && generation === this.generation && !controller.signal.aborted
    const content = this.state.draft.trim()
    const body = this.state.attempt?.content === content ? this.state.attempt : { commandId: this.uuid(), messageId: this.uuid(), content }
    const version = this.state.version
    // Invoke before clearing the editor: synchronous rejection means no send began.
    let request: ReturnType<Api['send']>
    try { request = this.api.send(this.sessionId, body, controller.signal) }
    catch (error) { this.update({ error: error instanceof Error ? error.message : '无法开始发送' }); return }
    this.update({ attempt: body, echoes: [...this.state.echoes.filter(item => item.messageId !== body.messageId), body], draft: '', pending: true, error: '' })
    const restore = () => { if (this.state.version === version) this.update({ draft: body.content }) }
    try {
      const result = await request
      if (!current()) return
      if (result.commandId !== body.commandId || result.messageId !== body.messageId) throw new Error('发送响应身份不匹配')
      if (['rejected', 'failed'].includes(result.status)) { restore(); this.update({ attempt: null, echoes: this.state.echoes.filter(item => item.messageId !== body.messageId), error: '消息被拒绝。' }); return }
      this.update({ pending: false, receipt: { id: result.messageId, status: result.status } })
      for (let check = 0; check < 30 && current(); check++) {
        if (check) await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException('Disposed', 'AbortError')) }
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve() }, 1000)
          controller.signal.addEventListener('abort', abort, { once: true })
        })
        if (!current()) return
        const receipt = await this.api.command(body.commandId, controller.signal)
        if (!current()) return
        if (receipt.status === 'accepted') { this.update({ attempt: null, receipt: null }); return }
        if (receipt.status === 'rejected') { restore(); this.update({ attempt: null, receipt: null, echoes: this.state.echoes.filter(item => item.messageId !== body.messageId), error: `消息被拒绝：${receipt.receipt?.error?.message ?? '未知原因'}` }); return }
      }
    } catch (error) {
      if (!current()) return
      restore()
      const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : undefined
      const rejected = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
      this.update({ attempt: rejected ? null : body, echoes: rejected ? this.state.echoes.filter(item => item.messageId !== body.messageId) : this.state.echoes, error: rejected ? '服务端明确拒绝请求。' : '发送结果尚未确认；重试将复用原请求身份。' })
    } finally { if (current()) this.update({ pending: false }) }
  }
}
