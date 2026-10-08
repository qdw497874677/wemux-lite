# Ticket07 普通 Task Run 纵向增量（部分）

> Phase 1 01-06 按原票八项列出的当前已验范围、未验门与 01-07..01-11 映射见 `docs/acceptance/web-next-phase1-conversation-run-gap.md`。本页保留各轮限定切片的原始证据和当时边界；当前 Ticket07 八个复合验收项仍全部 OPEN。

范围：Next Task 详情加入 Run 启动、状态/关联 Session/结果/故障展示和取消；不自动把 Task 标记为 done。用户通过当前指派发起新 Run；重试丢失的启动响应时复用同一完整请求和 requestId，按宿主/账号/Team/Project/Task 限定 sessionStorage，回执不符不清除待确认请求。取消也以宿主/账号/Team/Project/Task/Run/Session 持久化同一身份；终态抢先到达时不宣称取消被受理。列表不可用时阻止新 Run，显示已知活跃 Run。复用 Session 的 UI、受权的审查阶段决定、真实 Worker 执行的浏览器验收尚未提供；待办目前只有只读入口，尚非有界可操作汇总。

验证（确定性无模型）：

- `node --experimental-strip-types --test packages/web-client/tests/task-runs.test.mjs`：`/tmp/wemux-ticket07-cancel-tests-v5.log`，**9/9**。前次 v3/v4 红是改动后只重建类型而未重建 `@wemux/web-client` 的编译产物；实际修正后重建 web-client 再运行通过，不能标记为产品红绿证明。
- Server HTTP 取消路由确需三元目标并持久重放：`/tmp/wemux-ticket07-cancel-route-v3.log`，**1/1**。第一次红是新测试误用不存在的 `cancelRequests` 仓库方法；修正 `cancelRequest` 后通过。
- `npm run typecheck --workspace @wemux/server`：`/tmp/wemux-ticket07-server-type-v3.log`，成功；`npm run typecheck --workspace @wemux/web-next`：`/tmp/wemux-ticket07-next-type-v11.log`，成功。`git diff --check` 通过。
- 隔离 Server + Next 真实 Chromium 桌面/手机：`apps/e2e/next-task-run-browser.mjs`，`/tmp/wemux-ticket07-browser-v3.log`，6 项全部通过；原始 JSON/截图/临时 SQLite 在 `/tmp/wemux-next-task-run-browser-t51gFH/`。以登录身份经真实浏览器创建 Run，拦截发往真实 Server 的响应来模拟丢失并刷新；确认精确重放只生成同一个 Run/Session，取消重试保留同一请求标识且 Command ID 相同，Session 导航参数与加载的会话元数据一致。Worker 能力与就绪 Workspace 为隔离夹具，**无真实 Worker 执行或模型调用**。最初脚本 v1 红是把预期故障注入的四条 `ERR_FAILED` 当作意外 console error；v2 精确匹配这四条，所有页面异常仍为零。
- 只读独立复审 `83c63192-6e70-4af1-9eba-2194fd808ef2` 认可最初 P1 修复，指出取消刷新身份、假成功与 Run 列表故障三个 P2；`6b4a8976-4a37-4b3a-b6ee-e221d0718ba2` 确认持久化/列表修复，继续指出终态取消回执和文案两个 P2。末尾的时间戳校验和“无需取消”提示已修，尚待新复审和真实浏览器验证。

显式完成增量：新增 `POST /api/projects/:projectId/tasks/:taskId/completion`，要求当前普通 Task `in_progress`、最新成功 Run、无活动 Run、CAS 版本、摘要/证据、权限与持久化 `requestId`。成功 Run 不自动 `done`；普通 `PATCH`/`transition`/`move` 不允许直接 `done`，需无强制审查的显式完成或审查决定。任务审查要求仅 Project owner/manager 可更改；已执行的必审任务不得通过改状态/清除元数据跳过审查。新版 TaskRuns 提供显式完成表单和持久请求意图。本会话曾记录相应运行结果（93 个 task-runs 测试通过、packages/Server/Next 类型检查通过），但原 `/tmp` 日志在当前工作环境不可读取，不作为可复查证据。后续需在当前工作树重跑并保留真实日志；覆盖策略越权、三类状态旁路、审查要求、CAS、重放冲突、重启回执和非法输入的测试源码已落盘。首次独立只读审查 `67db14a3-478e-4f91-8525-c25a10023b84` 指出旁路与策略越权（已修）；后续独立复核进行中。**尚未真实浏览器验证提交完成**，不宣称这一新切片验收通过。

2026-10-05 复核与安全收口：独立只读复审 `/opt/data/.pi/agent/sessions/--opt-data-profiles-hacker-workspace-project-wemux-mini--/subagent-artifacts/outputs/d2506321-08da-4099-bd40-d32239940182/tickets/07/policy-hardening-recheck.md` 认为已配置的 `human`/`agent`/`multi-stage` 策略在真实参与者与阶段工作流交付前拒绝旧式单票审查，且指出任务/Run/汇总的能力预告与拒绝语义不一致。后续把相同拒绝条件移到 `packages/web-contract/src/action-capability.ts`，审批汇总从 `runCapabilities` 派生可操作决定，不再固定展示批准按钮。隔离 SQLite + 真实 HTTP 测试验证策略变化后的审批列表没有决定能力，拒绝决定不产生写入；任务与 Run 读取不宣告不可用审查入口。证据：`/tmp/ticket07-policy-capability-parity.log`（95/95）、`/tmp/ticket07-policy-approval-parity.log`（28/28）、`/tmp/ticket07-projection-typecheck.log`、`/tmp/ticket07-web-next-typecheck.log`、`/tmp/web-next-packages-build.log`；`git diff --check` 通过。`@wemux/web-contract` 无独立 `npm test` 脚本，不能称该命令通过。以上仅证明现存路径暂时关闭绕过并维持能力一致，**不是审查功能或 Ticket07 完成**；项目默认策略/继承、真正的阶段与参与者授权、待办、决定与回执原子性、真实 Worker 结果和完成表单浏览器验收仍未完成。

2026-10-01 本工作树补验（与上述历史记录分别看待）：`apps/e2e/next-task-run-browser.mjs` 在无付费模型的隔离 Server + Chromium 桌面/手机上新增“成功 Run 不自动完成、摘要/证据经真实表单提交后 done、活动落库”各一项。`/tmp/wemux-next-ticket07-run-browser-v22.log`：8 项通过，原始证据 `/tmp/wemux-next-task-run-browser-NSrmik/`；成功 Run **是测试脚本直接写入的合成投影**，不能证明 Worker 或 Agent 真实执行。Server 定向 `/tmp/wemux-ticket07-policy-pin-test.log`：99/99，显式任务策略在首次 Run 一并固定且启动后不可抹除；只读独立复审 `/tmp/wemux-ticket07-policy-pin-browser-review.md` 没有发现本切片缺陷。`/tmp/wemux-ticket07-attention-gate.log`：待办单测与真实迁移 HTTP 共 6/6；`/tmp/wemux-ticket07-ts-v22.log`：Server typecheck 通过。上述日志、截图和断言仅支持对应小切片，不抵消前面缺口。

2026-10-05 真实 Worker 浏览器补验：`apps/e2e/next-worker-task-run-browser.mjs` 从仓库 Worker CLI 注册并启动隔离节点，经真实 HTTP 建 Workspace Placement，选择确定性 Test Agent，由桌面及手机 Chromium 启动 Run；等待真实 `turn.finished` Journal 与成功 Run，确认 Task 仍 `in_progress`，在关联会话显示权威 Agent 元数据和终态历史后提交摘要及证据引用，核实 `done` 和活动中的 Run ID、摘要、证据。第二条真实 Run 在 Test Agent 可中止暂停期间从 UI 取消，同时核实 Run 和 Journal 均为 `cancelled`。四条路径通过，浏览器异常零；原始 `result.json`、四张截图和清理证明在 `/tmp/wemux-next-worker-run-browser-bSQXF8/`。隔离 Server/Worker/浏览器/数据库在运行后清理；实际执行的是本仓库无模型的 Test Agent，**不是 Pi/Claude 或真实审查 Agent**。只读独立复审 `/tmp/wemux-ticket07-real-browser-review.md` 曾指出失败路径清理及两个断言缺口；父会话修复后复跑获得上述证据；本轮修复尚待再复审。

补充安全回归：`packages/web-contract/src/action-capability.ts` 禁止在已完成 Task 或其 blocked/cancelled 恢复链上启动新 Run，必须先显式重新进入实施状态。保留原有 Run 请求的幂等回执，不重新启动；新的成功 Run 也不能靠普通状态 PATCH 恢复旧的完成结果。`packages/web-contract/src/action-capability.test.ts` 49/49、`apps/server/src/test/task-runs.test.ts` 100/100、`npm run typecheck --workspace @wemux/server` 通过。独立只读复审 `/tmp/wemux-ticket07-restore-review.md` 未发现当前绕过；该防护不代替真实审查工作流。

旧无审查 ReviewRequest 路径现在也要求提交时 Run 已成功，failed/cancelled 不再能因“已终态”而进入审查。独立只读复审 `/tmp/wemux-ticket07-terminal-review-reviewer.md` 随后发现普通 PATCH `in_review` 可绕过并对失败 Run 形成可批准审查；已在共享能力判定中给入口加最新成功 Run/无活跃 Run 门，审批旧持久化审查同样要求成功。两种失败终态的服务测试验证 PATCH/提交均拒绝且无活动/审查写入；旧管理测试改为不再假设活跃或已失败 Run 可提交。当前证据 `/tmp/wemux-ticket07-bypass-contract.log` 57/57、`/tmp/wemux-ticket07-bypass-runs-v3.log` 102/102、`/tmp/wemux-ticket07-bypass-packages.log`、`/tmp/wemux-ticket07-bypass-type-v2.log`、`/tmp/wemux-ticket07-bypass-next-type.log`，`git diff --check` 通过。最初复跑中原有测试的旧断言失败（测试预设在活跃 Run 或 blocked 状态仍可请求审查），已按收紧后语义修改并复跑；本防护不开放配置审查决定。独立再复审 `/tmp/wemux-ticket07-bypass-rereview.md` 确认原 P1 的 PATCH、POST、普通完成旁路均关闭。此后以当前工作树重跑 `node --import tsx --test packages/web-contract/src/action-capability.test.ts` 57/57，Server/Next 类型检查与 Next build 通过；实际 Worker CLI/Test Agent 的桌面手机浏览器 4 条路径通过，证据 `/tmp/wemux-ticket07-final-worker-browser.log` 与 `/tmp/wemux-next-worker-run-browser-TLdxh6/`（`cleanup.json` 全部为 true、无失败）。该脚本覆盖启动/取消/无审查显式完成，不覆盖配置审查参与者与阶段。补充历史 Review 已存在而 Run 后变为失败/取消时公开 HTTP 审批拒绝且活动/Review/Task 不变，`apps/server/src/test/task-runs.test.ts` 104/104，日志 `/tmp/wemux-ticket07-persisted-bad-review-http.log`；这是异常数据防御，不代表已实现多阶段审批。

2026-10-05 新版 `/next/` 人工审查**提交请求**切片：项目人审策略在首次 Run 固定，成功且最新的 Run 可从新版 Task 详情提交有摘要、证据引用、CAS 与 requestId 的请求；Server 在同一事务保存 undecided ReviewRequest、`in_review`、活动、审计及幂等回执，重放重新校验写权限。请求者不会自动成为审查者，既有配置审查决定仍拒绝。浏览器端使用 `PendingHumanReview` 将完整原始请求存于当前标签页，响应丢失后即使刷新/详情重载、Task 已变为 `in_review` 仍提供“重试原人工审查请求”；新草稿不可代替原请求。新版前端和 Server HTTP/PAT 路径、共享包及契约同步验证。证据：`/tmp/wemux-ticket07-human-runs-v7.log` 113/113，`/tmp/wemux-ticket07-human-intent-v1.log` 3/3，`/tmp/wemux-ticket07-human-{packages-v4,server-type-v4,web-type-v4}.log`；真实桌面/手机 Chromium `/tmp/wemux-ticket07-human-browser-3kxUaJ/browser.log` 共 10 项通过，原始 `checks.json`/截图/隔离数据库 `/tmp/wemux-next-task-run-browser-l47MyR/`。脚本 `apps/e2e/next-task-run-browser.mjs` 用真实 Server HTTP/页面，但 Worker 在线库存和成功 Run **为合成投影**，不能当真实 Worker/审查人验收。独立只读审查 `/tmp/wemux-ticket07-human-review-independent.md` 曾指出 UI 不可重放及失败 Run/非人审策略测试虚空，目前已有代码、定向单测、浏览器与真实服务端覆盖。再次复审 `/tmp/wemux-ticket07-human-final-review.md` 发现确定性 CAS 409 拒绝后原请求永久锁住 UI，及缺失审查回执 ID 可被误认成功；已加入 `ReviewVersionConflict` 明确标记和用户确认丢弃仅该类被拒原请求、刷新当前 Task 后才能重发，其他模糊回执继续固定；同时强制校验非空审查 ID 与 undecided 字段。`/tmp/wemux-ticket07-human-intent-v2.log` 4/4，`/tmp/wemux-ticket07-human-next-type-v6.log` 通过，桌面/手机重测 `/tmp/wemux-ticket07-human-browser-v2-lx1LJW/browser-v2.log` 10 项通过；原始 `checks.json` 和截图 `/tmp/wemux-next-task-run-browser-klAC4F/`。浏览器依序注入两次网络回执丢失、一次预期 CAS 409 和一次审查回执丢失，控制台仅有对应预期资源错误，页面异常零。此修复仍需独立再复审，不抵消前述未完成验收。

### 人工审查 Attention 后续补验（当前工作树，局部验收）

本轮只加固测试与证据，不改变产品实现；上文“决定/有界待办尚未提供”的历史结论按以下限定范围更新，**不勾选 Ticket07 整票完成**。

- `/api/attention/pages?kind=approval` 仅收集普通 Task 当前人工审查周期：Task 为 `in_review`、固定 `human` 策略、当前未决定 ReviewRequest、最新成功 Run 且无活动 Run。提交者不能审自己的成果，只有当前 Project owner 或有当前 Team membership 的 Project manager 可见；实例管理员身份不能绕过这些条件。权限与来源读取在同一事务中完成，不读取 Session Journal，不把私有会话内容或决定能力附到列表。
- 数据库按持久化 `requestedAt` 的 TEXT 值降序、Review ID 升序 seek；合法日期字符串采用该持久化排序，不宣称对任意时区格式作时间归一化。每次候选 SELECT 至多 `limit+1`，元数据校验不合格时继续取下一批直至足够有效 lookahead 或耗尽；这限制返回/物化候选批次，**不保证 SQL 扫描行数、总批次数或总耗时有硬上限**。页大小默认 50、最大 100。新增混合日期/同时间戳跨页测试验证无遗漏/重复与游标，非法数值 Julian 日期在有效日期前后跨多批，实际批长度为 `3,3,3,3,3,3,2`（limit=2）。保留生产 CHECK/触发器。迁移补验保留真实人审行，重建索引及再次重放后逐字段相等、仍可分页读取、迁移版本不重复。
- Next 待办按来源分页，人工审查入口仅导航到 `/next/projects/:projectId?task=:taskId`，不在 Attention 内直接决定，也不把已加载数当总量。Task 页面重新读取当前 Task/Run/Review 并在公开决定 API 上重新授权、CAS；本轮桌面/手机各从 Attention 进入，然后由另一已授权 owner 经真实 `PATCH /api/projects/:projectId/tasks/:taskId` 更新标题和版本，**不是 SQL 注入版本**。
- 浏览器先丢弃真实 CAS 409 响应，验证不确定状态仍持久化同一决定完整载荷，不提供放弃或另一决定。刷新后精确重试取回 `409 version_conflict`，显示明确拒绝；即使已读到版本 2 也不能自动新建决定。独立复审 `936ce4ea` 指出原脚本仅等待 Task/Run 响应头，不能证明两者已渲染。本轮在明确拒绝后再次经授权公开 PATCH 把 Task 更新到版本 3 和唯一标题，并只更新既有合成 Run 夹具的 `resultSummary`（不改状态、身份或审查资格）。用户显式“放弃已拒绝决定并重新核对”后，暂停真实 Task、Run、Review GET，以请求事件确认三个读请求均发出；先释放 Task/Run，等待版本 3、唯一标题及对应 Run 行的新成果摘要全部出现在 DOM，仍保持 Review 读取未释放，此时批准仍禁用。没有定时休眠或伪造响应。全部读取完成仍不自动提交，下一次用户明确点击才产生新 requestId 与版本 3。再丢弃真实成功响应并刷新，精确重放取回同一回执，只产生一条 `review.decided` 活动；完成后从重新加载的 Attention 消失。

可复查命令与证据：

- `node --import tsx --test apps/server/src/test/attention-human-review-pages.test.ts apps/server/src/test/attention-human-review-pages-http.test.ts apps/server/src/test/attention-source-pages.test.ts apps/server/src/test/attention-pages-service.test.ts apps/server/src/test/attention-pages-routes.test.ts`：**16/16**，`/tmp/wemux-attention-hardening-server-final.log`。
- `node --experimental-strip-types --test packages/web-client/tests/pending-human-decision.test.mjs`：**79/79**，`/tmp/wemux-attention-hardening-decision.log`，为既有请求身份测试复跑，不冒充本轮新增测试。
- `npm run build:packages`、`npm run typecheck --workspace @wemux/server`、`npm run typecheck --workspace @wemux/web-next` 成功，分别见 `/tmp/wemux-attention-hardening-packages.log`、`/tmp/wemux-attention-hardening-server-type-final.log`、`/tmp/wemux-attention-hardening-next-type-final.log`。`npx vite build --config apps/web-next/vite.config.ts --outDir /tmp/wemux-attention-hardening-dist` 成功，见 `/tmp/wemux-attention-hardening-build.log`；产物隔离在 `/tmp`，未覆盖共享 Web dist。
- `PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome WEMUX_NEXT_TEST_DIST=/tmp/wemux-attention-render-barrier/dist node --import tsx apps/e2e/next-attention-review-browser.mjs`：重新隔离构建（`/tmp/wemux-attention-render-barrier/build.log`）后，真实 Chromium 桌面 1440×1000、手机 390×844，**4 项通过**，`/tmp/wemux-attention-render-barrier/browser.log`；原始 `checks.json`、12 张截图及隔离数据库 `/tmp/wemux-next-attention-review-tZN0mJ/`，其中两张 `*-review-read-held.png` 为 Task/Run 已渲染但 Review 仍暂停的证据。每个 viewport 的服务端决定序列为 `[409,409,200,200]`，请求版本为 `[1,1,3,3]`；完整请求载荷、重新读取路径和 `renderedBarrier` 记录于 JSON；页面异常为零。进程观察 `/tmp/wemux-attention-render-barrier/cleanup.json` 记录 11 个测试及后代进程，运行退出码 0，结束后无残留进程。旧 `/tmp/wemux-next-attention-review-SVKrEw/` 只证明响应头到达，不作为 Task/Run 已渲染的证据。控制台严格匹配每个 viewport 两次故意断网、一次已送达 CAS 409，另有非实例管理员两次请求 `channel_dead_letter` 的预期 403，响应路径/来源逐一断言，**不是零控制台错误**。未忽略其他错误。账号密码运行时随机生成，不写入证据；数据库仍含隔离测试账号/鉴权状态，不应公开原始数据库。
- 测试编写期间 v1/v2 Server 红因夹具试图改不可变 Review 身份、插入被生产 CHECK 拒绝的空/非法日期；改为约束允许但共享校验拒绝的数值日期后通过，未关闭约束。浏览器 v1–v3 的场景均走完，但错误计数未计非管理员渠道 403 而红；确认实际端点后增加精确断言，最终重跑通过，不把早期红称为产品缺陷。

### 要求修改的桌面与手机补验（2026-10-05，限定切片）

仅扩展既有 `apps/e2e/next-attention-review-browser.mjs` 和本记录，未修改生产代码。保留并复跑前述批准、丢失响应、CAS 及 Task/Run 已渲染而 Review 仍暂停的全部断言；每个 viewport 另建独立合成人审 Task，以真实 Server、公开 HTTP 决定端点与 Chromium 验证 `changes_requested`：

- 非实例管理员的当前 Project manager 从 Attention 进入正确 Task，理由为空或纯空格时“要求修改”按钮禁用；填入理由后经真实表单发送带当前版本、Review ID、requestId 与理由的决定，收到 200。页面显示“审查要求修改，Task 已回到进行中。”与版本 2，旧决定表单消失，待确认请求清空。
- 只读 SQLite 核验回执与持久 Task/Review 完全一致：Task 从 `in_review` 回到 `in_progress`、版本只增一、`currentReviewId=null`；旧 Review 为 `changes_requested`，原提交者和 Task/Run 身份不变，审查者为该 manager，`closedAt=decidedAt` 且时间有效。Run 未被修改或新建。唯一 `review.decided` 活动的 actor、Task/Project/Run/Review、from/to、状态、理由及时间与决定一致，公开活动 API 返回值与数据库一致。重新加载 Attention 后人工审查分组为空，桌面与手机均无横向溢出。
- 辅助真实 HTTP 负例不伪装为 UI 点击：提交者即使也是 Project owner/实例管理员仍收到 `403 forbidden`；manager 空白理由收到 `400 invalid_request`；同一完整成功请求精确重放为 200 且回执完全相同，新 requestId 配旧版本为 `409 version_conflict`，当前版本再次决定已关闭 Review 为 `409 invalid_transition`。逐次核验 Task/Review/Run/活动不因拒绝或重放而变化。

本轮实际命令与原始证据：

- `node --check apps/e2e/next-attention-review-browser.mjs` 通过，`/tmp/wemux-ticket07-changes-requested/syntax.log`；`npx vite build --config apps/web-next/vite.config.ts --outDir /tmp/wemux-ticket07-changes-requested/dist` 通过，`/tmp/wemux-ticket07-changes-requested/build.log`，未覆盖共享 dist。
- `PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome WEMUX_NEXT_TEST_DIST=/tmp/wemux-ticket07-changes-requested/dist node --import tsx apps/e2e/next-attention-review-browser.mjs` 两次通过。最终日志 `/tmp/wemux-ticket07-changes-requested/browser-final.log`：桌面 1440×1000、手机 390×844 共 **6 项通过**（原 4 项加要求修改 2 项），原始证据 `/tmp/wemux-next-attention-review-uuD4XT/`，含 `checks.json`、18 张截图、隔离 SQLite 与 `cleanup.json`。新增截图为两个 viewport 各自的 `*-changes-reason.png`、`*-changes-decided.png`、`*-changes-attention-cleared.png`；`changesRequestedEvidence` 保存真实载荷、回执、持久数据、负例错误码与重放状态。首次通过证据 `/tmp/wemux-next-attention-review-GhXzXL/`，日志 `browser-v1.log` 位于同一命令证据目录。
- 页面异常零；控制台严格匹配每个 viewport 既有两次故意断网、一次 CAS 409，以及四次非管理员 Attention 读取 `channel_dead_letter` 的 403（新增场景多两次 Attention 加载），**不是零控制台错误**。负例由辅助 HTTP 会话发送，不计入浏览器 console/response 事件；对应状态和错误码另行断言并存档。
- `node --import tsx --test apps/server/src/test/task-runs.test.ts apps/server/src/test/attention-human-review-pages.test.ts apps/server/src/test/attention-human-review-pages-http.test.ts`：**132/132**，`/tmp/wemux-ticket07-changes-requested/server-tests.log`。`node --experimental-strip-types --test packages/web-client/tests/pending-human-decision.test.mjs`：**79/79**，`/tmp/wemux-ticket07-changes-requested/pending-decision-tests.log`。均为既有定向测试复跑，不冒充新增单测；新增覆盖在上述浏览器脚本。`git diff --check` 通过。
- `cleanup.json` 记录浏览器与 Server 均已关闭；外部进程观察 `/tmp/wemux-ticket07-changes-requested/process-cleanup.json` 记录测试及后代共 11 个进程，退出码 0，无观察到的进程残留。数据库故意保留用于复查，含隔离账号/鉴权状态，不应公开；未使用外部凭据或付费模型。

边界与剩余缺口：本轮使用真实 Server/公开 API/浏览器，但成功 Run 和待审 Review 是隔离 SQLite **合成夹具**，不启动 Worker、不调用 Pi/Claude 或任何付费 Agent；此前真实 Test Agent 证据不能替代真实审查 Agent。已覆盖要求修改决定本身，但夹具没有可执行 Worker 或就绪 Workspace，**未覆盖要求修改后的下一 Run 与再次提交全浏览器链**；完整参与者分配/多阶段/Agent 审查、Worker 独立宿主安全平权仍未覆盖；不涵盖 Session 工具审批的待办分页，也未新增人工任务指派模型。非管理员 Attention 仍请求管理员专属渠道页并展示 403，是现存体验限制，本轮未改。待办内直接决定、全来源可操作汇总、严苛大数据扫描预算不在此证据范围；本增量尚需独立只读复审。

### 真实 Worker 的两次执行与人工审查闭环补验（2026-10-05，限定切片）

新增独立可重复脚本 `apps/e2e/next-worker-human-review-browser.mjs`，保留上述已批准的合成夹具和既有浏览器脚本不变，无生产代码修改。本节补齐上节“要求修改后的下一 Run 与再次提交全浏览器链”的缺口，仅针对现有单阶段人工审查，不代表 Ticket07 整票完成。

- 隔离 Server 绑定动态 loopback 端口；私有 `/tmp` 编译产物启动真实 Worker CLI，通过公开注册 API 上线并发现确定性 Test Agent。Workspace Placement 由该 Worker 实际创建并上报 ready，没有写入合成 Worker 库存、成功 Run、Session、Journal 或 Review。只用本地账号夹具跳过邮件注册；真实登录、Team 邀请/接受、Project manager 授权、项目 human 策略、Task/Workspace/指派/状态均经公开 HTTP，未播种 membership/grant。
- Chromium 桌面 1440×1000 和手机 390×844 分别完整执行：作者启动第一次 Run，观察 running 到 succeeded、Task 仍 in_progress；从对应 Run 打开真实 Session，核对权威 Test Agent 元数据与终态历史；作者通过表单提交摘要、Run/Journal 证据引用，生成真实待审 Review 并进入 in_review；不同账号、非实例管理员的当前 Project manager 从 Attention 导航到正确 Task，以理由要求修改；Task 回到 in_progress 后作者再次启动真实 Run，生成不同 Run/Session，成功后通过表单产生新 Review；manager 再从 Attention 进入并批准，最终 done。每次决定后重新加载 Attention，当前待审条目消失；手机与桌面 Attention 无横向溢出。
- 每个 Run 核对 Test Agent 确定性 Echo 摘要、无 failure、Worker/Workspace/Agent/model 快照，Session 的 Task/Run/Project/owner 身份，真实 Journal 的 `message.queued.commandId/sentByAccountId/messageId`、`turn.started.turnId` 与 Run 字段的对应关系，以及唯一 completed `turn.finished` 和 Run finishedAt 一致。活动中按序出现 pending/running/succeeded，随后两轮 `review.submitted → review.decided` 的 actor、Task/Project/Run/Review、摘要、证据、理由、时间和状态转换与回执、公开活动 API、只读持久化快照一致。第二次执行在第一次 changes_requested 之后，不能改写第一次 Run 或重开第一次 Review。
- 四次真实提交和四次真实决定各故意丢弃首次成功响应；同一标签刷新不自动写入，完整原请求仍保存在 sessionStorage，手动重试的 requestId、版本及全部字段与完整回执逐字段相等。只读 SQLite 逐次确认 Task/Run/Review/activity 没有重放副作用。两轮完成后再经 HTTP 重放所有历史提交/决定，仍得到原历史回执，最终 done 和全部持久记录不变。作者即使是 Project owner/实例管理员，决定自己成果仍为 403 forbidden 且不改变持久数据。

复跑命令（不覆盖共享 dist，不需要付费运行时或外部凭据）：

```bash
OUT=$(mktemp -d /tmp/wemux-ticket07-human-review-build-XXXXXX)
printf '{"type":"module"}\n' > "$OUT/package.json"
ln -s "$PWD/node_modules" "$OUT/node_modules"
npx tsc -p apps/worker/tsconfig.json --outDir "$OUT/worker-dist"
npx tsc -p apps/server/tsconfig.json --outDir "$OUT/server-dist"
npx vite build --config apps/web-next/vite.config.ts --outDir "$OUT/dist"
node --check apps/e2e/next-worker-human-review-browser.mjs
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
WEMUX_TEST_WORKER_CLI="$OUT/worker-dist/cli.js" WEMUX_NEXT_TEST_DIST="$OUT/dist" \
node --import tsx apps/e2e/next-worker-human-review-browser.mjs
```

加固前的历史证据（非本次复跑）：

- 历史 writer 报告私有 Worker/Server 编译、Next Vite build、脚本语法通过：`/tmp/wemux-ticket07-real-human-review/{worker-build,server-build,build,syntax}.log`。其中 `worker-build.log`、`server-build.log`、`syntax.log` 以及同目录 `diff-check.log`、`staged-files.log` 为现存空日志：writer 报告通过，现存空日志不足以独立确认退出码。不得回填历史 manifest。本轮脚本的 Server 实际源码导入 `apps/server/src/server.ts`，私有 `server-dist` 仅为编译验证，不是浏览器运行宿主。未改 packages，沿用现有编译依赖。
- `node --import tsx --test apps/server/src/test/task-runs.test.ts apps/server/src/test/attention-human-review-pages.test.ts apps/server/src/test/attention-human-review-pages-http.test.ts`：**132/132**，`/tmp/wemux-ticket07-real-human-review/server-tests.log`。
- `node --experimental-strip-types --test packages/web-client/tests/pending-human-decision.test.mjs packages/web-client/tests/pending-human-review.test.mjs`：**85/85**，`/tmp/wemux-ticket07-real-human-review/pending-tests.log`。以上是既有定向测试复跑，新增测试覆盖仅在独立浏览器脚本。
- 第一次完整通过 `/tmp/wemux-ticket07-real-human-review/browser-v1.log`，原始证据 `/tmp/wemux-next-worker-human-review-DR1GRg/`；补强 Run 生命周期、Turn/Message ID、finishedAt、第二次 Run 时序和最终活动序列后再次通过 `/tmp/wemux-ticket07-real-human-review/browser-final.log`。最终原始证据 `/tmp/wemux-next-worker-human-review-gn3jbE/`：`checks.json` 合计六项检查（每 viewport 三项，不是各六项）、16 张截图、`cleanup.json`。JSON 保存四条真实 Run/Session/Journal、四对提交/重放、四对决定/重放以及各阶段只读持久快照，可独立核对来源。
- 页面异常零；浏览器控制台逐条严格匹配每 viewport 四次故意丢失响应的 `ERR_FAILED`，以及非管理员四次 Attention 加载 `channel_dead_letter` 的 403。失败 HTTP 路径/来源/状态全部精确匹配该已知 403，不忽略其他错误；**不宣称零控制台错误**。
- 浏览器、Server、Worker 全部关闭，注册和运行 CLI 退出码均为 0；Worker home、Server SQLite/transport SQLite 及其 WAL/SHM 删除，保留结构化证据和截图；这不构成所有参数、日志和报告路径均不泄漏的保证。额外 `/proc` 父子进程观察 `/tmp/wemux-ticket07-real-human-review/process-cleanup.json` 记录 30 个测试及后代进程，退出码 0，无残留；辅助观察脚本同目录 `watch-processes.py`。`git diff --check` 通过，无暂存文件。

### P2 凭据与执行记录加固复跑（2026-10-05，限定切片）

独立复审认可前述窄口径增量、未发现 P0/P1；本轮仅修复两项 P2 并重新运行，不改变生产代码或原有断言强度。注册令牌在 `ownedWorkerLaunch` 清洗后的子进程环境中显式注入本轮 `WEMUX_ENROLLMENT_TOKEN`，不再出现在 argv。失败诊断复用 `recordAcceptanceFailure`，只写固定步骤与 `acceptance-failed` 类别，不序列化异常；不保留可能包含敏感内容的失败截图。非预期 console 文本与 HTTP 路径只记固定类别，预期 `ERR_FAILED` 与 `channel_dead_letter` 403 仍逐条严格断言，其他错误仍导致失败。

本次命令、起止时间、真实退出码及关键源码/产物 SHA-256 摘要见 `/tmp/wemux-ticket07-p2-FciiUj/manifest.jsonl`，执行器 `/tmp/wemux-ticket07-p2-FciiUj/run-validation.py`。这是本次执行时产生的记录，不补造旧空日志。每条含 `label`、`command`、`cwd`、`startedAt`、`endedAt`、`exitCode`、`inputs`、`outputs`、`log`；浏览器另列非敏感的显式环境路径和进程观测摘要。Server 使用仓库源码及既有 packages 编译依赖；Worker 与 Next 使用本次私有 `/tmp` 产物，未覆盖共享 dist 或 release。

- 本次私有 Worker/Server 编译、Next build、脚本语法检查退出码均为 **0**，日志 `/tmp/wemux-ticket07-p2-FciiUj/{worker-build,server-build,build,syntax}.log`。静默输出的检查以 manifest 的起止时间、退出码、输入摘要核对，不把空文件当作通过证明。
- Server 定向同上三文件本次 **132/132**（fail 0），`server-tests.log`；待决提交/决定两文件本次 **85/85**（fail 0），`pending-tests.log`；既有隔离 Worker 清理与 acceptance-runtime 安全测试本次 **8/8**（fail 0），`fixture-safety-tests.log`。这些是既有测试复跑，不冒充新增单测。
- 浏览器本次退出码 **0**，`/tmp/wemux-ticket07-p2-FciiUj/browser.log`；新原始证据 `/tmp/wemux-next-worker-human-review-Rn3myL/`。`checks.json` **合计 6 项检查，每 viewport 3 项**，**4 个真实 Run**，16 张截图；桌面 Run 为 `4826efc8-4e24-40ee-bc76-36e81bedf865`、`eb2503b3-fb5e-43a6-a639-495cc8d08370`，手机 Run 为 `ecfa2022-ba84-46a4-8f48-a076c8db4092`、`46b77747-8862-481a-9578-87fc54409a0f`。要求修改和批准均由非实例管理员的 Project manager 作出，作者自审被拒。每次丢失成功响应、reload、完整请求/回执精确重放，以及完成后的历史回执不改变持久快照，均保留并通过。
- `pageErrors=[]`；16 条 console 错误严格匹配 8 条注入 `ERR_FAILED` 与 8 条已知 manager 403，8 条失败 HTTP 响应仅为 `/api/attention/pages?kind=channel_dead_letter` 的 403。不是零控制台错误。
- `cleanup.json` 全部清理标志为 true、`failures=[]`，注册/启动 CLI 均正常退出 0。仅清理本轮子进程、随机 home 与精确派生的 Server SQLite/transport SQLite 和 WAL/SHM。`/tmp/wemux-ticket07-p2-FciiUj/process-cleanup.json` 每 **50ms** 采样，本次观察 **30** 个测试/后代进程，结束时 `remaining=[]`；可能漏掉极短命或重设父进程的进程，**不是系统级无残留证明**，观测器不杀进程。
- 最终保留的成功运行证据未发现凭据值；本轮已去除注册 argv 令牌并加固失败诊断脱敏。这不等于消除同权限本地进程读取环境/内存的能力，也不保证所有失败路径均不泄漏。16 张截图只确认生成与数量，未逐张人工视觉审查；本脚本失败注入路径的清理与脱敏尚未做端到端故障演练，不能由成功运行或共享 helper 测试代替。`git diff --check` 与未暂存检查另存 manifest；未 stage、未 commit。

边界：这是当前单阶段人工审查的真实 Test Agent 执行验收，**不是 Pi/Claude、真实审查 Agent、多阶段、Session reuse、Worker 独立宿主或完整 Ticket07 验收**。新项目默认不强制审查的浏览器证明、无审查完成的真实 Worker 浏览器本轮复跑、失败与取消三态竞态的真实 Worker 演练、完整参与者分配仍未证明。全来源可操作待办未完成，`apps/server/src/application/attention-service.ts:30-37` 的 `AttentionService.pages` 明确拒绝 `task_assignment`；不能把人工审查导航当全来源受权操作。前述 16 张截图人工视觉内容及失败注入路径清理/脱敏也未证明。非管理员 Attention 的已知渠道 403 保持原样。本轮 P2 修复仍需独立只读复审。

本记录仅覆盖已实现、实际复验的纵向增量。Ticket07 八项验收仍未全部完成，不得用这一局部 Attention/人工决定证据替代多阶段、Agent 审查与双宿主完整验收，也不要以 Test Agent 等同于付费模型运行时验收。

## 2026-10-07 显式完成回执丢失恢复（01-08 切片，真实 Worker）

- 新增 `packages/web-client/src/pending-task-completion.ts`：`PendingTaskCompletion` 将完整原始完成请求（版本、runId、摘要、证据、requestId）持久化在 sessionStorage（按 host/account/team/project/task 作用域），响应丢失或不确定失败后仅允许按原请求精确重放；回执身份（runId、task id/project/status、currentReviewId）不符即拒绝且保留原请求；确定性 `409 version_conflict` 标记为 `CompletionVersionConflict`，只有用户显式确认丢弃该被拒请求并刷新当前 Task 后才允许新请求；存储损坏、并发共用一次飞行、成功后清理均有测试。`packages/web-client/tests/pending-task-completion.test.mjs` 5/5。
- `apps/web-next/src/components/TaskRuns.tsx`：完成表单在存在待确认完成请求时隐藏并展示恢复条（“重试原完成请求”/被 409 拒绝后的“放弃已拒绝请求并重新核对”），启动新 Run 同样被待确认完成请求与存储错误阻塞；`complete(retry)` 重试路径校验存储请求身份未变化，模糊失败不提供放弃入口。移除未使用的 `useCreateIntent` 导入。
- 真实 Worker + Test Agent + 桌面/手机 Chromium：`apps/e2e/next-worker-task-run-browser.mjs` 在两次真实 Run（新建 + UI 显式复用同 Session、幂等重放与改载荷 409）后，拦截完成 POST（先 `route.fetch()` 送达服务端提交、再对页面 abort），验证页面出现“原完成请求结果尚未确认”、服务端已 `done`；整页刷新后原请求仍在、仅“重试原完成请求”可用；解除拦截重试取回原回执，`completion.submitted` 活动恰 1 条、摘要/证据引用原样持久。脚本以 URL 谓词匹配（实际请求带 `?teamId=` 查询串，精确字符串路由不生效），并只在模拟窗口内忽略预期的 `net::ERR_CONNECTION_RESET` 控制台资源错误。退出码 0，8 条 checks，`errors=[]`；证据 `/tmp/wemux-next-worker-run-browser-QGY9SN/`（checks、截图、隔离数据库）。
- `npm run build:packages`、全仓 `npm run typecheck` 通过；`apps/server/src/test/task-completion-http.test.ts`、`project-review-policy.test.ts` 复跑通过。
- 边界：不宣称配置审查下的完成、多阶段、外部付费 Runtime 或 Ticket07/08 整票完成；排队取消端到端与真实 Worker 抢占仍只有服务端确定性证明。

## 2026-10-07 多阶段审查链（01-09 切片，真实 Worker）

- 服务端状态机（`apps/server/src/application/task-service.ts`）：`multi-stage` 策略在提交（`submitHumanReview`）时冻结为固定两段人工链（stage 1/2，`stageIndex/stageCount` 持久于审查行）；`decideHumanReview` 批准推进下一阶段（任务保持 `in_review`、`currentReviewId` 换后继审查），末段批准才 `done`；`changes_requested` 任意段回 `in_progress`。同一 Run 上已决定过前序阶段的参与者与提交者本人对后续阶段一律 `forbidden`；已关闭阶段经新请求重决被 CAS 先行拒绝。多阶段推进显式补 `version+1`（`in_review→in_review` 的同态推进仍是状态变更），服务测试断言 `advanced.task.version === submission.task.version + 1`，客户端 CAS 回执校验与之对齐。
- 客户端恢复语义：`packages/web-client/src/pending-human-decision.ts` `matches()` 接受阶段推进回执（`in_review` 且 `currentReviewId` 为不同于已决阶段的有效后继），修复了把合法推进当"回执与原请求不符"的缺陷；其余身份/版本/时间戳校验不变。`packages/web-client/tests/pending-human-decision.test.mjs` 80/80（含推进回执正/反例）。
- 新版 UI（`apps/web-next/src/components/TaskRuns.tsx`）：`第 X/Y 阶段审查决定` 表单、`批准并进入下一阶段`/`批准并完成` 按钮按阶段位置切换；提交者看不到任何决定按钮；推进成功提示三态区分（完成/下一阶段/回实施）。
- 真实 Worker + 确定性 Test Agent + Next Chromium（桌面/手机）：`apps/e2e/next-multi-stage-review-browser.mjs` 退出码 0、2 条 checks、`errors=[]`。演练：项目默认 `multi-stage` 于首次 Run 前设置、launch 冻结快照 → 真实 Run 成功不自动完成 → 提交者（实例管理员）提交分级审查 → 阶段 1 获权 manager 批准推进（1/2，任务保持 `in_review`）→ 同一 manager 对阶段 2 决定收到服务端 403 且任务状态不变 → 阶段 2 另一获权 manager 批准 → `done`；活动链含 `review.submitted`、`review.stage_advanced`，`currentReviewId` 清空。预期 403 控制台资源错误仅在受阻决定窗口内豁免。证据 `/tmp/wemux-next-multi-stage-review-Ji0W3u/`（checks、两端截图）。
- 回归：`@wemux/server` 全量 917/917；`@wemux/web-client` 318 pass/0 fail；`@wemux/web-next` 经 `scripts/test-with-browser.mjs` 166/166；`tsc -b apps/server packages/web-client apps/web-next` 退出码 0；`npm run build --workspace @wemux/web-client` 同步 dist。
- 阶段回执重播：`authorizeReviewReplay` 按当前获权与阶段隔离（前序决定者不得读后段回执、失去管理权即失去访问），`apps/server/src/test/multi-stage-review.test.ts` 覆盖。
- 边界：`agent` 审查策略无真实获权 Agent 决策面，门保持 blocked（Test Agent 是确定性执行器，不是审查决策面，也不得用付费 Runtime 或伪造批准替代）；`changes_requested` 第 2 段回实施仅服务端证明；票 07 继续 OPEN。

## 2026-10-07 真实来源待办与双端回访（01-10 切片，真实 Worker）

- 新脚本 `apps/e2e/next-attention-sources-browser.mjs`：真实 Worker CLI（受控 home、`register`/`start` 真实子进程）+ 确定性 Test Agent + Next Chromium（桌面 1440x1000 / 手机 390x844），替换此前合成投影的 `next-attention-review-browser.mjs` 证据。退出码 0，4 条 checks，`errors=[]`；证据 `/tmp/wemux-next-attention-sources-YEVpmc/`（checks.json、16 张截图、隔离数据库），checks.json 副本入 `.scratch/web-next-project-agent-platform/evidence/phase1-01/0110-attention-sources/`。
- 真实来源演练：实例管理员建项目并把审查策略设为 `human`（首次 Run 前设置，launch 冻结快照）→ 真实 Run 成功后 `POST /human-review-submission` 产生真实 approval 待办；项目 manager（获 `use` Worker Grant，否则 launch 404）在浏览器启动带 `[test-agent:fail]` 的真实 Run 失败产生真实 run_problem 待办。验证点：
  - manager 桌面/手机在待办中心看到自己的 approval（“成果审查任务”）与 run_problem（“异常任务 *”）来源，渠道死信区域明示“渠道死信仅实例管理员可处理，当前账号不是实例管理员。”；
  - run_problem 链接携带 `?run=` 深链回任务页正确 Run（“第 1 次执行：失败”与“故障：agent-error：Test Agent injected failure”）；approval 链接回到任务页“批准并完成”决定面；
  - 页面级注入 `route.abort('failed')` 于 `/api/attention/pages?kind=approval` 后出现 alert 且**不误显示空态**，解除后“重试任务人工审查”恢复列表（唯一注入窗口豁免 `net::ERR_FAILED` 控制台资源错误，其余 console/pageerror/response≥400 全零）；
  - 实例管理员（提交者，无决定权）与 outsider（无 Team/Project 权限）分别看到各自空态，outsider 视图全文不含他人任务标题；`GET /api/attention/pages?kind=channel_dead_letter` 管理员 200、outsider 403（越权负例）；
  - 受控 Worker 子进程 `start`/关闭均正常退出（SIGTERM 后 exit 0），无悬挂进程。
- 回归：`@wemux/server` 全量 917/917（`/tmp/server-test-0110.log`）；`@wemux/web-next` 带 Chromium 配置 `test:prepared` 167/167（无配置裸跑 3 项按设计失败于 "Browser acceptance configuration required"）；`tsc -b` typecheck 退出码 0。
- 边界（诚实门，未完成不得宣称）：16 张截图仍只确认生成与断言文本，未逐张人工视觉审查（当前会话无可用图像模型）；渠道死信仅验证授权与空态，无真实外部渠道死信条目导航（外部 Feishu/Webhook 投递属后续票）；`attention-service.ts:30-37` 的 `AttentionService.pages` 仍明确拒绝 `task_assignment`，为票 07 边界而非本票缺陷；协调计划批准/工具审批仍属后续票集成，不在本票冒充交付。
