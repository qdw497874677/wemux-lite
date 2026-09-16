import type {
  ApprovalRequest,
  CommandDescriptor,
  RuntimeAuthorization,
  RuntimeErrorInfo,
  RuntimeEvent,
  RuntimeEventSequence,
  RuntimeOperationId,
  RuntimeSessionId,
  RuntimeUsage,
  Timestamp,
} from '@wemux/domain'

const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const parseUsage = (value: unknown): RuntimeUsage | undefined => {
  const source = record(value)
  if (!source) return undefined
  const usage: {
    scope?: 'message' | 'operation' | 'native-session'
    subjectId?: string
    source?: 'runtime'
    revision?: number
    completeness?: 'complete' | 'partial'
    modelId?: RuntimeUsage['modelId']
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    totalTokens?: number
    costUsd?: number
    currency?: 'USD'
  } = {}
  if (source.scope === 'message' || source.scope === 'operation' || source.scope === 'native-session') usage.scope = source.scope
  const subjectId = text(source.subjectId)
  if (subjectId) usage.subjectId = subjectId
  if (source.source === 'runtime') usage.source = 'runtime'
  const revision = number(source.revision)
  if (revision !== null && Number.isSafeInteger(revision) && revision >= 0) usage.revision = revision
  if (source.completeness === 'complete' || source.completeness === 'partial') usage.completeness = source.completeness
  const modelId = text(source.modelId)
  if (modelId) usage.modelId = modelId as RuntimeUsage['modelId']
  const inputTokens = number(source.inputTokens)
  const outputTokens = number(source.outputTokens)
  const cacheReadTokens = number(source.cacheReadTokens)
  const cacheWriteTokens = number(source.cacheWriteTokens)
  const totalTokens = number(source.totalTokens)
  const costUsd = number(source.costUsd)
  if (source.currency === 'USD') usage.currency = 'USD'
  if (inputTokens !== null && Number.isSafeInteger(inputTokens)) usage.inputTokens = inputTokens
  if (outputTokens !== null && Number.isSafeInteger(outputTokens)) usage.outputTokens = outputTokens
  if (cacheReadTokens !== null && Number.isSafeInteger(cacheReadTokens)) usage.cacheReadTokens = cacheReadTokens
  if (cacheWriteTokens !== null && Number.isSafeInteger(cacheWriteTokens)) usage.cacheWriteTokens = cacheWriteTokens
  if (totalTokens !== null && Number.isSafeInteger(totalTokens)) usage.totalTokens = totalTokens
  if (costUsd !== null) usage.costUsd = costUsd
  return Object.keys(usage).length > 0 ? usage : undefined
}

const parseError = (value: unknown): RuntimeErrorInfo | null => {
  const source = record(value)
  const code = text(source?.code)
  const message = text(source?.message)
  if (!source || !code || !message) return null
  const retryAfterMs = number(source.retryAfterMs)
  const details = record(source.details)
  return {
    code,
    message,
    retryable: source.retryable === true,
    ...(retryAfterMs === null ? {} : { retryAfterMs }),
    ...(details ? { details } : {}),
  }
}

export const parseRuntimeEvent = (value: unknown): RuntimeEvent | null => {
  const source = record(value)
  if (!source || source.version !== 2) return null
  const type = text(source.type)
  const operationId = text(source.operationId) as RuntimeOperationId | null
  const sessionId = text(source.sessionId) as RuntimeSessionId | null
  const sequence = number(source.sequence) as RuntimeEventSequence | null
  const occurredAt = text(source.occurredAt) as Timestamp | null
  if (!type || !operationId || !sessionId || sequence === null || !Number.isInteger(sequence) || sequence < 0 || !occurredAt) return null
  const base = { version: 2 as const, operationId, sessionId, sequence, occurredAt }
  switch (type) {
    case 'text_delta': {
      const textValue = typeof source.text === 'string' ? source.text : null
      return textValue === null ? null : { ...base, type, text: textValue }
    }
    case 'reasoning_delta': {
      const textValue = typeof source.text === 'string' ? source.text : null
      return textValue === null ? null : { ...base, type, text: textValue }
    }
    case 'operation_status': {
      const status = text(source.status)
      if (!status || !['queued', 'running', 'stopping', 'completed', 'failed', 'cancelled'].includes(status)) return null
      const message = text(source.message)
      return message
        ? { ...base, type, status: status as 'queued' | 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled', message }
        : { ...base, type, status: status as 'queued' | 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled' }
    }
    case 'command_catalog':
      return Array.isArray(source.commands) ? { ...base, type, commands: source.commands as CommandDescriptor[] } : null
    case 'approval_required': {
      const approval = record(source.approval) as ApprovalRequest | null
      return approval && text(approval.id) && text(approval.title) && text(approval.description) && ['pending', 'approved', 'denied', 'expired'].includes(approval.status)
        ? { ...base, type, approval }
        : null
    }
    case 'usage': {
      const usage = parseUsage(source.usage)
      return usage ? { ...base, type, usage } : null
    }
    case 'authorization': {
      const authorization = record(source.authorization) as RuntimeAuthorization | null
      return authorization && ['unknown', 'authorized', 'unauthorized', 'expired'].includes(authorization.state)
        ? { ...base, type, authorization }
        : null
    }
    case 'error': {
      const error = parseError(source.error)
      return error ? { ...base, type, error } : null
    }
    case 'completed': {
      const status = text(source.status)
      if (!status || !['succeeded', 'failed', 'cancelled'].includes(status)) return null
      const usage = parseUsage(source.usage)
      const error = source.error === undefined ? undefined : parseError(source.error) ?? undefined
      return {
        ...base,
        type,
        status: status as 'succeeded' | 'failed' | 'cancelled',
        ...(usage ? { usage } : {}),
        ...(error ? { error } : {}),
      }
    }
    default:
      return null
  }
}

export const encodeRuntimeEvent = (event: RuntimeEvent): RuntimeEvent => event
