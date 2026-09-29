import test from 'node:test'
import assert from 'node:assert/strict'
import { hostRoutes, isHostPathAllowed } from '../src/app/host-paths.ts'

test('local host mounts only local routes and rejects cluster and unknown paths', () => {
  assert.ok(hostRoutes('local-worker').every(path => path.startsWith('/local')))
  for (const path of ['/local', '/local/sessions', '/local/sessions/a', '/local/cluster', '/local/settings']) assert.equal(isHostPathAllowed('local-worker', path), true, path)
  for (const path of ['/', '/projects', '/projects/p/sessions', '/teams', '/local/sessions/a/extra']) assert.equal(isHostPathAllowed('local-worker', path), false, path)
  assert.equal(isHostPathAllowed('cluster', '/projects'), true)
  assert.equal(isHostPathAllowed('cluster', '/local'), false)
})
