# R3 未验证模型候选 Web 展示（局部）

Project 快速对话界面在选定 Worker/Agent 后使用项目、节点双权限的 `/api/workers/:workerId/projects/:projectId/provider-candidates?agentKey=...`；模型列表仅增加不可选项，明确显示“已绑定，尚未验证模型与凭据；暂不可用于对话”。与 Worker Agent 自身已报告的模型 ID 重复的候选不重复展示，已报告模型仍可选择；不以候选覆盖其授权状态。空结果、断线或 403 不阻断既有 Agent 模型或默认模型的选择；客户端只处理非秘密 `modelId/resourceId/bindingId/status`，不得将候选当作 `ready` 或加入 Worker capabilities。

真实 Chromium + 生产 Web 构建的可重复脚本 `apps/e2e/provider-candidate-browser.mjs` 使用隔离 Server 及鉴权/资源 API 桩，检查 Project/Worker/Agent scoped 请求、候选按钮 disabled、状态说明、已有 Agent 模型仍可选且未因候选创建 Session；日志 `/tmp/provider-candidate-browser-final.log`。桩是 UI 行为验收，非真实模型探测。初版 `npm run typecheck` 通过（`/tmp/provider-candidate-web-typecheck.log`）；完整 `npm test` Node 867 tests / 859 pass / 0 fail / 8 skipped，package 10 pass、Web 291 pass（`/tmp/provider-candidate-web-full-test.log`）。重复候选过滤后生产 Web 构建与 Chromium 复验通过（`/tmp/provider-candidate-dedupe-build.log`、`/tmp/provider-candidate-dedupe-browser.log`）。
