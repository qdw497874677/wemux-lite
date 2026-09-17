import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../index.html', import.meta.url), 'utf8')

test('module load fallback is triggered by an actual script load error', () => {
  assert.match(source, /type="module"[^>]+onerror="window\.__wemuxModuleLoadFailed\(\)"/)
  assert.match(source, /window\.__wemuxModuleLoadFailed = function/)
})

test('slow startup does not use the old four-second false-positive timeout', () => {
  assert.doesNotMatch(source, /}, 4000\)/)
  assert.match(source, /}, 15000\)/)
  assert.match(source, /JavaScript/)
})
