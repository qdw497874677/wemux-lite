# 01: Worker / Agent / Model / Skill / Preset / Provider 管理面

Status: ready-for-human
Blocked by: 无未完成 ticket 前置；复用现有 Project/Workspace、Worker 与授权基线，不依赖画布、连接器或计划交接验收。

**Spec:** [资源管理与独立 Worker 双宿主](../spec.md)
**合并来源:** `43966aa` 的原票 01（范围不变）。
**What to build:** 管理员在一个管理面管理 Worker、Agent 能力、Model、Skill、Preset、Provider，四态（已配置、已认证、已分发、可执行）分离展示，版本与能力来自运行时真实探测。

## 实现计划

1. 盘点 Worker discovery、runtimes/management 与 ResourceReconciler，资源版本及认证/可执行状态只从真实探测投影。
2. Server 授权管理 API 与 web-next 管理面共用状态；远程托管安装需显式确认，固定版本、独立目录，不作为 Worker 启动依赖。
3. 测未安装/未认证/离线、安装失败与撤权、Secret 脱敏；真实浏览器覆盖四态及失败恢复。执行容量合同归[派发 spec](../../web-next-task-dispatch/spec.md)，不混用分发并发上限。

## 验收

- [ ] 六类资源均可列出、查看与配置（列出与查看已完成并验证；web-next 管理面目前是只读投影，配置仍走既有 `/api/resources*` 授权管理 API，管理面内的配置动作未实现）
- [x] 四态分离展示，配置状态不冒充可执行状态
- [x] 版本与能力来自真实探测，探测失败如实上报不可用
- [ ] 远程安装 Agent 不覆盖全局安装，失败给出明确原因（失败原因上报已验证；托管安装的固定版本与 Worker home 独立目录是既有 `ResourceReconciler` 行为，本票未新增针对远程安装入口的验收，且 Web 远程安装入口尚未实现）
- [x] 无权限用户不能修改管理面配置
- [x] 断言与截图作为证据留存

## 验收记录（2026-10-14，分支 `dualhost-01-resources`，基点 `8cf9bff`，已 merge `main`@`b1637cc`）

实现提交（均为中文提交，重构与功能分开）：

| 提交 | 内容 |
| --- | --- |
| `05d443c` | `packages/domain/src/resource-inventory.ts` 四态契约与推导 helper + 契约测试 |
| `f1fbc03` | `apps/server/src/application/resource-inventory-service.ts` 六类资源投影服务 + 服务测试 |
| `03b7a20` | `Worker.capabilitiesObservedAt` 持久化探测时刻并作为探测证据展示 |
| `5db31c9` | `GET /api/resource-inventory`（admin）路由 + 真 HTTP 授权矩阵测试 |
| `1a50c25` | `web-contract` 的 `ResourceInventoryDTO` + `web-client` 只读操作 |
| `b9dec90` | web-next `/next/resources` 四态管理面与管理员门 + 组件测试 |
| `cf78b22` | 资源级条目的分发版本退回 Worker 回执版本（修复） |
| `2fd9c1e` | `apps/e2e/next-resource-management-browser.mjs` 双宿主浏览器验收脚本 |

验证命令与退出码（日志均在 `/var/tmp/wemux-d01-*.log`）：

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| `npm run build:packages` | 0 | `wemux-d01-build-packages.log` |
| `npm run typecheck`（全 workspace） | 0 | `wemux-d01-typecheck-all.log` |
| `node --import tsx --test apps/server/src/test/*.test.ts`（996 用例） | 0 | `wemux-d01-server-tests.log` |
| `node --test "packages/domain/tests/*.test.mjs"`（13 用例） | 0 | `wemux-d01-domain-tests.log` |
| `node --import tsx --test "packages/**/*.test.ts"`（144 用例） | 0 | `wemux-d01-packages-ts-tests.log` |
| `node --test "packages/**/*.test.mjs"`（339 用例） | 0 | `wemux-d01-packages-mjs-tests.log` |
| `npm test --workspace @wemux/web-client`（320 用例） | 0 | `wemux-d01-webclient-test.log` |
| web-next 全量（`tests/*.test.mjs` + `src/components/__tests__/*.test.mjs`，177 用例，含真 Chromium） | 0 | `wemux-d01-webnext-all-tests.log` |
| `node --import tsx apps/e2e/next-resource-management-browser.mjs` | 0 | `wemux-d01-e2e-resources.log` |

真浏览器双宿主验收（`apps/e2e/next-resource-management-browser.mjs`，可重复脚本已入库）：真 Server 服务真 web-next dist、真 Worker CLI（在线节点 + 只注册不启动的离线节点）、真资源授权与真物化回执、真 Chromium，覆盖 desktop/mobile 两轮与非管理员一轮。

- 六类分区 2/8/95/2/0/1（Worker/Agent/Model/Skill/Preset/Provider）全部渲染，每条资源四条状态轴分开呈现（`data-axis` 四个）。
- 四态分离断言：Worker `已配置｜无已发布修订｜已注册到集群` 与 `已认证｜已通过 Worker 凭据认证` 不合并；技能 `已配置｜修订 v1` 与 `已分发｜期望态 v3｜Worker 已确认安装并就绪｜探测于 …` 分别成立；Provider 认证 `未认证` 只来自 Worker 回执；凭据只出现变量名 `OPENAI_API_KEY`，页面无 `OPENAI_API_KEY=` 与 `sk-…` 取值。
- 真实探测与失败如实上报：真 Worker 物化技能回执 `installed/ready` 且 `integrity === revision.contentSha256`；伪造 blob 的技能真物化失败，界面显示 `分发失败｜期望态 v3｜资源物化失败，已保留当前激活版本｜探测于 …`，同节点聚合也显示 `分发失败`；Provider 回执 `credential-required` 显示 `未认证`；离线 Worker 的 Agent 显示 `执行未知｜Worker 离线，运行时探测结果可能过期`；沙箱内 Claude Code 已安装但 `version === null`，因此 Agent 条目如实显示 `不可执行` 而不冒充可执行。
- 权限门：非管理员读 `/api/resource-inventory` 得 403 `admin_required`；界面零请求、零状态轴、零按钮，且不出现节点名。服务端另有 10 用例授权矩阵：匿名 401 `authentication_required`、成员 403 `admin_required`、管理员只读 PAT 403 `pat_scope_required`、管理员 Cookie 与管理员 PAT 200；无任何非 GET 的 `/resource-inventory` 路由。
- 脱敏证据：`/var/tmp/wemux-d01-evidence/wemux-next-resource-management-tFyunI/`（`checks.json` + `desktop-administrator-inventory.png`、`desktop-installation-failure.png`、`mobile-administrator-inventory.png`、`mobile-installation-failure.png`、`member-denied.png`）。

## 门槛（转 ready-for-human 的理由）

1. 验收项 1 的「配置」与管理面内的配置动作未实现：web-next `/next/resources` 目前是只读投影（列出、查看、四态、刷新），写路径仍是既有 `/api/resources*`、`/api/resource-presets`、`/api/resource-bindings` 授权管理 API（既有测试 `resource-http.test.ts`、`resource-authorization-http.test.ts` 覆盖）。是否需要管理面内配置动作，需人工确认范围。
2. 验收项 4 的远程托管安装入口未实现（`AGENTS.md` 已记「Web 远程安装入口尚未实现」）：本票只验证了安装失败原因的如实上报，未新增「不覆盖全局安装、固定版本、独立目录」的远程安装验收。
3. `spec.md` 要求证据准备完成后转 ready-for-human，并在用户确认前不勾选 NEXT-11/13/14、不关闭本票。
