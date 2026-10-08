import type { ProjectDTO, WorkerDTO, WorkspaceDTO } from '@wemux/web-contract/browser-host'
export interface AttentionResult {
  readonly total: number
  readonly groups: readonly { readonly kind: 'approval' | 'task_assignment' | 'run_problem' | 'channel_dead_letter'; readonly label: string; readonly count: number; readonly items: readonly { readonly projectionKey: string; readonly projectId: string; readonly title: string; readonly detail: string; readonly href: string }[] }[]
}
/** Approval pages contain human Task reviews only; Session approvals and human assignments are not included. */
export interface AttentionPagesQuery {
  readonly kind: 'approval' | 'run_problem' | 'channel_dead_letter'
  readonly projectId?: string
  readonly limit?: number
  readonly cursor?: string
}
export interface AttentionPagesResult {
  readonly items: AttentionResult['groups'][number]['items']
  readonly nextCursor: string | null
  readonly generatedAt: string
}
import type { TaskCreate, TaskDetail, TaskSummary, TaskPatch, TaskActivity, Assignment, CreateTaskWorkspaceRequest, TaskDeleteReceipt, Run, LaunchRequest, LaunchResponse, CancelRunResponse, CompletionRequest, CompletionResponse, HumanReviewSubmissionRequest, HumanReviewSubmissionResponse, HumanReviewDecisionRequest, HumanReviewDecisionResponse, ReviewRequest } from '@wemux/web-contract/task-platform'
import type { createClusterTransport } from './cluster-transport.ts'
const id = encodeURIComponent
const project = (p: string) => `/api/projects/${id(p)}`
const task = (p: string, t: string) => `${project(p)}/tasks/${id(t)}`
export function projectManagementOperations({ request, list }: ReturnType<typeof createClusterTransport>) {
  return {
    createProject: (body: { name: string; teamId: string; requestId: string }) => request<ProjectDTO>('/api/projects', body),
    renameProject: (p: string, name: string) => request<ProjectDTO>(project(p), { name }, undefined, 'PATCH'),
    deleteProject: (p: string) => request<void>(project(p), undefined, undefined, 'DELETE'),
    projectGrants: (p: string) => list<{ userId: string; role: 'viewer' | 'contributor' | 'manager' }>(`${project(p)}/grants`),
    updateProjectAccess: (p: string, shareScope: ProjectDTO['shareScope']) => request<ProjectDTO>(`${project(p)}/access`, { shareScope }, undefined, 'PATCH'),
    updateProjectReviewPolicy: (p: string, reviewPolicy: NonNullable<ProjectDTO['reviewPolicy']>, version: number) => request<ProjectDTO>(`${project(p)}/review-policy`, { reviewPolicy, version }, undefined, 'PATCH'),
    attention: () => request<AttentionResult>('/api/attention'),
    attentionPages: (query: AttentionPagesQuery, signal?: AbortSignal) => {
      const params = new URLSearchParams({ kind: query.kind, limit: String(query.limit ?? 50) })
      if (query.projectId !== undefined) params.set('projectId', query.projectId)
      if (query.cursor !== undefined) params.set('cursor', query.cursor)
      return request<AttentionPagesResult>(`/api/attention/pages?${params}`, undefined, signal)
    },
    grantProject: (p: string, userId: string, role: 'viewer' | 'contributor' | 'manager') => request(`${project(p)}/grants`, { userId, role }),
    revokeProjectGrant: (p: string, userId: string) => request<void>(`${project(p)}/grants/${id(userId)}`, undefined, undefined, 'DELETE'),
    workers: () => list<WorkerDTO>('/api/workers'),
    workspaces: (p: string, visibility: 'visible' | 'hidden' | 'all' = 'visible') => list<WorkspaceDTO>(`/api/workspaces?projectId=${id(p)}&visibility=${visibility}`),
    setWorkspaceVisibility: (w: string, body: { hidden: boolean; expectedRevision: number; requestId: string }) => request<{ workspaceId: string; hidden: boolean; revision: number }>(`/api/workspaces/${id(w)}/visibility`, body, undefined, 'PUT'),
    createWorkspace: (p: string, body: { name: string; workerId?: string; source: 'empty' | 'git'; repository?: { gitUrl: string; revision?: string }; requestId: string }) => request<{ workspace: WorkspaceDTO; commandId?: string }>('/api/workspaces', { ...body, projectId: p }),
    workspace: (w: string) => request<WorkspaceDTO>(`/api/workspaces/${id(w)}`),
    deleteWorkspace: (w: string, expectedRevision: string, requestId: string) => request<{ workspaceId: string; deletedAt: string }>(`/api/workspaces/${id(w)}`, { expectedRevision, requestId }, undefined, 'DELETE'),
    renameWorkspace: (w: string, name: string) => request<WorkspaceDTO>(`/api/workspaces/${id(w)}`, { name }, undefined, 'PATCH'),
    retryWorkspace: (w: string, workerId: string, requestId: string) => request(`/api/workspaces/${id(w)}/reprovision`, { workerId, requestId }),
    cancelPreparation: (commandId: string) => request(`/api/commands/${id(commandId)}`, undefined, undefined, 'DELETE'),
    tasks: (p: string) => list<TaskSummary>(`${project(p)}/tasks`),
    task: (p: string, t: string) => request<TaskDetail>(task(p, t)),
    createTask: (p: string, body: TaskCreate & { requestId: string }) => request<TaskDetail>(`${project(p)}/tasks`, body),
    deleteTask: (p: string, t: string, version: number, requestId: string) => request<TaskDeleteReceipt>(task(p, t), { version, requestId }, undefined, 'DELETE'),
    patchTask: (p: string, t: string, body: TaskPatch) => request<TaskDetail>(task(p, t), body, undefined, 'PATCH'),
    taskActivity: (p: string, t: string, after = 0) => list<TaskActivity>(`${task(p, t)}/activity?after=${after}`),
    taskRuns: (p: string, t: string) => list<Run>(`${task(p, t)}/runs`),
    launchTask: (p: string, t: string, body: LaunchRequest) => request<LaunchResponse>(`${task(p, t)}/launch`, body),
    cancelTaskRun: (p: string, t: string, runId: string, sessionId: string, requestId: string) => request<CancelRunResponse>(`${task(p, t)}/runs/${id(runId)}/cancel`, { runId, sessionId, requestId }),
    completeTask: (p: string, t: string, body: CompletionRequest) => request<CompletionResponse>(`${task(p, t)}/completion`, body),
    submitHumanReview: (p: string, t: string, body: HumanReviewSubmissionRequest) => request<HumanReviewSubmissionResponse>(`${task(p, t)}/human-review-submission`, body),
    pendingReviews: (p: string) => list<ReviewRequest>(`${project(p)}/reviews`),
    decideHumanReview: (p: string, t: string, body: HumanReviewDecisionRequest) => request<HumanReviewDecisionResponse>(`${task(p, t)}/human-review-decision`, body),
    addTaskLink: (p: string, t: string, url: string) => request<TaskDetail>(`${task(p, t)}/links`, { url }),
    removeTaskLink: (p: string, t: string, linkId: string) => request<TaskDetail>(`${task(p, t)}/links/${id(linkId)}`, undefined, undefined, 'DELETE'),
    createTaskWorkspace: (p: string, t: string, body: CreateTaskWorkspaceRequest) => request<{ workspace: WorkspaceDTO; task: TaskDetail; commandId?: string }>(`${task(p, t)}/workspaces`, body),
    retryTaskWorkspace: (p: string, t: string, w: string, workerId: string, requestId: string) => request(`${task(p, t)}/workspaces/${id(w)}/retry`, { workerId, requestId }),
    bindTaskWorkspace: (p: string, t: string, w: string) => request<TaskDetail>(`${task(p, t)}/workspaces/${id(w)}`, {}, undefined, 'PUT'),
    unbindTaskWorkspace: (p: string, t: string, w: string, version: number) => request<TaskDetail>(`${task(p, t)}/workspaces/${id(w)}`, { version }, undefined, 'DELETE'),
    assignTask: (p: string, t: string, assignee: Assignment | null, version: number) => request<TaskDetail>(`${task(p, t)}/assignment`, assignee ? { assignee, version } : { version }, undefined, assignee ? 'PUT' : 'DELETE'),
  }
}
