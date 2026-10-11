# 05: 协调闭环 review 跟进（断言补签、重试语义与测试环境修复）

Status: needs-triage
Blocked by: 无（02 已 done；本票是 integration/web-next-coordination-closure 全量 review 后的遗留项收敛，非功能门）。

**来源:** 2026-10-12 integration 分支双轴 code-review（Standards + Spec）。P0/P1 级发现（`commandAuthority` 未接线导致停用账号停不掉在跑 Turn、v3 审批刷新 409、验收文档失实）由 t02-review-fixes 分支即时修复，不入本票；本票只收推迟项。

**What to build / verify:**

1. **断言过期补签或明确失败语义。** `SIGNATURE_WINDOW_MS`（5 分钟）过后，pending 的 `session.create`/`session.enqueue` 断言过期：worker 入口拒收（authorization_expired）、server `deliverable()` 不再投递，当前无补签路径。需要为长离线 worker 设计重签（重验主体活跃/权限后重发）或把失败终态如实呈现给用户，并同步修正 UI "恢复后自动继续"（`apps/web-next/src/components/TeamCoordination.tsx`）只在该窗口内成立的文案。02 已声明旧命令补签/迁移范围外，本票针对当前版本可用性，不是旧数据迁移。
2. **上传的手机视口 E2E。** 票据 04 手机项勾选所据脚本不含上传链路；补手机视口两阶段上传验收。
3. **投递失败后的重试语义。** 附件投递 failed/revoked 后同 requestId 重放只回放失败 Session，无法原意图重投；要么支持重投，要么 UI 明确引导换新上传。
4. **e2e harness 偶发时序抖动。** `apps/e2e/coordination-command-transport.mjs` 首跑曾在 setup 超时（`Timed out: real session.create receipt`），复跑 3 次全绿；加连接静默失效检测或重试。
5. **apps/web 4 个环境性测试失败。** `base-ui-coexistence`/`command-palette`/`plan-card`/`project-query-rendered` 硬编码另一台机器的 playwright npx 缓存与 chromium-1243 绝对路径；改用 `channels.browser.mjs` 的 `PLAYWRIGHT_MODULE` 环境变量模式。
6. **Standards 判断题级重构（可择机合并处理，不单开门）：** 签发降级逻辑三处同形（`team-service.ts`/`account-lifecycle-service.ts`/`connector-service.ts`）应并入 `command-assertion-issuer.ts` helper；`ASSERTION_REQUIRED_COMMAND_KINDS` 与 `WORKER_COMMAND_KINDS` 同值拷贝；`WorkerService` 构造第 8 参裸布尔、`ServerService` 8 个位置可选参 → options 对象；`attachmentViewRecord` 死参；`server-service.ts` 幂等重放 `listSessions()` 全表扫 → 索引化；`runtime.ts` `provisionLaunchRetries` 与 `launchRetries` 两套重试共享调度器；`actorField` 三元在 server 与 worker 两处重复。

## 验收

- [ ] 长离线（>5 分钟）场景有明确终态：补签后正常投递，或用户可见的诚实失败与恢复路径，UI 文案与行为一致
- [ ] 手机视口两阶段上传 E2E 退出码记录入库
- [ ] 附件投递失败后的用户路径明确（重投或引导重建），E2E 断言
- [ ] coordination-command-transport e2e 连续多次首跑稳定或抖动有检测与重试
- [ ] apps/web 全量测试在本机可运行且通过（无硬编码绝对路径）
- [ ] 第 6 项重构若实施：行为不变，全量套件绿

## Comments
