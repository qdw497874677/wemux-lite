# R3 Pi Provider 集群 Turn 守卫（局部）

Worker 内部 `WorkerRuntime` 已将受权 Provider 快照接入私有 Pi Runner，**仅对集群中的 `pi` + `openai-compatible::model` Session**：启动前拒绝本地 Workspace、无连接或未收敛期望态、缺少 binding/凭据、已有 native Session resume；从 `ResourceReconciler.piProviderForLaunch` 获取仅在 Worker 信任域存在的密钥和不可逆凭据指纹，不写入通用 RunRequest、Session Journal、Server 或 Web。私有 Pi 子进程管理器与普通 Pi 分离；本地凭据写入/轮换/撤销、资源变更通知及传输断线立即失效并强杀私有进程。重新连接需资源收敛后才能开始新的 Turn，跨连接解析不接受旧结果；运行时 `set_model` 不允许切入或切出该 Provider。通过假 Pi Adapter/真实 WorkerRuntime 本地命令链验证执行、Session Journal 无秘密、模型切换拒绝、断线后失败与重连使用新凭据、普通 Pi 不被强杀；不是在线模型探测。

限制：**Worker 原生能力清单尚不包含这类绑定模型**；Server 创建 Session 会校验 Worker 广播的模型，所以目前不能通过 Server Web 正常选择并创建此模型 Session。对外能力宣告、实际 Pi 隔离子进程与网络模型探测、撤权中途 Turn 终止时序、双 Worker 真实模型验证必须作为下一切片完成。不要把这个内部运行时测试当作 Provider ready 或付费模型证明。完整 `npm test`：Node 865 tests / 858 pass / 0 fail / 7 skipped，package 10 pass、Web 291 pass（`/tmp/r3-provider-runtime-full-test.log`）；`npm run typecheck` 通过（`/tmp/r3-provider-runtime-typecheck.log`）。
