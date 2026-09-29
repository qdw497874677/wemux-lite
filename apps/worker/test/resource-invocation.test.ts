import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentKey, CommandId, ProjectId, ResourceSetSnapshot, SessionId, Turn, WorkerId, WorkspaceId } from '@wemux/domain'
import type { RuntimeOperationInput, RuntimeSessionAdapter } from '../src/application/ports/runtime-session.js'
import { TestAgent } from '../src/agents/test-agent.ts'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.ts'
import { WorkerRuntime } from '../src/application/runtime.ts'
import { FilesystemAgentLaunchContextProvider } from '../src/application/agent-launch-context-provider.ts'
import { ResourceReconciler } from '../src/resources/resource-reconciler.ts'

const hash = (content: string) => createHash('sha256').update(content).digest('hex')
const workerId = 'invocation-worker' as WorkerId
const projectId = 'invocation-project' as ProjectId
const agentKey = 'test' as AgentKey
const workspaceId = 'invocation-workspace' as WorkspaceId
const sessionId = 'invocation-session' as SessionId
const content = '# Invocation fixture skill'
const snapshot: ResourceSetSnapshot = {
  workerId, revision: 1, fingerprint: hash('set-1'), createdAt: '2026-01-01T00:00:00.000Z' as never,
  bindings: [{ bindingId: 'binding-1', bindingRevision: 1, resourceId: 'skill-1', resourceRevisionId: 'revision-1', kind: 'skill', projectId, agentKey,
    contentSha256: hash('manifest-1'), files: [{ path: 'SKILL.md', size: Buffer.byteLength(content), mediaType: 'text/markdown', sha256: hash(content), blobSha256: hash(content) }] }],
}

async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Invocation was not completed')
}

test('真实 WorkerRuntime 的 Invocation 固定已授权 Skill，撤权后新调用不注入', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-resource-invocation-'))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  let reconciler!: ResourceReconciler
  const resources = { send: async (message: import('@wemux/wire-protocol').WorkerPayload) => {
    if (message.type === 'resource.blob.fetch') queueMicrotask(() => reconciler.receive({ type: 'resource.blob.fetch', action: 'response', requestId: message.requestId, sha256: message.sha256, mediaType: 'text/markdown', size: Buffer.byteLength(content), base64Content: Buffer.from(content).toString('base64') }))
  } }
  reconciler = new ResourceReconciler({ workerId, home, databasePath: join(home, 'resources.sqlite'), transport: resources })
  const observed: Array<string | null> = []
  const adapter: RuntimeSessionAdapter = { async openSession() { return {
    async execute(input: RuntimeOperationInput) {
      observed.push(input.launchContext?.skillsRoot ? await readFile(join(input.launchContext.skillsRoot, 'skill-1', 'SKILL.md'), 'utf8') : null)
      return { signals: (async function* () { yield { kind: 'finished' as const, outcome: { status: 'completed' as const } } })(), stop: async () => {} }
    }, async command() {}, async resolveApproval() {}, async close() {},
  } } }
  const provider = new FilesystemAgentLaunchContextProvider(home, null, undefined, (project, agent) => reconciler.skillsForLaunch(project, agent), async (turn: Turn) => {
    const session = await store.sessions.get(turn.sessionId)
    const workspace = session ? await store.workspaces.get(session.binding.workspaceId) : null
    return session && workspace ? { projectId: workspace.projectId, agentKey: session.binding.agent.agentKey } : null
  })
  const runtime = new WorkerRuntime(store, { async provision() { return { rootPath: home, checkouts: [] } } }, [new TestAgent()], { send() {} }, workerId, 'invocation-worker', provider, undefined, new Map([[agentKey, adapter]]))
  try {
    await store.transaction(async tx => {
      await tx.workspaces.save({ id: workspaceId, workerId, projectId, name: 'fixture', spec: { kind: 'composite', memberWorkspaceIds: [] }, rootPath: home, status: 'ready', failureReason: null, updatedAt: new Date().toISOString() as never })
      await tx.sessions.createSession(sessionId, { workspaceId, agent: { workerId, agentKey }, modelId: 'test' as never })
    })
    await reconciler.reconcile(snapshot)
    await runtime.initialize()
    const invoke = async (index: number) => {
      const commandId = `invoke-${index}` as CommandId
      await runtime.receive({ type: 'command', commandId, command: { kind: 'session.enqueue', sessionId, message: { messageId: `message-${index}` as never, content: `step ${index}` }, capabilities: { snapshot: { id: `snapshot-${index}`, sessionId, projectId, workspaceId, version: 1, assets: [], allowedTools: [], allowedConnectorIds: [], createdAt: new Date().toISOString() as never }, token: 'test-token', grant: { turnId: `turn-${index}` as never } } as never } })
      await until(async () => observed.length >= index && (await store.sessions.get(sessionId))?.runtimeState === 'idle')
    }
    await invoke(1)
    assert.deepEqual(observed, [content])
    await reconciler.reconcile({ ...snapshot, revision: 2, fingerprint: hash('revoked'), bindings: [] })
    await invoke(2)
    assert.deepEqual(observed, [content, null])
  } finally { await runtime.shutdown(); await reconciler.close(); store.close(); await rm(home, { recursive: true, force: true }) }
})
