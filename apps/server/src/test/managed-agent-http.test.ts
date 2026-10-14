import test from 'node:test'
import assert from 'node:assert/strict'
import { agentRuntimeCatalog } from '@wemux/domain'
import { adminRouteFixture } from './fixtures/admin-route-fixture.ts'

/**
 * 托管 Agent 安装的管理面契约：固定版本目录只来自 @wemux/domain，下发是幂等的，
 * 且必须由管理员显式确认。公开下载面（/downloads/*）与 /api 面读同一份目录。
 */
test('managed agent catalog comes from the shared pinned catalog and is admin-only', async () => {
  const f = await adminRouteFixture()
  try {
    const member = await f.login('member')
    assert.equal((await f.request('/managed-agent-catalog', { token: null })).status, 401)
    assert.equal((await f.request('/managed-agent-catalog', { ...member })).status, 403)
    const response = await f.request('/managed-agent-catalog')
    assert.equal(response.status, 200)
    assert.equal(response.data.schemaVersion, 1)
    assert.equal(response.data.registryOrigin, 'https://registry.npmjs.org')
    assert.equal(response.data.installerPath, '/downloads/install-agent.sh')
    assert.equal(response.data.manifestPath, '/downloads/agent-manifest.json')
    assert.deepEqual(response.data.agents.map((entry: { key: string }) => entry.key), Object.keys(agentRuntimeCatalog))
    for (const entry of response.data.agents) {
      const pinned = agentRuntimeCatalog[entry.key as keyof typeof agentRuntimeCatalog]
      assert.equal(entry.packageName, pinned.name)
      assert.equal(entry.packageVersion, pinned.version)
      assert.equal(entry.packageIntegrity, pinned.integrity)
      assert.equal(entry.bin, pinned.bin)
    }
  } finally { await f.close() }
})

test('public agent downloads serve the same catalog and refuse other paths', async () => {
  const f = await adminRouteFixture()
  try {
    const manifest = await fetch(`${f.origin}/downloads/agent-manifest.json`)
    assert.equal(manifest.status, 200)
    assert.equal(manifest.headers.get('cache-control'), 'no-store')
    assert.equal(manifest.headers.get('x-content-type-options'), 'nosniff')
    const body = await manifest.json()
    assert.equal(body.schemaVersion, 1)
    assert.deepEqual(body.agents.map((entry: { key: string }) => entry.key), Object.keys(agentRuntimeCatalog))
    const script = await fetch(`${f.origin}/downloads/install-agent.sh`)
    assert.equal(script.status, 200)
    assert.equal(script.headers.get('content-type'), 'text/x-shellscript; charset=utf-8')
    assert.equal(script.headers.get('cache-control'), 'no-store')
    const text = await script.text()
    assert.ok(text.startsWith('#!/bin/sh'))
    assert.ok(text.includes('WEMUX_AGENT_KEY'))
    assert.ok(text.includes('WEMUX_WORKER_HOME'))
    for (const pinned of Object.values(agentRuntimeCatalog)) assert.ok(text.includes(pinned.integrity), `${pinned.name} integrity missing from served script`)
    assert.equal((await fetch(`${f.origin}/downloads/install-agent.sh/extra`)).status, 404)
  } finally { await f.close() }
})

test('managed agent install is explicit, idempotent and pinned to the shared catalog', async () => {
  const f = await adminRouteFixture()
  try {
    const member = await f.login('member')
    assert.equal((await f.request('/managed-agent-installs', { token: null, body: { workerId: f.worker.workerId, agentKey: 'pi' } })).status, 401)
    assert.equal((await f.request('/managed-agent-installs', { ...member, body: { workerId: f.worker.workerId, agentKey: 'pi' } })).status, 403)
    // 非管理员被拒绝时不产生任何资源或绑定。
    assert.deepEqual((await f.request(`/resource-bindings?workerId=${f.worker.workerId}`)).data.items, [])
    assert.equal((await f.request('/resources')).data.items.length, 0)

    assert.equal((await f.request('/managed-agent-installs', { body: { workerId: 'unknown-worker', agentKey: 'pi' } })).status, 404)
    assert.equal((await f.request('/managed-agent-installs', { body: { workerId: f.worker.workerId, agentKey: 'codex' } })).status, 400)
    assert.equal((await f.request('/managed-agent-installs', { body: { workerId: f.worker.workerId } })).status, 400)

    const first = await f.request('/managed-agent-installs', { body: { workerId: f.worker.workerId, agentKey: 'claude' } })
    assert.equal(first.status, 201)
    assert.equal(first.data.agentKey, 'claude-code')
    assert.equal(first.data.packageName, '@anthropic-ai/claude-code')
    assert.equal(first.data.packageVersion, agentRuntimeCatalog['claude-code'].version)
    assert.equal(first.data.binding.status, 'notified')
    assert.equal(first.data.binding.projectId, null)

    const inventory = await f.request('/resource-inventory')
    assert.equal(inventory.status, 200)
    const entry = inventory.data.agents.find((item: { workerId: string; agentKey: string }) => item.workerId === f.worker.workerId && item.agentKey === 'claude-code')
    assert.equal(entry.configuration.state, 'configured')
    assert.match(entry.configuration.detail, /集群托管修订/)
    // 尚未收到 Worker 回执：分发必须是 pending，不能算已分发。
    assert.equal(entry.distribution.state, 'pending')
    assert.equal(entry.distribution.detail, '尚未收到 Worker 安装回执')

    const stored = await f.request(`/resources/${first.data.resourceId}`)
    assert.equal(stored.status, 200)
    assert.equal(stored.data.revisions.length, 1)
    const revision = stored.data.revisions[0]
    assert.equal(revision.payload.mode, 'artifact')
    assert.deepEqual(revision.payload, { mode: 'artifact', packageName: '@anthropic-ai/claude-code', packageVersion: agentRuntimeCatalog['claude-code'].version, registryOrigin: 'https://registry.npmjs.org', packageIntegrity: agentRuntimeCatalog['claude-code'].integrity })
    assert.equal(revision.manifest.restartPolicy, 'worker')

    // 重复调用不产生第二份修订或绑定（UNIQUE(resource_id,version) 与 UNIQUE(worker_id,resource_revision_id)）。
    const second = await f.request('/managed-agent-installs', { body: { workerId: f.worker.workerId, agentKey: 'claude-code' } })
    assert.equal(second.status, 201)
    assert.equal(second.data.resourceRevisionId, first.data.resourceRevisionId)
    assert.equal(second.data.binding.id, first.data.binding.id)
    assert.equal((await f.request(`/resources/${first.data.resourceId}`)).data.revisions.length, 1)
    assert.equal((await f.request(`/resource-bindings?workerId=${f.worker.workerId}`)).data.items.length, 1)
    assert.equal((await f.request('/resources')).data.items.length, 1)
  } finally { await f.close() }
})

test('managed agent install keeps one binding per worker and agent, and rejects unknown keys without touching the store', async () => {
  const f = await adminRouteFixture()
  try {
    const pi = await f.request('/managed-agent-installs', { body: { workerId: f.worker.workerId, agentKey: 'pi' } })
    const opencode = await f.request('/managed-agent-installs', { body: { workerId: f.worker.workerId, agentKey: 'opencode' } })
    assert.equal(pi.status, 201)
    assert.equal(opencode.status, 201)
    assert.notEqual(pi.data.resourceRevisionId, opencode.data.resourceRevisionId)
    const bindings = (await f.request(`/resource-bindings?workerId=${f.worker.workerId}`)).data.items
    assert.equal(bindings.length, 2)
    assert.deepEqual(bindings.map((item: { binding: { agentKey: string } }) => item.binding.agentKey).sort(), ['opencode', 'pi'])
    const before = (await f.request('/resources')).data.items.length
    for (const key of ['pi; touch /tmp/wemux-pwned', '', 'Pi']) {
      assert.equal((await f.request('/managed-agent-installs', { body: { workerId: f.worker.workerId, agentKey: key } })).status, 400)
    }
    assert.equal((await f.request('/resources')).data.items.length, before)
  } finally { await f.close() }
})
