# R2 Agent runtime 物化切片验收

范围：固定官方 npm 制品、CLI 与资源层共用安装器、期望态绑定、Worker 安装及下次手工重启的激活/探测/回滚。**本切片不等于 R2 完成**：自动受控重启、Linux Worker managed installer/用户级服务、Preset UI、真实有凭证的模型 Turn 仍待后续切片验收。

## 边界与状态

- Server 仅接受实例管理员管理的不可变 runtime revision；绑定必须给定匹配的 Agent key，禁止 Project 范围。期望态携带 registry artifact 信息，Worker 本地目录再次校验官方包名、精确版本、registry 和固定 SHA-512；拒绝任意 URL、脚本和未批准的包。
- CLI `agent install` 与 Resource adapter 共用安装代码：`npm pack --ignore-scripts` 到独立目录，验证预期文件名、128 MiB 大小上限和制品字节 SHA-512，再从本地 tgz `npm install`。安装前不更改当前选择；失败时仅清理新目录。安装后的 package manifest/bin 和精确 `--version` 再校验。
- Resource adapter 安装成功仅报告 `restart-required`；运行中的 Session 不热切。Worker **下次手工启动**前，根据已持久化的期望态和 Worker 身份，切换到新可执行文件并保留先前的完整选择。Agent 能力探测成功才报告 `ready`；缺少模型凭证报告 `credential-required`；探测失败恢复原选择、重建 adapters 并将该 revision 标记失败，避免循环重启。失败的同一 revision 不自动重试，新 revision 可再物化。
- 老版 Worker 对 runtime artifact 的 wire 帧不兼容，必须先升级 Worker；目前其他平台和自动重启未经验证，不能宣称支持。

## 可复查验证

- `npm run build:packages && npm run typecheck`：通过。
- `npm run build --workspace @wemux/server && npm run build --workspace @wemux/worker`：通过。
- `npm test`：TypeScript 823 项（818 通过、5 跳过）、packages 9/9、Web 280/280；无失败。
- `node --import tsx --test apps/worker/test/runtime-management.test.ts apps/worker/test/resource-reconciler.test.ts`：34/34；覆盖坏 hash、不可信元信息、不一致 manifest/bin/version、原选择保留、回滚、身份隔离、模型凭证缺失、重启探测与 ready。
- `node --import tsx --test apps/e2e/resource-reconcile.test.ts`：真实 Server + 两个 Worker 进程通过（约 106 秒）。完成 Skill 双节点分发/离线追赶后，Server 向 Worker 2 分配 Pi 官方 runtime revision；真实 registry 下载、安装、报告 `restart-required`，运行中 Agent 选择不变。随后手动重启 Worker 进程，检测到受信任选择并上报 `ready` 或 `credential-required`（依宿主机认证状态）。证据 `.scratch/r1-stage4/resource-reconcile-e2e.txt` 与 `/tmp/r2-runtime-e2e.log`。**此测试不声称模型 Turn 成功，也不代表干净 Linux 安装链路。**
- 真实 registry 实测（隔离临时目录）：`npm pack --json --ignore-scripts -- @earendil-works/pi-coding-agent@0.85.1` 生成 `earendil-works-pi-coding-agent-0.85.1.tgz`，计算 SHA-512 与固定值 `sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==` 一致；通过 `installAgent()` 真实下载、安装并获得 `0.85.1` 可执行入口。原始输出：`/tmp/wemux-r2-real-install.log`；临时安装 home 已清理。

## 残余风险与下一步

缺少 Worker managed installer/自动服务排空重启、下载并发/磁盘预算、端到端真实模型凭证；npm 下游依赖仍受 npm 解析和 registry 影响，固定的顶层包 hash 不等于完整依赖树锁定。下一切片实现 Preset（手工应用、自动应用默认关闭）及节点进度，再完成干净 Linux 安装到真实 Session 的验收；未通过前不能宣称 R2 裸机闭环。
