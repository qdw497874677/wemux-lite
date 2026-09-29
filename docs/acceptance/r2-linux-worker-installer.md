# R2 Linux Worker 安装器验收（部分）

## 已实现

- 下载 Worker tgz 与同源 manifest，按长度、SHA-256 比对后才执行 npm；HTTPS 下载禁止降级到 HTTP。SHA-256 仅检测损坏和版本错配，同源 HTTP 的完整性不提供来源认证，也不是独立签名。
- 默认 `WEMUX_INSTALL_MODE=managed`：Node >=22.13/npm、运行中的 `systemd --user` manager 预检；以 tgz hash 命名隔离 release，在 staging 内 `npm install --ignore-scripts` 并验证 CLI；注册凭据存于 Worker home 而不在 release；原子切换 `current`、安装用户服务并进行 `is-active` 轮询，失败时恢复旧指针和旧 unit；安装锁避免两个安装并发。
- `WEMUX_INSTALL_MODE=global` 是显式旧模式，只有前台进程且不能宣称部署完成。`WEMUX_INSTALL_ROOT`、`WEMUX_WORKER_HOME` 可自定义绝对路径。相同包重跑不重新注册，已注册 home 升级无需再提供 Token。首次启动由 `WEMUX_ENROLLMENT_TOKEN` 和 `WEMUX_WORKER_NAME` 供给；Token 不写入 unit，注册完成后 Worker home 中 credential 权限由 Worker CLI 管理。

## 验证与边界

```bash
node --import tsx --test --test-name-pattern='managed installer|installer downloads|serves an installer' apps/server/src/test/server.test.ts
npm run typecheck
```

2026-09-29 最终隔离测试 3 pass、0 fail，覆盖 HTTP manifest、坏 hash 拒绝且不执行 npm、nc 隧道、版本化安装、身份复用、systemd unit 语法校验、启用失败与进程健康检查失败回滚；日志位于 `/tmp/r2-installer-managed-final.log`。根 `npm test` 独立复跑通过：Node 测试 823 pass、0 fail、5 skip，另外 9 个 package 测试与 Web 测试 280 pass、0 fail，日志位于 `/tmp/r2-installer-all-final.log`。资源收敛的真实 Server + 两 Worker 进程测试独立复跑 1 pass，日志位于 `/tmp/r2-installer-resource-e2e-final.log`；`npm run typecheck` 和 Server build 通过。当前沙箱没有可访问的 `systemd --user` manager，无法在此以真实 manager 验证 service 启动与断线恢复；隔离测试通过假 systemctl 断言交互，真实机器验收必须补做。

## 尚未验证/已知限制

- `systemctl --user is-active` 检测进程活跃，不保证 Worker 成功登录 Server 或完成第一个 WebSocket 握手；节点页应再核对在线与能力。没有重启后的持久在线证据时不声称完成裸机部署。
- release 包的依赖由 npm registry 安装，即使禁用 npm lifecycle scripts 仍需要信任其依赖分发；当前没有离线签名/透明证明、依赖离线镜像与平台兼容 manifest。
- 测试未串联干净 Linux 安装 → Web Preset → 托管 Agent runtime → 固定 Skill 注入 → 有权限真实模型 Turn；该链路是 R2 完整验收的剩余工作。
