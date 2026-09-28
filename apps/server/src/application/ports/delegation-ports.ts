import type { AgentInboxMessage, SessionId } from '@wemux/domain'
import type {
  DelegatedAuthority,
  Delegation,
  DelegationRepository,
} from '@wemux/server-domain'

export interface DelegationAuthorityResolver {
  resolve(sessionId: SessionId): Promise<DelegatedAuthority & { readonly workerId: import('@wemux/domain').WorkerId }>
}

export interface DelegationApprovalPort {
  requestCrossProjectApproval(delegation: Delegation): Promise<void>
}

export interface DelegationDeliveryPort {
  deliverRequest(delegation: Delegation): Promise<AgentInboxMessage>
  deliverResult(delegation: Delegation, silent: boolean): Promise<AgentInboxMessage>
}

export interface DelegationJournalPort {
  appendResult(delegation: Delegation, silent: boolean): Promise<void>
}

export type { DelegationRepository }
