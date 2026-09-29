import type { AgentDTO, JournalEventDTO } from '../api/dto.ts'
import { randomId } from '../lib/random.ts'

export interface LocalDirectory { workspaceId: string; name: string; path: string }
export interface LocalSessionRecord {
  sessionId: string
  binding: { workspaceId: string; agent: { agentKey: string; workerId: string }; modelId: string | null }
  runtimeState: string
  activeTurnId: string | null
}
export interface LocalStatus { csrf: string; capabilities: AgentDTO[]; installation: { name: string; installationId: string } }
export interface LocalSendReceipt { commandId: string; status: string; messageId: string }

export function createLocalSessionApi(fetcher: typeof fetch = fetch, onUnauthorized: () => void = () => {}) {
  let csrf = ''
  const request = async <T>(path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (method !== 'GET') { headers['x-wemux-csrf'] = csrf; headers['content-type'] = 'application/json' }
    const response = await fetcher(`/api/local/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, credentials: 'same-origin', cache: 'no-store' })
    if (response.status === 401 && path !== 'auth/session' && path !== 'status') onUnauthorized()
    if (!response.ok) {
      let message = `本地请求失败：HTTP ${response.status}`
      try { const error = await response.json() as { error?: string }; if (typeof error.error === 'string') message = error.error } catch { /* Keep HTTP status. */ }
      throw new Error(message)
    }
    return response.json() as Promise<T>
  }
  const sessionPath = (id: string) => `workbench/sessions/${encodeURIComponent(id)}`
  return {
    async status() { const status = await request<LocalStatus>('status'); csrf = status.csrf; return status },
    async login(username: string, password: string) {
      const result = await request<{ csrf: string }>('auth/session', 'POST', { username, password }); csrf = result.csrf
      return this.status()
    },
    directories: () => request<{ items: LocalDirectory[] }>('workbench/directories').then(result => result.items),
    addDirectory: (path: string) => request<LocalDirectory>('workbench/directories', 'POST', { path }),
    sessions: () => request<{ items: LocalSessionRecord[] }>('workbench/sessions').then(result => result.items),
    create: (workspaceId: string, agentKey: string, modelId: string) => request<LocalSessionRecord>('workbench/sessions', 'POST', { workspaceId, agentKey, modelId, requestId: randomId() }),
    async send(sessionId: string, content: string, ids: { commandId: string; messageId: string }): Promise<LocalSendReceipt> {
      const result = await request<{ commandId: string; status: string }>(`${sessionPath(sessionId)}/messages`, 'POST', { content, ...ids })
      return { ...result, messageId: ids.messageId }
    },
    stop: (sessionId: string, turnId: string) => request(`${sessionPath(sessionId)}/turns/${encodeURIComponent(turnId)}/stop`, 'POST'),
    cancelQueued: (sessionId: string, commandId: string) => request(`${sessionPath(sessionId)}/queue/${encodeURIComponent(commandId)}/cancel`, 'DELETE'),
    resolveApproval: (sessionId: string, approvalId: string, decision: 'approve' | 'deny', commandId: string) => request(`${sessionPath(sessionId)}/approvals/${encodeURIComponent(approvalId)}/resolve`, 'POST', { decision, commandId }),
    journal: (sessionId: string, fromSeq: number, limit: number) => request<{ events: JournalEventDTO[]; throughSeq: number; hasMore: boolean }>(`${sessionPath(sessionId)}/journal?fromSeq=${fromSeq}&limit=${limit}`),
  }
}
