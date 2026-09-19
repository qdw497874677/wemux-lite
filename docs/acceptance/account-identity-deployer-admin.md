# 接受验收：部署者即管理员（账号与实例授权根切换）

日期：2026-09-19
范围：Server 账号/身份子系统与 Web 落地页；把实例授权根从「引导令牌首次认领」改为「部署声明管理员邮箱」。
结论：**已实现并已验证**。无引导令牌、无 `instance_claim`、无 `POST /api/auth/setup`；声明邮箱命中即实例管理员，注册策略不再拦它。

## 变更要点

- 授权根：`WEMUX_ADMIN_EMAILS`（逗号分隔、大小写不敏感，`createWemuxServer({ administratorEmails })` 等价）。缺失时 Server 拒绝启动，不再有「第一个公开注册者成为管理员」。
- 账号路径不变：声明邮箱仍需自己注册 + 邮件验证；`invite_only`/`closed` 下声明邮箱放行，审计 `identity.registration_allowed` / `identity.oauth_registration_allowed` 带 `reason: declared_administrator`。
- 删除：`POST /auth/setup`、`instance_claim` 记录、引导令牌凭据类型与首次认领表单；`POST /auth/session` 仍是 410 `retired_endpoint`。
- 恢复：改管理员只改环境变量；`node dist/cli.js credentials reset-password|revoke` 仍是唯一的主机本地凭据恢复入口（审计 `credentials.recovered` / `credentials.revoked`）。
- 首次启动必须能自举：`apps/web/src/components/landing.tsx` 的注册入口不再只看「策略开放」，声明邮箱未建号时也放出注册表单（`declaredFirstRun`）。否则默认 `invite_only` 的空白实例谁也当不成管理员：服务端豁免声明邮箱，界面却没有入口。

## 可重复验证

```bash
npm run typecheck
npm test
node --import tsx apps/server/scripts/verify-account-login.mjs
node --import tsx apps/server/scripts/verify-deployer-bootstrap.mjs
node --import tsx apps/server/scripts/verify-email-registration.mjs
node --import tsx apps/server/scripts/verify-google-login.mjs
node --import tsx apps/server/scripts/verify-wave-ab.mjs
```

真实结果（2026-09-19，本机）：

- `npm run typecheck`：10 个 workspace 全绿，0 个 TS 错误。
- `npm test`：server/worker/packages 606 tests / 601 pass / 5 skipped / 0 fail；`@wemux/web` 160 tests / 160 pass。
- `verify-account-login.mjs`：13 条断言全过。落地页只有「账号或邮箱 + 密码」与注册入口，`#auth-bootstrap` 计数为 0；`/api/auth/setup` 已不可用（未鉴权 401 / 未知路由 404）；错误密码提示明确；会话列表撤销、CSRF 缺失 403、退出即失效、CLI 重置密码后旧密码失效。
- `verify-deployer-bootstrap.mjs`：全过（新增，覆盖之前的盲区：四个旧脚本都先把管理员账号直接写进数据库），共 7 个环节、约 20 条断言、4 张截图。全新空库 + 只声明 `WEMUX_ADMIN_EMAILS` + 本地出件箱，真实进程真实浏览器：落地页可达注册入口且说明“声明邮箱是例外”；未声明邮箱直连 API 仍 403 `invitation_required`（策略没被放宽）；部署者用声明邮箱注册 → 从 `.eml` 取链接 → 打开/刷新不消费 → 点击激活即进入控制台；`/api/auth/me` 为 `instanceAdministrator=true`，能读 `/api/projects` 与注册策略（默认仍是 `invite_only`）；审计有 `identity.registration_allowed`（`reason=declared_administrator`、邮箱脱敏 `d***@wemux.test`）与 `instance.administrator_assigned`（`channel=declared`）；`POST /api/auth/setup` 404。
- `verify-email-registration.mjs`：21 条断言全过。默认 `invite_only` 无注册入口且直连 API 403；管理员在账号页放开后邮箱注册 → 待验证 → 站内确认页（打开不消费）→ 激活即登录；新账号控制面 403 `admin_required`；找回密码后旧会话与旧密码全部失效；`closed` 下入口消失、API 403，已登录账号不受影响。
- `verify-google-login.mjs`：13 条断言全过。未配置时零 Google 入口；声明管理员登录后出现 Google 入口；deep link 回跳、PKCE/state/nonce 校验、策略拒绝（`registration_closed` / `invitation_required`）与审计秘密零出现。
- `verify-wave-ab.mjs`：14 条断言全过。三种身份（密码/邮箱注册/Google）并存互不干扰，退出只撤销自己；血缘路由对成员 403 `admin_required`；实例配置读写均 403；`/auth/verify-email` 与 `/auth/password/reset` 返回页面而 `/api/auth/*` 仍是 API；令牌只存哈希且用后消费。

## 未覆盖与风险

- 部署前置：声明邮箱必须真的能收到验证邮件；未配置邮件投递时注册返回 503，本模型无法自举。这是有意失败，不会静默把无邮件投递变成“注册成功”。

- 未做真实 Google 提供方验收（脚本用本地替身 IdP：只替换授权页与令牌端点，`jose` 验签仍是生产代码）。
- 多实例/多部署并发声明未验证（部署声明是纯配置，不存在竞态写入）。
- 已有实例的升级映射（占位管理员账号 → 真实部署者账号）只覆盖到「声明邮箱未注册时界面如实提示」，历史数据的批量归属改写未实现。