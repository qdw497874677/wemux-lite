import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildDiffRows, MAX_DIFF_LINES } from '../src/features/files/diff-model.ts'

const context = (start, count) => Array.from({ length: count }, (_, index) => ({ type: 'ctx', oldLine: start + index, newLine: start + index, text: `line ${start + index}` }))

test('DiffBlock keeps three context lines around changes and folds pure context runs', () => {
  const lines = [...context(1, 8), { type: 'del', oldLine: 9, text: 'old' }, { type: 'add', newLine: 9, text: 'new' }, ...context(10, 8)]
  const rows = buildDiffRows(lines, new Set())
  assert.deepEqual(rows.filter(row => row.kind === 'fold').map(row => [row.start, row.end]), [[0, 5], [13, 18]])
  assert.equal(rows.filter(row => row.kind === 'line').length, 8)
  const expanded = buildDiffRows(lines, new Set(['0:5']))
  assert.equal(expanded.filter(row => row.kind === 'line').length, 13)
})

test('DiffBlock source renders semantic colors, honest states and the 1000-line guard', async () => {
  const source = await readFile(new URL('../src/features/files/diff-block.tsx', import.meta.url), 'utf8')
  assert.equal(MAX_DIFF_LINES, 1000)
  assert.match(source, /text-diff-addition-foreground/)
  assert.match(source, /text-diff-deletion-foreground/)
  assert.match(source, /非 git 管理文件，暂不支持 diff/)
  assert.match(source, /diff 超过 1000 行，仅显示前 1000 行/)
  assert.match(source, /折叠 \{count\} 行未变更上下文/)
})

test('changed files request diffs only after a file row is expanded', async () => {
  const source = await readFile(new URL('../src/features/sessions/conversation.tsx', import.meta.url), 'utf8')
  assert.match(source, /const toggle = \(file: string\)/)
  assert.match(source, /if \(!nextOpen \|\| loads\[file\] \|\| !api \|\| !sessionId\) return/)
  assert.match(source, /api\.diffSessionFile\(sessionId, file\)/)
  assert.match(source, /正在加载 diff/)
})
