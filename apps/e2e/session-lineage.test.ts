import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWemuxServer } from '../server/src/server.js'
import { provisionAdministrator } from './session.js'

/**
 * Ticket 17 端到端：真实 Server + 真实 Worker CLI，走 HTTP 完成 Fork、幂等重试与血缘查询。
 * 关键断言是“Fork 是后端领域事实”：目标 Session 由服务端在事务里创建，来源事件不进入目标上下文。
 */
const administratorEmail = 'session-lineage-owner@example.com'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let latest: T | undefined
  for (let attempt = 0; attempt < 240; attempt += 1) {
    latest = await read()
    if (accept(latest)) return latest
    await delay(25)
  }
  assert.fail(`Timed out waiting for lineage state: ${JSON.stringify(latest)}`)
}

function workerProcess(args: string[]): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function completed(child: ChildProcess): Promise<{ stdout: string; stderr: string; code: number | null }> {
  let stdout = '', stderr = ''
  child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const code = await new Promise<number | null>(resolve => child.once('close', resolve))
  return { stdout, stderr, code }
}

interface EventPage {
  readonly events: readonly { readonly seq: number; readonly payload: { readonly kind: string; readonly text?: string } }[]
  readonly nextSeq?: number
  readonly freshness: { readonly status: string }
}

test('real Server and Worker fork a Session at a durable cursor and serve lineage without leaking context', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-lineage-'))
  const workerHome = join(directory, 'worker')
  const repository = join(directory, 'repository')
  const server = createWemuxServer({ databasePath: join(directory, 'server.sqlite'), administratorEmails: [administratorEmail] })
  const baseUrl = await server.listen(0)
  let worker: ChildProcess | undefined
  t.after(async () => {
    if (worker && worker.exitCode === null) {
      worker.kill('SIGTERM')
      await new Promise(resolve => worker!.once('close', resolve))
    }
    await server.close()
    await rm(directory, { recursive: true, force: true })
  })

  console.error('[e2e] provision administrator')
  const admission = await provisionAdministrator({ store: server.store, baseUrl })
  const api = admission.api
  // api() 把非 2xx 抛成无状态码的 Error，需要真实状态码的断言走这个包装。
  const postFork = async (projectId: string, body: Record<string, unknown>) => {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/session-forks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admission.cookie, 'X-CSRF-Token': admission.csrfToken },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  const gitInit = await completed(spawn('git', ['init', '--initial-branch=main', repository], { stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.equal(gitInit.code, 0, gitInit.stderr)
  const commit = await completed(spawn('git', ['-C', repository, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '--allow-empty', '-m', 'initial'], { stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.equal(commit.code, 0, commit.stderr)

  const enrollment = await api<{ token: string }>('/enrollment-tokens', 'POST', {})
  const registration = await completed(workerProcess(['register', '--home', workerHome, '--server', baseUrl, `--token=${enrollment.token}`, '--name', 'Lineage Worker']))
  assert.equal(registration.code, 0, registration.stderr)
  console.error('[e2e] register worker')
  const workerId = JSON.parse(registration.stdout).workerId as string
  const project = await api<{ id: string }>('/projects', 'POST', { name: 'Lineage Project' })
  const provision = await api<{ workspace: { id: string } }>('/workspaces', 'POST', {
    projectId: project.id,
    workerId,
    name: 'Lineage Workspace',
    repository: { gitUrl: repository, revision: 'main' },
  })
  console.error('[e2e] project and workspace created')
  const workspaceId = provision.workspace.id

  worker = workerProcess(['start', '--home', workerHome, '--name', 'Lineage Worker'])
  let workerStderr = ''
  worker.stderr?.setEncoding('utf8').on('data', chunk => { workerStderr += chunk })
  await eventually(() => api<{ status: string; placements?: { status?: string }[] }>(`/workspaces/${workspaceId}`), value => value.status === 'ready' || Boolean(value.placements?.some(placement => placement.status === 'ready')))
  console.error('[e2e] workspace ready, wait capabilities')
  await eventually(() => api<{ capabilities: { agentKey: string; mode: string }[] }>(`/workers/${workerId}/capabilities`), value => value.capabilities.some(capability => capability.agentKey === 'test' && capability.mode === 'execution'))

  console.error('[e2e] create source session')
  const created = await api<{ session: { id: string }; commandId: string }>('/sessions', 'POST', {
    requestId: 'e2e-lineage-source', workspaceId, title: 'Lineage Source', agentKey: 'test', modelId: 'test',
  })
  const sourceSessionId = created.session.id
  console.error('[e2e] source session created', sourceSessionId, created.commandId)
  await eventually(() => api<{ status: string }>(`/commands/${created.commandId}`), command => command.status === 'accepted')
  console.error('[e2e] create command accepted')
  console.error('[e2e] send seed message')
  const sent = await api<{ commandId: string }>(`/sessions/${sourceSessionId}/messages`, 'POST', { content: 'lineage seed' })
  const sourcePage = await eventually<EventPage>(
    () => api<EventPage>(`/sessions/${sourceSessionId}/events?fromSeq=1&limit=100`),
    page => page.freshness.status === 'synced' && page.events.some(event => event.payload.kind === 'turn.finished'),
  )
  assert.equal(sourcePage.events.filter(event => event.payload.kind === 'assistant.text.delta').map(event => event.payload.text).join(''), 'Echo: lineage seed')
  assert.equal(sent.commandId.length > 10, true)
  console.error('[e2e] durable cursor')
  const durableCursor = sourcePage.events.at(-1)!.seq

  const forkBody = {
    requestId: 'e2e-fork-1',
    sourceSessionId,
    sourceEventCursor: durableCursor,
    contextPolicy: 'through_cursor',
    targetWorkspaceId: workspaceId,
    targetWorkerId: workerId,
    targetAgentKey: 'test',
    targetModelId: 'test',
  }
  console.error('[e2e] fork session')
  const forked = await api<{ fork: { forkId: string; sourceSessionId: string; sourceEventCursor: number; targetSessionId: string }; targetSessionId: string; graphRevision: string; replayed: boolean }>(`/projects/${project.id}/session-forks`, 'POST', forkBody)
  assert.equal(forked.targetSessionId === sourceSessionId, false)
  assert.equal(forked.fork.sourceEventCursor, durableCursor)
  const replayed = await api<{ fork: { forkId: string }; targetSessionId: string }>(`/projects/${project.id}/session-forks`, 'POST', forkBody)
  assert.equal(replayed.fork.forkId, forked.fork.forkId)
  assert.equal(replayed.targetSessionId, forked.targetSessionId)
  const sessions = await api<{ items: { id: string }[] }>('/sessions')
  assert.equal(sessions.items.length, 2, '重试不得创建第二个目标 Session')

  console.error('[e2e] query lineage')
  const lineage = await api<{ ancestors: Record<string, unknown>[]; children: { forkId: string; targetSessionId: string; sourceEventCursor: number }[] }>(`/sessions/${sourceSessionId}/lineage`)
  assert.deepEqual(lineage.ancestors, [])
  assert.deepEqual(lineage.children.map(child => [child.forkId, child.targetSessionId, child.sourceEventCursor]), [[forked.fork.forkId, forked.targetSessionId, durableCursor]])
  // 血缘投影就是冻结的 SessionForkPoint：不允许多出字段（原生会话 id、contextPolicy 都不能出现在这里）。
  assert.deepEqual(Object.keys(lineage.children[0]!).sort(), ['forkId', 'sourceEventCursor', 'sourceSessionId', 'targetSessionId'])
  const targetLineage = await api<{ ancestors: { forkId: string }[] }>(`/sessions/${forked.targetSessionId}/lineage`)
  assert.deepEqual(targetLineage.ancestors.map(ancestor => ancestor.forkId), [forked.fork.forkId])
  const forkPoint = await api<{ fork: { forkId: string; sourceSessionId: string; targetSessionId: string; sourceEventCursor: number }; graphRevision: string }>(`/session-forks/${forked.fork.forkId}`)
  assert.equal(forkPoint.fork.sourceSessionId, sourceSessionId)
  assert.equal(forkPoint.graphRevision, forked.graphRevision)

  console.error('[e2e] query graph')
  const graph = await api<{ graph: { nodes: Record<string, unknown>[]; edges: { relation: { forkId: string } }[]; revision: string } }>(`/projects/${project.id}/session-graph?rootSessionId=${sourceSessionId}&depth=2`)
  assert.equal(graph.graph.nodes.length, 2)
  assert.deepEqual(graph.graph.edges.map(edge => edge.relation.forkId), [forked.fork.forkId])
  assert.equal(graph.graph.revision, forked.graphRevision)
  // 领域 DTO 不含画布布局或原生会话：React Flow 字段名与原生 session 引用都不得出现在响应里。
  const serialized = JSON.stringify(graph.graph)
  for (const forbidden of ['"position"', '"sourceHandle"', '"targetHandle"', '"type":"default"', 'nativeSessionId', 'providerSessionId', 'sessionRef']) assert.equal(serialized.includes(forbidden), false, `${forbidden} must not appear in the domain graph`)

  const targetPage = await api<EventPage>(`/sessions/${forked.targetSessionId}/events?fromSeq=1&limit=100`)
  assert.deepEqual(targetPage.events.filter(event => event.payload.kind === 'assistant.text.delta'), [], 'Fork 不复制来源事件：固定 cursor 只是边界，不是上下文搬运')

  const ahead = await postFork(project.id, { ...forkBody, requestId: 'e2e-fork-ahead', sourceEventCursor: durableCursor + 50 })
  assert.equal(ahead.status, 409, `cursor 超前必须冲突：${JSON.stringify(ahead.body)}`)
  const conflict = await postFork(project.id, { ...forkBody, targetModelId: 'other-model' })
  assert.equal(conflict.status, 409, '同 requestId 换载荷必须冲突')

  const anonymous = await fetch(`${baseUrl}/api/projects/${project.id}/session-forks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(forkBody) })
  assert.equal(anonymous.status, 401)
  for (const path of [`/api/sessions/${sourceSessionId}/lineage`, `/api/projects/${project.id}/session-graph`, `/api/session-forks/${forked.fork.forkId}`]) {
    assert.equal((await fetch(`${baseUrl}${path}`)).status, 401, `${path} without a session must be rejected`)
  }
  assert.equal(worker.exitCode, null, workerStderr)
})