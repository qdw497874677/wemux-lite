# 协调命令授权票 02：启动前复核与进程内所有权部分证据

状态：**部分实现，不构成票 02 验收或协调入口开门依据**。候选 `integration/web-next-coordination-closure` 的 `3fad5fd` 合并 `fix/coordination-prelaunch` 至 `d5a4fe7`。前一部分签名 `session.enqueue` 链路见 `docs/acceptance/web-next-coordination-ticket02-partial.md`。

## 已验证的受控范围

- 对已 claim 的集群 Turn，在会话启动环境准备、Provider 解析后及首次读取 Agent iterator 前重新在线复核；复核失败不开始首次读取，Turn 留失败终态并释放执行位。收到显式 stop 与在线复核的并发时优先保留取消状态。新增失败原因 `authorization_unavailable`，避免误报 Provider 故障。
- 不确定的 iterator 读取、停止或释放保持 Session 隔离；清理逐项有界尝试。运行于同一 Worker 进程、使用同一 `ClusterLifecycle`/home 的本地与集群 Runtime 共享进程生命周期所有权栅栏，不能靠有界 shutdown 或 `abort()` 假定旧子进程已退出。`WorkerAgentRunner` 直接调用在释放期也拒绝重入。测试覆盖延迟准备/Provider、stop 并发、未决读取、Runtime 替换及有界 shutdown。
- 同一合并候选：`npm run build:packages` 与 Server/Worker build、Server/Worker/Web typecheck 通过；Worker Node 测试 `485` 项中 `480` 通过、`5` 跳过、`0` 失败（`/tmp/wemux-prelaunch-merge-worker-test.log`）；Server `935/935`（`/tmp/wemux-prelaunch-merge-server-test.log`）；实际 Server + 已入群 Worker + 无付费 Test Agent 的传输 E2E 三项通过（`/tmp/wemux-prelaunch-merge-e2e.log`）。两个 `npm test` 工具包装器输出 `FAIL: 1 failed`，与原始 Node `fail 0` 汇总不一致，本摘要只报告可核对的 Node 汇总及 E2E 退出码。测试生成的 `apps/server/.scratch/` 单个未跟踪文件已清理，未入库。

## 仍有明确缺口

- 复核响应和真正启动不是跨进程原子操作，最终 HTTP 响应后仍可发生撤权竞态；准备/Provider hook 在后续复核之前可能有自身副作用。仅 `session.enqueue` 具签名链路，其他集群副作用命令、provision 恢复未收口。
- 所有权栅栏仅进程内：`apps/worker/src/application/session-ownership.ts` 按未规范化的 home 字符串分组，同一实际目录的不同路径拼写或另一个 Worker 进程不共享；Worker 进程重启后旧子进程存活仍未验证。取回栅栏还依赖 Runtime Adapter 成功 stop/release 兑现子进程退出合同。竞争 Runtime 可能在另一方占用前 claim 并把合法排队 Turn 失败化。不得将有界 shutdown 表述为已证明物理子进程终止。
- 旧 Server outbox 的无签名 enqueue 顺序屏障仍可阻塞后续帧；签名收帧五分钟有效期、在线复核有限重试及失败后的可用性另需处置。拒绝审计、结果读取及票 01 工具授权缺口见前述证据文档。

`apps/server/src/application/coordination-gate.ts` 仍固定 `FAIL`，票 01/02 未完成、票 03 前置门未解除、票 04 人工残余风险接受及开门未经授权。L1 的环境作用域不是 OS 文件/网络隔离；本轮未清理用户数据或调用付费 Runtime。
