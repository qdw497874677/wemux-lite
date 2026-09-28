import assert from 'node:assert/strict'
import test from 'node:test'
import { DelegationRuntime } from '../src/application/delegation-runtime.ts'

const dispatch = {
  kind: 'delegation.dispatch', requestId: 'request-1', delegationId: 'delegation-1', dispatchId: 'dispatch-1', objective: '检查测试失败',
  sourceProjectId: 'project-1', targetProjectId: 'project-1', sourceSessionId: 'session-a', targetSessionId: 'session-b', canonicalSessionId: 'session-a',
  sourceAgentId: 'agent-a', targetAgentId: 'agent-b', authorityCapabilities: ['agent.send'], ancestorAgentIds: ['agent-a'], depth: 1,
  route: { sourceWorkerId: 'worker-1', targetWorkerId: 'worker-1' },
} as never

test('two test agents collaborate through child Run, result return, and canonical session continuation', async () => {
  const events: string[] = []
  const runtime = new DelegationRuntime('worker-1', {
    createChildRun: async input => { events.push(`run:${input.targetSessionId}:${input.requestId}`); return { id: 'child-run-1', sessionId: input.targetSessionId } },
    executeChildRun: async (run, objective) => { events.push(`execute:${run.id}:${objective}`); return { outcome: 'completed', output: 'B 已定位失败原因为快照过期' } },
    returnResult: async result => { events.push(`result:${result.canonicalSessionId}:${result.resultSummary}`) },
    continueCanonicalSession: async (sessionId, result) => { events.push(`continue:${sessionId}:${result.content}`) },
  })
  const result = await runtime.execute(dispatch)
  assert.equal(result.childRunId, 'child-run-1')
  assert.deepEqual(events, [
    'run:session-b:delegation:dispatch-1',
    'execute:child-run-1:检查测试失败',
    'result:session-a:B 已定位失败原因为快照过期',
    'continue:session-a:B 已定位失败原因为快照过期',
  ])
  assert.deepEqual(await runtime.execute(dispatch), result)
  assert.equal(events.length, 4)
})

test('[SILENT] produces an empty sender reply and is not forwarded as visible content', async () => {
  let continuation: { content: string; silent: boolean } | undefined
  const runtime = new DelegationRuntime('worker-1', {
    createChildRun: async input => ({ id: 'child-run-silent', sessionId: input.targetSessionId }),
    executeChildRun: async () => ({ outcome: 'completed', output: '[SILENT]' }),
    returnResult: async result => { assert.equal(result.resultSummary, undefined); assert.equal(result.silent, true) },
    continueCanonicalSession: async (_sessionId, result) => { continuation = result },
  })
  const result = await runtime.execute(dispatch)
  assert.equal(result.silent, true)
  assert.deepEqual(continuation, { content: '', silent: true })
})

test('cross Worker dispatch is rejected without creating a child Run', async () => {
  let created = false
  const runtime = new DelegationRuntime('worker-1', {
    createChildRun: async () => { created = true; throw new Error('unexpected') },
    executeChildRun: async () => ({ outcome: 'failed' }), returnResult: async () => {}, continueCanonicalSession: async () => {},
  })
  await assert.rejects(() => runtime.execute({ ...dispatch, route: { sourceWorkerId: 'worker-1', targetWorkerId: 'worker-2' } }), /same Worker/)
  assert.equal(created, false)
})
