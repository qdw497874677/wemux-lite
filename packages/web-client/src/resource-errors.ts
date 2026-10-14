import { ApiError } from './errors.ts'

/**
 * Server 在并发/幂等冲突时返回的冲突码（apps/server/src/http/routes/node-resource-routes.ts）。
 * 这类失败不是用户输入错误，唯一正确的处理是刷新后重试。
 */
const conflictCodes = new Set([
  'preset_revision_conflict',
  'preset_application_request_conflict',
  'resource_set_revision_conflict',
  'preset_binding_conflict',
  'provider_version_conflict',
  'resource_binding_revision_conflict',
])

/** 校验失败的具体原因提示：把 Server 的错误码翻译成可操作的中文说明。 */
const validationHints: Record<string, string> = {
  invalid_provider_config: 'Provider 配置不符合要求：端点必须是 HTTPS，模型 ID 与凭据引用需符合格式。',
  invalid_provider_revision: 'Provider 修订无效：请检查版本、定义与内容哈希是否自洽。',
  invalid_provider_binding: '绑定无效：Provider 修订需声明目标 Agent，技能需兼容目标 Agent。',
  invalid_provider_binding_target: '绑定目标无效：请确认 Worker 上存在该 Agent 或项目。',
  invalid_request: '请求字段缺失或不匹配：请检查表单内容后重试。',
  invalid_preset: '预设内容无效：请检查名称与条目。',
  invalid_preset_entry: '预设条目无效：请确认所选资源修订属于对应资源。',
  preset_revision_not_published: '所选资源修订尚未发布，无法加入预设。',
  duplicate_preset_entry: '预设中存在重复条目，请去重后重试。',
  resource_not_found: '资源不存在：可能已被删除，请刷新后重试。',
  resource_revision_not_found: '资源修订不存在：请刷新后重新选择。',
  provider_resource_not_found: 'Provider 资源不存在：请刷新后重试。',
}

export function isResourceWriteConflict(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409
    && typeof cause.code === 'string' && conflictCodes.has(cause.code)
}

/** 把写路径失败翻译为面向管理员的一句话原因；从不静默吞掉失败。 */
export function describeResourceWriteError(cause: unknown): string {
  if (isResourceWriteConflict(cause)) return '资源状态已被其他操作改变，请刷新后重试。'
  if (cause instanceof ApiError) {
    const code = typeof cause.code === 'string' ? cause.code : ''
    const hint = validationHints[code]
    if (hint) return `${hint}（${code}）`
    const detail = cause.message.replace(/^请求失败（HTTP \d+）：/, '').trim()
    return detail ? `${detail}${code ? `（${code}）` : ''}` : '资源写入失败，请重试。'
  }
  const message = cause instanceof Error ? cause.message.trim() : ''
  return message || '资源写入失败，请重试。'
}
