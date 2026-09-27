import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
const page=readFileSync(new URL('../src/features/connectors/connector-page.tsx',import.meta.url),'utf8')
const client=readFileSync(new URL('../src/api/client.ts',import.meta.url),'utf8')
test('连接器管理页提供 CRUD、凭证状态、测试和错误重试',()=>{for(const text of ['新建 HTTP 连接器','未配置','可用','失效','Worker 本地配置说明','测试连接','重试'])assert.match(page,new RegExp(text));assert.match(client,/createConnector/);assert.match(client,/updateConnector/);assert.match(client,/setConnectorEnabled/);assert.match(client,/testConnector/)})
test('连接器 Web 写请求使用 randomId 且不携带秘密字段',()=>{assert.match(page,/randomId\(\)/);assert.doesNotMatch(page,/crypto\.randomUUID/);for(const forbidden of ['api'+'Key','app'+'Secret','authoriz'+'ation','cipher'+'text'])assert.equal((page+client).toLowerCase().includes(forbidden.toLowerCase()),false)})
