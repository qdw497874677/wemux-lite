import { assertModelProviderConfig, type ReconcileReport, type ResourceFile, type ResourceKind, type ResourceSetSnapshot, type WorkerId } from '@wemux/domain'

export interface ResourceSetSummary {
  readonly bindingId: string
  readonly resourceRevisionId: string
  readonly kind: ResourceKind
  readonly contentSha256: string
}

export interface ResourceSetNotifyPayload {
  readonly type: 'resource.set.notify'
  readonly workerId: WorkerId
  readonly setRevision: number
  readonly fingerprint: string
  readonly resources: readonly ResourceSetSummary[]
}

export type ResourceSetPullPayload =
  | {
      readonly type: 'resource.set.pull'
      readonly action: 'request'
      readonly requestId: string
      readonly workerId: WorkerId
      readonly knownSetRevision: number | null
    }
  | {
      readonly type: 'resource.set.pull'
      readonly action: 'snapshot'
      readonly requestId: string
      /** 完整 snapshot 的 binding 项包含文件 hash 清单，不携带 blob。 */
      readonly resourceSet: ResourceSetSnapshot
    }

export type ResourceBlobFetchPayload =
  | {
      readonly type: 'resource.blob.fetch'
      readonly action: 'request'
      readonly requestId: string
      readonly sha256: string
    }
  | {
      readonly type: 'resource.blob.fetch'
      readonly action: 'response'
      readonly requestId: string
      readonly sha256: string
      readonly mediaType: string
      readonly size: number
      readonly base64Content: string
    }
  | {
      readonly type: 'resource.blob.fetch'
      readonly action: 'not-found'
      readonly requestId: string
      readonly sha256: string
    }

export interface ResourceReconcileReportPayload {
  readonly type: 'resource.reconcile.report'
  readonly report: ReconcileReport
}

export type ServerResourcePayload =
  | ResourceSetNotifyPayload
  | Extract<ResourceSetPullPayload, { readonly action: 'snapshot' }>
  | Exclude<ResourceBlobFetchPayload, { readonly action: 'request' }>

export type WorkerResourcePayload =
  | Extract<ResourceSetPullPayload, { readonly action: 'request' }>
  | Extract<ResourceBlobFetchPayload, { readonly action: 'request' }>
  | ResourceReconcileReportPayload

export type ResourceRevisionWireFile = ResourceFile

const SHA256 = /^[a-f0-9]{64}$/
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value)
const hash = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value)
const kind = (value: unknown): value is ResourceKind => value === 'skill' || value === 'agent-runtime' || value === 'model-provider' || value === 'connector-config'
const provider = (value: unknown): boolean => {
  const item = object(value)
  if (!item || !exact(item, ['mode', 'contentSha256', 'config']) || item.mode !== 'inline-config' || !hash(item.contentSha256)) return false
  try { assertModelProviderConfig(item.config) } catch { return false }
  return true
}
const artifact = (value: unknown): boolean => {
  const item = object(value)
  return Boolean(item && exact(item, ['mode', 'packageName', 'packageVersion', 'registryOrigin', 'packageIntegrity']) && item.mode === 'artifact' && text(item.packageName) && text(item.packageVersion) && item.registryOrigin === 'https://registry.npmjs.org' && typeof item.packageIntegrity === 'string' && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.packageIntegrity))
}

function summary(value: unknown): boolean {
  const item = object(value)
  return Boolean(item && exact(item, ['bindingId', 'resourceRevisionId', 'kind', 'contentSha256']) && text(item.bindingId) && text(item.resourceRevisionId) && kind(item.kind) && hash(item.contentSha256))
}

function file(value: unknown): boolean {
  const item = object(value)
  return Boolean(item && exact(item, ['path', 'size', 'mediaType', 'sha256', 'blobSha256']) && text(item.path) && integer(item.size) && text(item.mediaType) && hash(item.sha256) && hash(item.blobSha256))
}

function binding(value: unknown): boolean {
  const item = object(value)
  if (!item || !Object.keys(item).every(key => ['bindingId', 'bindingRevision', 'agentKey', 'projectId', 'resourceRevisionId', 'resourceId', 'kind', 'contentSha256', 'files', 'artifact', 'provider'].includes(key)) || !['bindingId', 'bindingRevision', 'agentKey', 'projectId', 'resourceRevisionId', 'resourceId', 'kind', 'contentSha256', 'files'].every(key => key in item)) return false
  return Boolean(text(item.bindingId) && integer(item.bindingRevision, 1) && (item.agentKey === null || text(item.agentKey)) && (item.projectId === null || text(item.projectId)) && text(item.resourceRevisionId) && text(item.resourceId) && kind(item.kind) && hash(item.contentSha256) && Array.isArray(item.files) && item.files.length <= 64 && item.files.every(file) && (item.kind === 'agent-runtime' ? artifact(item.artifact) && item.files.length === 0 && item.provider === undefined : item.kind === 'model-provider' ? provider(item.provider) && item.files.length === 0 && item.artifact === undefined && item.contentSha256 === (item.provider as Record<string, unknown>).contentSha256 : item.artifact === undefined && item.provider === undefined))
}

function snapshot(value: unknown): boolean {
  const item = object(value)
  return Boolean(item && exact(item, ['workerId', 'revision', 'fingerprint', 'bindings', 'createdAt']) && text(item.workerId) && integer(item.revision) && hash(item.fingerprint) && Array.isArray(item.bindings) && item.bindings.every(binding) && text(item.createdAt) && Number.isFinite(Date.parse(item.createdAt)))
}

function report(value: unknown): boolean {
  const item = object(value)
  const results = ['installed', 'failed', 'version-mismatch', 'pending-gc']
  const phases = ['queued', 'downloading', 'verifying', 'installing', 'restart-required', 'credential-required', 'ready', 'gc']
  return Boolean(item && exact(item, ['requestId', 'workerId', 'resourceSetRevision', 'bindingId', 'bindingRevision', 'resourceRevisionId', 'resourceId', 'kind', 'integrity', 'result', 'phase', 'progressBytes', 'errorCode', 'message', 'activeRevision', 'previousRevision', 'occurredAt']) && text(item.requestId) && text(item.workerId) && integer(item.resourceSetRevision) && text(item.bindingId) && integer(item.bindingRevision, 1) && text(item.resourceRevisionId) && text(item.resourceId) && kind(item.kind) && hash(item.integrity) && results.includes(String(item.result)) && (item.phase === null || phases.includes(String(item.phase))) && (item.progressBytes === null || integer(item.progressBytes)) && (item.errorCode === null || text(item.errorCode)) && (item.message === null || text(item.message)) && (item.activeRevision === null || integer(item.activeRevision, 1)) && (item.previousRevision === null || integer(item.previousRevision, 1)) && text(item.occurredAt) && Number.isFinite(Date.parse(item.occurredAt)))
}

export function isServerResourcePayload(value: unknown): value is ServerResourcePayload {
  const item = object(value)
  if (!item || !text(item.type)) return false
  if (item.type === 'resource.set.notify') return exact(item, ['type', 'workerId', 'setRevision', 'fingerprint', 'resources']) && text(item.workerId) && integer(item.setRevision) && hash(item.fingerprint) && Array.isArray(item.resources) && item.resources.every(summary)
  if (item.type === 'resource.set.pull') return exact(item, ['type', 'action', 'requestId', 'resourceSet']) && item.action === 'snapshot' && text(item.requestId) && snapshot(item.resourceSet)
  if (item.type === 'resource.blob.fetch' && item.action === 'response') return exact(item, ['type', 'action', 'requestId', 'sha256', 'mediaType', 'size', 'base64Content']) && text(item.requestId) && hash(item.sha256) && text(item.mediaType) && integer(item.size) && typeof item.base64Content === 'string'
  return item.type === 'resource.blob.fetch' && exact(item, ['type', 'action', 'requestId', 'sha256']) && item.action === 'not-found' && text(item.requestId) && hash(item.sha256)
}

export function isWorkerResourcePayload(value: unknown): value is WorkerResourcePayload {
  const item = object(value)
  if (!item || !text(item.type)) return false
  if (item.type === 'resource.set.pull') return exact(item, ['type', 'action', 'requestId', 'workerId', 'knownSetRevision']) && item.action === 'request' && text(item.requestId) && text(item.workerId) && (item.knownSetRevision === null || integer(item.knownSetRevision))
  if (item.type === 'resource.blob.fetch') return exact(item, ['type', 'action', 'requestId', 'sha256']) && item.action === 'request' && text(item.requestId) && hash(item.sha256)
  return item.type === 'resource.reconcile.report' && exact(item, ['type', 'report']) && report(item.report)
}
