import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWemuxServer } from '../../server.ts'
import { seedAdministrator, seedLocalAccount } from './administrator.ts'
import { hashSecret } from '../../application/auth.ts'
import type { PersonalAccessTokenScope } from '@wemux/server-domain'

/** Private current-source HTTP fixture. No real tailnet CLI, Agent, Worker or physical workspace. */
export async function adminRouteFixture(webNextStaticPath?: string) {
  const root = await mkdtemp(join(tmpdir(), 'wemux-admin-policy-'))
  const previousPath = process.env.PATH
  const bin = join(root, 'bin'), probe = join(root, 'tailnet-called')
  await mkdir(bin)
  await writeFile(join(bin, 'tailscale'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(probe)}, 'called\\n'); console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'private-fixture.invalid',TailscaleIPs:['100.64.0.1']}}));\n`, { mode: 0o700 })
  process.env.PATH = `${bin}:${previousPath ?? ''}`
  const accounts = {
    owner: { id: 'policy-owner', email: 'policy-owner@example.test', token: 'synthetic-policy-owner', password: 'private owner password 123' },
    admin: { id: 'policy-admin', email: 'policy-admin@example.test', token: 'synthetic-policy-admin', password: 'private admin password 123' },
    member: { id: 'policy-member', email: 'policy-member@example.test', token: 'synthetic-policy-member', password: 'private member password 123' },
  }
  const app = createWemuxServer({ databasePath: join(root, 'server.sqlite'), administratorEmails: [accounts.owner.email, accounts.admin.email], capabilitySecret: 'private-admin-route-fixture-capability-secret', webNextStaticPath, mail: {}, google: {} })
  const origin = await app.listen(0)
  assert.ok(![8004, 8010].includes(Number(new URL(origin).port)))
  const request = async (path: string, options: { token?: string | null; cookie?: string; csrf?: string; method?: string; body?: unknown } = {}) => {
    const { method = options.body === undefined ? 'GET' : 'POST', body } = options
    const response = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(options.cookie ? { Cookie: options.cookie, Origin: origin, ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}) } : options.token === null ? {} : { Authorization: `Bearer ${options.token ?? accounts.owner.token}` }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  const pat = async (userId: string, token: string, scopes: readonly string[]) => app.store.transaction(tx => tx.identity.savePersonalAccessToken({ id: token as never, userId: userId as never, name: 'Private fixture', scopes: scopes as PersonalAccessTokenScope[], tokenHash: hashSecret(token), createdAt: new Date().toISOString() as never, expiresAt: '2099-01-01T00:00:00Z' as never, lastUsedAt: null, revokedAt: null }))
  const login = async (key: keyof typeof accounts) => {
    const account = accounts[key]
    const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: account.email, password: account.password }) })
    assert.equal(response.status, 200)
    return { cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), csrf: (await response.json()).csrfToken as string }
  }
  try {
    for (const key of ['owner', 'admin', 'member'] as const) {
      const a = accounts[key]
      if (key !== 'member') await seedAdministrator(app.store, { userId: a.id as never, email: a.email, username: a.email, token: a.token })
      await seedLocalAccount(app.store, { userId: a.id as never, username: a.email, email: a.email, password: a.password })
      if (key === 'member') await pat(a.id, a.token, ['read', 'write', 'execute', 'admin'])
    }
    assert.equal((await request('/bootstrap', { body: {} })).status, 200)
    for (const key of ['admin', 'member'] as const) await app.store.transaction(tx => tx.identity.saveMembership({ teamId: 'default-team' as never, userId: accounts[key].id as never, role: 'member', joinedAt: new Date().toISOString() as never }))
    const project = (await request('/projects', { body: { name: 'Private policy project', teamId: 'default-team' } })).data
    await request(`/projects/${project.id}/grants`, { body: { userId: accounts.member.id, role: 'manager' } })
    const task = (await request(`/projects/${project.id}/tasks`, { body: { title: 'Private Session task' } })).data
    const workspace = (await request('/workspaces', { body: { projectId: project.id, name: 'Logical fixture' } })).data.workspace
    const enrollment = (await request('/enrollment-tokens', { body: {} })).data
    const worker = (await request('/workers/enroll', { body: { token: enrollment.token, name: 'Idle metadata fixture' } })).data
    const sessionId = 'policy-idle-session'
    await app.store.transaction(async tx => {
      const node = (await tx.resources.getWorker(worker.workerId))!
      await tx.resources.saveWorker({ ...node, connectionState: 'online' })
      await tx.resources.saveSession({ id: sessionId, projectId: project.id, ownerId: accounts.owner.id, workspaceId: workspace.id, title: 'Private Session', taskId: task.id, runId: null, binding: { workspaceId: workspace.id, agent: { workerId: worker.workerId, agentKey: 'fixture' }, modelId: 'fixture' }, runtimeState: 'idle', archivedAt: null, deletedAt: null, shareScope: 'project', storageMode: 'local' } as never)
      await tx.cache.recordWorkerHead(sessionId as never, 0 as never)
      await tx.commands.insertPending({ commandId: 'policy-command' as never, workerId: worker.workerId, command: { kind: 'turn.stop', sessionId: sessionId as never, turnId: 'fixture-turn' as never }, payloadFingerprint: 'synthetic', createdAt: new Date().toISOString() as never })
    })
    return {
      app, origin, accounts, project, sessionId, task, workspace, worker, request, login, pat,
      async tailnetCalls() { try { return (await readFile(probe, 'utf8')).trim().split('\n').length } catch { return 0 } },
      async snapshot() { return { projects: await app.store.resources.listProjects(), sessions: await app.store.resources.listSessions(), workspaces: await app.store.resources.listWorkspaces(), tasks: await app.store.tasks.list(project.id, true), commands: await app.store.commands.list({ limit: 1000 }), audit: (await app.store.identity.listAudit(1000)).filter(entry => /^(projects|sessions|command)\./.test(entry.action)) } },
      async close() { await app.close(); if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }) },
    }
  } catch (error) { await app.close(); if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); throw error }
}
