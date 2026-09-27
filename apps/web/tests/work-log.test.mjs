import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeWorkLogEntry } from '../src/features/sessions/work-log.ts'

test('normalizes shell tools as command activity', () => {
  assert.deepEqual(normalizeWorkLogEntry({ toolName: 'bash', input: { command: 'npm test' }, output: '', status: 'running', exitCode: null }), {
    tone: 'tool',
    action: 'command',
    toolTitle: '运行命令',
    detail: 'npm test',
  })
})

test('normalizes file reads and edits with changed files', () => {
  assert.deepEqual(normalizeWorkLogEntry({ toolName: 'read', input: { path: 'src/app.ts' }, output: 'source', status: 'completed', exitCode: 0 }), {
    tone: 'tool',
    action: 'read',
    toolTitle: '读取文件',
    detail: 'src/app.ts',
  })
  assert.deepEqual(normalizeWorkLogEntry({ toolName: 'write', input: { path: 'src/app.ts' }, output: 'ok', status: 'completed', exitCode: 0 }), {
    tone: 'tool',
    action: 'edit',
    toolTitle: '编辑文件',
    changedFiles: ['src/app.ts'],
    detail: 'src/app.ts',
  })
})

test('normalizes failed tools with an error tone', () => {
  assert.deepEqual(normalizeWorkLogEntry({ toolName: 'bash', input: { command: 'false' }, output: 'exit 1', status: 'failed', exitCode: 1 }), {
    tone: 'error',
    action: 'command',
    toolTitle: '运行命令失败',
    detail: 'exit 1',
  })
})
