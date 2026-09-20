import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const root = new URL('../src/', import.meta.url)
const read = name => readFile(new URL(name, root), 'utf8')

test('项目设置提供共享范围与成员角色管理', async () => {
  const [panel, app, client] = await Promise.all([read('components/project-access.tsx'), read('App.tsx'), read('api/client.ts')])
  assert.match(app, /<ProjectAccessPanel api=\{api\} project=\{project\}/)
  assert.match(panel, /owner-only/)
  assert.match(panel, /selected-members/)
  assert.match(panel, /Team 全员只读/)
  assert.match(panel, /viewer/)
  assert.match(panel, /contributor/)
  assert.match(panel, /manager/)
  assert.match(client, /updateProjectAccess/)
  assert.match(client, /grantProject/)
  assert.match(client, /revokeProjectGrant/)
})
