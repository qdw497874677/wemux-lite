import test from 'node:test'
import assert from 'node:assert/strict'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, administratorToken, seedAdministrator } from './fixtures/administrator.ts'
import { ProjectAccessService } from '../application/project-access-service.ts'
import type { ServerStore } from '../application/ports/server-store.ts'
import { randomUUID } from 'node:crypto'
import type { UserId, Timestamp } from '@wemux/domain'

test('Project review default is manager-only, CAS-protected and persists without changing existing Task overrides', async () => {
  const server = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const origin = await server.listen(0)
  const call = async (path: string, method = 'GET', body?: unknown, token = administratorToken) => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  try {
    await seedAdministrator(server.store)
    await call('/bootstrap', 'POST', {})
    const created = await call('/projects', 'POST', { name: 'Review defaults', teamId: 'default-team' })
    assert.equal(created.status, 201)
    const id = created.data.id as string
    assert.equal(created.data.reviewPolicy, 'none')
    assert.equal(created.data.reviewPolicyVersion, 1)
    const path = `/projects/${id}/review-policy`
    const contributor = randomUUID() as UserId
    const at = new Date().toISOString() as Timestamp
    await server.store.transaction(async tx => {
      await tx.identity.saveUser({ id: contributor, email: 'review-member@example.test', username: 'review-member', status: 'active', createdAt: at })
      await tx.identity.saveMembership({ teamId: created.data.teamId, userId: contributor, role: 'member', joinedAt: at })
      await tx.identity.saveProjectGrant({ projectId: id as never, userId: contributor, role: 'contributor' })
    })
    const access = new ProjectAccessService(server.store)
    await assert.rejects(access.updateReviewPolicy(contributor, id as never, { version: 1, reviewPolicy: 'human' }), { code: 'project_not_found' })
    for (const bad of [{ reviewPolicy: 'future', version: 1 }, { reviewPolicy: ['none'], version: 1 }, { reviewPolicy: { value: 'human' }, version: 1 }, { reviewPolicy: null, version: 1 }, { reviewPolicy: 'human', version: 0 }, { reviewPolicy: 'human', version: 1, hidden: 1 }]) {
      assert.equal((await call(path, 'PATCH', bad)).status, 400)
    }
    assert.equal((await server.store.identity.listAudit(100)).filter(a => a.action === 'project.review-policy.update').length, 0)
    const changed = await call(path, 'PATCH', { reviewPolicy: 'human', version: 1 })
    assert.equal(changed.status, 200)
    assert.equal(changed.data.reviewPolicy, 'human')
    assert.equal(changed.data.reviewPolicyVersion, 2)
    assert.equal((await call(path, 'PATCH', { reviewPolicy: 'none', version: 1 })).data.error.code, 'project_review_policy_conflict')
    assert.equal((await call(path, 'PATCH', { reviewPolicy: 'human', version: 2 })).data.reviewPolicyVersion, 2)
    const tasks = await call(`/projects/${id}/tasks`, 'POST', { title: 'Inherited review' })
    assert.equal(tasks.status, 201)
    assert.equal(tasks.data.metadataJson.values.reviewPolicy, undefined)
    const detail = await call(`/projects/${id}/tasks/${tasks.data.id}`)
    assert.equal(detail.data.capabilities.transitions.in_review.allowed, false)
    assert.equal((await call('/projects')).data.items.find((p: { id: string }) => p.id === id).reviewPolicy, 'human')
    assert.equal((await server.store.identity.listAudit(100)).filter(a => a.action === 'project.review-policy.update').length, 1)
    // Deterministic interleaving: an access update reads the old Project, then
    // a concurrent policy transaction commits before its own write begins.
    let interleaved = false
    const concurrentStore: ServerStore = { ...server.store,
      transaction: async work => {
        if (!interleaved) {
          interleaved = true
          const current = await server.store.resources.getProject(id as never)
          assert.ok(current)
          await server.store.transaction(tx => tx.resources.saveProject({ ...current, reviewPolicy: 'multi-stage', reviewPolicyVersion: 3 }))
        }
        return server.store.transaction(work)
      },
    }
    const updatedScope = await new ProjectAccessService(concurrentStore).updateShareScope(created.data.ownerId, id as never, { shareScope: 'team' })
    assert.equal(updatedScope.reviewPolicy, 'multi-stage')
    assert.equal(updatedScope.reviewPolicyVersion, 3)
    const persisted = await server.store.resources.getProject(id as never)
    assert.equal(persisted?.reviewPolicy, 'multi-stage')
    assert.equal(persisted?.reviewPolicyVersion, 3)
  } finally { await server.close() }
})
