import { createHash } from 'node:crypto'
import type { CommandId, TeamId, UserId } from '@wemux/domain'
import { AppError } from './errors.ts'
import type { SessionAttachmentRecord } from './ports/server-store-types.js'

/** 上传原始字节上限：投递命令携带 base64 后约 1.37 MiB，仍低于网关发送侧 2 MiB 看门狗。 */
export const MAX_ATTACHMENT_UPLOAD_BYTES = 1024 * 1024
/** multipart 额外开销（字段、边界、头部）的读取上限。 */
export const ATTACHMENT_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** 协调上传意图使用独立 requestId 命名空间，避免与首条消息发送意图互相顶替。 */
export const coordinationUploadRequestId = (requestId: string) => `coordination-upload:${requestId}`

export function attachmentDeliverCommandId(actor: UserId, team: TeamId, requestId: string): CommandId {
  return `coordination-attachment:${createHash('sha256').update(JSON.stringify([actor, team, requestId])).digest('hex')}` as CommandId
}

/** 文件名只保留可安全落盘的字符；路径分隔符与控制字符一律折叠，避免投递子路径被伪造。 */
export function attachmentSafeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? ''
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().replace(/\.+$/, '')
  return cleaned.slice(0, 120)
}

export function attachmentSubpath(sha256: string, filename: string): string {
  return `attachments/${sha256.slice(0, 12)}-${attachmentSafeFilename(filename) || 'attachment'}`
}

export interface AttachmentUploadInput {
  readonly requestId: string
  readonly workspaceId: string
  readonly workerId: string
  readonly agentKey: string
  readonly modelId: string | null
  readonly title: string
  readonly filename: string
  readonly contentType: string | null
  readonly bytes: Buffer
}

export function attachmentUploadIntentFingerprint(actor: UserId, team: TeamId, input: AttachmentUploadInput, commandId: CommandId): string {
  return createHash('sha256').update(JSON.stringify({
    actor, team, workspaceId: input.workspaceId, workerId: input.workerId, agentKey: input.agentKey,
    modelId: input.modelId, title: input.title, filename: input.filename, size: input.bytes.length,
    sha256: createHash('sha256').update(input.bytes).digest('hex'), commandId,
  })).digest('hex')
}

export function validateAttachmentUpload(actor: UserId, team: TeamId, input: AttachmentUploadInput): { sha256: string; subpath: string; commandId: CommandId; fingerprint: string } {
  if (!input.requestId || input.requestId.length > 180) throw new AppError(400, 'requestId is required')
  if (input.bytes.length === 0) throw new AppError(400, '附件内容为空')
  if (input.bytes.length > MAX_ATTACHMENT_UPLOAD_BYTES) throw new AppError(413, '附件超过大小上限 1 MiB', 'attachment_too_large')
  const safe = attachmentSafeFilename(input.filename)
  if (!safe) throw new AppError(400, 'filename is required')
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const commandId = attachmentDeliverCommandId(actor, team, input.requestId)
  return { sha256, subpath: attachmentSubpath(sha256, input.filename), commandId, fingerprint: attachmentUploadIntentFingerprint(actor, team, input, commandId) }
}

export type AttachmentDeliveryState = 'pending' | 'delivered' | 'failed'

export interface AttachmentDeliveryView {
  readonly state: AttachmentDeliveryState
  readonly commandId: CommandId
  readonly detail: string | null
  readonly workerConnectionState: string | null
}

/** 阶段二状态只由持久化命令投影与 Worker 连接态推导，不缓存、不提前乐观。 */
export function attachmentDeliveryView(record: SessionAttachmentRecord, command: { status: string } | null, workerConnectionState: string | null, rejectionDetail: string | null): AttachmentDeliveryView {
  if (!command || command.status === 'accepted') return { state: command ? 'delivered' : 'pending', commandId: record.deliverCommandId, detail: command ? null : '投递命令等待下发', workerConnectionState }
  if (command.status === 'rejected') return { state: 'failed', commandId: record.deliverCommandId, detail: rejectionDetail ?? '工作节点拒绝投递', workerConnectionState }
  if (command.status === 'cancelled') return { state: 'failed', commandId: record.deliverCommandId, detail: '投递命令已取消', workerConnectionState }
  // pending：撤权后命令永远无法送达，如实投影为失败而不是无限期待投递。
  if (workerConnectionState === 'revoked') return { state: 'failed', commandId: record.deliverCommandId, detail: '工作节点已撤销授权，附件无法投递', workerConnectionState }
  return { state: 'pending', commandId: record.deliverCommandId, detail: null, workerConnectionState }
}
