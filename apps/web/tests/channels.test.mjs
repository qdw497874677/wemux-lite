import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const page = await readFile(new URL('../src/features/channels/channel-page.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const client = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8')

test('Channel 管理页覆盖创建、一次性 token、binding、诊断与重放', () => {
  for (const label of ['创建 Channel', 'Generic Webhook', '一次性 Channel 令牌', '创建 binding', 'Delivery 诊断', '重放']) assert.match(page, new RegExp(label))
  assert.match(page, /randomId\(\)/)
  assert.doesNotMatch(page, /crypto\.randomUUID/)
  assert.match(page, /copyText\(issuedToken\)/)
  assert.match(page, /selectElementText/)
})

test('飞书 Channel 表单展示凭证、事件订阅 URL、binding 与诊断', () => {
  for (const label of ['飞书应用机器人', 'App ID', 'App Secret', 'Verification Token', 'Encrypt Key（可选）', '事件订阅 URL', '保存飞书配置', '连接测试']) assert.match(page, new RegExp(label.replace(/[（）]/g, value => `\\${value}`)))
  assert.match(page, /kind === 'feishu'/)
  assert.match(page, /externalConversationKey/)
  assert.doesNotMatch(page, /crypto\.randomUUID/)
})

test('Channel 路由接入应用并使用 typed API', () => {
  assert.match(app, /section === 'channels'/)
  assert.match(client, /createChannelBinding/)
  assert.match(client, /replayChannelDelivery/)
  assert.match(client, /@wemux\/web-contract\/channels/)
})
