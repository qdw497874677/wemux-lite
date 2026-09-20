import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const client = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8')
const dto = await readFile(new URL('../src/api/dto.ts', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/components/worker-access.tsx', import.meta.url), 'utf8')
const cluster = await readFile(new URL('../src/components/cluster-page.tsx', import.meta.url), 'utf8')

test('Worker access Web contract exposes use/manage without reusing Project roles', () => {
  assert.match(dto, /accessRole: 'owner' \| 'use' \| 'manage'/)
  assert.match(dto, /shareScope: 'owner-only' \| 'selected-members' \| 'team'/)
  assert.match(client, /workerGrants:/)
  assert.match(client, /updateWorkerAccess:/)
  assert.match(client, /grantWorker:/)
  assert.match(client, /revokeWorkerGrant:/)
  assert.match(panel, /Team 全员可使用/)
  assert.match(panel, /你拥有 use 权限/)
  assert.match(cluster, /worker\.accessRole === 'owner' \|\| worker\.accessRole === 'manage'/)
  assert.match(cluster, /<WorkerAccessPanel/)
  assert.match(cluster, /canEnrollWorkers/)
  assert.match(cluster, /当前账号没有可使用的工作节点/)
})
