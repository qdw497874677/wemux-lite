import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = path => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')
const page = await source('components/account-page.tsx')
const client = await source('api/client.ts')
const legacyDto = await source('api/dto.ts')
const sharedDto = await readFile(new URL('../../../packages/web-contract/src/browser-host.ts', import.meta.url), 'utf8')
const dto = `${legacyDto}\n${sharedDto}`
assert.match(legacyDto, /export type \{[^}]+AccountStatusDTO[^}]*\} from '@wemux\/web-contract\/browser-host'/)

test('账号生命周期与可筛选审计只走统一 API client', () => {
  assert.match(client, /accountLifecycle: '\/api\/auth\/account\/lifecycle'/)
  assert.match(client, /accountAudit: '\/api\/auth\/account\/audit'/)
  assert.match(client, /accountAuditExport: '\/api\/auth\/account\/audit\/export'/)
  assert.match(client, /managedAccountAction: \(userId: string, action: 'disable' \| 'restore' \| 'request-deletion' \| 'confirm-deletion'\)/)
  assert.match(client, /audit: \(query: AuditQueryDTO/)
  assert.match(dto, /export type AccountStatusDTO = 'active' \| 'disabled' \| 'deletion_pending' \| 'deleted'/)
  assert.match(dto, /export interface AuditPageDTO/)
  assert.doesNotMatch(page, /\bfetch\(/)
})

test('账号页说明销号边界、所有权阻断与审计筛选', () => {
  assert.match(page, /销号不会删除团队聊天、任务历史或 Worker 文件/)
  assert.match(page, /去标识用户名与邮箱/)
  assert.match(page, /输入“删除我的账号”确认/)
  assert.match(page, /lifecycle\.data\?\.blockers/)
  assert.match(page, /api\.confirmAccountDeletion/)
  assert.match(page, /api\.manageAccount\(account\.id, 'disable'\)/)
  assert.match(page, /api\.manageAccount\(account\.id, 'restore'\)/)
  assert.match(page, /动作/)
  assert.match(page, /开始时间/)
  assert.match(page, /结束时间/)
  assert.match(page, /导出 NDJSON/)
  assert.match(page, /api\.auditExportUrl/)
})
