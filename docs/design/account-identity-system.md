# 账号、注册与 Google 登录设计

状态：设计提案，未实现、未验收。已确认需求为完整账号系统、账号注册与 Google OAuth 登录；下述默认策略是建议实施基线。对应路线图 A0–A3 / M6，不以登录成功宣称团队权限已完成。

依据：[产品方向](../product-direction.md)、[领域术语](../../CONTEXT.md)、[路线图](../roadmap.md)。

## 1. 范围与关键决定

- Server 提供邮箱密码注册/登录，以及 Google OpenID Connect 登录（OAuth 2.0 授权码流程）；两者最终得到同一类 Wemux User 与本地登录会话。
- 账号与登录方式分离：稳定 UserId 关联本地密码和外部 Login Identity。Google 身份以已验证的 `(issuer, subject)` 唯一识别，邮箱不是身份主键；同邮箱不得静默绑定或合并。
- 注册、加入 Team、获得 Project/Worker/Session 权限是三步。新账号不加入 Default team，不取得已有 Worker 或聊天内容的访问权。
- Server 与 Worker 独立身份域继续分离。首版 Google 登录配置在 Server；Worker 独立工作台保留本机初始化和本地登录，不向公网开放任意账号注册。不复制密码、Cookie 或 Google 凭据到 Worker，不因加入集群自动创建同名用户。
- 共享密码校验等机制不等于共享账户数据库。Google 登录不提供 Google Drive、模型、Git 或 Agent CLI 的授权，执行 Secret 仍在 Worker。
- 保留 node:http + SQLite。OIDC/JWT 使用维护中的标准库，不手写签名验证；选型时记录版本、依赖体积和安全更新成本，不为登录引入独立身份服务器或 Broker。

## 2. 用户路径与产品策略

### 2.1 首次初始化与旧实例

- 授权根是部署声明：管理员邮箱由部署者通过 `WEMUX_ADMIN_EMAILS`（逗号分隔，大小写不敏感）声明，命中者即实例管理员。不设引导令牌、不设首次认领表单，也不允许“第一个公开注册者成为管理员”。
- 管理员账号走正常账号路径：声明邮箱先注册并验证，就成为实例管理员；注册策略收紧（`invite_only`/`closed`）不得拦截被声明邮箱，但仍需邮箱验证，不能靠隐藏按钮绕开。未声明任何管理员邮箱时，实例拒绝签发任何管理员权限并如实说明原因。
- 实例管理权限与 Team owner 分离，不自动允许读取所有私人会话。可随后绑定 Google，但本地恢复入口不能依赖 Google 可用性。
- 已有实例升级：只需把管理员邮箱写进部署声明（新增或替换 `WEMUX_ADMIN_EMAILS`），声明邮箱自己注册并验证后即为实例管理员；旧的管理员账号不被自动接管，也不重写历史审计冒充真实用户。旧实例上遗留的合成操作者归属（历史任务/会话的 actor）盘点与批量改写**未实现**，不能声称已完成迁移。
- 丢失管理员凭据通过主机本地、显式、可审计的恢复命令处理，不重新开启公网首次注册；改管理员只需改部署环境变量，不需要任何认领或初始化流程。

### 2.2 注册开关

| 策略 | 邮箱注册 | 首次 Google 登录 | 已有账号登录 |
| --- | --- | --- | --- |
| `open` | 验证邮箱后激活 | 验证身份后建号 | 允许，仍检查账号状态 |
| `invite_only`（建议默认） | 有效邀请 + 接收者验证后建号 | 有效邀请 + 接收者验证后建号 | 允许，仍检查账号状态 |
| `closed` | 禁止，包括邀请建号 | 禁止新建账号 | 允许；已有账号可接受有效团队邀请 |

初始化完成前所有公开注册关闭（被声明邮箱不受影响）；`open` 和 `invite_only` 对不互信用户开放前必须通过 A3 授权门槛。配置决定允许的流程，前后端同时执行，不能靠隐藏按钮限制。Provider 故障不改变注册策略。

### 2.3 邮箱密码注册、验证与找回

1. 落地页提供内联“登录 / 注册”，注册收集邮箱、显示名称、密码；用户名仅作为兼容字段或独立可选别名，不能由 Google 邮箱强行推导唯一 username。
2. 提交创建待验证注册记录，发送一次性验证邮件；验证成功时原子创建 User 与密码凭据。注册时预设的密码仅保存为带盐哈希。
3. 未验证注册不占用已验证账号的永久身份，也无资源访问权。重复提交给统一提示并限流；验证时遇到已存在账号则走登录/找回，不覆盖旧密码。
4. 支持重发验证邮件、过期恢复、忘记密码与重置。重置只更新已存在本地登录方式；Google-only 用户通过 Google 登录后近期重新认证再增加密码，不能凭找回流程隐式创建密码。
5. 重置密码后撤销全部登录会话与 PAT，并要求重新登录；普通修改密码需要旧密码或近期强认证，可保留经轮换的当前会话。邮箱修改必须验证新邮箱、通知旧邮箱，并重新检查唯一性，不自动改变 Google 身份绑定。
6. 邮箱规范化采用明确规则：去首尾空白、规范化域名、产品级大小写不敏感唯一约束；保留原始展示值，不做 Gmail 去点或去 `+tag` 的供应商别名合并。

邮件投递是本地自助注册/找回的组成部分，不推迟到 M7。支持配置 SMTP，连接超时、有限重试和可见失败；不要求本机部署邮件服务器。无邮件配置时关闭邮箱自助注册/找回，允许受控本机初始化、已有账号登录及满足验证规则的 Google 注册；界面明确说明，不模拟“发送成功”。邀请可由管理员手动分享链接，但链接本身不替代接收者邮箱所有权验证。

### 2.4 Google 首次与再次登录

- 登录/注册页共用“使用 Google 继续”，采用顶层重定向，适配手机，不依赖弹窗或第三方 Cookie。
- 已绑定 `(issuer, subject)`：登录原 User，检查禁用/删除与实例策略；Google 邮箱变动不创建新 User、不自动修改本地已验证邮箱。
- 未绑定且邮箱无冲突：按注册策略创建 Google-only User，不生成默认密码；完成条款/显示名称等必要确认后进入团队选择或空态。
- 未绑定但邮箱已被其他 User 使用：不签发该 User 的会话，不自动合并；提示通过已有方式登录后到“账号安全”绑定 Google，无法登录则走已有恢复渠道。
- 只将 `email_verified` 且符合 Google 邮箱权威条件（Gmail，或已验证的 Workspace `hd`）作为该邮箱的证明；其他第三方邮箱即使 `email_verified` 为真，涉及新建已验证邮箱、邀请匹配或恢复时仍做本站邮箱验证。登录身份本身始终取 `(issuer, subject)`。
- Google 授权取消、超时、网络失败、配置错误返回明确可重试状态；错误页不显示 code、Token、client secret 或完整 Provider 响应。

### 2.5 绑定、解绑与账号生命周期

- 绑定 Google 必须从已登录账号安全页发起，要求 5 分钟内重新认证；OIDC transaction 绑定当前 UserId、登录会话与 `link` 意图，回调时重新校验会话有效性。
- 验证新 Google 身份控制权后显式确认；身份已属于另一 User 则拒绝，首版不提供自动账号合并。绑定邮箱不同可明确确认，但不改变主邮箱与团队成员关系。
- 解绑、增加/删除密码、修改邮箱、签发 PAT、销号均要求近期重新认证；不以普通 Cookie 活跃时间冒充重新认证。Google-only 用户需新的交互认证并验证满足新鲜度，不能仅凭普通静默授权标为强认证。
- 禁止移除最后一种可用登录方式；Provider 被实例禁用时提示受影响用户先配置替代登录。实例管理员至少保留经验证的本机恢复路径。
- User 状态为 `active | disabled | deletion_pending | deleted`；待验证注册独立存放。停用立即阻止登录、撤销会话/PAT并触发流连接撤权。
- 销号前转移 Team/Project/Worker 等所有权，保护最后一个 Team owner 与最后一个实例管理员；处理进行中执行并显式确认，不自动删除团队聊天或 Worker 文件。保留必要审计归属，按保留策略去标识个人资料；Google subject 的防复用占位与保留期限需记录在隐私规则中。

### 2.6 团队入口

- 首版支持创建团队和接受邀请。创建团队受实例策略与配额控制，创建者仅成为该新 Team owner，不取得其他 Team 资源。
- 邀请绑定 teamId、目标邮箱、授予角色、邀请者、期限；随机令牌仅保存哈希，单次消费，可撤销。接受时重新校验邀请者仍有管理权、Team 有效、接收者已验证邮箱匹配以及成员资格。
- 邀请消费与 Membership 建立同事务；双击/回调重试不得重复成员或升级权限。已有成员接受邀请不得隐式提升角色；升权通过独立管理操作。
- 成员移除与相关 Grant 撤销同事务，立即影响查询、通知、下载、实时订阅与新执行。进行中执行进入撤权策略，不将断线误当执行停止。

## 3. 概念记录与不变量

下表是设计记录，不是声称现有类型已支持。公共 User DTO 不包含密码、身份令牌或管理秘密。

| 记录 | 关键字段/职责 |
| --- | --- |
| User | 稳定 id、显示名称、已验证主邮箱、状态、认证版本、时间；不内嵌 Team 角色 |
| LocalAccountCredential | userId、带算法/参数版本的密码哈希、更新时间 |
| ExternalLoginIdentity | userId、provider、规范 issuer、subject、Provider 邮箱及证明状态、绑定时间；唯一 `(issuer, subject)` |
| RegistrationAttempt | 待验证邮箱、密码哈希、到期/消费状态，不产生资源授权 |
| LoginSession | 独立于对话 Session：tokenHash、userId、认证方式/时间、空闲和绝对到期、撤销与认证版本 |
| OAuthTransaction | stateHash、浏览器绑定、nonce、短期 PKCE verifier、provider、login/link 意图、UserId、返回路径、到期/消费状态 |
| VerificationChallenge | tokenHash、userId 或注册记录、目标邮箱、用途、到期与消费状态；用途不可互换 |
| TeamInvitation | teamId、目标邮箱、角色、tokenHash、邀请者、期限、消费/撤销状态 |
| PAT | userId、tokenHash、scope、期限、撤销状态；有效权限始终与当前资源授权取交集 |

必须原子保证：邮箱唯一性、Google 身份唯一性、邀请码消费、初始化单次完成、最后 Owner/最后登录方式保护、成员撤销与 Grant 失效。账号状态及认证版本必须参与每次认证，不能依赖登录时快照。

现有 SQLite KV 可复用，但不等于“不需要迁移”：实施前明确记录版本、唯一键/索引、回填与冲突报告，审查历史管理员归属和旧 PAT/会话识别。歧义数据不得静默合并或直接赋予权限。先备份，演练升级失败与恢复；旧 `wemux-session-*` 不继续享有管理员特权，升级后要求重新登录。旧无 scope PAT 默认失效并重新签发，而不是猜测权限。

## 4. Google OIDC 与自托管部署

```text
浏览器 → Server 创建登录事务 → Google 授权页
Google → Server 固定 callback（code + state）
Server → Google 换取并验证 ID token → 查找/建立 Login Identity
Server → 签发本站 HttpOnly Cookie → 团队选择 / 原授权页面
```

- 使用 Authorization Code + PKCE S256、一次性 state 和 nonce；state 绑定发起浏览器，所有登录/绑定事务短期有效、原子消费。重放、浏览器不匹配、意图变更、会话已退出均拒绝；回调失败重新开始，不复用 authorization code。
- Server 交换 code，验证签名、允许算法、issuer、audience、必要的 azp、exp/iat 和 nonce；规范化 Google 合法 issuer 写法后再生成唯一键。不以解码 JWT 或调用调试 tokeninfo 接口代替生产验证。
- Discovery/JWKS 只取固定 Google 端点，缓存并处理密钥轮换；网络/未知密钥验证失败时关闭该次认证，不降级信任客户端资料。
- scope 仅 `openid email profile`；不请求 offline access，不持久保存 Google access/refresh token。短期 token 不进入 URL 后续跳转、日志、浏览器存储或 Worker。
- `returnTo` 仅允许已验证的站内相对路径，拒绝 `//`、跨源 URL 及编码绕过；邀请上下文放在服务端事务，不信任回调参数里的 teamId/role。
- 自托管管理员配置 Google Cloud 的 Web application Client ID、Client Secret、同意屏幕和精确 callback。环境变量：`WEMUX_PUBLIC_URL`、`WEMUX_GOOGLE_CLIENT_ID`、`WEMUX_GOOGLE_CLIENT_SECRET`；已实现（Ticket 07）。半配置（只给其一）在启动时直接失败，不拖到用户点击才发现；未配置时不渲染 Google 入口。
- 回调固定为 `${WEMUX_PUBLIC_URL}/api/auth/oauth/google/callback`，不从任意 Host/X-Forwarded-Host 构造。代理头仅信任显式代理来源。
- 正式部署使用 Google 允许的 HTTPS 域名和精确注册的重定向 URI；localhost 开发例外单独配置。现有 LAN/Tailscale 裸 IP HTTP 入口不能直接视为可用 Google 回调，需要合规域名/HTTPS配置，不承诺每种 tailnet 域名都被接受。
- 本地账号仍支持显式受信内网 HTTP 模式，但禁止把公网 HTTP 当作安全账号部署；OAuth 未配置时落地页与账号弹窗都不出现 Google 按钮（用户可见面零噪声），配置说明写在部署文档；不显示不可用的假登录按钮。
- SMTP/Google Client Secret 只在 Server 配置边界保存，不下发 Web，不与 Worker Enrollment 或 Execution Credentials 混用；没有公网 Google 网络时本地账号仍可用。

## 5. 会话与安全基线

以下防护随首次登录/注册交付，不得等 A2 才补：

- 密码复用经过审查的 scrypt 带盐方案，存算法版本与参数，验证后按需升级；无 MFA 时建议至少 15 字符，支持至少 64 字符长密码、粘贴与密码管理器，不强迫周期更换。限制请求大小与哈希并发，避免注册耗尽内存/CPU。
- 32 字节随机不透明登录令牌，服务端只保存哈希；Cookie 为 HttpOnly、SameSite=Lax、host-only，HTTPS 使用 Secure，HTTP 仅显式内网模式。跨宿主/端口部署需隔离 Cookie 名与作用域，不能误收另一安装的会话。
- 建议默认：登录空闲 24 小时、绝对期限 7 天；敏感操作重新认证窗口 5 分钟；OAuth 事务 10 分钟；验证邮件 24 小时；密码重置 30 分钟；邀请 7 天。均在测试中用可控时钟验证，不延长绝对期限假装无限续期。
- 登录/重新认证轮换会话令牌，退出当前设备、退出所有设备和设备会话列表可用；Cookie 退出、跨站写入、登录 CSRF 同时采用 Origin 检查与 CSRF token，SameSite 不是唯一防线。OAuth callback 使用已绑定的 state/nonce 事务验证。
- 注册、登录、验证重发、找回、OAuth start/callback 多维限流，错误不泄漏账号是否存在；鉴权接口和回调 `Cache-Control: no-store`，敏感跳转页 `Referrer-Policy: no-referrer`，不加载第三方统计脚本；邮件链接先展示确认再 POST 消费，避免扫描器 GET 即消耗凭据。
- 邮件/恢复挑战只存哈希，短期 PKCE verifier 必须可读取但受服务端私密存储与到期清理保护。日志/审计屏蔽密码、code、state、Cookie、Token、验证链接、SMTP 和 OAuth Secret。
- PAT 不进入 Cookie；登录会话不作为 CLI 长期凭证；PAT 只显示明文一次，撤销/禁用及时生效，不缓存过期权限。
- 撤权立即终止或重新鉴权 SSE/WebSocket 订阅，禁止继续发私有事件。执行撤权发送可追踪取消，离线 Worker 标待送达；Worker 在恢复/续执行前重新确认授权，不能把“已发取消”标为“已停止”。

### 5.1 已交付：部署声明的管理员与登录会话（Ticket 04）

本节记录上面策略的**已实现**形态，避免设计目标与现状混淆；未列出的条目仍是目标而非现状。

- 管理员：`WEMUX_ADMIN_EMAILS`（或 `createWemuxServer({ administratorEmails })`）声明邮箱，命中即实例管理员（审计 `instance.administrator_assigned` / `instance.administrator_recovered`）；声明邮箱在 `invite_only`/`closed` 下仍可注册（`identity.registration_allowed`、`identity.oauth_registration_allowed` 审计里标注 `declared_administrator`），其他邮箱照旧受限。没有引导令牌、没有 `instance_claim`、没有 `POST /auth/setup`；未声明任何邮箱时任何账号都不会获得管理员权限。账号为 `user` 记录，密码存 `local-credential`（`scrypt$v1$N=16384,r=8,p=1`，独立盐值）。
- 登录会话：独立 `login_sessions` 表（32 字节令牌只存 SHA-256 哈希，另有 CSRF 哈希、空闲/绝对过期、`revoked_at`），Cookie 为 `wemux_login_session`，HttpOnly、SameSite=Lax、host-only，路径 `/`；接口 `GET /auth/options`、`POST /auth/login|logout|logout-all`、`GET /auth/me|auth/sessions`、`DELETE /auth/sessions/:id`。写操作同时校验 Origin 与 `X-CSRF-Token`；`GET /auth/me` 在缺少或不匹配 CSRF 时轮换令牌并一次性返回新明文。
- 凭据隔离：浏览器 Cookie 只能作为登录会话使用，Bearer 只能作为 PAT 使用；`wemux-session-*` 前缀明确拒绝（`retired_credential`），PAT 要求非空过期时间。
- 主机本地恢复：`node dist/cli.js credentials list|reset-password|revoke`（`apps/server/src/application/recovery.ts` 提供 `AccountRecovery`）。它只在 Server 所在主机的进程内可用，不注册任何 HTTP 路由，也不签发会话：`reset-password` 撤销该账号全部登录会话与（默认）PAT、写审计 `credentials.recovered`，明文密码只在 stdout 出现一次；`revoke` 只清凭据并写审计 `credentials.revoked`。改实例管理员只需改 `WEMUX_ADMIN_EMAILS`；若新邮箱还没有账号，仍需它自己完成注册与验证。审计元数据只记录 `channel: host-local` 与撤销计数，不含任何秘密。
- 秘密屏蔽：密码、会话/CSRF 令牌、PAT 不得出现在审计、落盘明文或 CLI 输出；由 `apps/server/src/test/account-redaction.test.ts` 以“全库字节扫描 + 审计字段检查 + CLI 输出检查”回归锁定。

### 5.2 已交付：邮箱注册、验证与找回（Ticket 05）

- 注册与挑战：`POST /auth/register|register/resend|password/forgot|password/reset`、`POST /auth/email/verify`。注册先写待验证记录（`registration_attempts`，密码只存哈希、含用户名与显示名候选），验证通过才原子创建 `user` + `user_emails` + `local-credential` 并直接签发会话；重发沿用原候选，找回只更新已存在本地登录方式。
- 令牌模型：`verification_challenges` 行只存 SHA-256 哈希，带 `kind`（`verify_email` | `reset_password`）、`expiresAt`、`consumedAt`；邮件链接先到站内确认页，点确认才 POST 消费（扫描器 GET 不会消耗凭据）。
- 投递：`apps/server/src/mail/mail-connection.ts` 解析 `WEMUX_SMTP_URL`/`WEMUX_SMTP_FROM`/`WEMUX_PUBLIC_URL`，未配置时关闭自助注册与找回并在界面如实说明原因；`WEMUX_MAIL_OUTBOX` 可把邮件写成 `.eml` 供联调与验收。
- 注册策略：`instance_settings` 存 `registrationPolicy`（默认 `invite_only`，可 `open`/`closed`），`GET /auth/options` 公开 `registration.emailDelivery` 与策略，`PATCH /api/settings/registration-policy` 仅实例管理员可改并写审计。
- 反枚举与限流：注册、重发、找回响应形状统一（`accepted` + 掩码邮箱），登录、注册、重发、找回、OAuth start/callback 分维度限流；密码策略最短 15 字符（`passwordPolicy.minimumLength`）。

### 5.3 已交付：Google 注册与登录（Ticket 07）

- 身份模型：`login_identities` 存 `provider/issuer/subject` 唯一键（`subject` 与 `issuer` 规范化后再建键），`User.email` 与 `user_emails` 索引保持一致（注册时写索引）；同邮箱已属于其他账号时拒绝静默合并（审计 `identity.oauth_email_conflict`）。
- 邮箱权威边界：只有 Gmail/Googlemail，或 Workspace（ID token 带 `hd`）且邮箱域名与 `hd` 一致时，Google 声明的已验证邮箱才算本站邮箱证明（`isGoogleAuthoritativeEmail`）并写入 `user_emails`、参与同邮箱冲突判定；其他第三方邮箱即使 `email_verified=true` 也只随登录身份保存（`login_identities.email_at_sign_in`/`email_verified`）用于展示与排查，不建本站已验证邮箱，审计以 `emailAuthority: site_verified | provider_claim` 区分。
- 浏览器流：`POST /api/auth/oauth/google/start` 创建 OAuth 事务（`oauth_transactions`：state 与 nonce 哈希、PKCE verifier、`returnTo`、到期与消费时间），state 只通过 host-only Cookie 回给发起浏览器；`GET /api/auth/oauth/google/callback` 校验 state/PKCE/nonce 后换 token 并验签 ID token（issuer、audience/azp、exp/iat、签名与算法白名单），成功签发与密码登录同构的 Cookie 会话并把 `authenticationMethod` 记为 `google`。
- 失败语义：回调永不返回 JSON，一律 302 回落地页并带 `oauth_error=<code>`（`state_mismatch`、`state_replayed`、`email_conflict`、`registration_closed`、`invitation_required`、`google_verification_failed`、`google_unavailable` 等）；前端 `apps/web/src/lib/oauth-error.ts` 翻译成人话并立刻从地址栏清除，刷新不复活旧错误。
- 策略联动：首次 Google 登录服从实例注册策略与邀请要求（部署声明的管理员邮箱除外），已有绑定不受策略收紧影响；纯 Google 账号不生成默认密码，自带密码可通过 `/account/password` 补设而不覆盖已有凭据。
- 回跳与路径边界：回调路径固定为 `/api/auth/oauth/google/callback`，`returnTo` 经 `safeReturnTo` 只接受站内相对路径（拒绝协议相对、绝对 URL、反斜杠与控制字符）；`/api` 命名空间内的未知路径不再回落 SPA，端点拼错时返回 404 而不是 200 HTML。
- 秘密边界：client secret、authorization code、ID/access token、state、nonce 与 PKCE verifier 不进审计与日志（`apps/server/src/test/google-auth-routes.test.ts` 以审计序列化字符串扫描回归锁定）；access token 不落盘、不转发给浏览器，退出登录不影响 Google 侧会话。

## 6. API 与交互切片

以下全部为设计目标，统一挂 `/api`，不暗示已存在这些接口。鉴权写操作遵循幂等、CAS 和专用一次性令牌语义，不能缓存含秘密响应。

| 分组 | 拟议入口 |
| --- | --- |
| 能力/初始化 | `GET /auth/options`（公开安全配置，含管理员是否已声明与注册策略） |
| 注册/验证 | `POST /auth/register`、`POST /auth/email/verify`、`POST /auth/email/resend` |
| 登录/会话 | `POST /auth/login`、`POST /auth/logout`、`POST /auth/logout-all`、`GET /auth/me`、`GET /auth/sessions`、`DELETE /auth/sessions/:id` |
| 找回 | `POST /auth/password/forgot`、`POST /auth/password/reset` |
| Google | `POST /auth/oauth/google/start`、`GET /auth/oauth/google/callback` |
| 账号安全 | `POST /account/reauthenticate`、`GET /account/identities`、`POST /account/identities/google/link`、`DELETE /account/identities/:id`、`PUT /account/password`、邮箱变更发起/确认、停用/销号 |
| 团队 | Team 创建/选择、成员管理、邀请创建/撤销/接受、所有权转移 |
| 客户端 | PAT 创建/列表/撤销/轮换，审计检索 |

交互：落地页内联登录/注册，邮箱待验证页、忘记/重置密码页、Google 失败页、首次团队选择/空态、账号资料与安全页、团队成员与邀请页、实例登录策略设置。所有入口有加载/失败/重试/过期状态、桌面/手机与键盘路径；原应用内连接弹窗仅承担重连，不替代账号落地页。

## 7. 实施顺序与验收门槛

保留原 A0–A3 编号，A0 内细分，不把 Google 登录推迟到远期：

1. **A0.1 账号与会话基座**：稳定 User/身份/登录会话、初始化和旧数据升级；基础安全与双宿主隔离。
2. **A0.2 本地注册与恢复**：邮箱密码注册、邮件验证、找回、登录/退出与安全页；SMTP 生命周期。
3. **A0.3 Google OIDC**：新账号注册、已有账号登录、显式绑定/解绑、异常与部署配置；真实 Google 浏览器验收。
4. **A1 团队加入**：Team 创建、邀请与成员生命周期；与 A3 同时定义授权契约。
5. **A2 凭证管理**：PAT 与设备管理/审计完善，不延后 A0 的 CSRF、限流与秘密保护。
6. **A3 全路径授权**：所有查询/写入/实时订阅/执行的权限及撤权。A0 完成仅可受控验收；A3 未验收前不得开放不互信多用户。P2 委派不得绕过此门槛。

至少覆盖以下可重复场景，实际执行才创建 acceptance 报告：

- 全新与旧实例升级、声明邮箱的非管理员/占位账号回收、无 scope 旧 PAT、升级失败恢复；既有项目/Worker 归属不丢。
- open/invite_only/closed 在邮箱和 Google 两条路径一致生效；新账号无法访问 Default team，邀请过期/撤销/重复/目标不匹配均拒绝。
- 邮箱注册、重发、扫描器访问、验证/找回过期与重放、枚举防护、SMTP 断网、并发相同邮箱、限流与哈希资源上限。
- Google 首次/重复登录、拒绝授权、错误 audience/issuer/signature/nonce、state 跨浏览器/重放、code 复用、PKCE 错误、JWKS 轮换、Secret 错误与网络失败。
- 同邮箱本地/Google 不自动合并、不同 Google subject 不冒用、邮箱改变仍登录原账号、第三方邮箱所有权再验证、绑定时退出/换用户、并发绑定与最后登录方式保护。
- Cookie 固定攻击/跨站写入/开放重定向、手机回跳、HTTPS 代理、明确内网 HTTP 边界、两个宿主凭据互不接受。
- 退出/重置/停用后会话和 PAT 失效；两个 Team、多角色、私人/共享资源及已打开实时流撤权，实际操作者审计可追踪。
- 用户提供自托管 Google Client 配置与测试账号后进行真实 Google 流程；未配置时只能标模拟协议测试通过、真实验收阻塞，不记录为已支持。不把 Client Secret 或真实邮箱写入验收报告。

## 8. 参考依据

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)：授权码、state/nonce、ID token 验证、稳定 sub 与邮箱非主键。
- [Google Web Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)：Web application 凭据、精确 redirect URI 与部署约束。
- [Google ID token 验证](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)：Gmail/Workspace 与第三方邮箱的权威性差异。
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)：重新认证、错误枚举、限流与凭据安全。

通用企业 SSO/SAML、其他社交 Provider、MFA/Passkey 是后续明确切片，不是本次 Google 登录的替代方案；数据模型保留多登录方式能力，不预先引入完整身份平台。
