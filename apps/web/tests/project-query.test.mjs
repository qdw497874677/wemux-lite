import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QueryClient } from '@tanstack/react-query'
import { projectKeys, eventKeys, projectSubscription, mergeActivity } from '../src/app/project-query.ts'
const item = (cursor, taskId = 't', seq = cursor) => ({ cursor, activity: { taskId, seq, type: 'task.updated' } })
test('activity merges overlapping durable pages, dedupes task seq and never uses SSE identity', () => {
 const first = mergeActivity([], [item(2), item(1)])
 assert.deepEqual(mergeActivity(first, [item(2), item(4), item(3)]).map(i => i.cursor), [1, 2, 3, 4])
 assert.equal(mergeActivity(first, [item(3, 'other', 1)]).length, 3)
 assert.throws(() => mergeActivity(first, [item('opaque')]), /cursor/)
})
test('precise event invalidation does not invalidate unrelated projects or global lists', () => {
 const keys = eventKeys({ id: 'opaque:99', projectId: 'p', taskId: 't', type: 'link.changed' })
 assert.deepEqual(keys, [projectKeys.activity('p'), projectKeys.tasks('p'), projectKeys.task('p', 't')])
 const run = eventKeys({ id: 'x', projectId: 'p', taskId: 't', runId: 'r', type: 'run.changed' })
 assert.ok(run.some(k => JSON.stringify(k) === JSON.stringify(projectKeys.runs('p', 't'))))
 assert.ok(run.some(k => JSON.stringify(k) === JSON.stringify(projectKeys.reviews('p'))))
})
test('scope disposal rejects queued old callbacks and reconnect; next scope reconciles only itself', async () => {
 const client = new QueryClient(), calls = []
 client.setQueryData(projectKeys.tasks('p'), [{ id: 'durable' }])
 const invalidate = key => { calls.push(key); void client.invalidateQueries({ queryKey: key }) }
 const old = projectSubscription('p', invalidate)
 old.event({ id: '1', projectId: 'other', type: 'task.created', taskId: 't' }); assert.equal(calls.length, 0)
 old.dispose(); old.event({ id: '2', projectId: 'p', type: 'task.created', taskId: 't' }); old.reconcile(); assert.equal(calls.length, 0)
 const next = projectSubscription('q', invalidate); next.reconcile()
 assert.deepEqual(calls, [projectKeys.root('q')])
 assert.deepEqual(client.getQueryData(projectKeys.tasks('p')), [{ id: 'durable' }]); client.clear()
})
