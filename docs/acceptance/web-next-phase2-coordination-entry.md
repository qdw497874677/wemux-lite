# 阶段 2 / 02-02 验收摘要：Team 协调入口禁用态与服务端关闭

对应计划：`.planning/phases/02-agent-api/02-02-PLAN.md`（票 05 切片，NEXT-05 仍为 in-progress）
原始证据：`.scratch/web-next-project-agent-platform/evidence/02-02/`（双视口截图；脚本日志另存 /tmp）

## 范围与结论

Team 范围提供协调入口 UI（无需先选 Project），在运行时隔离资格门判定 FAIL 期间呈现可诊断禁用态；服务端同源拒绝协调会话创建，UI 禁用不是安全边界。本切片不开放任何协调执行，不涉及真实 Agent 运行时。

## 验证环境

- Server：`createWemuxServer` 动态端口（禁用 8004），SQLite 临时库；真实管理员账号经 `provisionAdministrator` 注册登录。
- 前端：`WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-dist-0202`（本仓 `apps/web-next` 构建产物拷贝，单写者纪律下未跑根 build）。
- 浏览器：Chromium `chromium-1228/chrome-linux64/chrome` + playwright-core 1.61.0，桌面 1440×1000 与手机 390×844 各一轮。
- 命令：`WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-dist-0202 PLAYWRIGHT_CORE_PATH=… PLAYWRIGHT_CHROMIUM_PATH=… node --import tsx apps/e2e/next-coordination-entry-browser.mjs`

## 已验证检查项

| # | 检查 | 结果 |
|---|------|------|
| 1 | `GET /api/teams/:id/coordination/availability` 返回 `disabled` + `gate.verdict=FAIL` + 两条原因 + 证据路径（`ticket-05-runtime-isolation-gate.md` §五）+ 三条解除条件 | 通过 |
| 2 | 可用性投影不含口令、邮箱等凭据（脚本断言） | 通过 |
| 3 | 直接 HTTP `POST /api/teams/:id/coordination/sessions` → **403 `coordination_gate_closed`**（绕过 UI 亦不可创建） | 通过 |
| 4 | 非成员访问同一 Team 的可用性端点 → 403，不泄漏 Team 存在性 | 通过 |
| 5 | 浏览器直访 `/next/teams`（Team 范围）可见协调入口，无需选择 Project；状态卡呈现 FAIL、全部原因、证据路径（含 02-05 矩阵位置）、全部解除条件 | 通过（双视口）|
| 6 | 协调区无任何发送/上传可点控件（button/input/textarea/contenteditable 计数为 0） | 通过（双视口）|
| 7 | 页面内 `fetch` 直接 enqueue（绕过组件）→ 403 `coordination_gate_closed` | 通过（双视口）|
| 8 | 双视口零 `pageerror`；截图存档 | 通过 |
| 9 | `npm test --workspace @wemux/server`：925/925 | 通过 |
| 10 | `npm run test:prepared --workspace @wemux/web-next`：168/168（需带 `PLAYWRIGHT_CORE_PATH`/`PLAYWRIGHT_CHROMIUM_PATH`，缺失时 4 项浏览器用例按设计报配置错） | 通过 |
| 11 | `npm run typecheck --workspace @wemux/web-next`；源码扫描无 `crypto.randomUUID` / `document.execCommand` 命中 | 通过 |

## 未验证 / 限制

- 本切片**未**开启任何协调会话执行：资格门仍为常量 FAIL，解除条件满足前不提供可翻转开关。
- 协调可用性投影当前是编译期常量；运行期重新探测不在本切片范围。
- 桌面截图为浅色主题（应用跟随系统主题，深色为默认偏好），非缺陷。

## 签收状态

- 自动化与双视口浏览器证据齐备；**禁用态 UX 的人审 checkpoint 已获用户批准（2026-10-08，回复"都接受"）**。批准前后该入口均保持禁用；后续受控切片（02-05 矩阵）已据此签收。