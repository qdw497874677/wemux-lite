import assert from 'node:assert/strict'
import test from 'node:test'
import { approvalPresentation } from '../src/features/sessions/approval-presentation.ts'

test('presents command approvals with command text and cwd', () => {
  assert.deepEqual(approvalPresentation({ kind: 'command', command: 'npm test', cwd: '/workspace/project' }, ''), {
    kind: 'command', title: 'Agent \u8bf7\u6c42\u6267\u884c\u547d\u4ee4', command: 'npm test', cwd: '/workspace/project',
  })
})

test('presents write and file approvals as unique target paths', () => {
  assert.deepEqual(approvalPresentation({ kind: 'write', files: [{ path: 'src/a.ts' }, 'src/b.ts', { path: 'src/a.ts' }] }), {
    kind: 'files', title: 'Agent \u8bf7\u6c42\u4fee\u6539\u6587\u4ef6', paths: ['src/a.ts', 'src/b.ts'],
  })
})

test('prefers reason for unknown approval summaries', () => {
  assert.deepEqual(approvalPresentation({ kind: 'network', description: '\u5c06\u8fde\u63a5\u5916\u90e8\u670d\u52a1' }, '\u9700\u8981\u7f51\u7edc\u8bbf\u95ee'), {
    kind: 'summary', title: '\u5f85\u5ba1\u6279\u64cd\u4f5c', summary: '\u9700\u8981\u7f51\u7edc\u8bbf\u95ee',
  })
})
