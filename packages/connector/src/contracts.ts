import { createHash } from 'node:crypto'
import type {
  ProjectId,
  SessionId,
  Timestamp,
  ToolCallId,
  TurnId,
  UserId,
  WorkerId,
  WorkspaceId,
} from '@wemux/domain'

declare const connectorIdBrand: unique symbol

export type ConnectorId = string & { readonly [connectorIdBrand]: 'ConnectorId' }
export type ChannelId = string & { readonly [connectorIdBrand]: 'ChannelId' }
export type ChannelBindingId = string & { readonly [connectorIdBrand]: 'ChannelBindingId' }
export type ConnectorCredentialId = string & { readonly [connectorIdBrand]: 'ConnectorCredentialId' }

export type OperationType = 'read' | 'write' | 'destructive'
export type CredentialAvailability =
  | 'not_required'
  | 'unconfigured'
  | 'available'
  | 'unavailable'
  | 'invalid'

export interface ConnectorRiskDefaults {
  readonly requireApprovalForRead: boolean
  readonly allowMcpReadOnlyHint: boolean
}

export interface ConnectorDefinitionBase {
  readonly id: ConnectorId
  readonly projectId: ProjectId
  readonly name: string
  readonly description: string | null
  readonly revision: number
  readonly enabled: boolean
  readonly allowedWorkerIds: readonly WorkerId[]
  readonly credentialRef: ConnectorCredentialId | null
  readonly credentialAvailability: CredentialAvailability
  readonly riskDefaults: ConnectorRiskDefaults
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export type ConnectorDefinition = McpConnectorDefinition | HttpConnectorDefinition

export interface McpConnectorDefinition extends ConnectorDefinitionBase {
  readonly kind: 'mcp'
  readonly config: McpConnectorConfig
}

export type McpConnectorConfig =
  | {
      readonly transport: 'stdio'
      readonly command: string
      readonly args: readonly string[]
      readonly cwd: string | null
      readonly publicEnvironment: Readonly<Record<string, string>>
      readonly secretEnvironmentNames: readonly string[]
    }
  | {
      readonly transport: 'streamable_http'
      readonly url: string
      readonly publicHeaders: Readonly<Record<string, string>>
      readonly authentication: 'none' | 'api_key' | 'custom_credential'
      readonly allowPrivateNetwork: boolean
    }

export interface HttpConnectorDefinition extends ConnectorDefinitionBase {
  readonly kind: 'http'
  readonly config: {
    readonly baseUrl: string
    readonly allowedOperations: readonly HttpOperationDefinition[]
    readonly authentication: 'none' | 'api_key' | 'custom_credential'
    readonly publicHeaders: Readonly<Record<string, string>>
    readonly allowPrivateNetwork: boolean
  }
}

export interface HttpOperationDefinition {
  readonly id: string
  readonly description: string
  readonly method: 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly pathTemplate: string
  readonly allowedQueryNames: readonly string[]
  readonly allowedRequestHeaderNames: readonly string[]
  readonly requestContentTypes: readonly (
    | 'application/json'
    | 'text/plain'
    | 'application/x-www-form-urlencoded'
  )[]
  readonly operationTypeOverride: OperationType | null
}

/** Supported channel transports: signed HTTP webhook, Feishu HTTP events, and DingTalk Stream. */
export type Channel = GenericWebhookChannel | FeishuChannel | DingTalkChannel

export interface ChannelBase {
  readonly id: ChannelId
  readonly projectId: ProjectId
  readonly name: string
  readonly credentialRef: ConnectorCredentialId
  readonly credentialAvailability: Exclude<CredentialAvailability, 'not_required'>
  readonly enabled: boolean
  readonly revision: number
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export interface GenericWebhookChannel extends ChannelBase {
  readonly kind: 'generic_webhook'
  readonly config: {
    readonly tokenVersion: number
    readonly previousTokenValidUntil: Timestamp | null
    readonly replayWindowSeconds: 300
    readonly sourceCidrs: readonly string[]
  }
}

export interface FeishuChannel extends ChannelBase {
  readonly kind: 'feishu'
  readonly config: {
    readonly appIdHint: string
    readonly verificationMode: 'verification_token' | 'signature' | 'encrypted'
    readonly acceptEventSchema: '2.0'
    readonly tenantKey: string | null
  }
}

export interface DingTalkChannel extends ChannelBase {
  readonly kind: 'dingtalk'
  readonly config: {
    readonly clientIdHint: string
    readonly robotCode: string
    readonly streamMode: true
    readonly messageTopic: '/v1.0/im/bot/messages/get'
  }
}

export interface ChannelBinding {
  readonly id: ChannelBindingId
  readonly projectId: ProjectId
  readonly channelId: ChannelId
  readonly externalConversationKey: string
  readonly sessionId: SessionId
  readonly workerId: WorkerId
  readonly triggerPolicy: ChannelTriggerPolicy
  readonly senderAllowlist: readonly string[]
  readonly revision: number
  readonly enabled: boolean
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export type ChannelTriggerPolicy =
  | { readonly kind: 'always' }
  | { readonly kind: 'mention_only' }
  | { readonly kind: 'private_chat_or_mention' }

export interface CredentialRecord {
  readonly id: ConnectorCredentialId
  readonly owner:
    | { readonly kind: 'connector'; readonly connectorId: ConnectorId }
    | { readonly kind: 'channel'; readonly channelId: ChannelId }
  readonly authType: 'api_key' | 'custom_credential'
  readonly ciphertext: string
  readonly profile: {
    readonly accountId: string | null
    readonly displayName: string | null
    readonly grantedScopes: readonly string[]
  }
  readonly revision: number
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export interface ToolCall {
  readonly requestId: string
  readonly fingerprint: string
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly toolCallId: ToolCallId
  readonly connectorId: ConnectorId
  readonly connectorRevision: number
  readonly action:
    | { readonly kind: 'mcp'; readonly toolName: string }
    | { readonly kind: 'http'; readonly operationId: string }
  readonly operationType: OperationType
  readonly input: unknown
  readonly actor: {
    readonly kind: 'agent'
    readonly agentId: SessionId
    readonly requestedByAccountId: UserId | null
    readonly channelDeliveryId: string | null
  }
  readonly createdAt: Timestamp
}

export const connectorExecutionErrorCodes = [
  'invalid_input',
  'scope_denied',
  'approval_required',
  'approval_denied',
  'credential_unavailable',
  'connector_unavailable',
  'revision_conflict',
  'idempotency_conflict',
  'timeout',
  'cancelled',
  'upstream_error',
  'rate_limited',
  'response_too_large',
  'unsafe_destination',
  'unsupported_content_type',
  'internal_error',
] as const

export type ConnectorExecutionErrorCode = (typeof connectorExecutionErrorCodes)[number]

export type ExecutionResult<T = unknown> =
  | {
      readonly ok: true
      readonly output: T
      readonly requestId: string
      readonly connectorRevision: number
      readonly completedAt: Timestamp
    }
  | {
      readonly ok: false
      readonly error: {
        readonly code: ConnectorExecutionErrorCode
        readonly message: string
        readonly retryable: boolean
        readonly retryAfterMs: number | null
      }
      readonly requestId: string
      readonly connectorRevision: number | null
      readonly completedAt: Timestamp
    }

/** Return the SHA-256 digest of stable-key-order UTF-8 JSON. */
export function stableFingerprint(value: unknown): string {
  const canonical = canonicalJson(value)
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('fingerprint values must contain only finite numbers')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('fingerprint values must contain only plain objects and arrays')
    }
    const entries = Object.keys(value as object)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !('value' in descriptor)) {
          throw new TypeError('fingerprint values must not contain accessors')
        }
        if (descriptor.value === undefined || typeof descriptor.value === 'function' || typeof descriptor.value === 'symbol') {
          throw new TypeError('fingerprint values must be JSON values')
        }
        return `${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`
      })
    return `{${entries.join(',')}}`
  }
  throw new TypeError('fingerprint values must be JSON values')
}
