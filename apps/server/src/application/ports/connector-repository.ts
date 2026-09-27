import type { Timestamp, WorkerId } from '@wemux/domain'
import type { ConnectorDefinition, ConnectorId, CredentialAvailability } from '@wemux/connector'

export interface ConnectorRequestRecord {
  readonly projectId: string
  readonly requestId: string
  readonly fingerprint: string
  readonly operation: 'create' | 'update' | 'enable' | 'disable' | 'distribute' | 'test'
  readonly connectorId: ConnectorId
  readonly result: unknown
  readonly createdAt: Timestamp
}

export interface ConnectorDistributionRecord {
  readonly connectorId: ConnectorId
  readonly workerId: WorkerId
  readonly revision: number
  readonly requestId: string
  readonly commandId: string
  readonly status: 'pending' | 'applied' | 'revoked' | 'unavailable' | 'test_succeeded' | 'test_failed'
  readonly credentialAvailability: CredentialAvailability
  readonly message: string | null
  readonly updatedAt: Timestamp
}

export interface ConnectorRepository {
  get(id: ConnectorId): Promise<ConnectorDefinition | null>
  list(projectId: string): Promise<readonly ConnectorDefinition[]>
  getRequest(projectId: string, requestId: string): Promise<ConnectorRequestRecord | null>
  create(definition: ConnectorDefinition, request: ConnectorRequestRecord): Promise<void>
  update(definition: ConnectorDefinition, expectedRevision: number, request: ConnectorRequestRecord): Promise<boolean>
  saveRequest(request: ConnectorRequestRecord): Promise<void>
  listDistributions(connectorId: ConnectorId): Promise<readonly ConnectorDistributionRecord[]>
  saveDistribution(record: ConnectorDistributionRecord): Promise<void>
  applyReport(record: Omit<ConnectorDistributionRecord, 'commandId'>): Promise<void>
}
