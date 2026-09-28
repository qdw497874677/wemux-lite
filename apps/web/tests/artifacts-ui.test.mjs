import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('task run tab contains artifact registration, preview and review controls', async () => {
  const [board, section] = await Promise.all([read('../src/features/tasks/board.tsx'), read('../src/features/artifacts/artifacts-section.tsx')])
  assert.match(board, /<ArtifactsSection/)
  assert.match(section, /相对路径/)
  assert.match(section, /预览/)
  assert.match(section, /通过/)
  assert.match(section, /需修改/)
  assert.doesNotMatch(section, /crypto\.randomUUID/)
})

test('artifact wire API carries metadata while content uses dedicated content endpoint', async () => {
  const client = await read('../src/api/client.ts')
  assert.match(client, /registerArtifact/)
  assert.match(client, /reviewArtifact/)
  assert.match(client, /\/artifacts/)
})
