# Ticket03 项目、工作区与任务管理：本地切片证据

状态：**partial / in-progress**。当前范围、已review增量与待验子项以如下CURRENT矩阵为准；不关闭原七条复合验收。

### Phase 1 / 01-05：Workspace 个人隐藏增补（2026-10-06，本地实现，待完整验收）

这是 D-03/D-04 新增的可逆**个人列表可见性**，不替代下面的 Workspace 安全删除资格，也不声称取消准备或停止 Worker。`GET /api/workspaces?visibility=visible|hidden|all` 默认只列当前用户可见 Workspace；`all` 在**同一个服务端事务快照**中返回当前账号仍获权且未删除的记录，每项有 `visibilityHidden` 与独立 `visibilityRevision`，客户端据此分组；已隐藏列表也从实际 Workspace/Worker 状态实时生成。`PUT /api/workspaces/:workspaceId/visibility` 接收 `{hidden:boolean, expectedRevision:number, requestId:string}`；当前 Project viewer 及以上均可只为自己切换/恢复，事务内重新授权、数字版本 CAS 与 requestId 幂等，版本从 0 起且每次实际切换递增，不与 Workspace 删除的共享 SHA256 状态指纹混用。即使重放旧 requestId，撤权后也返回 404；他人无权从列表发现或操作该记录。角色/Project Grant 实时生效。隐藏仅影响管理列表，不撤销对 Workspace 详情、Task 指派、Session 或试聊的既有授权；这些资源选择器读取 `all` 后仍按各自权限/就绪条件过滤，不得因个人列表隐藏丢失绑定或执行能力。隐藏状态保存在 `(account_id,workspace_id)` 独立 SQLite 表；共享 Workspace、Placement、命令、文件、Task 引用及历史准备证明不写入、不清理；迟到准备报告仍更新真实状态，列表不会自动恢复。永久删除仍经原单独 DELETE 的 409 保护门，准备取消继续拒绝。

**当前验证边界：** `apps/web-next/tests/real-worker-workspaces.browser.mts` 已在当前源码私有 Vite 构建 `/tmp/wemux-phase1-visibility-next-private` 下执行成功，证据 `/tmp/wemux-real-workspaces-IuA3Ym/evidence/result.json` 与同目录桌面/手机截图；两种视口均完成 UI 隐藏/恢复（个人版本 0→1→2）、隐藏期间真实第二 Worker 断线重连并确认新报告 ACK、双 Worker 物理目录和独立改动不变，原 Workspace DELETE/准备取消保护脚本亦通过。测试使用单主机上的两个独立真实 WorkerRuntime/transport/home，不含 Agent 运行时和跨物理主机部署；该双 Worker 脚本只使用单账号；另以 `WEMUX_VISIBILITY_ONLY=1` 跑 `apps/web-next/tests/project-management.browser.mts`，`/tmp/wemux-phase1-visibility-two-account-browser.json` **passed=true，60 条检查**，两视口中 Member 浏览器隐藏/刷新/恢复、Owner 仍可见、无权账号不可发现、撤权后隐藏列表与恢复拒绝、复权后可主动恢复，截图 `/tmp/wemux-phase1-visibility-two-account-browser.json.visibility-two-account-{desktop,mobile}.png`。后者是受控 Worker WebSocket 报告，不是真实 Worker 文件执行；两个脚本分别验证不同边界，尚未在同一多账号双 Worker 会话完成组合验收。完整 `project-management.browser.mts` 非聚焦执行曾在旧 Session 创建 fixture 处失败，不能当作完整浏览器回归通过；该失败与个人隐藏断言无关，后续需独立处理。`apps/server/src/test/workspace-visibility.test.ts` 覆盖双获权账号+无权账号、viewer 隐藏、撤权/重放、冲突与 ABA、独立恢复、旧库补迁移后 Workspace JSON 保持、SQLite 重启持久化、事务失败时可见性行与收据共同回滚、真实 HTTP 共享客户端及晚到状态反映（其中晚到状态是存储注入，不是 Worker 实际报告）。`/tmp/wemux-phase1-visibility-validation.log` 18/18，后续新加回滚定向测试 `/tmp/wemux-phase1-visibility-rollback.log` 5/5；`/tmp/wemux-phase1-visibility-server-suite.log` Server 913/913；Server/contract/client/Next typecheck/build 成功。Web-next 完整准备测试在配好绝对 Playwright/Chromium 路径后 `/tmp/wemux-phase1-visibility-web-test-browser.log` 166/166；首次无浏览器配置的失败不计产品回归。以上仍不是同一候选真实双 Worker + 双账号桌面/手机组合验收，也不是 Ticket03 全票关门。共享树另有并行在制代码，不能把所有检查归为本切片的独立无干扰候选证明。下一步补真实浏览器/Worker 证据并核对独立复审剩余项；01-04 保持 blocked，票 03/阶段 1 OPEN。

### Phase 1 / 01-04：关联 Session/Run 的 Task 删除合同及安全阻塞（2026-10-06）

**尚未交付成功删除。** 当前 `TaskService.delete` 仅对无 Session 引用、无活动 Run/开放审查的普通 Project Task 执行事务内 tombstone、解除 Task–Workspace 绑定和清空指派；保留 Workspace/Placement/Worker 文件、Task ID、活动、Run、审查和 artifact。已有 Session（包括 archived、deleted、idle、Worker 离线）、Run.sessionId 引用仍返回 `task_has_sessions`；活动 Run 优先返回 `active_run`。不指导用户删除 Session 来绕过守卫，不用 ACK、超时或 UI 停止图标推定执行终结。

**拟议成功资格（未实现，不可冒充现有行为）：** 在同一事务中按 Project owner/manager 与当前身份先授权、按 `requestId` 重放及 version CAS 后，必须证明每个相关 Run 已终结、没有待发/已接收但未完成的 create/enqueue/cancel 指令、关联 Session 无排队或执行中的非 Run Turn，且重连/晚到 Worker receipt、journal 和同步不会再启动工作或复活已删 Task 的 Run；缺记录、矛盾历史、跨 Task 复用或未知状态必须拒绝；跨 Task 复用本身是允许的历史关系，**只是当前拟议安全成功资格无法覆盖它**，不能据此阻断正常的 Session 复用。不能用 `Session.deletedAt`、`archivedAt` 或 Run 的终态单独作为证明。成功时只设 tombstone，不硬删 Session/Run/命令/活动/artifact，也不修改 Workspace 文件或其归属。已删 Task 的新 Session/Run/消息/文件/terminal/artifact 写入仍必须受阻；历史资源的原有读取权限与撤权需分别核对，不因为有 tombstone 扩大可见性：Task/Run/activity 和 artifact 历史读取按 Project 权限，存续 Session 按其 Project/shareScope/Grant 授权；现有 API 对 `deletedAt` Session 返回 404、列表不展示，底层行保留不等于它可由用户读到。

**现有反例与待改接缝：** `TaskService.sessions` 对 tombstone 直接抛 `task_deleted`（无法作为成功删除后的关联历史入口），`projectRuns` 只遍历非删除 Task，晚到 journal 会更新 Session 却不投影其历史 Run；`WorkerService` 的 receipt 分支也能修改 Run。`SessionAccessService` 的 owner/shareScope/Grant/Project 权限与 `ArtifactService` 的 Project 读取权限须分别保留，artifact 历史 review/登记则拒绝。Worker receipt、journal、sync 在 tombstone 前后的事实持久化、执行拒绝与投影一致性尚无已定义成功路径；不能仅将 Run 遍历改为 includeDeleted：先定义不再派发的终结证明以及晚到事实的保留方式。01-04 原计划列出的 service/route/单测文件范围不足以覆盖这些 Worker 与授权写面，实施时必须扩大审计和测试范围。`task-delete-artifacts.test.ts` 的历史 Run/Session 是合成拒绝夹具，非已终结真实 Run 的成功证明；其 PASS 只证明 fail-closed。需要真实终结 Run+Session 正例、pending/running/cancelling 与未决命令、离线/重连/迟到 ACK+journal、Session 复用/跨 Task、权限撤销、幂等/CAS/回滚、历史查询与双 Worker 文件保留的正反验收，并经独立复审。未完成前 01-04、Ticket03 和阶段 1 均保持 OPEN。

## CURRENT：Ticket03 验收对账（2026-10-03，含当前源码集中验证）

**本节是当前状态入口；其后各节保留为按时间追加的历史，不应用旧“尚未实现/待review/无CAS/无删除”覆盖当前代码。** 此前对账轮仅只读核对；随后parent批准列表发现单一接缝，列表发现E7已fresh独立review OK with notes/no issues；操作补验E8已获review OK with notes；其中接受的P2活动可见性修复已由parent核对源码/hash/原child16checks结果，parent未重跑。普通Task创建草稿保护E9已独立review no issues / OK with notes；E10 Metadata迁移原独立review为 **BLOCK（P1创建重试identity）**；窄修复已独立复审 **no issues / OK with notes，原P1 resolved**（E10-P1）。原BLOCK保留为历史，不改写原review。parent另已成功重算六个hash，此为完整性核对，不是测试。其余既有结果不冒充本轮重跑。整票仍`partial/in-progress`，七个复合checkbox均不改为完成。

最新七路由安全增量已经fresh独立review **no issues / OK with notes**，不是待review：`/opt/data/.pi/agent/sessions/--opt-data-profiles-hacker-workspace-project-wemux-mini--/subagent-artifacts/outputs/3bbbdbfb-8c9e-4522-9398-b081f0b11963/tickets/03/admin-route-auth-review.md`。该review未重跑测试且不能查看截图像素；只批准九文件安全增量与明确授权的Project作用域收紧，不批准全路由安全或整个Ticket03。

### 证据索引（E1–E12为既有分层证据；E13为本轮Slice A准备proof删除增量）

下列`E/`统一指`.scratch/web-next-project-agent-platform/evidence/ticket03/`；`R/`统一指`/opt/data/.pi/agent/sessions/--opt-data-profiles-hacker-workspace-project-wemux-mini--/subagent-artifacts/outputs/`。review描述的边界优先于测试数量；不把多个不同代码时点的结果加总为一次全量绿色。

- **E1 最新UI/权限回归**：`E/admin-route-auth/project.json`96checks、`account.json`115checks、`security-browser.json`20checks；`server-tests.log`44、`auth-tests.log`19、`client-tests.log`49。review `R/3bbbdbfb-8c9e-4522-9398-b081f0b11963/tickets/03/admin-route-auth-review.md`。20项中Project改名/空项目删除是真UI，Session管理是同origin HTTP，不冒充Session UI。
- **E2 内容并发**：`E/content-cas/server-tests.log`118、`browser.json`92；review `R/ff39484a-76f8-4228-8f38-b1ee6f14ebb9/tickets/03/content-cas-review.md`。真实outgoing PATCH扣留后竞争写，409、保留草稿、显式reload/同字段选择/不同字段合并；后续E1的96项保留该场景。
- **E3 Task删除**：`E/task-delete/real-worker-result.json`47、`server-tests.log`128、`lifecycle-regression.log`33（重叠）；review `R/cfa92a32-083e-4659-877f-18ea52747b24/tickets/03/task-delete-review.md`。**B政策只允许无关联Session/Run历史Task成功**，其余拒绝；非完整历史Task删除。
- **E4 Workspace删除/修复**：`E/workspace-delete-fixes/real-worker-result.json`57（含两Worker具体report seq/ACK通过后不复活）、`server-tests.log`66、`green.log`2；review `R/69c4d8ff-13bd-4615-9703-ee63e8fa3580/tickets/03/workspace-delete-fix-review.md`。mutation receipt revision是原快照，不是重放时最新状态。
- **E5 最新真实准备/取消拒绝**：`E/preparation-cancel/real-worker-result.json`61、`server-tests.log`61、`run-tests.log`87、`worker-tests.log`20；review `R/ea171805-25bf-425c-b393-ab3fda7ad2a3/tickets/03/preparation-cancel-review.md`。真实Worker/Git双home；取消是保护拒绝且继续执行，不是停止。Git branch原红/绿保留`E/git-branch-fix/`，review `R/97040027-45c9-421e-9513-187b0214b4be/tickets/03/git-branch-review.md`。
- **E6 导航/重试身份**：`E/task-workspace-navigation/wemux-ticket03-navigation-browser.json`72checks，及`E/retry-navigation-fix/wemux-ticket03-async-browser.json`84checks；后续E1 `project.json`已保留Task深链/后退/dirty编辑、身份退休、A丢响应→B确认→A同ID重试场景。review `R/63aa6a96-ac91-4019-bc80-9b74026e3333/tickets/03/retry-navigation-rereview.md`、`R/ef024e2b-9b9e-4367-b9e1-7441f5920e57/tickets/03/content-fixes-review.md`。以下优先引用存在且最新的E1，不要求恢复旧临时运行环境。

- **E7 列表发现（已review OK with notes/no issues）**：`E/list-discovery/result.json`14checks（desktop/mobile各7组行为断言）、`focused-tests.log`51tests、`project.json`96checks、`account.json`115checks；`red.json`保留实施前新版缺Task搜索控件的失败。精确运行和fixture边界见文末本切片节。review：`R/32292e84-2654-4692-9407-b688c42765a2/tickets/03/list-discovery-review.md`（parent consumed d99c0c6a）。review未跑测试、不能看截图像素；仅批准该增量。

- **E8 操作补验（原review OK with notes；P2修复parent已核对源码/hash/child结果，未重跑）**：`E/operation-evidence/result.json`12组desktop/mobile检查、`focused-tests.log`51tests、`project.json`96checks、`account.json`115checks。真实UI链接拒绝/恢复/移除、六条活动因果与refresh去重、Workspace改名刷新、viewer/无Grant拒绝；无生产源码改动。 原review：`R/6709f09c-cac4-41ff-a182-99b6ed3e2b04/tickets/03/operation-evidence-review.md`（8939f4f9）。P2补证据：`E/activity-visibility-fix/result.json`16组checks，含两端隐藏list/row拒绝与精确style恢复；不是像素视觉批准。

- **E9 普通Task创建草稿保护（已独立review no issues / OK with notes）**：`E/task-create-draft-fallback/result.json`12组desktop/mobile、`focused-tests.log`52、`server-tests.log`31、`project.json`96、`account.json`115；Server/Next及browser直接types、private Vite均通过。全部是本fallback实际新运行，不冒充旧8checks重跑。旧red/green独立保留并标为inherited；来源、精确manifest和有界限制见文末。独立review `R/5694ccea-ca5c-473b-a7c1-78eb142c47ac/tickets/03/task-create-draft-fallback-review.md`；reviewer仅检查，未重跑、重算hash或查看截图像素。

- **E10 普通Task高级Metadata JSON创建/编辑（原review BLOCK；P1修复已独立复审resolved）**：`E/task-metadata/result.json`18组desktop/mobile、`create-result.json`12组（既有创建草稿脚本扩为五字段）、`regression-tests.log`57、`server-tests.log`10、`project.json`96；Next与新测试直接types、private Vite通过。既有schemaVersion1/16000字符/null语义不变；同字段冲突显式选择、结构比较、dirty-only/CAS及身份退休见文末。非新metadata系统。

- **E10-P1 metadata创建重试identity修复**：原review `R/47a55910-4c0a-414b-8165-12358646f8b3/tickets/03/task-metadata-recovery-review.md` 为BLOCK。新证据 `E/metadata-retry-identity/`：真正提交后丢响应再递归重排object keys，desktop/mobile均先红（不同requestId、2个Task），修复后绿（同requestId、1个Task）；raw及实际POST payload原样保留。focused13、Next/browser types、metadata18/create12两端回归通过。只规范化Task metadata在intent中的贡献，不改通用useCreateIntent或Server fingerprint。独立复审 `R/6e031123-3bc0-4589-9e43-b2f94d06b55e/tickets/03/metadata-retry-identity-rereview.md`：no issues / OK with notes，原P1 resolved，仅该metadata增量；review未重跑测试或重算hash，parent另重算六hash成功（非测试）。

- **E11 当前源码集中验证（已独立review OK with notes/no issues）**：`E/current-integration/`。HEAD `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255` 加当时全部tracked/dirty/untracked源码快照；Server159、Worker/shared88、client/Next59通过，Project96/account115/真实Worker61各desktop/mobile通过，不与历史次数累加。全部package及Server/Worker/Next project types通过；**该轮扩展browser直接types RED：7项TS7006**保留；后续E12相同命令已绿，历史real-worker直接types不是替代。metadata-P1 browser不在本轮三脚本中，没有声称重跑该专项。

- **E12 review状态更新**：七callback typing repair已独立review **OK with notes / no issues**，`R/bab69d80-9166-4837-b9fb-ac9136615592/tickets/03/fixture-types-review.md`。review未重跑测试/hash、没有像素批准；不是pending。

- **E13 Slice A准备proof与删除集成（两阶段已独立review OK with notes/no issues，parent 已接受限定状态对账）**：`E/preparation-proof-ledger/`为stage1内部存储/观察证据；`E/preparation-proof-delete/`为本轮stage2独立增量与当前联合验证。37/37 focused Server tests，真实双home Worker/Git desktop/mobile 67checks；同一最终源码Server types、Next/browser types、private packages/Vite通过。两阶段原独立review：`R/74cea753-d2d9-40d5-a7b3-e38fcb7822c2/tickets/03/preparation-proof-review.md`；parent 已接受状态对账：`R/6933c88c-5371-4c45-9e2c-e957de897c1f/tickets/03/preparation-proof-closure-review.md`，均为 OK with notes，仅限 Slice A。对账继承原审查结论，不是新代码审查、测试/构建或源码 hash 复核，不批准当前整棵 dirty tree。不把stage1内部测试当作文件删除证据。

### 唯一当前要求矩阵（按原七条拆分）

状态词：**已验证**=存在适用行为证据且限定增量review通过；**已实现/待补验证**=源码存在但下列具体断言未找到；**部分**=批准的子范围通过但原更广能力仍未满足；**未开始**=未发现实现/证据。review只覆盖其增量，不为全票背书。

| 原条款/具体要求 | 当前代码/合同入口 | 当前状态、最新适用证据/review | 精确剩余动作（不自动扩域） |
| --- | --- | --- | --- |
| 1a 项目列表、详情、搜索及获权计数 | `apps/web-next/src/components/Projects.tsx:10–28`；GET projects及ProjectAccess | 已验证：E1列表/深链/refresh、撤权；account115保留搜索节点/焦点/过滤值 | 无已识别本子项实现缺口；最终一次current候选回归门另列 |
| 1b 项目排序 | `Projects.tsx:12–16`名称/角色、id稳定tie-break | 已验证且限定review通过：E7四个获权Project+隐藏Project，两种实际顺序、相同name/role ID tie-break、搜索交互和两viewport | 此子项限定review已通过，不引入持久rank字段 |
| 1c 已有项目配置/生命周期及普通Task归属 | `ProjectManagement.tsx:31–35`；`resource-routes.ts`；`ServerService.update/delete`；`TaskService.project/workspace` | 已验证的限定合同：E1 admin且owner/manager才改名/删除eligible空Project；保留Task/Workspace含tombstone则409；Task/Workspace跨Project/Team拒绝 | 保留约束不是删除失败bug；不得将Team协调/自动聊天归属（04/05等后续票）宣称本票已全实现 |
| 2 共享范围、Grant、撤权、无权/名称计数不泄漏 | `ProjectManagement.ProjectAccess`、ProjectAccessService；application generation/role remount | 已验证：E1、E4、E6；真实API跨Team拒绝、viewer降权、held detail/workspace/activity、身份/Team退休 | 不是全系统权限审计；无本子项新增生产工作建议 |
| 3a Repository关联及真实配置生效 | `ProjectWorkspaces.tsx:11–14`输入gitUrl/revision；`ServerService.createWorkspaceInTx:391–425`创建关联Repository；LocalProvisioner | 已验证：E5真实固定SHA/独立branch与tag失败修复；明确不支持独立CRUD/修改既有关联 | standalone CRUD无精确本票必须实现依据，见下裁定；不要另造Repository后台。现列表显示Repository ID，不声称有独立Repo详情编辑器 |
| 3b Workspace创建、选Worker、多个Placement、失败/安全重试 | `ProjectWorkspaces`、`TaskWorkspaces`；workspace/task routes、reprovision | 已验证：E5两真实Worker私有home目录/HEAD/文件、分离失败原因/retry；E1包含Task内创建/绑定与按Placement身份重试 | 限同机双home+本地Git，无远端认证/跨主机/CLI安装声明；历史attempt证明不足只影响下面删除资格；Workspace改名同身份、列表/刷新/重载另由E8补验（原review OK with notes） |
| 4a 普通Task列表/看板/详情/创建/内容/状态/验收标准 | `ProjectTasks.tsx`、`TaskContentEditor.tsx`、TaskContentDraft、TaskService.patch | 已验证核心：E1/E2真实多行/null空串、dirty-only、status/content CAS、深链与未保存**编辑内容**保护 | 标题搜索/状态筛选E7已迁移且独立review通过；普通Task新建草稿保护E9已review；高级Metadata JSON创建/编辑E10及P1修复已独立review（限定增量） |
| 4b Task排序 | `ProjectTasks.tsx:15–22`更新时间/名称/优先级+id tie-break；旧board拖放调用status PATCH而非rank | 已验证且限定review通过：E7四Task固定时间/内容，三种实际列表顺序、每状态看板列内顺序和ID tie-break | 此子项限定review已通过；没有持续手工排序新合同依据 |
| 4c 外部关联、活动 | `TaskDetailPanel.tsx:16–24`、TaskService.link/activity；`tasks.test.ts:79–86` | 原review OK with notes；P2修复parent已核对源码/hash/child16checks（非parent重跑）：E8实际UI移除、服务端非法URL400/输入纠正、六条活动type/payload/actor/seq与UI时间对应，刷新/重载不重复；viewer/无Grant负例 | P2 waited list/row visibility证据已由parent核对；独立像素视觉仍blocked；不新增全局timeline（07/15） |
| 4d 指派与Workspace绑定、CAS/权限/lifecycle | `TaskDetailPanel.tsx:18–23`、TaskWorkspaces；assignment/bind/unbind/create/retry | 已验证：E1/E3，Run/Workspace/assignment public tests；实际可用候选、改指派CAS、跨scope、绑定唯一性 | combined create+assignment由API证明、UI采用创建后独立指派是已批准边界；非Session对话执行验收替代 |
| 5 expand–contract、兼容字段/旧入口、CI | optional create requestId、content version、Workspace revision/terminalReport、shared transport | 部分：E1–E5 focused tests/types/build:packages及review；旧无versioncontent兼容且会升version，自己不承诺CAS；no-body旧501改400已批准 | “CI保持通过”未取得根/完整candidate证明，不能勾；无需旧Web全量browser回归，但最终current快照集中检查另安排 |
| 6a 准备取消相关有效行为、真实错误 | generic DELETE command保护、`ProjectWorkspaces`不可用说明 | 已验证**migration-only拒绝**：E5任意provision409、outbox/command不改、重连实际继续完成、非admin先拒绝 | 物理停止准备未开始（无新wire/abort合同），属批准的未来能力，不是用“取消”一词自动强迫本票新协议；不能写成功停止已验 |
| 6b Workspace逻辑删除、不动文件 | deleteWorkspace+canonical state fingerprint+per-attempt proof、WorkspaceDeletion | E4/E5原受限合同已review；新增E13 Slice A每attempt accepted+terminal proof及当前严格proof，fail→retry→ready实际DELETE后文件保留，**两阶段已独立review OK with notes/no issues，parent 已接受限定状态对账** | 部分且OPEN：未知旧attempt、Task/Run/Session/composite引用仍拒绝；不支持全历史删除或取消，不用ACK/超时补proof |
| 6c Task删除不删除Workspace文件 | TaskService.delete B-policy、TaskDeletion | 已验证受限正例：E3及E5真实Task DELETE后双home编辑文件仍在，不是unbind/teardown替代 | 部分且**明确OPEN**：任何关联Session/Run历史Task不能删，缺终端/in-flight/accepted执行settlement及保留history合同。此批准局部实现不能自动消除原条款适用范围差额 |
| 7a 重复提交/并发修改可恢复 | explicit create IDs、PlacementRetryIntents、content/status/assignment CAS、DELETE replay | 已验证：E1/E2/E3/E4丢响应/异体/重启/并发、真实outgoing PATCH竞争409恢复；legacy无version限制公开 | 普通Task未提交创建表单现已纳入E9 dirty guard（已review），metadata五字段扩展E10及P1修复已独立review；其他创建表单未改，不能扩大为所有表单。自然过期/部署重连宽门属后续集成门 |
| 7b 桌面/手机Project→Workspace→Task真实链路 | `project-management.browser.mts`、`real-worker-workspaces.browser.mts`、admin-route browser | 已验证受控私有真实API/两Worker链路：E11同一snapshot的UI96/account115与真实61；focused同源回归不是全当前release运行 | E11当前源码Project96/account115/真实Worker61两端已重跑通过；expanded fixture types在后续E12窄修复后已绿，不是完整candidate/全CI。独立像素视觉与真实部署使用门未过 |

### 两个易被历史“剩余”放大的范围裁定

**Repository**：原第3条明确“关联Repository…未实现的仓库能力不伪装为已交付”，PRD故事14（`docs/specs/web-next-project-agent-prd.md:43–44`）描述获权资源组织；spec迁移表（`docs/specs/web-next-project-agent-platform.md:48–55`）与operation inventory项目/Workspace行要求已有项目配置/仓库/Placement/失败重试。旧`apps/web/src/components/create-dialog.tsx:42–53`也只是随Workspace输入URL/revision；当前routes没有独立Repository CRUD端点，ServerService随创建保存Repository。**未找到必须新增独立CRUD/更换既有仓库的确切票据操作合同**；它仍未开始/不提供，但不是凭“管理Repository”三个字即可阻断当前关联验收的必建新产品。若parent需要独立CRUD，先拆明授权、复用和修改语义，不能本轮暗加。

**排序**：原第1/4条与Paperclip来源段（spec:83）要求排序；当前select排序确实存在。PRD §5读取“有界分页、稳定排序”（PRD:157）也不是持久用户rank/拖放排序合同。旧`apps/web/src/features/tasks/board.tsx:68–94`拖放只写`{status,version}`，`/move`仍调用TaskService.patch；TaskContentPatch无position/rank字段，当前`tasks.list`按rowid读取、UI自行排序。**没有持久手工ordering需新建的明文要求**；E7已补实际排序结果断言且限定review通过；不是只点击选择框便勾选。稳定分页/项目级Agent资源API是整体PRD跨票合同，不能以UI sort假装其已完成。

### 最小下一步与本票本地收口顺序（建议，需parent采纳）

1. **parent已采纳本轮范围**：Standalone Repository CRUD/持久rank不新增；protected-refusal迁移与未来物理取消分开；历史Task删除/Workspace未知旧attempt及保留引用差额继续OPEN；Slice A仅已证明attempt删除的两阶段已独立review OK with notes/no issues，parent 已接受限定状态对账，由parent决定另立后续生命周期门还是仍为Ticket03关闭前硬缺口。没有这项决定不能称全票已满足。
2. **Task列表发现能力已实施/本地验证且独立review通过**。旧board:79–85标题搜索/状态筛选迁入ProjectTasks同一列表view seam；遵循现有Next view/sort内存状态，不新增URL/persistence语义。现有Project/Task排序最终顺序已补E7。已完成限定fresh review，不扩大到全票。
3. **有限操作补验E8已review OK with notes，P2 visibility修复parent已核对原child证据（未重跑）**：UI link移除/非法URL恢复、Task活动内容/刷新无重复、Workspace改名后的列表/刷新/重载及移动/权限负例已真实断言，无生产修复。普通Task创建draft E9已review；parent已批准并完成Metadata JSON迁移E10，P1已独立复审resolved。
4. **普通Task创建草稿保护E9已独立review，Metadata JSON迁移E10及P1修复已独立复审通过**，仅普通Task表单serialization/reconciliation。旧board:112与TaskDraft/Server.content为合同来源，不声称本轮旧UI已跑，不捆Repository/rank或生命周期新合同。
5. 在已决定范围内做**一次当前候选**的focused Server/Worker/shared+types、Project/account与realWorker两端聚合验收、再fresh review矩阵中的未验断言。本轮E11已执行授权的集中focused验证，当前三类双端browser均通过；expanded fixture typecheck留下7项TS7006历史红证据，E12已修复重验。E11已限定独立review通过，不是根/candidate全CI；E12已独立review OK with notes/no issues。复合criteria按剩余子项逐条决定，不能用历史总测试数勾选。

### 单列延期/外部前置门（不伪装pass）

- Ticket01最终依赖/root candidate门按用户override允许下游临时推进，仍未验收；根build/test/完整CI未跑。本轮仅授权隔离snapshot focused验证且已执行；完整candidate/root运行仍需单独授权与候选锁定，避免共享dist/tgz写冲突。
- 独立截图像素/视觉/无障碍人工或可看图review尚未完成；需要具备图像查看能力的reviewer或人工。已有mobile脚本断言不等于像素review通过。
- PRD:173–175、末“产品验收”要求实际使用/双宿主/Agent入口；当前证据是私有真实Server/两home Worker与受控protocol混合，不能替代真实部署/跨主机/CLI包、Worker独立宿主、Agent/会话/画布等其他票。外部网络、真实账号、付费Runtime另需明确授权，不能让不可用前置变成暗中安装或模型调用。
- 更广历史删除/物理取消若parent决定继续，需明确settlement/retention协议与可控并发夹具，不以删除Session或ACK/timeout/现有保守拒绝替代。不是本轮可自行新增的架构。
- 本次 parent 接受仅关闭 E13/Slice A 两阶段独立 review 待办，不授予当前部署身份、整票或当前整棵工作树验收。尚未授权 provisional Ticket03→Ticket04 依赖例外，不启动 Ticket04 或改变其状态；本次文档订正交 parent 检查，不再重复该增量 reviewer 轮。


### E11 当前源码集中验证：来源、红证据与剩余门（2026-10-03）

本轮只写验收文档和证据，没有生产或测试源码修复。private snapshot `/tmp/wemux-ticket03-current-vwf_ggzg/source`，raw logs及build `/tmp/wemux-ticket03-current-vwf_ggzg/`；归档 `E/current-integration/`。精确展开前命令、cwd、UTC起止、exit见`commands.jsonl`；完整逐检查断言见三个result JSON。source manifest覆盖1025个tracked/dirty/untracked文件，SHA256 `957da74cbf49c69e77d1a7daa4e5108c4a38e10e6ae6e8e337d06675fcf8d110`；所有package源码和lock包含在内。原共享产物619项有独立hash/mtime manifest；重新私有构建后274项package输出与共享一致，Server输出39项不同或缺失，**不能用共享Server dist代表当前源码**。本轮七packages/Server均私有重建；浏览器和Server测试加载snapshot Server TS，真实Worker加载snapshot WorkerRuntime/WebSocketTransport/LocalProvisioner TS，package ESM解析逐项确认指向private dist。所有共享产物hash及mtime未变。

Node v26.5.1/npm11.17.0；外部已装依赖经只读symlink复用，不安装。Playwright `/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs`、Chromium `/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`。private Vite build成功，三browser均经原`test-with-browser.mjs` preflight、dynamic loopback端口、合成账号/私有SQLite和outbox；desktop1440×900/mobile390×844。Project使用受控Worker协议，不能作为真实准备证据；real-worker用两个真实私有home及file-only本地Git、无Agent adapters/付费Agent/外部Git。实际检查包括Git SHA/tag/branch失败恢复、双落点独立文件、拒绝取消后重连继续完成、Task与Workspace受限真实DELETE后文件保留、相关report seq/ACK drain后不复活；Project含导航/身份退休/CAS/权限，account含邮件/Team/登录生命周期与搜索焦点保留。原始61/96/115检查清单保留，DOM不等于视觉批准。

**初始准备失败及恢复**：/tmp helper假设所有workspace候选有name，在已知辅助包`apps/e2e/package.json`遇`KeyError: 'name'`，exit1，立即停报，尚无build/test。parent明确批准按root workspaces枚举、仅对该已知无name辅助包不建name链接，源码保留，其他缺失name/dependency mapping应失败；仅/tmp helper窄修并保留preimage/diff，恢复exit0。没有CLI fallback。

**类型红证据**：package/Server/Worker/Next各project `tsc --noEmit`全部exit0；之后扩展direct browser命令exit1：`project-management.browser.mts(93,22)` url、`(93,88)` route、`(120,44)` response；`task-async-intent-scenarios.mts(44,20)` url、`(44,57)` route；`task-navigation-scenarios.mts(7,20)` url、`(7,76)` route，均TS7006 implicit any。parent批准保留红继续browser，不修源码。只涵盖real-workspace-worker.ts及real-worker-workspaces.browser.mts的历史direct types另跑exit0，**不覆盖/抵消扩展types失败**。后续parent已批准E12最小callback类型注解修复，相同expanded命令通过；原红日志和snapshot不改写，未降低检查配置。

cleanup：三脚本exit0；project/account finally删除owned root，real-worker `cleanupFailures=[]`且`/tmp/wemux-real-workspaces-HqwZbZ`仅剩evidence、无state；最终无属于本轮browser/Worker/Server/Git的存活进程。private snapshot/build/raw证据有意留/tmp；没有部署、真实凭据、8004/8010、root npm build/test/pretest、共享dist/tgz替换或stage/commit。index为空。文档修改前源码1025项均未漂移，文档preimages/posthash独立归档。

| 剩余门类别 | 具体未满足事项 | 状态/责任边界 |
| --- | --- | --- |
| 产品缺口（OPEN，未豁免） | 关联Session/Run历史Task删除；历史accepted prepare attempt无proof及保留Session/Run/composite的Workspace删除 | 当前保守拒绝，不是全生命周期实现；需parent生命周期决策，不由本轮设计或删历史解锁 |
| 产品未提供/未来能力 | 真正物理停止Workspace准备；独立Repository CRUD、持久手工rank | 保护拒绝已验；后两项无已确认本票必建合同，不能冒称已交付或暗加范围 |
| 验证缺口 | 完整candidate/root CI、Ticket01最终依赖 | Slice A两阶段独立review已OK with notes/no issues，parent已接受限定状态对账；E11已限定review；原7项TS7006由E12相同命令重验绿，旧RED保留；focused不是full CI，不替代专项browser证据 |
| 外部blocked | 独立截图像素/视觉批准，真实部署/跨主机使用 | DOM/截图存在不等于像素批准；无生产部署/外部凭据授权，不得用CLI fallback |
| 后续票责任 | Task-bound对话/Agent入口（04/05/08）、Worker独立宿主（13/14）、全功能收敛/切换（15/16） | 双宿主/Agent/真实部署门均未过；私有同机两home不是双宿主交付 |

原七条复合checkbox继续OPEN，Ticket03/all16仍partial；metadata原P1已由限定独立复审解决，不把该review或parent六hash核对写成本轮测试。


### E12 browser fixture七项类型修复（2026-10-03，test-only，已独立review OK with notes/no issues）

**E11已获限定独立review OK with notes / no issues**：`/opt/data/.pi/agent/sessions/--opt-data-profiles-hacker-workspace-project-wemux-mini--/subagent-artifacts/outputs/b3105207-2a3b-4cc2-bbf1-02cc1755ac54/tickets/03/current-integration-evidence-review.md`。该review只批准集中验收证据增量，未重跑测试/build/hash，非全Ticket03/all16或release批准。

parent本轮仅批准修复E11七个TS7006。`project-management.browser.mts`、`task-async-intent-scenarios.mts`、`task-navigation-scenarios.mts`的七个callback参数增加URL与最小准确结构类型：request method/requestId、route fetch/abort/continue/fulfill及response url/ok/json。没有增加any、ts-ignore、编译器降级、安装依赖、production或运行语句变更；使用结构类型避免把仅外部安装的Playwright路径写入源码。相关JSON payload类型限定这三个既有测试场景，不是新的通用browser接口。

**本轮新执行**：NEW snapshot `/tmp/wemux-fixture-types-29etnxe7/source`；相对E11 snapshot精确delta仅三测试与E11已完成的acceptance文档变化，生产/package源码无delta。原 `/tmp/wemux-ticket03-current-vwf_ggzg`及`E/current-integration/typecheck-red.txt`完整保留。相同expanded direct fixture命令（同flags、四入口、全部imported helpers）**exit0**，client/Next相关**59/59**，受影响Project browser desktop1440×900/mobile390×844 **96checks exit0**。private七package/Server/Vite重建、原browser preflight成功；全部产物在新/tmp，ESM解析指向新private package dist。命令/UTC/exit、source/build及增量manifest、preimages/diff和browser结果见`E/fixture-types-fix/`。**account115、realWorker61、Server159与Worker/shared88是E11既有通过，本轮没有重跑或累计**。

新增可选“emitted-JS等价”/tmp辅助脚本错误假设installed TypeScript存在`lib/typescript.js`，报`ERR_MODULE_NOT_FOUND` **exit1**。立即停报，parent明确批准放弃此非必需证明、保留失败日志，不修helper、不换CLI协议。**不能称所有命令成功或已执行证明字节等价**；运行逻辑不变是注解diff判断，已独立review OK with notes（非字节等价证明）。必需expanded types/tests/Project browser已真实通过。

cleanup：Project原finally清理private Server/peer/browser/SQLite根目录，exit0，最终无本轮owned Node/Chrome/Git进程。共享packages/apps dist/tgz全部hash及mtime未变；E11证据hash未变、旧private源码保留；index为空。raw日志和新snapshot/build保留 `/tmp/wemux-fixture-types-29etnxe7/`。仅本类型门由历史红转绿，不关闭历史Session/Run Task删除、Workspace历史proof/保留引用、独立像素、root/candidate CI、Ticket01依赖、双宿主/Agent/部署门，七复合checkbox与Ticket03/all16继续partial。

---

### E13 Slice A stage2：每次准备证明消费、严格回填与真实重试后删除（2026-10-03）

**当前状态订正：implemented / locally verified / independently reviewed OK with notes（Slice A 两阶段，No issues found）；parent 已接受限定状态对账**。原独立 review：`/opt/data/.pi/agent/sessions/--opt-data-profiles-hacker-workspace-project-wemux-mini--/subagent-artifacts/outputs/74cea753-d2d9-40d5-a7b3-e38fcb7822c2/tickets/03/preparation-proof-review.md`；对账：`/opt/data/.pi/agent/sessions/--opt-data-profiles-hacker-workspace-project-wemux-mini--/subagent-artifacts/outputs/6933c88c-5371-4c45-9e2c-e957de897c1f/tickets/03/preparation-proof-closure-review.md`。对账不重复代码审查、测试/构建或 hash 核验，不证明当前源码与原快照相同；后续其他 dirty-tree 增量不在接受范围。以下实施与运行结果均为原轮次记录，并非本次重跑。

唯一生产改动在`apps/server/src/application/server-service.ts`：重试替换前及删除事务内，只从当前Placement已存在的terminalReport回填stage1 immutable ledger；验证current command、Worker、Workspace retained command归属、ready/failed状态、时间与location身份。旧status、reportedAt、receipt、ACK或超时均不是proof。删除逐一检查所有retained provision command的accepted状态和各自proof，同时仍需当前Placement terminalReport一致；所有Task绑定/指派/Run/Session/composite引用、授权先于replay、requestId fingerprint/CAS保留。proof、tombstone、audit、receipt同事务；ledger不进入revision。重试不会补造已丢失旧proof，delayed superseded report仍按旧政策忽略。

复用stage1 storage/report seam，没有改Worker wire/runtime、Task/Session lifecycle或UI生产copy。现有Next删除说明“证据不足拒绝、不取消、不删文件”仍准确，不必改。

**精确来源**：HEAD `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255` intentional dirty tree，fresh snapshot `/tmp/wemux-preparation-delete-p29eyixs/source`；归档`E/preparation-proof-delete/`。`source-manifest.json`记录初始1027文件；`source-final.json`记录测试最终源码，`changed-files.json`列stage2六个文件的pre/post hash，`implementation.diff`相对本轮preimage而非HEAD巨量dirty diff。stage1五文件无改动。`commands.jsonl`记录cwd/完整命令/UTC/exit；private七package dist与Vite UI全部本轮重建，七ESM解析均指向private，619共享artifact hash/mtime不变。

**新运行结果**：37/37测试（6新stage2 + 6 stage1 + 25既有删除/取消/Task Workspace回归），Server/Next/direct real-worker fixture types exit0。覆盖当前proof回填、fail→retry保存旧proof、legacy历史无proof/迟到旧报告拒绝、wrong identities/status/time、accepted独立要求、restart/同ID并发重放/异体冲突、撤权后拒绝replay、ledger-only revision不变但事务检查、audit/receipt写后回滚、retry回滚及failed placement DELETE/retry竞争。原Workspace retry测试从有proof历史拒绝改为允许；unknown历史仍有独立拒绝用例。

真实browser **67checks exit0**：desktop1440×900/mobile390×844，两真实WorkerRuntime/WebSocketTransport/LocalProvisioner私有home、只允许本地Git、无Agent adapters。每viewport独立缺tag与branch的真实失败→本地补revision→UI retry ready→**实际UI DELETE 200**，删除前后文件编辑内容/Git HEAD、两attempt accepted命令和failed/ready ledger、当前Placement保留；再真实reconnect，等待特定Workspace/command/epoch/seq的ACK drain后tombstone不复活，文件仍在。ACK只证明报告已送达，不是删除资格。原双落点编辑文件、Task删除、原始Workspace删除与丢响应/冲突场景也通过。final browser `/tmp/wemux-real-workspaces-JvCKqB/evidence`，完整结果和截图复制归档；前一绿运行另存不累计。没有声称视觉像素review通过。

**实施测试RED完整保留**：初次新fixture Timestamp缺brand导致TS2322，补准确Timestamp cast后types绿；初次断言用API transient offline health视图对比tombstone raw placement，失败后改为保存raw placement比较，生产无策略变更。两份red fixture与日志保留，最终tests/types/browser在最终生产源码上重跑成功。没有基础设施失败、依赖安装或外部服务回退。

**cleanup/边界**：两次browser finally关闭browser、两个Worker/SQLite、Server并移除owned state，cleanupFailures=[]；最终owned进程扫描为空。snapshot/build/logs及截图有意保留/tmp与scratch。没有root/shared build、deploy、stage/commit/reset/clean、8004/8010、外部Git/Runtime/凭据/安装。完整性检查无无关源码漂移，index空。E12七类型修复已review OK with notes，精确review路径见上；本E13/Slice A两阶段的独立review已完成，parent已接受上述限定状态对账。Task历史删除、未知attempt及所有保留引用的Workspace删除、视觉/root/candidate、双宿主/Agent/部署、七复合checkbox与Ticket03/all16 **全部相应OPEN**，没有擅自豁免。

---

## 以下为历史逐次实施与验证记录（保持原文，包括当时未实现/待review/FAILED状态）

状态：**partial / in-progress，待独立审查**。Ticket01 最终依赖验收和完整 candidate/root gate 已由用户允许延期，本票可临时推进，但不是依赖验收或发布批准。没有删除旧兼容路径，没有执行提交、部署、根 build/test 或共享 Web/Worker dist/tgz 替换。

## 操作与权威合同映射

| 能力 | 既有权威服务 / 旧 UI | 新版实现与证明边界 |
| --- | --- | --- |
| 项目列表、排序、概要 | GET `/api/projects`；旧 projects 页面 | 只使用当前账号过滤后的列表；名称/角色本地排序、搜索。Ticket02 搜索输入节点/焦点/过滤值保持不变。 |
| 项目创建、配置、生命周期 | POST/PATCH/DELETE `/api/projects[/id]`，`resource-routes.ts`、`ServerService`；旧创建对话 | 新版管理员新建、改名、删除空项目；非空项目删除409。保持管理员权限，不新增跨 Team 移动。 |
| 共享、Grant、撤销 | `/projects/:id/access`、`/grants`；`project-access.tsx` | 新版项目设置；owner/manager 管理，同 Team 成员选择。真实 HTTP 跨 Team Grant409、不可见详情404、列表排除；撤权重放拒绝、挂载页面焦点核验后清屏。 |
| Repository 关联 | Workspace 创建 body `source=git/repository`；旧工作区创建 | 保存 Git URL/版本并关联 Repository；浏览器只证明登记，不声称 clone 成功。当前没有独立 Repository CRUD/修改关联合同，页面明确说明。 |
| Workspace/Placement | GET `/workspaces?projectId=…`、POST `/workspaces`；旧 workspace UI | 列表、独立逻辑 Workspace、选 Worker 创建、每落点状态/失败原因/路径、管理员改名。 |
| 新增 Placement、重试 | POST `/workspaces/:id/reprovision`，接受 absent/stopped/failed Placement | 旧 client 的专用 placements 路由不存在；新版使用真实 reprovision 合同为 absent Placement 创建命令。协议 Worker fixture 证明失败→重试→ready 投影，**不是实际磁盘准备**。 |
| 准备取消 | DELETE `/commands/:id` | 当前 Workspace provision 命令受保护，pending/accepted 都可409；页面明确限制并显示真实错误。取消不等于文件回滚/删除。 |
| Workspace 删除 | generic DELETE `/workspaces/:id` 最终固定501 | 页面明确暂不支持，不伪造删除按钮或成功。HTTP 已证明501。 |
| Task 内容、列表/看板、排序 | `/projects/:p/tasks[/t]`、`TaskService`；旧 `features/tasks/project-pages.tsx` | 创建/编辑标题、描述、优先级、验收标准；列表/七状态看板、名称/更新时间/优先级视图排序。没有持久拖动顺序合同。 |
| 状态/CAS、指派、绑定 | PATCH task、PUT/DELETE assignment、PUT/DELETE task workspaces；旧任务详情 | 状态/指派保持既有 version CAS；冲突保留表单，显式加载最新版本后重新提交。绑定/解绑当前 Project Workspace，ready/online/available 执行环境选项；服务端仍做最终授权。 |
| 外部关联、活动 | task `/links`、`/activity` | 支持 GitHub Issue/PR URL 添加/移除，显示活动；活动类型/载荷保留服务端事实。当前活动接口无分页上限，未擅自新增合同。 |
| Task 删除 | 专用 task routes 与 generic resource routes 均无支持；既有 tasks HTTP 测试也约束404 | 经 supervisor 批准，本轮不发明删除领域语义。明确暂不支持；**解绑保留 Workspace 不能代替 Task 删除保留文件验收**。 |
| Task 内新建/重试 Workspace | `TaskService.createWorkspace/retryWorkspace` 已存在 | 本轮先交付项目工作区创建→任务绑定路径；任务详情的一步创建/失败重试仍需迁移。 |

## 增量实现

- `packages/web-client/src/project-management.ts` 使用共享 Cookie/CSRF、Team 范围、身份取消 transport；工作区不走不存在的 `/projects/:id/workspaces`。
- `browser-host.ts` 增补 Workspace/Worker 读模型；Task 使用既有 `task-platform` 类型。没有移动或删除旧 DTO/调用。
- 项目管理拆为 `ProjectManagement`、`ProjectWorkspaces`、`ProjectTasks`、`TaskDetailPanel`。中文表单、既有 Paperclip tokens、手机布局、共享 randomId/复制降级保留。项目详情刷新时保留编辑器 DOM，但隐藏并 inert 至权限核验完毕；撤权后卸载，不显示缓存标题或计数。
- 显式 **body.requestId** 才启用创建幂等。`X-Request-ID` 继续只是可复用追踪号。记录 key 隔离 actor、project/workspace/task 操作、Team/Project scope、requestId；规范化有效输入指纹，同体返回原创建结果、异体409。
- 原子记录在已有 SQLite `records` 与 ServerStore FIFO transaction 内提交，和领域记录、Task 活动、Workspace 准备命令同事务；无额外框架/依赖/数据库迁移。每次重放重新经过 HTTP 鉴权和领域授权；无 ID 旧调用保持原语义。
- UI 同一创建意图的未知响应重试保留 requestId；成功或修改内容开始新意图。只在本组件生命周期保留，跨页面重载恢复待提交意图未实现。

## 本轮实际验证

私有 dist `/tmp/wemux-ticket03-ui`；浏览器脚本每次新建动态 loopback 端口、SQLite、outbox、合成 owner/member/outsider；仅清理脚本创建的资源。未用8004/8010、生产账号/数据库或外部模型；没有外网安装/真实 Git clone。Worker 是现有 `TransportV2Peer`，通过真实 Worker WebSocket 上报能力和准备结果，不是 UI mock。

- Server focused **29/29**：新增创建幂等 HTTP 测试以及既有 tasks/task-workspaces/task-assignment-http。6并发创建只产生一个对象/准备 commandId；同体重放、异体409、追踪号兼容、校验失败、重启持久化；注入索引写失败回滚后同 ID 可重试。既有测试含准备重放、旧 attempt、取消保护、CAS、活跃执行限制与事务失败。
- Client/application focused **39/39**：新增共享 client body、scope、CAS、解绑/清指派、身份取消测试；保留 Ticket02 stale-response/会员撤权 generation guards 和 HTTP randomId/clipboard tests。
- 新脚本 `apps/web-next/tests/project-management.browser.mts`：**42 explicit checks**，桌面1440×900/手机390×844。每端真实项目创建→Workspace/Placement→Task；协议失败/重试/ready；Repository 登记、absent Placement；丢失创建响应再提交无重复；内容/状态CAS冲突与最新版本恢复、指派/清除、绑定/解绑、外部链接、看板排序；跨 Team/Project 绑定403和错误Team scope403；Grant越权与撤销后重放；两种 actor 相同 ID 不共享结果；挂载草稿跨焦点刷新保留、不可见名称计数清除；空项目改名/删除、非空拒绝；无 pageerror/页面横向溢出。脚本中步骤断言比 explicit checks 多，不将数量当独立旅程数。
- 既有 `account-team.browser.mjs`：**115 checks，双 viewport** 再跑通过；特别证明项目搜索/焦点/过滤值在焦点与15秒轮询期间保留，撤权仍清列表/命令。
- packages build、Server/Next typecheck、git diff whitespace 检查通过。根和 release gates **未执行**。

可重复命令（现成本机浏览器路径可替换为相容安装，不下载）：

```sh
npm run build:packages
npm run typecheck --workspace @wemux/server
npm run typecheck --workspace @wemux/web-next
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir /tmp/wemux-ticket03-ui
node_modules/.bin/tsx --test apps/server/src/test/{project-create-idempotency,tasks,task-workspaces,task-assignment-http}.test.ts
node --experimental-strip-types --test packages/web-client/tests/*.test.mjs apps/web-next/tests/{application,account-routes,source-boundaries}.test.mjs
export PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs
export PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
export WEMUX_NEXT_TEST_DIST=/tmp/wemux-ticket03-ui
WEMUX_TICKET03_EVIDENCE=/tmp/wemux-ticket03-browser-result.json node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts
WEMUX_TICKET02_EVIDENCE=/tmp/wemux-ticket03-ticket02-regression.json node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
```

原始日志 `/tmp/wemux-ticket03-{packages,server-types,web-types,server-tests,client-tests,vite,browser,ticket02-regression}.log`；浏览器结果 `/tmp/wemux-ticket03-browser-result.json`、`/tmp/wemux-ticket03-ticket02-regression.json`；截图 `/tmp/wemux-ticket03-browser-result.json.{desktop,mobile}.png`。预编辑已有文件副本/SHA256 `/tmp/wemux-ticket03-preedit/`；调用方原 tracked baseline `/tmp/wemux-ticket03-baseline-8vDVcn` 不修改。

## 有限剩余清单与验收结论

1. Task 删除合同仍缺失：未来明确关联 Session/Run/活动保留、运行中限制、Workspace/文件独立性，再实现与测验。Workspace 删除501与受保护准备取消不可算已交付删除/取消成功。
2. 真正 Worker 文件准备/本地 Git 仓库失败恢复需要受控真实 Worker 文件系统 fixture；本轮协议结果不能替代。新增第二落点 UI 已存在，但只实测从无落点新增第一个，没有宣称多节点物理隔离已验证。
3. Task 内一步新建/重试 Workspace 尚未迁移；持久手工排序无既有字段，当前只有视图排序。未保存编辑离开提醒、Task详情独立深链/刷新恢复尚需完善。内容编辑仍遵循既有非CAS内容合同，不能声称全字段乐观锁。
4. 需要更强的项目撤权与 Task详情延迟请求交错浏览器测试；目前 Team 级 stale-response/generation 用既有单测与Ticket02浏览器回归证明，项目撤权已实测焦点清屏，不等同所有竞态已穷尽。
5. 无根/完整CI候选证明；独立 reviewer gate 未过。此文是局部交付证据，不勾选整票完整验收、不授权发布。

## 独立 review 三项修复（2026-10-01，本轮有界增量）

仅修复独立 review 的两个P1内容丢失与一个P2错误码，不推进其他未完成切片。待 reviewer 复核，整票继续 partial。

- **不同字段覆盖**：新增独立 `TaskContentEditor` 和非UI `TaskContentDraft`。审计了旧 `apps/web/src/features/tasks/draft.ts` 的 dirty-field PATCH 与 submitted snapshot acknowledgement 思路；新版不依赖旧UI/源码，不直接照搬其字符串化null或全局 remoteChanged 行为。仅发送编辑过的字段；加载最新版本更新未编辑字段、保留脏字段，同字段变化保留明确冲突。用户逐字段选择保留本地或采用远端后才允许保存，重复刷新不会解除冲突。保存前重新GET检查已发生的同字段修改；**内容接口没有CAS，GET到PATCH之间仍有竞态，不能宣称原子并发保护**。版本CAS仍仅按已有状态/指派合同执行。
- **换行和null/空串**：任务创建与内容编辑的描述/验收标准改为textarea，保留多行、缩进和尾换行；标题单独保存不再提交这些字段。编辑draft保留`null`和`''`区别，未编辑的null不会被变成空字符串，显式清空内容保留空字符串。新建时空验收标准沿用既有null语义。共享`ActionForm`没有改动；创建表单仅利用现有children放入textarea，账号兼容不受新字段类型影响。
- **公共错误码**：task route只在409且`AppError.code === request_id_conflict`时映射既有Task错误码；其他409仍按原runtime_unavailable语义处理。HTTP回归断言status、code和message完整对象，而非只判断409。

### 红绿与本轮结果

- HTTP红：原实现返回 `runtime_unavailable`，完整错误对象断言失败；修复后通过。`/tmp/wemux-ticket03-content-server-red.log`、`...-server-green.log`。
- browser红：新增双编辑器回归在原私有dist的 multiline editor 阶段失败；Server确实存有换行而旧输入无法回读，非mock。`/tmp/wemux-ticket03-content-browser-red.{json,log}`。draft测试起始红因新模块尚未实现，仅证明测试未被跳过，不将其声称旧行为断言红。
- 新draft行为测试4项通过：只发dirty字段、reload/同字段双向选择、原样multiline与null/空串、pending保存仅确认提交快照。
- 当前源码私有Vite构建 `/tmp/wemux-ticket03-content-ui`；项目browser **52 checks**（原42+每端5项内容回归），desktop1440×900/mobile390×844。真实两个挂载编辑器先后不同字段保存保留双方；同字段显式reload保留草稿并禁用保存；保留本地后提交；保存preflight检出冲突不发PATCH；采用远端只放弃该字段；多行创建/标题单独保存和null/空串roundtrip。测试仅等待最终200写响应，允许共享transport在同Cookie多tab遇到CSRF轮换时按既有合同重试；未修改transport。
- focused Server **29/29**；client/application/draft **43/43**；Server/Next typecheck通过。
- 既有账号团队browser **115 checks双端通过**，包括项目搜索/焦点/轮询和撤权保护；没有修改共享账号表单。
- git diff whitespace与空staging检查通过。没有根build/test、共享dist替换、安装、部署、提交、真实Agent调用。

本轮精确pre/post SHA256：`.scratch/web-next-project-agent-platform/evidence/ticket03/content-fixes/file-delta.json`，预编辑副本 `/tmp/wemux-ticket03-content-preedit`。测试脚本 `apps/web-next/tests/task-content-editors.mts` 由既有 `project-management.browser.mts`调用；重跑沿用上方browser命令，`WEMUX_NEXT_TEST_DIST=/tmp/wemux-ticket03-content-ui`、输出 `/tmp/wemux-ticket03-content-browser.json`。focused client命令加上`task-content-draft.test.mjs`。本轮截图在`/tmp/wemux-ticket03-content-browser.json.{desktop,mobile}.png`。

Task/Workspace删除、真实Worker文件准备、Task内Workspace操作、导航/深链、其他权限交错及延期依赖/root gates仍是上文单独剩余，不因三项修复或测试数量升级为完整验收。

## Task 内 Workspace、导航与延迟授权响应切片（2026-10-01）

状态：本切片实现/本地验证完成，待独立review；**整票仍partial**。前述三项内容修复已独立复核通过。本节更新历史剩余事项中的Task内Workspace、详情恢复和所列授权交错，不把其他缺口一并关闭。

### 已实现

- 任务详情使用真实 `POST /projects/:p/tasks/:t/workspaces` 创建并绑定Workspace，选择Worker、空/Git仓库，创建后重读权威Task，不使用幂等返回的旧Task快照覆盖界面。指派继续独立按现有version CAS保存；不隐式开启Run。每绑定Workspace展示各Placement状态/原因/路径，通过task `/workspaces/:w/retry`按明确workerId/requestId重试。
- 核查发现原Task内create拒绝requestId。经supervisor明确批准，增量添加optional body.requestId，沿用create-request事务记录；key隔离actor、task-workspace操作、[projectId,taskId]。有效输入默认source/仓库name/revision规范化并含可选assignment/version；同体返回原结果，异体409 request_id_conflict。重放先检查当前Project/Task权限和Workspace归属/存活，不再执行原version CAS/绑定/指派/活动/准备命令；无ID保留原语义。首次失败全部随原事务回滚。
- Task详情深链为 `/next/projects/:projectId?task=:taskId`，创建/选取/关闭更新history。刷新、浏览器前进后退恢复选中任务；query变化进入任务页签，不持久化草稿。
- Task内容dirty guard仅内存注册，实际详情关闭、换任务、项目列表、项目页签、shell导航、浏览器popstate离开需确认。拒绝保留挂载draft与冲突决策，接受才丢弃。`beforeunload`仅请求浏览器提示，不能保证浏览器总展示；不向storage写敏感草稿。
- 授权撤销/角色变化/logout直接清理受保护子树，不走导航确认。project management以accessRole为key，editor→viewer使旧子树/请求失效，清除旧draft。内容保存preflight异步返回后检查组件是否仍存活，避免旧editor卸载后继续发PATCH。现有共享transport identity retire、request generation guards以及pending权限隐藏保留。

### 真实验证范围

新增 `task-workspace-create-idempotency.test.ts`：公开HTTP并发5次同ID一个Workspace/command、一次workspace.created活动、默认值等价重放、异体完整409码、不同Task隔离、首次CAS与无效runtime失败无Workspace残留；带assignment成功后清指派/版本变化，原请求重放不重新指派/写活动；重启后仍重放原结果。browser补actor隔离与撤销后task-local重放403。

`task-navigation-scenarios.mts`被项目browser调用，desktop1440×900/mobile390×844真实Server/合成账号：

- 真实Task内创建POST送达后丢响应，再提交同ID绑定一次；协议Worker报告失败，Task内按该Placement重试，新commandId。不是真实clone/文件准备。
- query深链、reload、close、back/forward；有dirty内容时拒绝close/另一个Task/页签/返回列表/shell设置/back，原草稿保留；接受close丢弃内存草稿。
- 将真实获权的Task详情、Workspace列表、Task活动三个HTTP响应取回后扣留，通过真实API将contributor降为viewer，再释放旧响应；最新只读控件不可恢复写，草稿被清理且不提示离开。
- 同样扣留三个真实响应，真实Grant撤销并完成项目权限核验后释放，标题和详情不恢复；Task-local重复创建仍403。
- 扣留响应跨实际Team范围切换，以及dirty状态直接logout；旧响应不能恢复详情/可写控件，logout没有被确认阻止。测试仅延迟真实响应，不mock权限或领域数据。

最终：Server **30/30**，client/application/draft/navigation **45/45**，项目browser **72 checks**，账号团队browser **115 checks**双端通过。新增client测试锁定task-local create/retry URL、requestId、Team范围、assignment version、Placement workerId；in-memory导航guard单测通过。packages构建（共享包改变后先执行）、Server/Next typecheck、私有Vite构建、git diff检查及空staging通过。

本轮原始证据前缀 `/tmp/wemux-ticket03-navigation-`：`server-tests.log`、`client-tests.log`、`packages.log`、`server-types.log`、`web-types.log`、`vite.log`、`browser.json`、`account.json`。私有dist `/tmp/wemux-ticket03-navigation-ui`，预编辑副本与SHA256 `/tmp/wemux-ticket03-navigation-preedit`。增量清单与脱敏结果归档 `.scratch/web-next-project-agent-platform/evidence/ticket03/task-workspace-navigation/`。复跑沿用前节命令，Server增加`task-workspace-create-idempotency`，client增加`unsaved-navigation`，browser dist/result改为本节路径。

开发中发现并修正测试时序：上一内容测试在reload尚未返回时输入下一草稿会合理触发冲突，现等待已加载内容后再输入；被拒导航的history恢复需等popstate；viewer数据重挂载需等权威详情返回。最终测试不依赖固定延时断言这些结果。历史首次失败不当作权限实现已修复的红绿证明。

### 有限剩余/不作保证

- Task删除领域合同、Workspace删除501、受保护准备取消409仍未改变；真实Worker文件系统/Git/多节点隔离未验证。独立Repository CRUD、持久手工排序、原子内容CAS、streaming Session不在本切片。
- beforeunload是浏览器可选择的提示，跨文档历史没有本应用history index时不保证可撤回；已测本应用内push/pop历史。新建表单尚未提交的输入不纳入Task内容dirty guard。
- UI采用创建后独立指派（CAS）；API可选同时assignment路径由HTTP测验，不宣称新增同时指派UI。
- 本轮覆盖明确四种延迟响应顺序，不宣称所有网络/授权竞态穷尽。Token自然过期、真实Worker文件门及完整candidate/root门继续独立。

## 异步重试意图与迟到创建导航修复（2026-10-01，有界review修复）

本节仅修复上一切片独立BLOCK review两项P1，并直接补验已存在的content-save preflight生命周期保护。整票仍partial，独立review待复核；没有新增Server/domain合同。

### 修复

1. **Placement重试不能共用一个待确认意图。** 新增内存 `PlacementRetryIntents`，Task界面以 `[taskId, workspaceId, workerId]` 索引，Project界面的重试/新增落点同样以 `[projectId, workspaceId, workerId]` 索引。B请求或B成功不替换/清除A；只确认key和requestId均匹配的条目，旧ack不能删除较新的意图。成功确认后下一次明确点击获得新ID。仅存内存中的scope IDs/requestId，不写浏览器storage。
2. **Task创建迟到响应不允许导航已退休页面。** 新增 `useOperationLifetime`，每个layout-effect scope activation有独立token；创建前捕获检查函数，await后先核对当前component/client/project/role，再进行意图确认、全局导航、reload。Unmount或scope retirement后即使Server已创建成功也不做这些副作用，不回滚合法Server成功。审计同一接缝的Project创建，也在create/reload两次await后分别检查token，防止同类旧页面导航。共享ActionForm/transport未改。
3. **直接preflight回归。** 持有真实已授权的内容保存GET响应，真实API把contributor降为viewer、旧editor退休后释放，断言没有任何随后PATCH、没有旧draft恢复、没有离开确认。已有内容draft/conflict处理及GET→PATCH非原子限制不变。

### 红绿与真实browser证据

预编辑副本/hash `/tmp/wemux-ticket03-async-preedit`。先写browser复现，预修复UI在两项阶段失败；随后还从预编辑四个组件构建隔离的 `/tmp/wemux-ticket03-async-red-ui` 再跑当前测试，未覆盖工作树源码：

- `async-retry-red.json`: `passed=false`，`desktop: A replay requestId equality`。真实A重试接受后丢响应；受控Worker把该命令报告为failed；B重试成功；A第二次重试错误地产生新ID。绿测明确断言原requestId、原commandId、公开commands数量不增加；A成功确认后的下一次点击则必须新ID/新命令。
- `async-navigation-red.json`: `passed=false`，`desktop: late Task create across actual viewer retirement`。持有真实已提交POST成功响应直到contributor→viewer退休，旧实现改变URL。
- 最终当前源码私有dist `/tmp/wemux-ticket03-async-ui`：项目browser **84 checks**（原72+每端6项），desktop1440×900/mobile390×844。新增A/B交错、新意图、Settings离开后迟到成功、另一个Project有dirty编辑器时迟到成功（URL不变/零确认）、真实viewer降权迟到成功、直接保存preflight退休。保留同scope正常创建和先前三轮全部内容/权限/导航回归。
- 账号团队browser **115 checks**双端通过；client/application/draft/navigation/intents **46/46**；Next typecheck、private Vite build、diff whitespace与空staging通过。

执行命令：

```sh
npm run typecheck --workspace @wemux/web-next
node --experimental-strip-types --test packages/web-client/tests/*.test.mjs apps/web-next/tests/{placement-retry-intents,unsaved-navigation,task-content-draft,application,account-routes,source-boundaries}.test.mjs
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir /tmp/wemux-ticket03-async-ui
# 显式PLAYWRIGHT_CORE_PATH/PLAYWRIGHT_CHROMIUM_PATH沿用前节现有安装
WEMUX_NEXT_TEST_DIST=/tmp/wemux-ticket03-async-ui WEMUX_TICKET03_EVIDENCE=/tmp/wemux-ticket03-async-browser.json node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts
WEMUX_NEXT_TEST_DIST=/tmp/wemux-ticket03-async-ui WEMUX_TICKET02_EVIDENCE=/tmp/wemux-ticket03-async-account.json node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
```

日志/results前缀 `/tmp/wemux-ticket03-async-`，归档 `.scratch/web-next-project-agent-platform/evidence/ticket03/retry-navigation-fix/`。新增单测最初遇到Node strip-only不支持TS parameter property，已改成显式字段/赋值；不是领域失败。持有写响应的fixture将CSRF403交回原transport处理，只扣留真实成功响应；没有mock权限或重写响应数据。

没有packages/Server/domain源码改动，因此不重复根/package/Server构建测试；先前Server30/30属于上一轮证据，不冒称本轮重跑。无生产端口/账号/数据、Agent调用、网络安装、根build/test、shared dist/tgz、stage/commit/deploy。真实Worker文件、删除合同、完整候选root/dependency gates等仍是既有独立缺口。内存重试意图不跨组件卸载/刷新恢复，本轮不声称持久离线重试；protocol Worker失败报告不是filesystem准备证明。

## 真实 Worker Workspace 物化集成切片（2026-10-02）

状态：**限定场景真实验证通过，整体准备验收仍部分完成，发现一项OPEN产品缺陷**。上一轮异步retry/navigation两项P1已经独立复审“no issues found”（`retry-navigation-rereview.md`，输出63aa6a96…），现在记为本地已review；本轮只增加测试/证据，不修改生产代码，待本轮独立review。整票与candidate/root gate未因此关闭。

### 运行边界与实现

新增显式集成脚本 `apps/web-next/tests/real-worker-workspaces.browser.mts` 与窄fixture `real-workspace-worker.ts`，使用已有Worker测试的in-process模式：当前源码 `WorkerRuntime` + `SqliteWorkerStore` + `WebSocketTransport` + `WorkerTransportStore` + **原样LocalProvisioner**。两个独立私有home、真实持久transport、动态loopback Server端口；通过公开注册/邮件验证、enrollment、Project/Workspace/Task HTTP操作。没有直接写Server资源库，没有手工发ready/failed报告，没有替代Git/filesystem provisioner。

Agent列表为空，不发现/认证/启动任何Agent，没有Session/模型调用。Git source为一次性合成仓库，两个提交，配置独立HOME/XDG_CONFIG_HOME、禁止系统/全局Git配置、`GIT_ALLOW_PROTOCOL=file`，因此真实clone仅能本机文件协议，不访问外部仓库、凭据或网络。两个Workers在同一OS进程、同一主机不同home；证明两个实际物理落点隔离，不宣称不同机器/OS/CLI安装验收。

脚本每次自建mkdtemp root，`state/`含SQLite/outbox/两个Worker homes/Git source；`evidence/`含result和截图。`finally`停止真实Workers（shutdown中止owned Git子进程）、关闭Server/browser/SQLite，再仅删除自身state；保留evidence。无广泛kill、生产端口/数据或共享dist替换。

### 已证明（desktop1440×900/mobile390×844，共27检查）

1. UI建项目、空Workspace；真实Worker准备后公开API ready，观察路径经realpath验证在对应home下；磁盘目录存在且为空。
2. UI选择本地Git URL与**非HEAD的固定commit SHA**；真实clone/checkout后文件内容及`git rev-parse HEAD`均为该SHA，不是较新的main内容；Next展示对应ready路径。
3. 同一个Git逻辑Workspace通过UI新增第二Worker Placement。两真实home的路径不同；A先改的内容不进入B，B从source固定SHA独立clone。修改B后A内容不变，并在后续真实准备/多次刷新后仍独立。Next能看到两个ready落点和实际路径。
4. 真实缺失tag导致checkout失败；Worker通过真实transport报告失败，Server GET与Next alert显示相同实际错误。创建source tag指向原固定SHA后，通过**UI重试**获得新command，原Worker真实clone/checkout成功；文件和HEAD验证通过，Next失败原因消失并显示ready。
5. 通过Task UI创建、绑定、解绑该两落点Workspace；Task绑定清空，但两个真实目录及各自编辑内容仍保留。**不是Task删除证据**。
6. Server Sessions始终为空，Worker异步运行/transport无unexpected errors，browser无pageerror且不横向溢出。两端流程均实际执行，不只是第二端打开已有数据。

### OPEN产品缺陷：非默认远端分支无法按短名detached checkout

最初fixture用缺失分支 `repair-desktop`，修复source新增该branch后UI重试仍失败。真实公开投影：

```text
Command failed: git -C <owned-state>/worker-A/workspaces/<id>.partial checkout --detach repair-desktop --
fatal: '--detach' cannot be used with '-b/-B/--orphan'
```

Git版本 `git version 2.47.3`（以归档git-version.txt和minimal-repro.json实际输出为准）。原因边界：clone --no-checkout仅为default branch创建local ref；新增的非default branch只在`refs/remotes/origin/repair`存在；当前LocalProvisioner直接执行`checkout --detach repair --`触发Git remote-branch guessing，和detach冲突。相关源码 `apps/worker/src/workspaces/local-provisioner.ts:34–36`；真实失败catch/report `apps/worker/src/application/runtime.ts:362–380`。**未修复、不能声称branch选择全面可用**。

最小本地复现（隔离HOME/Git配置，所有路径均mkdtemp所有）：

```sh
R=$(mktemp -d /tmp/wemux-branch-repro-XXXXXX)
mkdir "$R/templates"
export HOME="$R" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0 GIT_ALLOW_PROTOCOL=file GIT_TERMINAL_PROMPT=0 GIT_TEMPLATE_DIR="$R/templates"
git --version
git init --initial-branch=main "$R/source"
git -C "$R/source" -c user.name=Fixture -c user.email=fixture@example.test -c commit.gpgsign=false commit --allow-empty -m initial
git -C "$R/source" branch repair
git clone --no-checkout -- "$R/source" "$R/checkout"
git -C "$R/checkout" checkout --detach repair -- # 当前退出非0，保持OPEN
git -C "$R/checkout" show-ref --verify refs/remotes/origin/repair # branch实际存在
# 复核后仅删除明确owned的 $R
```

已把公开失败投影和原失败scenario结果复制出临时state，归档 `open-branch-defect-projection.json`、`branch-scenario-failed.json`；最小复现逐条命令、exit/stdout/stderr在 `open-branch-minimal-repro.json`。生产Writer修复之前不得删掉此缺陷或把原branch场景写作通过。

supervisor明确批准保持此缺陷OPEN、改用“缺失tag→补tag→UI retry”完成**另一合法修复路径**。这不是原分支bug的修复，也不关闭整条准备criteria。没有反复换数据掩盖问题；tag场景首次执行及两次复跑均通过。

### 命令/证据

私有当前源码UI与日志 `/tmp/wemux-ticket03-real-run-W4nHf6`，最终runtime evidence `/tmp/wemux-real-workspaces-bWHC7m/evidence`；前两次tag通过 `/tmp/wemux-real-workspaces-Xa6uNn/evidence`、`/tmp/wemux-real-workspaces-ETqn3x/evidence`。失败branch runtime证据 `/tmp/wemux-real-workspaces-JmUo8N/evidence`。这些state已经finally清理，evidence保留；截图包括两端failed、ready-placements、task-unbound。

- `vite build ... --outDir "$RUN/ui"` 当前源码私有构建通过，没有shared dist/tgz。
- 显式浏览器preflight + `real-worker-workspaces.browser.mts` 最终 **27/27**，`cleanupFailures=[]`；需要已有绝对Playwright/Chromium路径。可重复完整命令已注册说明在 `apps/web-next/tests/ACCEPTANCE.md`，不是默认glob自动运行。
- `node_modules/.bin/tsx --test apps/worker/test/workspace-files.test.ts` **7/7**。
- `node_modules/.bin/tsx --test --test-name-pattern='empty workspace provisions|git clone uses' apps/worker/test/worker.test.ts` **2/2**，真实LocalProvisioner回归。最初错误pattern只选中文件wrapper，不记为有效provision测试。
- `npm run typecheck --workspace @wemux/worker`、`npm run typecheck --workspace @wemux/web-next`通过。
- fixture直接`tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck ...real-workspace-worker.ts ...real-worker-workspaces.browser.mts`通过；初次遗漏allowJs导致已有acceptance-runtime.mjs声明报错，补齐后检查通过。
- `git diff --check`与空staging通过。无package/domain源码改动，已有packages产物可直接使用，未重建packages、根build/test、CLI包或部署。

精确pre/post SHA256清单：`.scratch/web-next-project-agent-platform/evidence/ticket03/real-worker-workspaces/file-delta.json`，预编辑副本 `/tmp/wemux-ticket03-real-preedit-51jrajd5`。本节不声称旧84/115 browser本轮重跑；UI生产源码未变，仅执行本新增集成路径与上述focused checks。

### 下一步有限缺口

1. **新发现的non-default branch checkout缺陷，独立有界生产修复与原分支失败场景回归**，由parent安排，当前writer未改生产实现。
2. 本轮真实物化证据独立review；不将同机双home证明扩大到多主机/Worker安装/任意Git认证与平台兼容。
3. Task删除404、Workspace删除501、准备command取消保护409的领域生命周期缺口不变；Task解绑仍不能代替删除文件保留验收。
4. 独立Repository管理、持久手工排序、自然token过期等既有范围/证明缺口及延期candidate/root gates保留；不得据本节勾选整票完成。

## Blocker #20：LocalProvisioner Git revision解析修复（2026-10-02）

**状态：原非default branch缺陷已本地修复并原路径验证通过，待本轮独立review；整票仍partial。** 上一真实Worker fixture独立review结论为OK with notes，reviewer无法读取截图像素，因此只核查脚本/结果与文件存在，视觉截图审查仍未获独立证明。保留上一节OPEN记录作为发现时历史，以及`real-worker-workspaces/open-branch-*`原始FAILED证据，不重写成成功。

### 根因、修复边界与碰撞规则

已先读取diagnosing-bugs/tdd技能；约定测试接缝是实际`LocalProvisioner.provision`与原真实Worker公开API/UI。新增focused测试先红：missing `repair-branch`第一次失败且managed目录无ready/root/partial；source新增该非default branch后，同一Workspace重试再现 `fatal: '--detach' cannot be used with '-b/-B/--orphan'`。记录于本轮`regression-red.log`，约0.27秒。

原因与前轮推断一致：branch被clone成origin remote ref，但短名checkout尝试猜测创建local branch，和detach冲突。唯一生产改动 `apps/worker/src/workspaces/local-provisioner.ts`：

1. 克隆方式不变，先用`git rev-parse --verify --quiet --end-of-options <revision>`解析已有Git对象；校验输出确为40/64位hex object ID。
2. 仅未解析且不是`refs/…`的请求，经`check-ref-format refs/heads/<revision>`验证后尝试**精确**`refs/remotes/origin/<revision>`。没有fetch、凭据、协议放宽或HEAD兜底。
3. 对该object ID解析`^{commit}`验证/剥离到commit，再以可信commit ID执行`checkout --detach <commit> --`。tag指向非commit时明确失败，不能落到同名branch。
4. **branch/tag碰撞遵循Git rev-parse文档中的tag优先于heads**，先保留native Git解析结果。测试覆盖默认main与tag同名、非default branch/tag同名且内容不同；显式`refs/heads/main`能选branch。没有默默改变为“总选branch”。只声明下述实际测试的revision形式，不宣称任意rev语法/歧义均支持。
5. 参数均数组，无shell拼接；原AbortSignal、120000ms timeout、1MiB buffer、GIT_TERMINAL_PROMPT=0保持。仅rev-parse普通未找到的exit1可进入fallback，abort/timeout/其他进程失败继续传播。加显式revision NUL拒绝。原staging清理、原子rename、ready marker及重复provision保护不变。

### 测试与原场景绿灯

- 新 `apps/worker/test/local-provisioner-revisions.test.ts`：真实临时Git/config隔离/file-only；原missing branch→新增branch→同Workspace重试、实际HEAD/内容/detached状态、marker幂等保留本地编辑；default main、HEAD、显式local/remote refs、lightweight/annotated tag、固定SHA；两种branch/tag碰撞；不存在revision、非法option、NUL、非commit tag与同名branch、显式不存在ref全部失败且不遗留ready/root/partial；提前abort同样不遗留。原focused红到绿后扩展矩阵，未先修改生产再制造红。
- 三个Worker文件联合 **20/20**：新增revision测试 + `worker.test.ts` + `workspace-files.test.ts`。单测矩阵有多个断言但只算1个test，不虚增计数。
- 原真实Worker browser保留tag恢复，**另加独立branch恢复**：desktop/mobile分别真实缺失revision→failed（公开API及Next原样原因），磁盘无该Workspace ready/root/partial；在同一source新增branch指向已知非HEAD SHA；UI retry**同一逻辑Workspace**，命令ID变化，真实Worker目录HEAD/内容匹配，ready marker才出现。固定SHA、两home不隐式同步、Task解绑保留文件的原覆盖保留。
- 当前源码私有UI + 两真实Worker runtime/browser **43 checks通过**，最终 `cleanupFailures=[]`，无Agent/Session/模型执行。两次完整新fixture执行通过，最终 `/tmp/wemux-real-workspaces-p7Ah1o/evidence`，上次 `/tmp/wemux-real-workspaces-3DH0Ld/evidence`；两端tag/branch失败与恢复截图保留，但本轮不代替独立视觉review。
- Worker/Next typecheck与fixture/no-emit typecheck通过。初次fixture类型检查发现新测试缺少required name/品牌ID与assert重载使用不正确，均修成严格DTO类型及正确断言后通过，没有类型抑制。

### 精确命令与证据

本轮私有root `/tmp/wemux-ticket03-branch-fix-qmzia_ch`：`preedit/`含副本/SHA256；`regression-red.log`、`regression-green.log`、`revision-matrix.log`、`worker-tests.log`、`worker-types.log`、`web-types.log`、`fixture-types.log`、`vite.log`、`browser-final.log`；private dist在`ui/`。原失败归档未修改；本轮脱敏副本与精确增量清单在 `.scratch/web-next-project-agent-platform/evidence/ticket03/git-branch-fix/`。

```sh
node_modules/.bin/tsx --test apps/worker/test/local-provisioner-revisions.test.ts
node_modules/.bin/tsx --test apps/worker/test/local-provisioner-revisions.test.ts apps/worker/test/workspace-files.test.ts apps/worker/test/worker.test.ts
npm run typecheck --workspace @wemux/worker
npm run typecheck --workspace @wemux/web-next
node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck apps/worker/test/local-provisioner-revisions.test.ts apps/web-next/tests/real-workspace-worker.ts apps/web-next/tests/real-worker-workspaces.browser.mts
RUN=/tmp/wemux-ticket03-branch-fix-qmzia_ch
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui"
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
WEMUX_NEXT_TEST_DIST="$RUN/ui" timeout --signal=TERM --kill-after=5s 100s \
node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/real-worker-workspaces.browser.mts
```

没有Server/domain/其他UI源码改动、无package build需要；不跑根build/test、不写shared dist/tgz，不安装/提交/部署。Git源、Worker homes、账号、DB/outbox均owned私有；正常finally已清理runtime state，证据保留。git diff whitespace与空staging通过。

### 当前有限剩余

Blocker #20现在为**implemented + locally verified，pending independent review**，不是整个Ticket03关闭。原删除生命周期（Task无DELETE、Workspace501、准备取消保护409）、独立Repository管理/持久排序等不在本修复范围。只证明同机双home与列明revision形式，不扩大到跨主机/CLI包/真实外部认证或任意Git表达式。独立截图视觉检查、candidate/root/dependency release gates仍待单独完成。

## Task CONTENT PATCH 原子CAS纵向切片（2026-10-02）

状态：**本切片implemented/locally verified，待独立review；整票仍partial。** 上一Git branch blocker #20已由独立review确认no issues found、OK with notes，现记为本地已review；原Git失败归档保持不变，截图像素仍未独立核查。

### 新增兼容合同（expand阶段）

- Task内容PATCH现在允许已有正整数`version`，服务端在**同一store transaction**中先授权/查当前Task，再比较版本，随后写content、version和activity。状态仍必须version；未匹配返回真实409 `version_conflict`与当前版本，不自动重试。
- 老调用**省略version仍接受**，但任何有效content修改（title/description/acceptanceCriteria/priority/metadataJson）都使Task.version前进一次，令其他已读version失效。无version老写方自己没有CAS保证；仍可能覆盖后来内容，这是expand兼容限制，不可宣称所有旧调用已原子保护。
- 合并status+content只前进一次。status no-op + content变化也前进一次；assignment现有版本行为不改，Run成功不会自动done。
- **no-op政策**：提供version的请求即使内容相同，也必须先通过CAS；过期no-op409。当前版本或无version、语义完全相同的请求不改version/time/activity。metadata对象键顺序不算修改（使用Node `isDeepStrictEqual`）；数组顺序、字符串空白、null/空串仍是有效内容差异。纯version没有content/status返回400。
- 无schema/storage迁移。TaskPatch类型增量允许content version；shared ApiError增补可选公共`code`，transport保留已有状态/鉴权/CSRF处理且不重试409。

### Next消费者

内容编辑器继续只发送dirty字段，preflight GET用于字段合并/同字段决策；PATCH现在携带该**同一个已接受preflight snapshot.version**。GET后发生其他写也会被事务CAS拒绝。409不更新baseline/丢草稿/重发；显示独立“重新加载内容版本”按钮，保存禁用，用户明确加载后按既有逐字段local/remote选择恢复。不同字段恢复合并remote未编辑字段，不以旧表单覆盖它们。pending时输入禁用，null/空串/多行原样保持；退休editor不处理迟到成功或409。已有授权/identity/role retirement与memory-only导航保护保留。

### 顺序实施与红绿

1. **Server红**：公开HTTP先legacy无version修改description，然后旧version content写应409，旧实现实际400（content version被拒）。`server-red.log`明确记录400≠409。生产改动后Server兼容/Task/Run/Workspace共 **118/118**通过。
2. 首轮policy补测：metadata只有对象key顺序不同不应前进，JSON字符串比较给出9≠8，`metadata-noop-red.log`记录；改为语义deep equality后通过。注入activity append失败，公开HTTP500之后GET和activity均与此前完全一致，证明事务回滚内容+version+activity。并发同version content两写恰一200一409；无version写使过期version失效；mixed/no-op/非法版本/不同Team授权先于冲突/null空串/priority/metadata均覆盖。
3. Server阶段green后修改shared类型/error，再立即`npm run build:packages`，随后Next版本提交/明确恢复。client/API/application/draft/导航共 **47/47**通过，新增client断言版本/多行/null请求体、公共error.code和不重试409。旧tests仅更新“内容写不升version”的过时预期和状态no-op应使用最新version。
4. browser新增 `task-content-cas.browser.mts`：**实际截住outgoing versioned PATCH**（不是mock409或延迟detail GET），在已成功preflight之后通过真实授权API做竞争legacy无version写，再释放原请求，断言真实409/code、Server remote内容保持、local草稿保留。明确reload/同字段保留local/不同字段合并后重试成功。两端还验证null、多行、显式empty、pending输入、退休editor收到实际409及已提交200响应均不恢复UI/导航。
5. 当前源码私有Vite UI下项目browser **92 checks**（原84+每端4项），账号团队browser **115 checks**通过。旧CAS状态脚本硬编码version4改为实际最新版本+1，不掩盖冲突断言。Server/Next与新测试直接no-emit typecheck通过。

### 精确命令和证据

私有root `/tmp/wemux-ticket03-content-cas-8fitlkrm`：preedit副本/hash、stage1/2/3 SHA256记录、server-red/metadata-noop-red、server-stage1/server-tests、packages-stage2、client-tests、server/web/test-types、vite/browser/account日志及JSON。private dist `ui/`；结果`browser.json`=92checks、`account.json`=115checks。每次browser仍用新私有DB/outbox/owned合成账号/动态端口并finally清理，不触碰live8010/8004。

```sh
node_modules/.bin/tsx --test apps/server/src/test/{task-content-cas,tasks,task-workspaces,task-assignment-http,task-runs,project-create-idempotency,task-workspace-create-idempotency}.test.ts
npm run build:packages
npm run typecheck --workspace @wemux/server
npm run typecheck --workspace @wemux/web-next
node --experimental-strip-types --test packages/web-client/tests/*.test.mjs apps/web-next/tests/{placement-retry-intents,unsaved-navigation,task-content-draft,application,account-routes,source-boundaries}.test.mjs
node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck apps/server/src/test/task-content-cas.test.ts apps/web-next/tests/task-content-cas.browser.mts
RUN=/tmp/wemux-ticket03-content-cas-8fitlkrm
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui"
# 显式PLAYWRIGHT_CORE_PATH与PLAYWRIGHT_CHROMIUM_PATH沿用前节现有安装
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET03_EVIDENCE="$RUN/browser.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET02_EVIDENCE="$RUN/account.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
```

精确增量清单/脱敏证据 `.scratch/web-next-project-agent-platform/evidence/ticket03/content-cas/`。stage1-hashes记录初始Servergreen；后续metadata no-op政策修正体现在最终manifest，不误称三个stage的hash均为最终树。无root build/test、shared UI dist/tgz、外部安装、模型调用、stage/commit/deploy。packages产物按仓库约定重建用于下游类型，但不是发布构建。

### 当前有限剩余

本轮使**新版versioned content写**的GET→PATCH竞态闭合；旧无version内容写继续last-writer兼容，不提供自身CAS保证。独立review待执行。Task/Workspace删除与取消生命周期、独立Repository CRUD/持久排序、截图视觉review、跨主机/CLI包边界以及延期candidate/root/dependency gates仍独立，整票不因这一合同切片标完成。

## Ordinary Task 永久逻辑删除切片（2026-10-02，限定无Session任务）

**状态：受限删除合同implemented/locally verified，待独立review；整票仍partial。** 上一content CAS独立review结论no issues/OK with notes，已记为本地review通过。旧Git FAILED证据未改。这里是经parent批准的新增生命周期决策，不是把已有archive或解绑改名为删除。

### 决策与明确收缩

首次提案允许“所有关联Session证明idle”后删除，随后调查发现：当前Session删除会移除cache历史并排队`session.delete`，deletedAt不证明Worker terminal已关闭或in-flight fs.write已结束；sessionIdleReason也不跟踪terminal。不得DB事务跨网络等待，亦不得为本票引入租约/终端追踪子系统。

**parent明确改批B保守部分实现**：任何关联Session记录（idle、archived、offline/unsynced、queued、已deletedAt但cleanup未证明）都拒绝；任何Run保留sessionId，即使读不到Session行也拒绝。**成功正向仅限没有关联Session的普通Project Task**，可以绑定真实Workspace。不要指导用户先删除Session“解锁”，不自动清理Session，不以更容易的正例冒称历史Task可删。全历史Task删除仍OPEN，需要未来可证明的Worker终端/请求排空及保留历史策略。此决策取代前述idle-live-Session正例要求。

### 公共合同

`DELETE /api/projects/:projectId/tasks/:taskId`，JSON `{ version: positiveInteger, requestId: safeString1..200 }`，200 `{ taskId, version, deletedAt }`。

- Project owner或manager；Team/member/Project作用域按现有Task授权先检查，再披露CAS/replay信息。实例管理员不是额外跨Project绕行；保留现有角色继承行为。viewer/contributor不允许破坏性删除。
- 同一store transaction中授权→幂等记录→当前状态/version CAS→运行/审查/Session限制→绑定解除/assignee清空/版本+1/tombstone/活动/audit/replay记录。缺少requestId/version400；过期version409；activeRun pending/running/cancelling409；open review409；Session历史409 `task_has_sessions`，带明确原因但无私有Session名称/计数。
- `deletedAt/deletedBy`为兼容可选字段；**永久逻辑删除，不提供恢复**。Task、links、activity、Run、review、artifact历史不级联删除，Session.taskId不变化。绑定行释放，旧workspaceIds写入`task.deleted`活动；Workspace/Placement/文件不改，不发送Worker命令，Workspace之后可以绑定其他Task。
- 幂等key隔离actor+task-delete+[Project,Task]+requestId，指纹包含version；同ID同体重启后返回原receipt但仍当前授权；异体同ID409 request_id_conflict；其他ID再次删除410 task_deleted。成功只有一条delete活动/audit；失败全事务回滚。没有隐式取消Run/消息。
- 普通task list/board、pending review、attention排除tombstone。已获权`GET detail/activity/runs`保留只读历史（没有增授Session权限）。新版深链显示已永久删除，不可编辑；角色变化/身份退休保护沿用。项目保留Task历史时Project DELETE拒绝`project_has_tasks`，避免原generic项目删除绕过保留链。

### 不可执行tombstone的入口清单

- `TaskService.writeTask`统一拒绝PATCH内容/状态、transition/move、links增删、assignment增删、Workspace bind/unbind/create/retry、reviewAction、launch/cancelRun、createSession；旧createTask requestId命中已删Task也410，不复活。
- capability判定对tombstone拒绝transition/launch/review/cancel。Task Session creation在事务中校验Task未删；与delete并发只允许一种顺序。legacy Session创建幂等重放、direct enqueue/runtime/session-control以及fork source同样在授权之后检查tombstone。history/read、Session管理性清理未被粗暴禁用。
- Session-scoped文件write和terminal非dispose请求有post-auth生命周期检查；**成功Task删除本身排除一切有关联Session**，所以不需要事务跨Worker等待。此guard只保护不一致/既存tombstone数据，不能当作未来live-Session删除的租约方案。独立Workspace-wide能力不受已解除Task绑定影响。
- Artifact register/review获权Task读和mutation用store.transaction，仓储create/review改为同一个SharedSqliteDatabase.transaction嵌套工作；`server.ts`两者实际共享database。读保留，tombstone后写410。不改迁移或重写仓储。

### Artifact证据限制（parent后续明确批准）

真实artifact要求succeeded Run/session，因此在B政策下，正常artifact-bearing Task不能成功删除。此前要求的“artifact-before成功delete vs delete-before成功artifact”并非两种可达成功顺序，不用伪造它来宣称通过：

1. fixture通过严格存储约束建立历史Run/Session，公开artifact registration成功；公开Task DELETE被拒，artifact/history保持。缺失Session reader但Run.sessionId保留仍拒绝。
2. **明确synthetic inconsistent/preexisting tombstone fixture**验证授权后artifact create/review及Session enqueue/fs.write/terminal拒绝，history可读，不声称这个tombstone由合法delete生成。
3. 同SharedDatabase的repository/store事务rollback和FIFO测试证明create/review无内部BEGIN冲突，回滚无artifact/版本残留；这不是可达的成功历史Task删除race。

### 验证

- 新公开HTTP先红：旧无DELETE路由404而新授权路径应403；`server-red.log`保留。
- Task/delete/CAS/Run/Workspace/Artifact focused **128/128**；附加files/terminals/lineage/attention/projections/lifecycle **33/33**（部分重叠，不相加冒称不同测试）。覆盖同ID并发/restart、CAS与PATCH竞态、owner/manager/viewer/contributor/撤权重放、未知同体/异体、所有Task写路由410、capabilities、no Worker command、绑定释放复用、activity/audit故障回滚。
- Session创建/delete事务顺序两种及真正并发都验证；idle/archived/queued/offline-unsynced/deleted-cleanup-unproven均拒绝，未丢既有Session数据；不一致active Run三态和open review阻断。
- shared contract **49/49**；client/application **48/48**；Server/Next以及新测试直接no-emit typecheck通过。packages改变后按要求先build:packages。
- **真实Worker browser47 checks**：在之前真实Git/双Worker文件场景中，Task先重新绑定Workspace，制造真实stale delete409、明确reload/确认；让真正DELETE先送达丢响应，再同ID重试。随后Task tombstone、列表排除、只一条delete活动，Workspace身份/两Placement/两份实际编辑文件保留，刷新深链只读。**这是真正Task DELETE，不是fixture teardown或Task解绑替代**。仍无Session/Agent执行。
- project browser **96 checks**：原内容/导航/权限全部回归，新增实际Task-bound Session创建（仅Test Agent能力协议fixture，不发送模型消息）后UI delete409、Task/Session仍在；没有自动取消/清理。account-team **115 checks**双端通过。私有Vite输出与合成DB/outbox/动态端口，无生产环境操作。

### 命令/精确delta

本轮根 `/tmp/wemux-ticket03-delete-v2vp2muo`：`preedit/hashes.json`、source copies、server-red/delete-all/server-tests/lifecycle-regression、packages、contract/client/server/web/test-types、vite、project/account-browser日志/JSON。真实Worker最终 `/tmp/wemux-real-workspaces-U4ePLB/evidence`=47checks/cleanupFailures空，早期同场景 `/tmp/wemux-real-workspaces-8UfwTQ/evidence`；owned state都已finally清理，evidence保留。

```sh
npm run build:packages
node_modules/.bin/tsx --test apps/server/src/test/{task-delete,task-delete-artifacts,task-content-cas,tasks,task-workspaces,task-assignment-http,task-runs,project-create-idempotency,task-workspace-create-idempotency,artifact-repository,artifact-timeline,artifact-http}.test.ts
node_modules/.bin/tsx --test apps/server/src/test/{session-files-http,session-terminal-http,session-lineage,attention-http,attention-service,attention-source,projection-routes,projection-service,artifact-http,artifact-repository,artifact-timeline,task-delete,task-delete-artifacts}.test.ts
node_modules/.bin/tsx --test packages/web-contract/src/{task-platform,action-capability}.test.ts
node --experimental-strip-types --test packages/web-client/tests/*.test.mjs apps/web-next/tests/{placement-retry-intents,unsaved-navigation,task-content-draft,application,account-routes,source-boundaries}.test.mjs
npm run typecheck --workspace @wemux/server
npm run typecheck --workspace @wemux/web-next
node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck apps/server/src/test/task-delete.test.ts apps/server/src/test/task-delete-artifacts.test.ts apps/web-next/tests/real-worker-workspaces.browser.mts
RUN=/tmp/wemux-ticket03-delete-v2vp2muo
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui"
# Export explicit installed PLAYWRIGHT_CORE_PATH / PLAYWRIGHT_CHROMIUM_PATH as in previous gates.
WEMUX_NEXT_TEST_DIST="$RUN/ui" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/real-worker-workspaces.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET03_EVIDENCE="$RUN/project-browser.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET02_EVIDENCE="$RUN/account-browser.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
```

最终逐文件pre/post SHA256与stage分组manifest：`.scratch/web-next-project-agent-platform/evidence/ticket03/task-delete/`。git diff/空staging通过，无root build/test、shared dist/tgz、外部安装、paid模型、reset/clean/commit/deploy。没有把fixture编造状态当真实执行正例；存储约束对最初缺少runId/invalid Run identity fixture报错，修成满足真实约束的historical rows后通过。

### 有限剩余

本轮**不是完整历史Task删除**：所有Session/Run关联历史任务仍不能删除，需要后续持久的终端/in-flight操作排空证明、真正已接收create/enqueue清理以及不丢Journal历史的生命周期设计；不能以Session.deletedAt替代。Workspace删除/取消、独立Repository/持久排序等仍后续seams。截图独立视觉review和candidate/root/dependency gates继续未过，Task03和all16都未完成。本切片独立review待安排。

## Workspace 永久逻辑删除切片（2026-10-02，保守准备证明）

状态：**本切片implemented/locally verified，待独立review；整票partial。** 上一受限Task-delete独立review结论no issues/OK with notes，仅批准无关联Session的限定合同；历史Task删除仍OPEN，不能由本节关闭。

### 经parent批准的合同与限制

`DELETE /api/workspaces/:id` authenticated JSON `{ expectedRevision, requestId }` → 200 `{ workspaceId, deletedAt }`。Project owner/manager，授权与Team scope先于fingerprint/replay/限制披露。既有无body DELETE此前固定501，现在400（明确确认参数），其他创建/重试调用兼容。

Workspace没有持久version，因此新增API只读`revision`是**opaque STATE fingerprint，不是单调版本**：SHA256规范序列化id/projectId/name/spec/deletedAt和按workerId排序的完整持久placements（包括path/failure/provisioning/terminal proof）。不含凭据或临时online health；对象key次序/placement排列不影响值。状态等价/ABA可得到相同token，不保证捕捉每次中间变更。删除事务内独立重读所有refs/commands，绑定/Session/命令不在hash也不能绕过eligibility。

永久tombstone保留Repository关联、placements/path/失败及准备元数据和文件，不支持restore，不发送任何Worker cleanup命令。普通列表过滤，授权GET `/workspaces/:id`可读tombstone原始元数据（不再以离线health改写保留状态）；创建requestId重放不能复活已删对象，rename/reprovision/Task绑定/新Session不能使用已删Workspace。

requestId隔离actor+workspace-delete+workspace；同ID同expectedRevision重启后返回原receipt并重验当前权限；异体同ID409，新ID到tombstone410。token不同409 `workspace_revision_conflict`，UI显示实际原因、刷新后明确重新确认。事务rollback不留下tombstone/audit/replay；并发同ID一次删除，无隐式取消。

**独立拒绝条件**：任何Task binding、Task assignee snapshot、Run workspace snapshot；任何Session记录含已deleted；composite成员或ownership（含保留reference），非空composite；任何准备状态或当前/历史command的结束证明不足。不能指导用户删Session清history绕过。成功现实路径：无refs的unplaced logical Workspace，或各原始准备有确切terminal proof的ready/failed Workspace。失败后重试可能保留旧accepted attempt而无历史proof，仍拒绝，不默默收缩为“永远只能空Workspace”。

Project DELETE现在事务内拒绝**所有**保留Workspace记录，包括逻辑删除tombstone，与既有Task history保护一致；和Workspace创建原子互斥。UI解释空列表不等于可删除Project，保留历史不cascade/purge。

### 准备结束证据，不是ACK或新取消协议

调查发现旧`reportedAt`混有legacy无commandId报告与rejected receipt，不能证明settled。parent额外批准窄字段 `WorkspaceProvisioningAttempt.terminalReport`：`{commandId,workerId,status:ready|failed,occurredAt}`，只在已鉴权Worker、Workspace/Placement归属、**精确current command且command payload目标一致**、既有状态/时间顺序校验后原子保存。legacy报告、transport ACK、accepted/rejected receipt、timeout/offline都不能填此字段；已有proof不被无关联legacy覆盖。新attempt替换清空proof，允许非terminal投影时不携带proof，过时/矛盾报告按原规则拒绝。

真实Worker证据路径：`apps/worker/src/application/runtime.ts:342–379`先await LocalProvisioner，成功在实际clone/checkout/rename/marker结束之后保存ready，再发report；失败在LocalProvisioner catch await staging清理后保存failed并report。LocalProvisioner子进程均await；因此证明该**准备attempt**已settled，不证明Session/terminal/其他文件操作settled，后者靠引用拒绝。

删除用新增无history窗口的`listWorkspaceProvisions`读取**全部**该Workspace准备命令。只接受status=accepted且为该placement的current command、有精确匹配terminalReport且terminal status一致；pending/rejected/缺失proof/历史superseded accepted等全部拒绝。不是将accepted解释成完成，而是同时要求真实terminal report。当前版本不维护过去attempt proof ledger，因此即使当前重试成功也可能因旧attempt拒绝；准备取消与历史结算证明保留OPEN。

旧记录兼容加载，但没有字段不回填；需要新验证的带commandId报告才建立proof，不能保证所有旧Workers reconnect自动恢复。服务器忽略tombstone后的late报告/rejected回执投影，真实runtime reconnect重报也不改变tombstone或文件。

### Tests和真实结果

- 新公共HTTP测试先红（Workspace读模型缺revision），记录`red.log`。4个测试内有界矩阵：unplaced delete/restart/同ID并发/异体、auth-before-conflict与撤权重放、rollback、list/detail、rename/create replay不能复活、无Worker命令；fingerprint读取稳定/placements顺序稳定/path改变失效；refs不改变fingerprint仍阻断；composite/assignee/Run/deletedSession负例；binding/provision/Session创建的两种顺序与并发互斥；Project删除/Workspace创建互斥。
- terminal proof回归：pending、legacy无commandId、错误command/Worker、rejected receipt都不授权；current correlated terminal正例，restart proof保留、health不污染revision、legacy不覆盖、contradictory/stale不改、retry清空、旧accepted历史拒绝、late报告/reconnect不复活。控制协议fixture仅测试合同，不冒充实际文件准备。
- focused Server **53/53**，独立Run suite **87/87**；最后扩展引用/Project race后Workspace测试 **4/4**再跑通过（包含于53，不重复加总）。client/application **49/49**。Server/Next及新fixture直接no-emit typecheck通过，shared包改变后立即build:packages。
- 真实两Worker desktop/mobile **55 checks**：在原真实Git/SHA、两个独立编辑文件场景后，Task unbind/delete只是setup；真正点击**Workspace DELETE**，先制造rename state conflict，再刷新确认；真正DELETE成功后丢响应，再相同identity重试。列表消失、授权detail tombstone保留两placement/path/status，公开command数量不增加、两实际编辑文件在teardown前仍在。真实两Worker disconnect/reconnect重报后tombstone/文件不变。原失败后重试的Workspace删除仍显示“Preparation settlement is unproven”拒绝，单独验证而非绕开。
- project browser **96 checks**、account-team **115 checks**双端回归通过。未调用模型；未使用production/8010/8004、外网安装、root build/test、shared UI/Worker dist/tgz、stage/commit/deploy。

### 命令、delta与局部完成门

本轮root `/tmp/wemux-workspace-delete-lfysvnd6`：preedit副本/hash、red/green/proof/workspace-tests-final/server-tests/run-tests、packages/server/web/test-types、client-tests、vite、project/account结果。真实Worker最终 `/tmp/wemux-real-workspaces-1Sb7SD/evidence`，55checks/cleanupFailures空；owned state已finally清理，evidence保留。原Git FAILED归档不变。

```sh
npm run build:packages
node_modules/.bin/tsx --test apps/server/src/test/{workspace-delete,task-delete,task-delete-artifacts,task-content-cas,tasks,task-workspaces,task-assignment-http,project-create-idempotency,task-workspace-create-idempotency,server}.test.ts
node_modules/.bin/tsx --test apps/server/src/test/task-runs.test.ts
node_modules/.bin/tsx --test apps/server/src/test/workspace-delete.test.ts
node --experimental-strip-types --test packages/web-client/tests/*.test.mjs apps/web-next/tests/{placement-retry-intents,unsaved-navigation,task-content-draft,application,account-routes,source-boundaries}.test.mjs
npm run typecheck --workspace @wemux/server
npm run typecheck --workspace @wemux/web-next
node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck apps/server/src/test/workspace-delete.test.ts apps/web-next/tests/real-workspace-worker.ts apps/web-next/tests/real-worker-workspaces.browser.mts
RUN=/tmp/wemux-workspace-delete-lfysvnd6
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui"
# Explicit PLAYWRIGHT_CORE_PATH and PLAYWRIGHT_CHROMIUM_PATH use the existing installed versions documented above.
WEMUX_NEXT_TEST_DIST="$RUN/ui" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/real-worker-workspaces.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET03_EVIDENCE="$RUN/project.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET02_EVIDENCE="$RUN/account.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
```

精确incremental SHA256 manifest归档 `.scratch/web-next-project-agent-platform/evidence/ticket03/workspace-delete/`。只改这一seam及测试/文档；旧generic删除501断言更新为缺confirmation body400，不删兼容读取字段。独立review仍待执行，完整historical Task删除、准备取消/历史attempt proof、视觉截图审查及candidate/root/dependency gates继续OPEN，全Ticket03/all16未完成。

## Workspace-delete独立review修复（2026-10-02）

上一切片review为BLOCK（P1授权顺序泄漏、P2声明DTO缺revision），不能记为已通过。本轮仅修复这些问题及指定的证据弱点，**已本地验证、待独立复审**；历史准备证明/取消、historical Task删除、视觉/candidate-root等局部门仍OPEN。

### P1：先授权再披露生命周期

公开HTTP红先复现：同Team无Grant账号对private deleted Workspace POST `/sessions`返回410，而同类live/不存在资源应404。修复在同一事务中raw lookup→Project contributor授权→`getWorkspace`生命周期校验。不存在及无权分支统一404 `workspace_not_found`/`Workspace not found`，不泄漏deleted标记；合法owner仍收到410 `workspace_deleted`。

审计该helper调用者：reprovision与管理员rename改走同一actor-facing授权顺序，rename route显式传operator；fork target先授权目标Project后披露scope/deleted状态。内部enqueue已先Session授权、workspace create replay已先Project授权；这些保留执行拒绝行为。内部无actor兼容调用保持已有生命周期保护。测试覆盖同Team无Grant、拥有其他Team账号、private live/deleted/nonexistent完整响应、reprovision/rename负例。

### P2：mutation响应与WorkspaceDTO一致

真实shared-client→真实HTTP红先复现create返回的`workspace.revision`为undefined。create（unplaced/placed）、rename统一返回该**返回快照**的revision；创建幂等重放仍返回原资源快照并从该快照计算token，绝不把当前token贴到旧payload上。新记录保存同一返回receipt；旧幂等记录缺revision也可从原快照补投影，不放宽required WorkspaceDTO。

测试直接用shared client的create结果确认DELETE成功；rename后使用rename结果确认DELETE成功；原create重放仍旧token，确认DELETE真实409；placed创建/rename投影与read状态一致、pending资格仍409而非漏token400。两项公共回归都先红后绿，未修改packages/client源码，因此不额外build packages。

### 两项浏览器证据加强

- 去掉reconnect固定200ms等待。owned real Worker fixture观察真实enqueue后的durable outbox sequence/epoch，以及实际`acknowledgeOutbound`路径收到的Server ACK。记录每个相关Workspace/current command的post-reconnect report seq，等待**两台Worker各自ACK through≥该seq**后才检查tombstone不变与文件存在。未注入报告或ACK、无生产测试端点；fixture SQLite只读观察，只涉及该私有home。Server gateway在await service.receive/持久处理后才发送该ACK。结果JSON保存worker/workspace/command/epoch/seq/ackThrough，可独立核对，不将online等同report drain。
- desktop/mobile各有真实Workspace DELETE先提交并扣留成功响应，SPA离开到Settings再logout，最后释放响应。断言URL不变、无新的project/workspace请求/无提示/无私有内容恢复，重新登录API证明服务器tombstone仍存在。logout会dispose transport并可能abort旧浏览器请求，因此不要求退休请求再收到200网络事件；等待fixture响应释放尝试结束及登录UI状态，而非伪造响应或声称撤销服务器成功。

### 结果与复跑

私有root `/tmp/wemux-wsdelete-fixes-9q9nef3e`：preedit副本/hash、`red.log`（410≠404与revision undefined两个实际红）、`green.log`、server/client/types/Vite日志、project/account结果。初次shared-client测试误用Fetch response.ok()，修成boolean后才记录有效P2红；初次delayed DELETE测试误等logout后已取消request的200，修正为身份退休的实际abort语义，无生产行为变更。

- focused Server **66/66**，最终两项review回归**2/2**（与66重叠）含增补rename/明确其他Team；client/application **49/49**。
- Server/Next和new-tests/fixture直接no-emit typecheck通过，私有当前源码Vite build通过。
- 实际两Worker browser **57 checks**，最终 `/tmp/wemux-real-workspaces-WeJdEm/evidence/result.json`，`cleanupFailures=[]`；reconnectEvidence对两viewport分别记录两Worker的相关报告seq及ACK，不再固定sleep。
- project browser **96 checks**、account-team **115 checks**双端通过。原物理文件保留、stale token、失败重试拒绝、Task删除/CAS/身份/导航回归保留。

```sh
RUN=/tmp/wemux-wsdelete-fixes-9q9nef3e
node_modules/.bin/tsx --test apps/server/src/test/workspace-delete-review.test.ts
node_modules/.bin/tsx --test apps/server/src/test/{workspace-delete-review,workspace-delete,task-delete,task-delete-artifacts,task-content-cas,tasks,task-workspaces,task-assignment-http,project-create-idempotency,task-workspace-create-idempotency,server,session-lineage,session-files-http,session-terminal-http}.test.ts
node --experimental-strip-types --test packages/web-client/tests/*.test.mjs apps/web-next/tests/{placement-retry-intents,unsaved-navigation,task-content-draft,application,account-routes,source-boundaries}.test.mjs
npm run typecheck --workspace @wemux/server
npm run typecheck --workspace @wemux/web-next
node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck apps/server/src/test/workspace-delete-review.test.ts apps/web-next/tests/real-workspace-worker.ts apps/web-next/tests/real-worker-workspaces.browser.mts
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui"
# Explicit installed PLAYWRIGHT_CORE_PATH / PLAYWRIGHT_CHROMIUM_PATH as in previous gate.
WEMUX_NEXT_TEST_DIST="$RUN/ui" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/real-worker-workspaces.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET03_EVIDENCE="$RUN/project.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET02_EVIDENCE="$RUN/account.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
```

精确本轮source/docs哈希manifest与脱敏证据在 `.scratch/web-next-project-agent-platform/evidence/ticket03/workspace-delete-fixes/`，旧review BLOCK及原失败证据保留。无root build/test、外部安装/模型、live8010/8004、production data/credentials、shared dist/tgz、stage/commit/deploy。没有扩大生命周期范围；opaque fingerprint/ABA、historical accepted proof不完备、原Session/Run/composite保留、视觉/跨主机/candidate-root等限制继续有效。

## Workspace准备取消：既有保护拒绝迁移与安全加固（2026-10-02）

**本轮是已验证的拒绝行为，不是新增“停止准备”功能。** parent批准有限迁移范围，不建立取消wire协议或per-attempt abort基础设施。Workspace-delete remediation独立复审no issues/OK with notes，已记为本地review通过；本轮安全加固待独立review，整票/all16仍partial。

### 规格/旧实现界线及批准决策

Ticket03原文是“工作区取消/删除相关有效行为按清单验证…错误显示实际原因”。操作inventory列Workspace创建、Placement和重试，没有实际成功停止准备操作。旧create-dialog的“取消”关闭未提交表单，busy时禁用，不代表停止已提交Worker工作。既有`DELETE /commands/:id`仅对当前stopped准备返回protected_command；已有task-workspaces回归锁定离线拒绝和重连继续投递。

pending不能证明未发出：Server gateway可先向持久outbox投递，随后才收到应用receipt；报告也可能先于receipt。当前WorkerRuntime只有准备Promise和全局shutdown/LocalProvisioner AbortController，没有带attempt的独立取消命令/settled取消报告。因此parent批准**任何workspace.provision command一律409保护拒绝**，不用generic cancelPending假装停止；真正物理准备取消明确是未来产品缺口。

### 修复与权限

- `ServerService.cancelCommand`在同一事务内读持久command payload；只要kind为workspace.provision，不论pending/accepted、ready/failed报告、rejected receipt、旧attempt或当前attempt，均返回409 `{code:'protected_command',message:'protected_command: Workspace preparation cancellation is unavailable'}`，在任何cancelPending/audit/notification之前。没有Workspace名称/path/私有状态细节。重复/重启请求结果相同，不写幂等新状态，不给safe-delete资格。
- 普通非provision命令保持原pending cancellation行为（含既有late receipt语义）；Run命令保护不变。公开cancelCommand调用仅admin-routes的DELETE；另一内部cancelPending调用是Run create拒绝后的enqueue清理，不是准备取消入口，没有更改。
- 新负例发现**真实权限漏洞**：`auth:'admin'` descriptor并不自动authenticateAdmin；handler仅先验PAT scope，DELETE原handler没有调用operator。非admin用户持write+admin scope PAT能到protected409，甚至能取消普通命令。parent额外批准精确路由在任何command lookup之前`await context.operator()`，执行原本声明的管理员权限，而非新增Project-manager规则。PAT scopes绝不能授予实例管理员身份。Cookie/CSRF与PAT scope检查保留。
- Next移除误导的可点击“取消排队准备”，显示准备取消暂不可用、请求继续处理、关闭页面/表单不会停止Worker或回滚文件。普通重试、删除及真实错误展示保留；无取消动作，故不引入取消异步回调/身份退休风险。

### 红绿与验证边界

`workspace-preparation-cancel.test.ts`首先在真实HTTP复现**terminal报告先于应用receipt时旧实现返回200/status=cancelled**；记录`red.log`。修复后又发现非admin返回409而非403，记录`nonadmin-auth-red.log`；不是fixture错误。精确路由授权修复后green。

公共行为矩阵：offline pending、重启重复、transport已durable发送但fixture暂不发ACK/应用receipt（owned transport SQLite只读断言该command确在outbox）、accepted、terminal-report-before-receipt、failed/ready、superseded/current retry、rejected。每次拒绝前后command payload/status、placement/terminalReport和可投递身份不变；outbox行不移除/修改。相同retry requestId仍同command，没有重复准备。普通命令admin PAT与cookie+CSRF可取消，非admin不能改它；缺失/错误认证401，非admin持全scope PAT对existing/unknown均403且无protected disclosure；admin read-only PAT拒绝，缺CSRF拒绝。

真实双Worker desktop/mobile：断开A，UI创建empty Workspace、公开API两次拒绝取消并确认command/placement不变；A真实重连后仍原command实际物化目录ready。UI说明不可取消，没有stop按钮。两个Git落点真实ready且各自编辑后再请求取消，409且command、terminal proof、两份文件不变。原retry/ready、logical delete、报告ACK drain和identity-retirement场景继续通过。**不能据此说实际停止已验证**；这里证明拒绝不妨碍原准备完成、不破坏用户文件。

结果：Server focused **61/61**，Run **87/87**，Worker **20/20**，client/application **49/49**；Server/Worker/Next和新测试直接types通过。真实Worker browser **61checks**（原57+两端各2个拒绝不变/继续完成检查），project **96**、account **115**双端通过。没有shared types或client代码变更，无需build:packages；Server typecheck脚本自身按既有约定编译domain/wire，不是root build。

### 新发现的相邻授权问题（独立后续，不在本修复内）

只读审计发现同类descriptor-only路径：`admin-routes.ts`的GET `/commands`、GET `/commands/:id`、GET `/cluster/tailnet`未调用operator；`resource-routes.ts`的PATCH/DELETE `/projects/:id`、PATCH/DELETE `/sessions/:id`在generic调用中未传actor/operator。已向parent报告为独立安全审计/修复事项。本轮未改这些路径，不能因DELETE精确修复而声称整个admin路由授权已正确。此处为source finding，未冒称每个相邻路径均已动态复现。

### 证据与命令

私有root `/tmp/wemux-preparation-refusal-7knypk1m`含preedit/hash、red/nonadmin-auth-red/green、server/run/worker/client tests、types、Vite与browser日志/results；private dist `ui/`。最终真实Worker证据 `/tmp/wemux-real-workspaces-bnXkAL/evidence`，passed61checks/cleanupFailures空；owned state正常finally清理。脱敏归档 `.scratch/web-next-project-agent-platform/evidence/ticket03/preparation-cancel/`。原FAILED证据保留，未覆盖旧历史。

```sh
node_modules/.bin/tsx --test apps/server/src/test/workspace-preparation-cancel.test.ts
node_modules/.bin/tsx --test apps/server/src/test/{workspace-preparation-cancel,workspace-delete-review,workspace-delete,task-delete,task-delete-artifacts,task-content-cas,tasks,task-workspaces,task-assignment-http,project-create-idempotency,task-workspace-create-idempotency,cluster-stages,server}.test.ts
node_modules/.bin/tsx --test apps/server/src/test/task-runs.test.ts
node_modules/.bin/tsx --test apps/worker/test/{worker,workspace-files,local-provisioner-revisions}.test.ts
node --experimental-strip-types --test packages/web-client/tests/*.test.mjs apps/web-next/tests/{placement-retry-intents,unsaved-navigation,task-content-draft,application,account-routes,source-boundaries}.test.mjs
npm run typecheck --workspace @wemux/server
npm run typecheck --workspace @wemux/worker
npm run typecheck --workspace @wemux/web-next
node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck apps/server/src/test/workspace-preparation-cancel.test.ts apps/web-next/tests/real-workspace-worker.ts apps/web-next/tests/real-worker-workspaces.browser.mts
RUN=/tmp/wemux-preparation-refusal-7knypk1m
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui"
# Explicit installed PLAYWRIGHT_CORE_PATH / PLAYWRIGHT_CHROMIUM_PATH as previously documented.
WEMUX_NEXT_TEST_DIST="$RUN/ui" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/real-worker-workspaces.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET03_EVIDENCE="$RUN/project.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET02_EVIDENCE="$RUN/account.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
```

本轮仅把**既有拒绝迁移**与新安全缺陷修复记为本地已验；真正成功取消、历史attempt proof、historical Task删除、相邻权限修复、独立视觉审查和candidate/root/dependency门保持OPEN。既有共享client cancelPreparation方法兼容保留但Next无normal workflow调用。无外网/安装/模型/生产数据/8004/8010、root build/test、shared dist/tgz、stage/commit/deploy。待独立review，不宣称全票或all16完成。

## 相邻declared-admin路由安全修复（2026-10-02）

状态：本轮安全修复implemented/locally verified，待独立review；整票/all16仍partial。上一准备取消protected-refusal切片独立review OK with notes，现记为本地已review，**不等于成功物理取消**。

### 精确可达性与政策

实际`routes/index.ts`按数组顺序、registry first-match。七个目标方法/路径均唯一且可达，没有同method/pattern被shadow的非发现：GET `/commands`、GET `/commands/:id`、GET `/cluster/tailnet`归admin-routes；PATCH/DELETE `/projects/:id`和PATCH/DELETE `/sessions/:id`归resource-routes。既有GET Session和PATCH Session `/access`是另一个authenticated scoped合同，未改。新增registry对象身份测试补充公共HTTP行为，而非扫描字符串替代授权证明。

七个handler现**首先await context.operator()**再读取body、查询资源、执行tailnet子进程或变更。原descriptor本身不authenticateAdmin的问题已真实复现：匿名GET commands200而非401；admin无Project Grant的PATCH原200；admin scope不足原可读/写。请求无/错认证401；非admin Cookie及带read/write/execute/admin全部scopes的PAT仍403，existing/unknown ID一致。PAT scope不是实例admin身份；已声明admin的PAT也要admin scope，read-only不是admin路由的合法凭据。Cookie写仍要求CSRF。

### 经parent额外批准的Project作用域收紧

generic Project update/delete原来没有资源交集，即使传actor也未验证。parent明确批准**实际instance-admin AND 当前Project owner/manager**，不是声称原实现已这样执行，更不新增非admin manager公开入口。service在同一store事务中先`ProjectAccess.requireInTx(...,'manager')`再audit/lifecycle/retained-history约束。admin同Team无Grant/跨Team、viewer/contributor、撤权后的请求按既有helper语义404 project_not_found；不披露非空/已删除constraint细节。admin owner/manager对符合条件的empty Project可rename/delete；保留Workspace/Task历史仍409。

Session PATCH/DELETE传actor，重用既有Session control权限而不是替换为新政策。先控制授权再audit/删除idle校验，无关联Project权限404、只有Session可读的admin viewer403，合法admin owner或有可读Session的Project manager可控制。此处没有历史Task删除/Worker cleanup扩张。内部actor-less组合方法保持兼容；生产调用清单审计发现这些Project/Session update/delete仅此四个HTTP调用，现均传actor。测试和旧内部服务用法未擅自删掉。

Next项目设置改为只有instanceAdministrator且project.accessRole为owner/manager显示rename/delete；其他角色显示准确双重要求说明。Project权限实时撤销/角色变化仍依已有机制隐藏资源。

### 测试/真实浏览器证据

- 公共红先于生产改动：`red.log`记录匿名commands200≠401、无Grant admin Project PATCH200≠404、insufficient-scope200≠403；路由可达性测试原本即通过。原红保存，不把这是fixture错误。
- 新4项HTTP/registry矩阵最终通过：所有目标方法existing/unknown、missing/invalid、non-admin manager Cookie/全scope PAT403；无private名称/command/network数据；拒绝前后Project/Session/Workspace/Task versions、mutation audit和command队列一致。PAT used/login安全事件不混入mutation audit比较。
- tailnet使用owned PATH中的无害CLI fixture记录调用：所有拒绝请求零子进程，合法admin诊断一次，避免执行真实网络命令。admin Cookie+CSRF与full-scope PAT合法，read/write不足scope拒绝；缺CSRF拒绝。
- 合法空Project rename/delete及合成fresh-idle Task-bound Session rename/delete成功；Session删除测试只证明既有server命令/记录语义，**无真实Worker清理或文件删除声称**。admin manager Session rename+撤权拒绝、viewer control拒绝、mutation audit actor正确。保留原Session scope read行为。
- focused route/auth/PAT/lifecycle **44/44**；另auth/registry/Project/Session **19/19**；最后新增矩阵4/4重跑通过（与44重叠）。client/application **49/49**。Server/Next/direct fixture typecheck通过。
- 新 `admin-route-auth.browser.mts` desktop1440×900/mobile390×844 **20checks**：真实浏览器登录合成owner/admin/member；非admin manager能看Project但无admin修改入口，通过同origin Cookie+CSRF真实HTTP七类操作拒绝且无资源改变/无tailnet调用；admin viewer拒绝，授manager后Next真实rename，撤权后请求拒绝/页面清私有标题；合法owner Next确认删除empty Project。Session页面尚未迁移，Session rename用浏览器fetch公共API验证，不伪称点击Session UI。
- 当前源码私有Vite下原project **96checks**、account **115checks**双端通过。无packages源码改变，不需要build:packages；root build/test没有运行。

### 命令与归档

本轮私有根 `/tmp/wemux-admin-route-auth-gg1cjure`：preedit/hash、red/green、server-tests/auth-tests/client-tests/types/vite、security-browser/project/account日志与JSON。新安全browser证据 `/tmp/wemux-admin-browser-evidence-WPZjKc`（20checks/cleanupFailures空），包含两端截图；截图像素没有在本轮宣称独立验收。私有fixture DB/账号/metadata/tailnet executable finally只清自身root，证据另保留。

```sh
node_modules/.bin/tsx --test apps/server/src/test/admin-route-auth.test.ts
node_modules/.bin/tsx --test apps/server/src/test/{admin-route-auth,workspace-preparation-cancel,workspace-delete-review,workspace-delete,task-delete,task-delete-artifacts,server,session-lineage,session-files-http,session-terminal-http,personal-access-token-management}.test.ts
node_modules/.bin/tsx --test apps/server/src/test/{auth-routes,http-route-registry,project-authorization,project-authorized-resources,session-authorization-http,session-workbench,project-create-idempotency}.test.ts
node --experimental-strip-types --test packages/web-client/tests/*.test.mjs apps/web-next/tests/{placement-retry-intents,unsaved-navigation,task-content-draft,application,account-routes,source-boundaries}.test.mjs
npm run typecheck --workspace @wemux/server
npm run typecheck --workspace @wemux/web-next
node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck apps/server/src/test/admin-route-auth.test.ts apps/server/src/test/fixtures/admin-route-fixture.ts apps/web-next/tests/admin-route-auth.browser.mts
RUN=/tmp/wemux-admin-route-auth-gg1cjure
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui"
# Explicit installed PLAYWRIGHT_CORE_PATH and PLAYWRIGHT_CHROMIUM_PATH as previous gates.
WEMUX_NEXT_TEST_DIST="$RUN/ui" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/admin-route-auth.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET03_EVIDENCE="$RUN/project.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET02_EVIDENCE="$RUN/account.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
```

精确pre/post SHA256增量清单与脱敏证据 `.scratch/web-next-project-agent-platform/evidence/ticket03/admin-route-auth/`。后续增加合法admin-manager Session rename测试时，初次audit预期仍只允许owner而失败；修正测试为精确一条manager update+两条owner update/delete，保留实际actor证明，未放宽权限实现。

**广度限制**：本轮仅上述七个方法/path及Project交集收紧，不是全路由admin descriptor自动审计或通用handler改造。其他descriptor未验证、未证明安全；源码没有覆盖就不宣称无风险。成功物理prepare cancel、历史attempt proof、historical Task删除/终端排空、独立Repository管理/排序、视觉与candidate/root/dependency等仍OPEN。建议先review本安全增量，再由parent选择下一有限Ticket03范围/验收决策，不能直接结整票/all16。


## Task列表发现与精确排序验收（2026-10-02，单一前端接缝）

状态：**implemented/locally verified，待独立review；整票partial**。parent采纳对账中的不新增Standalone Repository CRUD/持久rank、protected-refusal不等同停止准备、历史删除差额继续OPEN；本轮没有改这些生命周期、draft创建保护、metadata或link/activity。

### 来源与实现

- 旧`apps/web/src/features/tasks/board.tsx:79–85`的有效代码路径直接对已授权Task列表做`title.toLowerCase().includes(query.toLowerCase())`与精确status AND筛选；旧`q/filter`是旧route的控件编码，并非新域字段。Next当前view/sort是组件内状态，因此新search/status也内存持有，随Project/client/role subtree退休，不新增URL写入、localStorage、domain/API调用。Task深链仍仅原`?task=`，不把每次按键变成导航或触发dirty确认。明确限制：离开项目或刷新重置筛选，不声明旧q/filter深链迁移。
- `ProjectTasks`增中文searchbox、全状态select、清除按钮和有界获权计数；无匹配与无任务空态分开；同一结果用于list/board，已选Task详情独立保留（即使被筛选隐藏），编辑draft不会丢弃。
- `task-list-view.ts`是直接相关纯函数：title/status交集→原三种sort→ascending ID tie-break，不修改请求缓存。排序语义保持原来updated降序、title中文locale、priority high→none，非新持久rank。Project排序算法未动，只增加明确aria-label；Task行data-task-id与看板列accessible region提供可检查结果身份。
- 已读本仓库design-taste-frontend技能，其声明不用于dashboard/table；按适用部分保留现有Paperclip primitives/token与中文/移动布局，不加视觉体系或依赖。HTTP不安全上下文randomId/clipboard等既有边界没改。

### 红绿与断言

实施前先增加真实browser case，pre-edit private Vite下在`desktop: title search available and live filtering`失败（无搜索控件），结果归档`red.json`。新增控件实际是searchbox角色，开发中测试误用textbox导致初轮修复后仍失败；改为正确accessible searchbox定位后通过，不把定位错误算生产缺陷。

新增2项unit行为测试锁定具体期望ID数组，筛选大小写/status交集/清空/无结果、updated/title/priority与ties、原数组不变。browser复用已有private adminRouteFixture，所有Project/Task创建与Grants走真实HTTP；为了重复排序用例仅在**owned合成DB**设置四个Task确定updatedAt（两项相同），不mock API响应/授权；期望顺序由预先选择的Alpha/Beta/Same/priority/time建立，ties按规范要求独立比较ID，不导入生产排序helper产生期望值。

每viewport3+获权实体（4Project、4Task）和隐藏Project/隐藏Task；真实结果断言覆盖：

1. 大小写不敏感标题substring、描述不参与搜索、status单项和交集、无结果/清空、获权4/4计数。
2. 三种Task最终ID顺序及list/board分组内一致，tie-break确定；Project name/role最终链接ID顺序、name与role ties、隐藏Project不进入结果。
3. 连续typing不替换input、不失焦；显式Task刷新与app权限刷新保持输入节点/值，旧账户筛选不进入新Project。保留dirty Task详情时改search/status不弹离开提示、不丢草稿。
4. 实际Team切换清掉前Project列表/控件；logout后另一个无Grant admin登录深链不能恢复旧Task/filter。新Project空态与无匹配状态独立。
5. desktop1440×900/mobile390×844，board无页面横向溢出与pageerror。截图保存，但**未声明像素已独立检查**。

### 实际结果、命令、清理与边界

本轮focused client/application/draft/list **51/51**，Next typecheck和browser fixture直接no-emit typecheck通过。新列表browser **14组checks双端通过**；旧project **96**、account-team **115**双端回归通过。无Server/domain/package改动，未build packages，未跑Server/root tests。仅私有current-source Vite dist。正常finally关闭browser/Server并清owned fixture state；证据另保留。

原始root `/tmp/wemux-list-discovery-_5tgzx2w`：preedit/hash、`browser-red.log`、`unit.log`、`focused-tests.log`、`types.log`、`browser-types.log`、`vite.log`、`browser.log`、`project/account.json`。红证据 `/tmp/wemux-list-evidence-vycvWv/result.json`，最终绿证据 `/tmp/wemux-list-evidence-iDNkGx/result.json`，`cleanupFailures=[]`。绿截图各viewport有`task-list.png`、`task-board.png`、`project-order.png`、`isolated.png`，在同目录。脱敏归档与精确增量manifest：`.scratch/web-next-project-agent-platform/evidence/ticket03/list-discovery/`。

```sh
node --experimental-strip-types --test apps/web-next/tests/{task-list-view,application,account-routes,source-boundaries,task-content-draft,unsaved-navigation,placement-retry-intents}.test.mjs packages/web-client/tests/*.test.mjs
npm run typecheck --workspace @wemux/web-next
node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck apps/web-next/tests/list-discovery.browser.mts
RUN=/tmp/wemux-list-discovery-_5tgzx2w
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui"
# 已安装的显式PLAYWRIGHT_CORE_PATH/PLAYWRIGHT_CHROMIUM_PATH沿用前节，不安装新浏览器。
WEMUX_NEXT_TEST_DIST="$RUN/ui" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/list-discovery.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET03_EVIDENCE="$RUN/project.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET02_EVIDENCE="$RUN/account.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
```

限定剩余：本切片review；CURRENT中link/activity/rename补验、创建draft/metadata候选与所有历史生命周期及视觉/root/candidate/dependency门保持原样。无全票/all16完成声明，无外部网络/install/Agent/model调用、生产数据/8004/8010、shared dist/tgz、stage/commit/deploy。


## 操作级证据补齐：link/activity/Workspace rename（2026-10-02）

**仅测试/文档，无生产代码改动。** 开始与结束核对HEAD=`93c9f67`，既有dirty tree保留。列表发现review `outputs/32292e84-2654-4692-9407-b688c42765a2/tickets/03/list-discovery-review.md`为OK with notes/no issues（parent已消费d99c0c6a），CURRENT E7/1b/4a/4b据此更新；不是全票批准。本批次E8待独立review。

新增 `apps/web-next/tests/operation-evidence.browser.mts` 复用既有`adminRouteFixture`，私有动态loopback Server、合成owner/viewer/无Grant admin、独立browser contexts，Project/Task/Workspace操作全部走真实public API/Next控件，不mock成功/失败响应。fixture初始账号和无关idle Session为既有合成测试metadata；本场景不执行Worker/Agent/物理文件操作。浏览器不打开GitHub外链，不用外部网络。

每个desktop1440×900/mobile390×844真实执行：

1. UI创建Task。提交语法合法但非GitHub的URL `https://example.test/not-a-github-issue`，观测实际POST400 `invalid_request`；表单显示服务端原因、保留输入；API links/activity完全不变。纠正为GitHub Issue后同表单成功，错误清除，UI出现link。
2. UI点“移除关联”及确认，真实DELETE200，链接消失；新增/删除activity的linkId与真实对象一致。再编辑标题、status迁移todo、添加Pull Request，为可读负例保留link。
3. 明确期望六条事件：created、link added、link removed、content updated、transitioned、link added；检查序号1..6、actor为owner、各payload精确匹配（含dirty字段仅title、状态from/to）。可见活动每一行type/payload/time与公开API逐条一致，不只比较计数。两次“加载最新版本”及整页reload后API事件全文不变、UI只有同六条，无重复。
4. UI创建无placement逻辑Workspace，再真实UI改名；原标题消失、新名立即出现在相同身份列表。手动刷新及整页reload重开Workspace tab后只一条该id新名，API一致。
5. viewer可读link/activity/Workspace，但UI没有link增删/Workspace改名入口；直接浏览器Cookie/CSRF公共API写403。另一无Grant admin进入深链只得无权页，detail/activity/link写/Workspace改名403或404，没有私有标题/URL泄漏。拒绝后links/activity/Workspace name原样。
6. 所有三种账号页面无横向溢出，无pageerror；截图存在，不声称独立pixel/视觉或辅助技术review通过。

**结果**：新browser12组断言双端通过，cleanupFailures=[]；focused client/application51/51，Next与新browser直接no-emit typecheck通过；原project96、account115双端回归通过。没有新产品bug；第一次测试误预期link POST201而现有route合同是200，纠正测试到`apps/server/src/http/routes/task-routes.ts:52–53`实际合同后通过，未改生产/弱化期望内容。该首次失败保留并标为测试期望错误，不算产品红绿修复。

私有run `/tmp/wemux-operation-evidence-av_wu3i6`：preedit/hash、private UI、browser/types/focused/project/account/Vite日志；最终结果 `/tmp/wemux-operation-browser-tFEDza/result.json`，两端截图`task-activity.png`、`workspace-renamed.png`、`readonly-workspace.png`、`unauthorized.png`在同目录。初次合同预期错误 `/tmp/wemux-operation-browser-nx0ttI/result.json`保留。fixture finally关闭browser/Server并仅清owned私有DB/账号/tailnet executable root，evidence另留。脱敏副本与精确manifest `.scratch/web-next-project-agent-platform/evidence/ticket03/operation-evidence/`。

```sh
RUN=/tmp/wemux-operation-evidence-av_wu3i6
node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck apps/web-next/tests/operation-evidence.browser.mts
npm run typecheck --workspace @wemux/web-next
node --experimental-strip-types --test apps/web-next/tests/{task-list-view,application,account-routes,source-boundaries,task-content-draft,unsaved-navigation,placement-retry-intents}.test.mjs packages/web-client/tests/*.test.mjs
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui"
# Explicit installed PLAYWRIGHT_CORE_PATH/PLAYWRIGHT_CHROMIUM_PATH as prior gates.
WEMUX_NEXT_TEST_DIST="$RUN/ui" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/operation-evidence.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET03_EVIDENCE="$RUN/project.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts
WEMUX_NEXT_TEST_DIST="$RUN/ui" WEMUX_TICKET02_EVIDENCE="$RUN/account.json" timeout --signal=TERM --kill-after=5s 100s node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
```

下一parent决策只指向既有候选：创建草稿保护 `apps/web/src/components/create-dialog.tsx:29–30`、`apps/web/src/features/tasks/board.tsx:39–41`；metadata editor `apps/web/src/features/tasks/board.tsx:110–114`（实际字段见该区域，旧JSON编辑支持存在）。本轮未实现/重新验旧UI，不新增调查范围。历史Task/Workspace限制、实际物理cancel、视觉/root/candidate/dependency门不变，原七条复合checkbox继续未关闭。无stage/commit/deploy、生产数据/8004/8010、外部运行时/安装/模型/网络、shared dist/tgz或root build/test。


## E8 P2修复：等待活动list/逐行DOM可见（2026-10-02）

**只改测试断言和文档/证据，无生产改动。** 原operation review8939f4f9为OK with notes，parent接受P2：先前helper只比较DOM文本，不证明list/row可见。本轮为其有限修复，parent直接核验待完成；Ticket03/all16保持partial。

`apps/web-next/tests/operation-evidence.browser.mts`的`assertVisibleActivity(page, activity, timeout=10000)`现在通过“活动”heading相邻的实际`ol`定位，先等待list visible，再等待每个预期直接`li` visible，之后保留原精确count/order/type/payload/time内容校验和独立seq/actor/API assertions。不以容器存在或textContent替代可见性。

每个desktop1440×900/mobile390×844都有两个bounded负探针：对实际list临时加`display:none!important`，对最后预期row临时加`visibility:hidden!important`；DOM事件内容不变，先断言target不可见，再要求同一个helper以350ms timeout抛TimeoutError。`finally`按原style attribute完整恢复（原无style则移除attribute），核对恢复值、dispose ElementHandle，再使用默认wait重新验证全部可见与内容/order一致。没有改生产文件或持久页面数据；负探针的预期超时是成功断言，不是产品/基础设施失败。

实际结果：operation browser **16组checks**（原12+两端各2个negative visibility probe），`passed=true`、`cleanupFailures=[]`；新test直接no-emit类型检查通过；当前源码private Vite build通过。没有重跑无关suite或其它Project/account gates，旧51/96/115结果仅历史证据。最终 `/tmp/wemux-operation-browser-VsgqZh/result.json` 和同目录两端截图；本轮run `/tmp/wemux-activity-visibility-eicca4nh` 含preedit/hash、types/vite/browser日志与private `ui/`。精确增量及脱敏证据 `.scratch/web-next-project-agent-platform/evidence/ticket03/activity-visibility-fix/`。

```sh
RUN=/tmp/wemux-activity-visibility-eicca4nh
node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck apps/web-next/tests/operation-evidence.browser.mts
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui"
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
WEMUX_NEXT_TEST_DIST="$RUN/ui" timeout --signal=TERM --kill-after=5s 100s \
node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/operation-evidence.browser.mts
```

**DOM visibility不是pixel/visual approval**：它证明非hidden且有渲染框，不证明像素品质、遮挡、对比度或完整视觉验收。parent的vision_analyze因配置`my-codex/gpt-5.6-luna` unavailable失败，视觉gate继续blocked；没有修改model settings或调用替代模型。私有fixture在finally正常清理，styles即使负断言失败也恢复。无生产改动、stage/commit/deploy、外部安装/模型、8004/8010、root build/test或shared dist/tgz。历史FAILED证据保留，其他未完成范围不变。

## E9 普通Task创建草稿保护：同角色fallback完成（2026-10-02）

状态：**implemented / locally verified，待独立review**；Ticket03/all16仍partial，七条复合checkbox不变。本轮是在旧runner丢失、authoritative resume拒绝后获准的新writer，不恢复旧child、不启动嵌套代理。HEAD仍`93c9f67`，保留全部intentional dirty tree。

### 实际增量及归属

- 原child已留下`TaskCreateForm.tsx`及`ProjectTasks.tsx`接入：四字段内存草稿，精确空值/priority=none为pristine；注册现有unsaved guard；按Task selection key退休；pending fieldset禁用+useAction同步pending latch；同body失败保留useCreateIntent requestId，成功先同步清guard ref再detail导航；operation lifetime防退休回调修改新页面。fallback未再改生产源码，未发现需修复的本slice生产缺陷。
- `navigation.ts`和`unsaved-navigation.ts`为**既有导航切片**，不是此次新改：当前SHA256与`E/task-workspace-navigation/file-delta.json`的after完全相同（分别`650fbdb087fa85edf68c172a7a21d276caa4b90670934076695698c75933c97a`、`32566ade786d41f18735c661ffb88b1fe5b9f3b759eeed50a6923cad4fad4aeb`）。parent recovery全Next src/tests与fallback入场逐文件一致。不能把整个untracked `apps/web-next/`或HEAD以来Server/Worker/package等dirty变更归本slice。
- fallback只扩充`task-create-draft.browser.mts`、`unsaved-navigation.test.mjs`与当前验收/票据文档。guard单测确认两个guard共存、批准并不隐式抹除状态、一个dispose不能绕过另一个。
- 不改metadata、Project/Workspace等其他创建表单、共享ActionForm、API/权限/CAS/idempotency、物理Worker/Agent生命周期；不承诺reload后恢复草稿。批准离开不撤销已经服务端提交的Task，只退休私有UI与回调。

### 当前运行证明（均由fallback实际执行）

私有root `/tmp/wemux-create-draft-fallback-ny6bxz5_`，当前真实browser证据 `/tmp/wemux-create-draft-evidence-p8iRWS/result.json`，**12组desktop/mobile（1440×900/390×844）**，`cleanupFailures=[]`。使用现有private real Server/SQLite、合成账号和Cookie/CSRF，动态端口；没有mock成功/401、模型或外部服务。两端各六组：

1. Task选择、关闭详情、Project list、工作区/设置tab、shell Settings/Team入口拒绝均保留字段和位置；refresh/权限focus refresh、搜索/状态筛选/排序/board保留且不提示。
2. 接受selection/close丢弃；拒绝back恢复URL；四字段分别独立变脏/还原验证；接受tabs/Project/shell/Team/back/forward均丢弃，拒绝forward恢复URL与全部字段。Team为从Project进入Team页面的导航，实际Team范围切换仍由既有project96回归证明，不伪称同一新draft仍挂载于Team选择器。
3. 真400同body两次保持同requestId及多行/优先级；纠正body后换ID。真POST提交后扣留/丢响应，pending全部字段禁用、程序化重复submit不出第二请求；重试同ID只产生一个Task，成功先清四字段再detail导航，不产生假确认。
4. 已提交Task响应跨真实viewer降权退休，无prompt/导航/私有恢复；恢复contributor得到空表单。logout跨另一held commit同样清理；再次登录为空。
5. 另一个真实登录调用logout-all撤销浏览器会话；focus revalidation `/api/teams`真实401，login页替代私有表单；释放已提交响应无prompt/导航/复活，无pageerror。logout-all保留调用者，测试显式logout该辅助会话。
6. 截图记录空新建表单及退休登录态，只是证据采集，**没有像素批准**。

- focused shared-client/Next **52/52**（新增1个guard共存测试）；focused Server **31/31**（创建幂等/Task-workspace创建/内容CAS/tasks/task-workspaces/assignment）。
- Server/Next typecheck与browser fixture直接no-emit通过，私有Vite当前生产源码build通过；Server typecheck脚本会构建既有domain/wire包产物，未修改包源码，未跑root build或shared Web/Worker dist/tgz。
- 私有同dist双端project-management **96 checks**、account-team **115 checks**通过，包含既存CAS/异步意图/撤权/Team变换/登录导航回归。project使用受控Worker protocol，不是重新跑realWorker物理准备61checks。

### 失败、继承证据与清理边界

原child `/tmp/wemux-create-draft-evidence-ZsuJkp`为首个selection拒绝红；`/tmp/wemux-create-draft-evidence-o4V3mN`为8组绿/cleanupFailures空。只读取保留，**不是fallback重跑**；旧root focused/browser-types/project日志空，不能当通过。原生产preimage只提供ProjectTasks和两份docs，`TaskCreateForm`/browser文件原缺失判断来自恢复上下文，manifest明确无原preimage，不制造完整基线。

fallback首次直接browser types发现TS7022（fixture局部推断），显式标注ID/字符串/计数类型后通过。新增auth场景最初两次错等`/api/auth/me` 401，实际源码focus走`/api/teams`；两次失败结果与空cleanupFailures保留，修正测试谓词后最终12组绿；没有以此改生产auth。第一次扩展10组绿也保留，不与最终12加总。

draft脚本finally关闭browser和private fixture（关闭Server/删除owned SQLite目录/恢复PATH），结果无cleanup失败；project/account脚本finally退出成功并删除owned root，没有cleanupFailures字段，不能冒写该字段。证据/Vite/preimages按要求保留；未做全局进程kill或环境清理。无8004/8010、生产数据/凭据、外部安装、paid Agent、root build/test、deploy/stage/commit/reset/clean。

### 可复跑命令与manifest

```sh
RUN=/tmp/wemux-create-draft-fallback-ny6bxz5_
node --experimental-strip-types --test packages/web-client/tests/*.test.mjs apps/web-next/tests/{placement-retry-intents,unsaved-navigation,task-content-draft,task-list-view,application,account-routes,source-boundaries}.test.mjs
node_modules/.bin/tsx --test apps/server/src/test/{project-create-idempotency,task-workspace-create-idempotency,task-content-cas,tasks,task-workspaces,task-assignment-http}.test.ts
npm run typecheck --workspace @wemux/server
npm run typecheck --workspace @wemux/web-next
node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck apps/web-next/tests/task-create-draft.browser.mts
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui"
export PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs
export PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
export WEMUX_NEXT_TEST_DIST="$RUN/ui"
timeout --signal=TERM --kill-after=5s 150s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/task-create-draft.browser.mts
WEMUX_TICKET03_EVIDENCE="$RUN/project.json" timeout --signal=TERM --kill-after=5s 150s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts
WEMUX_TICKET02_EVIDENCE="$RUN/account.json" timeout --signal=TERM --kill-after=5s 180s node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
```

`E/task-create-draft-fallback/`保存fallback preimages/原slice可得preimages、SHA256/diffs、继承红绿、当前结果、日志与commands/cleanup记录。原parent snapshot `/tmp/wemux-draft-recovery-nrt3oi0u`、原slice `/tmp/wemux-task-create-draft-q_k7rlfg`不改。

下一步仅独立review本slice。metadata、历史Task/Workspace生命周期、整体candidate/root/CI、Ticket01依赖、双宿主/真实部署仍OPEN或外部门；独立视觉所配`my-codex/gpt-5.6-luna` unavailable，gate仍blocked，无模型替换/CLI fallback或pixel approval。E8 P2的parent源码/hash/child16checks核对不是parent重跑，亦不是此E9 review。


## 普通Task高级Metadata JSON创建/编辑迁移（2026-10-03）

E9创建草稿fallback独立review **no issues / OK with notes** 已纳入CURRENT；reviewer检查但未重跑测试、重算hash或审阅像素。新E10 **本地verified、待独立review**，Ticket03/all16仍partial，原七checkbox及历史删除/视觉/candidate/双宿主等门OPEN。

### 窄合同与实现

- 来源为legacy `board.tsx`高级设置、`features/tasks/draft.ts`原样JSON.parse与既有`TaskService.content`。Next只增加普通Task创建/编辑高级JSON textarea；没有新metadata key/schema/protocol、Repository/rank/lifecycle或Server生产修改。
- 必须为对象且仅顶层`schemaVersion:1`与`values`对象；保留所有values下未知key、嵌套null、空串、数组和对象。空白文本、JSON null、数组、缺values/不合法schema均报实际parse/validation原因，保留原始文本、不POST/PATCH，不替换为空对象。JSON.stringify长度边界16000，与Server一致。默认创建显式发`{schemaVersion:1,values:{}}`，等同原Server默认；验收标准的null/空串保持原逻辑。
- Metadata是一个内容字段：对象key顺序/格式不算修改；数组顺序、null/空串区别保留。结构比较忽略格式，不按key自动合并同字段冲突；远端同字段变化保留raw并要求local/remote选择，不同内容字段自动合并。仅dirty字段序列化PATCH并携带preflight版本。真实409后显式reload/选择，不自动重试；失败/丢响应保留草稿，已提交同结构的重读可收敛为no-op。
- 创建dirty/reset/revert/成功先清空再导航包含metadata。既有pending latch/disabled fieldset、Project角色remount与身份transport退休沿用；viewer只读，Server仍最终授权。没有持久化私有草稿。

### 本轮实际验证与失败记录

- focused draft/metadata/client/application/navigation/list tests **57/57**（此前focused28与初版56包含于最终57，不累加）。Server现有内容CAS/创建幂等/tasks及新metadata HTTP合同 **10/10**。新HTTP测试覆盖默认值、所有非法输入无写、16000边界、unknown及`__proto__`key保留、结构no-op、version409、viewer403/anonymous401。
- 新private Server/browser **18组**：1440×900/390×844真实create/read/edit/reload；无效输入无请求、实际nested内容、格式no-op、dirty-only metadata/version、不同字段合并、local/remote选择、扣留真正outgoing PATCH再并发写的409、pending重复抑制、丢成功响应后no-op收敛、拒绝/接受编辑离开、viewer/无Grant403。两端实际role/logout/auth401退休后释放已提交响应，不能恢复私有UI、提示或触发reload，服务器成功仍保留。截图只记录，非独立像素批准。
- 既有create草稿浏览器扩为五字段 **12组**：metadata独立dirty/revert、拒绝/接受导航/历史、真实400与丢响应同requestId重试、成功先清draft、角色/登出/真实401退休。private Project回归 **96checks**通过，保留其他内容/CAS/导航/权限；Worker为协议fixture，不冒充物理执行。没有重跑account115/realWorker61等不相关历史宽suite，shared/auth/Worker生产代码未修改。
- Next与新增Server/browser直接no-emit types、private Vite均exit0。未调用根/共享build；未改shared包无需build:packages。未外部安装/调用模型、未使用生产凭据/数据、8004/8010、stage/commit/deploy。
- 实施中失败均为新增测试修正，日志保留：Server初次在create body误带patch-only version，返回400非预期403；修正后最后snapshot错误比较read-with-capabilities与mutation-without-capabilities，改比较两次GET。初次direct types发现隐式类型，已补。browser初次错误预期无Grant404（既有TaskService合同为403）；随后role等待使用textarea.disabled而不是fieldset继承`:disabled`，导致三次timeout，修正后通过。无infra错误、无产品合同更改或CLI fallback；失败不标作生产红绿。

### 可重复命令与证据

本轮root `/tmp/wemux-task-metadata-e_h9azwk`，preimages、原始失败/成功log、私有`ui`；最终新browser `/tmp/wemux-task-metadata-browser-2uptAu`、create `/tmp/wemux-create-draft-evidence-2ehqXo`。全部fixture/browser finally cleanup，两个结果`cleanupFailures=[]`。Project fixture也正常结束；只保留本轮证据/私有dist，不留下运行服务。

```sh
RUN=/tmp/wemux-task-metadata-e_h9azwk
node --experimental-strip-types --test packages/web-client/tests/*.test.mjs apps/web-next/tests/{task-content-draft,task-metadata,task-list-view,unsaved-navigation,application,account-routes,source-boundaries}.test.mjs
node_modules/.bin/tsx --test apps/server/src/test/{task-metadata-contract,task-content-cas,tasks,task-workspace-create-idempotency}.test.ts
npm run typecheck --workspace @wemux/web-next
node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --allowJs --esModuleInterop --skipLibCheck apps/server/src/test/task-metadata-contract.test.ts apps/web-next/tests/task-metadata.browser.mts apps/web-next/tests/task-create-draft.browser.mts
node_modules/.bin/vite build apps/web-next --config apps/web-next/vite.config.ts --outDir "$RUN/ui"
export PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs
export PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
export WEMUX_NEXT_TEST_DIST="$RUN/ui"
timeout --signal=TERM --kill-after=5s 120s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/task-metadata.browser.mts
timeout --signal=TERM --kill-after=5s 120s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/task-create-draft.browser.mts
WEMUX_TICKET03_EVIDENCE="$RUN/project.json" timeout --signal=TERM --kill-after=5s 120s node scripts/test-with-browser.mjs -- node_modules/.bin/tsx apps/web-next/tests/project-management.browser.mts
git diff --check
git diff --cached --name-only
```

以上最终命令均exit0，staged名单为空。精确本轮12文件pre/post SHA256与incremental diff、sanitized结果/失败摘要、命令结果归档 `.scratch/web-next-project-agent-platform/evidence/ticket03/task-metadata/`。Next目录在继承dirty tree中已为untracked，不能将HEAD diff当此增量。review仍需独立执行；本轮不批准全票或release。


## Metadata创建重试identity P1修复（2026-10-03）

原E10独立review为 **BLOCK**，不是已通过。仅修`TaskCreateForm`为intent提供metadata稳定结构key；新`taskMetadataIntentKey`递归排序object keys，数组顺序不变，Object.fromEntries保留`__proto__`等自身键。原raw和实际request body不改，值/数组顺序改变仍改变identity。未修改通用useCreateIntent、Server fingerprint、编辑CAS或其他创建流程。

新可重复`apps/web-next/tests/metadata-retry-identity.browser.mts`使用真实私有Server：先commit并丢响应，再只重排top-level/nested/array内对象/`__proto__`对象key。修前两viewport均不同requestId、2个持久Task（exit1）；修后均同requestId、1个Task（exit0），并断言raw/两次实际payload未被规范化。focused13（新增语义value/array-order/特殊key/非mutating断言），Next/direct browser types、private Vite通过；metadata18/create12两端真实回归通过。没有重跑不相关Project/Server/Worker宽suite或root/shared build。所有fixture cleanupFailures=[]，无基础设施错误。

证据 `.scratch/web-next-project-agent-platform/evidence/ticket03/metadata-retry-identity/` 含六文件pre/post SHA256、五preimages、精确diff、命令exit和红绿/回归结果。原证据不覆盖。raw/private dist `/tmp/wemux-metadata-retry-vf1o2kud`；复跑命令见commands.json。新修复本地verified、待独立复审；Ticket03/all16仍partial，历史删除/视觉/candidate/双宿主等OPEN。
