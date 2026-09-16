import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateCapability, type CapabilityAction, type CapabilityFacts } from './action-capability.js'
const a = { workspaceId: 'w', workerId: 'worker', agentKey: 'agent', modelId: 'model' }
const task = { id: 't', projectId: 'p', version: 1, status: 'in_progress', assignee: a, blockedFrom: null, cancelledFrom: null, metadataJson: { schemaVersion: 1, values: {} } }
const run = { id: 'r', taskId: 't', projectId: 'p', sessionId: 's', attempt: 1, status: 'succeeded', snapshot: a }
const review = { id: 'review', taskRunId: 'r', taskId: 't', projectId: 'p', status: 'requested', actor: 'owner', reviewer: null, requestedAt: '2026-01-01T00:00:00.000Z', decidedAt: null, closedAt: null }
const facts: CapabilityFacts = { task, run, runs: [run], target: 'in_review', actor: 'owner', idleReason: null, binding: { taskId: 't', projectId: 'p', workspaceId: 'w' }, workspace: { id: 'w', projectId: 'p', deletedAt: null, placements: [{ workerId: 'worker', status: 'ready' }] }, worker: { id: 'worker', connectionState: 'online', capabilities: [{ agentKey: 'agent', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' }] }] }, session: { id: 's', projectId: 'p', taskId: 't', ownerId: 'owner', workspaceId: 'w', deletedAt: null, binding: { workspaceId: 'w', agent: { workerId: 'worker', agentKey: 'agent' }, modelId: 'model' } } }
const actions: CapabilityAction[] = ['transition', 'launch_new', 'launch_reuse', 'cancel', 'review_request', 'review_approve', 'review_changes_requested', 'send']
for (const action of actions) test(`capability ${action}: allow and missing facts fail closed, pure deterministic result`, () => {
  const f = action === 'review_approve' || action === 'review_changes_requested' ? { ...facts, task: { ...task, status: 'in_review', currentReviewId: review.id }, review } : facts
  const before = JSON.stringify(f)
  assert.deepEqual(evaluateCapability(action, f), { allowed: true, reasonCode: 'allowed', reason: '' })
  assert.equal(evaluateCapability(action, {}).allowed, false)
  assert.equal(JSON.stringify(f), before)
})
const cases: [string, CapabilityAction, CapabilityFacts, string][] = [
  ['illegal target', 'transition', { target: 'done' }, 'invalid_transition'],
  ['active completion', 'transition', { task: { ...task, status: 'in_review' }, target: 'done', run: { ...run, status: 'running' }, runs: [{ ...run, status: 'running' }] }, 'active_run'],
  ['active launch', 'launch_new', { run: { ...run, status: 'pending' }, runs: [{ ...run, status: 'pending' }] }, 'active_run'],
  ['assignment mismatch', 'launch_new', { assignment: { ...a, modelId: 'other' } }, 'assignment_changed'],
  ['unbound', 'launch_new', { binding: null }, 'assignment_changed'],
  ['workspace provisioning', 'launch_new', { workspace: { id: 'w', projectId: 'p', deletedAt: null, placements: [{ workerId: 'worker', status: 'provisioning' }] } }, 'workspace_not_ready'],
  ['missing worker', 'launch_new', { worker: null }, 'runtime_unavailable'],
  ['partial capabilities', 'send', { worker: { id: 'worker', connectionState: 'online', capabilities: [null, {}] } }, 'runtime_unavailable'],
  ['unknown idle', 'launch_reuse', { idleReason: undefined }, 'reuse_ineligible'],
  ['busy session', 'launch_reuse', { idleReason: 'Session has queued work' }, 'reuse_ineligible'],
  ['foreign owner', 'launch_reuse', { actor: 'other' }, 'reuse_ineligible'],
  ['missing run', 'cancel', { run: null }, 'not_found'],
  ['missing review', 'review_approve', { review: null }, 'not_found'],
  ['decided review', 'review_changes_requested', { review: { ...review, status: 'approved', reviewer: 'owner', decidedAt: review.requestedAt, closedAt: review.requestedAt } }, 'invalid_transition'],
  ['active review', 'review_request', { run: { ...run, status: 'pending' }, runs: [{ ...run, status: 'pending' }] }, 'active_run'],
  ['foreign review', 'review_request', { review: { ...review, taskId: 'foreign' } }, 'invalid_metadata'],
  ['corrupt task', 'transition', { task: { ...task, metadataJson: null } }, 'invalid_metadata'],
  ['partial snapshot', 'transition', { runs: [{ ...run, snapshot: {} }] }, 'invalid_metadata'],
  ['missing attempt', 'transition', { runs: [{ ...run, attempt: undefined }] }, 'invalid_metadata'],
  ['foreign run', 'transition', { runs: [{ ...run, projectId: 'foreign' }] }, 'invalid_metadata'],
  ['invalid restore', 'transition', { task: { ...task, status: 'blocked', blockedFrom: 'blocked' } }, 'invalid_metadata'],
  ['partial session', 'send', { session: { id: 's', binding: {} } }, 'invalid_metadata'],
  ['foreign workspace', 'send', { workspace: { id: 'w', projectId: 'foreign', deletedAt: null, placements: [{ workerId: 'worker', status: 'ready' }] } }, 'invalid_metadata'],
]
for (const key of ['status', 'sessionId', 'projectId', 'taskId', 'attempt', 'lastProjectedSeq'] as const) test(`selected Run ${key} must match authoritative history`, () => {
  for (const action of ['cancel', 'review_request', 'review_approve', 'review_changes_requested'] as const) {
    assert.equal(evaluateCapability(action, { ...facts, run: { ...run, [key]: key === 'attempt' || key === 'lastProjectedSeq' ? 99 : 'other' } }).reasonCode, 'invalid_metadata')
  }
})
for (const patch of [{ actor: '' }, { requestedAt: 'invalid' }, { reviewer: 'owner' }, { decidedAt: review.requestedAt }, { closedAt: '2000-01-01' }, { status: 'approved', reviewer: null }]) test(`review lifecycle rejects ${JSON.stringify(patch)}`, () => {
  assert.equal(evaluateCapability('review_approve', { ...facts, review: { ...review, ...patch } }).reasonCode, 'invalid_metadata')
})
test('independent send remains allowed with offline Worker', () => {
  assert.equal(evaluateCapability('send', { ...facts, worker: { ...(facts.worker as object), connectionState: 'offline' } }).allowed, true)
})
for (const [name, action, patch, reasonCode] of cases) test(`capability reason: ${name}`, () => {
  const result = evaluateCapability(action, { ...facts, ...patch })
  assert.equal(result.allowed, false); assert.equal(result.reasonCode, reasonCode); assert.ok(result.reason)
})
