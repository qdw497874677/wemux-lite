import { isFileWriteAdmissionType, isServerFileWriteAdmissionStructure, isWorkerFileWriteAdmissionStructure } from './file-admission.js'
import { WEMUX_ADK_PROFILE_V1 } from '@wemux/domain'
import type { MessageId, Timestamp, WorkerId } from '@wemux/domain'
import type { ServerPayload, WorkerPayload } from './messages.js'
import { isServerResourcePayload, isWorkerResourcePayload } from './resources.js'

export const TRANSPORT_V2_MAJOR = 2 as const
export const TRANSPORT_V2_MINOR = 0 as const
export { WEMUX_ADK_PROFILE_V1 }

export type TransportLane = 'control' | 'command' | 'journal' | 'snapshot'
export type VolatileLane = 'realtime' | 'presence'

export interface DeliveryCursor {
  readonly deliveryEpoch: string
  readonly ackThrough: number
}

export interface WorkerTransportHello {
  readonly frameType: 'transport.hello'
  readonly side: 'worker'
  readonly transport: {
    readonly supportedMajors: readonly number[]
    readonly preferredMinorByMajor: Readonly<Record<string, number>>
  }
  readonly adkProfiles: readonly string[]
  readonly features: readonly string[]
  readonly workerId: WorkerId
  readonly workerVersion: string
  readonly name: string
  readonly platform: string
  readonly architecture: string
  readonly resume: {
    readonly logicalConnectionId: string | null
    readonly workerToServer: DeliveryCursor | null
    readonly serverToWorker: DeliveryCursor | null
  }
}

export interface ServerTransportHello {
  readonly frameType: 'transport.hello'
  readonly side: 'server'
  readonly selectedTransport: { readonly major: typeof TRANSPORT_V2_MAJOR; readonly minor: number }
  readonly selectedAdkProfile: string
  readonly enabledFeatures: readonly string[]
  readonly logicalConnectionId: string
  readonly connectionEpoch: string
  readonly resumeAccepted: boolean
  readonly authoritativeCursors: {
    readonly workerToServer: DeliveryCursor
    readonly serverToWorker: DeliveryCursor
  }
  readonly acceptedAt: Timestamp
}

export interface DurableDataFrame<Payload = unknown> {
  readonly frameType: 'data'
  readonly durability: 'durable'
  readonly deliveryEpoch: string
  readonly directionSeq: number
  readonly messageId: MessageId
  readonly lane: TransportLane
  readonly payloadVersion: string
  readonly expiresAt: Timestamp | null
  readonly payload: Payload
}

export interface VolatileDataFrame<Payload = unknown> {
  readonly frameType: 'data'
  readonly durability: 'volatile'
  readonly lane: VolatileLane
  readonly payloadVersion: string
  readonly payload: Payload
}

export interface TransportAckFrame {
  readonly frameType: 'transport.ack'
  readonly deliveryEpoch: string
  readonly ackThrough: number
}

export type TransportErrorCode =
  | 'unsupported-transport-major'
  | 'unsupported-adk-profile'
  | 'unauthorized'
  | 'revoked'
  | 'invalid-frame'
  | 'integrity-error'
  | 'resume-rejected'
  | 'over-capacity'
  | 'temporary-unavailable'

export interface TransportPingFrame {
  readonly frameType: 'transport.ping' | 'transport.pong'
  readonly nonce: string
  readonly sentAt: Timestamp
}

export interface TransportErrorFrame {
  readonly frameType: 'transport.error'
  readonly code: TransportErrorCode
  readonly message: string
  readonly retryable: boolean
}

export type WorkerDataFrame = DurableDataFrame<WorkerPayload> | VolatileDataFrame<WorkerPayload>
export type ServerDataFrame = DurableDataFrame<ServerPayload> | VolatileDataFrame<ServerPayload>
export type WorkerHelloFrame = WorkerTransportHello
export type ServerHelloFrame = ServerTransportHello
export type WorkerTransportAckFrame = TransportAckFrame
export type ServerTransportAckFrame = TransportAckFrame
export type WorkerTransportFrame = WorkerTransportHello | WorkerDataFrame | TransportAckFrame | TransportPingFrame | TransportErrorFrame
export type ServerTransportFrame = ServerTransportHello | ServerDataFrame | TransportAckFrame | TransportPingFrame | TransportErrorFrame
export type WorkerToServerFrame = WorkerTransportFrame
export type ServerToWorkerFrame = ServerTransportFrame
export type TransportV2Frame = WorkerTransportFrame | ServerTransportFrame

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const stringArray = (value: unknown, max = 64): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => text(item, 256))
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value)

function cursor(value: unknown): value is DeliveryCursor {
  const item = record(value)
  return Boolean(item && exactKeys(item, ['deliveryEpoch', 'ackThrough']) && text(item.deliveryEpoch) && integer(item.ackThrough))
}

function nullableCursor(value: unknown): value is DeliveryCursor | null { return value === null || cursor(value) }

function parseWorkerHello(value: Record<string, unknown>): WorkerTransportHello | null {
  if (!exactKeys(value, ['frameType', 'side', 'transport', 'adkProfiles', 'features', 'workerId', 'workerVersion', 'name', 'platform', 'architecture', 'resume'])) return null
  const transport = record(value.transport), resume = record(value.resume)
  if (value.frameType !== 'transport.hello' || value.side !== 'worker' || !transport || !resume) return null
  if (!exactKeys(transport, ['supportedMajors', 'preferredMinorByMajor']) || !Array.isArray(transport.supportedMajors) || !transport.supportedMajors.every(item => integer(item, 1))) return null
  const preferred = record(transport.preferredMinorByMajor)
  if (!preferred || !Object.values(preferred).every(item => integer(item))) return null
  if (!exactKeys(resume, ['logicalConnectionId', 'workerToServer', 'serverToWorker'])) return null
  if (!(resume.logicalConnectionId === null || text(resume.logicalConnectionId)) || !nullableCursor(resume.workerToServer) || !nullableCursor(resume.serverToWorker)) return null
  if (!stringArray(value.adkProfiles) || !stringArray(value.features) || !text(value.workerId) || !text(value.workerVersion) || !text(value.name) || !text(value.platform) || !text(value.architecture)) return null
  return value as unknown as WorkerTransportHello
}

function parseServerHello(value: Record<string, unknown>): ServerTransportHello | null {
  if (!exactKeys(value, ['frameType', 'side', 'selectedTransport', 'selectedAdkProfile', 'enabledFeatures', 'logicalConnectionId', 'connectionEpoch', 'resumeAccepted', 'authoritativeCursors', 'acceptedAt'])) return null
  const selected = record(value.selectedTransport), cursors = record(value.authoritativeCursors)
  if (value.frameType !== 'transport.hello' || value.side !== 'server' || !selected || !cursors) return null
  if (!exactKeys(selected, ['major', 'minor']) || selected.major !== TRANSPORT_V2_MAJOR || !integer(selected.minor)) return null
  if (!exactKeys(cursors, ['workerToServer', 'serverToWorker']) || !cursor(cursors.workerToServer) || !cursor(cursors.serverToWorker)) return null
  if (!text(value.selectedAdkProfile) || !stringArray(value.enabledFeatures) || !text(value.logicalConnectionId) || !text(value.connectionEpoch) || typeof value.resumeAccepted !== 'boolean' || !text(value.acceptedAt) || !Number.isFinite(Date.parse(value.acceptedAt))) return null
  return value as unknown as ServerTransportHello
}

function workerPayload(value: unknown): value is WorkerPayload {
  const payload = record(value)
  return Boolean(payload && (['heartbeat', 'hello', 'capability', 'ack', 'event', 'fs.response', 'terminal.response', 'terminal.output', 'terminal.exit', 'sync'].includes(String(payload.type)) || isWorkerResourcePayload(payload) || isWorkerFileWriteAdmissionStructure(payload)))
}

function serverPayload(value: unknown): value is ServerPayload {
  const payload = record(value)
  return Boolean(payload && (['heartbeat', 'command', 'fs.request', 'terminal.request', 'sync'].includes(String(payload.type)) || isServerResourcePayload(payload) || isServerFileWriteAdmissionStructure(payload)))
}

function parseData(value: Record<string, unknown>): DurableDataFrame | VolatileDataFrame | null {
  if (value.frameType !== 'data') return null
  if (value.durability === 'durable') {
    if (!exactKeys(value, ['frameType', 'durability', 'deliveryEpoch', 'directionSeq', 'messageId', 'lane', 'payloadVersion', 'expiresAt', 'payload'])) return null
    if (!text(value.deliveryEpoch) || !integer(value.directionSeq, 1) || !text(value.messageId) || !['control', 'command', 'journal', 'snapshot'].includes(String(value.lane)) || !text(value.payloadVersion) || !(value.expiresAt === null || (text(value.expiresAt) && Number.isFinite(Date.parse(value.expiresAt))))) return null
    return value as unknown as DurableDataFrame
  }
  if (value.durability === 'volatile') {
    if (isFileWriteAdmissionType(value.payload)) return null
    if (!exactKeys(value, ['frameType', 'durability', 'lane', 'payloadVersion', 'payload'])) return null
    if (!['realtime', 'presence'].includes(String(value.lane)) || !text(value.payloadVersion)) return null
    return value as unknown as VolatileDataFrame
  }
  return null
}

function parseAck(value: Record<string, unknown>): TransportAckFrame | null {
  return exactKeys(value, ['frameType', 'deliveryEpoch', 'ackThrough']) && value.frameType === 'transport.ack' && text(value.deliveryEpoch) && integer(value.ackThrough) ? value as unknown as TransportAckFrame : null
}

function parsePing(value: Record<string, unknown>): TransportPingFrame | null {
  return exactKeys(value, ['frameType', 'nonce', 'sentAt']) && (value.frameType === 'transport.ping' || value.frameType === 'transport.pong') && text(value.nonce) && text(value.sentAt) && Number.isFinite(Date.parse(value.sentAt)) ? value as unknown as TransportPingFrame : null
}

function parseError(value: Record<string, unknown>): TransportErrorFrame | null {
  const codes: readonly TransportErrorCode[] = ['unsupported-transport-major', 'unsupported-adk-profile', 'unauthorized', 'revoked', 'invalid-frame', 'integrity-error', 'resume-rejected', 'over-capacity', 'temporary-unavailable']
  return exactKeys(value, ['frameType', 'code', 'message', 'retryable']) && value.frameType === 'transport.error' && codes.includes(value.code as TransportErrorCode) && text(value.message) && typeof value.retryable === 'boolean' ? value as unknown as TransportErrorFrame : null
}

/** Structural transport validation only; durable file admission integrity requires the Node subpath. */
export function parseWorkerTransportFrame(value: unknown): WorkerTransportFrame {
  const frame = record(value)
  const parsed = frame && (parseWorkerHello(frame) ?? parseData(frame) ?? parseAck(frame) ?? parsePing(frame) ?? parseError(frame))
  if (!parsed || ('side' in parsed && parsed.side !== 'worker') || (parsed.frameType === 'data' && !workerPayload(parsed.payload))) throw new Error('Invalid Worker transport v2 frame')
  return parsed as WorkerTransportFrame
}

/** Structural transport validation only; durable file admission integrity requires the Node subpath. */
export function parseServerTransportFrame(value: unknown): ServerTransportFrame {
  const frame = record(value)
  const parsed = frame && (parseServerHello(frame) ?? parseData(frame) ?? parseAck(frame) ?? parsePing(frame) ?? parseError(frame))
  if (!parsed || ('side' in parsed && parsed.side !== 'server') || (parsed.frameType === 'data' && !serverPayload(parsed.payload))) throw new Error('Invalid Server transport v2 frame')
  return parsed as ServerTransportFrame
}
