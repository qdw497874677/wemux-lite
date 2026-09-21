import test from 'node:test'
import { administratorEmail, seedAdministrator, seedLocalAccount } from './fixtures/administrator.js'
import assert from 'node:assert/strict'
import { createWemuxServer } from '../server.js'

const password = 'correct horse battery staple'

function browser(base: string) {
  let cookie = '', csrf = ''
  return {
    async call(path: string, init: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = { Accept: 'application/json', Origin: base, 'Content-Type': 'application/json' }
      if (cookie) headers.Cookie = cookie
      if (csrf) headers['X-CSRF-Token'] = csrf
      const response = await fetch(`${base}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
      const setCookie = response.headers.getSetCookie().find(value => value.startsWith('wemux_login_session='))
      if (setCookie) cookie = setCookie.split(';')[0]!
      const data = response.status === 204 ? null : await response.json() as any
      if (typeof data?.csrfToken === 'string') csrf = data.csrfToken
      return { status: response.status, data }
    },
    async raw(path: string) {
      const headers: Record<string, string> = { Accept: 'text/event-stream', Origin: base }
      if (cookie) headers.Cookie = cookie
      return fetch(`${base}${path}`, { headers })
    },
  }
}

test('project SSE authorizes before headers and emits committed flat invalidations, separate from activity', async () => {
  const server = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  const { token } = await seedAdministrator(server.store)
  const base = await server.listen(0)
  const controller = new AbortController()
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const path = `${base}/api/projects/default-project`
  try {
    await fetch(`${base}/api/bootstrap`, { method: 'POST', headers, body: '{}' })
    for (const [url, auth, expected] of [[`${path}/events`, 'bad', 401], [`${path}/events?teamId=wrong`, token, 403], [`${base}/api/projects/missing/events`, token, 404]] as const) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${auth}` } })
      assert.equal(response.status, expected)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      assert.ok((await response.json()).error.code)
    }
    const response = await fetch(`${path}/events`, { headers, signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type')!, /text\/event-stream/)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = decoder.decode((await reader.read()).value)
    assert.match(text, /revalidate/)
    const created = await fetch(`${path}/tasks`, { method: 'POST', headers, body: JSON.stringify({ title: 'Committed task' }) })
    const task = await created.json()
    while (!text.includes('event: project.event')) text += decoder.decode((await reader.read()).value)
    const event = JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6))
    assert.deepEqual(Object.keys(event).sort(), ['id', 'projectId', 'taskId', 'type'])
    assert.equal(event.taskId, task.id)
    assert.equal(event.type, 'task.created')
    const detail = await fetch(`${path}/tasks/${event.taskId}`, { headers })
    assert.equal((await detail.json()).title, 'Committed task')
    const activity = await fetch(`${path}/tasks/${event.taskId}/activity`, { headers })
    assert.deepEqual((await activity.json()).items.map((item: { seq: number }) => item.seq), [1])
    controller.abort()
    await reader.cancel().catch(() => {})
  } finally { controller.abort(); await server.close() }
})

test('Project Grant 撤销提交后立即关闭已打开的 Project SSE', async t => {
  const server = createWemuxServer({ databasePath: ':memory:', administratorEmails: [administratorEmail] })
  await seedLocalAccount(server.store, { username: 'owner', email: administratorEmail, password })
  const viewer = await seedLocalAccount(server.store, { username: 'viewer', email: 'viewer@example.com', password })
  const base = await server.listen(0)
  t.after(() => server.close())
  const owner = browser(base), member = browser(base)
  assert.equal((await owner.call('/auth/login', { body: { login: 'owner', password } })).status, 200)
  assert.equal((await member.call('/auth/login', { body: { login: 'viewer', password } })).status, 200)
  const team = await owner.call('/teams', { body: { name: 'Realtime project' } })
  await server.store.transaction(async tx => tx.identity.saveMembership({ teamId: team.data.id, userId: viewer.id, role: 'member', joinedAt: new Date().toISOString() as never }))
  const project = await owner.call('/projects', { body: { teamId: team.data.id, name: 'Private project', shareScope: 'selected-members' } })
  assert.equal(project.status, 201, JSON.stringify(project.data))
  assert.equal((await owner.call(`/projects/${project.data.id}/grants`, { body: { userId: viewer.id, role: 'viewer' } })).status, 201)

  const response = await member.raw(`/projects/${project.data.id}/events`)
  assert.equal(response.status, 200)
  const reader = response.body!.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /revalidate/)

  assert.equal((await owner.call(`/projects/${project.data.id}/grants/${viewer.id}`, { method: 'DELETE' })).status, 204)
  assert.equal(await Promise.race([reader.closed.then(() => true, () => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 1_000))]), true)
  assert.equal((await member.call(`/projects/${project.data.id}`)).status, 404)
})
