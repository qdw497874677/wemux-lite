import assert from 'node:assert/strict'
import type { AgentKey, ModelId } from '@wemux/domain'
import { createWemuxServer } from '../../server.ts'
import { administratorEmail, instanceOperatorId, seedLocalAccount, seedOperator } from './administrator.ts'

export const password = 'correct horse battery staple'
export async function sseCredentialFixture(adminSessionTtlMs?: number) {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail], adminSessionTtlMs, webNextStaticPath: new URL('../../../../web-next/dist', import.meta.url).pathname })
  await seedOperator(app.store, app.service)
  await seedLocalAccount(app.store, { userId: instanceOperatorId, username: 'deployer', email: administratorEmail, password })
  const enrollment = await app.service.createEnrollment({})
  const enrolled = await app.service.enroll({ token: enrollment.token, name: 'sse-credential-worker' })
  await app.store.transaction(tx => tx.resources.saveWorker({ ...enrolled.worker, capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test Agent', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test' as ModelId, displayName: 'Test', source: 'detected' }] }] }))
  const project = await app.service.createProject({ name: 'SSE credential' })
  const { workspace } = await app.service.createWorkspace({ projectId: project.id, workerId: enrolled.worker.id, name: 'workspace' })
  const location = { workspaceId: workspace.id, workerId: enrolled.worker.id, rootPath: '/tmp/sse-credential-workspace', checkouts: [] }
  await app.store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready', workerId: enrolled.worker.id, location, placements: workspace.placements.map(placement => ({ ...placement, status: 'ready' as const, location })) }))
  const { session } = await app.service.createSession({ requestId: 'sse-credential-session', workspaceId: workspace.id, title: 'SSE credential', agentKey: 'test', modelId: 'test' })
  const base = await app.listen(0)
  const paths = {
    session: `/api/sessions/${session.id}/stream`, project: `/api/projects/${project.id}/events`,
    canvas: `/api/projects/${project.id}/canvas/collaboration/events`, terminal: `/api/sessions/${session.id}/terminal/stream`,
  }
  const login = async () => {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ login: 'deployer', password }) })
    assert.equal(response.status, 200)
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('wemux_login_session='))!.split(';')[0]!
    const data = await response.json()
    return { cookie, csrf: data.csrfToken as string, id: data.session.id as string }
  }
  return { app, base, paths, login, session, project, actor: instanceOperatorId }
}

export async function consumeStream(base: string, path: string, headers: Record<string, string>) {
  const controller = new AbortController()
  const response = await fetch(`${base}${path}`, { headers, signal: controller.signal })
  assert.equal(response.status, 200)
  let text = '', ended = false, failed = false
  const reader = response.body!.getReader()
  const done = (async () => {
    try { for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value) } }
    catch { failed = true }
    finally { ended = true }
  })()
  return { text: () => text, ended: () => ended, failed: () => failed, done, stop: () => controller.abort() }
}
export async function until(predicate: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!predicate()) { assert.ok(Date.now() < deadline, 'condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)) }
}
