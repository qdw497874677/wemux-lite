import assert from 'node:assert/strict'
import test from 'node:test'
import { routes } from '../http/routes/index.js'

test('HTTP route registry has the complete surface and no method-pattern conflicts', () => {
  assert.ok(routes.length >= 43, `expected at least 43 routes, received ${routes.length}`)
  const keys = routes.map(route => `${route.method} ${route.pattern}`)
  assert.equal(new Set(keys).size, keys.length, `duplicate routes: ${keys.filter((key, index) => keys.indexOf(key) !== index).join(', ')}`)
})
