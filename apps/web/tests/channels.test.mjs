import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const page = await readFile(new URL('../src/features/channels/channel-page.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const client = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8')

test('Channel 管理页覆盖创建、一次性 token、binding、诊断与重放', () => {
  for (const label of ['创建 Generic Webhook Channel', '一次性 Channel 令牌', '创建 binding', 'Delivery 诊断', '重放']) assert.match(page, new RegExp(label))
  assert.match(page, /randomId\(\)/)
  assert.doesNotMatch(page, /crypto\.randomUUID/)
  assert.match(page, /copyText\(issuedToken\)/)
  assert.match(page, /selectElementText/)
})

test('Channel 路由接入应用并使用 typed API', () => {
  assert.match(app, /section === 'channels'/)
  assert.match(client, /createChannelBinding/)
  assert.match(client, /replayChannelDelivery/)
  assert.match(client, /@wemux\/web-contract\/channels/)
})
