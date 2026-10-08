import { createLocalTransport, localIdentityOperations } from '@wemux/web-client'
import type { AgentDTO, JournalEventDTO } from '../api/dto.ts'
import { randomId } from '../lib/random.ts'

export interface LocalDirectory { workspaceId: string; name: string; path: string }
export interface LocalSessionRecord {
  sessionId: string
  binding: { workspaceId: string; agent: { agentKey: string; workerId: string }; modelId: string | null }
  runtimeState: string
  activeTurnId: string | null
}
export type { LocalStatus } from '@wemux/web-contract/browser-host'
export interface LocalAgentSettings {
  selections: { key: string; executable: string; source: string; selected: boolean }[]
  capabilities: AgentDTO[]
}
export interface LocalConnectorDefinition {
  id: string; projectId: string; kind: string; name: string; description: string | null; revision: number; enabled: boolean; allowedWorkerIds: string[]; credentialRef: string | null; credentialAvailability: string; riskDefaults: { requireApprovalForRead: boolean; allowMcpReadOnlyHint: boolean }; createdAt: string; updatedAt: string
  config: { transport: 'stdio'; command: string; args: string[]; cwd: string | null; publicEnvironment: Record<string, string>; secretEnvironmentNames: string[] } | { transport: 'streamable_http'; url: string; publicHeaders: Record<string, string>; authentication: 'none' | 'api_key' | 'custom_credential'; allowPrivateNetwork: boolean }
}
export interface LocalConnectorList { items: LocalConnectorDefinition[]; credentialCapability: 'available' | 'unavailable' }
export interface LocalProviderCredential { id: string; variableNames: string[]; revision: number; availability: 'available' | 'unavailable' }
export interface LocalProviderCredentialList { items: LocalProviderCredential[]; credentialCapability: 'available' | 'unavailable' }
export interface LocalAgentInstallation { installation: { key: string; phase: 'installing' | 'ready' | 'failed'; message: string } | null }
export interface LocalClusterDiscovery { serverUrl: string; ok: boolean; status: number; name?: string; error?: string }
export interface LocalSendReceipt { commandId: string; status: string; messageId: string }

export function createLocalSessionApi(fetcher: typeof fetch = fetch, onUnauthorized: () => void = () => {}) {
  const transport = createLocalTransport(fetcher, onUnauthorized)
  const { request } = transport
  const sessionPath = (id: string) => `workbench/sessions/${encodeURIComponent(id)}`
  return {
    ...localIdentityOperations(transport),
    dispose: transport.dispose,
    agents: () => request<LocalAgentSettings>('agents'),
    selectAgent: (key: string, executable: string) => request<LocalAgentSettings>(`agents/${encodeURIComponent(key)}`, 'PUT', { executable }),
    resetAgent: (key: string) => request<LocalAgentSettings>(`agents/${encodeURIComponent(key)}`, 'DELETE'),
    agentInstallation: () => request<LocalAgentInstallation>('agents/install'),
    installAgent: (key: string) => request<LocalAgentInstallation>('agents/install', 'POST', { key, confirm: true }),
    connectors: () => request<LocalConnectorList>('connectors'),
    saveConnector: (definition: LocalConnectorDefinition) => request<LocalConnectorDefinition>('connectors', 'POST', definition),
    deleteConnector: (id: string) => request<void>(`connectors/${encodeURIComponent(id)}`, 'DELETE'),
    putConnectorCredential: (connectorId: string, id: string, secret: Record<string, string>, authType: 'api_key' | 'custom_credential') => request<{ id: string; revision: number }>(`connectors/${encodeURIComponent(connectorId)}/credential`, 'PUT', { id, authType, secret }),
    providerCredentials: () => request<LocalProviderCredentialList>('providers/credentials'),
    putProviderCredential: (id: string, variableNames: string[], secret: Record<string, string>, expectedRevision: number) => request<LocalProviderCredential>(`providers/credentials/${encodeURIComponent(id)}`, 'PUT', { variableNames, secret, expectedRevision }),
    deleteProviderCredential: (id: string, expectedRevision: number) => request<void>(`providers/credentials/${encodeURIComponent(id)}`, 'DELETE', { expectedRevision }),
    discoverCluster: (serverUrl: string) => request<LocalClusterDiscovery>('cluster/discover', 'POST', { serverUrl }),
    enrollCluster: (serverUrl: string, token: string, name: string) => request<{ identity: { workerId: string } }>('cluster/enroll', 'POST', { serverUrl, token, name }),
    resumeCluster: () => request('cluster/resume', 'POST'),
    pauseCluster: () => request('cluster/pause', 'POST'),
    leaveCluster: () => request('cluster/enrollment', 'DELETE'),
    directories: () => request<{ items: LocalDirectory[] }>('workbench/directories').then(result => result.items),
    addDirectory: (path: string) => request<LocalDirectory>('workbench/directories', 'POST', { path }),
    sessions: () => request<{ items: LocalSessionRecord[] }>('workbench/sessions').then(result => result.items),
    create: (workspaceId: string, agentKey: string, modelId: string) => request<LocalSessionRecord>('workbench/sessions', 'POST', { workspaceId, agentKey, modelId, requestId: randomId() }),
    async send(sessionId: string, content: string, ids: { commandId: string; messageId: string }): Promise<LocalSendReceipt> {
      const result = await request<{ commandId: string; status: string }>(`${sessionPath(sessionId)}/messages`, 'POST', { content, ...ids })
      return { ...result, messageId: ids.messageId }
    },
    stop: (sessionId: string, turnId: string) => request(`${sessionPath(sessionId)}/turns/${encodeURIComponent(turnId)}/stop`, 'POST'),
    cancelQueued: (sessionId: string, commandId: string) => request(`${sessionPath(sessionId)}/queue/${encodeURIComponent(commandId)}/cancel`, 'DELETE'),
    resolveApproval: (sessionId: string, approvalId: string, decision: 'approve' | 'deny', commandId: string) => request(`${sessionPath(sessionId)}/approvals/${encodeURIComponent(approvalId)}/resolve`, 'POST', { decision, commandId }),
    journal: (sessionId: string, fromSeq: number, limit: number) => request<{ events: JournalEventDTO[]; throughSeq: number; hasMore: boolean }>(`${sessionPath(sessionId)}/journal?fromSeq=${fromSeq}&limit=${limit}`),
  }
}
