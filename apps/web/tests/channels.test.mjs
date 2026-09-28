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

test('钉钉 Stream Channel 表单展示凭证、连接说明与在线诊断', () => {
  for (const label of ['钉钉 Stream 机器人', 'Client ID', 'Client Secret', '机器人 Code', '启用 Stream 模式', '无需公网回调地址', '保存钉钉配置', '连接中', '离线']) assert.match(page, new RegExp(label))
  assert.match(page, /kind === 'dingtalk'/)
  assert.match(page, /testChannel/)
})

test('Channel 令牌轮换仅对管理者展示并一次性显示新值', () => {
  for (const label of ['轮换令牌', '旧令牌将在 15 分钟后失效', '一次性 Channel 令牌']) assert.match(page, new RegExp(label))
  assert.match(page, /canManage/)
  assert.match(page, /rotateChannelToken/)
  assert.match(client, /channelTokenRotation/)
})

test('Channel 删除入口要求先停用并显示确认对话框', () => {
  for (const label of ['删除 Channel', '请先停用 Channel', '投递诊断保留 30 天']) assert.match(page, new RegExp(label))
  assert.match(page, /useConfirmDialog/)
  assert.match(page, /disabled=\{item\.enabled/)
  assert.match(client, /deleteChannel/)
  assert.match(client, /'DELETE'/)
})

test('Channel 路由接入应用并使用 typed API', () => {
  assert.match(app, /section === 'channels'/)
  assert.match(client, /createChannelBinding/)
  assert.match(client, /replayChannelDelivery/)
  assert.match(client, /@wemux\/web-contract\/channels/)
})
