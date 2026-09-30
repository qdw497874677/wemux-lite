# R3 Pi Provider 私有 Runner 入口（局部完成）

`WorkerAgentRunner.runWithPiProvider` 是 Worker 受信进程的私有入口：拒绝非 Pi、native Session resume、缺失或错误模型/环境；受限 Provider 定义与本 Turn 密钥值的不可逆 hash + 不含明文的凭据 stamp 纳入 Session 子进程复用键。密文轮换、环境变量原地变化或 endpoint/模型定义变化会先关闭旧进程，再开新进程。Provider native Session 引用不写入通用 SessionStore，不返回公共 Runner stream。

防止 Agent/adapter 从错误、工具输出、流事件回显密钥：私有模式统一错误文案，缓冲单 Turn 最多 1 MiB 的信号并跨字符串检查 Secret；不安全则只发布失败事件，无部分响应。已用假 Adapter 验证错误和事件密钥不进入内存 SessionStore 或结果。

边界：**此入口尚未与 `WorkerRuntime` 的集群控制路径接线**；没有把 Provider 凭据发给 Server/Web/通用 `RunRequest`，也未验证真实 Pi 模型/计费 Turn。`ResourceReconciler` 仍仅报告 `credential-required`。最初定向测试 `apps/worker/test/agent-runner.test.ts` 11/11 pass（`/tmp/private-runner-definition-green.log`）；又发现 environment locator 原地更换时旧子进程被复用，补红绿测试并改为包含当前密钥 hash；修复后 `apps/worker/test/agent-runner.test.ts` 11/11 pass（`/tmp/private-runner-final-unit.log`）；完整 `npm test` Node 859 tests / 852 pass / 0 fail / 7 skipped、package 10 pass、Web 291 pass（`/tmp/r3-private-runner-env-full-test.log`），`npm run typecheck` 通过（`/tmp/r3-private-runner-env-typecheck.log`）。
