# Ticket03 局部验收：Session 文件与终端副作用授权

状态：本地实现并验证，已独立审查通过（no issues / OK，`outputs/ad276845-de5a-4f5a-a91a-082d0cb9e682/tickets/03/session-effect-auth-review.md`）。审查检查源码、前镜像、增量 diff 与执行证据，未自行重跑测试或校验全部哈希。Ticket03 仍为 partial；本记录不关闭全部票据、私有历史门、双宿主或发布门。

## 本次边界

- Server `fs/write` 要求既有 Session `write` 权限。
- terminal create/write/resize/dispose 要求既有 Session `control` 权限。
- 文件 list/read/diff 和 terminal stream 保持既有 read 语义；不改变 PAT scope 映射。
- owner 保留控制权；可读 contributor 可以写文件，但非 owner contributor 不能操作终端；可读 manager 可控制终端。
- 对 owner-only Session 无读取权的 Project manager 和未获 Session 授权的实例管理员均为 404，无管理员绕过。
- HTTP 在解析请求体之前检查能力；应用服务接收已认证 actor，并在独立 ServerStore 事务中重新检查当前 Session 权限，然后检查 Task 生命周期。
- 配置 SessionAccessService 时缺失 actor 返回 401。仅既有可信、未配置 SessionAccessService 的直接应用服务组合保留无 actor 兼容；网络入口仍先认证 actor/operator。
- 已删除 Task 的文件写与终端 create/write/resize 保持 410；dispose 仍允许有 control 权限者清理。授权拒绝优先于生命周期信息。

## 时序及明确未实现项

`requireSessionEffectAccess` 在同一事务中读取权限与 Task 状态。事务完成后，应用方法注册响应等待项并调用 gateway；网络 I/O 不占用数据库事务。

这是 dispatch 前的当前授权快照，不是与 Worker effect 原子绑定的持久准入。排在检查之前提交的撤权会拒绝；检查之后至 dispatch 之间仍存在非原子的时序窗口。已经 dispatch 的请求不会因之后撤权而被取消。测试明确允许在 gateway 入口之后撤权并完成已发请求，同时拒绝下一次请求。

没有新增 durable admission、历史 fence、在途取消、终端归属规则、ACL role、持久化或 wire 合同；没有启动 shell/真实终端进程、真实 Agent 或收费模型。受控协议 peer 的成功响应仅证明 Server 转发与授权，不证明 Worker 文件或终端执行完成。

## 可重复验证

仓库根执行，使用已安装依赖。浏览器变量必须指向现有本机 Playwright 与 Chromium，禁止自动下载。UI 构建必须使用独立 `/tmp` 输出目录；Server 通过 tsx 运行当前源码，不使用共享 dist。

```sh
node --import tsx --test \
  apps/server/src/test/session-effect-authorization.test.ts \
  apps/server/src/test/session-effect-service.test.ts \
  apps/server/src/test/session-files-http.test.ts \
  apps/server/src/test/session-terminal-http.test.ts \
  apps/server/src/test/project-authorization.test.ts \
  apps/server/src/test/project-authorized-resources.test.ts \
  apps/server/src/test/task-delete.test.ts \
  apps/server/src/test/task-delete-artifacts.test.ts \
  apps/server/src/test/admin-route-auth.test.ts
node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit
node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 \
  --module ESNext --moduleResolution Bundler --allowImportingTsExtensions \
  --allowJs --types node apps/web-next/tests/session-effect-authorization.browser.mts
PRIVATE_ROOT=$(mktemp -d /tmp/wemux-session-effect-acceptance-XXXXXX)
node_modules/.bin/vite build --config apps/web-next/vite.config.ts --outDir "$PRIVATE_ROOT/next-dist"
export WEMUX_NEXT_TEST_DIST="$PRIVATE_ROOT/next-dist"
# 必须事先设置 PLAYWRIGHT_CORE_PATH、PLAYWRIGHT_CHROMIUM_PATH 的绝对路径。
node --import tsx apps/web-next/tests/session-effect-authorization.browser.mts
node --import tsx apps/web-next/tests/admin-route-auth.browser.mts
node --import tsx apps/web-next/tests/project-management.browser.mts
```

## 实际结果

- 红：未修复源码的公开 HTTP viewer 对五个 mutation 均实际 dispatch 一次，返回 200/201，而非预期 403/零 dispatch；1 test failed，exit 1。
- 首个绿：同一测试修复后 1/1，exit 0。扩展 HTTP matrix 3/3，直接服务 5/5，最终定向 Server 合集 22/22，exit 0。
- HTTP matrix：owner、可读 contributor、viewer、可读 manager、不可读 manager、未获 Session 授权的 admin、anonymous、PAT scope 不足；全部拒绝行同时检查 malformed JSON 不先泄露验证结果且零 gateway dispatch。
- 直接服务：缺失 actor、Session grant 撤销先于事务检查、角色降级、shareScope 收紧、Task 生命周期、dispose、无事务覆盖 gateway、已 dispatch 后撤权边界、timeout 504 与既有 Worker 错误映射。
- Server 类型检查初次发现新测试误带 `messageId`（TS2353），移除后 exit 0；新 browser 测试类型检查 exit 0。没有忽略或放宽类型规则。
- 新浏览器：1440×900 / 390×844，真实私有 Server、内联登录、Cookie/CSRF、真实 HTTP 请求及受控协议 peer，80 组检查通过，exit 0，零 pageerror/清理失败。行为检查不是 pixel/UI 视觉验收。
- 相邻浏览器回归：admin-route 20 组、project-management 96 组通过，均 exit 0。
- 私有当前源码 UI build exit 0；没有覆盖共享 dist/artifacts，无安装、部署、服务重启、staging 或 commit。

脱敏原始日志及本次增量校验留于 `/tmp/wemux-session-effect-auth-FpuYvu/`；新浏览器结果 `/tmp/wemux-session-effect-browser-5jW4Fm/result.json`，相邻 admin 浏览器结果 `/tmp/wemux-admin-browser-evidence-zViocw/result.json`，project 结果在上述根目录 `project-browser-result.json`。原始证据不作为全票完成证明。
