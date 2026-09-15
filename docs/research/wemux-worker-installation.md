# Wemux Worker 发布与安装方式调研

> 调研对象：`/opt/data/profiles/scribe/workspace/wemux-slim`
> 调研日期：2026-09-13
> 范围：只读源码、脚本、compose 与公开文档；未在 `wemux-slim` 中修改文件，也未实际安装、配对或升级 Worker。

## 1. 核心结论

当前 Wemux Worker 的正式交付模型不是“编译成原生单文件”，而是：

1. 从 monorepo 构造一个**可发布 npm 包目录**；
2. 包内含编译后的 Worker、Web Console、Node 启动脚本和生产依赖；
3. 正式安装器再将这个完整目录压成 `package.tgz`，由控制面的 `/install/*` 路由提供；
4. 目标机只需 Node.js 22+，不必 clone monorepo，也不必预装 npm/pnpm；
5. 安装后通过一次性 pairing code 注册，随后注册 systemd user service、macOS LaunchAgent 或 Windows 计划任务/启动项；
6. daemon 空闲时每 10 秒检查更新，下载新 tarball，经 SHA-256、staging smoke test、原子目录切换后重启。

因此，“能否独立于 monorepo 安装”的答案是：**能**。但独立安装仍依赖 Node.js 22+，正式产物是“自包含 Node 应用目录 + launcher”，不是一个完全静态的单 binary。

另有两条辅助路径：

- 仓库内开发：`pnpm dev:worker` 等；
- Docker：控制面提供 `/install/docker`，同时仓库有 compose profile 和 Docker helper。Docker 路径也无需在目标机 clone monorepo，但需拉取已发布镜像，且授予 Docker socket。

## 2. Package 名与 bin/CLI

### 2.1 源码仓库没有独立 Worker workspace package

根 package 名为 `wemux`、版本 `0.3.131`、`private: true`、要求 Node `>=20`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/package.json:2-14`。当前 `apps/worker` 下没有自己的 `package.json`；发布包由脚本动态生成。因此不能把源码仓库理解为可以直接执行：

```bash
npm install -g @wemux/worker
```

### 2.2 发布 package 名

发布脚本按 channel 生成 package：

```js
const packageName = readArg('--package-name', channel === 'preview' ? 'wemux-worker-preview' : 'wemux-worker')
const binName = packageName
```

见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs:25-29`。即：

- production：`wemux-worker`
- preview：`wemux-worker-preview`

生成的 package 是 `private: false`、Apache-2.0，并要求 Node `>=22`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs:35-57`。注意源码根项目只要求 Node 20，而**可安装 Worker 包要求 Node 22**。

### 2.3 bin 映射

生成 package 的 `bin` 为：

```js
bin: {
  vbx: './bin/vbx.mjs',
  vibemux: './bin/vibemux.mjs',
  wemux: './bin/wemux.mjs',
  [binName]: './bin/cli.mjs',
  [nodeWrapperBinName]: './bin/node-wrapper.mjs',
}
```

见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs:42-49`。production 因而提供 `wemux-worker` 和 `wemux-worker-node-wrapper`；preview 对应 `wemux-worker-preview` 和 `wemux-worker-preview-node-wrapper`。`vbx`、`vibemux`、`wemux` 是兼容入口。

launcher 设置 `WEMUX_CLI_NAME`、`WEMUX_RUNTIME_ROOT` 后加载 `dist-worker/apps/worker/src/index.js`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs:88-101`。主 `cli.mjs` 还带 entry-load self-repair：依赖损坏导致入口加载失败时，可从控制面重拉完整包，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs:102-128`。

### 2.4 CLI 命令

主 CLI usage 包含：

```text
wemux-worker daemon
wemux-worker open
wemux-worker connect --pairing-code <code> [--server-url <url>] [--name <name>] [--no-start]
wemux-worker disconnect
wemux-worker unpair
wemux-worker reset
wemux-worker status
wemux-worker check
wemux-worker doctor
wemux-worker update [--check] [--force]
wemux-worker service install|uninstall|start|stop|restart|status
wemux-worker service logs [--follow] [--lines N]
wemux-worker service supervisor
wemux-worker local
wemux-worker runtime smoke
wemux-worker mcp-stdio
wemux-worker mcp-connector-stdio
```

精确帮助文本见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/index.ts:312-357`。命令分派见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/index.ts:367-517`。

未配对 daemon 不会退出，而是进入 `unpaired` 状态并提示运行 `npx <package> connect --pairing-code <CODE>` 或使用本地 setup page，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/runtime/daemon.ts:956-967`。

## 3. npm/pnpm scripts 与构建链

根 scripts 中与 Worker 直接相关的入口包括：

```json
"dev:worker": "pnpm build:worker:console && ... tsx apps/worker/src/index.ts daemon",
"dev:worker:hybrid": "... WEMUX_CLOUD_URL=http://127.0.0.1:18989 ... daemon",
"dev:worker:preview": "... WEMUX_CLOUD_URL=https://wemux.xyz/ ... daemon",
"build:worker:console": "node scripts/build-worker-console.mjs",
"build:worker:runtime": "node scripts/build-worker-runtime.mjs",
"build:worker:installer": "node scripts/build-worker-installer.mjs",
"build:worker:preview-installer": "node scripts/build-worker-installer.mjs --channel preview",
"build:worker:npm": "... package-worker-npm.mjs",
"start:worker": "... dist-server/apps/worker/src/index.js daemon",
"worker:docker": "node scripts/run-worker-docker.mjs",
"worker:docker:dev": "node scripts/run-worker-docker-dev.mjs"
```

开发脚本精确值见 `/opt/data/profiles/scribe/workspace/wemux-slim/package.json:27-29`；构建、启动与 Docker scripts 见 `/opt/data/profiles/scribe/workspace/wemux-slim/package.json:70-88`。

### 3.1 `build:worker:npm`

`package-worker-npm.mjs` 动态生成 package.json、launchers、release metadata，再复制已构建的 `dist-worker`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs:35-82`、`/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs:130-199`。运行依赖显式包含 pi coding agent、MCP SDK、OpenCode SDK/wrapper、dotenv、simple-git 和 ws，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs:53-64`。

### 3.2 `build:worker:installer`

installer builder：

- 默认 channel 为 `preview`；
- production package 名为 `wemux-worker`，preview 为 `wemux-worker-preview`；
- package version 默认取根版本，preview 在 CI 有 commit SHA 时形成 `${rootVersion}-preview.${shortSha}`；
- 输出默认在 `dist-server/worker-installer`。

见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/build-worker-installer.mjs:13-36`。

它依次构建 runtime、console、npm package，随后在构建机上运行：

```bash
pnpm install --prod --no-frozen-lockfile --node-linker=hoisted
```

把生产依赖完整装进 package tree，目标机因此无需 npm，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/build-worker-installer.mjs:47-67`。

脚本会剔除 OpenCode 多平台大二进制、sourcemap 和部分 SDK TS 源码以控制体积，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/build-worker-installer.mjs:69-122`。最后生成 `package.tgz` 和 manifest，manifest 含 `packageName`、`packageVersion`、`binName`、`fileName`、`builtAt`、`commitSha`、`disableNpmUpdateCheck`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/build-worker-installer.mjs:124-144`。

## 4. 安装命令与控制面下载接口

README 给出的异机快速安装命令是：

```bash
curl -fsSL https://<server>/install | bash -s -- \
  --pairing-code '<PAIRING_CODE>' \
  --server-url 'https://<server>'
```

见 `/opt/data/profiles/scribe/workspace/wemux-slim/README.md:137-147`。命令由控制面 **Execution → Add Executor** 生成，Worker 不必与控制面同机，见 `/opt/data/profiles/scribe/workspace/wemux-slim/README.md:137-143`。

控制面暴露：

- `/install/worker/manifest.json`
- `/install/worker/package.tgz`
- `/install/worker.sh`
- `/install/worker.ps1`
- `/install`（Unix bootstrap）
- `/install.ps1`
- `/install/docker`

精确路由见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:1280-1362`。

`/install` 是很薄的 bootstrap：把 `${serverUrl}/install/worker.sh` 下载到临时文件并 `exec bash`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:288-302`。

### 4.1 Unix/macOS 主机安装

完整 shell installer 支持：

```text
--pairing-code <code>
--server-url <url>
--name <worker-name>
--install-root <path>
--no-start
```

参数解析与必填 pairing code 校验见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:947-1008`。默认安装根目录为 `${WEMUX_WORKER_INSTALL_ROOT:-$HOME/.local/share/wemux-worker}`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:923-934`。

安装器要求 `curl`、`tar`、`sha256sum`/`shasum`，并要求 Node 22+；Node 不足时给出 nvm v0.40.3 安装建议，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:1011-1056`。

它下载 manifest 与 `package.tgz`，校验 manifest 中的 SHA-256，然后解压至 release 目录；相关 URL 与下载校验逻辑见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:1074-1126`。之后切换 `current` symlink，创建用户 bin launcher，并调用 `connect --pairing-code ... --server-url ...`；安装完成后会输出 `status`、`service logs --follow`、`open` 等命令，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:1128-1228`。

### 4.2 Windows 安装

PowerShell installer 接受 `PairingCode`、`ServerUrl`、`WorkerName`、`InstallRoot`、`NoStart`，默认根目录 `%LOCALAPPDATA%\Wemux\worker`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:304-322`。它要求 Node 22+，下载 manifest/package，计算 SHA-256 并比较，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:389-451`。解压后切换 current junction，生成 `.cmd` launcher，再执行 `connect`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:453-560`。

## 5. 配置文件、目录和环境变量

### 5.1 配置模型

`WorkerConfig` 包含：

```ts
export type WorkerConfig = {
  executorId: string
  executorToken: string
  executorName: string
  cloudUrl: string
  workDir: string
  workerHome?: string
  hostAdvertiseAddress?: string
  hostAdvertisePort?: number
  dockerHostGateway?: string
  workerAccessUrl?: string
}
```

见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:28-39`。

默认 home 按包/channel 隔离：

- preview：`~/.wemux-preview`
- production：`~/.wemux`
- development：`~/.wemux-dev`

见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:78-95`。`WEMUX_WORKER_HOME` 可覆盖，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:97-103`。配置写在 `<home>/node/config.json`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:105-107`；保存时目录 `0700`、文件 `0600`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:123-141`。

默认 cloud URL 来自 release metadata，没有 metadata 时 preview 为 `https://wemux.xyz`、production 为 `https://wemux.ai`、development 为 `http://127.0.0.1:8989`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:157-168`。有效 URL 优先级是 CLI → `WEMUX_CLOUD_URL`/`WEMUX_SERVER_URL` → 已保存 config → 默认值，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:170-186`。

### 5.2 关键环境变量

| 变量 | 用途 | 来源 |
|---|---|---|
| `WEMUX_WORKER_HOME` | Worker 数据根目录 | `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:97-103` |
| `WEMUX_CLOUD_URL` / `WEMUX_SERVER_URL` | 控制面 URL | `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:170-186` |
| `WEMUX_WORKER_PORT` | 本地 Worker Console/API 端口 | `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:188-197` |
| `WEMUX_WORKER_PORT_PROFILE` | development/preview 等端口 profile | `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:188-197` |
| `WEMUX_WORKER_HOST` | 本地监听地址 | `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:245-247` |
| `WEMUX_WORKER_ACCESS_URL` | 控制面访问 Worker 的 URL | `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/core/config.ts:249-259` |
| `WEMUX_WORKER_INSTALL_PREFIX` | 当前安装根/更新切换边界 | `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/index.ts:53-85` |
| `WEMUX_RUNTIME_ROOT` | package runtime 根 | `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs:88-101` |
| `WEMUX_WORKER_EXECUTABLE_PATH` | 服务与升级使用的 launcher | `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs:168-171` |
| `VIBEMUX_WORKER_RESTART_STRATEGY` | `service`/`docker` 更新重启策略 | `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/update/worker-updater.ts:210-226` |
| `VIBEMUX_INSTALL_URL` | 更新源基础 URL | `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/update/worker-release.ts:196-202` |
| `VIBEMUX_WORKER_DISABLE_NPM_UPDATE_CHECK` | 禁用 registry update check | `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/update/worker-release.ts:88-93` |

兼容性上仍保留多处 `VIBEMUX_*` 旧前缀。Mini 不宜复制这种双命名债务，应尽早固定唯一前缀。

## 6. 注册与配对

控制面注册接口在 executor control plane routes 中：

- `POST /api/executors/pairing-codes`：为当前用户生成 code，默认 `expiresInMs: 10 * 60 * 1000`；
- `POST /api/executors/pair`：消费 code，创建/配对 executor；
- `POST /api/executors/register`：alias 到同一 pairing handler；
- `POST /api/executors/install-command`：同时创建 code 并生成当前 OS 对应安装命令。

见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/executor-control-plane-routes.ts:237-333`。pairing code 由 4 个随机字节转成 8 位大写 hex，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/control-plane/executor-registry.ts:95-95`。

Worker 的 `connect`：

- 需要 `--pairing-code`；
- 可接 `--server-url`、`--name`、`--no-start`；
- 请求 payload 带 pairing code、hostname、platform、arch、version、能力与 advertise 信息；
- 成功后保存 executor ID/token/name/cloud URL；
- 默认安装并启动系统服务，`--no-start` 时只配对。

见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/index.ts:148-262`。

`disconnect` 会先卸载服务、停止当前运行时，再调用云端解绑并清除本地配对；`unpair` 是 alias，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/index.ts:402-433`。`reset` 会额外清理本地配置，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/index.ts:435-443`。

## 7. systemd、launchd 与 Windows 守护运行

平台由 `createPlatformService(serviceName?: string): Promise<PlatformService>` 按 `darwin/linux/win32` 选择实现，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/service/service-factory.ts:8-25`。

### 7.1 Linux

Linux 使用 `~/.config/systemd/user/<serviceName>.service`，安装时：

- 写 unit；
- 尝试 `loginctl enable-linger`，确保 SSH 断开后 user service 持续；
- `systemctl --user daemon-reload`；
- enable，并按 `autoStart` 决定 restart。

见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/service/linux-service.ts:19-42`。unit 使用 `After/Wants=network-online.target`、`Type=simple`、绝对 ExecStart、可配置 restart/restart delay、显式环境变量，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/service/linux-service.ts:95-115`。日志封装 `journalctl --user -u ...`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/service/linux-service.ts:78-85`。

### 7.2 macOS

macOS 使用 `~/Library/LaunchAgents/com.wemux.<serviceName>.plist`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/service/macos-service.ts:18-32`。通过 `launchctl bootstrap/kickstart/bootout` 管理，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/service/macos-service.ts:50-85`。plist 包含 `RunAtLoad`、`KeepAlive`、`ThrottleInterval`、stdout/stderr 路径与环境变量，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/service/macos-service.ts:111-146`。

### 7.3 Windows

Windows 当前不是 `sc.exe` 服务，而是：

1. 优先注册 `\Wemux\` 下的 Scheduled Task（AtLogOn）；
2. 若需要管理员权限等原因失败，fallback 到用户 Startup 目录中的隐藏 VBS launcher；
3. supervisor 负责重启 Worker；计划任务通过 `conhost.exe --headless` 避免可见 console 及关闭窗口导致进程离线。

见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/service/windows-service.ts:31-45`、`/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/service/windows-service.ts:94-115`、`/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/service/windows-service.ts:117-149`。运行配置和日志放在 `%LOCALAPPDATA%\Wemux\services\<serviceName>`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/service/windows-service.ts:47-77`。

## 8. Docker 与 compose

### 8.1 compose 中的 Worker

`deploy/docker/docker-compose.dev-full.yml` 的 `worker` service 位于 `worker` profile，默认镜像 `${WEMUX_WORKER_IMAGE:-ghcr.io/wemux-ai/wemux-worker:latest}`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/deploy/docker/docker-compose.dev-full.yml:141-145`。环境变量包含 server URL、worker home/install prefix、host/port/access URL、restart strategy=`docker`、run mode=`docker`、install URL 和 pairing code，见 `/opt/data/profiles/scribe/workspace/wemux-slim/deploy/docker/docker-compose.dev-full.yml:149-165`。

容器挂载 named volume `/data/wemux-worker`，并挂载 `/var/run/docker.sock`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/deploy/docker/docker-compose.dev-full.yml:166-168`。healthcheck 请求本地 `/api/health`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/deploy/docker/docker-compose.dev-full.yml:177-181`。

### 8.2 Docker 安装脚本

控制面的 `/install/docker` 脚本要求 Docker daemon 可用、pairing code 非空，然后拉取 `WEMUX_WORKER_IMAGE`（默认 GHCR latest），见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:173-213`。它以 host network、restart unless-stopped 启动容器，挂载持久目录和 Docker socket，并传入 `VIBEMUX_PAIRING_CODE`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:214-246`。

仓库 helper `scripts/run-worker-docker.mjs` 默认使用同一 compose 文件、service=`worker`、server URL=`http://server:8989`，可由 `WEMUX_PAIR_CODE`/`VIBEMUX_PAIRING_CODE` 提供配对码，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/run-worker-docker.mjs:26-38`。没有 pair code 时会尝试从 compose volume 的 `node/config.json` 判断是否已经配对；否则拒绝启动，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/run-worker-docker.mjs:98-128`。

**安全关注**：Docker Worker 具备 Docker socket，等价于对宿主机非常高的控制权。Mini 若采用这一方案，必须在 UI 和文档中明确提示，不能把它包装成普通低权限容器。

## 9. 升级方式

### 9.1 用户命令

CLI 支持：

```bash
wemux-worker update --check
wemux-worker update
wemux-worker update --force
```

分派见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/index.ts:454-488`。`--check` 只查询；普通模式无更新时退出；`--force` 即使版本相同也启动更新。

### 9.2 更新源

`checkForWorkerUpdate()` 优先用自托管 installer manifest；`VIBEMUX_INSTALL_URL` 可指定基址，默认使用已配置 cloud URL，manifest 为 `/install/worker/manifest.json`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/update/worker-release.ts:194-229`。若自托管检查失败，再尝试 npm registry；preview package 固定 `dist-tag=latest`，production 先读 `stable`，没有再 fallback `latest`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/update/worker-release.ts:127-193`。

### 9.3 自动更新时机

每个已配对、无 queued/running task 的 daemon 都符合空闲更新条件；连接状态本身不构成阻止条件，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/runtime/daemon-auto-update.ts:7-19`。daemon 每 10 秒检查一次；发现更新后先进入 drain，再启动 pending update，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/runtime/daemon.ts:973-1000`。

### 9.4 安全切换与重启

更新器从 `<baseUrl>/install/worker/manifest.json` 和 `package.tgz` 下载，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/update/worker-updater.ts:265-309`。它：

- 校验 tarball SHA-256；
- 解压到 staging；
- 验证 packageName/packageVersion；
- 运行 staging entry smoke test；
- 把 staging rename 成 release dir；
- 原子切换 `current` symlink；
- 重写 launcher；
- service 模式 restart，docker 模式退出等待容器策略拉起；
- 失败时回滚 symlink 和 launcher。

完整关键流程见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/update/worker-updater.ts:315-449`。重启策略解析为 `service|docker|none`，Docker 环境默认 `docker`，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/update/worker-updater.ts:210-226`。

发布包本身还带 self-repair launcher，用于入口依赖损坏时重拉完整包，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs:102-128`。

## 10. 是否可独立于 monorepo 安装

### 10.1 可以独立安装

证据链：

1. 动态生成的 npm package 是 `private: false` 并有完整 bin/dependencies，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs:35-64`；
2. installer builder 在构建期把生产依赖装进 package tree，明确注释“installer must not need npm on target machine”，见 `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/build-worker-installer.mjs:59-67`；
3. 控制面直接提供 tarball、manifest、shell/PowerShell installer，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:1280-1349`；
4. README 明确 Worker 可安装在控制面之外的另一台机器，见 `/opt/data/profiles/scribe/workspace/wemux-slim/README.md:137-147`。

目标机仍需要：

- Node.js 22+；
- curl/tar/checksum 工具（Unix）；
- 到控制面与下载源的网络；
- 执行代码所需的 Git/SSH/agent runtime；
- 对本地目录和服务管理器的权限。

### 10.2 npm 安装能力的边界

生成物本身是合法公开 npm package，并且 updater 支持 npm registry，因此架构上支持发布到 npm。但仓库根 package 是 private，`apps/worker` 又没有静态 package.json；用户不能从源码树直接 `npm i -g` 得到 Worker。是否已有实际公开 npm release，单靠本地源码无法证明，应以 registry/发布流水线事实为准。

### 10.3 Docker 也可脱离 monorepo

`/install/docker` 拉取 `ghcr.io/wemux-ai/wemux-worker:latest`，不需要源码 checkout，见 `/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts:173-246`。但它对宿主机 Docker socket 的依赖和权限风险明显高于主机原生安装。

## 11. 现状优点与风险

### 优点

1. **控制面自带 installer artifact**：自托管用户无需依赖唯一中心 registry。
2. **目标机无需 npm/pnpm**：依赖在构建期 vendoring，只要求 Node 22。
3. **配对与安装一条命令完成**：UI 创建短期 code 并生成 OS 适配命令。
4. **系统服务跨平台覆盖**：Linux/macOS/Windows 都有实现。
5. **更新有 drain、checksum、smoke、原子切换、回滚**：明显优于直接覆盖正在运行的目录。
6. **service 与 Docker 两种重启策略分开**：避免更新器错误地操作容器内 systemd。

### 风险/改进点

1. **两套 Node 要求**：根项目 `>=20`，发布 Worker `>=22`，文档和 doctor 必须始终以安装包要求为准。
2. **旧 `VIBEMUX_*` 与新 `WEMUX_*` 并存**：增加安装、排障和迁移复杂度。
3. **10 秒更新查询过于频繁**：大量 Worker 会持续请求控制面；宜改为分钟/小时级并加随机抖动，关键安全更新再由控制面 push。
4. **Docker socket 是宿主 root 等级能力**：需要明确风险、范围限制与替代 sandbox 方案。
5. **Windows fallback 只在登录后启动**：Scheduled Task 是 AtLogOn，Startup VBS 也依赖用户登录，不等同于真正的无人值守 Windows service。
6. **供应链主要依赖 SHA-256**：checksum 与 package 从同一控制面获取，可防损坏但不能防控制面/发布系统被攻破；可增加签名。
7. **npm 发布状态不由源码保证**：虽然包和 updater 支持 registry，但需额外发布流水线与 registry 可用性验证。
8. **包仍依赖系统 Node**：Node 升级或路径变化可能影响服务。若 Mini 追求 appliance 体验，可考虑 bundled runtime 或单 binary。

## 12. Wemux Lite 可借鉴方案

### 12.1 推荐主线：控制面分发的自包含应用目录

Mini 首期可直接复用 Wemux 的深模块边界：

```text
CI 构建 Worker + Console
  -> 生成 mini-worker package tree
  -> 安装生产依赖
  -> package.tgz + manifest(SHA-256/version/commit)
  -> 控制面 /install、/install.ps1、/install/worker/*
  -> 一次性 pairing code
  -> 原生用户服务
  -> manifest 更新 + staging + 原子 current 切换 + 回滚
```

这比一开始维护 npm、GitHub Release、Docker 三套独立升级协议更简单。npm registry 可只作为 fallback。

### 12.2 Mini 应保留的接口

建议 CLI：

```text
mini-worker connect --pairing-code ... --server-url ... [--no-start]
mini-worker daemon
mini-worker status
mini-worker doctor
mini-worker service install|uninstall|start|stop|restart|status|logs
mini-worker update --check|--force
mini-worker disconnect
mini-worker open
mini-worker version
```

增加显式 `version`，让 installer 与 CI 能验证“运行中的版本、manifest 版本、目录版本”一致。

### 12.3 配置与安全

- 固定一个环境变量前缀，例如 `WEMUX_MINI_*`，不要继承双前缀兼容债务。
- 采用 CLI > env > config > release default 的确定优先级。
- config 只保存 node ID、server URL、name；长期 token 优先 OS secret store，暂存文件时强制 `0700/0600`。
- 明确分层 `node/`、`users/<userId>/runtime/`、`workspaces/<workspaceId>/`，不要把 agent 凭据放进共享 workspace。
- pairing code 保持 10 分钟一次性语义，并对生成/消费做限流和审计。

### 12.4 服务运行

- Linux 复用 systemd user service + `loginctl enable-linger`；失败时不要静默，应在 `doctor` 中显示。
- macOS 复用 LaunchAgent。
- Windows 若要求真正无人登录运行，应实现 Windows Service host；若只支持桌面用户登录态，明确标为“登录自启动”，不要称 system service。
- 所有平台 `service logs` 应提供统一体验。

### 12.5 更新策略

复用现有的 release directories 和 `current` symlink/junction，但建议：

- 检查间隔改为 15–60 分钟并随机抖动；
- 控制面可发“建议立即检查”事件；
- 下载后做 SHA-256 + 签名；
- staging smoke test 至少验证 module graph、config read、service adapter load；
- 保留上一版本，重启后健康检查失败自动回滚；
- 仅在 queued/running task 均为 0 时切换；
- 记录 update audit：from/to/source/checksum/result。

### 12.6 Docker 定位

Docker 应作为高级/服务器部署选项，不应取代默认主机安装：

- 发布固定版本 tag，不只用 `latest`；
- 首次 pair 后不再保留 pairing code；
- 明示 Docker socket 权限；
- 能不用 socket 就不用，优先挂载经过授权的 workspace 根；
- restart strategy 明确为 container supervisor；
- 提供最小独立 compose，不要求 clone Mini monorepo。

### 12.7 实施顺序

1. 定义 package tree、manifest schema、目录 layout；
2. 实现 Node 22 自包含 tarball与 Unix installer；
3. pairing + Linux systemd user service；
4. status/doctor/logs；
5. staging 更新、原子切换、回滚；
6. macOS；
7. Windows（先明确登录态还是无人值守）；
8. Docker registry image；
9. 最后评估是否需要 npm 公共发布。

## 13. 最终判断

Wemux Worker 当前最成熟的发布方式是“**动态生成公开 npm 形状的 Node 包，但由控制面以完整 tarball 安装**”。它同时保留 npm registry 更新 fallback、Docker 安装和仓库内开发入口。正式主机安装不依赖 monorepo和 npm/pnpm，但依赖 Node.js 22+。

Wemux Lite 最值得借鉴的是：配对安装命令、构建期 vendoring、跨平台用户服务、release-directory/current-pointer 模型，以及更新前 drain + checksum + smoke + 回滚。最应避免复制的是：旧新环境变量双前缀、10 秒轮询、把 Windows 登录自启动等同于系统服务，以及默认授予 Docker socket 却不突出风险。
