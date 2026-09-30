# R3 非秘密 Provider 资源发布界面（部分）

集群管理员现可从「节点预设」创建 OpenAI 兼容 / 隔离 Pi / 单模型的 `model-provider` 资源及不可变 v1 revision，再将它加入 Preset。表单只接受名称、HTTPS endpoint、模型 ID、本机凭据引用；生成严格的 `inline-config` 和 SHA-256 manifest，API 仍按 Server repository 验证内容 hash。浏览器不会收集或传输密钥值；`worker-credential` ID 仅在 Worker 本地录入密钥。失败时保留已创建的资源，用户可重试，但当前 UI 尚不支持为同一资源再次发布 v2。

真实 Chromium 浏览器验收使用隔离本机 Server 提供生产 Web、拦截 API 提供可重复交互桩：创建资源/发布 revision、只包含非秘密字段、错误 Agent 被拒、预设发布 v1/v2、确认/CSRF/CAS、非管理员门禁。运行 `npm run build --workspace @wemux/web && node apps/e2e/resource-preset-browser.mjs`，结果 `/tmp/provider-publish-browser.log`、`.scratch/r2-presets/browser-result.json` 与截图；Web helper 行为测试 2/2（`/tmp/provider-publish-unit.log`）、`npm run typecheck --workspace @wemux/web`（`/tmp/provider-publish-typecheck-final.log`）、完整 `npm test` Node 868/860 pass/0 fail/8 skip，package 10，Web 293（`/tmp/provider-publish-full-test.log`）。这不是实机 Provider 认证或模型 ready 证据。

后续必须补 Provider 更新 revision/CAS、真实 Worker ready 验证/权限失效和双 Worker E2E；无计费授权不得自动发真实模型请求。
