import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, seedAdministrator, seedLocalAccount } from './fixtures/administrator.ts'
import { seedAttentionHumanReview } from './fixtures/attention-human-reviews.ts'
import type { AttentionPagesResult } from '@wemux/server-domain'

test('HTTP human review pages enforce current actor authority, seek, Task route, CAS decision and revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attention-human-http-'))
  const databasePath = join(directory, 'server.sqlite')
  const app = createWemuxServer({ databasePath, administratorEmails: [administratorEmail] })
  try {
    const admin = await seedAdministrator(app.store)
    const reviewer = await seedLocalAccount(app.store, { username: 'reviewer', email: 'reviewer@example.test', password: 'synthetic-reviewer-password' })
    const { project } = await app.service.ensureDefaultEnvironment(admin.userId)
    await app.store.transaction(async tx => {
      await tx.identity.saveMembership({ teamId: project.teamId, userId: reviewer.id, role: 'member', joinedAt: new Date().toISOString() as never })
      await tx.identity.saveProjectGrant({ projectId: project.id, userId: reviewer.id, role: 'manager' })
    })
    const db = new DatabaseSync(databasePath)
    try {
      seedAttentionHumanReview(db, 'a', project.id, admin.userId)
      seedAttentionHumanReview(db, 'b', project.id, admin.userId)
      // Session Journal is a separate privacy boundary, never an approval page source.
      db.prepare('INSERT INTO events(session_id,seq,data) VALUES(?,?,?)').run('session-a', 1, JSON.stringify({ privateSecret: 'private-journal-approval' }))
    } finally { db.close() }
    const base = await app.listen(0)
    const path = `/api/attention/pages?kind=approval&projectId=${project.id}&limit=1`
    assert.equal((await fetch(`${base}${path}`)).status, 401)
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'reviewer', password: 'synthetic-reviewer-password' }) })
    assert.equal(login.status, 200)
    const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0]! }
    const get = async (suffix = '') => {
      const response = await fetch(`${base}${path}${suffix}`, { headers })
      assert.equal(response.status, 200)
      return response.json() as Promise<AttentionPagesResult>
    }
    const first = await get('&actorId=forged&isAdministrator=true')
    assert.equal(first.items.length, 1)
    assert.equal(first.items[0]?.href, `/next/projects/${project.id}?task=task-a`)
    assert.ok(first.nextCursor)
    assert.doesNotMatch(JSON.stringify(first), /private-journal-approval|session-a|decisionCapabilities/)
    const second = await get(`&cursor=${first.nextCursor}`)
    assert.equal(second.items[0]?.sourceId, 'task_review:task-b:run-b:b')
    assert.equal(second.nextCursor, null)
    assert.equal((await fetch(`${base}${path}&cursor=bad`, { headers })).status, 400)
    const wrongKind = Buffer.from(JSON.stringify([1, 'run_problem', 'now', 'id'])).toString('base64url')
    assert.equal((await fetch(`${base}${path}&cursor=${wrongKind}`, { headers })).status, 400)
    assert.equal((await fetch(`${base}/api/attention/pages?kind=task_assignment`, { headers })).status, 422)
    const self = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${admin.token}` } })
    assert.deepEqual((await self.json() as AttentionPagesResult).items, [], 'Project owner/instance admin cannot review own submission')
    const me = await (await fetch(`${base}/api/auth/me`, { headers })).json() as { csrfToken: string }
    const decide = (version: number, requestId: string) => fetch(`${base}/api/projects/${project.id}/tasks/task-a/human-review-decision`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-csrf-token': me.csrfToken }, body: JSON.stringify({ version, requestId, reviewId: 'a', status: 'approved' }) })
    assert.equal((await decide(2, 'stale-request')).status, 409)
    const decision = await decide(1, 'accepted-request')
    assert.equal(decision.status, 200, await decision.clone().text())
    assert.equal((await decide(1, 'accepted-request')).status, 200, 'idempotent decision receipt')
    assert.deepEqual((await get()).items.map(item => item.sourceId), ['task_review:task-b:run-b:b'])
    await app.store.transaction(tx => tx.identity.removeMembership(project.teamId, reviewer.id))
    const revoked = await get(`&cursor=${first.nextCursor}`)
    assert.deepEqual(revoked.items, [])
    assert.equal(revoked.nextCursor, null)
    assert.notEqual((await decide(1, 'accepted-request')).status, 200, 'replay reauthorizes after membership revocation')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
