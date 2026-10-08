import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { findSafeTestAgentTarget } from './legacy-test-target.mjs'

const project = { id: 'project/one' }
const worker = (id, connectionState = 'online') => ({ id, connectionState })
const workspace = (placements, extra = {}) => ({ id: 'workspace', projectId: project.id, placements, ...extra })
const capability = (status = 'available', models = [{ modelId: 'echo' }]) => ({ agentKey: 'test', mode: 'execution', availability: { status }, models })

function publicApi(workspaces, workers, capabilities) {
  const calls = []
  return {
    calls,
    request: async path => {
      calls.push(path)
      if (path === '/api/workspaces?projectId=project%2Fone') return { items: workspaces }
      if (path === '/api/projects/project%2Fone/tasks') return { items: [] }
      if (path.startsWith('/api/workers/') && path.endsWith('/capabilities')) {
        return { capabilities: capabilities[path.split('/')[3]] ?? [] }
      }
      throw Error(`unexpected public API route: ${path}`)
    },
    workers,
  }
}

test('selects ready placement on online Worker with advertised executable Test Agent and model via public Workspace route', async () => {
  const api = publicApi([
    workspace([{ workerId: 'offline', status: 'ready' }, { workerId: 'ready', status: 'ready' }], { workerId: 'legacy', status: 'failed' }),
  ], [worker('offline', 'offline'), worker('legacy'), worker('ready')], { ready: [capability()] })
  const result = await findSafeTestAgentTarget({ projects: [project], ...api })
  assert.equal(result.selection.worker.id, 'ready')
  assert.equal(result.selection.agent.models[0].modelId, 'echo')
  assert.deepEqual(api.calls, ['/api/workspaces?projectId=project%2Fone', '/api/projects/project%2Fone/tasks', '/api/workers/ready/capabilities'])
})

test('fails closed for stale legacy ready fields, missing matching placement, offline Worker or unavailable Test Agent/model', async () => {
  for (const [placements, workers, capabilities] of [
    [[{ workerId: 'ready', status: 'provisioning' }], [worker('ready')], { ready: [capability()] }],
    [[{ workerId: 'ready', status: 'ready' }], [worker('ready', 'offline')], { ready: [capability()] }],
    [[{ workerId: 'ready', status: 'ready' }], [worker('ready')], { ready: [capability('unavailable')] }],
    [[{ workerId: 'ready', status: 'ready' }], [worker('ready')], { ready: [capability('available', [])] }],
    [[{ workerId: 'ready', status: 'ready' }], [worker('ready')], { ready: [{ ...capability(), mode: 'detect-only' }] }],
    [[{ workerId: 'unknown', status: 'ready' }], [worker('ready')], { ready: [capability()] }],
  ]) {
    const api = publicApi([workspace(placements, { workerId: 'ready', status: 'ready' })], workers, capabilities)
    const result = await findSafeTestAgentTarget({ projects: [project], ...api })
    assert.equal(result.selection, undefined)
    assert.equal(api.calls[0], '/api/workspaces?projectId=project%2Fone')
  }
})

test('legacy browser regression uses the tested public-API target gate before Task creation', async () => {
  const source = await readFile(new URL('./real-legacy-regression.mjs', import.meta.url), 'utf8')
  assert.match(source, /const \{ selection, safeTargets \} = await findSafeTestAgentTarget\(\{ projects, workers, request \}\)/)
  const writeGate = source.indexOf("if (!mobile && process.env.WEMUX_LEGACY_TEST_WRITE === '1')")
  const preflight = source.indexOf('findSafeTestAgentTarget({ projects, workers, request })')
  const createBind = source.indexOf('await createRetainedTestTask(')
  assert.ok(writeGate >= 0 && writeGate < preflight && preflight < createBind)
  assert.ok(createBind < source.indexOf('/assignment`, \'PUT\''))
  assert.match(source, /return readLegacyPublicResponse\(response\)/)
  assert.match(source, /retained-private\.json'.*JSON\.stringify\(record\).*mode: 0o600/)
  assert.doesNotMatch(source, /\/api\/projects\/\$\{project\.id\}\/workspaces/)
})

test('does not use foreign or deleted Workspaces or another Agent capability as a write target', async () => {
  const api = publicApi([
    workspace([{ workerId: 'ready', status: 'ready' }], { projectId: 'other' }),
    workspace([{ workerId: 'ready', status: 'ready' }], { deletedAt: '2026-01-01' }),
    workspace([{ workerId: 'ready', status: 'ready' }]),
  ], [worker('ready')], { ready: [{ ...capability(), agentKey: 'pi' }] })
  assert.equal((await findSafeTestAgentTarget({ projects: [project], ...api })).selection, undefined)
  assert.deepEqual(api.calls, ['/api/workspaces?projectId=project%2Fone', '/api/projects/project%2Fone/tasks', '/api/workers/ready/capabilities'])
})
