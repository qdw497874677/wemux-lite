# 02-03 SUMMARY — 查询缺口 (a)：共享 Task 计划与审查投影

状态：全部自动任务完成并通过；票 05 / NEXT-05 保持 in-progress（该票合并验收未完成，不整票勾选）。

## 交付

- `packages/web-contract/src/task-platform.ts`：新增共享投影类型与派生函数（`contractVersion: 2`）
  - `TaskPlanProjection`/`TaskPlanWindow`/`PlannedTurn`：权威计划版本 = `plan.proposed` 的 `turnId`、`text`、`steps`、`journalSeq`、`window.throughSeq`/`fromSeq`；无事件为 `null`；最多 500 条尾部事件，镜像 Web 窗口化推导。
  - `TaskReviewProjection`/`TaskReviewRequirement`：`authority` (`task`|`project`|`platform`)、`enforced`、`source`、`reviewerRoles`、`gate` (`none`|`manual`|`role`)。
  - `parsePlanSteps`：计划步骤唯一解析规则（编号行与 `- [ ]`/`* [x]` 复选框行），由 Web 计划卡与 Server 投影共用；Web 端 `apps/web/src/api/journal.ts` 改为 re-export（`export const parseProposedPlanSteps = parsePlanSteps`），不再有第二份实现。
- `apps/server/src/application/review-requirement.ts`（新）：审查要求解析的唯一权威 `resolveReviewRequirement(projectPolicy, taskOverride)` —— Task 钉选 → Project 默认 → 平台默认 `none`；Task 覆写空值**不得放宽**为 `none`，而是回退 Project。
- `apps/server/src/application/task-service.ts`：新增 `query(projectId, taskId, context)` 与 `queryList(projectId, context)`（原 `get`/`list` 签名不变，避免破坏既有 55 处调用），投影在读取前完成门槛判定。
- `apps/server/src/application/capability-service.ts`、`action-capabilities.ts`：`task.get`/`task.list` 改走 `query*`，返回投影 DTO。
- 测试：`apps/server/src/test/capability-task-projection.test.ts`（合法投影 + 门槛差异 + 拒绝矩阵）；`packages/web-contract/src/task-platform.test.ts` 增加共享解析规则测试。

## 验证结果（本次运行）

- `npm test --workspace @wemux/server`：**930/930 pass**，0 fail（含新测试文件 5 个用例）。
- `node --import tsx --test packages/web-contract/src/task-platform.test.ts`：6/6 pass；`npm run build:packages` 退出 0。
- `npm test --workspace @wemux/web`：297/297 pass（含源码契约扫描）；`npx tsc -p apps/web/tsconfig.json --noEmit` 退出 0。
- 门槛矩阵实测：Task 钉选 `role`/`manual`/空值三种覆写、Project 默认 `agent`/`none`、平台默认 `none`；空值覆写回退 Project 而非降级为 `none`。
- 拒绝矩阵实测：跨 Project 404（不泄露标题）、未授权账号 403/404、过期 token 401、撤权后 403/404；协调身份 `task.get` 404 且 `task.list` 任何分页都不含 `coordination:` 前缀条目（协调 Task 行确实存在，只是不在普通 Project 作用域）。
- 权限先于分页：`CapabilityService.events` 与 `queryList` 均先 `require` 权限再读缓存/分页；拒绝路径不返回条数。

## 未完成 / 边界

- 票 05 第 2、3 项（协调入口、真实 Worker 配对观测的整票签收）未完成，票面验收框不勾选；本次仅在验收文档追加「查询缺口 (a) 已补」段落，并明确协调专用 Task 不得由 `Project` 范围 Token 伪装。
- `project.list` 仍只允许来源 Project，不宣称跨项目发现（不在本切片范围）。

## 后续

- 02-05 写入通道矩阵依赖 02-02 禁用态 UX 人审 checkpoint；02-06 总账需引用本切片结论。