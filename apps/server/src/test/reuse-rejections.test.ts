import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, ModelId, UserId, SessionId, EventSeq, JournalEvent, Timestamp, MessageId, CommandId, TurnId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { ServerService } from '../application/server-service.js'
import { TaskService, TaskError } from '../application/task-service.js'
import { Notifications } from '../application/notifications.js'
import { seedOperator, instanceOperatorId } from './fixtures/administrator.js'

const context = { actor: instanceOperatorId, requestId: 'reuse-matrix' }
const mismatch = 'Session ownership or binding mismatch; explicitly confirm a new Session'
const stale = 'Session Journal is not fresh; wait for synchronization; explicitly confirm a new Session'
const busy = 'Session has queued messages or a running Turn; explicitly confirm a new Session'
const runtime = 'Worker must be online with an available execution Agent and reported Model'
const cases = [
  ['eligible', null, null],
  ['wrong owner', 'reuse_ineligible', mismatch],
  ['wrong project', 'reuse_ineligible', mismatch],
  ['wrong task provenance', 'reuse_ineligible', mismatch],
  ['missing provenance', 'reuse_ineligible', mismatch],
  ['deleted Session', 'reuse_ineligible', mismatch],
  ['missing Session', 'reuse_ineligible', mismatch],
  ['workspace binding mismatch', 'reuse_ineligible', mismatch],
  ['agent binding mismatch', 'reuse_ineligible', mismatch],
  ['model binding mismatch', 'reuse_ineligible', mismatch],
  ['Worker binding mismatch', 'reuse_ineligible', mismatch],
  ['Worker offline', 'runtime_unavailable', runtime],
  ['unknown Journal', 'reuse_ineligible', stale],
  ['stale Journal', 'reuse_ineligible', stale],
  ['gapped Journal', 'reuse_ineligible', stale],
  ['pending enqueue beyond window', 'reuse_ineligible', 'Session has pending enqueue delivery; explicitly confirm a new Session'],
  ['accepted enqueue beyond window', 'reuse_ineligible', 'Session has pending enqueue delivery; explicitly confirm a new Session'],
  ['independent queued message', 'reuse_ineligible', busy],
  ['active Turn', 'reuse_ineligible', busy],
  ['Worker active Session invocation', 'reuse_ineligible', 'Worker has an active Session invocation; explicitly confirm a new Session'],
  ['unresolved accepted cancellation', 'active_run', 'Task already has an active Run'],
  ['nonterminal linked Run', 'active_run', 'Task already has an active Run'],
] as const

for (const [name, code, message] of cases) test(`public reuse rejection matrix: ${name}`, async () => {
  const at = '2025-01-01T00:00:00.000Z' as Timestamp
  const dir = await mkdtemp(join(tmpdir(), 'reuse-rejections-')), path = join(dir, 'server.db')
  const store = new SqliteServerStore(path), signals = new Notifications(), server = new ServerService(store, signals)
  const tasks = new TaskService(store, event => signals.project(event), server), db = new DatabaseSync(path)
  try {
    await seedOperator(store, server)
    const { worker } = await server.enroll({ token: (await server.createEnrollment({})).token, name: 'Reuse worker' })
    await store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }))
    const task = await tasks.create('default-project', { title: 'Reuse matrix' }, context)
    const { workspace } = await tasks.createWorkspace(task.projectId, task.id, { name: 'Ready', workerId: worker.id, source: 'empty' }, context)
    await store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready' }))
    const assignment = { workspaceId: workspace.id, workerId: worker.id, agentKey: 'test', modelId: 'model' }
    await tasks.assignment(task.projectId, task.id, { version: 1, assignee: assignment }, false, context)
    const { session: eligible } = await tasks.createSession(task.projectId, task.id, { title: 'Eligible Task Session' }, context)
    // Immutable bindings/provenance cannot be corrupted by UPDATE. Construct each
    // candidate from the same eligible Session before its first persisted insert.
    const candidate = structuredClone({ ...eligible, id: 'candidate' as SessionId, ownerId: context.actor, shareScope: 'owner-only' as const, binding: { ...eligible.binding, agent: { ...eligible.binding.agent } } })
    if (name === 'wrong owner') candidate.ownerId = 'another-owner' as UserId
    if (name === 'wrong task provenance' || name === 'wrong project') {
      let projectId = task.projectId
      if (name === 'wrong project') {
        const project = (await store.resources.getProject(task.projectId as typeof eligible.projectId))!
        db.prepare("INSERT INTO records(kind,id,data) VALUES('project','other-project',?)").run(JSON.stringify({ ...project, id: 'other-project' }))
        projectId = 'other-project'
        candidate.projectId = projectId as typeof candidate.projectId
      }
      // Project/Task scope is also enforced by SQL; foreign-project candidates
      // necessarily carry that project's valid Task provenance, not corrupt FKs.
      const other = await tasks.create(projectId, { title: 'Other Task' }, context)
      candidate.taskId = other.id
    }
    if (name === 'missing provenance') candidate.taskId = null
    if (name === 'deleted Session') candidate.deletedAt = '2025-01-01T00:00:00.000Z' as Timestamp
    if (name === 'workspace binding mismatch') candidate.binding.workspaceId = 'other-workspace' as typeof candidate.binding.workspaceId
    if (name === 'agent binding mismatch') candidate.binding.agent.agentKey = 'other-agent' as AgentKey
    if (name === 'model binding mismatch') candidate.binding.modelId = 'other-model' as ModelId
    if (name === 'Worker binding mismatch') candidate.binding.agent.workerId = 'other-worker' as typeof worker.id
    if (name !== 'missing Session') await store.transaction(tx => tx.resources.saveSession(candidate))
    if (name !== 'unknown Journal') await store.transaction(tx => tx.cache.recordWorkerHead(candidate.id, 0 as EventSeq))
    if (name === 'Worker offline') await store.transaction(async tx => { const current = (await tx.resources.getWorker(worker.id))!; await tx.resources.saveWorker({ ...current, connectionState: 'offline' }) })
    if (name === 'Worker active Session invocation') await store.transaction(tx => tx.resources.saveSession({ ...eligible, runtimeState: 'running' }))
    const event = (seq: number, payload: JournalEvent['payload']): JournalEvent => ({ sessionId: candidate.id, seq: seq as EventSeq, occurredAt: at, payload })
    if (name === 'stale Journal') await store.transaction(tx => tx.cache.recordWorkerHead(candidate.id, 1 as EventSeq))
    if (name === 'gapped Journal') await store.transaction(async tx => { await tx.cache.applyEvents(candidate.id, [event(2, { kind: 'session.runtime.changed', state: 'idle', reason: null })]); await tx.cache.recordWorkerHead(candidate.id, 2 as EventSeq) })
    if (name.includes('enqueue beyond window')) {
      const queued = await server.enqueue(candidate.id, { content: 'Unobserved independent enqueue' })
      if (name.startsWith('accepted')) await store.transaction(tx => tx.commands.recordReceipt({ commandId: queued.commandId, status: 'accepted' }, at))
      db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100001)
        INSERT INTO commands SELECT 'window-'||x,worker_id,'completed',
        json_set(data,'$.commandId','window-'||x,'$.command.sessionId','other'),
        json_set(projection,'$.commandId','window-'||x,'$.status','completed') FROM n CROSS JOIN commands WHERE id=?`).run(queued.commandId)
      assert.equal(db.prepare('SELECT count(*) AS n FROM commands WHERE rowid>(SELECT rowid FROM commands WHERE id=?)').get(queued.commandId)!.n, 100001)
    }
    if (name === 'independent queued message' || name === 'active Turn') {
      const events = [event(1, { kind: 'message.queued', commandId: 'independent' as CommandId, messageId: 'independent' as MessageId, content: 'Independent', position: 0 })]
      if (name === 'active Turn') events.push(event(2, { kind: 'turn.started', messageId: 'independent' as MessageId, turnId: 'turn' as TurnId }))
      await store.transaction(async tx => { await tx.cache.applyEvents(candidate.id, events); await tx.cache.recordWorkerHead(candidate.id, events.length as EventSeq) })
      assert.deepEqual(await store.commands.listUnsettledEnqueues(candidate.id), [])
    }
    const input = { requestId: 'reuse-rejection', mode: 'reuse', reuseSessionId: candidate.id, prompt: 'Same prompt', assignment }
    if (name === 'nonterminal linked Run' || name === 'unresolved accepted cancellation') {
      const { run } = await tasks.launch(task.projectId, task.id, { ...input, requestId: 'prior' }, context)
      // Settle enqueue visibility without queued/active Journal work, isolating
      // the linked nonterminal Run/cancel barrier from the idle predicates.
      await store.transaction(tx => tx.commands.recordReceipt({ commandId: run.enqueueCommandId as CommandId, status: 'rejected', error: { code: 'invalid-input', message: 'Not queued', retryable: false } }, at))
      if (name === 'unresolved accepted cancellation') {
        const cancelled = await tasks.cancelRun(task.projectId, task.id, run.id, { runId: run.id, sessionId: run.sessionId, requestId: 'cancel' }, context)
        await store.transaction(tx => tx.commands.recordReceipt({ commandId: cancelled.run.cancelCommandIds[0] as CommandId, status: 'accepted' }, at))
        assert.equal((await store.tasks.run(run.id))!.status, 'cancelling')
      }
    }
    const seen: string[] = []
    for (const id of [worker.id, candidate.binding.agent.workerId, 'unrelated-worker' as typeof worker.id]) signals.onCommands(id, () => { seen.push(`commands:${id}`) })
    for (const id of [eligible.id, candidate.id, 'unrelated-session' as SessionId]) signals.onSession(id, () => { seen.push(`session:${id}`) })
    for (const id of [task.projectId, candidate.projectId, 'unrelated-project']) signals.onProject(id, event => { seen.push(`project:${event.type}`) })
    const snapshot = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => ({ name: row.name, rows: db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all() }))
    const before = snapshot()
    if (code) {
      await assert.rejects(tasks.launch(task.projectId, task.id, input, context), (error: unknown) => {
        assert.ok(error instanceof TaskError)
        assert.equal(error.status, 409); assert.equal(error.code, code); assert.equal(error.message, message)
        return true
      })
      assert.deepEqual(snapshot(), before, 'all tables unchanged, including Runs, commands, dependencies, activity, audit, Sessions and freshness')
      assert.deepEqual(seen, [], 'no command, Session or project notification')
    } else {
      const result = await tasks.launch(task.projectId, task.id, input, context)
      assert.equal(result.run.sessionId, candidate.id)
      assert.equal(result.run.createCommandId, null)
      assert.equal(result.run.status, 'pending')
      assert.ok(seen.length > 0)
    }
  } finally { db.close(); store.close(); await rm(dir, { recursive: true, force: true }) }
})
