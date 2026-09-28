import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('batch two exposes attention navigation and grouped jump targets', async () => {
  const [app, page] = await Promise.all([
    readFile(new URL('../../web/src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../web/src/features/attention/attention-page.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(app, /path: '\/attention'/)
  assert.match(page, /href=\{item\.href\}/)
  assert.match(page, /attention-group-/)
})

test('batch two artifact flow registers, reviews and projects timeline events', async () => {
  const [section, migration] = await Promise.all([
    readFile(new URL('../../web/src/features/artifacts/artifacts-section.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/storage/sqlite/migrations.ts', import.meta.url), 'utf8'),
  ])
  assert.match(section, /api\.registerArtifact/)
  assert.match(section, /api\.reviewArtifact/)
  assert.match(migration, /artifact\.registered/)
  assert.match(migration, /artifact\.reviewed/)
})
