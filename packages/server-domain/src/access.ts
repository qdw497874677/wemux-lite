import type { ProjectId, SessionId, UserId, WorkerId } from '@wemux/domain'

export type WorkerGrantRole = 'use' | 'manage'
export type ProjectGrantRole = 'viewer' | 'contributor' | 'manager'
export type ResourceShareScope = 'owner-only' | 'selected-members' | 'team'
export type SessionShareScope = 'owner-only' | 'selected-members' | 'project'

export interface WorkerGrant {
  readonly workerId: WorkerId
  readonly userId: UserId
  readonly role: WorkerGrantRole
}

export interface ProjectGrant {
  readonly projectId: ProjectId
  readonly userId: UserId
  readonly role: ProjectGrantRole
}

export interface SessionGrant {
  readonly sessionId: SessionId
  readonly userId: UserId
}
