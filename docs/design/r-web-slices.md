# R-web 双宿主前端实施切片

状态：2026-09-29 拆分待实施；M2 W1/W2/W3 的 Worker 本地 HTTP/API 已完成，但本地页面仍是 `apps/worker/src/local-control/server.ts` 的内联页，不是 `apps/web` 的共享会话界面。设计依据：`docs/design/node-resource-distribution-architecture.md` §10、`docs/design/worker-web-workbench.md`、`docs/design/m2-dual-host-contract.md`。R2 真实用户级 systemd 服务及重启恢复尚未验收，不以 R-web 代替该验收。

## 顺序与验收切片

1. **宿主协商与路由隔离**：Server 和 Worker 各返回版本化、安全的宿主 bootstrap；`apps/web` 启动时先识别宿主再构造 TanStack Router。两宿主复用一个构建产物，但分别只挂载允许的路由；本地访问 `/projects`、`/teams` 或任务路由应返回本地 404，而不是仅隐藏侧栏。现有集群登录/会话路径无回归。测试包括未登录、错误版本、网络中断与直接打开禁止路径。Worker local-control 继续按本机管理员认证，不能把集群 Cookie/CSRF 视为本地凭据。
2. **共享 Session Interface**：定义宿主中立的会话/Journal/队列/审批/运行能力 Interface，用现有 Server 和 Worker 作为两个真实 Adapter。对齐 Journal 正向分页、旧记录查询与 gap，SSE 的游标、重连及会话撤权；不要把本地目录伪装成 Project/Placement，也不要生成虚假 Worker ID。先迁移单个本地会话完整路径：授权目录、创建会话、选择 Agent/模型、发送、时间线、停止、刷新补页；再迁移队列逐条取消、运行详情和审批。双宿主通过相同的 Surface 行为用例验收。
3. **本地设置与集群接入**：在共享壳中迁移已有 local-control 的 Agent 设置、连接器/本地 Secret、探测与加入/暂停/退出集群；登录表单、可恢复错误和能力不可用态按 Worker 身份模型实现。操作仍由 Worker 后端校验 Host、Origin、CSRF、目录与授权；浏览器不能持久化 enrollment token 或 Worker credential。特别覆盖脱敏、断网离线继续对话及集群身份切换不共享本地正文。
4. **Worker 发布物及内联页下线**：只在上述共享 UI 真正可用后，把同一次构建的 `apps/web/dist` 嵌入 Worker tgz。改造 pack/check、静态服务 MIME/CSP/cache、版本与大小门禁，未入集群也能离线首开；明确独立于普通 ResourceBinding/Preset 的 Worker 软件升级权威。真实浏览器分别对 Server 和打包 Worker 验收 LAN HTTP 非安全上下文、登录、对话、SSE 重连、审批与撤权。最后移除内联 HTML/CSS/JS，不能先删除已有可用本地入口。

## 首个可独立验收的交付

优先只做第 1 项：两个宿主均明确报告 `hostKind`、合同版本和可展示能力，Web 根据 bootstrap 拒绝错误宿主路由；不在这一项冒充共享 Session UI 已完成。Worker `GET /api/local/bootstrap` 现有 `{ initialized }` 是公开端点，只可追加非敏感固定宿主数据；登录态和能力细节须经已认证接口。Server 的宿主发现也不能暴露私有权限。首项通过后再落第 2 项；不要在第 1 项复制另一套 HTTP Session 实现。

## 验收门禁

- `npm run build:packages`（如修改合同包）、`npm run typecheck`、`npm test`、Worker `pack:check`；影响入口、路由、对话或鉴权必须额外运行真实 Chromium，保留脱敏结果及可重复脚本。
- 本地值 import 带 `.ts`；LAN HTTP 不直接使用 `crypto.randomUUID()`，复制操作需按 `copyText()` 的失败降级；不要引入第二套 App shell、构建期宿主 flag 或强制安装 Agent。
- R2 组合测试目前已覆盖真实 Web Preset、打包 Worker、托管 Pi、Skill 和模型 Turn，系统环境仍缺真实 `systemd --user` manager；此缺口与 R-web 资产/路由验收分别记录。
