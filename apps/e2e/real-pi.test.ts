import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWemuxServer } from '../server/src/server.js'
import { provisionAdministrator } from './session.js'

const administratorEmail = 'real-pi-owner@example.com'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let latest: T | undefined
  while (Date.now() < deadline) {
    latest = await read()
    if (accept(latest)) return latest
    await delay(100)
  }
  assert.fail(`Timed out waiting for real Pi E2E state: ${JSON.stringify(latest)}`)
}

function workerProcess(args: string[], captureStdout = false): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...args], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'],
  })
}

async function completed(child: ChildProcess) {
  let stdout = '', stderr = ''
  child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const code = await new Promise<number | null>(resolve => child.once('close', resolve))
  return { code, stdout, stderr }
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('close', resolve))
}

test('Server and Worker execute and resume a real Pi session', { timeout: 240_000 }, async t => {
  if (process.env.WEMUX_REAL_AGENT_E2E !== '1') {
    t.skip('set WEMUX_REAL_AGENT_E2E=1 to run the paid/network full-stack Pi test')
    return
  }

  const directory = await mkdtemp(join(tmpdir(), 'wemux-real-pi-'))
  const workerHome = join(directory, 'worker')
  const localRepository = join(directory, 'repository')
  const server = createWemuxServer({ databasePath: join(directory, 'server.sqlite'), administratorEmails: [administratorEmail] })
  const baseUrl = await server.listen(0)
  let worker: ChildProcess | undefined
  let workerStderr = ''
  t.after(async () => {
    await stop(worker)
    await server.close()
    await rm(directory, { recursive: true, force: true })
  })

  const api = (await provisionAdministrator({ store: server.store, baseUrl })).api

  let repository = process.env.WEMUX_E2E_GIT_URL
  let revision = process.env.WEMUX_E2E_GIT_REVISION
  if (!repository) {
    const git = await completed(spawn('git', ['init', '--initial-branch=main', localRepository], { stdio: ['ignore', 'ignore', 'pipe'] }))
    assert.equal(git.code, 0, git.stderr)
    const commit = await completed(spawn('git', ['-C', localRepository, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '--allow-empty', '-m', 'initial'], { stdio: ['ignore', 'ignore', 'pipe'] }))
    assert.equal(commit.code, 0, commit.stderr)
    repository = localRepository
    revision = 'main'
  } else {
    assert.ok(revision, 'WEMUX_E2E_GIT_REVISION is required for an external repository')
  }

  const enrollment = await api('/enrollment-tokens', 'POST', {})
  const registered = await completed(workerProcess(['register', '--home', workerHome, '--server', baseUrl, `--token=${enrollment.token}`, '--name', 'Real Pi Worker'], true))
  assert.equal(registered.code, 0, registered.stderr)
  const workerId = JSON.parse(registered.stdout).workerId as string

  const project = await api('/projects', 'POST', { name: 'Real Pi E2E' })
  const provision = await api('/workspaces', 'POST', {
    projectId: project.id,
    workerId,
    name: 'Real Pi Workspace',
    repository: { gitUrl: repository, revision },
  })

  const startWorker = () => {
    const child = workerProcess(['start', '--home', workerHome, '--name', 'Real Pi Worker'])
    child.stderr?.setEncoding('utf8').on('data', chunk => { workerStderr += chunk })
    return child
  }
  worker = startWorker()

  await eventually(() => api(`/workspaces/${provision.workspace.id}`), value => value.status === 'ready')
  const capabilityPage = await eventually(
    () => api(`/workers/${workerId}/capabilities`),
    value => value.capabilities.some((capability: any) => capability.agentKey === 'pi' && capability.availability.status === 'available' && capability.models.length),
    60_000,
  )
  const pi = capabilityPage.capabilities.find((capability: any) => capability.agentKey === 'pi')
  const requestedModel = process.env.WEMUX_REAL_PI_MODEL
  const selectedModel = requestedModel
    ? pi.models.find((model: any) => model.modelId === requestedModel)
    : pi.models[0]
  assert.ok(selectedModel, `Pi model ${requestedModel ?? '(first available)'} was not detected`)
  // Opt-in second model uses the same two paid Turns already present in this test.
  // Never infer a second model from a list alone when validating successful switching.
  const nextModelId = process.env.WEMUX_REAL_PI_NEXT_MODEL
  if (nextModelId) {
    assert.notEqual(nextModelId, selectedModel.modelId, 'model switch requires two distinct models')
    assert.ok(pi.modelSwap && pi.models.some((model: any) => model.modelId === nextModelId), `Pi cannot switch to ${nextModelId}`)
  }

  const created = await api('/sessions', 'POST', {
    workspaceId: provision.workspace.id,
    title: 'Real Pi Session',
    agentKey: 'pi',
    modelId: selectedModel.modelId,
    requestId: 'real-pi-create-session',
  })
  await eventually(() => api(`/commands/${created.commandId}`), value => value.status === 'accepted')

  const first = await api(`/sessions/${created.session.id}/messages`, 'POST', {
    content: 'Reply with exactly WEMUX_REAL_PI_1. Do not use tools.',
  })
  await eventually(() => api(`/commands/${first.commandId}`), value => value.status === 'accepted')
  const firstPage = await eventually(
    () => api(`/sessions/${created.session.id}/events?fromSeq=1&limit=1000`),
    value => value.events.some((event: any) => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed'),
    120_000,
  )
  const firstText = firstPage.events.filter((event: any) => event.payload.kind === 'assistant.text.delta').map((event: any) => event.payload.text).join('')
  assert.match(firstText, /WEMUX_REAL_PI_1/)

  await stop(worker)
  worker = undefined
  await eventually(() => api('/workers'), value => value.items.some((item: any) => item.id === workerId && item.connectionState === 'offline'))

  worker = startWorker()
  await eventually(() => api('/workers'), value => value.items.some((item: any) => item.id === workerId && item.connectionState === 'online'), 60_000)

  if (nextModelId) {
    const selection = await api(`/sessions/${created.session.id}/runtime/commands`, 'POST', {
      commandId: 'real-pi-switch-model', name: 'set_model', arguments: { modelId: nextModelId },
    })
    await eventually(() => api(`/commands/${selection.commandId}`), value => value.status === 'accepted')
    await eventually(() => api(`/sessions/${created.session.id}/events?fromSeq=1&limit=1000`),
      value => value.events.some((event: any) => event.payload.kind === 'model.changed' && event.payload.modelId === nextModelId))
  }

  const second = await api(`/sessions/${created.session.id}/messages`, 'POST', {
    content: 'Reply with exactly WEMUX_REAL_PI_2. Do not use tools.',
  })
  await eventually(() => api(`/commands/${second.commandId}`), value => value.status === 'accepted')
  const nextSeq = firstPage.nextSeq ?? firstPage.events.at(-1).seq + 1
  const secondPage = await eventually(
    () => api(`/sessions/${created.session.id}/events?fromSeq=${nextSeq}&limit=1000`),
    value => value.freshness.status === 'synced' && value.events.some((event: any) => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed'),
    120_000,
  )
  const secondText = secondPage.events.filter((event: any) => event.payload.kind === 'assistant.text.delta').map((event: any) => event.payload.text).join('')
  assert.match(secondText, /WEMUX_REAL_PI_2/)
  assert.equal(secondPage.freshness.status, 'synced')
  if (nextModelId) {
    const timeline = (await api(`/sessions/${created.session.id}/events?fromSeq=1&limit=1000`)).events
    assert.deepEqual(timeline.filter((event: any) => event.payload.kind === 'turn.started').map((event: any) => event.payload.modelId), [selectedModel.modelId, nextModelId], 'first Turn snapshot stays immutable; subsequent Turn uses selected model')
    assert.equal(timeline.filter((event: any) => event.payload.kind === 'model.changed' && event.payload.modelId === nextModelId).length, 1)
    assert.equal((await api(`/sessions/${created.session.id}`)).binding.modelId, nextModelId)
  }
  assert.doesNotMatch(workerStderr, /(?:^|\n)(?:Error:|\[error\]|\[fatal\]|\[runtime-error\])/i, 'Worker reported an error')
})
