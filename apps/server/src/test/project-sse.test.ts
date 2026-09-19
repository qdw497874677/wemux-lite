import test from 'node:test'
import { administratorEmail, seedAdministrator } from './fixtures/administrator.js'
import assert from 'node:assert/strict'
import { createWemuxServer } from '../server.js'

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
