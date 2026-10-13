# 05: 协调闭环 review 跟进（断言补签、重试语义与测试环境修复）

Status: needs-triage
Blocked by: 无（02 已 done；本票是 integration/web-next-coordination-closure 全量 review 后的遗留项收敛，非功能门）。

**优先级（2026-10-12 主会话排定）：** 第 1、2、5 项现在做（断言过期补签是可用性/诚实性缺口；手机上传 E2E 与 apps/web 环境修复便宜且解除本机验证阻塞）；第 3、4 项挂起（症状偶发/可绕）；第 6 项机会性处理不单开门。

**来源:** 2026-10-12 integration 分支双轴 code-review（Standards + Spec）。P0/P1 级发现（`commandAuthority` 未接线导致停用账号停不掉在跑 Turn、v3 审批刷新 409、验收文档失实）由 t02-review-fixes 分支即时修复，不入本票；本票只收推迟项。

**What to build / verify:**

1. **断言过期补签或明确失败语义。** `SIGNATURE_WINDOW_MS`（5 分钟）过后，pending 的 `session.create`/`session.enqueue` 断言过期：worker 入口拒收（authorization_expired）、server `deliverable()` 不再投递，当前无补签路径。需要为长离线 worker 设计重签（重验主体活跃/权限后重发）或把失败终态如实呈现给用户，并同步修正 UI "恢复后自动继续"（`apps/web-next/src/components/TeamCoordination.tsx`）只在该窗口内成立的文案。02 已声明旧命令补签/迁移范围外，本票针对当前版本可用性，不是旧数据迁移。
2. **上传的手机视口 E2E。** 票据 04 手机项勾选所据脚本不含上传链路；补手机视口两阶段上传验收。
3. **投递失败后的重试语义。** 附件投递 failed/revoked 后同 requestId 重放只回放失败 Session，无法原意图重投；要么支持重投，要么 UI 明确引导换新上传。
4. **e2e harness 偶发时序抖动。** `apps/e2e/coordination-command-transport.mjs` 首跑曾在 setup 超时（`Timed out: real session.create receipt`），复跑 3 次全绿；加连接静默失效检测或重试。
5. **apps/web 4 个环境性测试失败。** `base-ui-coexistence`/`command-palette`/`plan-card`/`project-query-rendered` 硬编码另一台机器的 playwright npx 缓存与 chromium-1243 绝对路径；改用 `channels.browser.mjs` 的 `PLAYWRIGHT_MODULE` 环境变量模式。
6. **Standards 判断题级重构（可择机合并处理，不单开门）：** 签发降级逻辑三处同形（`team-service.ts`/`account-lifecycle-service.ts`/`connector-service.ts`）应并入 `command-assertion-issuer.ts` helper；`ASSERTION_REQUIRED_COMMAND_KINDS` 与 `WORKER_COMMAND_KINDS` 同值拷贝；`WorkerService` 构造第 8 参裸布尔、`ServerService` 8 个位置可选参 → options 对象；`attachmentViewRecord` 死参；`server-service.ts` 幂等重放 `listSessions()` 全表扫 → 索引化；`runtime.ts` `provisionLaunchRetries` 与 `launchRetries` 两套重试共享调度器；`actorField` 三元在 server 与 worker 两处重复。

## 验收

- [x] 长离线（>5 分钟）场景有明确终态：补签后正常投递，或用户可见的诚实失败与恢复路径，UI 文案与行为一致
- [x] 手机视口两阶段上传 E2E 退出码记录入库（2026-10-12 `t05-mobile-upload-e2e` 新增 `apps/e2e/team-coordination-attachments-mobile.mjs`：playwright-core 真实 Chromium 手机视口 390×844（isMobile/hasTouch）走完整两阶段上传——选文件 → 阶段一 Server 有界收件 + 协调 Task/Session 原子绑定 + Worker 离线「待投递/恢复后自动继续」如实呈现 + 不虚构首条消息 → 阶段二 Worker 重启后 UI 轮询翻转为「已投递」且工作区落盘 sha256 字节精确 → 同一手机会话 read-file 回显 sha256/size → 刷新恢复同一 Task 历史；裸跑（缺 env）exit 1 by design；同候选连续两次 exit 0，merge main tip（6deb365）后复跑仍 exit 0，原始 JSON 日志在 `/var/tmp/wemux-t05b-evidence/attachments-mobile-run{1,2,3-merged}.log`，不入库）
- [x] 附件投递失败后的用户路径明确（引导重建，不重投），E2E 断言（2026-10-14 `t05-attachment-retry`：失败意图重放只回放失败记录不复活；同文件新 requestId 重传畅通且端到端落盘成功，失败历史保留；UI 明确引导 + 一键「原文件重新上传（新请求）」，组件浏览器用例与 e2e 断言见 Comments）
- [x] coordination-command-transport e2e 连续多次首跑稳定或抖动有检测与重试（2026-10-14 分支 `t05-e2e-jitter`：代理审计已认证 WS 链路生命周期，投递等待期检测链路断开并给一次有界 60s 自愈预算，终态回执快速失败；连续 5 次独立首跑全部 exit 0，详见 Comments）
- [x] apps/web 全量测试在本机可运行且通过（无硬编码绝对路径）
- [ ] 第 6 项重构若实施：行为不变，全量套件绿

## Comments

### 2026-10-14 第 4 项：e2e harness 抖动检测与有界自愈预算（分支 `t05-e2e-jitter`）

**根因分析（读码，未复现原抖动）：** `Timed out: real session.create receipt` 的等待路径是「`POST /sessions` 返回后轮询 `GET /commands/:id` 直到 `accepted`」，固定 30s 预算。而传输层对链路断开的自愈是按设计的：Worker 退避重连（上限 30s）→ hello → outbox 重放 → 回执；Server 侧对静默死链的检测窗口为 15s ping 间隔 + 60s lastSeen 阈值（最长约 75s），Worker 侧 idle 45s。两个检测窗口都超过 30s 预算：setup 阶段一次链路抖动（含检测窗口内的静默失效）必然在自愈完成前被判成超时，复跑（无抖动）全绿，症状与票据记录一致。另原实现把「Worker 明确拒收」（rejected/failed/cancelled）也淹没在 30s 超时里，真实失败原因被吞。就绪信号本身完整（capability + placement ready 先于该等待），无启动竞态证据。

**修复（仅 harness，`apps/e2e/coordination-command-transport.mjs`，产品代码零改动）：**

1. `transportProxy` 审计已认证 WS 链路生命周期：`linkEvents`（upgraded/dropped 带时间戳）+ `liveLinks()` 存活计数，转发字节行为不变；
2. 新增 `waitForDelivery`：等待期间每 50ms 轮询链路活性，观察到断开（或存活链路归零）即给一次有界 60s 自愈预算（覆盖 30s 退避上限 + 重放），并打 `[ticket05]` 观测日志；终态回执立即快速失败带状态；到期失败带分类诊断（等待时长、链路 alive/dead、等待内断开次数、末次读数、Worker connectionState、链路事件表）；
3. 覆盖四个投递关键等待：provision placement ready、session.create receipt、echo enqueue receipt、revoke 场景 queued 回执；健康路径预算保持 30s 不放宽，不用延长等待掩盖真实故障。

**验证：** helper 逻辑探针 4/4（健康路径返回、断开后延长预算内自愈完成、无断开按基准预算分类超时、终态快速失败；探针在 `/var/tmp/wemux-t06b-probe/` 不入库）；连续 5 次独立首跑（每次全新 `/var/tmp/wemux-t06b-run{1..5}` TMPDIR）全部 exit 0 且 `status:pass`，日志 `/var/tmp/t06b-run{1..5}.log`（5 次均走健康路径，未触发断开观测）；positive/unsigned/revoke 三种隔离模式回归各 1 次全绿（`/var/tmp/t06b-{positive,unsigned,revoke}.log`）。

**残余风险：** 真正的半开死链（无 FIN/RST，loopback 基本不发生）最长需 Server 侧约 75s 才检测，30+60s 总预算覆盖典型重连场景；若未来复现为「链路存活但 >30s 未投递」，分类诊断会如实报出，届时按诊断深挖（不排除产品侧投递路径问题，本票未发现证据）。

### 2026-10-13 第 1 项：断言过期补签（分支 `t05-resign`，TDD 红→绿）

设计取向：服务端补签而非降级。新增 `ServerService.refreshPendingCommandAuthorization`：先走 `authorizeEnqueueLaunch` 在线复核（主体 active 且 authVersion 一致、会话/工作区权限仍满足、Worker 未撤销、摘要与受众一致），通过后以原领域身份重签（同 commandId，仅更新 issuedAt/expiresAt）；存储层新增 `refreshCommandAuthorization`（拒绝任何身份字段变动，签名不可洗白）。网关在有界投递唤醒与重放阶段对过期非审批命令帧先补签再投递；已发送未被 Worker 处理的过期帧原位替换（同 directionSeq/messageId）；重签被拒时按原始字节投递，由 Worker 终态拒收（诚实失败，拒绝后果沿用票据 02 语义）。审批命令保持原 `refreshPendingApproval` 通道不变。撤销类 `turn.stop` 重签同样要求操作主体仍 active，主体停用即 fail-closed（残余：已排队 Turn 不被截停，已在验收文档写明）。无 ACK 驱动的重签，无忙循环风险。

UI：`TeamCoordination.tsx` 文案改为“Worker 当前离线，恢复后自动续签投递；账号或权限失效时会改为失败并显示原因”，组件浏览器验收同步更新断言。文档：`docs/acceptance/command-frame-authorization.md` 已知限制一节改写为补签后的真实行为。

验收证据（本机，日志退出码在 `/var/tmp/t05-*.log`）：红→绿 `apps/server/src/test/command-assertion-refresh.test.ts` 9/9（重签身份保持、窗口内不重复签发；主体停用/Worker 撤销/会话删除负例；篡改不洗白；turn.stop 主体停用 fail-closed；审批通道回归；传输层屏障与原位替换单测；真实 WS 重连重签投递；已发送未处理帧原位替换重投；拒绝后终态回执落库）。全量 `@wemux/server` / `@wemux/worker` 套件绿；`npm run build:packages` / `npm run typecheck` 0 错误；组件浏览器验收 `TeamCoordinationAttachments.test.mjs` 1/1、`TeamCoordination.test.mjs` 1/1。

### 2026-10-14 第 3 项：投递失败后的重试语义（分支 `t05-attachment-retry`，选引导重建）

设计决策：选 b 引导重建，不提供重投。理由：(1) 上传创建的 Session 零内容（不虚构首条消息），重投能保留的东西为空；新 requestId 重传 = 同协调 Task 下新空 Session，零损失。(2) 现实失败以永久性为主（Worker 撤销、session.create 被拒致 Session 在 Worker 上不存在），重投命令根本无法覆盖，必须新会话/换环境。(3) 同 commandId 重投需洗白终态 rejected 命令（command() 对已有 rejection 抛 409），违反 command-frame-authorization 语义；新 commandId 重投诚实但严格劣于重传（服务面新增端点/命令面，收益为空）。(4) 新 requestId 重传路径服务端已具备（内容寻址 blob 去重、协调 Task 复用），真实缺口只在 UI 引导。

改动：`TeamCoordination.tsx` 投递失败态新增引导文案（`data-attachment-guidance="failed"`）+ 一键「原文件重新上传（新请求）」按钮（保留阶段一成功的 File，新 requestId=randomId()，不重放失败意图；环境失效时按钮不可用，用户改选下拉中仍在线的环境，与 taskSessionOptions 只列可用环境的诚实口径一致）。

验收证据（本机，日志在 `/var/tmp/t06a-*.log`）：红→绿组件浏览器用例 `apps/web-next/src/components/__tests__/TeamCoordinationAttachments.test.mjs`（失败引导呈现、一键重传用新 requestId 且复用原文件、终态后引导与按钮消失）；server 契约锁定用例 `apps/server/src/test/team-coordination-attachments.test.ts`「投递失败后的重建路径」（旧意图重放只回放失败记录、新 requestId 同文件重传创建独立新投递且失败历史不改写）；真实整链 `node --import tsx apps/e2e/team-coordination-attachments.mjs` exit 0：撤权失败后注册第二个 Worker + 新工作区，同文件新 requestId 重传端到端 delivered 且落盘 sha256 一致，失败附件保持 failed。merge main tip（3b81f72，第 4 项）后全量复验绿：build:packages / typecheck / @wemux/server 978 / @wemux/worker 527+5 skipped / web-next 浏览器套件 169 / 三个协调 e2e 全 exit 0。顺手修复：`apps/e2e/team-coordination-attachments-mobile.mjs` 断言的离线文案自第 1 项（e1274e6）改写为「恢复后自动续签投递」后未同步，在 main 上即失败（非本项回归），已更新断言与当前文案一致并复跑 exit 0。
