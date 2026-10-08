import test from 'node:test'
import assert from 'node:assert/strict'
import { adminRouteFixture } from './fixtures/admin-route-fixture.ts'

test('ordinary Task metadata validation, defaults, size, CAS and permissions retain the existing contract', async () => {
  const f = await adminRouteFixture()
  try {
    const base = `/projects/${f.project.id}/tasks`, path = `${base}/${f.task.id}`
    assert.deepEqual(f.task.metadataJson, { schemaVersion: 1, values: {} })
    const before = (await f.request(path)).data
    const invalid = [null, [], '', {}, { schemaVersion: 2, values: {} }, { schemaVersion: 1 }, { schemaVersion: 1, values: [] }, { schemaVersion: 1, values: null }, { schemaVersion: 1, values: {}, extra: true }, { schemaVersion: 1, values: { text: 'x'.repeat(16000) } }]
    for (const metadataJson of invalid) {
      assert.equal((await f.request(base, { body: { title: 'Invalid metadata', metadataJson } })).status, 400)
      assert.equal((await f.request(path, { method: 'PATCH', body: { metadataJson, version: before.version } })).status, 400)
      assert.deepEqual((await f.request(path)).data, before)
    }
    assert.equal((await f.request(base)).data.items.length, 1)
    const metadataJson = JSON.parse('{"schemaVersion":1,"values":{"__proto__":{"retained":true},"unknown":[null,"",{},[],false],"nested":{"a":1,"b":2}}}')
    const created = await f.request(base, { body: { title: 'Metadata', metadataJson } })
    assert.equal(created.status, 201); assert.deepEqual(created.data.metadataJson, metadataJson)
    const saved = await f.request(path, { method: 'PATCH', body: { metadataJson, version: before.version } })
    assert.equal(saved.status, 200); assert.deepEqual(saved.data.metadataJson, metadataJson)
    assert.equal(saved.data.acceptanceCriteria, null)
    assert.equal((await f.request(path, { method: 'PATCH', body: { metadataJson, version: before.version } })).status, 409)
    const noOp = await f.request(path, { method: 'PATCH', body: { metadataJson: { values: { ...metadataJson.values, nested: { b: 2, a: 1 } }, schemaVersion: 1 }, version: saved.data.version } })
    assert.equal(noOp.data.version, saved.data.version)
    const minimal = { schemaVersion: 1, values: { text: '' } }
    const boundary = { schemaVersion: 1, values: { text: 'x'.repeat(16000 - JSON.stringify(minimal).length) } }
    assert.equal((await f.request(base, { body: { title: 'Boundary', metadataJson: boundary } })).status, 201)
    const beforeForbidden = (await f.request(path)).data
    await f.request(`/projects/${f.project.id}/grants`, { body: { userId: f.accounts.member.id, role: 'viewer' } })
    for (const method of ['POST', 'PATCH']) assert.equal((await f.request(method === 'POST' ? base : path, { token: f.accounts.member.token, method, body: { title: 'Forbidden', metadataJson, ...(method === 'PATCH' ? { version: saved.data.version } : {}) } })).status, 403)
    assert.equal((await f.request(path, { token: null, method: 'PATCH', body: { metadataJson } })).status, 401)
    assert.deepEqual((await f.request(path)).data, beforeForbidden)
  } finally { await f.close() }
})
