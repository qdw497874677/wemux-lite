import type { Api } from '../../api/client'
import type { SendMessageDTO, SessionDTO, WorkerDTO, WorkspaceDTO } from '../../api/dto'
import { isExecutable } from '../../lib/capability.ts'
import { randomId } from '../../lib/random.ts'

export interface QuickConfig { workspaceId: string; workerId: string; agentKey: string; modelId: string }
export const emptyQuickConfig = (): QuickConfig => ({ workspaceId: '', workerId: '', agentKey: '', modelId: '' })
export const quickKey = (scope: string, projectId: string) => `wemux.quick-start:${JSON.stringify([scope, projectId])}`
const isConfig = (value: unknown): value is QuickConfig => Boolean(value && typeof value === 'object' && ['workspaceId', 'workerId', 'agentKey', 'modelId'].every(key => typeof (value as Record<string, unknown>)[key] === 'string'))
export function readPreference(storage: Pick<Storage, 'getItem'>, key: string): QuickConfig | null {
  try { const value: unknown = JSON.parse(storage.getItem(`${key}:preference`) ?? 'null'); return isConfig(value) ? value : null } catch { return null }
}
/** Defaults are unique choices only. A saved selection is never repaired implicitly. */
export function initialQuickConfig(projectId: string, workspaces: WorkspaceDTO[], workers: WorkerDTO[], preference: QuickConfig | null): QuickConfig {
  if (preference) return preference
  const candidates = workspaces.filter(ws => ws.projectId === projectId)
  if (candidates.length !== 1 || candidates[0].status !== 'ready' || !workers.some(w => w.id === candidates[0].workerId && w.connectionState === 'online' && w.capabilities.some(a => isExecutable(a) && a.models.length))) return emptyQuickConfig()
  const ws = candidates[0], worker = workers.find(w => w.id === ws.workerId)!
  const agents = worker.capabilities.filter(a => isExecutable(a) && a.models.length)
  const agent = agents.length === 1 ? agents[0] : undefined
  return { workspaceId: ws.id, workerId: ws.workerId, agentKey: agent?.agentKey ?? '', modelId: agent?.models.length === 1 ? agent.models[0].modelId : '' }
}
export function quickConfigReason(config: QuickConfig, projectId: string, workspaces: WorkspaceDTO[], workers: WorkerDTO[]): string {
  if (!config.workspaceId) return '请选择工作区；多个可用工作区不会自动代选。'
  const ws = workspaces.find(w => w.id === config.workspaceId && w.projectId === projectId)
  if (!ws) return '原工作区已不可访问，请明确选择其他工作区。'
  if (ws.workerId !== config.workerId) return '工作区绑定的节点已变化，请重新选择工作区。'
  if (ws.status !== 'ready') return ws.failureReason || '工作区尚未就绪，请等待准备完成或检查工作区。'
  const worker = workers.find(w => w.id === config.workerId)
  if (!worker || worker.connectionState !== 'online') return '所选工作节点不在线，请恢复连接或明确更换工作区。'
  if (!config.agentKey) return '请选择智能体。'
  const agent = worker.capabilities.find(a => a.agentKey === config.agentKey)
  if (!agent || !isExecutable(agent)) return agent?.availability.reason || '所选智能体不可执行或尚未认证。'
  if (!config.modelId) return '请选择模型。'
  if (!agent.models.some(m => m.modelId === config.modelId)) return '原模型已不在节点报告清单中，请明确选择其他模型。'
  return ''
}

/** Only explicit upstream selection calls this; refresh never repairs stale choices. */
export function fillQuickChoices(config: QuickConfig, projectId: string, workspaces: WorkspaceDTO[], workers: WorkerDTO[]): QuickConfig {
  const ws = workspaces.find(w => w.id === config.workspaceId && w.projectId === projectId && w.workerId === config.workerId && w.status === 'ready')
  const worker = workers.find(w => w.id === ws?.workerId && w.connectionState === 'online')
  const agents = worker?.capabilities.filter(a => isExecutable(a) && a.models.length) ?? []
  const agentKey = config.agentKey || (agents.length === 1 ? agents[0].agentKey : '')
  const agent = agents.find(a => a.agentKey === agentKey)
  return { ...config, agentKey, modelId: config.modelId || (agent?.models.length === 1 ? agent.models[0].modelId : '') }
}

interface Attempt { requestId: string; config: QuickConfig; title: string; message: SendMessageDTO; sessionId: string | null; sent?: boolean; rejected?: boolean }
export interface QuickState { draft: string; config: QuickConfig; pending: boolean; error: string; attempt: Attempt | null; completed: string | null }
type QuickApi = Pick<Api, 'createSession' | 'session' | 'send' | 'command' | 'workspaces' | 'workers'>
/** Connection-owned, project-specific state. Persist intent before the idempotent create.
 * The durable requestId safely reconciles a lost create response to the same Session.
 * Uncertain retries retain payload identity; only confirmed rejection permits fresh IDs. */
export class QuickStartController {
  state: QuickState
  private api: QuickApi
  private projectId: string
  private key: string
  private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  private preferences: Pick<Storage, 'setItem'>
  private listeners = new Set<() => void>()
  private disposed = false
  private receiptTimer?: ReturnType<typeof setTimeout>
  private checking = false
  constructor(api: QuickApi, projectId: string, key: string, initial: QuickConfig, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, preferences: Pick<Storage, 'setItem'>) {
    this.api = api; this.projectId = projectId; this.key = key; this.storage = storage; this.preferences = preferences
    this.state = { draft: '', config: initial, pending: false, error: '', attempt: null, completed: null }
    try {
      const saved = JSON.parse(storage.getItem(key) ?? 'null')
      if (saved && typeof saved.draft === 'string' && isConfig(saved.config)) {
        const a = saved.attempt
        if (a && (!isConfig(a.config) || typeof a.title !== 'string' || !(a.sessionId === null || typeof a.sessionId === 'string') || !a.message || !['content', 'commandId', 'messageId'].every(k => typeof a.message[k] === 'string'))) throw new Error('Invalid intent')
        if (a && typeof a.requestId !== 'string') a.requestId = a.message.commandId
        this.state = { ...this.state, draft: saved.draft, config: saved.config, attempt: a ?? null, completed: typeof saved.completed === 'string' ? saved.completed : null, error: typeof saved.error === 'string' ? saved.error : '' }
        // Older quick-start versions considered pending complete. Recheck their retained intent.
        if (a?.sessionId && this.state.completed && !a.sent) this.state = { ...this.state, completed: null, draft: a.message.content, attempt: { ...a, sent: true } }
      }
    } catch { this.state.error = '无法读取快速会话草稿。为避免重复创建，请先核对项目会话。'; this.disposed = true }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  private update(patch: Partial<QuickState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(l => l()) }
  private persist() { this.storage.setItem(this.key, JSON.stringify({ ...this.state, pending: false })) }
  edit(draft: string) { if (this.state.pending || this.state.attempt || this.state.completed) return; this.update({ draft }); try { this.persist() } catch { /* Start requires durable intent; editing remains possible. */ } }
  configure(config: QuickConfig) { if (this.state.pending || this.state.attempt || this.state.completed) return; this.update({ config, error: '' }); try { this.persist() } catch { /* Checked before create. */ } }
  dispose() { this.disposed = true; clearTimeout(this.receiptTimer); this.listeners.clear() }
  private bound(session: SessionDTO, attempt: Attempt) {
    return session.projectId === this.projectId && session.workspaceId === attempt.config.workspaceId && session.workerId === attempt.config.workerId && session.agentKey === attempt.config.agentKey && session.modelId === attempt.config.modelId
  }
  private acknowledge() {
    const attempt = this.state.attempt!
    this.update({ completed: attempt.sessionId, draft: '', error: '' }); this.persist()
    try { this.preferences.setItem(`${this.key}:preference`, JSON.stringify(attempt.config)) } catch { /* Optional preference. */ }
  }
  private reject(message: string) {
    this.update({ attempt: { ...this.state.attempt!, rejected: true }, error: `首条消息被拒绝：${message}。可在同一会话重新发送。` }); this.persist()
  }
  /** Connection-owned polling survives view navigation; remount/reload resumes without resending. */
  async checkReceipt() {
    const attempt = this.state.attempt
    if (this.disposed || this.checking || this.state.pending || this.state.completed || !attempt?.sent || attempt.rejected) return
    clearTimeout(this.receiptTimer); this.checking = true
    try {
      const receipt = await this.api.command(attempt.message.commandId)
      if (this.disposed || this.state.attempt !== attempt) return
      if (receipt.status === 'accepted') this.acknowledge()
      else if (receipt.status === 'rejected') this.reject(receipt.receipt?.error?.message ?? 'Worker 拒绝请求')
      else this.update({ error: '首条消息等待 Worker 确认；草稿已保留，可查看会话或稍后核对。' })
    } catch { if (!this.disposed) this.update({ error: '首条消息回执暂不可用；草稿已保留，重试将复用原请求身份。' }) }
    finally {
      this.checking = false
      if (!this.disposed && !this.state.completed && this.state.attempt?.sent && !this.state.attempt.rejected) this.receiptTimer = setTimeout(() => { void this.checkReceipt() }, 3000)
    }
  }
  resetCompleted() { if (!this.state.completed) return; this.update({ draft: '', attempt: null, completed: null, error: '' }); try { this.persist() } catch { this.update({ error: '无法保存新会话状态，请检查浏览器存储。' }) } }
  async start(): Promise<string | null> {
    if (this.disposed || this.checking || this.state.pending || this.state.completed || !this.state.draft.trim()) return null
    this.update({ pending: true, error: '' })
    let creating = false
    let sending = false
    try {
      const [workspaces, workers] = await Promise.all([this.api.workspaces(this.projectId), this.api.workers()])
      if (this.disposed) return null
      const reason = quickConfigReason(this.state.attempt?.config ?? this.state.config, this.projectId, workspaces, workers)
      if (reason) throw new Error(reason)
      if (!this.state.attempt) {
        const content = this.state.draft.trim()
        if (content.includes('\0') || content.length > 100000 || new TextEncoder().encode(JSON.stringify(content)).length > 200000) throw new Error('。')
        const attempt: Attempt = { requestId: randomId(), config: { ...this.state.config }, title: content.slice(0, 80), message: { commandId: randomId(), messageId: randomId(), content }, sessionId: null }
        // Failure to persist must not issue a create request.
        this.storage.setItem(this.key, JSON.stringify({ ...this.state, attempt, pending: false }))
        this.update({ attempt })
      }
      let attempt = this.state.attempt!
      if (!attempt.sessionId) {
        creating = true
        const created = await this.api.createSession({ requestId: attempt.requestId, workspaceId: attempt.config.workspaceId, agentKey: attempt.config.agentKey, modelId: attempt.config.modelId, title: attempt.title, shareScope: 'owner-only' })
        attempt = { ...attempt, sessionId: created.id }; creating = false
        this.update({ attempt }); this.persist()
      }
      if (this.disposed) return null
      const session: SessionDTO = await this.api.session(attempt.sessionId!)
      if (this.disposed) return null
      if (!this.bound(session, attempt)) throw new Error('会话绑定与启动配置不一致，已停止发送。')
      if (!session.sendCapability?.allowed) throw new Error(session.sendCapability?.reason || '服务端未提供发送权限。')
      const nextAttempt = { ...attempt, sent: true, rejected: false, message: attempt.rejected ? { ...attempt.message, commandId: randomId(), messageId: randomId() } : attempt.message }
      // Do not mutate the live attempt if durable storage rejects the new identity.
      this.storage.setItem(this.key, JSON.stringify({ ...this.state, attempt: nextAttempt, pending: false }))
      this.update({ attempt: nextAttempt }); attempt = nextAttempt
      sending = true
      const result = await this.api.send(session.id, attempt.message)
      sending = false
      if (result.commandId !== attempt.message.commandId || result.messageId !== attempt.message.messageId) throw new Error('发送响应身份不匹配；重试将复用原请求。')
      if (['rejected', 'failed'].includes(result.status)) { this.reject('服务端明确拒绝请求'); return null }
      if (result.status === 'accepted') this.acknowledge()
      else this.update({ error: '首条消息等待 Worker 确认；草稿已保留。' })
      return this.disposed ? null : session.id
    } catch (cause) {
      const status = typeof cause === 'object' && cause && 'status' in cause ? Number(cause.status) : 0
      if (sending && status >= 400 && status < 500 && ![408, 429].includes(status)) { this.reject('服务端明确拒绝请求'); return null }
      if (creating && status >= 400 && status < 500 && ![408, 429].includes(status)) { this.update({ attempt: null }); try { this.persist() } catch { /* Keep durable retry identity if persistence fails. */ } }
      this.update({ error: creating ? '，； requestId 。' : cause instanceof Error ? cause.message : '，。' })
      return this.disposed ? null : this.state.attempt?.sessionId ?? null
    } finally { this.update({ pending: false }); void this.checkReceipt() }
  }
}
