# Ticket 04 Task Session 后端与客户端合同增量

状态：后端有界增量已实现并验证；04 整票 in-progress。用户批准在 03 仍为 partial 时开始 04；03 文件协议、删除能力不在本轮范围。后端摘要与下述客户端桌面浏览器证据只覆盖创建/重试/发现，不是真实 Runtime 或整票验收证明。

## 共享客户端与 Next UI 交接

### 创建

复用 `POST /api/projects/:projectId/tasks/:taskId/sessions`，不新增平行创建 API。

```json
{
  "requestId": "client-stable-request-id",
  "title": "任务会话",
  "workspaceId": "workspace-id",
  "workerId": "worker-id",
  "agentKey": "agent-key",
  "modelId": "advertised-model-id"
}
```

- 走现有认证与授权；Cookie 写请求继续需要 CSRF，PAT 继续受既有 scope 控制。权限不由 `/next/` URL 决定。
- `requestId` 和 title 必填非空字符串，最多 200 字符，不含 NUL；不接受未知字段。`X-Request-ID` 仅追踪，不代替 body requestId。
- 显式选择须完整提供 workspaceId/workerId/agentKey；modelId 可省略或 null。完全省略四个选择字段时使用 Task assignee fallback，但 requestId 仍必填。部分选择拒绝。
- 创建事务中验证 Task 属于 URL Project 且未删除、操作者有 Project 写权限、Workspace 同 Project 且未删除、所选 Worker 获权且有 ready Placement、Agent 为 available execution、模型存在。保留既有 Worker 离线可排队语义，不另改 Runtime 可用性规则；revoked Worker 拒绝。
- 允许未绑定或绑定当前 Task 的 Workspace；绑定其他 Task 的 Workspace 返回 workspace_bound。不修改 assignment、不自动绑定 Workspace、不创建 Run。
- 成功与重放均 HTTP 201：`{ session: Session, commandId: string, created: boolean }`。新建 created=true，完全重放 false；相同 Session ID 和 commandId。Session 固定 taskId、runId=null、shareScope=project、storageMode=local，包含创建收据 `creation: { requestId, fingerprint, commandId }`。响应不是完整 sessionView，需要后续 GET 获取会话状态/能力。
- 收据使用既有 `(ownerId, projectId, requestId)` 身份空间，指纹包含规范化 Workspace/Worker/Agent/Model/title/shareScope 及 taskId/runId。不同 Task 或不同逻辑请求重用同键冲突；不能当作切换 Task。新意图必须新键。通用根入口也在既有身份空间内，因此与 Task 请求同键时安全冲突。
- 当前生命周期与授权先验证，再判定重放。不保证撤权、删除或环境不可用后还能取回旧成功响应，但保证不会因此新建重复命令。重放不再次记录 Task activity 或发送 commands/project 通知。事务失败整体回滚 Session、收据、command、audit 和 Task activity。
- **模型规范化边界**：省略/null 仍解析为当前 Agent 首个 advertised model；具体模型进入指纹。模型列表顺序变化可能返回 request_id_conflict，不会静默选择新模型或重复创建。调用方应保存具体 modelId 和整份请求，网络失败/刷新后重试同请求，而不是读取当前下拉默认值重建请求。assignee fallback 改选后也会冲突或校验失败，不产生第二个 Session。此轮未改变模型切换语义。
- Task 绑定不可变：普通 PATCH /sessions/:id 只允许 title/archived，不接受 taskId；现有 SQLite provenance 约束阻止直接换绑或清空。

Task 路由错误保持 `{ error: { code, message, details? } }`：

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | invalid_request | 缺少/非法 requestId、title、部分选择、未知字段、非法 archived |
| 401 | unauthorized | 未认证/失效凭据 |
| 403 | forbidden | Task Project 无权限或 viewer 写请求、跨 Project Workspace、PAT scope 等既有拒绝 |
| 404 | not_found | Project/Task 不存在或不匹配；Workspace/Worker 不存在或不可见；已删除 Session 的重试 |
| 409 | assignment_changed | fallback 未配置 assignee |
| 409 | workspace_bound | Workspace 独占绑定其他 Task |
| 409 | runtime_unavailable | 既有 AppError 409 映射：Placement 未 ready、Agent/Model 不可用、Worker revoked |
| 409 | request_id_conflict | 同键不同 Task 或规范化 payload |
| 410 | task_deleted | Task 已删除 |

Task 自身未授权沿用既有 forbidden，不重新设计所有 Task 隐藏语义。列表不得泄露未授权 Session 标题、ID 或内容。

### 发现

- `GET /api/projects/:projectId/tasks/:taskId/sessions` 返回 HTTP 200 `{ items: SessionView[] }`。按实际 Session.taskId 查询，不从 Run 拼接；Task 下多个 Session（包含不启动 Run 的 Session）均可发现。
- 先验证 Task 访问，再逐 Session 用现有 SessionAccessService 授权；owner-only 对其他人不可见，selected-members 需已有 Grant，project 范围按既有策略。已删除 Session 不返回。
- 每项使用现有 sessionView，包含原有 access、storageMode、archivedAt、执行状态及 sendCapability；内容读取仍走现有 Session API。
- 可选 projectId/workspaceId/taskId/archived 与路径范围合取。archived 只允许 true/false；省略包括两种状态。teamId 沿用 Task 路由上下文校验。
- `GET /api/sessions` 的 authenticated 分支现在同样合取 projectId/workspaceId/taskId/archived，继续与可见 Project/teamId 范围相交；旧 operator 分支也不再用 workspaceId 覆盖 projectId。
- 本轮返回既有 `{ items }` 无总数/分页。规格中的有界分页、稳定游标合同仍是后续项目 API 工作，不能将本增量描述为全量 task.sessions API 已完成。

## 验证

全部使用自有 `/tmp` SQLite、合成账号/授权/Worker 能力及动态 loopback 端口；未连接真实 Worker、真实 Agent 或付费提供方。新增 `apps/server/src/test/task-session-contract.test.ts` 8 项：

1. 公开认证 HTTP 并发六次创建、忽略成功响应后的 SQLite 重开重试、同 Task 多 Session、单 command/activity、无 Run/assignment/binding 副作用。
2. title/model/workspace/task 变化冲突；mandatory requestId；HTTP 与 SQLite 不可换绑。
3. Task Session 可见性、私有标题不泄露、合取筛选、viewer 与 Project 撤权。
4. 无效认证、Task/Project/Workspace/Worker 关系、ready placement、Agent 认证状态、Model、其他 Task 绑定、删除/撤销拒绝及无副作用。
5. assignee fallback 与省略模型规范化；默认模型顺序变化明确冲突，固定 modelId 可重放。
6. 成功后 Worker/Project 撤权、Worker revoked、Task/Project/Session 删除重试拒绝，不重复执行。
7. 事务强制失败回滚全部创建事实；成功仅一次通知，重放不通知；SQLite provenance 锁定。
8. 旧根通用创建/发送及幂等保留，根与 Task 同键冲突。

命令（仓库根目录）：

```sh
node_modules/.bin/tsx --test apps/server/src/test/task-session-contract.test.ts apps/server/src/test/task-runs.test.ts apps/server/src/test/session-lineage.test.ts apps/server/src/test/session-authorization-http.test.ts apps/server/src/test/session-workbench.test.ts apps/server/src/test/tasks.test.ts apps/server/src/test/http-route-registry.test.ts
node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit
```

最终结果：117 tests / 117 passed / 0 failed，退出 0；Server noEmit 退出 0。先有 4 项红测试（原接口拒绝 requestId/选择字段），再实现变绿；期间修正测试 Workspace 兼容字段及现有 Run 测试的 requestId/错误断言。现有 launch/Fork/Session 授权回归通过。未改 packages，无 build:packages 需要；未运行根 build、pack、部署。

## 基线与增量证据

基线 HEAD `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`，原工作树 `git status --short` 为 163 条 dirty/untracked；`--porcelain=v1 -uall` 展开未跟踪目录后为 288 条（均记录文件哈希），index 无已暂存文件。最终验证所有增量范围外基线 dirty 文件哈希未变、HEAD/index 未变。自有证据目录 `/tmp/wemux-ticket04-bdoy9lnz/` 包含 HEAD/status/index、scoped preimages 与 SHA-256、dirty 文件哈希、红绿/回归/noEmit 日志及基于 preimages 生成的 `incremental.patch`、`preservation.json`。增量不是整个工作树 diff，不复制凭据或生成目录；没有 stage/commit/reset/clean/stash。该目录属于本机原始证据，不作为可移植测试依赖。

## 未完成的 04 门槛

- Next UI 接入仍待交付。共享客户端与旧 Task 按钮的 requestId/完整请求留存已在下述客户端增量修复；不代表 Next 会话 UI 完成。
- 旧根 taskless POST /sessions 仅临时兼容：04 后续 owner 实施自动专用 Task 或调用方转换；15 核实所有调用方后收紧。测试/试聊专用 Task 复用规则未实现。
- 真实 Worker 流式文本/工具/历史/错误/用量/恢复；队列取消、停止、审批拒绝/超时；下一 Turn 模型快照和竞争策略；草稿保留与弱网恢复。
- 桌面与手机真实浏览器 Task→Session→发送→审批/停止→切模型→刷新恢复，真实现有 Runtime 验收及授权的付费请求。
- Worker 本地 Task/双宿主规则、完整迁移与旧入口移除按后续票据；本轮不改 Worker runtime/wire/file protocol。

后端有界增量已获独立 review `b3aebe1c` 的 OK with notes；该 review 为静态审查与日志核对，未重跑命令。其 P2 指出旧 Task 按钮只传 title 导致 400，已在本客户端增量修复并用实际按钮验收。客户端首轮独立 review 为 **BLOCK**，指出下述两个 P1；修复后的六文件增量已获独立 reviewer `c31086a3` 的 **OK with notes**，仅关闭两项 P1，不代表整票完成。上述测试不能代替整票浏览器或真实 Runtime 门槛。


## 客户端增量与 Next owner 交接

- `@wemux/web-client` 的 `taskSessionOperations(transport)` 复用现有 Cluster transport；已组合到 `createClusterClient` 和旧版 `createApi`。`createTaskSession(projectId, taskId, body, signal?)` 返回 `{session,commandId,created}`；`taskSessions(projectId, taskId, filters?, signal?)` 将服务端 `{items}` 解包为 `TaskSessionView[]`。创建 Session 的 `binding.agent.{workerId,agentKey}` 与发现的 freshness/access/queuedMessages 保持实际服务端形状，不伪装成旧版 UI 扁平 DTO。关键响应身份、收据与列表投影验证失败时抛中文 contract error；HTTP status/code 沿用 ApiError，绝不将失败当空列表。
- 类型放在 `@wemux/web-contract/task-platform`：`CreateTaskSessionRequest/Response`、`TaskSession/TaskSessionView`、`TaskSessionFilters`。显式选择字段必须整体出现，也允许原 assignee fallback；UI 推荐固定具体 modelId。
- `PendingTaskSession(() => window.sessionStorage, {...api.taskSessionScope,projectId,taskId})` 是比例适中的创建身份助手。调用 `run(intentFactory, body => api.createTaskSession(projectId,taskId,body))`；首次发送前验证并保存完整不可变请求，重试/刷新只读旧 body，不重新读 title/assignment/default model。`read()` 可用于展示待确认状态。`run` 合并重复点击，重挂载并发查能力后重读已存身份；旧请求的迟到成功不会清掉新请求。仅成功响应后移除 pending，下一次明确点击才开始新意图。未知、冲突、撤权等失败均保留原请求，不提供静默换键。
- `taskSessionScope` 使用宿主 origin、登录账号 username、teamId，助手再加 Project/Task；不使用可轮换 CSRF 或设备 ID 代替账号。账号退出/切换继续要求既有 transport dispose，组件离开/换 scope 后不接收旧成功结果。存储不是授权凭证，每次网络访问仍经当前服务器授权。存储仅含 title 与所需选择/request IDs，无 Cookie、凭据、消息内容。
- 旧 `TaskRuns` 使用独立 keyed `TaskSessionButton` 与 `createIndependentTaskSession` 小助手。当前 assignment 在首次操作时复制；modelId 为空时通过原 `api.workers()` 能力读取选定 Agent 的具体模型后冻结，之后变化不影响重试。未配置环境或无模型时报中文错；服务器能力/runtime 授权仍为权威，不绕过或自行更改 assignment/Task binding。
- 浏览器存储读取、解析、写入或读回失败都在发送前阻止操作，显示恢复存储后重试提示；不声称内存模式可跨刷新。成功后清理失败提示“会话已创建”并保留核对路径。sessionStorage 只保证同标签页刷新，关闭标签页、主动清空浏览器数据或跨标签页不在此持久性保证内；UI 明示此边界。不可恢复的存储损坏/已被服务器拒绝的原请求保守阻止换键，需要先人工核对，不提供危险的“忽略并新建”。

### 客户端首轮 writer 验证（历史证据，不等于 review 接受）

自有临时目录，无生产数据库、live credentials、付费 Agent、Worker 连接、端口 8004、网络安装、根 build/pack 或部署。

```sh
npm run build:packages
node --experimental-strip-types --test packages/web-client/tests/*.test.mjs apps/web/tests/task-session-create.test.mjs apps/web/tests/api.test.mjs apps/web/tests/insecure-context.test.mjs
node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit
node_modules/.bin/tsc -p apps/web-next/tsconfig.json --noEmit
node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit
node_modules/.bin/vite build apps/web --outDir /tmp/task-session-client-evidence/web-dist
WEMUX_TASK_SESSION_WEB=/tmp/task-session-client-evidence/web-dist node --import tsx apps/e2e/task-session-client-browser.mjs
```

共享客户端新增行为测试涵盖 POST/GET/合取筛选、响应验证、错误状态/code、未知结果、刷新、全请求冻结、重复点击、下一意图、五维 scope 隔离、dispose/迟到响应、存储故障及重挂载竞争。旧调用方行为测试实际调用 `createApi`（含 Worker capabilities API），覆盖 title/assignment/model 默认序变化后的原样重试。前述 Server 117 项合同回归重新运行通过。最终共享客户端/旧 Web 聚焦 45/45（本轮新增 9 项：共享客户端 8、真实 Api 调用方 1），Server 回归 117/117；build:packages、Web/Next/Server/Worker noEmit 均退出 0。最终浏览器证据 `/tmp/wemux-task-session-browser-XL0f92/` 含 result.json、replayed.png、other-task.png；命令日志、scoped preimages、增量 patch 与 preservation 记录在 `/tmp/task-session-client-evidence/`。

可重复真实 Chromium 脚本 `apps/e2e/task-session-client-browser.mjs` 启动 owned 临时 Server/SQLite 与测试身份，通过实际旧 Task 页面按钮获得新合同 201；故意丢弃已提交响应，刷新前修改 Task title/assignment，再点击重试，断言同 payload、Session ID、commandId 且 created=false；显式再次创建使用新键；迟到响应不更新另一 Task。HTTP 与共享客户端发现结果经过真实 Server。此为桌面创建/重试/发现证据，不包含发送、流式、审批、模型切换、手机或真实 Worker/Runtime。04 整票继续 in-progress，综合验收项不勾选。


## 客户端 P1 跟进修复（独立复审已接受有界增量）

保留历史结论：首轮客户端独立 review `task-session-client-review.md` 的 merge verdict 是 **BLOCK**，且 parent 确认两项 P1 为有效 blocker。该 review 为只读源码/日志检查，未执行命令；此前 45/45 与浏览器结果是 writer 证据，不足以证明以下竞争/重放场景。此次修复不将历史 BLOCK 改写为通过，也不宣称整票完成。

1. **可变 Session 元数据重放**：Server 的 `created=false` 响应返回当前 Session 标题与模型，不是创建时快照。客户端现在只对 `created=true` 比较 title/model；所有响应仍验证 Task/Project、Workspace、Worker/Agent 绑定、creation requestId/commandId/fingerprint。原请求保持不变，成功重放即清理 pending。没有绕过授权或放宽不可变绑定。
2. **成功重挂载竞争**：`PendingTaskSession` 用模块内 `WeakMap<Storage, Map<fullScopeKey, Promise>>` 协调同一个存储对象与完整 host/account/team/project/task 范围。登记发生在调用存储方法、intent/capability lookup 或 send 之前；重挂载/同步重入加入同一 Promise，包含能力查询阶段，不能因另一个实例成功清理 storage 而再造身份。成功/拒绝均在 finally 移除活动条目，空 map 从 WeakMap 删除；不使用定时锁、永久锁或仅 suppress UI 回调。拒绝留下持久请求，下一次调用用原 body 重试；成功后新的显式点击允许新意图。不同 storage 对象及 scope 独立。

使用边界：传入 getter 必须返回同一个真实 storage 对象，不要每次包装新的代理对象。协调只覆盖同一 JS realm/标签页中的未决操作，不能宣称跨标签页 exactly-once；sessionStorage 仍只保证同标签页刷新，关闭/清除数据不在保证内。刷新后 JS 操作表消失，由此前已持久化的请求恢复。能力查询阶段尚未产生网络创建，因此刷新此阶段不遗留已发送创建。

### P1 红绿与真实浏览器证据

新独立基线 `/tmp/task-session-client-p1-evidence/` 保留 HEAD/index/status、1078 个基线文件 SHA-256、scoped preimages、后续精确 incremental.patch 和 preservation.json；不覆盖原 `/tmp/task-session-client-evidence/`。

- 两项 P1 定向行为测试在修改实现前均红：**0/2 passed、2 failed**（exit 1，red.log）。随后再次直接 import 本次捕获的原始 preimage 模块，验证 **0/2、2 failed**（red-preimages.log）；P1a 为 contract error，P1b 确实发送两个创建身份（2 !== 1），不是仅以源码扫描推断。
- 修复后共享 Task Session 测试 **12/12**（green.log）；完整聚焦客户端/旧 Web **49/49**（client-web.log，exit 0）。两个旧并发测试依赖允许跨实例并发发送，替换为合并成功/失败生命周期测试；增加 scope/storage 独立、同步重入、不可变绑定及新建元数据验证。真实旧 `createApi` 调用方测试继续通过。
- `npm run build:packages` 及 Web/Next/Server/Worker noEmit 均 exit 0。相关 Server `task-session-contract.test.ts` + `task-runs.test.ts` **95/95**（server-regression.log），不修改 Server 代码。
- 真实 Chromium 脚本 `apps/e2e/task-session-client-browser.mjs` 在 owned 临时 Server 通过公共 PATCH 改 Session title，再用既有 runtime/commands `set_model` 公共接口修改模型投影（只入队 synthetic Worker 命令，无真实 Runtime 执行）。刷新后同请求重放返回当前标题/模型、相同 Session/command，pending 清空。
- 同脚本实际点击旧 Task 按钮、hold 该点击的真实 Worker capabilities HTTP 响应、切换“详情”再“运行”使 TaskRuns 真正卸载重挂载，再点击创建后释放能力响应。结果只有 **1 次 action capability lookup、1 POST、1 新 Session、1 新 command**。真实 Server 数据库计数断言，不是 mock-only 证明。
- 浏览器证据 `/tmp/wemux-task-session-browser-iKlqgU/`：result.json、replayed.png、other-task.png、remount.png 及 owned SQLite；browser.log exit 0，page errors 为空。曾有一次脚本 fixture 使用 networkidle 被长期 SSE 阻塞（browser-fixture-failure.log）；改为等待明确的初始 capabilities response 后通过，不是浏览器/工具启动故障，未做任何替代执行。
- 浏览器/Server 均在 finally 关闭；无付费 Agent、生产 DB、live credentials、网络安装、端口 8004、根 build/pack、部署或 stage/commit/reset/clean/stash。

复现命令沿用上节，但临时 dist 改为 `/tmp/task-session-client-p1-evidence/web-dist`；新红测可运行 `node --experimental-strip-types --test --test-name-pattern='P1 ' packages/web-client/tests/task-sessions.test.mjs`。上述运行结果为 writer evidence。独立 reviewer `c31086a3-7df6-4cbb-b0e4-0e5d623baf68` 已核对源码、增量 patch、preimages 与执行日志，结论 **OK with notes**，确认两项 P1 修复且未发现本增量新增缺陷；reviewer 未自行执行测试。Parent 另行重跑共享 Task Session 行为测试 **12/12**（`/tmp/task-session-p1-parent-check.log`，exit 0），并核对协调器与响应验证源码后接受此有界增量。报告位于 workflow `1bc29ae2-b15b-4471-b00a-94a877d39ffa` 的 `tickets/04/task-session-client-p1-review.md`。Next UI、真实 Worker/Runtime 发送/流式/审批/停止/模型切换执行与手机完整闭环继续开放，04 状态仍为 in-progress。

## Next 任务详情 Session 创建与发现（writer 有界增量，待独立 review）

本增量只将上述合同接入 `/next/projects/:projectId?task=:taskId` 的任务详情。整票仍 **partial / in-progress**，不勾选综合验收项，不改写前述历史 review。创建与发现不是已交付对话执行。

- 新 `TaskSessions` 消费原 `api.taskSessions`、`api.createTaskSession`、`api.taskSessionScope` 与 `PendingTaskSession`，不新增 API stack，不改共享客户端/Server/Worker/协议。用户显式选择同项目未删除 Workspace、ready Placement、在线同 Team Worker、available execution Agent 和已上报具体 Model；显示环境与模型含义，Server 保留最终授权及有效性判断。当前 Task 固定，不改 assignment/workspace binding、不启动 Run。
- 以稳定的 `window.sessionStorage` 保存完整创建请求；未知结果显示原 title/环境/模型/requestId 和“重试原会话请求”。修改下方表单不会替换原请求，刷新后仍重放同一 body；正常创建按钮在 pending 存在时禁用。未确认请求不能静默放弃。存储不可读/写时失败关闭，不发送新 POST。
- 只读角色可发现获权 Session，不展示创建入口；删除 Task 不可创建。列表显示运行状态、历史新鲜度及序号、执行绑定和模型，提供空态/加载/错误/刷新。成功确认后重新读取权威列表，不伪造投影或聊天按钮。创建响应与发现结果在 Task/Project/API scope 改变或卸载后不能更新旧视图；账号/Team 的现有应用壳会卸载此子树。本轮真实浏览器直接验证了 Task 导航隔离，未另行执行账号/Team 切换竞争。
- 此创建合同固定 `shareScope=project`，UI 明示按项目共享；本增量不添加合同未提供的创建时分享设置。对话发送、历史流、审批、停止、自动专用 Task、模型切换执行、Worker 独立宿主均仍未实现/验收。

### 执行证据与验证阻塞

基线 HEAD 为 `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`。新证据目录 `/tmp/wemux-task04-ui-1791041590/` 保存 before status/HEAD/index、所有基线文件 SHA-256、scoped preimages、`incremental.patch`、`preservation.json` 与命令日志。没有 stage/commit/reset/clean/stash/push；前序 dirty/untracked 内容保持，不覆盖历史证据。

| 命令 | writer 结果 |
| --- | --- |
| `node --experimental-strip-types --test apps/web-next/tests/task-session-options.test.mjs` | exit 0，3/3；选择资格/四元绑定/具体模型、跨项目/Team、不可用与未就绪排除 |
| `node_modules/.bin/tsc -p apps/web-next/tsconfig.json --noEmit` | 修正开发期括号/tuple 类型错误后 exit 0；`next-typecheck.log`。此通过发生在随后增加明确 aria-label 与 pending form-submit guard 之前；最终源未再次 noEmit，不能宣称最终版本完成此检查 |
| `node_modules/.bin/vite build --config apps/web-next/vite.config.ts --outDir /tmp/wemux-task04-ui-1791041590/next-dist` | 最终源 exit 0；`vite-build.log`。不写仓库 dist，不运行根 build/pack/deploy，也未运行 build:packages |
| `WEMUX_NEXT_TEST_DIST=/tmp/wemux-task04-ui-1791041590/next-dist node --import tsx apps/e2e/next-task-session-browser.mjs` | 最终 exit 0，desktop/mobile 共 23 个检查；`browser-5.log` |
| `node --experimental-strip-types --test apps/web-next/tests/*.test.mjs` | **exit 1，139 tests：136 pass、2 fail、1 skipped**。两项现有 real-app-abort diagnostic 被 `Browser acceptance configuration required (details withheld).` 阻止。最早底层栈为 `apps/web-next/tests/acceptance-runtime.mjs:5:159`；完整 `next-tests.log`、摘录 `next-config-gate-failure.txt` 和门源码快照 `acceptance-runtime-gate.mjs` 保留。更广 Next 套件未验证通过 |
| `npm test --workspace @wemux/web-client` | 同一已启动 shell 在上述失败后继续执行，exit 0，34/34；`shared-tests.log`。未改变执行方式或配置 |

识别配置前置失败后通过 supervisor 停止测试/重试/替换执行方式；supervisor 仅批准收尾文档与 patch/hash 保全，验证阻塞待 parent 归因。未读取 live credentials。本轮没有 independent reviewer 结论。

浏览器可重复脚本为 `apps/e2e/next-task-session-browser.mjs`，结果 `/tmp/wemux-next-task-session-browser-MBJiTn/result.json`：1440×1000 与 390×844 真实 Chromium，owned 动态 loopback 临时 Server、测试账号、合成 Worker capabilities。验证实际 Task 详情、明确环境、丢成功响应、刷新同 body/Session/command、公共 API 改 title/model 后 created=false 重放、多个 Session、Task 迟到创建与发现隔离、存储拒绝零 POST、Server 拒绝不可用 Agent 后原请求恢复、发现失败重试、删除 Task、只读与私有 Session 标题/数量过滤。无 Worker/Runtime 执行或付费模型；模型命令仅改变合成场景投影，不证明实际模型切换。

截图 `desktop/mobile-{pending,multiple,readonly}.png` 已捕获，**未进行视觉质量批准**。page errors 为空；console 只有刻意注入的网络失败/503、真实 Agent unavailable409、已删除 Task discovery410，零非预期 console error。此前浏览器脚本调试失败保留在 browser-1..4.log：首次未等待选项、label 精确匹配（随后添加 aria-label）、错误地假设 Server 禁止离线 Worker 创建（改用真实 unavailable Agent 拒绝）、未纳入预期410。这些是断言/脚本问题，不是启动环境替代。

所有专用脚本运行均 finally 关闭 owned Chromium/Server 并删除其 SQLite/WAL/SHM；各浏览器证据目录含 cleanup.json。临时静态构建和脱敏断言/截图保留用于 review，无生产 DB、live 凭据、网络安装或端口8004。整体 Next 配置门失败、最终 noEmit 未重跑、账号/Team 竞争未直接浏览器验证及后续对话/真实 Runtime/双宿主闭环仍为开放项。

## Next 重挂载原请求重试 P1/P2 修正（writer 红绿证据，待复审）

前一 UI 增量的独立 review `next-task-session-entry-review.md` 为 **BLOCK**：P1 为旧组件成功后清除 sessionStorage、新组件仍展示旧 saved 快照，点击“重试原会话请求”却经 current-fields factory 生成新身份；P2 为 UI 缺少同标签页持久边界。Parent 已确认两项有效并授权本次单 seam 修正。本节不把前次 BLOCK 改写为通过，不代表独立复审或整票完成，Ticket04 继续 partial。

修正仅触及 `TaskSessions.tsx`、专用浏览器脚本与本节/ignored issue 追加记录。创建与重试现在分开：普通创建可提供选项 factory；原请求重试提供只会拒绝、不能 mint 的 factory。重试前比较显示快照与当前持久请求，发送时再次比较 body，加入活动操作后核对返回的 creation requestId；空存储或不同身份不发送/清除无关请求，而是重新读取 pending、显示状态变更并刷新权威 discovery。仍消费原 PendingTaskSession、稳定 sessionStorage、相同 scope/操作协调和 Server 授权，不修改共享代码。正常同体重试和 still-active remount join 保持可用。

待确认请求旁新增说明：**“仅支持当前标签页刷新后恢复；关闭标签页或清除浏览器存储后不保证恢复，不保证跨标签页去重。”** 不改存储语义。

### 可重复真实 Chromium 红绿

新证据 `/tmp/wemux-task04-retry-1791043708/` 保存 fresh scoped preimages、全 dirty/untracked 基线 hash/status/HEAD/index、精确四文件 incremental.patch、preservation.json、validated-source-hashes.json、commands.json 和日志；旧 `/tmp/wemux-task04-ui-1791041590/` 与 `/tmp/wemux-next-task-session-browser-MBJiTn/` 均保留为历史。

1. **先红**：只添加真实 UI 回归，构建原 `TaskSessions.tsx` 到 red-dist。成功 POST 响应 hold，SPA 离开并返回同 Task，新组件显示原身份后释放旧响应；等待持久请求被清除（旧 helper 已成功清理），修改模型/标题，点击仍显示的原 retry。用下一次 discovery 响应及按钮状态作为完成屏障，不以定时 sleep 代替竞争条件。desktop/mobile 都观察到两个不同 requestId、两个 Session；command desktop **6→7**、mobile **13→14**。`red-browser.log` exit1；`/tmp/wemux-next-task-session-browser-orLDT1/remount-retries.json` 保留 body/收据/数量，断言错误为 `stale original retry must send zero new POST/requestId/command on desktop and mobile`。
2. **后绿**：最终组件和脚本构建 green-dist 后同一回归通过。desktop/mobile 各 **1 POST、1 requestId、1 Session**，stale retry 零新增 POST，command 分别 **6→6**、**14→14**；discovery 含原 Session。额外验证持久存储被另一个待确认身份替换时，第一次 stale retry 不发送/擦除该身份，UI 更新后再次明确点击才按新显示的完整 body 重试；仍未结束的同 scope 操作在重挂载点击 retry 时合并为一次 POST/command。正常 lost-success reload、当前 Session title/model 变化后的同体重放及原有权限/存储/隔离用例继续通过。
3. 最终浏览器 **29 检查**，`green-browser.log` exit0；`/tmp/wemux-next-task-session-browser-xhJxPZ/result.json`、remount-retries.json、桌面/手机 remount-retry.png 及原有截图。无 page error、无非预期 console error。截图已捕获，未作视觉批准。红绿两次 cleanup.json 均记录 owned Chromium/Server 关闭、SQLite/WAL/SHM 删除；只用动态 loopback、测试账号、合成 Worker，无真实 Runtime/付费模型。

### 最终源验证与原配置问题

Parent 明确授权使用已存在的本地路径，所有浏览器命令显式带 `PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs` 和 `PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`。没有修改/弱化/跳过 acceptance-runtime 配置门，也没有网络安装或执行模式 fallback。

- `node_modules/.bin/tsc -p apps/web-next/tsconfig.json --noEmit`：**exit0，最终源**（next-noemit.log）。
- `node_modules/.bin/vite build --config apps/web-next/vite.config.ts --outDir /tmp/wemux-task04-retry-1791043708/green-dist`：**exit0，最终源**（green-build.log）。
- 显式上述浏览器环境 + `WEMUX_NEXT_TEST_DIST=/tmp/wemux-task04-retry-1791043708/green-dist node --import tsx apps/e2e/next-task-session-browser.mjs`：**exit0，29 checks**。
- `npm test --workspace @wemux/web-client`：**exit0，34/34**（shared-tests.log）。
- 显式上述浏览器环境 + `node --experimental-strip-types --test apps/web-next/tests/*.test.mjs`：**exit0，139/139，0 skipped**（next-tests.log）。原两项 real-app-abort diagnostic 和原跳过 Chromium 测试均执行通过。

这些命令后只追加文档和证据，没有再改组件/脚本；validated-source-hashes.json 记录最终受测源码。原 broad log **139 total/136 pass/2 fail/1 skip** 完整保留，historical-log-sha256.txt 记录 digest。本次配置输入修正后的通过不是抹去历史失败；此前缺省路径在配置门先失败，不能推断 Session UI 当时通过。

独立复审仍待进行；直接 account/Team 导航竞争、无障碍/视觉质量、真实 Worker/Runtime、对话/双宿主和整票验收继续开放。未 stage/commit/reset/clean/stash/push、未 root build/pack/deploy、未使用生产 DB/live credentials/端口8004。

## Discovery 迟到响应 oracle 跟进（test-only，writer 证据）

Parent 已根据独立 reviewer **d5a7c8f9** 的 `next-session-retry-fix-review.md` **OK with notes** 接受前节限定的 retry P1 和持久边界 disclosure P2 修正；parent 另行重算四项 validated-source-hashes 且 git diff --check 通过。该接受仅针对前节修正，不意味着 Ticket04 或实际对话/Runtime 已完成。原 review BLOCK 与后续修正证据保持历史顺序。

该 review 另指出 `apps/e2e/next-task-session-browser.mjs` 的迟到 discovery 测试在 route.fulfill 完成后等待无关 Promise.resolve，不能证明应用读取响应及处理 UI。本次只修正测试 oracle，不改 UI/shared/client/server/worker 源码。已将该屏障替换为：

1. 仅被 hold 的旧 Task GET 响应附加唯一测试 header；在浏览器中临时包装 `Response.prototype.json`，同时检查实际 Response URL pathname 与唯一 header。Playwright 的 route.fetch 不在此浏览器上下文中，不能触发消费信号。
2. **应用实际调用并完成该 Response.json** 时记录 consumed、响应里的 Session IDs 和 phase，再原样返回 body。包装在命中一次后立即恢复，不改变 API body/响应身份或生产实现。
3. 返回 body 后让 transport 校验、taskSessions 和 hook 的 promise continuation 走完当前 microtask checkpoint；等待两个 requestAnimationFrame 与后续 MessageChannel task，记录 `application-json-resolved → first-ui-frame → second-ui-frame → post-frame-task` 后才从浏览器发出 uiProcessed 信号。
4. 断言命中的 body 确实包含旧 Task 新建的 Session，随后检查当前 Task DOM 中零 Session 行。同步不依赖 route handler 完成、固定毫秒 sleep 或 networkidle。

边界：此屏障覆盖当前实现的同步校验/promise 链和正常优先级 UI 更新后的浏览器渲染机会，不是任意未来 Suspense、transition、定时器或全部 React scheduler 工作的通用 flush API；没有生产测试 hook。测试不声称证明所有未来延迟任务永不更新 DOM。

### 当前脚本真实 desktop/mobile 与敏感性

新证据 `/tmp/wemux-task04-discovery-1791044791/`。运行前验证此前 green-dist 对应的 **53 个 Next/shared product 源文件 hash 均未变化**，四项旧 validated hash 也在编辑脚本前匹配，允许复用 `/tmp/wemux-task04-retry-1791043708/green-dist`；`dist-reuse-verification.json` 保留检查。最终 `final-source-provenance.json` 复核 product hash 和本次脚本 hash。未重建产品或复跑无关套件；前次最终 noEmit/build、共享34/34、Next139/139继续作为此前源码证据，不伪称本次新执行。

- 临时浏览器负控通过 `WEMUX_DISCOVERY_NEGATIVE_CONTROL=1` 启用：在已确认 JSON 消费之后的第一 UI frame，向当前 Task 注入带旧 Session ID 的测试 DOM row；不是改仓库 product 文件或放松生产权限。两 viewport 都收集到 `injected-stale-row` phase，最终断言前 staleRows 均为 **1**；只清除此测试 row 以继续收集另一 viewport，最后相同零行 oracle **exit1**，错误为 `consumed old Task discovery must not render in the current Task (desktop/mobile oracle)`。证据 `/tmp/wemux-next-task-session-browser-wrqsB3/discovery-barriers.json`，日志 `negative-browser.log`。
- 正常运行相同最终脚本，真实 desktop/mobile **29 checks、exit0**；两 viewport 的 consumed/uiProcessed 均 true、旧 Session IDs 非空、phase 完整且 staleRows 均 **0**。证据 `/tmp/wemux-next-task-session-browser-mplb9i/{result,discovery-barriers,cleanup}.json`，日志 `green-browser.log`。原 lost-response/reload/stale-remount retry 等检查仍通过。
- 负控证明零行断言能检测 **消费之后、UI frame 内发生的迟到 DOM 泄漏**，不是仅检测响应发出；它不等于已做删除生产 active guard 的 mutation test，也不证明 React 内部每一种 stale-update 回归均必红。此边界明确保留。

完整命令前缀均显式使用 parent 授权路径：`PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome WEMUX_NEXT_TEST_DIST=/tmp/wemux-task04-retry-1791043708/green-dist`，执行 `node --import tsx apps/e2e/next-task-session-browser.mjs`（负控额外设置上述变量）。无安装/配置门修改/fallback。`git diff --check` exit0。

两次 owned 临时 Chromium/Server 均 finally 关闭，SQLite/WAL/SHM 删除，cleanup.json 保留；正常结果无 page error/非预期 console error。截图仅捕获未作视觉批准；无真实 Worker/Runtime、live credentials、生产 DB、付费模型、端口8004、root build/pack/deploy。三文件 exact incremental.patch/scoped preimages/hash/preservation 位于新证据目录，前轮所有红绿/失败日志原样保留。本次 test-only 增量尚未独立复审；Ticket04 仍 partial。
