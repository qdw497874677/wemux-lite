import type { RuntimeProtocolVersion } from './runtime-protocol.js'

export const RUNTIME_PROTOCOL_V2: RuntimeProtocolVersion = 2
export const RUNTIME_SUPPORTED_PROTOCOLS = [RUNTIME_PROTOCOL_V2] as const

export interface RuntimeCompatibilityResult {
  readonly compatible: boolean
  readonly protocolVersion?: RuntimeProtocolVersion
  readonly missingFeatures: readonly string[]
  readonly reason?: 'unsupported_protocol' | 'missing_feature'
}

export const negotiateRuntimeCompatibility = (
  offeredProtocols: readonly number[],
  offeredFeatures: readonly string[],
  requestedProtocol: number,
  requiredFeatures: readonly string[] = [],
): RuntimeCompatibilityResult => {
  if (!RUNTIME_SUPPORTED_PROTOCOLS.some(version => version === requestedProtocol) || !offeredProtocols.includes(requestedProtocol)) {
    return { compatible: false, missingFeatures: [], reason: 'unsupported_protocol' }
  }
  const missingFeatures = requiredFeatures.filter(feature => !offeredFeatures.includes(feature))
  return missingFeatures.length === 0
    ? { compatible: true, protocolVersion: requestedProtocol as RuntimeProtocolVersion, missingFeatures }
    : { compatible: false, protocolVersion: requestedProtocol as RuntimeProtocolVersion, missingFeatures, reason: 'missing_feature' }
}
