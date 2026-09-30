# R3 Pi Provider 离线配置目录验证（部分）

`apps/worker/src/providers/pi-provider-directory.ts` 只生成 Pi 0.87.1 已验证的**无秘密**模型目录：单一 `openai-compatible` HTTPS endpoint、单一模型、仅 `pi` Agent、单一 `OPENAI_API_KEY` 环境变量；`models.json` 固定 `openai-completions`、`apiKey: "$NAME"`，不接受任意 `api`、命令或 header。目录权限 0700、文件 0600；调用方必须调用 `cleanup()`，且不得把密钥写入此目录。此切片明确**不复制用户 `auth.json`、扩展、skills 或 settings**，所以不是透明继承已有 Pi 环境；尚未连接 WorkerRuntime 子进程启动或 ResourceReconciler 的绑定选择。

`apps/worker/test/pi-provider-directory.test.ts` 用假 Pi 验证隔离目录、配置内容、环境中的测试值、双次清理、用户原 auth 不变、坏配置不留临时目录（2/2 通过，`/tmp/pi-provider-directory-red-green.log`）。本地以 Pi 0.87.1 在隔离 `PI_CODING_AGENT_DIR` 中执行 `get_available_models`，返回 `openai-completions` 的合成模型；目标域名不可解析，未执行 prompt 或计费模型探测。可重复脚本 `apps/e2e/pi-provider-offline.test.ts`：显式运行 `WEMUX_OFFLINE_PI_EXECUTABLE=/absolute/path/to/pi node --import tsx --test apps/e2e/pi-provider-offline.test.ts`，1/1 pass（`/tmp/pi-provider-offline-test-final.log`）；只证明配置可被 Pi 读取，不证明认证或真实模型响应。`npm run typecheck` 通过（`/tmp/pi-provider-directory-typecheck.log`）。

后续的**实施门槛**：将该目录严格绑定到一个授权 Session 的 Pi 子进程生命周期；在启动前/下一 Turn 重验期望态和凭据 revision，轮换/撤销终止旧进程而非复用；只给目标进程传指定 key，处理 Worker 通用 `process.env` 中其他密钥，选择允许明确隔离、不继承用户 Pi 配置的产品策略；验证退出与异常清理、模型探测及经明确计费授权的真实 Turn。未完成这些时 Provider 仍是 `credential-required`，不能声称 ready。完整设计见 `docs/design/r3-pi-provider-process-materialization.md`。
