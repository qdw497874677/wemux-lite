import { createHash, randomUUID } from 'node:crypto'
import type {
  AgentInboxMessage,
  CapabilityAsset,
  CapabilityGrantClaims,
  CapabilitySnapshot,
  CapabilityToolName,
  ProjectId,
  SessionId,
  Timestamp,
} from '@wemux/domain'
import type { ConnectorDefinition } from '@wemux/connector'
import type {
  CapabilityAgentListResult,
  CapabilityAgentSendInput,
  CapabilityAgentSendResult,
  CapabilityInboxListInput,
  CapabilityInboxListResult,
  CapabilityInboxReadInput,
  CapabilityInboxReadResult,
  CapabilityRuntimePayload,
  CapabilitySessionInfoResult,
} from '@wemux/wire-protocol'
import type { ServerStore } from './ports/server-store.ts'
import type { ConnectorRepository } from './ports/connector-repository.ts'
import { CapabilityTokenService } from './capability-token-service.ts'

export class CapabilityError extends Error {
    readonly code: 'forbidden' | 'not-found' | 'invalid-input'
  constructor(
    code: 'forbidden' | 'not-found' | 'invalid-input',
    message: string,
  ) {
    super(message); this.code = code;
  }
}

export interface CapabilityAssetDraft {
  readonly id?: string
  readonly kind: CapabilityAsset['kind']
  readonly name: string
  readonly version: string
  readonly content: string
  readonly targetPath?: string | null
}

const ASSET_COUNT_LIMIT = 64
const ASSET_BYTES_LIMIT = 512 * 1024
const ASSET_FIELD_LIMIT = 256
const ASSET_PATH_LIMIT = 1024

export class CapabilityService {
  private readonly store: ServerStore
  private readonly now: () => Timestamp
  private readonly tokens: CapabilityTokenService
  private readonly connectors?: Pick<ConnectorRepository, 'list'>
  constructor(
    store: ServerStore,
    now: () => Timestamp,
    tokens: CapabilityTokenService,
    connectors?: Pick<ConnectorRepository, 'list'>,
  ) { this.store = store; this.now = now; this.tokens = tokens; this.connectors = connectors;}

  async listProjectAssets(projectId: ProjectId): Promise<readonly CapabilityAsset[]> {
    return this.store.resources.listCapabilityAssets(projectId)
  }

  async replaceProjectAssets(projectId: ProjectId, drafts: readonly CapabilityAssetDraft[]): Promise<readonly CapabilityAsset[]> {
    if (drafts.length > ASSET_COUNT_LIMIT) throw new CapabilityError('invalid-input', `At most ${ASSET_COUNT_LIMIT} capability assets are allowed`)
    let totalBytes = 0
    const targets = new Set<string>()
    const assets = drafts.map((draft, index) => {
      const kind = capabilityAssetKind(draft.kind, index)
      const name = requiredAssetText(draft.name, `items[${index}].name`, ASSET_FIELD_LIMIT)
      const version = draft.version === undefined ? '1' : requiredAssetText(draft.version, `items[${index}].version`, ASSET_FIELD_LIMIT)
      const content = typeof draft.content === 'string' ? draft.content : invalidAsset(`items[${index}].content must be a string`)
      const targetPath = optionalAssetText(draft.targetPath, `items[${index}].targetPath`, ASSET_PATH_LIMIT)
      const materializedTarget = assetTarget(kind, name, targetPath)
      if (targets.has(materializedTarget)) throw new CapabilityError('invalid-input', `Capability assets contain duplicate target ${materializedTarget}`)
      targets.add(materializedTarget)
      if (draft.id !== undefined) requiredAssetText(draft.id, `items[${index}].id`, ASSET_FIELD_LIMIT)
      totalBytes += Buffer.byteLength(content)
      if (totalBytes > ASSET_BYTES_LIMIT) throw new CapabilityError('invalid-input', `Capability assets exceed ${ASSET_BYTES_LIMIT} bytes`)
      return {
        id: draft.id ?? randomUUID(),
        kind,
        name,
        version,
        content,
        checksum: createHash('sha256').update(content).digest('hex'),
        targetPath,
      }
    })
    await this.store.transaction(async (tx) => tx.resources.replaceCapabilityAssets(projectId, assets))
    return assets
  }

  async prepareTurn(input: {
    readonly sessionId: SessionId
    readonly turnId: CapabilityGrantClaims['turnId']
    readonly actorId?: import('@wemux/domain').UserId
    readonly allowedTools?: readonly CapabilityToolName[]
  }, resources = this.store.resources): Promise<{ readonly runtime: CapabilityRuntimePayload; readonly token: string }> {
    const session = await this.requireSession(input.sessionId, resources)
    const workspace = await resources.getWorkspace(session.workspaceId)
    if (!workspace) throw new CapabilityError('not-found', 'Workspace not found')
    const assets = await resources.listCapabilityAssets(session.projectId)
    const connectors = await this.resolveConnectors(session, input)
    const allowedConnectorIds = connectors.map(connector => connector.id)
    const allowedTools = input.allowedTools ?? [
      'session.info',
      'agent.list',
      'agent.send',
      'agent.inbox.list',
      'agent.inbox.read',
      'mcp.list_tools',
      'mcp.call',
      'http.call',
    ]
    const now = this.now()
    const snapshot: CapabilitySnapshot = {
      id: randomUUID(),
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      version: 1,
      assets,
      allowedTools,
      allowedConnectorIds,
      connectors,
      createdAt: now,
    }
    const issued = this.tokens.issue({
      grantId: randomUUID(),
      sessionId: session.id,
      turnId: input.turnId,
      actorAgentId: session.id,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      allowedTools,
      allowedConnectorIds,
    })
    return {
      token: issued.token,
      runtime: {
        snapshot,
        token: issued.token,
        grant: {
          grantId: issued.claims.id,
          sessionId: issued.claims.sessionId,
          turnId: issued.claims.turnId,
          actorAgentId: issued.claims.actorAgentId,
          projectId: issued.claims.projectId,
          workspaceId: issued.claims.workspaceId,
          allowedTools: issued.claims.allowedTools,
          allowedConnectorIds: issued.claims.allowedConnectorIds,
          issuedAt: issued.claims.issuedAt,
          expiresAt: issued.claims.expiresAt,
        },
      },
    }
  }

  async verify(token: string, requiredTool: CapabilityToolName): Promise<CapabilityGrantClaims> {
    const claims = this.tokens.verify(token)
    if (!claims.allowedTools.includes(requiredTool)) throw new CapabilityError('forbidden', `Capability ${requiredTool} is not allowed`)
    const session = await this.store.resources.getSession(claims.sessionId)
    if (!session || session.deletedAt !== null || session.projectId !== claims.projectId || session.workspaceId !== claims.workspaceId) throw new CapabilityError('forbidden', 'Capability session is no longer active')
    return claims
  }

  async sessionInfo(claims: CapabilityGrantClaims): Promise<CapabilitySessionInfoResult> {
    const session = await this.requireSession(claims.sessionId)
    return {
      projectId: claims.projectId,
      workspaceId: claims.workspaceId,
      sessionId: claims.sessionId,
      turnId: claims.turnId,
      agentId: claims.actorAgentId,
      agentKey: session.binding.agent.agentKey,
      capabilities: claims.allowedTools,
    }
  }

  async listAgents(claims: CapabilityGrantClaims): Promise<CapabilityAgentListResult> {
    const sessions = await this.store.resources.listSessions()
    return {
      agents: sessions
        .filter((session) => session.projectId === claims.projectId && session.deletedAt === null)
        .map((session) => ({
          agentId: session.id,
          agentKey: session.binding.agent.agentKey,
          sessionId: session.id,
          status: session.runtimeState === 'running' ? 'running' : 'idle',
        })),
    }
  }

  async sendAgentMessage(claims: CapabilityGrantClaims, input: CapabilityAgentSendInput): Promise<CapabilityAgentSendResult> {
    const content = input.content.trim()
    if (!content || content.includes('\0')) throw new CapabilityError('invalid-input', 'Message content is invalid')
    const idempotencyKey = requiredAssetText(input.idempotencyKey, 'idempotencyKey', ASSET_FIELD_LIMIT)
    const payloadFingerprint = createHash('sha256').update(JSON.stringify({ toAgentId: input.toAgentId, content })).digest('hex')
    const target = await this.findProjectAgent(claims.projectId, input.toAgentId)
    if (!target) throw new CapabilityError('not-found', 'Target agent is not available in this project')
    const message: AgentInboxMessage = {
      id: randomUUID(),
      projectId: claims.projectId,
      fromSessionId: claims.sessionId,
      toSessionId: target.id,
      fromAgentId: claims.actorAgentId,
      toAgentId: target.id,
      fromAgentKey: (await this.requireSession(claims.sessionId)).binding.agent.agentKey,
      toAgentKey: target.binding.agent.agentKey,
      content,
      payloadFingerprint,
      status: 'accepted',
      createdAt: this.now(),
      readAt: null,
    }
    const stored = await this.store.transaction(async (tx) =>
      tx.resources.createAgentInboxMessage({ message, idempotencyKey }),
    )
    return { message: stored }
  }

  async listInbox(claims: CapabilityGrantClaims, input: CapabilityInboxListInput): Promise<CapabilityInboxListResult> {
    return { messages: await this.store.resources.listAgentInboxMessages(claims.sessionId, input.unreadOnly) }
  }

  async readInbox(claims: CapabilityGrantClaims, input: CapabilityInboxReadInput): Promise<CapabilityInboxReadResult> {
    const existing = await this.store.resources.getAgentInboxMessage(input.messageId)
    if (!existing || existing.toSessionId !== claims.sessionId) throw new CapabilityError('not-found', 'Inbox message not found')
    const message =
      existing.status === 'read'
        ? existing
        : await this.store.transaction(async (tx) => tx.resources.markAgentInboxMessageRead(existing.id, this.now()))
    if (!message) throw new CapabilityError('not-found', 'Inbox message not found')
    return { message }
  }

  private async resolveConnectors(
    session: Awaited<ReturnType<CapabilityService['requireSession']>>,
    input: { readonly actorId?: import('@wemux/domain').UserId },
  ): Promise<readonly ConnectorDefinition[]> {
    if (!this.connectors || !input.actorId) return []
    try {
      const project = await this.store.resources.getProject(session.projectId)
      if (!project || project.deletedAt) return []
      const workerId = session.binding.agent.workerId
      const records = await this.store.identity.getIdentityRecords({ userId: input.actorId, teamId: project.teamId, projectId: project.id, workerId, sessionId: session.id })
      const projectVisible = project.ownerId === input.actorId || Boolean(records.membership && (records.projectGrant || project.shareScope === 'team'))
      if (!projectVisible) return []
      return (await this.connectors.list(session.projectId)).filter(connector => connector.enabled && (!connector.allowedWorkerIds.length || connector.allowedWorkerIds.includes(workerId)))
    } catch {
      return []
    }
  }

  private async requireSession(sessionId: SessionId, resources = this.store.resources) {
    const session = await resources.getSession(sessionId)
    if (!session || session.deletedAt !== null) throw new CapabilityError('not-found', 'Session not found')
    return session
  }

  private async findProjectAgent(projectId: ProjectId, agentId: SessionId) {
    const session = await this.store.resources.getSession(agentId)
    return session?.projectId === projectId && session.deletedAt === null ? session : null
  }
}

function capabilityAssetKind(value: unknown, index: number): CapabilityAsset['kind'] {
  if (value === 'skill' || value === 'prompt' || value === 'instruction' || value === 'file') return value
  throw new CapabilityError('invalid-input', `items[${index}].kind is invalid`)
}

function requiredAssetText(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string') throw new CapabilityError('invalid-input', `${field} must be a string`)
  const result = value.trim()
  if (!result || result.includes('\0') || result.length > limit) throw new CapabilityError('invalid-input', `${field} is invalid`)
  return result
}

function optionalAssetText(value: unknown, field: string, limit: number): string | null {
  if (value === undefined || value === null) return null
  return requiredAssetText(value, field, limit)
}

function assetTarget(kind: CapabilityAsset['kind'], name: string, targetPath: string | null): string {
  if (kind === 'skill') return `skill:${name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'skill'}`
  if (kind === 'file') return `file:${targetPath ?? name}`
  return `${kind}:${name}`
}

function invalidAsset(message: string): never {
  throw new CapabilityError('invalid-input', message)
}
