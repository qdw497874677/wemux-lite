# R3 Provider 资源进入预设（部分）

集群管理员的「节点预设」现可选择已发布的 `model-provider` revision，必须选兼容的 Agent；确认应用时明确提示只下发非秘密配置，凭据需在 Worker 本地录入或预置环境变量，`credential-required` 不代表模型已可用。与 Skill/托管 runtime 同样使用既有 CAS、手工应用和回滚状态投影，不自动调用模型。

真实 Chromium 对生产构建 Web（由本机隔离 Server 提供、API 交互桩）验证：错误 Agent 被拒、正确 Pi 加入含 Skill 的 Preset、发布 v1/v2、确认弹窗显示本地凭据提示、CSRF/手工应用 CAS、非管理员不显示入口；脚本 `apps/e2e/resource-preset-browser.mjs`，日志 `/tmp/provider-preset-browser.log`，截图/结果 `.scratch/r2-presets/preset-studio.png` 与 `.scratch/r2-presets/browser-result.json`。此脚本的 API 为浏览器交互桩，不是 Provider 真正部署或模型认证。`npm run build --workspace @wemux/web`、`npm run typecheck --workspace @wemux/web` 通过；完整 `npm test` Node 868/860 pass/0 fail/8 skip、package 10/10、Web 291/291（`/tmp/provider-preset-full-test.log`）。

仍缺完整可视化 Provider 资源创建与不可变 revision 发布入口，及真实 Provider 模型探测/ready。不要用预设 UI 成功替代上述验收。
