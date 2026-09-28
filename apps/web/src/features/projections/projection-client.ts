import type { ApprovalView, CursorPage, ProjectionFilters, TimelineEvent } from './projection-model.ts'

function queryString(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value)
  const text = params.toString()
  return text ? `?${text}` : ''
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
  if (!response.ok) throw new Error(body.error?.message ?? `请求失败 (${response.status})`)
  return body as T
}
export async function fetchApprovals(filters: ProjectionFilters, cursor?: string): Promise<CursorPage<ApprovalView>> {
  return request(`/approvals${queryString({ projectId: filters.projectId, sourceKind: filters.sourceKind, status: filters.status, cursor, limit: '30' })}`)
}
export async function fetchApproval(projectionKey: string): Promise<ApprovalView> {
  const body = await request<{ approval: ApprovalView }>(`/approvals/${encodeURIComponent(projectionKey)}`)
  return body.approval
}
export async function decideApproval(projectionKey: string, input: { readonly decision: string; readonly requestId: string; readonly fingerprint: string; readonly sourceRevision: string }): Promise<ApprovalView> {
  const account = await request<{ csrfToken: string }>('/auth/me')
  const body = await request<{ approval: ApprovalView }>(`/approvals/${encodeURIComponent(projectionKey)}/decisions`, { method: 'POST', headers: { 'x-csrf-token': account.csrfToken }, body: JSON.stringify(input) })
  return body.approval
}
export async function fetchTimeline(filters: ProjectionFilters, cursor?: string): Promise<CursorPage<TimelineEvent>> {
  return request(`/timeline${queryString({ projectId: filters.projectId, sourceKind: filters.sourceKind, cursor, limit: '30' })}`)
}
