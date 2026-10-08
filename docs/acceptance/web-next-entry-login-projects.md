# 阶段 1 / 01-02：新版入口候选前验收映射

状态：**局部受控验证完成，票 01 未签收**。本轮工作树不是冻结的同实例发布包。原始证据在 `/tmp/wemux-phase1-ticket01-controlled7/`、`/tmp/wemux-phase1-ticket01-controlled7.log`、`/tmp/wemux-phase1-next-tests-browser-fixed.log` 和 `/tmp/wemux-phase1-ticket01-safety.log`。桌面 1440×900 和移动 390×844 是 Chromium 模拟视口，不是物理手机或已部署真实账号。浏览器测试使用动态端口、合成 HTTP fixture；未调用付费 Runtime 或改动现有实例。后续针对独立审查的诊断收紧重跑证据在 `/tmp/wemux-phase1-ticket01-controlled11/result.json`、`/tmp/wemux-phase1-next-prepared-configured.log`：夹具匿名/退出后 Project 请求 401、只认可匹配注入端点的故障日志，SPA 已挂载登录页上的 OAuth 错误回跳也有用例，受控 7/7 且零未预期，Next prepared 166/166；仍非真实授权验收。

| 票 01 验收项 | 本轮结论与证据边界 |
| --- | --- |
| 1 Paperclip 来源、MIT、操作迁移 | `docs/design/web-next-paperclip-source.md` 固定 commit `53aad90b9e83dc147707797bf224bec12600b171`、取用组件和许可；`apps/web-next/src/PAPERCLIP-LICENSE.txt` 与 notice 进入发行图；`docs/acceptance/web-next-operation-migration.md` 按操作标历史有效、待核验、未实现或新规则替代。登记不等于逐操作已验。 |
| 2 Runtime 逐项盘点 | `docs/acceptance/web-next-runtime-inventory.md` 按 Pi/Claude Code/OpenCode/Test Agent 记录版本、认证条件、实测与未知。模型切换、平台工具、讨论写限制交 04/05/08/11 验证，不能以 Adapter 文件名宣称完成。 |
| 3 新版共享边界与行为 | `packages/web-client/`、`apps/web-next/src/application.ts` 的独立合同及同账号作用域行为由 Next 166/166 测试覆盖，包括新增的 pending 项目读取时退出、旧请求晚到、退出失败；新版无旧 UI 直接源码导入。旧版回归不作为新版票门。未证明真实浏览器全部授权竞态。 |
| 4 同实例 `/next/` | Server 静态路由和先前同实例证据见 `.scratch/web-next-project-agent-platform/evidence/ticket-01-acceptance.md`；本轮受控构建不等于当前产物部署，需 01-11 冻结候选身份/hash、同实例深链和回跳复验。 |
| 5 真实登录、获权列表、退出、过期、空态/重试 | 本轮受控浏览器验证登录/退出、注入过期和 HTTP 403/404/503/断网、空态/重试；先前隔离真实 Server 合成双账号权限与自然 TTL 证据见票 01 验收记录。**没有在既有实例以当前候选真实账号验证**；不能把合成账号说成现有账号。 |
| 6 异常区分 | 受控 Chromium 分别验证路由 404、隐藏 Project、403、404、断网、503、渲染异常及恢复；最终结果 7 组通过，零未解释诊断。已知测试主动触发的 pending 请求取消仅在该模式与退出操作期间按明确 GET 路径识别；fault 注入中的控制台/网络失败仅按对应端点、原因与模式识别，其他错误不白名单化；旧版未知取消不白名单化。真实实例异常仍需独立观察。 |
| 7 双宿主边界 | 受控 Worker host 分支断言只请求 `/api/host`，不请求 Server Cookie 项目 API；不冒称本地 Task/工作台迁移或验收。 |
| 8 桌面/手机/HTTP | 受控 Chromium 两视口实测键盘调整侧栏、搜索、移动触摸/Tab 双向环绕及 Esc 焦点返回、深链 query/hash、刷新/后退/前进、滚动恢复、非安全 HTTP 复制手选及随机 ID 路径。屏幕截图和诊断留在上述目录；真实设备和真实同实例复验尚缺。 |
| 9 浏览器稳定内容及剩余迁移 | 两视口等待实际标题/项目链接，不以 HTTP 200 代替稳定列表；剩余操作在迁移登记。候选同实例的当前真实账号桌面/手机读回与独立复审留 01-11。 |

本轮命令：`npm run typecheck --workspace @wemux/web-next`、`npm run build --workspace @wemux/web-next` 均通过；显式配置 Playwright core 1.61.0 / Chromium 1228 后 `npm run test:prepared --workspace @wemux/web-next` 为 166/166，无跳过；`npm run acceptance:safety --workspace @wemux/web-next` 为 2/2；`node apps/web-next/tests/browser.mjs` 为 7 组通过且零未预期诊断。无浏览器配置与曾将 Chromium **目录**而非可执行 `chrome` 文件设为 `PLAYWRIGHT_CHROMIUM_PATH` 的失败轮分别在 `/tmp/wemux-phase1-next-tests.log`、`/tmp/wemux-phase1-next-tests-browser.log`，不得算通过。最终候选应重跑相同门、确认发布身份并与获权项目/账号实测绑定；没有凭据或部署授权时明确标 blocked，不以受控 fixture 取代。
