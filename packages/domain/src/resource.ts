import type { AgentKey, Timestamp } from './values.js'
import type { ProjectId, UserId, WorkerId } from './ids.js'

export type ResourceKind =
  | 'skill'
  | 'agent-runtime'
  | 'model-provider'
  | 'connector-config'

export type ResourceId = string
export type ResourceRevisionId = string
export type ResourceBindingId = string

interface ResourceBase<Kind extends ResourceKind, Definition> {
  readonly id: ResourceId
  readonly kind: Kind
  readonly name: string
  readonly description: string
  readonly definition: Definition
  readonly createdBy: UserId
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export interface SkillResourceDefinition {
  readonly entryFile: 'SKILL.md'
  readonly compatibleAgents: readonly AgentKey[]
  readonly containsExecutableFiles: false
}

/** 首批仅保留类型边界，字段由后续批次补齐。 */
export type AgentRuntimeResourceDefinition = Readonly<Record<never, never>>
/** 首批仅保留类型边界，字段由后续批次补齐。 */
export type ModelProviderResourceDefinition = Readonly<Record<never, never>>
/** 继续由既有 Connector domain 承担运行时语义。 */
export type ConnectorConfigResourceDefinition = Readonly<Record<never, never>>

export type Resource =
  | ResourceBase<'skill', SkillResourceDefinition>
  | ResourceBase<'agent-runtime', AgentRuntimeResourceDefinition>
  | ResourceBase<'model-provider', ModelProviderResourceDefinition>
  | ResourceBase<'connector-config', ConnectorConfigResourceDefinition>

export interface ResourceFile {
  readonly path: string
  readonly size: number
  readonly mediaType: string
  readonly sha256: string
  readonly blobSha256: string
}

export interface ResourceManifest {
  readonly schemaVersion: 1
  readonly name: string
  readonly description: string
  readonly compatibility: {
    readonly workerProtocol: string
    readonly platforms: readonly string[]
    readonly architectures: readonly string[]
    readonly agentKeys: readonly AgentKey[]
  }
  readonly bytes: number
  readonly fileCount: number
  readonly sha256: string
  readonly materializerVersion: number
  readonly restartPolicy: 'none' | 'agent-process' | 'worker'
}

export interface StaticResourceSupplyChain {
  readonly mode: 'static-content'
  readonly manifestSha256: string
}

export interface RegistryResourceSupplyChain {
  readonly mode: 'registry-package'
  readonly packageName: string
  readonly packageVersion: string
  readonly registryOrigin: string
  readonly packageIntegrity: string
}

export interface DomainResourceSupplyChain {
  readonly mode: 'domain-reference'
  readonly domainId: string
  readonly domainRevision: number
}

export type ResourceSupplyChain =
  | StaticResourceSupplyChain
  | RegistryResourceSupplyChain
  | DomainResourceSupplyChain

export type ResourceRevisionPayload =
  | { readonly mode: 'blobs'; readonly files: readonly ResourceFile[] }
  | { readonly mode: 'artifact'; readonly packageName: string; readonly packageVersion: string; readonly registryOrigin: string; readonly packageIntegrity: string }
  | { readonly mode: 'inline-config'; readonly contentSha256: string }
  | { readonly mode: 'domain-ref'; readonly domainId: string; readonly domainRevision: number }

export interface ResourceRevision {
  readonly id: ResourceRevisionId
  readonly resourceId: ResourceId
  readonly kind: ResourceKind
  readonly version: number
  readonly state: 'draft' | 'published' | 'retired'
  readonly manifest: ResourceManifest
  readonly payload: ResourceRevisionPayload
  readonly contentSha256: string
  readonly supplyChain: ResourceSupplyChain
  readonly createdBy: UserId
  readonly createdAt: Timestamp
}

export type ResourceBindingStatus =
  | 'assigned'
  | 'notified'
  | 'installed'
  | 'failed'
  | 'pending-gc'
  | "gc'd"

export interface ResourceBinding {
  readonly id: ResourceBindingId
  readonly workerId: WorkerId
  readonly resourceRevisionId: ResourceRevisionId
  readonly resourceId: ResourceId
  readonly kind: ResourceKind
  readonly agentKey: AgentKey | null
  readonly projectId: ProjectId | null
  readonly status: ResourceBindingStatus
  readonly revision: number
  readonly createdBy: UserId
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export interface ResourceBindingSnapshot {
  readonly bindingId: ResourceBindingId
  readonly bindingRevision: number
  readonly agentKey: AgentKey | null
  readonly projectId: ProjectId | null
  readonly resourceRevisionId: ResourceRevisionId
  readonly resourceId: ResourceId
  readonly kind: ResourceKind
  readonly contentSha256: string
  readonly files: readonly ResourceFile[]
  /** Immutable registry artifact metadata, required for agent-runtime bindings. */
  readonly artifact?: Extract<ResourceRevisionPayload, { readonly mode: 'artifact' }>
}

export interface ResourceSetSnapshot {
  readonly workerId: WorkerId
  readonly revision: number
  readonly fingerprint: string
  readonly bindings: readonly ResourceBindingSnapshot[]
  readonly createdAt: Timestamp
}

export type ResourceReconcileResult = 'installed' | 'failed' | 'version-mismatch' | 'pending-gc'
export type ResourceReconcilePhase =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'restart-required'
  | 'credential-required'
  | 'ready'
  | 'gc'

export interface ReconcileReport {
  readonly requestId: string
  readonly workerId: WorkerId
  readonly resourceSetRevision: number
  readonly bindingId: ResourceBindingId
  readonly bindingRevision: number
  readonly resourceRevisionId: ResourceRevisionId
  readonly resourceId: ResourceId
  readonly kind: ResourceKind
  readonly integrity: string
  readonly result: ResourceReconcileResult
  readonly phase: ResourceReconcilePhase | null
  readonly progressBytes: number | null
  readonly errorCode: string | null
  readonly message: string | null
  readonly activeRevision: number | null
  readonly previousRevision: number | null
  readonly occurredAt: Timestamp
}

const SHA256 = /^[a-f0-9]{64}$/
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/
const TRUSTED_REGISTRY_ORIGINS = new Set(['https://registry.npmjs.org'])
const OFFICIAL_RUNTIME_PACKAGES = new Set(['@earendil-works/pi-coding-agent', '@anthropic-ai/claude-code', 'opencode-ai'])

export function assertResourceRevisionValid(revision: ResourceRevision): void {
  if (!revision.id || !revision.resourceId || revision.version < 1 || !Number.isSafeInteger(revision.version)) throw new Error('invalid_resource_revision')
  if (!SHA256.test(revision.contentSha256) || !SHA256.test(revision.manifest.sha256)) throw new Error('invalid_resource_integrity')
  if (revision.manifest.bytes < 0 || revision.manifest.fileCount < 0 || !Number.isSafeInteger(revision.manifest.fileCount)) throw new Error('invalid_resource_manifest')

  if (revision.kind === 'skill') {
    if (revision.payload.mode !== 'blobs' || revision.supplyChain.mode !== 'static-content') throw new Error('invalid_skill_supply_chain')
    const files = revision.payload.files
    if (files.length === 0 || files.length > 64 || files.length !== revision.manifest.fileCount) throw new Error('invalid_skill_manifest')
    if (files.reduce((total, file) => total + file.size, 0) !== revision.manifest.bytes || revision.manifest.bytes > 1024 * 1024) throw new Error('invalid_skill_manifest')
    if (revision.supplyChain.manifestSha256 !== revision.manifest.sha256 || revision.manifest.sha256 !== revision.contentSha256) throw new Error('skill_manifest_hash_mismatch')
    const paths = new Set<string>()
    for (const file of files) {
      if (!isSafeResourcePath(file.path) || paths.has(file.path) || file.size < 0 || !SHA256.test(file.sha256) || file.sha256 !== file.blobSha256) throw new Error('invalid_skill_file')
      paths.add(file.path)
    }
    if (!paths.has('SKILL.md')) throw new Error('skill_entry_missing')
    return
  }

  if (revision.kind === 'agent-runtime') {
    if (revision.payload.mode !== 'artifact' || revision.supplyChain.mode !== 'registry-package') throw new Error('invalid_runtime_supply_chain')
    assertTrustedRegistryPackage(revision.supplyChain)
    if (revision.payload.packageName !== revision.supplyChain.packageName || revision.payload.packageVersion !== revision.supplyChain.packageVersion || revision.payload.registryOrigin !== revision.supplyChain.registryOrigin || revision.payload.packageIntegrity !== revision.supplyChain.packageIntegrity) throw new Error('artifact_supply_chain_mismatch')
    return
  }

  if (revision.kind === 'connector-config' && (revision.payload.mode !== 'domain-ref' || revision.supplyChain.mode !== 'domain-reference')) throw new Error('invalid_connector_reference')
}

export function assertTrustedRegistryPackage(metadata: RegistryResourceSupplyChain): void {
  if (!SAFE_PACKAGE_NAME.test(metadata.packageName)) throw new Error('invalid_package_name')
  if (!OFFICIAL_RUNTIME_PACKAGES.has(metadata.packageName)) throw new Error('unapproved_package_name')
  if (!EXACT_VERSION.test(metadata.packageVersion)) throw new Error('package_version_must_be_exact')
  if (!TRUSTED_REGISTRY_ORIGINS.has(metadata.registryOrigin)) throw new Error('untrusted_registry_origin')
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.packageIntegrity)) throw new Error('invalid_package_integrity')
}

export function isResourceRevisionImmutable(previous: ResourceRevision, next: ResourceRevision): boolean {
  return JSON.stringify(previous) === JSON.stringify(next)
}

export function assertResourceRevisionImmutable(previous: ResourceRevision, next: ResourceRevision): void {
  if (!isResourceRevisionImmutable(previous, next)) throw new Error('resource_revision_immutable')
}

const BINDING_TRANSITIONS: Readonly<Record<ResourceBindingStatus, readonly ResourceBindingStatus[]>> = {
  assigned: ['notified', 'failed', 'pending-gc'],
  notified: ['installed', 'failed', 'pending-gc'],
  installed: ['failed', 'pending-gc'],
  failed: ['notified', 'pending-gc'],
  'pending-gc': ['installed', "gc'd"],
  "gc'd": [],
}

export function canTransitionResourceBinding(from: ResourceBindingStatus, to: ResourceBindingStatus): boolean {
  return from === to || BINDING_TRANSITIONS[from].includes(to)
}

export function assertResourceBindingTransition(from: ResourceBindingStatus, to: ResourceBindingStatus): void {
  if (!canTransitionResourceBinding(from, to)) throw new Error('invalid_resource_binding_transition')
}

function isSafeResourcePath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}
