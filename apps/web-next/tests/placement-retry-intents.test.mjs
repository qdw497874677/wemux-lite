import test from 'node:test'
import assert from 'node:assert/strict'
import { PlacementRetryIntents } from '../src/lib/placement-retry-intents.ts'
test('A uncertain, B acknowledged, A retries exactly; only matching acknowledgment starts a new intent', () => {
  let sequence = 0
  const intents = new PlacementRetryIntents(() => `id-${++sequence}`)
  const a = ['task', 'workspace-a', 'worker-a'], b = ['task', 'workspace-b', 'worker-b']
  const first = intents.id(a), other = intents.id(b)
  intents.acknowledge(b, other)
  assert.equal(intents.id(a), first)
  intents.acknowledge(a, first)
  const next = intents.id(a); assert.notEqual(next, first)
  intents.acknowledge(a, first)
  assert.equal(intents.id(a), next)
  assert.notEqual(intents.id(['different-task', ...a.slice(1)]), next)
  assert.notEqual(intents.id(['task', 'workspace-a', 'different-worker']), next)
})
