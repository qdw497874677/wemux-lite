import type { ConnectorDefinition, CredentialRecord, ExecutionResult, ToolCall } from '@wemux/connector'

export interface ConnectorExecutionRecord {
  readonly requestId: string
  readonly fingerprint: string
  readonly state: 'running' | 'completed'
  readonly toolCall: ToolCall
  readonly result: ExecutionResult | null
  readonly journalSummary: unknown | null
  readonly createdAt: string
  readonly completedAt: string | null
}

export interface WorkerConnectorStore {
  listConnectorDefinitions(): Promise<readonly ConnectorDefinition[]>
  getConnectorDefinition(id: string): Promise<ConnectorDefinition | null>
  saveConnectorDefinition(definition: ConnectorDefinition): Promise<void>
  saveClusterConnectorDefinition(definition: ConnectorDefinition): Promise<'applied' | 'current' | 'stale'>
  deleteConnectorDefinition(id: string): Promise<void>
  getConnectorCredential(id: string): Promise<CredentialRecord | null>
  saveConnectorCredential(record: CredentialRecord): Promise<void>
  deleteConnectorCredential(id: string): Promise<void>
  getConnectorExecution(requestId: string): Promise<ConnectorExecutionRecord | null>
  beginConnectorExecution(record: ConnectorExecutionRecord): Promise<'inserted' | 'exists'>
  finishConnectorExecution(requestId: string, result: ExecutionResult, journalSummary: unknown): Promise<void>
  listConnectorJournal(sessionId: string): Promise<readonly ConnectorExecutionRecord[]>
}
