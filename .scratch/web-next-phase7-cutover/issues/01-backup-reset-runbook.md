# 01: 备份与重置 runbook 及恢复演练

**What to build:** 一份可重复执行的 runbook：成组停服、按范围备份与重置 Server 与 Worker 应用数据/身份/传输状态，并在重置前完成一次恢复演练；范围明确排除外部仓库、工作区源码与 Agent 全局认证。

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [ ] runbook 参数化目标实例、路径与凭据，破坏性步骤标为人工确认点
- [ ] 备份与重置范围逐项枚举，明确排除项
- [ ] 成组停服与恢复顺序明确
- [ ] 恢复演练完成并留证据（备份可还原、实例可用）
- [ ] 失败时停在安全状态，不留半重置实例
- [ ] 日志与输出可复查，摘要入库
