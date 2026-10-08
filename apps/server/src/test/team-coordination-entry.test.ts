import assert from 'node:assert/strict'
import test from 'node:test'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.ts'

/** 真实 HTTP 入口验证：可用性投影的鉴权与脱敏、enqueue 关闭态不可绕过（T-2-05/T-2-06）。 */
test('team coordination availability projection and closed enqueue gate', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  try {
    await seedLocalAccount(app.store, { username: 'coordination-owner', email: 'coord-owner@example.test', password: 'coordination-owner-password' })
    await seedLocalAccount(app.store, { username: 'coordination-outsider', email: 'coord-outsider@example.test', password: 'coordination-outsider-password' })
    const base = await app.listen(0)
    const login = async (username: string, password: string) => {
      const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: username, password }) })
      assert.equal(response.status, 200)
      return response.headers.get('set-cookie')!.split(';')[0]!
    }
    const owner = await login('coordination-owner', 'coordination-owner-password')
    const outsider = await login('coordination-outsider', 'coordination-outsider-password')
    const csrfToken = ((await (await fetch(`${base}/api/auth/me`, { headers: { cookie: owner } })).json()) as { csrfToken: string }).csrfToken
    const created = await (await fetch(`${base}/api/teams`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'x-csrf-token': csrfToken }, body: JSON.stringify({ name: '协调团队' }) })).json() as { id: string }
    const availability = `${base}/api/teams/${created.id}/coordination/availability`
    const enqueue = `${base}/api/teams/${created.id}/coordination/sessions`

    // 未认证：401，不暴露任何投影。
    assert.equal((await fetch(availability)).status, 401)
    assert.equal((await fetch(enqueue, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401)
    // 非成员：403 team_membership_required，错误体不含团队信息或投影内容。
    const outsiderAvailability = await fetch(availability, { headers: { cookie: outsider } })
    assert.equal(outsiderAvailability.status, 403)
    const outsiderBody = await outsiderAvailability.text()
    assert.ok(outsiderBody.includes('team_membership_required'))
    assert.equal(outsiderBody.includes(created.id), false)

    // 成员：200，固定投影（disabled + FAIL 摘要 + 证据路径 + 解除条件）。
    const memberResponse = await fetch(availability, { headers: { cookie: owner } })
    assert.equal(memberResponse.status, 200)
    const projection = await memberResponse.json() as { status: string; gate: { verdict: string; reasons: string[]; evidencePath: string; remediationSection: string; reopenConditions: string[] } }
    assert.equal(projection.status, 'disabled')
    assert.equal(projection.gate.verdict, 'FAIL')
    assert.equal(projection.gate.evidencePath, '.scratch/web-next-project-agent-platform/evidence/ticket-05-runtime-isolation-gate.md')
    assert.equal(projection.gate.remediationSection, '五')
    assert.equal(projection.gate.reasons.length, 2)
    assert.equal(projection.gate.reopenConditions.length, 3)
    // 诊断信息不泄漏凭据或敏感内容（T-2-06）。
    const projectionText = JSON.stringify(projection)
    for (const forbidden of ['password', 'token', 'secret', 'cookie', 'authorization', base]) assert.equal(projectionText.toLowerCase().includes(forbidden), false, `投影不得包含 ${forbidden}`)

    // enqueue 关闭态：成员也是 403 coordination_gate_closed；缺 CSRF 先被拒（csrf_rejected），带完整凭据绕过 UI 直接 HTTP 同样被资格门拒绝。
    const noCsrf = await fetch(enqueue, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner }, body: '{}' })
    assert.equal(noCsrf.status, 403)
    assert.ok((await noCsrf.text()).includes('csrf_rejected'))
    const enqueueResponse = await fetch(enqueue, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner, 'x-csrf-token': csrfToken }, body: '{}' })
    assert.equal(enqueueResponse.status, 403)
    const enqueueBody = await enqueueResponse.json() as { error: { code: string; message: string } }
    assert.equal(enqueueBody.error.code, 'coordination_gate_closed')
    assert.ok(enqueueBody.error.message.includes('ticket-05-runtime-isolation-gate.md'), '错误信息包含证据路径')
    // 非成员 enqueue：成员资格先于资格门，得 team_membership_required 而非 coordination_gate_closed。
    const outsiderEnqueue = await fetch(enqueue, { method: 'POST', headers: { 'content-type': 'application/json', cookie: outsider, 'x-csrf-token': ((await (await fetch(`${base}/api/auth/me`, { headers: { cookie: outsider } })).json()) as { csrfToken: string }).csrfToken }, body: '{}' })
    assert.equal(outsiderEnqueue.status, 403)
    assert.ok((await outsiderEnqueue.text()).includes('team_membership_required'))
  } finally { await app.close() }
})
