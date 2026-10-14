# 04: Web 远程托管安装入口（Server 一键安装脚本，装到指定目录）

Status: ready-for-agent
Blocked by: 无。复用票 01 的四态投影与既有 ResourceReconciler 物化；与 03 共用 web-client 写操作（03 先完成则复用其幂等/冲突封装）。

**Spec:** [资源管理与独立 Worker 双宿主](../spec.md)
**来源:** 自票 01 移交（票 01 验收第 4 项：远程安装 Agent 不覆盖全局安装、失败给出明确原因；Web 远程安装入口尚未实现）。用户决定（m00996）：「要有这些资源的管理。应该是从 server 获取一键安装脚本吧，之前就是这个逻辑，安装到指定目录」。

**What to build:** 管理员可以在 `/next/resources` 对选中的 Worker × Agent 发起托管安装并看到进度与失败原因。安装固定官方版本、只写入指定的 Worker home 独立目录，不覆盖全局安装、不作为 Worker 启动依赖。安装入口沿用 Worker 一键安装脚本的既有逻辑：脚本与固定版本清单由 Server 提供。

### 一、Server 一键安装脚本与固定版本清单

- 固定官方 Agent 目录成为 Server 与 Worker 的单一来源（现仅存在于 `apps/worker/src/runtimes/management.ts` 的 `installCatalog`：`pi@0.85.1` / `opencode-ai@1.18.31` / `@anthropic-ai/claude-code@2.1.34`，各带 sha512 integrity），移到共用包导出，Server 与 Worker 不得各自维护副本。
- 新增 `GET /downloads/agent-manifest.json` 与 `GET /downloads/install-agent.sh`，与既有 `/downloads/worker.tgz`、`/downloads/worker-manifest.json`、`/downloads/install-worker.sh`（`apps/server/src/http/routes/public-routes.ts:11/16/21`，`auth:'public'`）同形。
- 脚本契约（全部经环境变量传入，不拼接命令注入）：
  - `WEMUX_AGENT_KEY`（pi | opencode | claude-code）、
  - `WEMUX_INSTALL_DIR` 必填绝对路径：指定的安装目录，默认建议 `<WEMUX_WORKER_HOME>/agents/<key>`；必须是绝对路径、不得是符号链接、不得越出 Worker home（越出需显式拒绝或在界面确认，不静默接受）、
  - `WEMUX_WORKER_HOME`：登记托管选择，供 Worker 重启后生效。
- 脚本行为：下载固定版本官方包并在校验 integrity 通过后才允许 npm 安装；每次安装用新的 staging 目录，失败不改动既有可用版本；成功后打印重启提示（Worker 不会热更新）。实现优先复用既有物化逻辑（`installAgent` / `stageAgentRuntime`，`apps/worker/src/runtimes/management.ts:95/108`），不在脚本里重写安装器。
- 不覆盖全局安装：不用全局 npm prefix、不写 PATH、不动已有的 `agent use --path` 选择。

### 二、Web 远程安装入口（`/next/resources`，管理员）

- 在线 Worker：对选中 Worker × Agent 发起「托管安装」，走既有集群托管分发（agent-runtime 修订 `artifact { packageName, packageVersion, registryOrigin, packageIntegrity }` + 绑定），由 `RuntimeMaterializer`（`apps/worker/src/resources/runtime-materializer.ts:63`）物化到 `home/agents/<key>/`，成功后 `activateStagedRuntimes` 在下次启动生效、版本探测失败自动回滚。管理面把物化回执的进度/失败原因（如 `unapproved_runtime_artifact`、版本探测不匹配、拉取失败）如实呈现。
- 离线或自助场景：展示可粘贴的一键命令（`curl -fsSL <server>/downloads/install-agent.sh | WEMUX_AGENT_KEY=… WEMUX_INSTALL_DIR=… WEMUX_WORKER_HOME=… sh`），私网/tailnet 地址带 `--noproxy`，多候选与 nc 隧道沿用 `apps/web/src/lib/worker-install.ts` 的既有生成规则；复制必须走 `copyText()` 不安全上下文降级。
- 未经管理员显式确认不发起安装；界面区分「已配置 / 已认证 / 已分发 / 可执行」四态，不把「脚本已给出」当作「已安装」。

## 实现计划

1. 抽出共用固定版本目录（Server/Worker 单一来源），Server 生成 manifest 与 install-agent.sh；为脚本写不依赖真实 npm 的契约测试（固定版本命中/未命中、integrity 校验失败、非法安装目录、非绝对路径、符号链接、越出 home）。
2. 管理面发起入口与进度/失败呈现（复用票 01 回执投影与错误映射），以及离线一键命令生成与复制降级。
3. 真脚本 e2e：以假 registry/tarball 与固定 integrity 验证「从 server 取脚本 → 安装到指定目录 → 校验 integrity → 版本探测」；真浏览器覆盖桌面与移动、管理员与非管理员；在线 Worker 路径验证物化回执与失败原因（含 `unapproved_runtime_artifact` 拒绝）。

## 验收

- [ ] Server 提供一键安装脚本与固定版本清单，脚本安装到指定目录且 integrity 校验通过才安装
- [ ] 非法安装目录被拒绝（非绝对路径、符号链接、越出 Worker home）
- [ ] 管理面内对在线 Worker 发起托管安装，进度与失败原因可见；四态如实呈现
- [ ] 离线/自助路径给出可粘贴命令，复制在不安全上下文可用（降级）
- [ ] 不覆盖全局安装、不作为 Worker 启动依赖；安装失败不破坏既有选择（staging + 回滚）
- [ ] 真脚本 e2e + 真浏览器覆盖桌面/移动；证据按仓库惯例留存，脱敏摘要入库

## Prior art 与依据

- Worker 一键安装（本票要沿用的逻辑）：`apps/server/src/http/worker-downloads.ts:8-10`（路径导出）与内嵌 installer（`workerTarballPath`/`workerManifestPath`/`workerInstallerPath`、manifest sha256 校验、staging、systemd/launchd 服务）；`apps/web/src/lib/worker-install.ts` 的 `buildWorkerInstallCommand`（curl/nc、`--noproxy`、候选回落、env 传参）。
- 托管安装既有物化：`apps/worker/src/runtimes/management.ts:30-35`（`installCatalog`）、`:95`（`installAgent`）、`:108`（`stageAgentRuntime`）；`apps/worker/src/resources/runtime-materializer.ts:63-105`（`approved/verify/materialize`，固定版本+integrity 白名单、`home/agents/<key>/` staging、版本探测与回滚）；`apps/worker/src/application/cluster-lifecycle.ts:178-190`（本地宿主 `beginAgentInstallation`，固定版本 + Worker home 独立目录）。
- 边界：`AGENTS.md`「Worker 与 Agent 安装边界」（托管安装固定官方版本、装到 Worker home 独立目录、不覆盖全局、变更路径需重启 Worker、未安装或未认证不得阻止注册上线）。
- 现有只读面：`apps/web-next/src/components/ResourceManagement.tsx`、`packages/web-client/src/resource-management.ts`。
