import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { EnqueueAuthorization } from './command-authorization.js'
import {
  ASSERTION_REQUIRED_COMMAND_KINDS,
  WORKER_COMMAND_KINDS,
  assertionScopeMatches,
  assertionVersionAccepted,
  authorizationBytes,
  isWorkerCommandKind,
  requiresCommandAssertion,
} from './command-authorization.js'
import type { WorkerCommand } from './commands.js'

const base = (overrides: Record<string, unknown> = {}): EnqueueAuthorization =>
  ({
    version: 3,
    kind: 'turn.stop',
    keyId: 'key-1',
    commandId: 'cmd-1',
    workerId: 'worker-1',
    sessionId: 'session-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    taskId: null,
    actorId: 'user-1',
    actorAuthVersion: 0,
    commandDigest: 'digest-1',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:05:00.000Z',
    ...overrides,
  }) as EnqueueAuthorization

test('byte layout stays frozen for v1 and v2 assertions', () => {
  const v1 = authorizationBytes(
    base({ version: 1, kind: undefined, sessionId: 'session-1', taskId: 'task-1' }),
  ).toString('utf8')
  const v2 = authorizationBytes(
    base({ version: 2, kind: 'runtime.approval.resolve', taskId: null }),
  ).toString('utf8')
  // 与 2026-10 部署的签名字节一致：v1 无 kind 字段，v2 起 kind 参与签名。
  assert.equal(v1, JSON.stringify({
    version: 1,
    keyId: 'key-1',
    commandId: 'cmd-1',
    workerId: 'worker-1',
    sessionId: 'session-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    taskId: 'task-1',
    actorId: 'user-1',
    actorAuthVersion: 0,
    commandDigest: 'digest-1',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:05:00.000Z',
  }))
  const v2Json = JSON.parse(v2) as Record<string, unknown>
  assert.equal(v2Json['kind'], 'runtime.approval.resolve')
  assert.deepEqual(Object.keys(v2Json).slice(0, 2), ['version', 'kind'])
})

test('v3 byte layout binds the command kind', () => {
  const json = JSON.parse(
    authorizationBytes(base({ kind: 'workspace.provision', sessionId: null, workspaceId: 'workspace-9' })).toString('utf8'),
  ) as Record<string, unknown>
  assert.equal(json['kind'], 'workspace.provision')
  assert.equal(json['sessionId'], null)
  assert.equal(json['workspaceId'], 'workspace-9')
})

test('command kind registries cover every transport kind and fail closed elsewhere', () => {
  for (const kind of [
    'workspace.provision',
    'workspace.delete',
    'session.create',
    'session.enqueue',
    'session.cancel-queued',
    'session.delete',
    'turn.stop',
    'runtime.command',
    'runtime.approval.resolve',
    'connector.definition.sync',
    'connector.definition.revoke',
    'connector.test',
  ]) {
    assert.equal(isWorkerCommandKind(kind), true, kind)
    assert.equal(requiresCommandAssertion(kind), true, kind)
  }
  assert.deepEqual([...ASSERTION_REQUIRED_COMMAND_KINDS], [...WORKER_COMMAND_KINDS])
  assert.equal(isWorkerCommandKind('trojan.horse'), false)
  assert.equal(isWorkerCommandKind(undefined), false)
  assert.equal(requiresCommandAssertion('trojan.horse'), false)
})

test('assertion version acceptance keeps legacy enqueue v1 and approval v2 replays valid', () => {
  assert.equal(assertionVersionAccepted('session.enqueue', 1), true)
  assert.equal(assertionVersionAccepted('session.enqueue', 3), true)
  assert.equal(assertionVersionAccepted('session.enqueue', 2), false)
  assert.equal(assertionVersionAccepted('runtime.approval.resolve', 2), true)
  assert.equal(assertionVersionAccepted('runtime.approval.resolve', 3), true)
  assert.equal(assertionVersionAccepted('runtime.approval.resolve', 1), false)
  assert.equal(assertionVersionAccepted('turn.stop', 3), true)
  assert.equal(assertionVersionAccepted('workspace.provision', 1), false)
  assert.equal(assertionVersionAccepted('workspace.provision', 2), false)
  assert.equal(assertionVersionAccepted('session.enqueue', 4), false)
  assert.equal(assertionVersionAccepted('session.enqueue', '3'), false)
})

test('assertion scope binds session-scoped, session creation and session-less commands', () => {
  const enqueue = {
    kind: 'session.enqueue',
    sessionId: 'session-1',
    message: { messageId: 'm1', content: 'hi', sentByAccountId: 'user-1' },
  } as never as WorkerCommand
  assert.equal(assertionScopeMatches(base({ kind: 'session.enqueue' }), enqueue), true)
  assert.equal(assertionScopeMatches(base({ kind: 'session.enqueue', sessionId: 'session-2' }), enqueue), false)
  const create: WorkerCommand = {
    kind: 'session.create',
    session: { sessionId: 'session-1', binding: { workspaceId: 'workspace-1' } },
  } as never
  assert.equal(assertionScopeMatches(base({ kind: 'session.create' }), create), true)
  assert.equal(
    assertionScopeMatches(base({ kind: 'session.create', workspaceId: 'workspace-2' }), create),
    false,
  )

  const provision: WorkerCommand = {
    kind: 'workspace.provision',
    workspace: { workspace: { id: 'workspace-1', projectId: 'project-1' } },
  } as never
  assert.equal(
    assertionScopeMatches(
      base({ kind: 'workspace.provision', sessionId: null, projectId: 'project-1', workspaceId: 'workspace-1' }),
      provision,
    ),
    true,
  )
  assert.equal(
    assertionScopeMatches(
      base({ kind: 'workspace.provision', sessionId: 'session-1', workspaceId: 'workspace-1' }),
      provision,
    ),
    false,
  )
  assert.equal(
    assertionScopeMatches(
      base({ kind: 'workspace.provision', sessionId: null, workspaceId: 'workspace-2' }),
      provision,
    ),
    false,
  )

  const sync: WorkerCommand = {
    kind: 'connector.definition.sync',
    requestId: 'req-1',
    definition: { projectId: 'project-1' },
  } as never
  assert.equal(
    assertionScopeMatches(
      base({ kind: 'connector.definition.sync', sessionId: null, workspaceId: null }),
      sync,
    ),
    true,
  )
  assert.equal(
    assertionScopeMatches(
      base({ kind: 'connector.definition.sync', sessionId: null, workspaceId: 'workspace-1' }),
      sync,
    ),
    false,
  )
})
