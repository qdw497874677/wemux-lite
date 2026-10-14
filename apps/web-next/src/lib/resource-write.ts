import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type {
  CreateResourceInput, ModelProviderDefinitionDTO, ResourceDTO, ResourceRevisionDTO,
} from '@wemux/web-contract/resource-write'

/**
 * 资源写路径的载荷构造：只组装 Server 既有契约要求的内容，不做任何授权判断。
 * 所有摘要与哈希都在浏览器本地计算，Server 会再次校验（内容哈希、清单一致性、CAS 版本）。
 */
export const SKILL_ENTRY_FILE = 'SKILL.md'
export const SKILL_BYTE_LIMIT = 1024 * 1024
export const PROVIDER_ENDPOINT_LIMIT = 2048
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export const resourceKindLabels = {
  skill: '技能',
  'agent-runtime': 'Agent 运行时',
  'model-provider': '模型 Provider',
  'connector-config': '连接器配置',
} as const

export type WritableResourceKind = keyof typeof resourceKindLabels
export const writableResourceKinds = Object.keys(resourceKindLabels) as WritableResourceKind[]

const encoder = new TextEncoder()

export function sha256Hex(value: string): string {
  return bytesToHex(sha256(encoder.encode(value)))
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
  return btoa(binary)
}

/** 技能资源定义：管理面只登记入口文件与兼容 Agent，不上传可执行文件。 */
export function skillDefinition(compatibleAgents: readonly string[] = ['pi']) {
  return { entryFile: SKILL_ENTRY_FILE, compatibleAgents, containsExecutableFiles: false }
}

export function providerDefinitionFromDefinition(definition: ModelProviderDefinitionDTO): { endpoint: string; modelId: string; credentialRef: string } {
  return {
    endpoint: definition.endpoint,
    modelId: definition.modelIds[0] ?? '',
    credentialRef: definition.credential.kind === 'worker-credential' ? definition.credential.credentialRef : '',
  }
}

/**
 * Provider 定义构造。字段顺序固定，因为 Server 用 JSON.stringify 比较资源定义与修订载荷，
 * 也用它计算内容摘要。
 */
export function prepareProviderDefinition(input: { endpoint: string; modelId: string; credentialRef: string; agentKeys?: readonly string[] }): ModelProviderDefinitionDTO {
  const endpoint = input.endpoint.trim()
  const modelId = input.modelId.trim()
  const credentialRef = input.credentialRef.trim()
  if (!endpoint) throw new Error('请填写 Provider 端点。')
  if (endpoint.length > PROVIDER_ENDPOINT_LIMIT) throw new Error(`Provider 端点不能超过 ${PROVIDER_ENDPOINT_LIMIT} 个字符。`)
  let url: URL
  try { url = new URL(endpoint) } catch { throw new Error('Provider 端点必须是合法的 HTTPS 地址。') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.search) throw new Error('Provider 端点必须是不含凭据、查询与片段的 HTTPS 地址。')
  if (!MODEL_ID_PATTERN.test(modelId)) throw new Error('模型 ID 需以字母或数字开头，只能包含字母、数字、点、下划线、冒号、斜杠与连字符。')
  if (!CREDENTIAL_REF_PATTERN.test(credentialRef)) throw new Error('凭据引用需以字母或数字开头，只能包含字母、数字、下划线与连字符。')
  const agentKeys = input.agentKeys?.length ? [...input.agentKeys] : ['pi']
  return {
    providerKey: 'openai-compatible',
    endpoint,
    modelIds: [modelId],
    agentKeys,
    credential: { kind: 'worker-credential', credentialRef, variableNames: ['OPENAI_API_KEY'] },
  } as unknown as ModelProviderDefinitionDTO
}

/**
 * 资源创建载荷。Server 会注入 createdBy（Provider 资源体不接受归属字段），
 * 但 createdAt/updatedAt 必须由客户端给出，否则持久化层拿不到时间戳。
 */
export function resourceCreateInput(input: { id: string; kind: WritableResourceKind; name: string; description: string; definition: unknown; now: string }): CreateResourceInput {
  const name = input.name.trim()
  if (!name) throw new Error('请填写资源名称。')
  return { id: input.id, kind: input.kind, name, description: input.description.trim(), definition: input.definition, createdAt: input.now, updatedAt: input.now }
}

/** 资源更新载荷：PATCH 要求 body.id 与路径一致，保留归属与定义，只改名称与描述。 */
export function resourceUpdateInput(resource: ResourceDTO, patch: { name: string; description: string }, now: string): ResourceDTO {
  const name = patch.name.trim() || resource.name
  return { ...resource, name, description: patch.description.trim(), updatedAt: now } as unknown as ResourceDTO
}

/** 技能修订：先按 sha256 上传 blob（去重），再发布引用该 blob 的不可变修订。 */
export function prepareSkillRevision(input: {
  resourceId: string; revisionId: string; version: number; name: string; description: string; content: string
  agentKeys?: readonly string[]; createdAt: string
}): { revision: ResourceRevisionDTO; blobSha256: string; base64Content: string } {
  if (!input.content.trim()) throw new Error('SKILL.md 内容不能为空。')
  const bytes = encoder.encode(input.content)
  if (bytes.length > SKILL_BYTE_LIMIT) throw new Error('SKILL.md 不能超过 1 MiB。')
  const blobSha256 = bytesToHex(sha256(bytes))
  const file = { path: SKILL_ENTRY_FILE, size: bytes.length, mediaType: 'text/markdown', sha256: blobSha256, blobSha256 }
  const manifestSha256 = sha256Hex(JSON.stringify({ resourceId: input.resourceId, version: input.version, name: input.name, description: input.description, files: [file] }))
  const revision = {
    id: input.revisionId,
    resourceId: input.resourceId,
    kind: 'skill',
    version: input.version,
    state: 'published',
    manifest: {
      schemaVersion: 1,
      name: input.name,
      description: input.description,
      compatibility: { workerProtocol: '2', platforms: [], architectures: [], agentKeys: [...(input.agentKeys ?? [])] },
      bytes: bytes.length,
      fileCount: 1,
      sha256: manifestSha256,
      materializerVersion: 1,
      restartPolicy: 'none',
    },
    payload: { mode: 'blobs', files: [file] },
    contentSha256: manifestSha256,
    supplyChain: { mode: 'static-content', manifestSha256 },
    // 通用 /revisions 路由以当前操作者覆盖 createdBy，这里只是占位。
    createdBy: '',
    createdAt: input.createdAt,
  } as unknown as ResourceRevisionDTO
  return { revision, blobSha256, base64Content: toBase64(bytes) }
}

/**
 * Provider 修订：只携带非秘密定位信息（端点、模型、凭据引用），内容摘要必须与载荷配置一致。
 * 首个修订必须走通用 /revisions，且载荷配置必须与资源当前定义完全相同。
 */
export function prepareProviderRevision(input: {
  resourceId: string; revisionId: string; version: number; name: string; description?: string
  definition: ModelProviderDefinitionDTO; createdAt: string; createdBy: string
}): ResourceRevisionDTO {
  const serialized = JSON.stringify(input.definition)
  const digest = sha256Hex(serialized)
  const revision = {
    id: input.revisionId,
    resourceId: input.resourceId,
    kind: 'model-provider',
    version: input.version,
    state: 'published',
    manifest: {
      schemaVersion: 1,
      name: input.name,
      description: input.description ?? '',
      compatibility: { workerProtocol: '2', platforms: [], architectures: [], agentKeys: [...input.definition.agentKeys] },
      bytes: encoder.encode(serialized).byteLength,
      fileCount: 0,
      sha256: digest,
      materializerVersion: 1,
      restartPolicy: 'none',
    },
    payload: { mode: 'inline-config', contentSha256: digest, config: input.definition },
    contentSha256: digest,
    supplyChain: { mode: 'static-content', manifestSha256: digest },
    createdBy: input.createdBy,
    createdAt: input.createdAt,
  } as unknown as ResourceRevisionDTO
  return revision
}

/** 下一个修订版本号：修订不可变，版本必须严格递增。 */
export function nextRevisionVersion(revisions: readonly { version: number }[]): number {
  return revisions.reduce((highest, revision) => Math.max(highest, revision.version), 0) + 1
}

export function latestRevision(resourceId: string, revisions: readonly ResourceRevisionDTO[]): ResourceRevisionDTO | undefined {
  return revisions.filter(revision => revision.resourceId === resourceId).sort((left, right) => right.version - left.version)[0]
}

export function isModelProvider(resource: ResourceDTO): resource is Extract<ResourceDTO, { kind: 'model-provider' }> {
  return resource.kind === 'model-provider'
}

export function isSkill(resource: ResourceDTO): resource is Extract<ResourceDTO, { kind: 'skill' }> {
  return resource.kind === 'skill'
}

/** 已撤销（待回收/已回收）的绑定不再占用 Worker，可重新绑定同一修订。 */
export function isRetiredBinding(status: string): boolean {
  return status === 'pending-gc' || status === "gc'd"
}
