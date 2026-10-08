import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { AgentKey, CredentialId, Resource, TeamId, Timestamp } from '@wemux/domain'
import type { PersonalAccessTokenScope, User } from '@wemux/server-domain'
import { hashSecret } from '../application/auth.ts'
import { createWemuxServer } from '../server.ts'
import { administratorEmail, seedLocalAccount } from './fixtures/administrator.ts'

const password = 'resource-authorization-test-password'

test('resource catalog HTTP enforces administrator identity and PAT scope before returning data', async t => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  t.after(() => app.close())
  const admin = await seedLocalAccount(app.store, { username: 'resource-admin', email: administratorEmail, password })
  const member = await seedLocalAccount(app.store, { username: 'resource-member', email: 'resource-member@example.test', password })
  const at = new Date().toISOString() as Timestamp
  const teamId = randomUUID() as TeamId
  await app.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Resource authorization Team', createdAt: at })
    await tx.identity.saveMembership({ teamId, userId: admin.id, role: 'owner', joinedAt: at })
    await tx.identity.saveMembership({ teamId, userId: member.id, role: 'member', joinedAt: at })
  })
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
    const token = `resource-test-${randomUUID()}`
    await app.store.transaction(tx => tx.identity.savePersonalAccessToken({
      id: randomUUID() as CredentialId, userId: user.id, name: 'Resource HTTP test', scopes,
      tokenHash: hashSecret(token), authVersion: user.authVersion ?? 0, createdAt: at,
      expiresAt: '2099-01-01T00:00:00.000Z' as Timestamp, lastUsedAt: null, revokedAt: null,
    }))
    return { Authorization: `Bearer ${token}` }
  }
  const adminCookie = await login(admin), memberCookie = await login(member)
  const adminPat = await pat(admin, ['admin'])
  const provider: Resource = {
    id: 'private-provider-catalog', kind: 'model-provider', name: 'Private Provider catalog', description: '',
    definition: { providerKey: 'openai-compatible', endpoint: 'https://models.example.test/v1', modelIds: ['private-model'], agentKeys: ['pi' as AgentKey], credential: { kind: 'environment', variableNames: ['OPENAI_API_KEY'] } },
    createdBy: admin.id, createdAt: at, updatedAt: at,
  }
  const skill: Resource = {
    id: 'private-skill-catalog', kind: 'skill', name: 'Private Skill catalog', description: '',
    definition: { entryFile: 'SKILL.md', compatibleAgents: ['pi' as AgentKey], containsExecutableFiles: false },
    createdBy: admin.id, createdAt: at, updatedAt: at,
  }
  async function createResource(resource: Record<string, unknown>) {
    return fetch(`${base}/api/resources`, {
      method: 'POST', headers: { ...adminPat, 'Content-Type': 'application/json' }, body: JSON.stringify(resource),
    })
  }
  for (const resource of [provider, skill]) {
    const { createdBy: _createdBy, ...input } = resource
    const response = await createResource(input)
    assert.equal(response.status, 201, JSON.stringify(await response.json()))
  }

  const identities: { name: string; headers: Record<string, string>; status: number; code?: string }[] = [
    // handler.ts 将无显式 code 的通用 401 拒绝归一化为 authentication_required（未知/过期/已撤销凭据
    // 故意不可区分），identity-expiry.test.ts 已锁定同一形状，这里不能用旧的泛用 'error'。
    { name: 'anonymous', headers: {}, status: 401, code: 'authentication_required' },
    { name: 'member Cookie', headers: memberCookie, status: 403, code: 'admin_required' },
    { name: 'administrator read PAT', headers: await pat(admin, ['read']), status: 403, code: 'pat_scope_required' },
    { name: 'administrator write PAT', headers: await pat(admin, ['write']), status: 403, code: 'pat_scope_required' },
    { name: 'administrator execute PAT', headers: await pat(admin, ['execute']), status: 403, code: 'pat_scope_required' },
    { name: 'member admin PAT', headers: await pat(member, ['admin']), status: 403, code: 'admin_required' },
    { name: 'administrator Cookie', headers: adminCookie, status: 200 },
    { name: 'administrator admin PAT', headers: adminPat, status: 200 },
  ]
  const endpoints = [
    { path: '/api/resources', body: { items: [provider, skill] } },
    { path: '/resources', body: { items: [provider, skill] } },
    { path: `/api/resources/${provider.id}`, body: { resource: provider, revisions: [] } },
    { path: `/api/resources/${skill.id}`, body: { resource: skill, revisions: [] } },
    { path: '/api/resource-presets', body: { items: [] } },
    { path: '/api/resource-preset-applications', body: { items: [] } },
    { path: '/api/resource-bindings', body: { items: [] } },
    { path: '/api/workers/private-worker/resource-set' },
  ]
  for (const endpoint of endpoints) {
    for (const identity of identities) {
      await t.test(`GET ${endpoint.path}: ${identity.name} returns ${identity.status}`, async () => {
        const response = await fetch(base + endpoint.path, { headers: identity.headers })
        const body = await response.json()
        assert.equal(response.status, identity.status)
        if (identity.status !== 200) {
          assert.deepEqual(Object.keys(body), ['error'])
          assert.equal(body.error.code, identity.code)
          assert.doesNotMatch(JSON.stringify(body), /private-provider-catalog|private-skill-catalog|private-model|models\.example\.test|OPENAI_API_KEY|private-worker/)
          assert.equal('items' in body || 'resource' in body || 'bindings' in body, false)
        } else if (endpoint.body) {
          assert.deepEqual(body, endpoint.body)
        } else {
          assert.equal(body.workerId, 'private-worker')
          assert.deepEqual(body.bindings, [])
        }
      })
    }
  }

  await t.test('Provider catalog stores only credential locators and rejects inline secrets over HTTP', async () => {
    const { createdBy: _createdBy, ...input } = provider
    const secret = 'resource-http-secret-sentinel'
    const invalidInputs = [
      { ...input, token: secret },
      { ...input, definition: { ...provider.definition, apiKey: secret } },
      { ...input, definition: { ...provider.definition, credential: { ...provider.definition.credential, value: secret } } },
      { ...input, definition: { ...provider.definition, endpoint: `https://models.example.test/v1?token=${secret}` } },
    ]
    for (const invalid of invalidInputs) {
      const response = await createResource({ ...invalid, id: randomUUID() })
      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.error.code, 'invalid_provider_config')
      assert.ok(!JSON.stringify(body).includes(secret))
    }
    const response = await fetch(`${base}/api/resources`, { headers: adminPat })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body, { items: [provider, skill] })
    const serialized = JSON.stringify(body)
    assert.ok(!serialized.includes(secret))
    assert.doesNotMatch(serialized, /"(?:apiKey|token|password|secret|value)":/)
  })
})
