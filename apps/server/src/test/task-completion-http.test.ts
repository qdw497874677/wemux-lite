import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWemuxServer } from '../server.ts'
import { hashSecret } from '../application/auth.ts'
import { seedLocalAccount } from './fixtures/administrator.ts'
import type { CredentialId, Timestamp, UserId } from '@wemux/domain'

const email = 'completion-http@example.test', password = 'long-test-password-2026'

async function pat(store: ReturnType<typeof createWemuxServer>['store'], userId: UserId, scopes: ('read' | 'write' | 'execute' | 'admin')[]) {
  const token = `completion-${randomUUID()}`, now = new Date().toISOString() as Timestamp
  await store.transaction(tx => tx.identity.savePersonalAccessToken({ id: randomUUID() as CredentialId, userId, name: 'completion-test', scopes, tokenHash: hashSecret(token), createdAt: now, expiresAt: '2099-01-01T00:00:00.000Z' as Timestamp, revokedAt: null }))
  return token
}

test('completion HTTP denies missing CSRF, insufficient PAT and viewer without persisted receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'completion-http-'))
  const app = createWemuxServer({ databasePath: join(dir, 'db'), administratorEmails: [email] })
  try {
    const owner = await seedLocalAccount(app.store, { username: 'completion-owner', email, password })
    const base = await app.listen(0)
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: owner.username, password }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    const me = await fetch(`${base}/auth/me`, { headers: { Cookie: cookie } })
    assert.equal(me.status, 200)
    const csrf = (await me.json()).csrfToken as string
    assert.ok(csrf)
    const projects = await fetch(`${base}/projects`, { headers: { Cookie: cookie } })
    assert.equal(projects.status, 200)
    const projectId = (await projects.json()).items[0].id as string
    const ownerPat = await pat(app.store, owner.id, ['read', 'write'])
    const viewer = await seedLocalAccount(app.store, { username: 'completion-viewer', email: 'completion-viewer@example.test', password })
    const viewerPat = await pat(app.store, viewer.id, ['read', 'write'])
    const readOnly = await pat(app.store, owner.id, ['read'])
    const create = await fetch(`${base}/projects/${projectId}/tasks`, { method: 'POST', headers: { Authorization: `Bearer ${ownerPat}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Completion HTTP authority check', requestId: 'completion-task' }) })
    assert.equal(create.status, 201)
    const taskId = (await create.json()).id as string
    const project = await app.store.resources.getProject(projectId as never)
    assert.ok(project)
    await app.store.transaction(async tx => {
      await tx.identity.saveMembership({ teamId: project.teamId, userId: viewer.id, role: 'member', joinedAt: new Date().toISOString() as Timestamp })
      await tx.identity.saveProjectGrant({ projectId: project.id, userId: viewer.id, role: 'viewer' })
    })
    const route = `/projects/${projectId}/tasks/${taskId}/completion`
    const body = JSON.stringify({ requestId: 'denied-completion', version: 1, runId: 'not-a-run', summary: 'No execution', evidence: [] })
    const send = async (headers: Record<string, string>) => {
      const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
      return { status: response.status, code: (await response.json()).error?.code as string }
    }
    assert.equal((await send({ Cookie: cookie, Origin: base })).status, 403)
    assert.equal((await send({ Authorization: `Bearer ${readOnly}` })).status, 403)
    // No cross-Project grant: merely possessing a write-scoped PAT is insufficient.
    assert.equal((await send({ Authorization: `Bearer ${viewerPat}` })).status, 403)
    // Valid owner credential passes auth but cannot claim a nonexistent Run.
    assert.equal((await send({ Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf })).code, 'invalid_transition')
    assert.equal((await send({ Authorization: `Bearer ${ownerPat}` })).code, 'invalid_transition')
    const activities = await fetch(`${base}/projects/${projectId}/tasks/${taskId}/activity`, { headers: { Authorization: `Bearer ${ownerPat}` } })
    assert.equal(activities.status, 200)
    assert.ok(!(await activities.json()).items.some((item: { payload: { action: string } }) => item.payload.action === 'completion.submitted'))
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
})
