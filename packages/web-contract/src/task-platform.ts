/** M1 wire DTOs. Dependency-free so domain, Server and Web share one contract.
 * Runtime validation, persistence, endpoints and UI belong to later tickets.
 */
export { evaluateCapability, unavailableCapability, validReviewMetadata } from './action-capability.js'
export type { ActionCapability, CapabilityFacts, CapabilityAction, TaskCapabilities, RunCapabilities } from './action-capability.js'
/** Status vocabulary and transition rule are domain invariants; re-exported so Web, Server and Worker share one contract. */
export { taskStatuses, workflowTargets } from '@wemux/domain'
export type { TaskStatus, BlockedFrom, CancelledFrom, TaskWorkflowState } from '@wemux/domain'
import type { TaskStatus } from '@wemux/domain'
export const boardStatuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked'] as const
export type BoardStatus = typeof boardStatuses[number]
export type TaskPriority = 'none' | 'low' | 'medium' | 'high'
export type TaskViewMode = 'board' | 'list'
export const runStatuses = ['pending', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'] as const
export type RunStatus = typeof runStatuses[number]
export const activeRunStatuses = ['pending', 'running', 'cancelling'] as const

export type ReviewStatus = 'requested' | 'approved' | 'changes_requested'
export interface ReviewRequest {
  readonly id: string
  readonly projectId: string
  readonly taskId: string
  readonly taskRunId: string
  readonly status: ReviewStatus
  readonly actor: string
  readonly reviewer: string | null
  readonly requestedAt: string
  readonly decidedAt: string | null
  /** Cycle closure is not a decision: ordinary exits preserve historical status. */
  readonly closedAt: string | null
  /** Staged policies only: 1-based position within the frozen stage chain.
   * Absent on single-stage human reviews. */
  readonly stageIndex?: number
  readonly stageCount?: number
}
export interface ReviewActionRequest { version: number; status: ReviewStatus }
/** A pending human review is identified separately from its Run. Decisions
 * require an explicit request identity and a new Task-version snapshot. */
export interface HumanReviewDecisionRequest {
  readonly version: number
  readonly requestId: string
  readonly reviewId: string
  readonly status: 'approved' | 'changes_requested'
  readonly reason?: string
}
export interface HumanReviewDecisionResponse { readonly task: TaskDetail; readonly review: ReviewRequest }
export interface ProjectActivityItem { cursor: number; activity: TaskActivity }

export interface Assignment {
  readonly workspaceId: string
  readonly workerId: string
  readonly agentKey: string
  /** Optional: null means the Agent runtime uses its default model. */
  readonly modelId: string | null
}
export interface TaskSummary {
  /** Permanent logical deletion; absent on legacy active records. History is retained. */
  readonly deletedAt?: string | null
  readonly deletedBy?: string | null
  readonly capabilities?: import('./action-capability.js').TaskCapabilities
  readonly id: string
  readonly projectId: string
  readonly title: string
  readonly priority: TaskPriority
  readonly status: TaskStatus
  /** Starts at 1; effective content, status or assignee changes increment this CAS version. */
  readonly version: number
  readonly assignee: Assignment | null
  readonly origin: 'manual'
  /** Host-created Project test/quick-chat reuse identity; not Team coordination mode. */
  readonly dedicatedConversation?: {
    readonly ownerId: string
    readonly workspaceId: string
    readonly workerId: string
    readonly agentKey: string
    readonly scenario: 'quick-chat' | 'agent-test'
  }
  readonly activeRun: RunSummary | null
  /** Non-negative external-link count; board/list markers need no detail requests. */
  readonly linkCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastActivityAt: string
}
export interface TaskMetadata { readonly schemaVersion: 1; readonly values: Readonly<Record<string, unknown>> }
export interface TaskCreate extends TaskContentPatch { readonly title: string }
export interface TaskActivity {
  readonly taskId: string
  readonly projectId: string
  readonly seq: number
  readonly type: 'task.deleted' | 'task.created' | 'task.updated' | 'task.transitioned' | 'link.changed' | 'binding.changed' | 'assignment.changed' | 'workspace.created' | 'workspace.retried' | 'workspace.provisioning' | 'run.created' | 'run.started' | 'run.finished'
  readonly actor: string
  readonly requestId: string
  readonly occurredAt: string
  readonly payload: Readonly<Record<string, unknown>>
}
export interface TaskDetail extends TaskSummary {
  /** The pending review belonging to this entry into in_review; null without a Run. */
  readonly currentReviewId?: string | null
  readonly metadataJson: TaskMetadata
  readonly description: string
  readonly acceptanceCriteria: string | null
  readonly blockedFrom: Exclude<TaskStatus, 'blocked'> | null
  readonly cancelledFrom: Exclude<TaskStatus, 'cancelled'> | null
  readonly workspaces: readonly TaskWorkspace[]
  readonly links: readonly TaskLink[]
}
export type Task = TaskDetail
export interface TaskWorkspace {
  readonly taskId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly createdAt: string
}
export interface TaskLink {
  readonly id: string
  readonly type: 'github-issue' | 'github-pr'
  readonly externalId: string
  readonly url: string
  readonly title?: string
  readonly syncState: 'none'
}
export interface BoardColumn {
  readonly status: BoardStatus
  readonly tasks: readonly TaskSummary[]
}
export interface TaskContentPatch {
  readonly metadataJson?: TaskMetadata
  readonly title?: string
  readonly description?: string
  readonly acceptanceCriteria?: string | null
  readonly priority?: TaskPriority
}
export interface TaskDeleteRequest { readonly version: number; readonly requestId: string }
export interface TaskDeleteReceipt { readonly taskId: string; readonly version: number; readonly deletedAt: string }
export interface TaskCAS { readonly version: number }
/** Status requires version. Content accepts optional version during expand phase;
 * every effective content write (including unversioned legacy writes) advances version once.
 * A supplied version is checked even for a no-op; valid no-ops do not advance version. */
export type TaskPatch = TaskContentPatch & (
  | { readonly status?: never; readonly assignee?: never; readonly version?: number }
  | (TaskCAS & { readonly status: TaskStatus; readonly assignee?: Assignment | null })
  | (TaskCAS & { readonly assignee: Assignment | null; readonly status?: TaskStatus })
)
export interface TransitionRequest extends TaskCAS { readonly status: TaskStatus }
export interface AssignmentRequest extends TaskCAS { readonly assignee: Assignment | null }
/** Required when unbinding the current assignment; server validates this condition. */
export interface UnbindWorkspaceRequest { readonly version?: number }
export interface CreateTaskWorkspaceRequest {
  /** Optional explicit create identity; tracing headers remain independent. */
  readonly requestId?: string
  readonly name: string
  readonly workerId: string
  readonly source: 'empty' | 'git'
  readonly repository?: { readonly name?: string; readonly gitUrl: string; readonly revision?: string }
  readonly assignment?: { readonly agentKey: string; readonly modelId: string }
  readonly version?: number
}
export interface RetryTaskWorkspaceRequest { readonly requestId: string }

export type LaunchRequest = {
  /** Client identity: retain for retries; a deliberate new attempt gets a new ID. */
  readonly requestId: string
  readonly prompt: string
  readonly assignment: Assignment
} & (
  | { readonly mode: 'new'; readonly reuseSessionId: null }
  | { readonly mode: 'reuse'; readonly reuseSessionId: string }
)
/** SHA-256 of JSON.stringify(this tuple); requestId and attempt are NOT inputs.
 * Preserve prompt verbatim, including whitespace. Identity is (taskId, requestId).
 */
export function launchFingerprintInput(request: LaunchRequest): readonly [
  LaunchRequest['mode'], string, string | null, readonly [string, string, string, string | null],
] {
  const a = request.assignment
  return [request.mode, request.prompt, request.mode === 'new' ? null : request.reuseSessionId,
    [a.workspaceId, a.workerId, a.agentKey, a.modelId]]
}
export interface RunSummary {
  readonly capabilities?: import('./action-capability.js').RunCapabilities
  readonly id: string
  readonly taskId: string
  readonly projectId: string
  readonly requestId: string
  /** Server allocated from 1 in the creating transaction; retries/rollback do not consume it. */
  readonly attempt: number
  readonly sessionId: string
  /** Immutable actual Session binding, never a live reference to Task.assignee. */
  readonly snapshot: Assignment
  readonly status: RunStatus
  readonly resultSummary: string | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly cancelRequestedAt: string | null
}
export interface Run extends RunSummary {
  readonly lastProjectedSeq: number
  readonly failure: { readonly code: string; readonly message: string } | null
  readonly request: LaunchRequest
  readonly fingerprint: string
  readonly createCommandId: string | null
  readonly enqueueCommandId: string
  readonly messageId: string | null
  readonly turnId: string | null
  readonly cancelCommandIds: readonly string[]
}
/** New and replay responses have the same shape, including original identity/attempt. */
export interface LaunchResponse { readonly run: Run }
/** accepted is not terminal: cancelling stays active until the owned Journal converges.
 * Cancel after terminal returns that terminal Run unchanged; unrelated messages are untouched.
 */
export interface CancelRunResponse { readonly run: Run }
/** Human explicit completion, never inferred from a successful Run. */
export interface CompletionRequest { readonly requestId: string; readonly version: number; readonly runId: string; readonly summary: string; readonly evidence: readonly string[] }
export interface CompletionResponse { readonly task: TaskDetail; readonly runId: string }
/** Submission opens a human review but grants no decision rights to its submitter. */
export interface HumanReviewSubmissionRequest extends CompletionRequest {}
export interface HumanReviewSubmissionResponse { readonly task: TaskDetail; readonly runId: string; readonly review: ReviewRequest }

export const taskErrorStatus = {
  task_deleted: 410, task_has_sessions: 409, task_has_review: 409,
  invalid_request: 400, unauthorized: 401, forbidden: 403, not_found: 404,
  request_id_conflict: 409, version_conflict: 409, active_run: 409,
  assignment_changed: 409, workspace_not_ready: 409, runtime_unavailable: 409,
  reuse_ineligible: 409, workspace_bound: 409, invalid_transition: 409,
} as const
export type TaskErrorCode = keyof typeof taskErrorStatus
export interface VersionConflictDetails {
  readonly currentVersion: number
  readonly status: TaskStatus
  readonly assignment: Assignment | null
}
export type TaskErrorResponse = { readonly error:
  | { readonly code: 'version_conflict'; readonly message: string; readonly details: VersionConflictDetails }
  | { readonly code: Exclude<TaskErrorCode, 'version_conflict'>; readonly message: string; readonly details?: Readonly<Record<string, unknown>> }
}

interface ProjectEventBase {
  /** Opaque invalidation identity, NOT a reliable activity/Journal cursor. */
  readonly id: string
  readonly projectId: string
}
/** Flat post-commit invalidations. Reconnect revalidates queries and tails activity separately. */
export type ProjectEvent = ProjectEventBase & (
  | { readonly type: 'task.created' | 'task.updated' | 'task.transitioned' | 'assignment.changed' | 'link.changed'; readonly taskId: string }
  | { readonly type: 'binding.changed'; readonly taskId: string; readonly workspaceId: string }
  | { readonly type: 'run.changed'; readonly taskId: string; readonly runId: string }
  | { readonly type: 'workspace.provisioning'; readonly workspaceId: string; readonly taskId?: string }
)

/** Task creation returns a persisted Session, not the richer discovery projection. */
export interface TaskSession {
  readonly id: string
  readonly projectId: string
  readonly taskId: string
  readonly runId: string | null
  readonly ownerId: string
  readonly workspaceId: string
  readonly title: string
  readonly shareScope: 'owner-only' | 'selected-members' | 'project'
  readonly binding: { readonly workspaceId: string; readonly agent: { readonly workerId: string; readonly agentKey: string }; readonly modelId: string | null }
  readonly runtimeState: import('@wemux/domain').SessionRuntimeState
  readonly archivedAt?: string | null
  readonly deletedAt: string | null
  readonly storageMode?: 'local' | 'replicated' | 'central'
  readonly creation?: { readonly requestId: string; readonly fingerprint: string; readonly commandId: string }
}
export type CreateTaskSessionRequest = { readonly requestId: string; readonly title: string } & (
  | { readonly workspaceId: string; readonly workerId: string; readonly agentKey: string; readonly modelId?: string | null }
  | { readonly workspaceId?: never; readonly workerId?: never; readonly agentKey?: never; readonly modelId?: never }
)
export interface CreateTaskSessionResponse { readonly session: TaskSession; readonly commandId: string; readonly created: boolean }
export interface TaskSessionView extends TaskSession {
  readonly access: { readonly canRead: boolean; readonly canWrite: boolean; readonly canControl: boolean; readonly projectRole: 'owner' | 'manager' | 'contributor' | 'viewer' | null }
  readonly activeTurnId: string | null
  readonly activeTurnOwnerId: string | null
  readonly queuedMessages: readonly { readonly commandId: string; readonly messageId: string; readonly content: string; readonly position: number | null; readonly sentByAccountId?: string }[]
  readonly freshness: { readonly sessionId: string; readonly contiguousSeq: number; readonly workerLastSeq: number | null; readonly status: 'unknown' | 'syncing' | 'synced' | 'gap' | 'offline' | 'orphaned' }
  readonly sendCapability: import('./action-capability.js').ActionCapability
}
export interface TaskSessionFilters { projectId?: string; workspaceId?: string; taskId?: string; archived?: boolean }
