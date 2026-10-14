import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agentAuthenticationAxis,
  agentExecutionAxis,
  bindingDistributionAxis,
  providerAuthenticationAxis,
} from '../dist/index.js'

const worker = 'worker-1'
const at = '2026-05-01T00:00:00.000Z'

function capability(overrides = {}) {
  return {
    agentKey: 'pi',
    displayName: 'Pi',
    version: '0.85.1',
    mode: 'execution',
    availability: { status: 'available' },
    models: [],
    ...overrides,
  }
}

function report(overrides = {}) {
  return {
    requestId: 'request-1',
    workerId: worker,
    resourceSetRevision: 3,
    bindingId: 'binding-1',
    bindingRevision: 2,
    resourceRevisionId: 'revision-1',
    resourceId: 'resource-1',
    kind: 'agent-runtime',
    integrity: 'a'.repeat(64),
    result: 'installed',
    phase: 'ready',
    progressBytes: null,
    errorCode: null,
    message: null,
    activeRevision: 1,
    previousRevision: null,
    occurredAt: at,
    ...overrides,
  }
}

test('认证状态只来自 Worker 的真实认证探测，缺失探测不冒充已认证', () => {
  assert.deepEqual(agentAuthenticationAxis(capability({ authorization: { state: 'authorized', accountLabel: 'work@example.test' } })), {
    state: 'authenticated', detail: '已认证（work@example.test）', observedAt: null,
  })
  assert.equal(agentAuthenticationAxis(capability({ authorization: { state: 'unauthorized', instructions: '请先运行 claude login' } })).state, 'unauthenticated')
  assert.equal(agentAuthenticationAxis(capability({ authorization: { state: 'unauthorized' } })).state, 'unauthenticated')
  assert.equal(agentAuthenticationAxis(capability({ authorization: { state: 'unknown' } })).state, 'unknown')
  assert.equal(agentAuthenticationAxis(capability()).state, 'unknown')
  assert.equal(agentAuthenticationAxis(null).state, 'unknown')

  // 已可用但没有认证证据时，绝不能返回 authenticated。
  for (const axis of [agentAuthenticationAxis(capability()), agentAuthenticationAxis(null)]) {
    assert.notEqual(axis.state, 'authenticated')
    assert.ok(axis.detail.length > 0)
  }
})

test('可执行状态要求本机在线且有真实版本探测，available 不足以声称可执行', () => {
  assert.deepEqual(agentExecutionAxis(capability(), 'online'), { state: 'executable', detail: '已探测到版本 0.85.1', observedAt: null })
  assert.equal(agentExecutionAxis(capability({ version: null }), 'online').state, 'unavailable')
  assert.match(agentExecutionAxis(capability({ version: null }), 'online').detail, /版本|版本探测/)
  assert.equal(agentExecutionAxis(capability({ mode: 'detect-only' }), 'online').state, 'unavailable')
  assert.equal(agentExecutionAxis(capability({ availability: { status: 'unavailable', reason: '缺少运行时依赖' } }), 'online').state, 'unavailable')
  assert.equal(agentExecutionAxis(capability({ availability: { status: 'unavailable', reason: '缺少运行时依赖' } }), 'online').detail, '缺少运行时依赖')
  assert.equal(agentExecutionAxis(capability({ availability: { status: 'authentication-required', reason: '未登录' } }), 'online').state, 'unavailable')

  // 离线 Worker 上报的能力快照可能过期：如实标为未知，不得当作可执行。
  assert.equal(agentExecutionAxis(capability(), 'offline').state, 'unknown')
  assert.equal(agentExecutionAxis(capability(), 'revoked').state, 'unavailable')
  assert.equal(agentExecutionAxis(null, 'online').state, 'unavailable')
  assert.equal(agentExecutionAxis(null, 'online').detail, 'Worker 未探测到该 Agent')
})

test('分发状态由绑定与 Worker 安装回执共同决定，并保留回执时间', () => {
  assert.deepEqual(bindingDistributionAxis('installed', report()), { state: 'distributed', detail: 'Worker 已确认安装并就绪', observedAt: at, setRevision: 3 })

  const restart = bindingDistributionAxis('notified', report({ phase: 'restart-required', message: 'Agent 已安装并通过版本探测，等待安全重启' }))
  assert.equal(restart.state, 'pending')
  assert.match(restart.detail, /重启/)

  const credential = bindingDistributionAxis('notified', report({ phase: 'credential-required', errorCode: 'credential_required', message: '需要在 Worker 本地配置模型凭据' }))
  assert.equal(credential.state, 'pending')
  assert.match(credential.detail, /凭据/)

  const failed = bindingDistributionAxis('failed', report({ result: 'failed', phase: null, errorCode: 'runtime_activation_failed', message: 'Agent 安装或探测失败，已保留当前激活版本' }))
  assert.equal(failed.state, 'failed')
  assert.match(failed.detail, /安装|探测/)

  const mismatch = bindingDistributionAxis('failed', report({ result: 'version-mismatch', phase: null, errorCode: 'resource_revision_integrity_conflict' }))
  assert.equal(mismatch.state, 'failed')
  assert.match(mismatch.detail, /完整性|版本/)

  const recycled = bindingDistributionAxis('pending-gc', report({ result: 'pending-gc', phase: 'gc' }))
  assert.equal(recycled.state, 'not-distributed')

  // 没有回执时只能读到 Server 侧绑定状态，且必须明说尚未确认。
  assert.deepEqual(bindingDistributionAxis('assigned', null), { state: 'pending', detail: '尚未收到 Worker 安装回执', observedAt: null, setRevision: null })
  assert.equal(bindingDistributionAxis('assigned', null).observedAt, null)
  assert.equal(bindingDistributionAxis('installed', null).state, 'distributed')
  assert.match(bindingDistributionAxis('installed', null).detail, /尚未收到|上报/)
  assert.equal(bindingDistributionAxis('failed', null).state, 'failed')
})

test('Provider 认证状态取自 Worker 的本地凭据探测，缺失时明确要求配置', () => {
  const locator = { kind: 'environment', variableNames: ['OPENAI_API_KEY'] }
  assert.deepEqual(providerAuthenticationAxis(null, locator), {
    state: 'unknown', detail: '尚未分发到 Worker，本地凭据未探测', observedAt: null,
  })
  const configured = providerAuthenticationAxis(report({ kind: 'model-provider', phase: 'credential-required' }), locator)
  assert.equal(configured.state, 'authenticated')
  assert.equal(configured.observedAt, at)
  const missing = providerAuthenticationAxis(report({ kind: 'model-provider', phase: 'credential-required', errorCode: 'credential_required', message: '需要在 Worker 本地配置模型凭据' }), locator)
  assert.equal(missing.state, 'unauthenticated')
  assert.equal(missing.detail, '需要在 Worker 本地配置模型凭据')
  // 探测报告里不得出现凭据取值，只允许声明过的变量名。
  for (const axis of [configured, missing]) {
    assert.ok(!/sk-|secret-value/i.test(axis.detail))
  }
  assert.equal(providerAuthenticationAxis(report({ kind: 'model-provider', result: 'failed', phase: null, errorCode: 'invalid_provider_config' }), locator).state, 'unknown')
})
