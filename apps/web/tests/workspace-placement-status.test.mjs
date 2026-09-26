import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { workspaceStateLabel } from '../src/lib/display.ts'

const clusterPage = await readFile(new URL('../src/components/cluster-page.tsx', import.meta.url), 'utf8')

test('workspace placement labels cover the five lifecycle states', () => {
  assert.deepEqual(workspaceStateLabel, {
    ready: '运行中',
    stopped: '已停止',
    deleted: '已删除',
    failed: '创建失败',
    unhealthy: '不健康',
  })
})

test('cluster workspace table renders placement status, reason and retry affordance', () => {
  assert.match(clusterPage, /workspace\.placements\.map\(placement/)
  assert.match(clusterPage, /workspaceStateLabel\[placement\.status\]/)
  assert.match(clusterPage, /placement\.failureReason/)
  assert.match(clusterPage, /placement\.status === 'stopped' \|\| placement\.status === 'failed'/)
  assert.match(clusterPage, /api\.reprovisionWorkspace\(workspace\.id, placement\.workerId\)/)
})
