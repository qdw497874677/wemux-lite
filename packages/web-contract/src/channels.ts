export interface ChannelDTO {
  readonly id: string
  readonly projectId: string
  readonly kind: 'generic_webhook'
  readonly name: string
  readonly enabled: boolean
  readonly revision: number
  readonly credentialAvailability: 'unconfigured' | 'available' | 'unavailable' | 'invalid'
  readonly tokenVersion: number
  readonly webhookPath: string
  readonly sourceCidrs: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}
export interface ChannelBindingDTO { readonly id: string; readonly channelId: string; readonly projectId: string; readonly externalConversationKey: string; readonly sessionId: string; readonly workerId: string; readonly callbackUrl: string; readonly senderAllowlist: readonly string[]; readonly revision: number; readonly enabled: boolean; readonly createdAt: string; readonly updatedAt: string }
export interface InboundDeliveryDTO { readonly id: string; readonly channelId: string; readonly status: string; readonly identityStrength: 'strong' | 'weak_identity'; readonly externalConversationKey: string; readonly senderId: string; readonly sessionId: string | null; readonly diagnostic: string | null; readonly receivedAt: string; readonly updatedAt: string }
export interface OutboundDeliveryDTO { readonly id: string; readonly channelId: string; readonly bindingId: string; readonly sessionId: string; readonly status: 'pending' | 'sending' | 'delivered' | 'retry_wait' | 'dead_letter' | 'cancelled'; readonly attempt: number; readonly responseStatus: number | null; readonly diagnostic: string | null; readonly createdAt: string; readonly updatedAt: string; readonly deliveredAt: string | null }
export interface ChannelListDTO { readonly items: readonly ChannelDTO[]; readonly bindings: readonly ChannelBindingDTO[]; readonly inbound: readonly InboundDeliveryDTO[]; readonly outbound: readonly OutboundDeliveryDTO[] }
export interface CreateChannelDTO { readonly requestId: string; readonly name: string; readonly callbackUrl: string | null; readonly sourceCidrs: readonly string[] }
export interface CreatedChannelDTO { readonly channel: ChannelDTO; readonly issuedToken: string; readonly replayed: boolean }
export interface CreateChannelBindingDTO { readonly requestId: string; readonly channelId: string; readonly externalConversationKey: string; readonly sessionId: string; readonly callbackUrl: string; readonly senderAllowlist: readonly string[] }
