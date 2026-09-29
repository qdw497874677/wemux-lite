# R2 Linux Worker 安装器验收（部分）

## 已实现

- 下载 Worker tgz 与同源 manifest，按长度、SHA-256 比对后才执行 npm；HTTPS 下载禁止降级到 HTTP。SHA-256 仅检测损坏和版本错配，同源 HTTP 的完整性不提供来源认证，也不是独立签名。
- 默认 `WEMUX_INSTALL_MODE=managed`：Node >=22.13/npm、运行中的 `systemd --user` manager 预检；以 tgz hash 命名隔离 release，在 staging 内 `npm install --ignore-scripts` 并验证 CLI；注册凭据存于 Worker home 而不在 release；原子切换 `current`、安装用户服务并进行 `is-active` 轮询，失败时恢复旧指针和旧 unit；安装锁避免两个安装并发。
- `WEMUX_INSTALL_MODE=global` 是显式旧模式，只有前台进程且不能宣称部署完成。`WEMUX_INSTALL_ROOT`、`WEMUX_WORKER_HOME` 可自定义绝对路径。相同包重跑不重新注册，已注册 home 升级无需再提供 Token。首次启动由 `WEMUX_ENROLLMENT_TOKEN` 和 `WEMUX_WORKER_NAME` 供给；Token 不写入 unit，注册完成后 Worker home 中 credential 权限由 Worker CLI 管理。

## 验证与边界

```bash
node --import tsx --test --test-name-pattern='managed installer|installer downloads|serves an installer' apps/server/src/test/server.test.ts
WEMUX_MANAGED_PACKAGE_E2E=1 node --import tsx --test apps/e2e/managed-worker-package.test.ts
# 真实 Chromium 操作实际 Server Web 的手动 Preset；需预先构建 apps/web/dist
WEMUX_MANAGED_PACKAGE_E2E=1 WEMUX_REAL_PACKAGE_WEB_E2E=1 \
  node --import tsx --test apps/e2e/managed-worker-package.test.ts
# 付费真实模型，仅操作者显式提供已有凭证和已开通模型时执行；不保存凭证
# 可同时加 WEMUX_REAL_PACKAGE_WEB_E2E=1 串联真实 Web 与真实模型
WEMUX_MANAGED_PACKAGE_E2E=1 WEMUX_REAL_PACKAGE_PI_E2E=1 \
  WEMUX_REAL_PI_AGENT_DIR=/path/to/pi/agent \
  WEMUX_REAL_PI_MODEL='provider::model' \
  node --import tsx --test apps/e2e/managed-worker-package.test.ts
# 完整组合：从空 Worker Agent 选择开始，由 Web Preset 安装固定官方 Pi，重启后通过
# Worker home 内的托管 Pi 完成真实模型 Turn；仅借用操作者的 npm 内容缓存与显式 Pi 凭证
WEMUX_MANAGED_PACKAGE_E2E=1 WEMUX_REAL_PACKAGE_WEB_E2E=1 \
  WEMUX_REAL_PACKAGE_MANAGED_PI_E2E=1 WEMUX_REAL_PACKAGE_PI_E2E=1 \
  WEMUX_REAL_PI_AGENT_DIR=/path/to/pi/agent WEMUX_REAL_PI_MODEL='provider::model' \
  node --import tsx --test apps/e2e/managed-worker-package.test.ts
npm run typecheck
```

2026-09-29 最终隔离测试 3 pass、0 fail，覆盖 HTTP manifest、坏 hash 拒绝且不执行 npm、nc 隧道、版本化安装、身份复用、systemd unit 语法校验、启用失败与进程健康检查失败回滚；日志位于 `/tmp/r2-installer-managed-final.log`。根 `npm test` 独立复跑通过：Node 测试 823 pass、0 fail、5 skip，另外 9 个 package 测试与 Web 测试 280 pass、0 fail，日志位于 `/tmp/r2-installer-all-final.log`。资源收敛的真实 Server + 两 Worker 进程测试独立复跑 1 pass，日志位于 `/tmp/r2-installer-resource-e2e-final.log`；`npm run typecheck` 和 Server build 通过。新增实际 tgz 测试后的全量复跑：Node 829 测试、823 pass/0 fail/6 skip（新增用例默认跳过），package 9 pass，Web 280 pass，日志位于 `/tmp/r2-managed-package-full-test.log`。另于 2026-09-29 复跑 `apps/e2e/managed-worker-package.test.ts` 1 pass、0 fail（最新 `/tmp/r2-real-managed-preset-final.log`）：真实 Server 提供 tgz 与 manifest，真实 npm 安装发布包、CLI 注册、打包 Worker 上线；经 Server API 发布静态 Skill、手动应用 Preset，断言打包 Worker 的物化文件与应用投影 `installed/ready`；停进程并观察 Server 离线，撤去注册 Token 后重装，确认同一 Worker 身份重新上线、credential 未变、没有第二个同名节点、Skill 文件和 ready 投影均保留。仅 `systemctl` 使用进程桩，因为当前沙箱没有可访问的 `systemd --user` manager。此用例默认跳过，须先构建 `artifacts/wemux-lite-worker.tgz`、有可访问的 npm 依赖源和缓存，再显式设环境变量运行。真实用户级 manager 的登录、开机重启及断线自动恢复尚未验收。另于 2026-09-29 以已开通模型 `my-codex::gpt-6-sol` 与本机 Pi 凭证显式复跑付费分支，1 pass、0 fail（`/tmp/r2-packaged-pi-final-recheck.log`）：打包安装、注册、Preset/Skill ready、停机重装同身份后创建 Project/Workspace/Session，Pi 在固定 Skill 启动目录读取 `SKILL.md`，模型回复匹配校准标记且 Turn 为 completed；完整测试也另以非付费分支复跑 1 pass（`/tmp/r2-packaged-preset-after-pi.log`）。所有临时数据库和 home 在测试后删除，日志不含凭据/原始响应。2026-09-29 组合复跑浏览器和付费模型分支 1 pass、0 fail（`/tmp/r2-real-web-pi-combined-final2.log`），以及默认非浏览器非付费分支 1 pass、0 fail（`/tmp/r2-real-package-default-after-browser.log`）：真实 Chromium 从生产 `/cluster` 页面发布 Preset、确认应用到打包 Worker、Server 验证 ready、重连后固定 Skill 被 Pi 读取且完成真实模型回复。浏览器使用现成 Chromium/Playwright 缓存而非 npm 自动安装，仍只有 systemctl 进程桩。2026-09-29 再以 `WEMUX_REAL_PACKAGE_MANAGED_PI_E2E=1` 组合复跑 1 pass、0 fail（`/tmp/r2-managed-pi-web-real-turn3.log`，104 秒），从空 Worker Agent 选择出发：Web 同一 Preset 分配静态 Skill + 精确官方 Pi 制品；真实 npm 安装、包 hash 与版本校验后报告 `restart-required`，运行中的 Worker 选择仍为空；停机重装模拟重启，确认选择位于临时 Worker home 的托管 Pi，两个资源投影均 `installed/ready`，固定 Skill 被托管 Pi 读取并得到真实模型回复。为降低网络耗时仅共享操作者 npm 内容缓存，未复制凭证；Pi 认证目录由操作者显式传入。非付费默认分支及全量 typecheck 再次通过（`/tmp/r2-managed-pi-default-regression.log`、`/tmp/r2-managed-pi-final-typecheck.log`）。首次组合调试因隔离 HOME 阻断 npm 缓存而长时间卡在安装阶段，曾在 `/tmp` 保留失败现场，已清理。

## 尚未验证/已知限制

- `systemctl --user is-active` 检测进程活跃，不保证 Worker 成功登录 Server 或完成第一个 WebSocket 握手；本用例另从 Server 核对在线，但使用进程桩而非真实 manager。没有真实用户服务、机器重启后的持续在线证据时不声称完成裸机部署。
- release 包的依赖由 npm registry 安装，即使禁用 npm lifecycle scripts 仍需要信任其依赖分发；当前没有离线签名/透明证明、依赖离线镜像与平台兼容 manifest。
- 本测试可选组合已串联临时 home 的打包安装、真实浏览器 Web 手动 Preset、静态 Skill + 官方 Pi runtime 物化、手动停机重装后的激活及有权限模型 Turn。模型认证仍依赖操作者显式提供的现有 Pi 凭证；尚未串联真实用户级 systemd manager、由用户服务自动重启及机器重启后恢复。这仍是 R2 完整裸机验收的剩余工作。
