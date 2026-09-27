export type AbortReason =
  | 'user_stop'
  | 'executor_disconnected'
  | 'control_plane_disconnect'
  | 'timeout'
  | 'provider_error'
  | 'cancelled'
  | 'unknown'

export const ABORT_REASON_LABELS: Readonly<Record<AbortReason, string>> = {
  user_stop: '用户已停止本轮',
  executor_disconnected: '执行节点连接已断开',
  control_plane_disconnect: '控制面连接已断开',
  timeout: '本轮执行超时',
  provider_error: '模型服务执行失败',
  cancelled: '本轮已取消',
  unknown: '本轮因未知原因中止',
}

export function abortReasonLabel(reason: AbortReason): string {
  return ABORT_REASON_LABELS[reason]
}

export type AgentFailureReason =
  | 'agent_error.context_overflow'
  | 'agent_error.missing_config'
  | 'agent_error.provider_auth_or_access'
  | 'agent_error.provider_quota_limit'
  | 'agent_error.provider_capacity_or_rate_limit'
  | 'agent_error.provider_server_error'
  | 'agent_error.provider_network'
  | 'agent_error.model_not_found_or_unavailable'
  | 'agent_error.empty_or_unparseable_output'
  | 'agent_error.agent_timeout'
  | 'agent_error.runtime_missing_executable'
  | 'agent_error.runtime_version_unsupported'
  | 'agent_error.process_failure'
  | 'agent_error.unknown'

export interface AgentErrorClassification {
  readonly reason: AgentFailureReason
  readonly retryable: boolean
}

export const AGENT_FAILURE_REASON_LABELS: Readonly<Record<AgentFailureReason, string>> = {
  'agent_error.context_overflow': '上下文窗口已超限',
  'agent_error.missing_config': '运行时缺少必要配置',
  'agent_error.provider_auth_or_access': '模型服务认证或访问被拒绝',
  'agent_error.provider_quota_limit': '模型服务额度不足',
  'agent_error.provider_capacity_or_rate_limit': '模型服务容量不足或触发限流',
  'agent_error.provider_server_error': '模型服务端发生错误',
  'agent_error.provider_network': '模型服务网络连接中断',
  'agent_error.model_not_found_or_unavailable': '模型不存在或当前不可用',
  'agent_error.empty_or_unparseable_output': '智能体未返回可解析结果',
  'agent_error.agent_timeout': '智能体进程执行超时',
  'agent_error.runtime_missing_executable': '智能体运行时未安装或不可执行',
  'agent_error.runtime_version_unsupported': '智能体运行时版本不受支持',
  'agent_error.process_failure': '智能体进程异常退出',
  'agent_error.unknown': '智能体发生未知错误',
}

export function agentFailureReasonLabel(reason: AgentFailureReason): string {
  return AGENT_FAILURE_REASON_LABELS[reason]
}

const boundedCode = (codes: string) => new RegExp(`(^|[^0-9])(?:${codes})([^0-9]|$)`)
const authCode = boundedCode('401|403')
const quotaCode = boundedCode('402')
const capacityCode = boundedCode('429|529')
const serverCode = boundedCode('5[0-9][0-9]')
const includesAny = (text: string, values: readonly string[]) => values.some(value => text.includes(value))

/**
 * Classifies free-form provider and runtime errors into the stable 14-value
 * Agent taxonomy. Rule order is part of the contract: specific upstream
 * failures must win over generic process-exit markers.
 */
export function classifyAgentError(errorText: string): AgentErrorClassification {
  const text = errorText.trim().toLowerCase()
  let reason: AgentFailureReason = 'agent_error.unknown'

  if (text.includes('concurrent request limit')) reason = 'agent_error.provider_capacity_or_rate_limit'
  else if (
    includesAny(text, ['context length', 'context_length_exceeded', 'maximum context', 'prompt is too long', 'context size has been exceeded', 'context window limit', 'model_context_window_exceeded', 'terminal_reason=prompt_too_long']) ||
    (text.includes('token') && text.includes('limit'))
  ) reason = 'agent_error.context_overflow'
  else if (
    text.includes('missing environment variable') ||
    (text.includes('missing') && text.includes('api_key')) ||
    (text.includes('api key') && text.includes('required')) ||
    includesAny(text, ['no llm provider configured', 'no provider configured'])
  ) reason = 'agent_error.missing_config'
  else if (authCode.test(text) || includesAny(text, ['unauthorized', 'login required', 'not logged in', 'please login again', 'refresh token', 'invalid api key', 'access token', 'subscription access', 'does not have access', 'you may not have access'])) reason = 'agent_error.provider_auth_or_access'
  else if (quotaCode.test(text) || includesAny(text, ['insufficient_balance', 'balance is too low', 'monthly usage limit', 'usage limit', "you've hit your limit", 'you’ve hit your limit', 'credits', 'quota'])) reason = 'agent_error.provider_quota_limit'
  else if (capacityCode.test(text) || includesAny(text, ['rate limit', 'overloaded', 'no capacity available'])) reason = 'agent_error.provider_capacity_or_rate_limit'
  else if (includesAny(text, ['server had an error', 'provider returned error', 'internal error', 'service unavailable', 'bad gateway']) || serverCode.test(text)) reason = 'agent_error.provider_server_error'
  else if (
    text === 'connection error.' || text === 'request timed out.' ||
    /^(connection error\.|request timed out\.); (?:pi|omp) exited with error:/.test(text) ||
    text.startsWith('opencode stream ended') || text.startsWith('codearts stream ended') ||
    includesAny(text, ['stream disconnected', 'connection closed', 'mid-response', 'error sending request', 'unable to connect', 'dial tcp', 'connection refused', 'connectionrefused', 'dns', 'i/o timeout', 'deadline exceeded', 'timeout exceeded while awaiting'])
  ) reason = 'agent_error.provider_network'
  else if ((text.includes('model') && text.includes('not found')) || includesAny(text, ['unknown model', 'selected model', 'http 404', '404 page not found'])) reason = 'agent_error.model_not_found_or_unavailable'
  else if (includesAny(text, ['returned empty output', 'returned no parseable output'])) reason = 'agent_error.empty_or_unparseable_output'
  else if (text.includes('timed out after')) reason = 'agent_error.agent_timeout'
  else if (includesAny(text, ['executable not found', 'exec format error'])) reason = 'agent_error.runtime_missing_executable'
  else if (includesAny(text, ['below the minimum supported version', 'requires a newer version'])) reason = 'agent_error.runtime_version_unsupported'
  else if (includesAny(text, ['exit status', 'signal', 'panic', 'sigsegv', 'process exited', 'start codex:', 'pipe has been ended', 'file already closed', 'initialize failed'])) reason = 'agent_error.process_failure'

  return { reason, retryable: reason === 'agent_error.provider_network' }
}
