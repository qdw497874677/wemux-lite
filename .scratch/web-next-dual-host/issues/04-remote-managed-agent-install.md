# 04: Web 远程托管安装入口（Server 一键安装脚本，装到指定目录）

Status: ready-for-human
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

- [x] Server 提供一键安装脚本与固定版本清单，脚本安装到指定目录且 integrity 校验通过才安装
- [x] 非法安装目录被拒绝（非绝对路径、符号链接、越出 Worker home）
- [x] 管理面内对在线 Worker 发起托管安装，进度与失败原因可见；四态如实呈现
- [x] 离线/自助路径给出可粘贴命令，复制在不安全上下文可用（降级）
- [x] 不覆盖全局安装、不作为 Worker 启动依赖；安装失败不破坏既有选择（staging + 回滚）
- [x] 真脚本 e2e + 真浏览器覆盖桌面/移动；证据按仓库惯例留存，脱敏摘要入库

## 验收记录（2026-10-14，分支 `dualhost-04-remote-install`，基点 `74c9c9c`，已 merge `main`@`360d219` → `2375edf`）

实现提交（中文提交，服务端 / 前端 / Worker 修复分开）：

| 提交 | 内容 |
| --- | --- |
| `a655e4b` | 共用固定版本目录 `packages/domain/src/agent-runtime-catalog.ts`（Server 与 Worker 单一来源）+ 公开 `GET /downloads/agent-manifest.json`、`GET /downloads/install-agent.sh`（`apps/server/src/http/agent-downloads.ts`）+ 不依赖真实 registry 的脚本契约测试 |
| `fefc79f` | 管理面接口 `GET /api/managed-agent-catalog`、`POST /api/managed-agent-installs`（resource + revision + binding，幂等）+ 物化失败原因（`unavailable`、`errorCode`）进四态投影 |
| `eae132d` | web-contract DTO、web-client `agent-install.ts`（新模块，未触碰票据 03 的 `resource-management.ts`）、web-next `lib/agent-install.ts` 命令生成 + `RemoteAgentInstall.tsx` + 真浏览器验收脚本 |
| `c295899` | Worker `runRuntimeProcess` 把子进程输出尾部并入失败原因（拉取失败不再只有 `Runtime process exited with 1`） |
| `2375edf` | merge `main`（票据 03） |

验证命令与退出码（日志均在 `/var/tmp/wemux-d04-*.log`）：

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| `npm run build:packages` | 0 | `wemux-d04-build-packages.log` |
| `npm run typecheck`（全 workspace） | 0 | `wemux-d04-typecheck.log` |
| `npm run build --workspace @wemux/worker` / `@wemux/server` / `@wemux/web` / `@wemux/web-next` | 0 | `wemux-d04-build-{worker,server,web,web-next}.log` |
| `npm test --workspace @wemux/server`（1019 用例，含 `agent-install-script.test.ts` 与 `managed-agent-http.test.ts`） | 0 | `wemux-d04-test-server.log` |
| `npm test --workspace @wemux/worker`（532 用例，527 通过 5 跳过） | 0 | `wemux-d04-test-worker.log` |
| `npm test --workspace @wemux/web-client`（327 用例，含票据 03 用例） | 0 | `wemux-d04-test-webclient.log` |
| `node --import tsx --test packages/domain/tests/*.test.mjs`（13 用例） | 0 | `wemux-d04-test-domain.log` |
| `npm run test:prepared --workspace @wemux/web-next`（202 用例，真 Chromium；必须带 `PLAYWRIGHT_CORE_PATH`/`PLAYWRIGHT_CHROMIUM_PATH`） | 0 | `wemux-d04-test-webnext.log` |
| `npm run test --workspace @wemux/web`（297 用例） | 0 | `wemux-d04-test-web.log` |
| `node --experimental-strip-types --test apps/web-next/tests/agent-install-command.test.mjs`（7 用例，命令生成契约） | 0 | `wemux-d04-webnext-lib.log` |
| `node --import tsx apps/e2e/next-managed-agent-install-browser.mjs`（真浏览器，桌面 1440×900 + 移动 390×844） | 0 | `wemux-d04-e2e-agent-install.log` |
| `HOME=<隔离目录> node --import tsx --test apps/e2e/resource-reconcile.test.ts`（既有托管安装 e2e，见残留 1） | 0 | `wemux-d04-resource-reconcile.log` |
| `node --import tsx apps/e2e/next-resource-management-browser.mjs`（票据 01 用例，回归） | 0 | `wemux-d04-e2e-resource-mgmt.log` |
| `node --import tsx apps/e2e/next-resource-management-write-browser.mjs`（票据 03 用例，回归） | 0 | `wemux-d04-e2e-resource-write.log` |

脚本契约与真脚本链路（`apps/server/src/test/agent-install-script.test.ts`，不访问真实 npm registry）：

- 命中固定版本：假 registry（packument + tarball）+ 假包（bin 名 `pi`、`--version` 输出固定版本）→ 脚本装到 `WEMUX_INSTALL_DIR` 下的独立 staging（`.wemux-managed-agent.json` 记 `installRoot` 与 sha512）→ 真跑 `--version` 通过 → 写 `agents.json`（`source: 'managed'`、`package`）→ 打印重启提示；断言不使用全局 prefix。
- integrity 不符 → 拒绝且不改动既有选择/目录；固定版本未命中（registry 404）→ 失败不落盘。
- 非法安装目录（非绝对、符号链接、越出 Worker home）→ 拒绝；环境变量只作数据（注入字符不进入 shell，未知 Agent 键被拒）。
- 生产脚本与清单逐字内嵌共享固定目录（防 Server/Worker 漂移）；下载面只服务两个固定路径且带 `no-store`。

真浏览器验收（`apps/e2e/next-managed-agent-install-browser.mjs`，可重复脚本已入库；证据 `/var/tmp/wemux-managed-agent-install-*/`，脱敏摘要如下）：

- 公开面与管理面同源：`/downloads/agent-manifest.json` 与 `GET /api/managed-agent-catalog` 逐字相等，`/downloads/install-agent.sh` 匿名可取且内嵌 `pi@0.85.1`/`opencode-ai@1.18.31`/`@anthropic-ai/claude-code@2.1.34` 与各自 sha512。
- 离线节点：界面只给一键命令（`curl -fsSL --connect-timeout 5 '<server>/downloads/install-agent.sh' --noproxy '127.0.0.1' \` + `| WEMUX_AGENT_KEY='pi' WEMUX_INSTALL_DIR="$HOME"'/.wemux-lite/agents/pi' WEMUX_WORKER_HOME="$HOME"'/.wemux-lite' sh`），该节点「托管安装」按钮 count 为 0，服务端无任何 agent-runtime 绑定：展示命令不被当成已安装。
- 在线节点：取消确认对话框时零写入；确认后只创建托管修订与绑定（`notified`），界面回执立刻是 `分发待确认｜正在安装（安装中）｜探测于 …`（进度可见，不是「已安装」）；Worker 真实取包失败后变为 `分发失败｜Agent 安装或探测失败，已保留当前激活版本（… ECONNREFUSED … port: 9 …）`，全程不出现 `已分发｜`。
- 与固定目录不符的托管修订（伪造 `claude-code` sha512）→ 界面 `分发失败｜…（unapproved_runtime_artifact）`；四轴仍渲染三行（配置/分发/执行）。
- 非管理员：页面 403 `admin_required`、零按钮零请求；直连 `POST /api/managed-agent-installs` 也 403 且零写入。
- 移动端真非安全上下文（`http://192.168.3.215:<port>`，`isSecureContext === false`、无 `navigator.clipboard`）：点复制不假称成功，降级为全选并提示 `无法自动复制…Ctrl+C`（选中 232 字符，含 `/downloads/install-agent.sh`）。
- 脱敏证据：`/var/tmp/wemux-managed-agent-install-Cmcfp7/`（`checks.json` + `desktop-offline-command.png`、`desktop-online-install-failure.png`、`desktop-unapproved-artifact-rejected.png`、`mobile-insecure-copy-fallback.png`）。

已实现 / 已验证 / 部分完成：

- 已实现且已验证：共享固定目录单一来源（Server 脚本/清单与 Worker `installCatalog` 同源，契约测试锁定防漂移）；公开 `agent-manifest.json` / `install-agent.sh`（环境变量传参、sha512 通过才 `npm install --prefix`、每轮 staging、不覆盖全局、打印重启提示）；非法安装目录拒绝（非绝对/符号链接/越出 home）；管理员目录接口与 `POST /api/managed-agent-installs` 幂等创建修订+绑定；Web「托管安装」入口（显式确认、进度/失败原因、四态、永不把「脚本已给出」当「已安装」）；离线命令生成（`--noproxy`、候选回落、nc 隧道）与不安全上下文复制降级。
- 部分完成（留给人工或后续票）：管理面「已分发/就绪」成功态在真浏览器里未观测到（本沙箱取包失败路径是刻意制造的，见残留 1）；浏览器用例的在线成功分支只在沙箱真装成功时才走断言，本次未触发；托管选择只写 `agents.json`，未安装/未认证不影响 Worker 注册上线（启动依赖为零）。

残留与后续会话须知：

1. `apps/e2e/resource-reconcile.test.ts`（既有托管安装 e2e）在本机 ambient `HOME` 下会红在第 119 行：本机 `~/.pi` 扩展 `pi-subagents-lite` 调用了固定版本 pi 0.85.1 没有的 `createCodemodeExtension`，RPC 直接退出 → `PiAgent.detect()` 返回 `unavailable` → `checkActivatedRuntimes` 回滚并报 `runtime_activation_failed`。用隔离 `HOME`（并 `ln -s ~/.npm` 复用 npm 缓存）即通过（1 用例 64s），说明是环境依赖而不是本票回归：`git diff 74c9c9c HEAD -- apps/worker/src/agents/pi-agent.ts apps/worker/src/runtimes/version-environment.ts` 为空，且独立探针直接复现（ambient → `unavailable`，隔离 → `authentication-required`，日志 `/var/tmp/wemux-d04-pi-detect-{ambient,isolated}.log`）。
2. `npm_config_proxy` 只挡 packument：未进本机 npm 缓存的包（`opencode-ai@1.18.31`）约 70s 后 `ECONNREFUSED` 失败，而 tarball 取包不受代理影响，`@earendil-works/pi-coding-agent@0.85.1` 即使代理指向死端口也能真装成功（约 3m30s，1056 个 entry）。所以浏览器用例用 `opencode` 做确定性失败路径、用 `claude-code` 做 `unapproved_runtime_artifact` 拒绝路径（`approved()` 在 npm 之前就拒绝，与包无关）。
3. 命令生成契约：`--noproxy` 在 URL 之后；多候选回落行的 `;` 前有一个空格；`new URL('fe80::1:8010')` 会被解析成 scheme `fe80:`，因此候选过滤必须判 `protocol` 是 http/https 且 hostname 非空；`DIRECT_HOST` 还要覆盖 `*.localhost`。
4. web-next 测试：`npm run test:prepared --workspace @wemux/web-next` 与 `npm run test --workspace @wemux/web` 都必须带 `PLAYWRIGHT_CORE_PATH`/`PLAYWRIGHT_CHROMIUM_PATH`，否则浏览器用例报 "Browser acceptance configuration required"（不是代码失败）。
5. 浏览器 e2e 需 fresh 构建的 web-next dist 拷到 `/tmp`（脚本断言 `WEMUX_NEXT_TEST_DIST` 以 `/tmp/` 开头）；`node --import tsx` 才能 import 仓库 TS 源码。
6. 跨票协作：本票的 web-client 操作放在新模块 `packages/web-client/src/agent-install.ts`、UI 在新组件 `RemoteAgentInstall.tsx`，对 `ResourceManagement.tsx` 只加一个挂载点；merge `main`（票据 03）时两处均自动合并成功，票据 01/03 的浏览器用例在本分支仍绿。

## Prior art 与依据

- Worker 一键安装（本票要沿用的逻辑）：`apps/server/src/http/worker-downloads.ts:8-10`（路径导出）与内嵌 installer（`workerTarballPath`/`workerManifestPath`/`workerInstallerPath`、manifest sha256 校验、staging、systemd/launchd 服务）；`apps/web/src/lib/worker-install.ts` 的 `buildWorkerInstallCommand`（curl/nc、`--noproxy`、候选回落、env 传参）。
- 托管安装既有物化：`apps/worker/src/runtimes/management.ts:30-35`（`installCatalog`）、`:95`（`installAgent`）、`:108`（`stageAgentRuntime`）；`apps/worker/src/resources/runtime-materializer.ts:63-105`（`approved/verify/materialize`，固定版本+integrity 白名单、`home/agents/<key>/` staging、版本探测与回滚）；`apps/worker/src/application/cluster-lifecycle.ts:178-190`（本地宿主 `beginAgentInstallation`，固定版本 + Worker home 独立目录）。
- 边界：`AGENTS.md`「Worker 与 Agent 安装边界」（托管安装固定官方版本、装到 Worker home 独立目录、不覆盖全局、变更路径需重启 Worker、未安装或未认证不得阻止注册上线）。
- 现有只读面：`apps/web-next/src/components/ResourceManagement.tsx`、`packages/web-client/src/resource-management.ts`。
