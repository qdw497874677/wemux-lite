import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWemuxServer } from '../server/src/server.js'

const bootstrapToken = 'full-stack-bootstrap-token-12345'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let latest: T | undefined
  for (let attempt = 0; attempt < 200; attempt += 1) {
    latest = await read()
    if (accept(latest)) return latest
    await delay(25)
  }
  assert.fail(`Timed out waiting for full-stack state: ${JSON.stringify(latest)}`)
}

function workerProcess(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
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

test('real Server and Worker CLI complete the project-to-agent conversation loop', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-full-stack-'))
  const workerHome = join(directory, 'worker')
  const repository = join(directory, 'repository')
  const server = createWemuxServer({ databasePath: join(directory, 'server.sqlite'), bootstrapToken })
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

  async function api(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${bootstrapToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = response.status === 204 ? null : await response.json()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`)
    return data as any
  }

  console.error('[e2e] init repository')
  const gitInit = await completed(spawn('git', ['init', '--initial-branch=main', repository], { stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.equal(gitInit.code, 0, gitInit.stderr)
  const commit = await completed(spawn('git', ['-C', repository, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '--allow-empty', '-m', 'initial'], { stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.equal(commit.code, 0, commit.stderr)
  console.error('[e2e] bootstrap and register')
  await api('/bootstrap', 'POST', {})
  const enrollment = await api('/enrollment-tokens', 'POST', {})
  const registration = await completed(workerProcess(['register', '--home', workerHome, '--server', baseUrl, `--token=${enrollment.token}`, '--name', 'E2E Worker'], {}))
  assert.equal(registration.code, 0, registration.stderr)

  console.error('[e2e] create project and workspace')
  const project = await api('/projects', 'POST', { name: 'E2E Project' })
  const provision = await api('/workspaces', 'POST', {
    projectId: project.id,
    workerId: JSON.parse(registration.stdout).workerId,
    name: 'E2E Workspace',
    repository: { gitUrl: repository, revision: 'main' },
  })

  console.error('[e2e] start worker')
  worker = workerProcess(['start', '--home', workerHome, '--name', 'E2E Worker'], {})
  let workerStderr = ''
  worker.stderr?.setEncoding('utf8').on('data', chunk => { workerStderr += chunk })

  console.error('[e2e] wait workspace ready')
  await eventually(
    () => api(`/workspaces/${provision.workspace.id}`),
    workspace => workspace.status === 'ready'
      || workspace.placements?.some((placement: { status?: string }) => placement.status === 'ready'),
  )
  const capabilities = await eventually(
    () => api(`/workers/${JSON.parse(registration.stdout).workerId}/capabilities`),
    value => value.capabilities.some((capability: { agentKey: string; mode: string }) => capability.agentKey === 'test' && capability.mode === 'execution'),
  )
  assert.ok(capabilities.capabilities.some((capability: { agentKey: string }) => capability.agentKey === 'test'))

  console.error('[e2e] create session and send')
  const created = await api('/sessions', 'POST', {
    requestId: 'e2e-session-create',
    workspaceId: provision.workspace.id,
    title: 'E2E Session',
    agentKey: 'test',
    modelId: 'test',
  })
  await eventually(
    () => api(`/commands/${created.commandId}`),
    command => command.status === 'accepted',
  )
  const sent = await api(`/sessions/${created.session.id}/messages`, 'POST', { content: 'hello full stack' })
  assert.equal(sent.status === 'pending' || sent.status === 'accepted', true)
  await eventually(
    () => api(`/commands/${sent.commandId}`),
    command => command.status === 'accepted' || command.status === 'completed',
    12_000,
  )
  console.error('[e2e] wait journal')
  const page = await eventually(
    () => api(`/sessions/${created.session.id}/events?fromSeq=1&limit=100`),
    value => value.freshness.status === 'synced' && value.events.some((event: { payload: { kind: string; outcome?: string } }) => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed'),
  )
  const assistantText = page.events
    .filter((event: { payload: { kind: string } }) => event.payload.kind === 'assistant.text.delta')
    .map((event: { payload: { text: string } }) => event.payload.text)
    .join('')
  assert.equal(assistantText, 'Echo: hello full stack')
  assert.equal(page.freshness.status, 'synced')

  const whitespaceSent = await api(`/sessions/${created.session.id}/messages`, 'POST', { content: '12345678        x' })
  await eventually(() => api(`/commands/${whitespaceSent.commandId}`), command => command.status === 'accepted')
  const whitespacePage = await eventually(
    () => api(`/sessions/${created.session.id}/events?fromSeq=${page.nextSeq ?? page.events.at(-1).seq + 1}&limit=100`),
    value => value.events.some((event: { payload: { kind: string; messageId?: string } }) => event.payload.kind === 'message.queued' && event.payload.messageId === whitespaceSent.messageId)
      && value.events.some((event: { payload: { kind: string; outcome?: string } }) => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed'),
  )
  assert.equal(whitespacePage.events.filter((event: { payload: { kind: string; turnId?: string } }) => event.payload.kind === 'assistant.text.delta').map((event: { payload: { text: string } }) => event.payload.text).join(''), 'Echo: 12345678        x')

  console.error('[e2e] stop worker')
  worker.kill('SIGTERM')
  await new Promise(resolve => worker!.once('close', resolve))
  assert.equal(worker.exitCode, 0, workerStderr)
  assert.equal((await readFile(join(workerHome, 'credential'), 'utf8')).length > 10, true)
  const workerRecord = await eventually(
    () => api('/workers'),
    value => value.items.some((item: { connectionState: string }) => item.connectionState === 'offline'),
  )
  assert.equal(workerRecord.items[0].connectionState, 'offline')
})
