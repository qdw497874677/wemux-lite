import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { AgentKey, CredentialId, TeamId, Timestamp, WorkerId } from '@wemux/domain'
import type { PersonalAccessTokenScope, User } from '@wemux/server-domain'
import { hashSecret } from '../application/auth.ts'
import { routes as allRoutes } from '../http/routes/index.ts'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.ts'

const password = 'resource-inventory-test-password'

test('resource inventory HTTP is administrator-only and read-only', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  t.after(() => app.close())
  const admin = await seedLocalAccount(app.store, { username: 'inventory-admin', email: administratorEmail, password })
  const member = await seedLocalAccount(app.store, { username: 'inventory-member', email: 'inventory-member@example.test', password })
  const at = new Date().toISOString() as Timestamp
  const teamId = randomUUID() as TeamId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Inventory Team', createdAt: at })
    await tx.identity.saveMembership({ teamId, userId: admin.id, role: 'owner', joinedAt: at })
    await tx.identity.saveMembership({ teamId, userId: member.id, role: 'member', joinedAt: at })
  })
  const workerId = 'inventory-worker' as WorkerId
  await app.store.transaction(tx => tx.resources.saveWorker({
    id: workerId,
    teamId,
    ownerId: admin.id,
    name: 'inventory-worker',
    shareScope: 'team',
    connectionState: 'online',
    version: '2.0.0',
    platform: 'linux',
    capabilities: [{
      agentKey: 'pi' as AgentKey, displayName: 'Pi', version: '0.87.1', mode: 'execution',
      availability: { status: 'available' }, models: [], authorization: { state: 'authorized' },
    }],
    capabilitiesObservedAt: at,
    lastSeenAt: at,
  }))
  const base = await app.listen(0)
  async function login(user: User): Promise<Record<string, string>> {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: user.username, password }),
    })
    assert.equal(response.status, 200)
    await response.json()
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('wemux_login_session='))?.split(';')[0]
    assert.ok(cookie)
    return { Cookie: cookie }
  }
  async function pat(user: User, scopes: PersonalAccessTokenScope[]): Promise<Record<string, string>> {
    const token = `resource-inventory-test-${randomUUID()}`
    await app.store.transaction(tx => tx.identity.savePersonalAccessToken({
      id: randomUUID() as CredentialId, userId: user.id, name: 'Resource inventory test', scopes,
      tokenHash: hashSecret(token), authVersion: user.authVersion ?? 0, createdAt: at,
      expiresAt: '2099-01-01T00:00:00.000Z' as Timestamp, lastUsedAt: null, revokedAt: null,
    }))
    return { Authorization: `Bearer ${token}` }
  }
  const identities: { name: string; headers: Record<string, string>; status: number; code?: string }[] = [
    { name: 'anonymous', headers: {}, status: 401, code: 'authentication_required' },
    { name: 'member Cookie', headers: await login(member), status: 403, code: 'admin_required' },
    { name: 'member admin PAT', headers: await pat(member, ['admin']), status: 403, code: 'admin_required' },
    { name: 'administrator read PAT', headers: await pat(admin, ['read']), status: 403, code: 'pat_scope_required' },
    { name: 'administrator Cookie', headers: await login(admin), status: 200 },
    { name: 'administrator admin PAT', headers: await pat(admin, ['admin']), status: 200 },
  ]
  for (const identity of identities) {
    await t.test(`GET /api/resource-inventory: ${identity.name} returns ${identity.status}`, async () => {
      const response = await fetch(`${base}/api/resource-inventory`, { headers: identity.headers })
      const body = await response.json()
      assert.equal(response.status, identity.status)
      if (identity.status !== 200) {
        assert.deepEqual(Object.keys(body), ['error'])
        assert.equal(body.error.code, identity.code)
        assert.doesNotMatch(JSON.stringify(body), /pi|0\.87\.1|inventory-worker/i)
      } else {
        assert.deepEqual(Object.keys(body), ['generatedAt', 'workers', 'agents', 'models', 'skills', 'presets', 'providers'])
        const workerEntry = body.workers.find((entry: { workerId: string }) => entry.workerId === workerId)
        assert.equal(workerEntry.authentication.state, 'authenticated')
        assert.equal(workerEntry.name, 'inventory-worker')
        assert.equal(workerEntry.version, '2.0.0')
        assert.equal(workerEntry.connectionState, 'online')
      }
    })
  }
  await t.test('no-API prefix serves the same projection', async () => {
    const response = await fetch(`${base}/resource-inventory`, { headers: await login(admin) })
    assert.equal(response.status, 200)
    assert.ok(Array.isArray((await response.json()).workers))
  })
  await t.test('the management projection exposes no write route', () => {
    const writes = allRoutes.filter(route => route.pattern.startsWith('/resource-inventory') && route.method !== 'GET')
    assert.deepEqual(writes, [])
    const route = allRoutes.find(candidate => candidate.method === 'GET' && candidate.pattern === '/resource-inventory')
    assert.equal(route?.auth, 'admin')
  })
  await t.test('administrator inventory never leaks credential values', async () => {
    const response = await fetch(`${base}/api/resource-inventory`, { headers: await login(admin) })
    const serialized = JSON.stringify(await response.json())
    assert.doesNotMatch(serialized, /"(?:apiKey|token|password|secret|value)":/)
  })
})
