import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient, describeResourceWriteError, isResourceWriteConflict } from '@wemux/web-client'

const inventory = {
  generatedAt: '2026-05-01T00:00:00.000Z',
  workers: [], agents: [], models: [], skills: [], presets: [], providers: [],
}

const session = { teamId: 'team-scope', username: 'administrator', csrfToken: 'csrf', email: null, instanceAdministrator: true }

function recordingClient(reply = () => Response.json({ items: [] })) {
  const calls = []
  const client = createClusterClient(session, () => {}, {
    origin: 'http://private.test',
    fetcher: async (url, init) => {
      calls.push({ path: new URL(url).pathname, query: new URL(url).search, method: init.method, body: init.body, csrf: init.headers['X-CSRF-Token'], credentials: init.credentials })
      return reply(new URL(url), init)
    },
  })
  return { client, calls }
}

test('resource inventory is a single administrator read with credentials, scope and abort signal', async () => {
  const calls = []
  const client = createClusterClient(
    { teamId: 'team-scope', username: 'administrator', csrfToken: 'csrf', email: null, instanceAdministrator: true },
    () => {},
    { origin: 'http://private.test', fetcher: async (url, init) => { calls.push({ url: new URL(url), ...init }); return Response.json(inventory) } },
  )
  const controller = new AbortController()
  const result = await client.resourceInventory(controller.signal)
  assert.deepEqual(result, inventory)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url.pathname, '/api/resource-inventory')
  assert.equal(calls[0].url.search, '?teamId=team-scope')
  assert.equal(calls[0].url.searchParams.get('teamId'), 'team-scope')
  assert.equal(calls[0].signal.aborted, false)
  controller.abort()
  assert.equal(calls[0].signal.aborted, true)
  client.dispose()
})

test('management writes are audited API calls with CSRF and no bypass route', async () => {
  const { client, calls } = recordingClient()
  const revision = { id: 'rev-1', resourceId: 'res-1', kind: 'skill', version: 1 }

  await client.createResource({ id: 'res-1', kind: 'skill', name: '技能', description: '', definition: {} })
  await client.updateResource({ id: 'res-1', kind: 'skill', name: '技能', description: '', definition: {} })
  await client.putResourceBlob('a'.repeat(64), 'YmFzZTY0')
  await client.publishResourceRevision('res-1', revision)
  await client.publishProviderRevision('res-1', { expectedVersion: 2, revision })
  await client.createResourceBinding({ id: 'bind-1', workerId: 'worker-1', resourceRevisionId: 'rev-1' })
  await client.revokeResourceBinding('bind-1', 3)
  await client.createResourcePreset({ id: 'preset-1', name: '预设', description: '', entries: [], expectedRevision: 0 })
  await client.applyResourcePreset('preset-1', { presetRevision: 1, workerId: 'worker-1', requestId: 'request-1', expectedSetRevision: 0 })
  await client.deleteResource('res-1')
  client.dispose()

  assert.deepEqual(calls.map(call => [call.method, call.path]), [
    ['POST', '/api/resources'],
    ['PATCH', '/api/resources/res-1'],
    ['PUT', `/api/resource-blobs/${'a'.repeat(64)}`],
    ['POST', '/api/resources/res-1/revisions'],
    ['POST', '/api/resources/res-1/provider-revisions'],
    ['POST', '/api/resource-bindings'],
    ['PATCH', '/api/resource-bindings/bind-1'],
    ['POST', '/api/resource-presets'],
    ['POST', '/api/resource-presets/preset-1/applications'],
    ['DELETE', '/api/resources/res-1'],
  ])
  for (const call of calls) {
    assert.equal(call.credentials, 'same-origin')
    assert.equal(call.csrf, 'csrf', `${call.method} ${call.path} 必须携带 CSRF`)
    assert.equal(call.query, '?teamId=team-scope')
    assert.match(call.path, /^\/api\//)
  }
  // 撤销是状态迁移，不是物理删除；应用预设必须带 requestId 幂等键。
  assert.deepEqual(JSON.parse(calls[6].body), { status: 'pending-gc', expectedRevision: 3 })
  assert.deepEqual(JSON.parse(calls[8].body), { presetRevision: 1, workerId: 'worker-1', requestId: 'request-1', expectedSetRevision: 0 })
  assert.deepEqual(JSON.parse(calls[4].body), { expectedVersion: 2, revision })
})

test('binding and set reads keep worker scope in the query string', async () => {
  const { client, calls } = recordingClient()
  await client.resourceBindings('worker-1')
  await client.resourceSet('worker-1')
  await client.resourceDetail('res-1')
  client.dispose()
  assert.deepEqual(calls.map(call => [call.method ?? 'GET', call.path, call.query]), [
    ['GET', '/api/resource-bindings', '?workerId=worker-1&teamId=team-scope'],
    ['GET', '/api/workers/worker-1/resource-set', '?teamId=team-scope'],
    ['GET', '/api/resources/res-1', '?teamId=team-scope'],
  ])
})

test('conflicts ask for a refresh and validation failures name the concrete reason', async () => {
  const conflict = () => Response.json({ error: { code: 'preset_revision_conflict', message: 'Preset or Worker resources have changed; refresh and retry' } }, { status: 409 })
  const invalid = () => Response.json({ error: { code: 'invalid_provider_config', message: 'Invalid model provider configuration' } }, { status: 400 })
  const conflictClient = recordingClient(conflict)
  const invalidClient = recordingClient(invalid)

  const conflictError = await conflictClient.client.createResourcePreset({ name: '预设', description: '', entries: [], expectedRevision: 0 }).then(() => null, cause => cause)
  assert.equal(isResourceWriteConflict(conflictError), true)
  assert.equal(describeResourceWriteError(conflictError), '资源状态已被其他操作改变，请刷新后重试。')

  const invalidError = await invalidClient.client.createResource({ id: 'provider-1', kind: 'model-provider', name: 'Provider', description: '', definition: {} }).then(() => null, cause => cause)
  assert.equal(isResourceWriteConflict(invalidError), false)
  assert.match(describeResourceWriteError(invalidError), /HTTPS/)
  assert.match(describeResourceWriteError(invalidError), /invalid_provider_config/)

  assert.equal(describeResourceWriteError(new Error('网络中断')), '网络中断')
  assert.equal(describeResourceWriteError(undefined), '资源写入失败，请重试。')
  conflictClient.client.dispose()
  invalidClient.client.dispose()
})
