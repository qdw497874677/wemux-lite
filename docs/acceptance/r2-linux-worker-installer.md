# R2 Linux/macOS Worker 安装器验收（部分）

## 已实现

- 下载 Worker tgz 与同源 manifest，按长度、SHA-256 比对后才执行 npm；HTTPS 下载禁止降级到 HTTP。SHA-256 仅检测损坏和版本错配，同源 HTTP 的完整性不提供来源认证，也不是独立签名。
- 默认 `WEMUX_INSTALL_MODE=managed`：Node >=22.13/npm、Linux `systemd --user` 或 macOS 已登录用户 `launchd` GUI domain 预检；以 tgz hash 命名隔离 release，在 staging 内 `npm install --ignore-scripts` 并验证 CLI；注册凭据存于 Worker home 而不在 release；原子切换 `current`、安装用户服务并检查进程，失败时恢复旧指针和旧 unit/plist；安装锁避免两个安装并发。macOS LaunchAgent 仅在 GUI 用户登录后启动，不宣称注销后常驻。
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

## 真实 Linux 用户服务验证（部分，2026-09-29）

在经操作者授权的局域网 Linux x86_64 主机上，以普通用户 `qdw`（Node v26.8.2、npm 11.19.1、真实 `systemd --user` running）进行隔离验收；Server 是当前执行机的临时实例，不是该 Linux 主机。临时 Server 向主机供应 tgz 和注册凭据；安装器下载、校验 SHA-256、安装依赖并在自定义 Worker home/release root 内注册。`systemctl --user is-active` 为 active，Server `/api/workers` 从另一台机器确认同一 Worker 在线。

- 临时 Server 创建 Project、Workspace、Session，跨机 Test Agent Turn 完成且 Journal 追赶 `synced`，回复精确为 `Echo: linux service turn`。这是**Test Agent**，不是 Pi 或付费模型证明。
- 手动应用静态 Skill Preset，Server 投影 `installed/ready`；Worker 物化 `resources/skills/<resource>/revisions/<revision>/SKILL.md` 的 SHA-256 与发布 blob 一致。停机后无注册 Token 重跑安装，同一 Worker ID、一个 Server 节点、Skill ready 保留。
- 真实 `systemctl --user restart` 后重连；对主进程发 `SIGKILL`，用户 manager `Restart=on-failure` 自动拉起并在 Server 再次 online。检测了 unit 复用、无明文 Token。退出后停止/disable 临时 unit，清除自定义 Worker home 与 release root，关闭临时 Server；远端普通用户其他进程与数据未动。
- **未通过托管 Pi 物化的实机验证**：远端同时存在操作者的另一条全局 npm 安装；固定官方 Pi 资源第一次拉取/安装超时并报告 `Runtime process exited with SIGTERM`，第二次下载/解包成功但测试用 Worker 被手动重启，不能据此声称 Pi 已 `restart-required`、激活或完成真实模型 Turn。临时运行目录、资源绑定已移除；与 Test Agent 会话成功严格区分。需要在无并行大规模 npm 安装的窗口重新完整验证，并添加安装/重启竞争的回归测试。机器重启后登录用户 manager 的持续在线、真实浏览器手工 Preset 与失败回滚仍待验证。

## macOS Worker 前置探测与模拟验证

2026-09-29 经 SSH 仅做只读检查：一台经操作者授权的目标机器是 Darwin/arm64、UID 501、`launchctl print gui/501` 成功，Home 剩余约 47 GB；**PATH 中未找到 node 和 npm**，未安装、未注册、未修改远端。Server 不运行在此机器，此地址定位为待部署 Worker。新增安装器 Darwin 分支的本地 Linux 桩测试：`launchctl` 用户域检查、plist 参数转义、重复安装不重注册、bootstrap/无存活 PID 回滚、外来 plist 拒绝覆盖；`node --import tsx --test --test-name-pattern 'installer downloads|serves an installer|managed installer' apps/server/src/test/server.test.ts` 3 pass，最终单测日志 `/tmp/mac-install-foreign-plist.log`，完整 `npm test` 为 Node 839 tests / 833 pass / 0 fail（其余跳过）、package 10 pass、Web 290 pass（`/tmp/mac-support-full-test.log`）；`npm run typecheck`、Server build 通过。模拟不等于真实 macOS 安装/重启验证；后者须先由操作者配置 Node >=22.13/npm、确认目标 Server 和安装目录，再进行。

## 尚未验证/已知限制

- `systemctl --user is-active` 检测进程活跃，不保证 Worker 成功登录 Server 或完成第一个 WebSocket 握手；早期本地 tgz 用例另从 Server 核对在线，但使用进程桩；上述局域网主机验收已补充真实用户 manager 的安装、重启、SIGKILL 自动恢复和远端 Server 在线证据（未做主机重启）。2026-09-29 再检查当前沙箱：PID 1 为 `entrypoint-cust`，无 `/run/user/10000` 和用户 bus，`systemctl --user is-system-running` 返回 `offline`，`loginctl show-user` 提示 `System has not been booted with systemd as init system (PID 1). Can't operate.`；因此这里不能伪造真实用户 manager 验收。有真实用户服务与进程故障恢复证据，但没有机器重启后的持续在线证据，不声称全量裸机部署验收完成。
- release 包的依赖由 npm registry 安装，即使禁用 npm lifecycle scripts 仍需要信任其依赖分发；当前没有离线签名/透明证明、依赖离线镜像与平台兼容 manifest。
- 本测试可选组合已串联临时 home 的打包安装、真实浏览器 Web 手动 Preset、静态 Skill + 官方 Pi runtime 物化、手动停机重装后的激活及有权限模型 Turn。模型认证仍依赖操作者显式提供的现有 Pi 凭证；另一次局域网实机验收已经串联真实用户级 systemd manager 与服务自动重启，但尚未在该机器上成功完成托管 Pi 安装/真实模型 Turn，也未验收机器重启后恢复。这仍是 R2 完整裸机验收的剩余工作。
