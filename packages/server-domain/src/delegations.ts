import type {
  CapabilityToolName,
  AgentInboxMessage,
  Page,
  PageRequest,
  ProjectId,
  SessionId,
  UserId,
  WorkerId,
} from '@wemux/domain';

export const delegationStatuses = [
  'draft',
  'pending_approval',
  'dispatched',
  'accepted',
  'rejected',
  'expired',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export type DelegationStatus = (typeof delegationStatuses)[number];
export type DelegationId = string;
export type DelegationDecision = 'accepted' | 'rejected';
export type DelegationCompletion = 'completed' | 'failed' | 'cancelled';

export interface DelegatedAuthority {
  capabilities: CapabilityToolName[];
  allowedProjectIds: ProjectId[];
}

export interface DelegationTarget {
  workerId: WorkerId;
  agentId: string;
  projectId: ProjectId;
  sessionId: SessionId;
}

export interface DelegationSource {
  projectId: ProjectId;
  sessionId: SessionId;
  runId?: string;
  agentId: string;
  userId: UserId;
  canonicalSessionId: SessionId;
}

export interface DelegationRequestReceipt {
  fingerprint: string;
  resultingVersion: number;
}

export interface Delegation {
  id: DelegationId;
  dispatchId: string;
  status: DelegationStatus;
  version: number;
  fingerprint: string;
  objective: string;
  source: DelegationSource;
  target: DelegationTarget;
  authority: DelegatedAuthority;
  ancestorAgentIds: string[];
  depth: number;
  childRunId?: string;
  resultSummary?: string;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
  requestReceipts: Readonly<Record<string, DelegationRequestReceipt>>;
}

export interface DelegationPolicy {
  maxDepth: number;
  maxConcurrentChildrenPerParent: number;
}

export const defaultDelegationPolicy: DelegationPolicy = {
  maxDepth: 4,
  maxConcurrentChildrenPerParent: 4,
};

export interface CreateDelegationCommand {
  requestId: string;
  dispatchId: string;
  objective: string;
  source: DelegationSource;
  target: DelegationTarget;
  requestedAuthority: DelegatedAuthority;
  ancestorAgentIds: string[];
  depth: number;
}

export interface AcceptDelegationCommand {
  requestId: string;
  delegationId: DelegationId;
  expectedVersion: number;
  actorAgentId: string;
}

export interface RejectDelegationCommand {
  requestId: string;
  delegationId: DelegationId;
  expectedVersion: number;
  actorAgentId: string;
  reason?: string;
}

export interface CompleteDelegationCommand {
  requestId: string;
  delegationId: DelegationId;
  expectedVersion: number;
  actorAgentId: string;
  outcome: DelegationCompletion;
  resultSummary?: string;
}

export interface StartDelegationCommand {
  requestId: string;
  delegationId: DelegationId;
  expectedVersion: number;
  childRunId: string;
}

export interface DelegationDispatchResult {
  delegation: Delegation;
  inboxMessage?: AgentInboxMessage;
  pendingApproval: boolean;
  replayed: boolean;
}

export interface DelegationMutationResult {
  delegation: Delegation;
  replayed: boolean;
}

export interface DelegationCompletionResult extends DelegationMutationResult {
  inboxMessage?: AgentInboxMessage;
}

export interface DelegationRepository {
  getDelegation(id: DelegationId): Promise<Delegation | undefined>;
  findDelegationByDispatchId(dispatchId: string): Promise<Delegation | undefined>;
  countActiveChildren(parentSessionId: SessionId): Promise<number>;
  listDelegations(query?: PageRequest): Promise<Page<Delegation>>;
  saveDelegation(delegation: Delegation, expectedVersion?: number): Promise<void>;
}

export interface DelegationService {
  create(command: CreateDelegationCommand): Promise<DelegationDispatchResult>;
  accept(command: AcceptDelegationCommand): Promise<DelegationMutationResult>;
  reject(command: RejectDelegationCommand): Promise<DelegationMutationResult>;
  start(command: StartDelegationCommand): Promise<DelegationMutationResult>;
  complete(command: CompleteDelegationCommand): Promise<DelegationCompletionResult>;
}

export const terminalDelegationStatuses = new Set<DelegationStatus>([
  'rejected',
  'expired',
  'completed',
  'failed',
  'cancelled',
]);

export const isActiveDelegationStatus = (status: DelegationStatus): boolean =>
  !terminalDelegationStatuses.has(status);

export const assertDelegationTransition = (
  from: DelegationStatus,
  to: DelegationStatus,
): void => {
  const allowed: Record<DelegationStatus, readonly DelegationStatus[]> = {
    draft: ['pending_approval', 'dispatched', 'cancelled'],
    pending_approval: ['dispatched', 'rejected', 'expired', 'cancelled'],
    dispatched: ['accepted', 'rejected', 'expired', 'cancelled'],
    accepted: ['running', 'cancelled'],
    rejected: [],
    expired: [],
    running: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  };

  if (!allowed[from].includes(to)) {
    throw new Error(`delegation transition ${from} -> ${to} is not allowed`);
  }
};

export const narrowDelegatedAuthority = (
  requested: DelegatedAuthority,
  source: DelegatedAuthority,
  target: DelegatedAuthority,
): DelegatedAuthority => {
  const sourceCapabilities = new Set(source.capabilities);
  const targetCapabilities = new Set(target.capabilities);
  const sourceProjects = new Set(source.allowedProjectIds);
  const targetProjects = new Set(target.allowedProjectIds);

  return {
    capabilities: [...new Set(requested.capabilities)].filter(
      (capability) => sourceCapabilities.has(capability) && targetCapabilities.has(capability),
    ),
    allowedProjectIds: [...new Set(requested.allowedProjectIds)].filter(
      (projectId) => sourceProjects.has(projectId) && targetProjects.has(projectId),
    ),
  };
};
