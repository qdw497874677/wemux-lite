#!/usr/bin/env node
/**
 * 迁移收口 01：无 Task 旁路勘察（只读、可重复）
 *
 * 用途：在给定提交上重新生成"无 Task 兼容入口 / 调用方"的源码级断言清单，
 * 作为 `docs/acceptance/web-next-migration-closure-bypass-survey.md` 的证据来源。
 * 脚本只读源码，不写入仓库、不启动服务、不修改产品行为。
 *
 * 运行：
 *   node scripts/migration-bypass-survey.mjs
 *   node scripts/migration-bypass-survey.mjs --json /var/tmp/wemux-m01-verify/bypass-inventory.json
 *   node scripts/migration-bypass-survey.mjs --root /tmp/wemux-m01
 *
 * 退出码：0 = 全部断言符合当前勘察结论；1 = 至少一条断言不符（说明代码实况已变化，
 * 必须先更新勘察报告与调用方转换清单，再考虑移除旁路）。
 *
 * 断言分两类：
 *   present —— 该标记必须存在（旁路入口、兼容读路径、存储不变量、合法替代路径）；
 *   absent  —— 该标记必须不存在（例如本地工作台里不得出现 taskId，证明本地 Task 尚未实现）。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const readFlag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const repoRoot = resolve(readFlag('--root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const jsonOut = readFlag('--json')

/** @type {{id: string, group: string, claim: string, file: string, kind: 'present'|'absent', pattern: string}[]} */
const checks = [
  // ---- 组 1：Server 集群路径的创建入口（无 taskId 形态仍被接受，但已强制绑定专用 Task）----
  {
    id: 'S1',
    group: 'server-cluster-entry',
    claim: 'POST /api/sessions 仍接受不带 taskId 的创建请求',
    file: 'apps/server/src/http/routes/session-routes.ts',
    kind: 'present',
    pattern: 'createSession(await context.readBody',
  },
  {
    id: 'S2',
    group: 'server-cluster-entry',
    claim: '无 taskId 的集群创建请求由 Server 自动创建专用 Task',
    file: 'apps/server/src/application/server-service.ts',
    kind: 'present',
    pattern: 'dedicatedConversationTask(tx, workspace.projectId',
  },
  {
    id: 'S3',
    group: 'server-cluster-entry',
    claim: '专用 Task 助手存在且按用户/项目/环境/场景复用',
    file: 'apps/server/src/application/dedicated-conversation-task.ts',
    kind: 'present',
    pattern: 'export async function dedicatedConversationTask',
  },
  {
    id: 'S4',
    group: 'server-cluster-entry',
    claim: '集群创建入口不再接受 taskId:null 的新写入（legacy 仅重放既有记录）',
    file: 'apps/server/src/application/server-service.ts',
    kind: 'present',
    pattern: 'previous.taskId == null && previous.runId == null',
  },
  // ---- 组 2：合法 Task Session 替代路径（调用方应转换到的目标）----
  {
    id: 'L1',
    group: 'legal-task-session',
    claim: 'Task 内创建 Session 的 HTTP 路由存在',
    file: 'apps/server/src/http/routes/task-routes.ts',
    kind: 'present',
    pattern: "'/projects/:projectId/tasks/:taskId/sessions'",
  },
  {
    id: 'L2',
    group: 'legal-task-session',
    claim: 'Task Service 通过 createSessionInTx 固定 taskId/runId 归属',
    file: 'apps/server/src/application/task-service.ts',
    kind: 'present',
    pattern: '{ taskId: id, runId: null, ownerId: context.actor, shareScope:',
  },
  {
    id: 'L3',
    group: 'legal-task-session',
    claim: '新版客户端提供 createDedicatedSession（/api/sessions + scenario）',
    file: 'packages/web-client/src/task-sessions.ts',
    kind: 'present',
    pattern: 'createDedicatedSession(',
  },
  {
    id: 'L4',
    group: 'legal-task-session',
    claim: '新版试聊组件调用 createDedicatedSession',
    file: 'apps/web-next/src/components/ProjectConversation.tsx',
    kind: 'present',
    pattern: 'api.createDedicatedSession(',
  },
  {
    id: 'L5',
    group: 'legal-task-session',
    claim: '新版会话控制器要求 session.taskId 与 scope 一致（无法打开无 Task 旧会话）',
    file: 'packages/web-client/src/conversation-controller.ts',
    kind: 'present',
    pattern: 'value.taskId !== scope.taskId',
  },
  {
    id: 'L6',
    group: 'legal-task-session',
    claim: '新版会话组件把 taskId 作为必填参数',
    file: 'apps/web-next/src/components/SessionConversation.tsx',
    kind: 'present',
    pattern: 'taskId: string',
  },
  // ---- 组 3：旧调用方（尚未转换）----
  {
    id: 'C1',
    group: 'legacy-callers',
    claim: '旧根前端快捷会话仍调用 createSession 且不传 taskId',
    file: 'apps/web/src/features/sessions/quick-start.ts',
    kind: 'present',
    pattern: 'this.api.createSession({ requestId: attempt.requestId',
  },
  {
    id: 'C2',
    group: 'legacy-callers',
    claim: '旧根前端快捷会话文件不出现 taskId（未转换的证明）',
    file: 'apps/web/src/features/sessions/quick-start.ts',
    kind: 'absent',
    pattern: 'taskId',
  },
  {
    id: 'C3',
    group: 'legacy-callers',
    claim: '旧根前端 API 客户端 createSession 打到 /api/sessions',
    file: 'apps/web/src/api/client.ts',
    kind: 'present',
    pattern: "createSession: '/api/sessions'",
  },
  {
    id: 'C4',
    group: 'legacy-callers',
    claim: '旧根前端本地宿主仍调用 Worker 工作台创建会话（无 taskId）',
    file: 'apps/web/src/hosts/local-session.ts',
    kind: 'present',
    pattern: "'workbench/sessions'",
  },
  // ---- 组 4：Worker 本地宿主的无 Task 创建旁路（本地 Task 未实现）----
  {
    id: 'W1',
    group: 'worker-local-bypass',
    claim: 'Worker 本地控制面暴露 POST /api/local/workbench/sessions',
    file: 'apps/worker/src/local-control/server.ts',
    kind: 'present',
    pattern: 'workbench.createSession({ workspaceId: body.workspaceId',
  },
  {
    id: 'W2',
    group: 'worker-local-bypass',
    claim: 'Worker 本地工作台 createSession 签名不含 taskId',
    file: 'apps/worker/src/application/local-workbench.ts',
    kind: 'present',
    pattern: 'createSession(input: { workspaceId: string; agentKey: string; modelId: string | null; requestId?: string })',
  },
  {
    id: 'W3',
    group: 'worker-local-bypass',
    claim: 'Worker 本地工作台不存在任何 taskId 概念（本地 Task 未实现）',
    file: 'apps/worker/src/application/local-workbench.ts',
    kind: 'absent',
    pattern: 'taskId',
  },
  {
    id: 'W4',
    group: 'worker-local-bypass',
    claim: '无 Web bundle 时使用内联兜底工作台表单创建会话',
    file: 'apps/worker/src/local-control/client.ts',
    kind: 'present',
    pattern: '/api/local/workbench/sessions',
  },
  {
    id: 'W5',
    group: 'worker-local-bypass',
    claim: 'Worker 本地 Web 优先服务旧共享 Web 构建产物',
    file: 'apps/worker/src/cli.ts',
    kind: 'present',
    pattern: 'webStaticPath: hasWebBundle ? webStaticPath : undefined',
  },
  // ---- 组 5：legacy 无 Task 数据的读兼容与存储不变量 ----
  {
    id: 'R1',
    group: 'legacy-read-compat',
    claim: '会话列表过滤签名容忍 taskId 为 null（legacy 读）',
    file: 'apps/server/src/http/routes/session-routes.ts',
    kind: 'present',
    pattern: 'taskId?: string | null',
  },
  {
    id: 'R2',
    group: 'legacy-read-compat',
    claim: '终端流对无 Task 旧会话走兼容分支',
    file: 'apps/server/src/http/routes/session-routes.ts',
    kind: 'present',
    pattern: 'if (session.taskId && context.tasks)',
  },
  {
    id: 'R3',
    group: 'legacy-read-compat',
    claim: '契约层为 legacy 记录保留 taskId: string | null',
    file: 'packages/web-contract/src/conversation.ts',
    kind: 'present',
    pattern: "readonly taskId: string | null",
  },
  {
    id: 'R4',
    group: 'legacy-read-compat',
    claim: 'web-client 会话读取层把缺失 taskId 规范化为 null',
    file: 'packages/web-client/src/session-conversation.ts',
    kind: 'present',
    pattern: 'taskId: raw.taskId ?? null',
  },
  {
    id: 'R5',
    group: 'legacy-read-compat',
    claim: '存储层拒绝改写 Session 归属（provenance 不可变）',
    file: 'apps/server/src/storage/sqlite/run-invariants.ts',
    kind: 'present',
    pattern: "RAISE(ABORT,'Session creation provenance is immutable')",
  },
  {
    id: 'R6',
    group: 'legacy-read-compat',
    claim: 'Session 类型注释承认 legacy 无 Task 记录',
    file: 'packages/server-domain/src/resources.ts',
    kind: 'present',
    pattern: 'absent only on legacy standalone Sessions',
  },
  // ---- 组 6：旧版入口整体（由切根票删除，不在本 spec 内执行）----
  {
    id: 'O1',
    group: 'legacy-shell',
    claim: '旧根前端集群路由清单仍存在',
    file: 'apps/web/src/app/host-paths.ts',
    kind: 'present',
    pattern: 'clusterPaths',
  },
  {
    id: 'O2',
    group: 'legacy-shell',
    claim: '旧根前端本地宿主路由清单仍存在',
    file: 'apps/web/src/app/host-paths.ts',
    kind: 'present',
    pattern: 'localPaths',
  },
  {
    id: 'O3',
    group: 'legacy-shell',
    claim: '新版壳保留旧版控制台入口',
    file: 'apps/web-next/src/components/Shell.tsx',
    kind: 'present',
    pattern: '<a href="/">旧版控制台',
  },
  {
    id: 'O4',
    group: 'legacy-shell',
    claim: '新版对独立 Worker 宿主明确标注未迁移本地任务与会话',
    file: 'apps/web-next/src/App.tsx',
    kind: 'present',
    pattern: '新版尚未迁移本地任务与会话',
  },
]

const results = checks.map((check) => {
  const path = resolve(repoRoot, check.file)
  const base = { ...check, exists: existsSync(path) }
  if (!base.exists) return { ...base, ok: false, line: null }
  const source = readFileSync(path, 'utf8')
  const lines = source.split('\n')
  const found = lines.findIndex((line) => line.includes(check.pattern))
  const ok = check.kind === 'present' ? found >= 0 : found < 0
  return { ...base, ok, line: found >= 0 ? found + 1 : null }
})

const failed = results.filter((r) => !r.ok)
const groups = [...new Set(results.map((r) => r.group))]

const width = Math.max(...results.map((r) => r.id.length))
for (const group of groups) {
  process.stdout.write(`\n## ${group}\n`)
  for (const r of results.filter((x) => x.group === group)) {
    const mark = r.ok ? 'OK  ' : 'FAIL'
    const where = r.line ? `${r.file}:${r.line}` : r.exists ? `${r.file}:(not found)` : `${r.file}:(missing file)`
    process.stdout.write(`${mark} ${r.id.padEnd(width)}  ${where}\n`)
    process.stdout.write(`     ${r.kind === 'present' ? '存在' : '不存在'}: ${r.pattern}\n`)
    process.stdout.write(`     断言: ${r.claim}\n`)
  }
}
process.stdout.write(`\n共 ${results.length} 条断言，失败 ${failed.length} 条。\n`)

if (jsonOut) {
  mkdirSync(dirname(resolve(jsonOut)), { recursive: true })
  writeFileSync(
    resolve(jsonOut),
    `${JSON.stringify({ repoRoot, total: results.length, failed: failed.length, results }, null, 2)}\n`,
  )
  process.stdout.write(`清单已写入 ${resolve(jsonOut)}\n`)
}

process.exit(failed.length === 0 ? 0 : 1)
