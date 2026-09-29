import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { ResourceFile, ResourceRevision } from '@wemux/domain'

const encoder = new TextEncoder()
const hash = (bytes: Uint8Array) => bytesToHex(sha256(bytes))

export function prepareSkillRevision(input: {
  resourceId: string
  revisionId: string
  version: number
  name: string
  description: string
  content: string
  createdBy: string
  createdAt: string
}) {
  const bytes = encoder.encode(input.content)
  if (!input.content.trim() || bytes.length > 1024 * 1024) throw new Error('SKILL.md 必须包含内容，且不能超过 1 MiB。')
  const blobSha256 = hash(bytes)
  const file: ResourceFile = { path: 'SKILL.md', size: bytes.length, mediaType: 'text/markdown', sha256: blobSha256, blobSha256 }
  const manifestSha256 = hash(encoder.encode(JSON.stringify({ resourceId: input.resourceId, version: input.version, name: input.name, description: input.description, files: [file] })))
  const revision: ResourceRevision = {
    id: input.revisionId, resourceId: input.resourceId, kind: 'skill', version: input.version, state: 'published',
    manifest: { schemaVersion: 1, name: input.name, description: input.description, compatibility: { workerProtocol: '2', platforms: [], architectures: [], agentKeys: [] }, bytes: bytes.length, fileCount: 1, sha256: manifestSha256, materializerVersion: 1, restartPolicy: 'none' },
    payload: { mode: 'blobs', files: [file] }, contentSha256: manifestSha256,
    supplyChain: { mode: 'static-content', manifestSha256 }, createdBy: input.createdBy as ResourceRevision['createdBy'], createdAt: input.createdAt as ResourceRevision['createdAt'],
  }
  return { revision, blobSha256, base64Content: toBase64(bytes) }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}
