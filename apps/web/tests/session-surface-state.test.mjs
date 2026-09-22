import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('interactive Surface preserves draft ownership in the shared Composer and exposes reconnect state', async () => {
  const surface = await read('../src/features/sessions/session-surface.tsx')
  const conversation = await read('../src/features/sessions/conversation.tsx')
  assert.match(surface, /<Composer controller={controller}/)
  assert.match(surface, /history\.stream !== 'live'/)
  assert.match(surface, /实时更新正在重连，历史仍会继续补传。/)
  assert.match(surface, /history\.freshness\?\.status === 'synced'/)
  assert.match(conversation, /const \[text, setText\] = useState\(''\)/)
  assert.match(conversation, /发送失败，内容已保留/)
  assert.match(conversation, /setText\(value\)/)
})
