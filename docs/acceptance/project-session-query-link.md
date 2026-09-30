# Project 查询会话链接回归

修复 `/projects/:projectId?session=:sessionId` 被误报“路径与查询参数冲突”。项目根路径未指定 Session/Workspace 时允许查询补充选择，先验证资源存在、权限和父级归属，再重定向到规范 Session/Workspace 路径；真正的路径与查询矛盾仍拒绝。`view=canvas` 保留为 overview 画布选择，不丢失会话。

回归 `apps/web/tests/workbench-routing.test.mjs`：项目根路径带 Session/Workspace、画布视图、跨项目、缺失/无权限及冲突参数。修复前稳定失败；Web 全部294测试通过，Web构建（含类型检查）通过，日志 `/tmp/project-link-tests.log`、`/tmp/project-link-build.log`。

已部署8010固定实例，真实Chromium以新账号打开用户报告的原链接，确认重定向到指定Session、会话界面渲染、刷新仍正常，无冲突提示。截图 `/tmp/wemux-project-link-fixed.png`。原Worker重连online；未改资源或用户数据。
