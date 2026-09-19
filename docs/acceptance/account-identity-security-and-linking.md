# 接受验收：账号安全与登录方式（密码/邮箱恢复、绑定与解绑）

日期：2026-09-19
范围：Server 账号子系统（`account-security-service`）、账号自助路由与 Web 账号页；对应 Ticket 06（密码与邮箱恢复管理）与 Ticket 08（登录方式绑定与解绑）。
结论：**已实现并已验证**。两张票的自动化测试、真实浏览器跨票据验收与全量门槛全部通过；期间修掉 3 个真实缺陷（其中 2 个会让用户直接卡住或掉登录）。

## 变更要点

- 强认证：敏感操作（改密码、改邮箱、解绑）要求「当前密码」或「近期强登录」（Google-only 账号看 `session.authenticatedAt` 是否在窗口内，默认 5 分钟，`reauthenticateWindowMs` 可配）。**强认证失败返回 400 `invalid_current_password`，不是 401**：Web 客户端把任何 401 当成会话失效并登出，用户只是打错一次密码不该被踢出。
- 撤销面：改密码与重置只撤销「其它」会话与 PAT（当前设备保留并轮换令牌），响应与审计（`credentials.reset` / `credentials.password_changed`）回显 `revokedSessions` / `revokedTokens`，界面如实告知。
- 邮箱变更：`POST /auth/email/change` 校验当前密码 → 新邮箱收确认链接、旧邮箱收变更提醒 → `POST /auth/email/change/confirm` 整体替换 `user.email` 与 `user_emails` 索引（不新旧并存、不合并任何 User）。目标邮箱被占用给 `credentials.email_change_rejected`；链接被后发变更超越给 409 `email_change_superseded`；消费后重放给 409「该链接已被使用」。旧邮箱立即不能登录，**登录名与团队归属不受影响**。
- 一次性链接落地页：`apps/web/src/routes/auth-link.tsx` 同时承担密码重置与邮箱变更确认，先展示再 POST 消费，扫描器 GET 不消耗凭据；服务端原话直接显示（不吞成通用错误）。
- 绑定登录方式：`POST /auth/identities/google/start` 创建带 `intent: 'link'` 的 OAuth 事务并绑定发起会话，回调只接受发起它的浏览器与会话；成功后 302 回 `/settings?linked=google`，**不签发新会话**；身份行以 `(provider, issuer, subject)` 落库，已属于其他 User 时拒绝，不做自动合并；绑定邮箱不同不改主邮箱与 Team Membership。
- 解绑与最后一种方式：`DELETE /auth/identities/:id` 要求强认证；删除后只剩一种方式则前后端同时拒绝。前端把唯一方式的按钮禁用，后端仍以 409 `last_login_method` 兜底（只靠界面不算数）。
- Google-only 账号：可在强认证窗口内直接设置本地密码（`POST /auth/password/change`），由此获得第二条登录方式；本地账号绑定 Google 后可解绑任一条。
- 路由与视图：`GET /auth/account/security` 只读列出登录方式与投递状态；账号页四个分区（密码 / 邮箱 / 登录方式 / 会话）在 `apps/web/src/components/account-page.tsx`。
- 顺带修正：邮箱注册路径的登录名派生不再把邮箱当用户名（`auth.ts` 的 `resolveUsername` 只接受登录名，邮箱注册走 `verifiedUsername`），与「邮箱只作标识、登录名为独立入口」对齐。
- 迁移：新增一条账号线迁移（append-only，`accountMigrations` 尾部）——`verification_challenges` 的 `purpose` CHECK 原有 `verify_email|reset_password` 不包含新用途，SQLite 不能就地改约束，因此同事务重建表并把进行中的挑战（含哈希与消费状态）原样搬过去，重建后重建索引与不可变触发器。

## 可重复验证

```bash
npm run build --workspace @wemux/web      # 脚本读 apps/web/dist，改前端后必须先重建
npm run typecheck
npm test
cd apps/server && npx tsx --test src/test/account-security.test.ts
cd ../.. && WEMUX_KEEP_SHOTS=1 node --import tsx apps/server/scripts/verify-wave-c.mjs
```

真实结果（2026-09-19，本机）：

- `npm run typecheck`：8 个 workspace 全绿，0 个 TS 错误。
- `npm test`：server/worker/packages 615 tests / 610 pass / 5 skipped / 0 fail；`@wemux/web` 165 tests / 165 pass，exit 0。
- `account-security.test.ts`：9 pass / 0 fail（找回不可枚举与重放、改密码撤销面、改邮箱冲突与一次性、安全视图与唯一方式、绑定会话归属与抢绑、Google-only 设密码、秘密边界）。
- `verify-wave-c.mjs`：9 条断链全过 + 4 张截图（本轮 `/tmp/wemux-wave-c-Puwi1a`，EXIT=0）。账号面板四分区与唯一方式禁用；找回对已注册/未注册邮箱同形（202 + 掩码邮箱）；重置链接点击才消费并撤销 2 个会话与 1 枚 PAT；改密码错密码 400 且不动其它会话、正确密码保留当前设备；改邮箱新旧各收一封、确认链接在未登录浏览器生效且重放失败、旧邮箱 401 / 新邮箱 200 / 登录名 200；绑定 Google 回调带 `linked=google` 且不签发新会话；解绑错密码不删行、正确解绑回落到唯一方式、后端 409 `last_login_method`；一次性令牌只存哈希、密码与 PAT 与令牌原文不落库不落审计。
- 同轮网络足迹：无 5xx；4xx 只有预期的拒绝路径（错密码 400、重放 409、最后方式 409）与两类已记录的成员侧控制面 403（`/api/workers`、`/api/projects`，等 Ticket 10/12）。

## 未覆盖与风险

- 并发重置/并发绑定没有做真并发压测：重置由「同一链接只能消费一次」锁定，绑定由 `(provider, issuer, subject)` 唯一键与抢绑分支锁定。
- 真实 SMTP 与真实 Google 端点未验收（沙箱无外网）：邮件走 `WEMUX_MAIL_OUTBOX` 本地出件箱，绑定用本地替身 IdP（只替换授权页与令牌端点，`jose` 验签、PKCE、state/nonce 一次性消费仍是生产代码路径）。
- 本波是单实例验收，不含多节点；唯一新增迁移（`verification_challenges` 重建）由 `account-upgrade.test.ts` 的旧库升级与重放用例覆盖，且它挂在账号迁移列表末尾，`firstAccountMigrationVersion` 边界不变（升级保留既有归属、不静默提权）。
- 浏览器验收依赖沙箱缓存的 `playwright-core@1.61.0` 与 `chromium-1228`（可用 `WEMUX_PLAYWRIGHT` / `WEMUX_CHROME` 覆盖）。

原始证据（逐条断言与截图目录）：`.scratch/product-convergence/evidence/wave-c-cross-ticket-acceptance.md` 与 `scripts/verify-wave-c.mjs` 的运行输出。