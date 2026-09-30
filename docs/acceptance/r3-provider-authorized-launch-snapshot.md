# R3 Worker 内部 Provider 启动快照（局部）

`ResourceReconciler.piProviderForLaunch(projectId, modelId)` 建立仅在 Worker 内消费的受权快照：先按 Project/Agent/model 精确选择已发布非秘密 binding，再按 locator 读取 Worker 本地变量或独立加密 owner；`worker-credential` 连带不可逆密文指纹（包含 revision、字段列表、密文）以区别轮换/撤权与删后重建。解析前后检查期望态连接 epoch、revision、fingerprint、binding 身份和本机 credential 指纹，竞争时 fail closed；Server resource、report、SQLite `resources.sqlite` 不存环境变量值。这个返回值含原始密钥，只准 WorkerRuntime 的可信代码使用，不能序列化给 Web/Server/Journal。

`apps/worker/test/resource-reconciler.test.ts` 定向覆盖 Project 优先级、冲突、密文轮换、失联、解析过程中同步轮换与不泄露；`npm run typecheck` 通过（`/tmp/pi-provider-snapshot-typecheck-final.log`）；完整 `npm test` Node 856 tests / 849 pass / 0 fail / 7 skip、package 10 pass、Web 291 pass（`/tmp/pi-provider-snapshot-full-test.log`）。**尚未与生产 WorkerRuntime / Pi Session 接线，未做实际模型探测或付费请求**；即使 selector 能返回 Secret，Reconcile 投影仍为 `credential-required`。
