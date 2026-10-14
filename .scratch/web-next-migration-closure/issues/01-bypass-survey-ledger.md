# 01: 无 Task 旁路勘察与操作级迁移登记表

Status: done
Blocked by: 无；只读勘察和迁移登记可先行，未实现或未验证的功能如实登记，不等待其他 spec 整体完成。

**Spec:** [迁移收口与旧版移除条件](../spec.md)
**合并来源:** `43966aa` 的原票 01、02。
**What to build:** 定位旧根前端、旧 Worker 工作台与所有无 Task 兼容入口，明确调用方与移除顺序；把平台规格 §4 逐行细化成操作级迁移登记表，两份结果在同票交付。本票不改产品行为。

## 实现计划

1. 从旧 `apps/web` 与 Worker local-workbench 创建/发送调用反查 Server 路由，列仍可访问的无 Task 入口及数据兼容路径。
2. 以平台规格 §4 每行拆为操作、角色、权限和证据；新增派发、自主推进、运行形态单列到[需求基线](../../../docs/specs/ai-workbench-requirements-alignment.md)，不使用旧签收覆盖。
3. 对照行为测试/路由可达性标实现与验证状态，形成转换顺序；本票仅报告，不移除代码。

## 旁路勘察

- [x] 列出全部无 Task 兼容入口与调用方，含路径、调用场景与是否仍在被使用
- [x] 每个旁路入口标注应替换到的合法 Task Session 路径
- [x] 产出改造清单与旁路移除顺序建议
- [x] 报告区分已实现、已验证与未完成，含可复查证据
- [x] 不修改产品行为，仅勘察

## 操作级登记表

- [x] 每行落到操作级（入口、角色、权限、证据、状态）
- [x] 状态明确区分已实现、已验证、未完成
- [x] 每项已验证条目附可复查证据路径或断言输出
- [x] 未完成项登记为缺口与责任票；新增目标按已确认 D5 单列纳入本次切换范围，不以旧验收覆盖
- [x] 登记表入库（脱敏），原始证据留 `.scratch/`（按任务书改留 `/var/tmp/wemux-m01-verify/`，见验收记录）

## 交付物

- 旁路勘察报告：`docs/acceptance/web-next-migration-closure-bypass-survey.md`，B-01…B-10 旁路/兼容入口 + 调用方转换清单 5 行 + 移除顺序 4 步 + 差异 D-01…D-06 + 缺口 G-01…G-04。
- 操作级迁移登记表：`docs/acceptance/web-next-migration-closure-operation-ledger.md`，按平台规格 §4-1…§4-13 逐行登记 + 新增目标（D5）单列 10 行 + 缺口汇总 G-01…G-07。
- 复查脚本：`scripts/migration-bypass-survey.mjs`（只读源码断言 29 条，`--root <dir>` / `--json <path>`，任一不符退出码 1）。

## 验收记录（2026-02-14，工作树 `/tmp/wemux-m01`，分支 `migration-01-survey`，基点 `8cf9bff`）

**验证命令与退出码**（证据根 `/var/tmp/wemux-m01-verify/`，原始输出不入库）：

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `node scripts/migration-bypass-survey.mjs --json /var/tmp/wemux-m01-verify/bypass-inventory.json` | 29/29 OK，EXIT=0 | `bypass-survey.log`、`bypass-inventory.json` |
| `node --import tsx --test apps/server/src/test/task-session-contract.test.ts` | 19/19，EXIT=0 | `task-session-contract.log` |
| `node --import tsx --test apps/server/src/test/task-delete.test.ts apps/server/src/test/task-delete-artifacts.test.ts` | 5/5，EXIT=0 | `task-delete.log` |
| Server 定向批 12 个测试文件（task-runs 126、task-workspaces 18、session-workbench 16、tasks 7、team-coordination-task 7、capability-task-projection 8、session-effect-authorization 3、task-assignment-http 2、task-completion-http 1、task-metadata-contract 1、task-workspace-create-idempotency 1、session-authorization-http 1） | 191/191，全部 EXIT=0 | `server/*.log` |
| `node --import tsx --test apps/worker/test/local-workbench.test.ts` | 3/3，EXIT=0 | `local-workbench.log` |
| `npm run build:packages` | EXIT=0 | 命令记录 |

**验收项证据对照**

- 旁路勘察①：报告 B-01…B-10 逐行含入口与行号、调用方、调用场景、是否仍在使用；源码断言脚本 S1–S4 / C1–C4 / W1–W5 锁定。
- 旁路勘察②：每行给出合法 Task Session 替代路径（集群侧 `POST /api/projects/:projectId/tasks/:taskId/sessions`，本地侧待双宿主 13 提供）。
- 旁路勘察③：报告“调用方转换清单”5 行 + “移除顺序建议”4 步。
- 旁路勘察④：报告与登记表使用统一状态词（已验证（本票）/已验证（既有）/已实现未验证/未实现/被替代/未实施），每条附证据指针。
- 旁路勘察⑤：本票只新增只读脚本与文档，未改产品行为；`git status` 仅三个新增文件。
- 登记表①：约 70 行按 §4-1…§4-13 分组，每行含操作、新版入口、角色/权限、状态、证据、责任票。
- 登记表②③：见状态列与证据列；本票新增断言级证据指向 `/var/tmp/wemux-m01-verify/`。
- 登记表④：缺口 G-01…G-07 逐条挂责任票；D5 新增目标单列 10 行，明确不由 NEXT-03/04 历史完成覆盖。
- 登记表⑤：两份文档入库（脱敏），原始扫描输出按任务书留 `/var/tmp/wemux-m01-verify/`（票据原文写 `.scratch/`，本任务书明确要求原始证据留 `/var/tmp`，以任务书为准）。

**边界与残余风险**

- 本机无 playwright-core 与 chromium 缓存，本票未执行浏览器验收；“已验证（本票）”仅到断言/测试级，浏览器级证据由 03 补齐。
- phase1-candidate 记载的源指纹在本票探针下未能复现，仓库无指纹生成脚本，故本票不判定“同候选”，留给 03。

**与票据假设不符之处**

- D-01：集群侧已无“新建无 Task Session”旁路，`POST /api/sessions` 省略 taskId 会被自动绑定专用 Task；旁路只剩本地宿主与 legacy 读兼容。
- D-06：基线“Task DELETE 无合同”已过时，`DELETE /projects/:projectId/tasks/:taskId` 已实现并有 5/5 测试。

**范围外声明**：本票不删除任何旁路、不改调用方、不实施切根、不勾选 NEXT-15，不修改其他票据文件。
