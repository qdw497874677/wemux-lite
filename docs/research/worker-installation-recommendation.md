# Wemux Lite Worker 安装方式调研与建议

## 结论

Wemux Lite 应采用 **Server 生成一次性注册码 + Server 托管自包含 Worker 安装包 + 一行安装命令 + 用户级守护服务** 的方式。

推荐主路径：

```bash
curl -fsSL https://wemux.example.com/install | bash -s -- \
  --token '<ONE_TIME_TOKEN>' \
  --server-url 'https://wemux.example.com' \
  --name 'dev-machine-01'
```

Windows：

```powershell
irm https://wemux.example.com/install.ps1 | iex
```

Docker 作为可选路径，不应成为默认路径。Worker 要复用宿主机 Git、SSH、Pi/Claude 凭据和本地代码目录，原生用户级服务更符合产品目标。

## Wemux 的做法

Wemux 控制面在“执行中心 → 新增节点”生成带短时配对码的安装命令。README 给出的 Unix 形式是 `curl -fsSL https://<server>/install | bash -s -- --pairing-code ... --server-url ...`。

Server 直接托管安装相关资源：

- `/install`：极薄 bootstrap，继续下载 `/install/worker.sh`。
- `/install/worker.sh`：macOS/Linux 安装器。
- `/install.ps1`、`/install/worker.ps1`：Windows 安装器。
- `/install/docker`：Docker 安装器。
- `/install/worker/manifest.json`：包名、版本、bin、构建时间、commit。
- `/install/worker/package.tgz`：自包含 Worker 包。

来源：`/opt/data/profiles/scribe/workspace/wemux-slim/apps/server/src/routes/worker-install-routes.ts`。

构建流程先生成独立 npm 风格包，再把生产依赖安装进包内，最终生成自包含 `package.tgz`。目标机器只要求 Node，不需要 clone monorepo，也不需要 pnpm/npm 在线解析 workspace 依赖。

来源：

- `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/package-worker-npm.mjs`
- `/opt/data/profiles/scribe/workspace/wemux-slim/scripts/build-worker-installer.mjs`

Unix 安装器负责：

1. 检查/安装 Node 22。
2. 下载 manifest 与 package.tgz。
3. 安装到 `~/.wemux-worker`，运行数据放 `~/.wemux`。
4. 在 `~/.local/bin` 创建命令 shim，有权限时也写 `/usr/local/bin`。
5. bootstrap Git 和 Agent runtime。
6. 使用一次性配对码执行 connect。
7. 注册用户级服务并启动。
8. 检查本地 health 和云端连接，连接未确认时安装不算成功。

Windows 使用当前用户启动项/服务，不要求管理员权限。Docker 使用持久 volume、`restart unless-stopped`，但运行在容器用户和容器文件系统中。

Wemux CLI 将安装、连接、服务管理、诊断、升级分开：`connect`、`daemon`、`doctor`、`service install/status/logs/...`、`update`。

来源：`/opt/data/profiles/scribe/workspace/wemux-slim/apps/worker/src/index.ts`。

## Wemux Lite 当前状态

`/opt/data/profiles/scribe/workspace/wemux-lite/apps/worker/package.json` 已声明独立包 `@wemux/worker`，并暴露：

- `wemux-worker`
- `wemux-agent`
- `wemux-agent-mcp`

当前源码仓库内可以：

```bash
npm install
npm run build --workspace @wemux/worker
node apps/worker/dist/cli.js register --server http://127.0.0.1:3001 --token TOKEN
node apps/worker/dist/cli.js start
```

但现在还不是可直接交付给普通用户的安装体验：

- `@wemux/domain` 和 `@wemux/wire-protocol` 使用 `0.1.0` workspace 依赖，独立安装前必须一起发布或打包进去。
- 缺少 Server `/install`、manifest、package.tgz 路由。
- 缺少生产安装器和 service install/uninstall/status/logs。
- 缺少 update/rollback。
- 注册命令叫 `register`，运行命令叫 `start`；适合当前 Mini，也可保持，不必复制 Wemux 的整套 CLI。

## 推荐的 Mini 分阶段方案

### 第一阶段：自包含 tarball + install.sh

保持最小依赖，不先做公开 npm 发布。

构建产物：

```text
dist-worker-installer/
├── manifest.json
└── package.tgz
```

`package.tgz` 包含：

- Worker 编译产物。
- `@wemux/domain`、`@wemux/wire-protocol` 的运行时产物。
- 所有 production dependencies。
- `wemux-worker`、`wemux-agent`、`wemux-agent-mcp` bin。

Server 增加：

```text
GET /install
GET /install/worker.sh
GET /install/worker/manifest.json
GET /install/worker/package.tgz
```

安装器默认目录：

```text
~/.wemux-lite/           # Worker 数据、identity、credential、SQLite、workspaces
~/.wemux-lite-worker/    # 可替换的程序安装目录
~/.local/bin/wemux-worker
```

程序目录和数据目录必须分开，升级只能替换程序目录。

### 第二阶段：用户级服务

Linux：systemd user service；执行 `loginctl enable-linger` 时失败只警告。

macOS：LaunchAgent。

Windows：当前用户启动任务或轻量 supervisor。

最小 CLI：

```bash
wemux-worker register --server URL --token TOKEN --name NAME
wemux-worker start
wemux-worker status
wemux-worker doctor
wemux-worker service install
wemux-worker service status
wemux-worker service logs --follow
wemux-worker service uninstall
```

### 第三阶段：受控升级

Server manifest 包含：

```json
{
  "version": "0.1.0",
  "sha256": "...",
  "node": ">=22.13.0",
  "builtAt": "...",
  "commitSha": "..."
}
```

升级流程：下载 staging → 校验 SHA-256 → 启动入口 smoke test → 空闲时停止服务 → 原子替换 → 重启 → health check；失败回滚上一版本。

MVP 不建议默认自动更新，先支持：

```bash
wemux-worker update --check
wemux-worker update
```

## 安全要求

- 注册 token 一次性、短时有效，优先环境变量或 stdin，避免 shell history。
- 安装包必须 SHA-256 校验；生产 HTTPS。
- Worker 长期 credential 继续保存在 mode `0600` 文件中。
- 不用 root 运行 Worker；使用当前用户，才能读取该用户 Git/SSH/Agent 凭据。
- Server URL 必须固定 origin，安装脚本不能允许下载 URL 跳到任意域。
- 安装成功必须同时满足：服务已启动、本地 health 正常、Server 已看到在线 Worker。

## 最终推荐

Wemux Lite 不需要完整复制 Wemux 的 runtime bootstrap、Mesh、local console、自修复等复杂能力，但应复制其安装架构：

> **控制台签发一次性注册码 → Server 提供环境绑定的一行命令 → 下载自包含包 → 当前用户安装 → 注册 → 用户级服务启动 → 双端在线验证。**

这比单纯 `npm install -g @wemux/worker` 更适合私有部署，也能保证 Worker 版本和对应 Server 契约一致。公开 npm 包可作为开发者备用渠道，而不是默认产品路径。
