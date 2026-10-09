# 01: 备份重置 runbook、恢复演练与干净实例验收

Status: ready-for-human
Blocked by: runbook 及隔离副本恢复演练可先准备；真实干净实例验收需 [迁移全链路验收](../../web-next-migration-closure/issues/03-authz-matrix-acceptance.md)、[真实外部服务](../../web-next-external-gates/issues/01-real-external-services.md)、[独立视觉复审与真实运行时](../../web-next-external-gates/issues/02-visual-runtime-acceptance.md)；NEXT-01–15 全部通过，需求基线 D5 已确认新增范围全部通过相应验收，目标实例与每个破坏性步骤获人工确认。

**Spec:** [备份、重置、切根与旧版删除](../spec.md)
**合并来源:** `43966aa` 的原票 01、02。
**What to build:** 交付参数化的成组停服、备份、恢复及重置 runbook，先完成恢复演练，再在获确认的干净实例执行全链路验收。Agent 只准备脚本、清单与证据，不代为执行真实破坏性操作。合并两票不合并或跳过人工确认点。

## 执行计划

1. 先交参数化停服/备份/恢复 runbook，在隔离副本演练；列 Server/Worker 库、身份、outbox、预约及在途执行，不含外部源码/全局认证。
2. 恢复使用[命令授权票](../../web-next-coordination-closure/issues/02-command-frame-authorization.md)提供的受控对账启动方式，先禁止 Agent/工具/provisioning 执行及 outbox 发送，再对账 Worker 实际执行。能力未提供时只做离线检查，不以普通启动或断网代替；确认解除后旧备份不复活旧执行权或重复派发，演练失败停止后续操作。
3. 按已确认 D5 核验全部前置后，人工逐项确认目标实例和重置范围，跑干净实例全链路；付费/外发仍各自授权。
4. 留可复查日志并交 02 go/no-go，不自动切根。

## runbook 与恢复演练

- [ ] runbook 参数化目标实例、路径与凭据，破坏性步骤标为人工确认点
- [ ] 备份与重置范围逐项枚举，明确排除项
- [ ] 成组停服与恢复顺序明确
- [ ] 恢复演练完成并留证据（备份可还原、实例可用）
- [ ] 对账解除前 Agent/工具/provisioning 进程启动与外发均为零，本地与集群初始化均覆盖
- [ ] 失败时停在安全状态，不留半重置实例
- [ ] 日志与输出可复查，摘要入库

范围排除外部仓库、工作区源码与 Agent 全局认证；恢复演练未通过不得重置。

## 干净实例验收（恢复演练通过、重置获确认后）

- [ ] 干净实例上完成注册、邮件验证、登录
- [ ] Worker 入群并可对话
- [ ] 协调会话可用（协调入口资格门通过并获人工开门授权后）
- [ ] 按需计划批准与获权交接可用；D5 纳入的新能力逐项验证
- [ ] 协作界面与双宿主流程可用
- [ ] 截图与断言输出留档，脱敏摘要入 `docs/acceptance/`
- [ ] 未过项如实标注并回到对应 spec/ticket 处理

本票通过后仍不可直接切根或删旧版；须进入独立 [02](02-go-no-go-cutover.md) 人工 go/no-go。
