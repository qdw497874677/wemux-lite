import type { Api } from '../../api/client.ts'
import type { PromptInputAttachment } from '../../components/ai-elements/attachments.tsx'
import { randomId } from '../../lib/random.ts'

export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024
const imageExtensionByType: Record<string, string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
}

const imageExtensions = new Set(['avif', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const fileExtension = (name: string): string => name.includes('.') ? name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '' : ''

export function isImageAttachment(attachment: PromptInputAttachment): boolean {
  return attachment.type.startsWith('image/') || imageExtensions.has(fileExtension(attachment.name))
}

export function imageUploadSubpath(attachment: PromptInputAttachment, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const extension = imageExtensionByType[attachment.type.toLowerCase()] ?? (fileExtension(attachment.name) || 'bin')
  return `uploads/${stamp}-${randomId().replaceAll('-', '').slice(0, 8)}.${extension}`
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const chunkSize = 32_768
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  return btoa(binary)
}

export async function uploadImageAttachments(api: Api, sessionId: string, attachments: readonly PromptInputAttachment[]): Promise<string[]> {
  const images = attachments.filter(isImageAttachment)
  const oversized = images.find(attachment => attachment.size > MAX_IMAGE_UPLOAD_BYTES)
  if (oversized) throw new Error(`图片“${oversized.name}”为 ${(oversized.size / 1024 / 1024).toFixed(1)} MB，超过 5 MB 限制。首版暂不压缩，请选择更小的图片。`)
  const references: string[] = []
  for (const attachment of images) {
    const subpath = imageUploadSubpath(attachment)
    const written = await api.writeSessionFile(sessionId, subpath, await fileToBase64(attachment.file))
    references.push(`![${attachment.name || 'image'}](${written.subpath})`)
  }
  return references
}
