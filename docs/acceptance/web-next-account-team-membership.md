# Ticket02 账号与团队迁移：临时验收记录

状态：**已实现并定向验证；独立复审已确认原四项 finding resolved，后台刷新 P2 也已获独立复审 OK/no issues；邀请重发增量也已获独立复审 OK with notes/no defects；最后本地角色交错证据已独立复核 OK with notes/no issues，parent 已接受该增量的状态对账（精确引用见末节）；Ticket01 依赖与完整 candidate/root gate 尚未验收，不是发布批准。** 未部署、未提交、未推送，未删除旧版。项目资源授权编辑仍由 Ticket03 接续。

## 实现边界

- `/next/login` 内联注册、验证重发、找回及已有 Google 登录；公开能力报告真实邮件/Google 不可用原因。
- `/next/auth/verify-email`、`/next/auth/password/reset`、`/next/auth/confirm-email-change` 均需明确提交，不在 GET 消费令牌。
- `/next/settings` 分为安全、设备会话、访问凭据、生命周期、审计、实例管理模块。包含密码/邮箱变更、Google 绑定解绑与最后方式保护、PAT 多 scope 创建/轮换/撤销与一次性展示、注销确认、管理员停用/恢复/请求删除/确认删除、注册策略与审计筛选/分页/导出。
- `/next/teams` 创建、选择团队、成员、邀请/重发/撤销、角色与显式所有权转让；`/next/join` 查看并接受。邀请重发是先撤销待接受邀请再签发，失败按真实错误展示，不宣称原子替换。
- 复用共享 Cookie/CSRF transport，不新增 API、不修改服务端授权/审计逻辑。切换团队撤销旧 transport 并清项目缓存；角色/成员页面焦点恢复及 15 秒轮询重新读取权限；安全设置页同样检查会话有效性。
- 注意已有服务端 `POST /auth/logout-all` **保留当前设备**。新版明确标注“退出其他设备”，不谎称全部退出；当前设备可单独撤销或使用壳退出。
- 保留旧邮件入口，增加清楚标注的新版链接，使用配置 public URL 与同一 token。获批准的服务端改动仅涉及邮件链接生成与正文，没有新凭据或任意 returnTo。

## 可重复检查

现有依赖已安装，不需下载浏览器，不运行根 build/test/install。根目录执行：

```sh
npm run build:packages
node --experimental-strip-types --test \
  apps/web-next/tests/application.test.mjs apps/web-next/tests/account-routes.test.mjs \
  packages/web-client/tests/*.test.mjs
node --import tsx --test apps/server/src/test/{next-account-mail-links,account-security,account-recovery,account-lifecycle-http,account-lifecycle-audit,team-management-http,team-management-edge-cases,team-membership-governance-http,google-auth-routes,google-authentication,registration-routes,team-invitation-mail,personal-access-token-management,web-console-auth-paths,auth-routes}.test.ts
npx tsc -p apps/web-next/tsconfig.json --noEmit
npx tsc -p apps/server/tsconfig.json --noEmit
npx tsc -p packages/web-client/tsconfig.json --noEmit
```

结果：35 个共享客户端/应用行为测试、94 个服务端测试全部通过，0 skip；三项类型检查与 `git diff --check` 通过。包构建只更新各 package 的生成 dist，未运行根构建、未写共享 Web dist 或 Worker tgz。

浏览器按 `browser-test-infrastructure.md` 先启动/关闭真实 Chromium 预检，再执行私有测试：

```sh
RUN=$(mktemp -d /tmp/wemux-ticket02-review-XXXXXX)
node node_modules/vite/bin/vite.js build --config apps/web-next/vite.config.ts --outDir "$RUN/dist"
# 两个浏览器路径须为本机已安装 fixture 的绝对路径，禁止下载安装。
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
WEMUX_NEXT_TEST_DIST="$RUN/dist" WEMUX_TICKET02_EVIDENCE="$RUN/browser-result.json" \
node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
```

浏览器脚本建立全新临时数据库、动态端口与私有邮件出件箱，注册自有合成账号；finally 只关闭本次 server/browser、删除本次数据库/邮件目录，保留脱敏结果。不接触 8010、8004、生产 DB、真实 Agent/模型。错误只记录步骤，不序列化 Playwright secret call log。

## 本轮真实浏览器证明

最终私有构建上桌面 1440×900、手机 390×844 均通过，67 项记录断言：

- 注册、重发废弃旧 token、邮件双链接相同对象、GET 不消费、验证后真实 Cookie 登录与重复消费拒绝。
- 密码确认错误恢复、实际改密码、申请/确认邮箱变更、重新登录；找回/重置与一次性检查。
- 最后登录方式不可移除、未配置 Google 禁用和实际原因；PAT 创建、隐藏、轮换、撤销。
- 创建团队、发邀请、错误账号拒绝、受邀账号接受、重复接受 409；普通成员不能邀请或查看实例账号，缺 CSRF 写入 403。
- 所有者改成员为管理员；管理员不能改 owner，owner 不能直接降级自己；移除后 API 立即 403，打开页面焦点重检移除成员区域。
- 撤销邀请不能恢复授权，重新邀请明确接受后才能恢复，输入团队名确认转让所有权。
- 退出其他设备仍保留当前会话；撤销当前会话后页面回登录，API 401。
- 桌面额外完成管理员停用、已有登录失效、恢复、重新登录与审计查询。
- 初轮两种 viewport 均无 pageerror；初轮横向溢出断言只覆盖退出后的登录页，不能证明账号/团队页。设置刷新正常；实际业务阶段布局补验见下节。原生确认对话框由浏览器自动化明确接受。

服务端定向测试补充：过期邀请、重复/并发接受、邀请者降权、最后 owner/管理员保护、权限撤销与已有 SSE 关闭、生命周期、自锁、审计脱敏、PAT、邮件能力、CSRF；Google 已配置本地 verifier 回调、PKCE/state/replay、Next 返回目标与绑定解绑均通过。旧邮件路径保留由服务端路径合同及邮件测试证明，未重新运行旧版浏览器全回归。

## 上轮残余与不得夸大的部分（当前状态见末节）

- 外部 Google Provider 未访问；本地 verifier/合同测试不等于真实 Google 网络登录。本地 Provider 失败恢复和成功绑定/登录/解绑均已有真实浏览器证明（最新结果见末节），不等于真实 Google 访问。
- 注销/管理员请求删除/确认删除、审计导出/翻页、全部 PAT scope 组合、邀请重发失败恢复、HTTP 复制降级、手机管理生命周期尚未逐项浏览器验证；其 UI 已接入，已有服务端/共享能力检查不是等价替代。
- 团队角色 API 没有 expected-role/revision CAS 参数，沿用服务端事务内最新 owner 权限校验；不声明新增 CAS 或并发覆盖检测。已有并发邀请测试并不能证明所有角色竞态。
- 成员列表 15 秒轮询或焦点重检，安全页同理；不是无请求立即推送清屏。服务端立即撤权已验证。
- 测试进行过有界红/绿迭代：确认提示被刷新卸载、PAT/移除导致行消失后等待旧提示、邀请终态码误期望，以及 logout-all 保留当前的既有合同。最终脚本依真实合同断言，不通过修改服务端放宽。
- 原四项修复已获独立复审确认；刷新稳定性 P2 也已独立复核通过；邀请重发修复/管理与本地 Provider 新增证据也已独立复核通过；角色交错证据增量也已独立复核并由 parent 接受状态对账；仍需 Ticket01 依赖决策与完整 candidate/root gate；本票不标全量完成，不授权部署或移除旧版。

## 独立 review 四项修复与补验

本节记录上一轮候选，初轮 35/94/67 是历史结果。fresh 独立复审已确认下列四项 finding resolved，结论为 OK with notes；新增后台刷新重置搜索/焦点 P2 见下一节。该结论不是全票或发布验收。

1. **成员撤权缓存**：应用层 `revalidateAccess()` 在路由切换、窗口焦点、重新可见和 15 秒轮询时先清空项目缓存，重新查询成员关系与获权项目。失去当前团队时退回无指定团队范围并销毁旧 transport。每次项目读取有独立序号；旧作用域与旧请求的晚到结果不可恢复项目元数据。命令面板和项目列表/概要使用同一清理后的状态。行为测试覆盖挂起旧请求、撤权、范围退休和重新打开。
2. **Next OAuth 失败回跳**：新增服务端 `callbackRecovery()` 在执行回调前读取并验证相同 state/Cookie、事务、有效期与未消费状态，只决定固定 `/next/login` 或 `/next/settings`。不从 callback 的 returnTo 构造目的地，不转发 code/state。晚期验证/交换/绑定失败仍使用已验证事务的入口。无效、缺失、跨浏览器、过期或重放 state 不获得新版路由权限，保留安全旧版错误落点；旧版发起行为不变。此次获父会话批准的新增服务端接缝只有 `application/google-authentication.ts` 与 `http/routes-auth.ts`（及对应测试），不改令牌消费/CSRF。
3. **邮件动作排他**：reset、verify、change-email 改为互斥分支；真实浏览器记录这三个写端点，分别断言恰好调用自身一次，不再 reset 后提交 email-change。
4. **实际布局证据**：桌面与手机均在账号设置、明文 PAT 显示、邀请确认、已填充成员列表阶段检查 document 和实际 main/section/form/row/secret 容器 `scrollWidth <= clientWidth + 1`。这四阶段全部通过，没有发现需要 CSS 修复的溢出，没有加隐藏溢出规则掩盖缺陷；最后登录页断言单独命名。

### 本轮结果与复跑

- 36 个 client/application 行为测试通过，0 skip。
- 96 个定向服务端测试通过，0 skip，沿用上节完整命令。新增本地 Provider 测试包括 Next 登录/绑定取消、验签/交换失败、旧入口、恶意 callback returnTo、跨浏览器/缺失/过期/重放 state。
- Server 与 Next 类型检查、`git diff --check` 通过。
- 当前源码直接 Vite 私有构建：`/tmp/wemux-ticket02-fixes-XsPUXo/dist`。
- 经过真实浏览器 preflight 后 `account-team.browser.mjs` 桌面/手机 **91 项断言通过**，包括真实团队可见 Project、命令面板撤权、客户端项目导航与重新打开深链接，及上述排他动作与实际业务布局。
- 新增 `account-oauth-recovery.browser.mjs` 经过同一 preflight，桌面/手机 **8 个真实浏览器本地 Provider 取消/验签失败恢复场景通过**。只拦截外部授权导航转向私有 callback，实际 API、Cookie、state、HTTP callback 和新版错误渲染都真实执行；没有访问 Google。复跑方式同上，将脚本替换为此文件并用 `WEMUX_TICKET02_OAUTH_EVIDENCE="$RUN/oauth-result.json"` 指定结果文件。
- 两个 browser 脚本各自使用新建私有 DB/出件箱或本地 Provider、动态端口、合成账号，finally 精确删除自己的运行夹具。为在手机场景通过已有项目创建授权，手机 owner 也在该私有实例管理员声明中；受限 member 始终不是管理员。
- 修复前源码 hash/copy 与定向变更清单位于 `/tmp/wemux-ticket02-fixes-XsPUXo`；没有改既有无关脏文件，没有 staging/commit/deploy，未运行根 build/test/install 或写共享 dist。

仍保留 Ticket01 依赖、完整 root/candidate gate 与外部 Google 未验声明。配置 Provider 的成功绑定/解绑、删除/审计翻页导出等先前列明的完整浏览器缺口没有因本次失败恢复测试而自动闭环。焦点/轮询清缓存不等于推送式立即清屏。

## 后台权限刷新稳定性 P2

独立复审 `review-fixes-independent.md` 已确认原四项 finding resolved，另提出后台 `busy` 替换 `ProjectList` 使本地搜索与焦点丢失。本轮只修此新 P2：项目列表在后台权限检查期间保持挂载，搜索 DOM 与筛选值不变；结果区显示加载状态，计数显示“正在核验权限”，不把核验中的空缓存说成无项目。受保护项目数据仍由既有应用逻辑立即清空；本轮没有改 generation/request 序号或撤销团队 scope 的规则。此新 P2 已获 `refresh-stability-review.md` 独立复核 **OK / No issues found**，不能把原四项已获确认写回全部待审。

- 生产代码仅 `apps/web-next/src/App.tsx` 与 `components/Projects.tsx`，没有 server/package/CSS 修改。
- 浏览器回归在私有实例创建的真实可见项目列表输入过滤条件，保留原始 input element handle。分别触发窗口 focus 与真实 15 秒轮询，在网络层暂缓 `/api/projects`（释放后仍请求真实服务器），断言刷新中与完成后同一 DOM input 仍连接并持有焦点、过滤值不变；检查刷新中项目结果立即消失且不出现“还没有可访问的项目”。桌面/手机各 12 条新断言。
- 先用改前私有构建运行同一回归，RED 于 `desktop: unchanged-authority focus refresh`；再以当前源码构建，完整账号/团队 suite **115 条断言通过**，包括既有撤权后 command palette、客户端项目导航、重新打开 deep link、过期身份及实际布局检查。不是只测孤立输入组件。
- 本轮重新执行 36 个 client/application 测试（含 stale in-flight/revoked-scope 用例）、Next 类型检查、私有 Vite 构建、真实 Chromium preflight，均通过。Server 96 tests 与 local-provider 8 browser scenarios 是上轮结果，本轮未重复运行，不作新增证明。
- 当前构建/RED/GREEN 脱敏证据及 pre-edit hash/copies：`/tmp/wemux-ticket02-refresh-7OaA6n`；本轮 JSON 在 `.scratch/web-next-project-agent-platform/evidence/ticket-02-refresh-browser-result.json`。复跑沿用上节 `account-team.browser.mjs` 的命令，dist/evidence 换成本轮私有目录。精确自有 DB/邮件夹具已清理，没有触碰生产服务或共享 dist；tracked diff 与本轮开始时逐字相同，无 staged 文件。

### 刷新轮交接时未闭环的票据浏览器项（本轮更新见下）

外部 Google 实际登录；配置 Provider 的成功绑定/解绑；账号注销、管理员请求删除/确认删除；审计导出及翻页；全部 PAT scope 组合；邀请重发失败恢复；HTTP 剪贴板降级；手机管理生命周期尚未逐项真实浏览器验证。既有本地 Provider 失败恢复、桌面管理员停用/恢复不能替代这些项目。Ticket01 依赖与完整 candidate/root gate 仍延后，本票仍是 in-progress/provisionally-verified，不授权部署、提交或移除旧版。

## 本轮补齐可行的账号管理浏览器验收

当前状态：原四项 finding 与 refresh P2 都已独立复审通过。以下是新的本地验收证据，不重新开启已解决 finding。新发现的**邀请重发部分失败状态缺陷**已作窄修并验证，`remaining-coverage-review.md` 已独立确认此增量 OK with notes / No issues found，不把已完成 review 写回“全部待审”。

### 实现与 RED/GREEN

唯一生产修改为 `components/Teams.tsx` 的重发邀请动作：先清除一次性旧链接，`finally` 刷新服务端邀请状态。真实 RED 证明旧邀请 DELETE 已成功但新 POST 被模拟 503 拒绝后，原 UI 仍展示旧链接/待接受状态，下一次重试又撤销已撤销邀请而卡住。GREEN 保留相同失败注入与断言，证明旧链接消失、已撤销状态回显、错误仍可见，取消注入后按钮可签发不同 token 的新 pending 邀请。不改 API，不把两步操作伪装成原子事务。没有其他产品功能改动。

### 当前源码私有构建实测

三个脚本均经过 `scripts/test-with-browser.mjs` 的真实 Chromium launch/close preflight；桌面 1440×900 与手机 390×844：

| 脚本 | 本轮结果 | 覆盖 |
| --- | --- | --- |
| `account-team.browser.mjs` | 115 checks passed | 原账号/邀请/角色/所有权/权限撤销/布局/刷新稳定性链路全部重跑 |
| `account-management.browser.mjs` | 108 checks passed | 下列生命周期、审计、PAT、真实 HTTP 复制、重发失败恢复 |
| `account-oauth-recovery.browser.mjs` | 16 scenarios passed | 既有本地取消/验签失败恢复 + 未配置邮件实际原因 + 本地 Provider 成功绑定/登录/解绑 |

具体本轮新增证明：
- **自助删除**：浏览器取消确认无写入效果；错误确认文字拒绝且账号仍有效；正确确认后页面回登录、旧会话 API 401、已删除账号不能重新登录。
- **管理员生命周期**：桌面/手机均停用已登录 throwaway 账号，API 即时失效、焦点检查后打开页回登录；恢复后重新登录；请求删除撤销当前会话；确认删除清邮箱、username 墓碑化。所有写操作使用真实 Cookie/CSRF。UI 对话框显式接受/取消。
- **保护规则**：默认 Team 所有者注销按钮禁用；最后实例管理员直接 API 删除 409 `last_instance_administrator`；不能停用当前管理员。普通 Team owner 删除 UI 禁用、直接 API 409；管理员也不能绕过其资源所有权阻塞。
- **审计**：通过公开 PAT 创建写入生成超过 50 条真实记录，UI 筛选 `pat.created`，首分页 50、有 cursor，下一页 ID 不重叠，返回第一页可操作。点击真实下载链接读取 NDJSON，证明导出跨页且仅匹配动作，不含本次密码、展示过的 PAT、tokenHash/passwordHash/csrfToken/codeVerifier。普通成员审计限自身动作/subject。55 次/viewport setup 写入逐次断言成功但不计入 108 条业务 checks。
- **PAT 范围**：UI 分别选择 read/write/execute/admin 四种单一 scope 并证明 API 持久化一致，列表不含明文/hash；四种均能获权 read；read/execute 拒绝 write，write/admin 能创建 Team；只有 admin scope 可走实例管理员项目创建，普通账号的 admin scope 仍不能提升身份。execute/admin 的空 Session POST 能通过 scope 门后在输入验证处 400，read/write 在 scope 门 403；**这不是成功执行 Agent 的证明**，未创建有效 Session、未调用 Agent/模型。不是 scope 组合指数穷举。
- **HTTP 剪贴板**：浏览器 hostname resolver 将 `wemux-http.test` 映射到 127.0.0.1，server 仍只监听 loopback。使用实际 HTTP 非可信 origin（断言 `!isSecureContext` 且无 navigator.clipboard），复制 PAT 后选中真实 Secret 文本、明确 Ctrl+C/长按引导，没有假成功或 execCommand。未访问公共 DNS、未扩大网络监听。
- **邀请重发**：真正撤销旧邀请后只对后续 POST 注入单个 503 边界；观察真实 API 旧状态 revoked、旧一次性链接不再展示，页面显示失败；恢复真实请求后新 token 不同且 status pending。此覆盖客户端两步部分失败恢复，不宣称测试真实 SMTP 外网故障。
- **本地 Provider 成功链路**：复用已有真实 RS256/JWKS/PKCE verifier fixture，只替换外部授权导航，浏览器真实 start/callback/Cookie 流完成绑定；退出后用同一 Provider 登录回原 User；输入当前密码确认解绑后只剩不可移除 password 方式。桌面手机全部完成，明确不冒称外部 Google。

本轮 36 client/application tests、96 focused server tests（沿用前文完整命令）、Next typecheck、脚本语法和 diff/staging 检查通过。没有 package/server 生产修改，不需包重建；没有 root gate 或 shared UI dist 重建。

### 精确复跑与证据

私有目录 `/tmp/wemux-ticket02-remaining-7GyX9j` 保存 pre-edit copies/hashes、`red-management.json`、最终三个 result JSON 与 private dist。测试最后只清理自己 mkdtemp DB/邮件/provider/browser，不触碰旧服务或既有工作树数据。源码与证据不记录 PAT/code/token、完整敏感邀请链接。

```sh
RUN=$(mktemp -d /tmp/wemux-ticket02-remaining-review-XXXXXX)
node node_modules/vite/bin/vite.js build --config apps/web-next/vite.config.ts --outDir "$RUN/dist"
export PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs
export PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
export WEMUX_NEXT_TEST_DIST="$RUN/dist"
export WEMUX_TICKET02_EVIDENCE="$RUN/browser-result.json"
export WEMUX_TICKET02_MANAGEMENT_EVIDENCE="$RUN/management-result.json"
export WEMUX_TICKET02_OAUTH_EVIDENCE="$RUN/oauth-result.json"
node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-management.browser.mjs
node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-oauth-recovery.browser.mjs
```

### 管理覆盖轮交接时剩余清单（当前状态见角色交错节）

1. **本轮增量独立复核**：只有新重发缺陷修复及新增测试证据尚待 review；之前四项 + refresh P2 已批准。
2. **并发角色变化反馈**：现有单次角色调整、owner/admin 越权与所有权冲突、并发邀请接受均有证据，但未证明两个浏览器并发修改同一成员角色的 UI 反馈；现 API 无 expected-role/revision CAS，不擅增 API。需专门有界交错场景验证现有事务权威/界面刷新，按真实合同记录行为。
3. **外部前置**：实际 Google Provider 网络登录需可达 Provider/部署凭据，未提供故未测试；本地 verifier 全链路不是其替代声明。实际 SMTP 外网投递也不在私有 outbox 验收证明内。
4. **延期 gate**：Ticket01 依赖最终验收与完整 candidate/root gate 未运行，禁止用本轮局部通过批准部署/提交/移除旧版。

管理覆盖轮交接时结论（历史）：因此账号管理/审计/PAT/HTTP 降级/手机生命周期/本地 Provider 的上述既有浏览器缺口已经闭环，不再作为笼统“以后都待测”。本票保持 in-progress / locally-verified-with-residuals，不能把缺失并发角色证据勾成通过。

## 最后一个本地标准：角色变更交错与真实界面恢复

管理覆盖增量的独立 review 已完成（OK with notes、无缺陷），原四项 finding、refresh P2、邀请重发修复均不再待审。本轮只补该 review 指定的角色交错标准，**未发现新产品缺陷，没有任何生产代码、API、CAS 或刷新架构改动**。该脚本与角色交错证据已有独立增量复核 OK with notes / No issues found，parent 已接受其状态对账；不重新开启已批准结果，也不批准当前整棵工作树。

### 确切参与者与顺序

可重复脚本：`apps/web-next/tests/team-role-interleaving.browser.mjs`。每个 viewport 使用新的合成 owner、successor、target 账号。A/B 是**同一 owner 的两个独立 browser context、不同登录 Session**；C 是**另一身份 successor 的独立 context**。额外 target context 只用于通过公开邀请接受建立成员关系。测试断言 A/B 同 User 不同 Session，C 不同 User。角色写入与所有权转移均点击实际 UI 表单及确认；邀请 fixture 通过公开 API，结果通过公开成员/团队 API readback，不直接改角色数据。

1. **有效写入的到达顺序**：A 在 target=member 时提交 member，浏览器只暂缓该真实 PATCH 的发送；B 提交 admin 并收到成功，API 确认 admin；释放 A，A 收到 200 且 UI 显示角色已更新，API 确认最终 member。A/B 在两个事务执行时都还是 owner，所以两个写入都有效；这是服务端到达顺序的后写覆盖，**不是 optimistic conflict / CAS 检测**。没有把无冲突 200 改说成并发冲突。
2. **失去权威的旧请求**：再次暂缓 A 的 target→member 请求。B 通过实际表单把所有权转给另一身份 C，API 确认 C=owner；C 刷新后通过 UI 将 target 改成 admin。释放 A 的旧请求，服务端依据执行当时权限返回 403；共享 transport 的一次 CSRF-refresh 重试也不能放行。A 显示真实“只有 Team owner 可以调整治理角色”错误，API 确认 target 仍 admin，未发生越权覆盖。
3. **打开页面恢复**：在 A 已显示拒绝错误后触发窗口 focus，沿用已批准的焦点刷新；A 的 owner 角色编辑/转让按钮消失，目标行显示当前 admin，公开 teams readback 确认 A 自己已为 admin。C 仍可再次通过 UI 改 target 为 member，等待该真实 PATCH 200 后 readback 确认 member。此处证明明确的 focus 驱动恢复，不声明无请求 push 清屏，也不要求拒绝横幅在刷新后永久保留。

上述两个排序分别执行于 1440×900 desktop 与 390×844 mobile，**28 条 UI/API 断言全通过**。只控制第一次 PATCH 的发送时间，不伪造 response 或 authorization；循环/等待有界、无真实 Agent/模型。

### 本轮检查与复跑

```sh
RUN=$(mktemp -d /tmp/wemux-ticket02-role-review-XXXXXX)
node node_modules/vite/bin/vite.js build --config apps/web-next/vite.config.ts --outDir "$RUN/dist"
export PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs
export PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
export WEMUX_NEXT_TEST_DIST="$RUN/dist"
WEMUX_TICKET02_ROLE_EVIDENCE="$RUN/role-result.json" \
  node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/team-role-interleaving.browser.mjs
WEMUX_TICKET02_EVIDENCE="$RUN/browser-result.json" \
  node scripts/test-with-browser.mjs -- node --import tsx apps/web-next/tests/account-team.browser.mjs
node --experimental-strip-types --test apps/web-next/tests/{application,account-routes}.test.mjs packages/web-client/tests/*.test.mjs
node --import tsx --test apps/server/src/test/{team-management-http,team-management-edge-cases,team-membership-governance-http}.test.ts
npx tsc -p apps/web-next/tsconfig.json --noEmit
```

结果：真实 Chromium preflight 后新角色脚本 28 checks 通过，既有账号团队脚本 115 checks 通过，均双 viewport；focused client/application 36 tests、team server 14 tests、Next typecheck 与脚本语法检查通过。前轮管理 108 checks/local Provider 16 scenarios/完整 focused server 96 tests 是已 review 的历史结果，本轮不重复冒称新运行。

本轮私有 dist 与证据：`/tmp/wemux-ticket02-role-xmmJyJ`；包含预编辑 SHA256/copies、tracked baseline、`role-result.json` 与 `browser-result.json`。脚本新建临时 DB/outbox、动态 loopback 端口并只清理自身资源。没有生产服务/8010/8004、外网 Google 凭据、模型、根 build/test/install、shared dist、stage/commit/deploy。既有生产源码与 tracked diff 均未改。

### 当前票据标准结论与有限剩余事项

- **本地已满足**：注册/邮件验证重发/恢复/密码邮箱变更；本地 configured/unconfigured Provider 登录/绑定/解绑和最后方式保护；登录会话/PAT/生命周期；团队创建/邀请过期与重复/撤销重发/角色所有权及本节明确交错；CSRF、审计、负向权限与焦点/轮询撤权；desktop/mobile 账号邀请链路与错误恢复。具体证明边界按本文件各节，不把断言数量当作独立用户旅程数量。
- **没有已知未关闭的具体本地功能 blocker**。最后角色交错测试证据已独立增量复核 OK with notes / No issues found，parent 已接受该增量状态对账；不是再审已解决产品修改。
- **实际 Google 环境排除**：未访问真实 Google，没有外部凭据；生产 SMTP 投递也不由私有 outbox 证明。这两个部署条件保持明确，不阻断已完成的本地能力结论。
- **延期依赖/release gate**：Ticket01 最终依赖验收与完整 candidate/root gate 由父会话另行安排。本票本地覆盖完成不等于 full release approval，不授权提交/部署/删除旧版。

### 已完成 review 与 parent 接受范围

- 原独立 review：`/opt/data/.pi/agent/sessions/--opt-data-profiles-hacker-workspace-project-wemux-mini--/subagent-artifacts/outputs/bebb63cb-252d-496f-8bf0-44449600f38b/tickets/02/role-interleaving-review.md`，结论 **OK with notes / No issues found**，仅覆盖角色交错测试/证据增量。
- 状态对账：`/opt/data/.pi/agent/sessions/--opt-data-profiles-hacker-workspace-project-wemux-mini--/subagent-artifacts/outputs/6933c88c-5371-4c45-9e2c-e957de897c1f/tickets/02/role-evidence-closure-review.md`，结论 **OK with notes / No issues found**。parent 已接受此对账，只关闭该增量的独立复核待办。
- 对账不是新执行的代码审查、测试、构建或源码 hash 一致性复核，本次仅订正文档；不证明当前整棵 dirty tree 获准，也不扩为所有退休响应/私有 UI 身份转换的全面结论。实际 Google/SMTP、Ticket01 依赖、真实部署及当前部署身份、完整 candidate/root CI、独立像素/视觉 gate 均仍 OPEN；复合未勾选标准不变。

至此停止增加验收范围；本次文档订正交 parent 检查，不再重复该增量 reviewer 轮。外部/延期事项仍由父会话处理；尚未授权 provisional Ticket03→Ticket04 依赖例外，不启动 Ticket04 或改变其状态。
