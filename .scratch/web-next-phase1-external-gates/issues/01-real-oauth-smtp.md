# 01: 真实 Google OAuth 与 SMTP 端到端验收

**What to build:** 在真实 Google OAuth 凭据与真实 SMTP 下完成注册、登录、找回邮件与链接流程验收，并覆盖半配置启动失败与无邮件投递时的明确不可用说明。

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [ ] 真实 OAuth 完成注册与登录
- [ ] 真实 SMTP 收到验证邮件并完成链接流程
- [ ] 找回密码流程端到端可用
- [ ] 半配置（缺 client secret 等）时启动失败并给出明确原因
- [ ] 无邮件投递时返回 503 且界面有说明
- [ ] 邮件链接只由 `WEMUX_PUBLIC_URL` 拼接
- [ ] 截图与日志留档，凭据不落明文
