---
phase: 01-existing-core-closure
plan: '02'
status: completed-locally
requirements: [NEXT-01]
---

# 01-02 执行摘要：新版入口收敛

对照票 01 九条标准完成逐条候选前核证，详细边界见 `docs/acceptance/web-next-entry-login-projects.md`。操作迁移账本、逐 Runtime 盘点与 Paperclip 固定 commit/MIT 许可已核实；未知能力仍归后续票。修复 pending 项目读取期间退出按钮误禁用和过期/失败 OAuth 返回后导航历史同步；补 late-response/logout 单测、移动与桌面浏览器交互及滚动恢复。受控脚本增加明确的 teams/tasks 响应，只对注入的身份过期及 pending 退出请求作有界诊断识别，不忽略其他请求异常。

执行记录：`npm run typecheck --workspace @wemux/web-next`、`npm run build --workspace @wemux/web-next` 通过；显式 Playwright 配置后 Next 166/166，安全 sentinel 2/2；受控 Chromium 桌面/手机 7 组通过、零未预期异常，结果和截图 `/tmp/wemux-phase1-ticket01-controlled7/`。失败配置尝试和原因亦在验收文档。`git diff --check` 通过。本计划只完成可在当前环境证明的局部入口基线，**不是票 01 签收**。

仍开放：冻结同一候选包在既有实例的身份/hash、当前真实获权账号登录/退出/获权列表/TTL、桌面手机深链及失败分支复验、独立审查；没有部署或凭据授权不得以 fixture 冒充。统一候选与五票人工签收归 01-11。
