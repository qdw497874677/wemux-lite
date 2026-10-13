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
- [ ] 手机视口两阶段上传 E2E 退出码记录入库
- [ ] 附件投递失败后的用户路径明确（重投或引导重建），E2E 断言
- [ ] coordination-command-transport e2e 连续多次首跑稳定或抖动有检测与重试
- [ ] apps/web 全量测试在本机可运行且通过（无硬编码绝对路径）
- [ ] 第 6 项重构若实施：行为不变，全量套件绿

## Comments

### 2026-10-13 第 1 项：断言过期补签（分支 `t05-resign`，TDD 红→绿）

设计取向：服务端补签而非降级。新增 `ServerService.refreshPendingCommandAuthorization`：先走 `authorizeEnqueueLaunch` 在线复核（主体 active 且 authVersion 一致、会话/工作区权限仍满足、Worker 未撤销、摘要与受众一致），通过后以原领域身份重签（同 commandId，仅更新 issuedAt/expiresAt）；存储层新增 `refreshCommandAuthorization`（拒绝任何身份字段变动，签名不可洗白）。网关在有界投递唤醒与重放阶段对过期非审批命令帧先补签再投递；已发送未被 Worker 处理的过期帧原位替换（同 directionSeq/messageId）；重签被拒时按原始字节投递，由 Worker 终态拒收（诚实失败，拒绝后果沿用票据 02 语义）。审批命令保持原 `refreshPendingApproval` 通道不变。撤销类 `turn.stop` 重签同样要求操作主体仍 active，主体停用即 fail-closed（残余：已排队 Turn 不被截停，已在验收文档写明）。无 ACK 驱动的重签，无忙循环风险。

UI：`TeamCoordination.tsx` 文案改为“Worker 当前离线，恢复后自动续签投递；账号或权限失效时会改为失败并显示原因”，组件浏览器验收同步更新断言。文档：`docs/acceptance/command-frame-authorization.md` 已知限制一节改写为补签后的真实行为。

验收证据（本机，日志退出码在 `/var/tmp/t05-*.log`）：红→绿 `apps/server/src/test/command-assertion-refresh.test.ts` 9/9（重签身份保持、窗口内不重复签发；主体停用/Worker 撤销/会话删除负例；篡改不洗白；turn.stop 主体停用 fail-closed；审批通道回归；传输层屏障与原位替换单测；真实 WS 重连重签投递；已发送未处理帧原位替换重投；拒绝后终态回执落库）。全量 `@wemux/server` / `@wemux/worker` 套件绿；`npm run build:packages` / `npm run typecheck` 0 错误；组件浏览器验收 `TeamCoordinationAttachments.test.mjs` 1/1、`TeamCoordination.test.mjs` 1/1。
