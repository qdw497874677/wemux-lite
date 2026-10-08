import type { ApprovalDecisionInput, ApprovalProjectionStatus, ApprovalSource, TimelineSourceKind } from '@wemux/server-domain'
import type { ProjectId, Timestamp } from '@wemux/domain'
import { AppError } from '../../application/errors.ts'
import { TaskError } from '../../application/task-service.ts'
import { createHash } from 'node:crypto'
import type { RouteDescriptor } from './types.ts'

function positiveInteger(value: string | null): number | undefined {
  if (value === null) return undefined
  if (!/^\d+$/.test(value)) throw new AppError(400, 'Invalid limit', 'invalid_limit')
  return Number(value)
}
function approvalStatus(value: string | null): ApprovalProjectionStatus | undefined {
  if (value === null) return undefined
  if (!['pending', 'approved', 'denied', 'changes_requested', 'expired', 'unavailable'].includes(value)) throw new AppError(400, 'Invalid approval status', 'invalid_request')
  return value as ApprovalProjectionStatus
}
function approvalSource(value: string | null): ApprovalSource['kind'] | undefined {
  if (value === null) return undefined
  if (!['session_tool', 'connector_call', 'task_review', 'channel_governance'].includes(value)) throw new AppError(400, 'Invalid approval source', 'invalid_request')
  return value as ApprovalSource['kind']
}
function timelineSource(value: string | null): TimelineSourceKind | undefined {
  if (value === null) return undefined
  if (!['audit', 'task_activity', 'run', 'channel_delivery', 'session'].includes(value)) throw new AppError(400, 'Invalid timeline source', 'invalid_request')
  return value as TimelineSourceKind
}

export const projectionRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/approvals', auth: 'task', handler: async context => {
    if (!context.projections) throw new AppError(404, 'Route not found')
    const actor = await context.actor('read')
    context.json(200, await context.projections.approvals(actor, {
      projectId: context.url.searchParams.get('projectId') as ProjectId | null ?? undefined,
      status: approvalStatus(context.url.searchParams.get('status')),
      sourceKind: approvalSource(context.url.searchParams.get('sourceKind')),
      cursor: context.url.searchParams.get('cursor') ?? undefined,
      limit: positiveInteger(context.url.searchParams.get('limit')),
    }))
  } },
  { method: 'GET', pattern: '/approvals/:projectionKey', auth: 'task', handler: async context => {
    if (!context.projections) throw new AppError(404, 'Route not found')
    const approval = await context.projections.approval(await context.actor('read'), context.params.projectionKey)
    if (!approval) throw new AppError(404, 'Approval not found', 'approval_not_found')
    context.json(200, { approval })
  } },
  { method: 'POST', pattern: '/approvals/:projectionKey/decisions', auth: 'task', handler: async context => {
    if (!context.approvalDecisions) throw new AppError(404, 'Route not found')
    const body = await context.readBody() as Partial<ApprovalDecisionInput>
    if (!body.requestId || !body.decision || !body.sourceRevision) throw new AppError(400, 'Missing approval decision fields', 'invalid_request')
    const canonical = JSON.stringify({ decision: body.decision, note: body.note ?? null, requestId: body.requestId, sourceRevision: body.sourceRevision })
    const input: ApprovalDecisionInput = { decision: body.decision, note: body.note, requestId: body.requestId, sourceRevision: body.sourceRevision, fingerprint: body.fingerprint ?? createHash('sha256').update(canonical).digest('hex') }
    try {
      context.json(200, await context.approvalDecisions.decide(await context.actor('write'), context.params.projectionKey, input))
    } catch (error) {
      if (error instanceof TaskError) throw new AppError(error.status, error.message, error.code)
      throw error
    }
  } },
  { method: 'GET', pattern: '/timeline', auth: 'task', handler: async context => {
    if (!context.projections) throw new AppError(404, 'Route not found')
    const actorKind = context.url.searchParams.get('actorKind')
    if (actorKind !== null && !['user', 'agent', 'channel', 'system'].includes(actorKind)) throw new AppError(400, 'Invalid actor kind', 'invalid_request')
    context.json(200, await context.projections.timeline(await context.actor('read'), {
      projectId: context.url.searchParams.get('projectId') as ProjectId | null ?? undefined,
      sourceKind: timelineSource(context.url.searchParams.get('sourceKind')),
      actorKind: actorKind as 'user' | 'agent' | 'channel' | 'system' | null ?? undefined,
      actorId: context.url.searchParams.get('actorId') ?? undefined,
      subjectKind: context.url.searchParams.get('subjectKind') ?? undefined,
      from: context.url.searchParams.get('from') as Timestamp | null ?? undefined,
      to: context.url.searchParams.get('to') as Timestamp | null ?? undefined,
      cursor: context.url.searchParams.get('cursor') ?? undefined,
      limit: positiveInteger(context.url.searchParams.get('limit')),
    }))
  } },
  { method: 'GET', pattern: '/projects/:projectId/timeline', auth: 'task', handler: async context => {
    if (!context.projections) throw new AppError(404, 'Route not found')
    context.json(200, await context.projections.timeline(await context.actor('read'), { projectId: context.params.projectId as ProjectId, cursor: context.url.searchParams.get('cursor') ?? undefined, limit: positiveInteger(context.url.searchParams.get('limit')) }))
  } },
]
