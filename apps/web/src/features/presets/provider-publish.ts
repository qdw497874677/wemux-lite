import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { AgentKey, ModelProviderResourceDefinition, ResourceRevision } from '@wemux/domain'

/** Only non-secret configuration supported by the isolated Pi process. */
export function prepareProviderRevision(input: {
  resourceId: string; revisionId: string; name: string; endpoint: string; modelId: string
  credentialRef: string; version: number; createdBy: string; createdAt: string
}): { definition: ModelProviderResourceDefinition; revision: ResourceRevision } {
  const name = input.name.trim(), endpoint = input.endpoint.trim(), modelId = input.modelId.trim(), credentialRef = input.credentialRef.trim()
  if (!name || name.length > 200 || !Number.isSafeInteger(input.version) || input.version < 1) throw new Error('请填写有效的供应商名称和版本')
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2048) throw new Error('端点必须使用 HTTPS')
  try {
    const url = new URL(endpoint)
    if (!url.hostname || url.username || url.password || url.search || url.hash || url.protocol !== 'https:') throw new Error('invalid')
  } catch { throw new Error('端点不得包含账号、密码、查询参数或片段') }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(modelId)) throw new Error('模型 ID 格式无效')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(credentialRef)) throw new Error('本机凭据引用格式无效')
  const definition: ModelProviderResourceDefinition = {
    providerKey: 'openai-compatible', endpoint, modelIds: [modelId], agentKeys: ['pi' as AgentKey],
    credential: { kind: 'worker-credential', credentialRef, variableNames: ['OPENAI_API_KEY'] },
  }
  const serialized = new TextEncoder().encode(JSON.stringify(definition))
  const digest = bytesToHex(sha256(serialized))
  const revision: ResourceRevision = {
    id: input.revisionId, resourceId: input.resourceId, kind: 'model-provider', version: input.version, state: 'published',
    manifest: { schemaVersion: 1, name, description: '', compatibility: { workerProtocol: '2', platforms: [], architectures: [], agentKeys: ['pi' as AgentKey] }, bytes: serialized.byteLength, fileCount: 0, sha256: digest, materializerVersion: 1, restartPolicy: 'none' },
    payload: { mode: 'inline-config', contentSha256: digest, config: definition }, contentSha256: digest,
    supplyChain: { mode: 'static-content', manifestSha256: digest }, createdBy: input.createdBy as ResourceRevision['createdBy'], createdAt: input.createdAt as ResourceRevision['createdAt'],
  }
  return { definition, revision }
}
