import type { RegisterArtifactCommand, ReviewArtifactCommand } from '@wemux/server-domain'
import { AppError } from '../../application/errors.ts'
import type { RouteDescriptor } from './types.ts'

const PREVIEW_LIMIT = 2 * 1024 * 1024
const DOWNLOAD_LIMIT = 20 * 1024 * 1024

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
    const artifact = await context.artifacts.get(await context.actor('read'), context.params.artifactId)
    const preview = context.url.searchParams.get('preview') === '1'
    const maximum = preview ? PREVIEW_LIMIT : DOWNLOAD_LIMIT
    if (artifact.size > maximum) throw new AppError(413, preview ? 'Artifact preview exceeds 2 MiB' : 'Artifact download exceeds 20 MiB', 'artifact_too_large')
    const file = await context.sessionFiles.read(artifact.sessionId, artifact.relativePath, maximum)
    if (!file.base64Content) throw new AppError(502, 'Worker returned no artifact content')
    const content = Buffer.from(file.base64Content, 'base64')
    context.response.statusCode = 200
    context.response.setHeader('content-type', artifact.mimeType || 'application/octet-stream')
    context.response.setHeader('content-length', String(content.length))
    context.response.setHeader('content-disposition', preview ? 'inline' : `attachment; filename="${artifact.relativePath.split('/').pop()?.replaceAll('"', '') || 'artifact'}"`)
    context.response.end(content)
  } },
]
