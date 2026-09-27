import type { ProjectId, Timestamp, WorkerId } from '@wemux/domain'
import type {
  ConnectorDefinition,
  ConnectorExecutionErrorCode,
  ConnectorId,
  CredentialAvailability,
} from '@wemux/connector'

/** Explicit alias keeps the reachable wire graph restricted to the frozen non-secret definition. */
export type ConnectorWireSnapshot = ConnectorDefinition

export interface ConnectorRevisionReport {
  readonly requestId: string
  readonly connectorId: ConnectorId
  readonly projectId: ProjectId
  readonly workerId: WorkerId
  readonly revision: number
  readonly status: 'applied' | 'revoked' | 'unavailable' | 'test_succeeded' | 'test_failed'
  readonly credentialAvailability: CredentialAvailability
  readonly errorCode: ConnectorExecutionErrorCode | null
  readonly message: string
  readonly occurredAt: Timestamp
}
