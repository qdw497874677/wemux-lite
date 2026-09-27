import type { ProjectId, Timestamp, UserId, WorkerId } from '@wemux/domain'
import type {
  ConnectorDefinition,
  ConnectorId,
  CredentialAvailability,
  HttpConnectorDefinition,
  McpConnectorDefinition,
} from '@wemux/connector'

export type ConnectorManagementAction = 'create' | 'update' | 'list' | 'enable' | 'disable' | 'distribute' | 'test'

/** Authorization facts consumed by H1. The application reuses A3 Project/Worker access services. */
export interface ConnectorAuthorizationInput {
  readonly actorId: UserId
  readonly projectId: ProjectId
  readonly action: ConnectorManagementAction
  readonly workerId?: WorkerId
}

export interface ConnectorWriteIdentity {
  readonly requestId: string
  readonly fingerprint: string
}

export interface CreateConnectorInput extends ConnectorWriteIdentity {
  readonly projectId: ProjectId
  readonly definition: Omit<HttpConnectorDefinition | McpConnectorDefinition, 'id' | 'projectId' | 'revision' | 'createdAt' | 'updatedAt' | 'credentialAvailability'>
}

export interface UpdateConnectorInput extends ConnectorWriteIdentity {
  readonly connectorId: ConnectorId
  readonly projectId: ProjectId
  readonly expectedRevision: number
  readonly definition: Omit<ConnectorDefinition, 'id' | 'projectId' | 'revision' | 'createdAt' | 'updatedAt' | 'credentialAvailability'>
}

export interface SetConnectorEnabledInput extends ConnectorWriteIdentity {
  readonly connectorId: ConnectorId
  readonly projectId: ProjectId
  readonly expectedRevision: number
  readonly enabled: boolean
}

export interface DistributeConnectorInput extends ConnectorWriteIdentity {
  readonly connectorId: ConnectorId
  readonly projectId: ProjectId
  readonly expectedRevision: number
  readonly workerIds?: readonly WorkerId[]
}

export interface TestConnectorInput extends ConnectorWriteIdentity {
  readonly connectorId: ConnectorId
  readonly projectId: ProjectId
  readonly workerId: WorkerId
  readonly expectedRevision: number
}

export interface ConnectorMutationResult {
  readonly definition: ConnectorDefinition
  readonly replayed: boolean
  readonly commandIds: readonly string[]
}

export interface ConnectorTestResult {
  readonly connectorId: ConnectorId
  readonly workerId: WorkerId
  readonly revision: number
  readonly requestId: string
  readonly commandId: string
  readonly replayed: boolean
}

export interface ConnectorAuditRecord {
  readonly actorId: UserId
  readonly action:
    | 'connector.create'
    | 'connector.update'
    | 'connector.enable'
    | 'connector.disable'
    | 'connector.distribute'
    | 'connector.test'
  readonly connectorId: ConnectorId
  readonly projectId: ProjectId
  readonly revision: number
  readonly requestId: string
  readonly workerId: WorkerId | null
  readonly result: 'succeeded' | 'failed'
  readonly occurredAt: Timestamp
  readonly credentialAvailability: CredentialAvailability
  readonly errorCode: string | null
}

export interface ConnectorCatalogPort {
  create(actorId: UserId, input: CreateConnectorInput): Promise<ConnectorMutationResult>
  update(actorId: UserId, input: UpdateConnectorInput): Promise<ConnectorMutationResult>
  list(actorId: UserId, projectId: ProjectId): Promise<readonly ConnectorDefinition[]>
  setEnabled(actorId: UserId, input: SetConnectorEnabledInput): Promise<ConnectorMutationResult>
  distribute(actorId: UserId, input: DistributeConnectorInput): Promise<ConnectorMutationResult>
  test(actorId: UserId, input: TestConnectorInput): Promise<ConnectorTestResult>
}

export interface ConnectorRevisionState {
  readonly connectorId: ConnectorId
  readonly workerId: WorkerId
  readonly revision: number
  readonly status: 'pending' | 'applied' | 'revoked' | 'unavailable' | 'test_succeeded' | 'test_failed'
  readonly credentialAvailability: CredentialAvailability
  readonly message: string | null
  readonly updatedAt: Timestamp
}
