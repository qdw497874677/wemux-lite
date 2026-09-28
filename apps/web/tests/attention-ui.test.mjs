import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('attention page renders grouped cards, distinct empty state and navigable items', async () => {
  const source = await read('../src/features/attention/attention-page.tsx')
  assert.match(source, /attention-group-/)
  assert.match(source, /现在没有需要你处理的事项/)
  assert.match(source, /href=\{item\.href\}/)
  assert.match(source, /待办加载失败/)
})

test('attention navigation polls and shows a count badge', async () => {
  const [hook, app] = await Promise.all([read('../src/features/attention/use-attention.ts'), read('../src/App.tsx')])
  assert.match(hook, /refetchInterval: 30_000/)
  assert.match(app, /attention-nav-count/)
  assert.match(app, /path: '\/attention'/)
})
