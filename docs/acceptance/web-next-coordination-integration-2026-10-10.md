# 协调受控切片：本次集成复核（2026-10-10）

状态：**部分实现；票 01/02 均未验收，票 03 前置未解除，协调入口仍固定 FAIL**。本记录覆盖 `integration/web-next-coordination-closure` 的 `5d99ee9`；不是 OS 文件/网络隔离证明，也不是部署者书面残余风险接受。未运行付费 Runtime，未删除用户数据，未执行开门操作。

## 合并范围

- `43ae6da`：Connector 注册显式区分本地与集群来源，集群来源在落盘前校验持久 Session/Workspace/Turn 和 Server grant 身份；`connector.identity` 不以 `session.info` 扩大权限，验证请求拒绝重定向。本地 Workbench 在已入群 Worker 上仍走独立本地身份。Server 尚不能证明 grant 签发时的 Worker 和当前 Turn，见 `docs/design/coordination-grant-freshness-gap.md`。
- `da8a180`：MCP discovery 和调用在可能启动 stdio Connector 前请求保守写风险审批；重复发现每次使用新的审批身份，审批后复核授权和 revision。这是平台网关的部分控制，不保证原生 Runtime 工具无宿主文件/网络访问。
- `971ca36`：同进程 Worker Session 所有权按真实 home 规范化；claim 前预留，未决子进程或终态写入未确认时保持栅栏；关闭旧 Runtime 后可由同进程替代 Runtime 用重新打开的 store 补终态，不重启 Agent；修正了串行数据库事务中测试等待造成的死锁。不是跨进程锁或重启后子进程退出证明。
- `00f86fd`、`5d99ee9`：修复合并后的测试夹具，分别显式提供受信任本地来源、模拟不同 Session 的持久绑定；普通身份到达 MCP 审批并被拒，协调身份仍被 scope 拒绝，不借测试假阳性声称授权完整。

## 同候选验证

- `npm run build:packages`、Server/Worker/Web typecheck：退出码 0（`/tmp/wemux-coordination-build-packages.log`、`/tmp/wemux-coordination-typecheck-*.log`）。
- Worker 原始 Node 汇总：`509` tests，`504` pass，`5` skipped，`0` fail（`/tmp/wemux-worker-after-gate-fixture.log`）。命令包装器同时打印 `FAIL: 1 failed`，与 Node 汇总不符；以原始汇总为范围描述，不宣称包装器全绿。
- Server：`TMPDIR=/home/qdw/.cache/wemux-test-tmp node --import tsx --test --test-concurrency=1 --test-reporter=tap src/test/*.test.ts`（从 `apps/server` 运行）得 `936` pass、`0` fail（`/tmp/wemux-server-serial-home-tmp.log`）。默认并行、`/tmp` tmpfs 路径下运行出现 `ERR_SQLITE_ERROR` / `disk I/O error`，且 600 秒截断日志无最终汇总；切换非 tmpfs 临时目录并逐文件串行后复核，不能把截断日志说成通过。
- 实际 Server + 入群 Worker + 非付费 Test Agent 传输用例 `apps/e2e/coordination-command-transport.mjs`：三项通过（合法签名 enqueue、无签名注入拒绝、撤权后排队 Turn 同 home 恢复不启动；`/tmp/wemux-coordination-integration-transport.log`）。未覆盖所有命令类别或完整浏览器验收。

## 后续阻塞

1. 票 01：能力 grant 需绑定签发 Worker、Server 权威的当前 Turn 生命周期，而非滞后 Journal；否认审计仍为 best effort，`actor` 字段也不是可信操作者。需要原始签发/恢复/撤权/终态的纵向测试。
2. 票 02：除 `session.enqueue` 外的有副作用命令与恢复路径尚未普遍签名并在线复核；`runtime.approval.resolve` 分支的健康连接临时失败重投、已发送签名过期/顺序屏障仍在隔离工作树验证，**未合并**。同进程所有权不覆盖多进程或旧子进程存活。
3. 旧队列、生产备份对账和轮换按票 02 的开发期边界另行设计；不得静默补签旧帧或跳过 transport 顺序。人工风险接受与开门仍未获得。

`apps/server/src/application/coordination-gate.ts` 保持 `verdict: 'FAIL'`；本记录不勾选上述票据验收项。
