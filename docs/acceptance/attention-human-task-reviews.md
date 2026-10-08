# Ticket 07 人工 Task 审查待办增量

## 边界

`GET /api/attention/pages?kind=approval` 仅包含当前用户可处理的人工 Task Review。Session Journal 工具审批不参与此查询，不能从项目权限推断私人 Session 读取权。`task_assignment` 继续返回 `422 unsupported_attention_kind`，现有执行指派不是人工指派。旧 `/api/attention` 保留。

每次请求在同一 SQLite 事务内读取项目可见范围与审批来源。来源再校验项目 owner 或仍有 Team Membership 的 project manager，并排除提交者本人；只选择未删除、`in_review`、当前 Review、已冻结 human policy、最新成功 Run 且无活跃 Run 的任务。页面不下发决定能力或复用页面版本作写授权；链接进入 `/next/projects/:projectId?task=:taskId`，现有 Task 表面重新读取 Review/Task version，写接口仍校验身份、CAS 与 requestId。

SQL 每批最多 `limit + 1` 行，按 `requestedAt DESC, review id ASC` seek。共享 Review 元数据校验拒绝的候选不会造成过早耗尽，继续有界批次直到足够可用结果或来源耗尽；游标仅基于获权且可处理的行。追加独立索引迁移，不修改历史迁移版本。

## 已验证

- Server Attention 与 Task Run/Review 测试共 149 项通过，包括真实 HTTP 登录、self-review、成员撤销、跨来源/非法游标、CAS 冲突、重复决定与撤权后重放。
- SQLite 来源测试覆盖 timestamp ties、游标行失效、超过一页的 self-review、数字日期等无效元数据候选、政策冻结、当前 review、最新成功 Run/活跃 Run、关闭审查；没有扫描 Session Journal。
- 真 React + Chromium Attention 组件测试 11 项通过，覆盖分页、重试、账户/权限变化中断、项目过滤、审查链接和无伪造决定按钮。
- 浏览器真实 Server + Next 桌面 1440×1000、手机 390×844：Attention 审查链接进入实际 Task，使用当前 Review/CAS/requestId 批准后 Task done，刷新待办后该项消失。无 pageerror，手机无水平溢出。Run 成功是持久化合成夹具，不声称真实 Worker 执行。
- Web-next 边界/任务视图与 web-client 请求测试共 9 项通过；packages 构建、server/web-next typecheck、`git diff --check` 通过。

## 复验

```sh
npm run build:packages
npx tsx --test apps/server/src/test/attention*.test.ts apps/server/src/test/task-runs.test.ts
node --experimental-strip-types --test apps/web-next/tests/source-boundaries.test.mjs apps/web-next/tests/task-list-view.test.mjs apps/web-next/tests/task-session-options.test.mjs packages/web-client/tests/project-management.test.mjs
npm run typecheck --workspace @wemux/server
npm run typecheck --workspace @wemux/web-next
# 先提供真实绝对路径 PLAYWRIGHT_CORE_PATH 与 PLAYWRIGHT_CHROMIUM_PATH
npm run test:attention-browser --workspace @wemux/web-next
npx vite build --config apps/web-next/vite.config.ts --outDir /tmp/ticket07-attention-next-dist
WEMUX_NEXT_TEST_DIST=/tmp/ticket07-attention-next-dist node --import tsx apps/e2e/next-attention-review-browser.mjs
```

本次脱敏日志位于 `/tmp/ticket07-attention-*.log`；浏览器截图与断言摘要位于 `/tmp/wemux-next-attention-review-DvXfcJ/`。没有提交或暂存文件。

## 限制

分页不提供跨请求快照；授权或状态变化会移除条目，客户端需刷新。LIMIT 限制结果物化数量而非扫描行数；实际 EXPLAIN 对单项目夹具选择 `review_requests_pending` 加排序，新增有序索引可由 SQLite 按数据分布选择。不宣称常数扫描成本。Task 详情现有 Review 读取仍是独立旧接口，本增量不改为有界详情读取。此验证不是 Ticket 07 的 Agent/多阶段审查或其他未实现功能的全量验收。
