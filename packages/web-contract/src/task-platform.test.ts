import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { activeRunStatuses, boardStatuses, launchFingerprintInput, runStatuses, taskErrorStatus, taskStatuses } from './task-platform.js'
import type { Assignment, LaunchRequest, LaunchResponse, ProjectEvent, TaskPatch, TaskErrorResponse, TaskSummary, TaskDetail, BoardColumn } from './task-platform.js'
// Public package entry and domain-safe subpath must expose the same DTOs.
import type { LaunchRequest as PublicLaunch } from '@wemux/web-contract'
import type { LaunchRequest as DomainLaunch } from '@wemux/web-contract/task-platform'

const assignment: Assignment = { workspaceId: 'ws-1', workerId: 'worker-1', agentKey: 'pi', modelId: 'provider::model' }
const launch: LaunchRequest = { requestId: 'launch-01', mode: 'new', prompt: ' 请实现验收标准 ', reuseSessionId: null, assignment }
const publicLaunch: PublicLaunch = launch
const domainLaunch: DomainLaunch = publicLaunch
const hash = (request: LaunchRequest) => createHash('sha256').update(JSON.stringify(launchFingerprintInput(request))).digest('hex')

test('M1 launch canonical tuple preserves content but separates request identity from fingerprint', () => {
  assert.deepEqual(launchFingerprintInput(domainLaunch), ['new', ' 请实现验收标准 ', null, ['ws-1', 'worker-1', 'pi', 'provider::model']])
  assert.equal(hash({ ...launch }), hash(launch), 'network retry retains the request')
  assert.equal(hash({ ...launch, requestId: 'launch-02' }), hash(launch), 'same content is allowed for a new request identity')
  for (const changed of [
    { ...launch, prompt: launch.prompt.trim() },
    { ...launch, assignment: { ...assignment, modelId: 'different' } },
    { ...launch, mode: 'reuse' as const, reuseSessionId: 'session-1' },
  ]) assert.notEqual(hash(changed), hash(launch))
})

test('M1 state, active cancellation and error vocabulary is frozen', () => {
  assert.deepEqual(taskStatuses, ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'])
  assert.deepEqual(boardStatuses, ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked'])
  assert.deepEqual(runStatuses, ['pending', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'])
  assert.deepEqual(activeRunStatuses, ['pending', 'running', 'cancelling'])
  assert.deepEqual(taskErrorStatus, {
    task_deleted: 410, task_has_sessions: 409, task_has_review: 409,
    invalid_request: 400, unauthorized: 401, forbidden: 403, not_found: 404,
    request_id_conflict: 409, version_conflict: 409, active_run: 409,
    assignment_changed: 409, workspace_not_ready: 409, runtime_unavailable: 409,
    reuse_ineligible: 409, workspace_bound: 409, invalid_transition: 409,
  })
})

test('M1 CAS authority and flat project event serialize without an alternate envelope', () => {
  const patch: TaskPatch = { version: 1, status: 'in_progress', title: 'preserve draft' }
  const conflict: TaskErrorResponse = { error: { code: 'version_conflict', message: 'Conflict', details: { currentVersion: 2, status: 'blocked', assignment } } }
  const event: ProjectEvent = { id: 'opaque', projectId: 'project-1', type: 'run.changed', taskId: 'task-1', runId: 'run-1' }
  assert.equal(patch.version, 1)
  assert.equal(conflict.error.details?.currentVersion, 2)
  assert.equal(JSON.stringify(event), '{"id":"opaque","projectId":"project-1","type":"run.changed","taskId":"task-1","runId":"run-1"}')
})

test('M1 board summaries carry external-link count without fetching details', () => {
  const summary: TaskSummary = {
    id: 't', projectId: 'p', title: 'Linked task', priority: 'none', status: 'todo',
    version: 1, assignee: null, origin: 'manual', activeRun: null, linkCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z',
  }
  const detail: TaskDetail = { ...summary, metadataJson: { schemaVersion: 1, values: {} }, description: '', acceptanceCriteria: null, blockedFrom: null, cancelledFrom: null, workspaces: [], links: [{ id: 'l', type: 'github-issue', externalId: '1', url: 'https://github.com/example/repo/issues/1', syncState: 'none' }] }
  const board: BoardColumn = { status: 'todo', tasks: [summary, { ...summary, id: 'unlinked', linkCount: 0 }] }
  assert.deepEqual(board.tasks.map(task => task.linkCount > 0), [true, false])
  assert.equal(detail.linkCount, detail.links.length)
  const { linkCount, ...missingCount } = summary
  // @ts-expect-error every summary must carry the external-link marker count
  const invalid: TaskSummary = missingCount
  void invalid
  assert.equal(linkCount, 1)
})

// Compile-time negative cases are checked by npm run typecheck, not runtime validation.
function contractTypeChecks(response: LaunchResponse) {
  const attempt: number = response.run.attempt
  // @ts-expect-error attempt is allocated by Server, not a LaunchRequest input
  const clientAttempt: LaunchRequest = { ...launch, attempt: 1 }
  // @ts-expect-error new must explicitly normalize reuseSessionId to null
  const invalidNew: LaunchRequest = { ...launch, mode: 'new', reuseSessionId: 's' }
  // @ts-expect-error reuse must identify a session
  const invalidReuse: LaunchRequest = { ...launch, mode: 'reuse', reuseSessionId: null }
  // @ts-expect-error status PATCH requires CAS
  const missingVersion: TaskPatch = { status: 'done' }
  // @ts-expect-error assignment PATCH requires CAS even when mixed with content
  const missingAssignmentVersion: TaskPatch = { title: 'draft', assignee: null }
  // @ts-expect-error run invalidation must identify the Run
  const missingRun: ProjectEvent = { id: 'e', projectId: 'p', type: 'run.changed', taskId: 't' }
  // @ts-expect-error version conflict requires authoritative details
  const missingAuthority: TaskErrorResponse = { error: { code: 'version_conflict', message: 'Conflict' } }
  // @ts-expect-error immutable snapshot cannot be rewritten after launch
  response.run.snapshot.modelId = 'different'
  return [attempt, clientAttempt, invalidNew, invalidReuse, missingVersion, missingAssignmentVersion, missingRun, missingAuthority]
}
void contractTypeChecks

 test('Run failure and projection cursor survive public DTO JSON serialization', () => {
  const run: LaunchResponse['run'] = {
    id: 'r', taskId: 't', projectId: 'p', requestId: launch.requestId, request: launch,
    fingerprint: hash(launch), attempt: 1, sessionId: 's', snapshot: assignment,
    status: 'failed', resultSummary: null, failure: { code: 'agent_failed', message: 'Agent failed' },
    createdAt: '2026-01-01T00:00:00.000Z', startedAt: null, finishedAt: '2026-01-01T00:00:01.000Z',
    cancelRequestedAt: null, createCommandId: 'create', enqueueCommandId: 'enqueue',
    messageId: null, turnId: null, cancelCommandIds: [], lastProjectedSeq: 501,
  }
  assert.deepEqual(JSON.parse(JSON.stringify({ run })).run.failure, { code: 'agent_failed', message: 'Agent failed' })
  assert.equal(JSON.parse(JSON.stringify({ run })).run.lastProjectedSeq, 501)
  assert.equal(JSON.parse(JSON.stringify({ ...run, failure: null })).failure, null)
  const { failure, lastProjectedSeq, ...incomplete } = run
  // @ts-expect-error both projection fields are mandatory on public Run
  const invalid: LaunchResponse['run'] = incomplete
  void invalid; void failure; void lastProjectedSeq
})
