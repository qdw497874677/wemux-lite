# R3 真实 Pi 对隔离 HTTPS 假模型单 Turn

本切片使用本机已安装的 Pi CLI，而不是 Agent 桩。`apps/e2e/pi-provider-https-offline.test.ts` 在 loopback 启动临时自签名 HTTPS OpenAI-compatible endpoint，临时 CA 仅由 `NODE_EXTRA_CA_CERTS` 信任，测试用合成密钥只放入 Pi 子进程环境。Pi 通过隔离 `PI_CODING_AGENT_DIR` 加载 `models.json`，向假模型 POST `/v1/chat/completions`、带 `Authorization: Bearer <test key>`，接收 SSE 并完成一次文本 Turn（`offline-answer`）；随后同一测试在真实 `WorkerRuntime` 命令链中创建隔离 Workspace/Session、通过私有 Provider resolver 再完成一条 Pi Turn，Journal 为 `completed`、文本精确匹配且无测试密钥，native Session 不写入 Worker store。断开 Provider 后第二条请求失败，假模型请求数保持 2，不复用已撤权子进程。子进程退出后不留下 Provider 配置目录。

先红：私有 Pi 进程没有继承本机 HTTPS CA 信任链而失败；仅新增 `NODE_EXTRA_CA_CERTS` 环境透传（不继承 Worker 其余认证变量）后 1/1 通过（`/tmp/pi-provider-runtime-real-revoked.log`）。可复跑：`WEMUX_OFFLINE_PI_EXECUTABLE=$(command -v pi) node --import tsx --test apps/e2e/pi-provider-https-offline.test.ts`，需 Node ≥22.13、openssl、现成 Pi CLI；默认 `npm test` 跳过此环境依赖用例。

本测试没有调用公网或付费模型，也没有经过真实 Server Session 创建/Worker 能力宣告。它证明受限配置/私有密钥与真实 Pi RPC 可从 WorkerRuntime 完成离线模拟 Turn；资源 `credential-required` 与实际模型 ready 仍是两回事。后续须确认受信网络与模型探测、按 Project/Worker 宣告能力、双 Worker 真实资源投影和撤权端到端。扩展后完整 `npm test` Node 866 tests / 858 pass / 0 fail / 8 skipped、package 10 pass、Web 291 pass（`/tmp/pi-provider-runtime-real-full.log`）；`npm run typecheck` 通过（`/tmp/pi-provider-runtime-real-typecheck.log`）。
