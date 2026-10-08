import type { RegisterArtifactCommand, ReviewArtifactCommand } from '@wemux/server-domain'
import { AppError } from '../../application/errors.ts'
import type { RouteDescriptor } from './types.ts'

const PREVIEW_LIMIT = 2 * 1024 * 1024
// Keep in sync with Worker MAX_FILE_READ_BYTES until shared wire constants are built.
export const ARTIFACT_DOWNLOAD_LIMIT = 10 * 1024 * 1024

function contentError(error: unknown): Error {
  if (error instanceof AppError && error.status === 403) return new AppError(403, '成果访问权限已被撤权', 'artifact_access_revoked')
  // Prefix source: apps/worker/src/files/workspace-files.ts FILE_READ_ERROR.
  const message = error instanceof Error ? error.message : 'unknown'
  const category = message.split(':', 1)[0]!
  switch (category) {
    case 'file_transport_too_large': return new AppError(413, '成果编码后过大，超出 Worker 传输帧上限', 'artifact_transport_too_large')
    case 'file_too_large': return new AppError(413, '成果文件过大，下载上限为 10 MiB', 'artifact_too_large')
    case 'file_not_found': return new AppError(404, '成果文件不存在', 'artifact_not_found')
    case 'file_unreadable': return new AppError(422, '成果文件不可读', 'artifact_unreadable')
    case 'file_access_revoked': return new AppError(403, '成果访问权限已被撤权', 'artifact_access_revoked')
  }
  if (error instanceof AppError && [401, 404, 503, 504].includes(error.status)) return error
  // Retain the upstream class/code without reflecting arbitrary paths or file content.
  const diagnostic = error instanceof AppError ? error.code ?? `http_${error.status}` : error instanceof Error ? error.name : 'unknown'
  return new AppError(502, `成果读取失败（${diagnostic}）`, 'artifact_read_failed')
}

function downloadFilename(path: string): string {
  const name = path.split('/').pop() || 'artifact'
  const fallback = name.replace(/[^\x20-\x7e]|["\\\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export const artifactRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/projects/:projectId/tasks/:taskId/artifacts', auth: 'task', handler: async context => {
    if (!context.artifacts) throw new AppError(404, 'Route not found')
    context.json(200, { items: await context.artifacts.listByTask(await context.actor('read'), context.params.taskId) })
  } },
  { method: 'POST', pattern: '/projects/:projectId/tasks/:taskId/artifacts', auth: 'task', handler: async context => {
    if (!context.artifacts) throw new AppError(404, 'Route not found')
    const body = await context.readBody() as Partial<RegisterArtifactCommand>
    if (!body.artifactId || !body.runId || !body.relativePath || !body.mimeType || body.size === undefined || !body.requestId) throw new AppError(400, 'Missing artifact fields', 'invalid_request')
    context.json(201, await context.artifacts.register(await context.actor('write'), { artifactId: body.artifactId, taskId: context.params.taskId, runId: body.runId, relativePath: body.relativePath, mimeType: body.mimeType, size: body.size, requestId: body.requestId }))
  } },
  { method: 'POST', pattern: '/artifacts/:artifactId/review', auth: 'task', handler: async context => {
    if (!context.artifacts) throw new AppError(404, 'Route not found')
    const body = await context.readBody() as Partial<ReviewArtifactCommand>
    if (!body.decision || body.expectedRevision === undefined || !body.requestId) throw new AppError(400, 'Missing artifact review fields', 'invalid_request')
    context.json(200, await context.artifacts.review(await context.actor('write'), { artifactId: context.params.artifactId, decision: body.decision, expectedRevision: body.expectedRevision, requestId: body.requestId }))
  } },
  { method: 'GET', pattern: '/artifacts/:artifactId/content', auth: 'task', handler: async context => {
    if (!context.artifacts || !context.sessionFiles) throw new AppError(404, 'Route not found')
    const actor = await context.actor('read')
    const artifact = await context.artifacts.get(actor, context.params.artifactId).catch(error => { throw contentError(error) })
    const preview = context.url.searchParams.get('preview') === '1'
    const maximum = preview ? PREVIEW_LIMIT : ARTIFACT_DOWNLOAD_LIMIT
    if (artifact.size > maximum) throw new AppError(413, preview ? '成果文件过大，预览上限为 2 MiB' : '成果文件过大，下载上限为 10 MiB', 'artifact_too_large')
    const file = await context.sessionFiles.read(artifact.sessionId, artifact.relativePath, maximum).catch(error => { throw contentError(error) })
    if (file.size > ARTIFACT_DOWNLOAD_LIMIT || (!preview && file.size > maximum)) throw new AppError(413, '成果文件过大，下载上限为 10 MiB', 'artifact_too_large')
    if (!preview && file.truncated) throw new AppError(422, '成果文件不可读：Worker 返回了截断内容，请重试', 'artifact_unreadable')
    // binary is the encoding discriminator, not the registered MIME type.
    let content: Buffer
    if (file.binary === false && typeof file.content === 'string') {
      content = Buffer.from(file.content, 'utf8')
    } else if (file.binary === true && typeof file.base64Content === 'string') {
      content = Buffer.from(file.base64Content, 'base64')
      if (content.toString('base64') !== file.base64Content) throw new AppError(502, '成果内容编码无效（base64）', 'artifact_invalid_content')
    } else {
      throw new AppError(502, '成果内容编码缺失或无效（binary/content/base64Content）', 'artifact_invalid_content')
    }
    if (content.length > maximum) throw new AppError(413, '成果内容超过请求的大小上限', 'artifact_too_large')
    if (!preview && content.length !== file.size) throw new AppError(422, '成果文件不可读：内容字节数不完整', 'artifact_unreadable')
    // Recheck the existing access gate after remote I/O; a denied gate never sends bytes.
    await context.artifacts.get(actor, context.params.artifactId).catch(error => { throw contentError(error) })
    context.response.statusCode = 200
    context.response.setHeader('content-type', artifact.mimeType || 'application/octet-stream')
    context.response.setHeader('content-length', String(content.length))
    context.response.setHeader('content-disposition', preview ? 'inline' : downloadFilename(artifact.relativePath))
    context.response.end(content)
  } },
]
