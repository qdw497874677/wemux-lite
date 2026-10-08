# 01: 备份重置 runbook、恢复演练与干净实例验收

Status: ready-for-human
Blocked by: [Phase 6 阶段签收](../../web-next-phase6-migration-closure/issues/03-authz-matrix-acceptance.md)、[Phase 1 外部服务](../../web-next-phase1-external-gates/issues/01-real-external-services.md)、[Phase 1 复审与运行时](../../web-next-phase1-external-gates/issues/02-visual-runtime-acceptance.md)；NEXT-01–15 全部通过，目标实例与每个破坏性步骤获人工确认。

**Spec:** [备份、重置、切根与旧版删除](../spec.md)
**合并来源:** `43966aa` 的原票 01、02。
**What to build:** 交付参数化的成组停服、备份、恢复及重置 runbook，先完成恢复演练，再在获确认的干净实例执行全链路验收。Agent 只准备脚本、清单与证据，不代为执行真实破坏性操作。合并两票不合并或跳过人工确认点。

## runbook 与恢复演练

- [ ] runbook 参数化目标实例、路径与凭据，破坏性步骤标为人工确认点
- [ ] 备份与重置范围逐项枚举，明确排除项
- [ ] 成组停服与恢复顺序明确
- [ ] 恢复演练完成并留证据（备份可还原、实例可用）
- [ ] 失败时停在安全状态，不留半重置实例
- [ ] 日志与输出可复查，摘要入库

范围排除外部仓库、工作区源码与 Agent 全局认证；恢复演练未通过不得重置。

## 干净实例验收（恢复演练通过、重置获确认后）

- [ ] 干净实例上完成注册、邮件验证、登录
- [ ] Worker 入群并可对话
- [ ] 协调会话可用（Phase 2 门通过后）
- [ ] 计划批准与交接可用
- [ ] 协作界面与双宿主流程可用
- [ ] 截图与断言输出留档，脱敏摘要入 `docs/acceptance/`
- [ ] 未过项如实标注并回到对应阶段处理

本票通过后仍不可直接切根或删旧版；须进入独立 [02](02-go-no-go-cutover.md) 人工 go/no-go。
