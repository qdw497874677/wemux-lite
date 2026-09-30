# R3 Worker 本地 Provider 凭据（局部完成）

此切片提供 Worker 信任域内独立的 `model-provider` 凭据 owner、SQLite `provider_credentials` 密文表（schema v5）、AES-GCM `enc:v2` 与登录/CSRF 保护的本地 JSON API；后续已接通 Server `worker-credential` **非秘密 locator** 和 Worker 可解密检查（见 `docs/acceptance/r3-worker-credential-locator.md`），但仍不能把凭据注入 Agent 或宣称模型 ready。

- `GET /api/local/providers/credentials` 只返回 id、环境变量名、revision、`available|unavailable` 与本机加密能力；`PUT /api/local/providers/credentials/:id` 接收 `{variableNames,secret,expectedRevision}`，`DELETE` 接收 `{expectedRevision}`。写入 CAS，返回不含 Secret/ciphertext。`WEMUX_CONNECTOR_ENCRYPTION_KEY` 是本机密钥，`WEMUX_CONNECTOR_ENCRYPTION_PREVIOUS_KEYS` 仅用于解读旧密文；无 key 时 Worker 本身仍可启动，但本地 Provider 写入/解密 fail closed。密钥必须由受信任服务环境注入，不能提交至配置仓库。
- 危险边界：接口只对本地管理员开放，跨来源、Cookie、CSRF 与请求体上限沿用已有本地控制面；集群 Server、资源 revision、wire、report、日志不传输 Secret。字段仅允许声明的 1–4 个 Provider Key 名称（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`AZURE_OPENAI_API_KEY`），每个值非空、≤64 KiB；禁止 PATH/HOME/NODE_OPTIONS/PI_CODING_AGENT_DIR 等进程控制变量；`model-provider` owner 的认证上下文不能作为 `connector` 解密，测试用明文 codec 在此拒绝。
- 回归：`npm run build:packages`、`npm run typecheck`、`npm test`；完整输出 `/tmp/provider-local-full-test-final.log`（Node 843 tests / 837 pass / 0 fail / 6 skipped，package 10 pass，Web 290 pass），Provider 定向 `/tmp/provider-cred-rotation2.log`、本地 HTTP `/tmp/provider-local-http-test.log`。旧 schema v1 迁移到 v5 的测试断言已更新。

后续已实现 `worker-credential` locator 的非秘密配置和 Worker 自检；仍须实现 per-Agent/Session 最小启动环境注入、模型清单验证与撤权。environment/worker-credential 两种 locator 均只报 `credential-required`。这份文档不是双 Worker 真实模型验收证据。
