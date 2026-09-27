import assert from 'node:assert/strict'
import test from 'node:test'

import { abortReasonLabel, classifyAgentError } from '../dist/index.js'

const cases = [
  ['prompt is too long for the context window', 'agent_error.context_overflow'],
  ['missing environment variable OPENAI_API_KEY', 'agent_error.missing_config'],
  ['request failed with 401 unauthorized', 'agent_error.provider_auth_or_access'],
  ['insufficient_balance, status 402', 'agent_error.provider_quota_limit'],
  ['rate limit exceeded 429', 'agent_error.provider_capacity_or_rate_limit'],
  ['service unavailable status 503', 'agent_error.provider_server_error'],
  ['dial tcp: connection refused', 'agent_error.provider_network'],
  ['selected model not found', 'agent_error.model_not_found_or_unavailable'],
  ['agent returned empty output', 'agent_error.empty_or_unparseable_output'],
  ['agent timed out after 30000ms', 'agent_error.agent_timeout'],
  ['executable not found', 'agent_error.runtime_missing_executable'],
  ['runtime is below the minimum supported version', 'agent_error.runtime_version_unsupported'],
  ['process exited with signal SIGSEGV', 'agent_error.process_failure'],
  ['something entirely unexpected', 'agent_error.unknown'],
]

test('classifyAgentError covers the stable 14-value taxonomy', () => {
  for (const [text, reason] of cases) assert.equal(classifyAgentError(text).reason, reason, text)
})

test('numeric status guards reject embedded and unrelated numbers', () => {
  assert.equal(classifyAgentError('trace id x4019').reason, 'agent_error.unknown')
  assert.equal(classifyAgentError('model build 5030 failed').reason, 'agent_error.unknown')
  assert.equal(classifyAgentError('status=403.').reason, 'agent_error.provider_auth_or_access')
})

test('ordered rules keep context overflow and explicit timeout semantics ahead of generic process errors', () => {
  assert.equal(classifyAgentError('prompt is too long; process exited with status 1').reason, 'agent_error.context_overflow')
  assert.equal(classifyAgentError('agent timed out after 30000ms; process exited').reason, 'agent_error.agent_timeout')
})

test('only provider network failures are retryable', () => {
  for (const [text, reason] of cases) assert.equal(classifyAgentError(text).retryable, reason === 'agent_error.provider_network', text)
})

test('AbortReason labels distinguish user stop from executor disconnect', () => {
  assert.equal(abortReasonLabel('user_stop'), '用户已停止本轮')
  assert.equal(abortReasonLabel('executor_disconnected'), '执行节点连接已断开')
  assert.notEqual(abortReasonLabel('user_stop'), abortReasonLabel('executor_disconnected'))
})
