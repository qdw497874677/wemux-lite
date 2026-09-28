export type ChannelDTO = GenericWebhookChannelDTO | FeishuChannelDTO | DingTalkChannelDTO

interface ChannelBaseDTO {
  readonly id: string
  readonly projectId: string
  readonly name: string
  readonly enabled: boolean
  readonly revision: number
  readonly credentialAvailability: 'unconfigured' | 'available' | 'unavailable' | 'invalid'
  readonly webhookPath: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface GenericWebhookChannelDTO extends ChannelBaseDTO {
  readonly kind: 'generic_webhook'
  readonly tokenVersion: number
  readonly sourceCidrs: readonly string[]
}

export interface FeishuChannelDTO extends ChannelBaseDTO {
  readonly kind: 'feishu'
  readonly appIdHint: string
  readonly verificationMode: 'verification_token' | 'encrypted'
  readonly acceptEventSchema: '2.0'
  readonly tenantKey: string | null
}

export interface DingTalkChannelDTO extends ChannelBaseDTO {
  readonly kind: 'dingtalk'
  readonly clientIdHint: string
  readonly robotCode: string
  readonly connection: { readonly state: 'offline' | 'connecting' | 'online'; readonly connectedAt?: string; readonly lastError?: string; readonly reconnectAttempt: number }
}

export interface ChannelBindingDTO { readonly id: string; readonly channelId: string; readonly projectId: string; readonly externalConversationKey: string; readonly sessionId: string; readonly workerId: string; readonly callbackUrl: string; readonly senderAllowlist: readonly string[]; readonly revision: number; readonly enabled: boolean; readonly createdAt: string; readonly updatedAt: string }
export interface InboundDeliveryDTO { readonly id: string; readonly channelId: string; readonly status: string; readonly identityStrength: 'strong' | 'weak_identity'; readonly externalConversationKey: string; readonly senderId: string; readonly sessionId: string | null; readonly diagnostic: string | null; readonly receivedAt: string; readonly updatedAt: string }
export interface OutboundDeliveryDTO { readonly id: string; readonly channelId: string; readonly bindingId: string; readonly sessionId: string; readonly status: 'pending' | 'sending' | 'delivered' | 'retry_wait' | 'dead_letter' | 'cancelled'; readonly attempt: number; readonly responseStatus: number | null; readonly diagnostic: string | null; readonly createdAt: string; readonly updatedAt: string; readonly deliveredAt: string | null }
export interface ChannelListDTO { readonly items: readonly ChannelDTO[]; readonly bindings: readonly ChannelBindingDTO[]; readonly inbound: readonly InboundDeliveryDTO[]; readonly outbound: readonly OutboundDeliveryDTO[] }
export type CreateChannelDTO =
  | { readonly requestId: string; readonly kind: 'generic_webhook'; readonly name: string; readonly callbackUrl: string | null; readonly sourceCidrs: readonly string[] }
  | { readonly requestId: string; readonly kind: 'feishu'; readonly name: string; readonly appId: string; readonly appSecret: string; readonly verificationToken: string; readonly encryptKey: string | null }
  | { readonly requestId: string; readonly kind: 'dingtalk'; readonly name: string; readonly clientId: string; readonly clientSecret: string; readonly robotCode: string }
export interface CreatedChannelDTO { readonly channel: ChannelDTO; readonly issuedToken?: string; readonly replayed: boolean }
export interface CreateChannelBindingDTO { readonly requestId: string; readonly channelId: string; readonly externalConversationKey: string; readonly sessionId: string; readonly callbackUrl?: string; readonly senderAllowlist: readonly string[] }
