# Ticket 01C 新版应用入口组件验收

状态：**组件已实现并通过受控验证；Ticket01尚未完成**。本次仅新增 `apps/web-next` 页面/样式/行为测试与本文关联来源、操作迁移、Runtime盘点；不改共享合同、构建配置、Server/Worker、旧页面或发布实例。01A/01B已有改动保持不动。

## 实现

- 固定Paperclip commit `53aad90b9e83dc147707797bf224bec12600b171`，实际移植SidebarShell、基础组件和焦点/滚动逻辑；见 `docs/design/web-next-paperclip-source.md`。MIT完整文字同时保留源码并进入发行JS，登录/侧栏可读。
- 使用冻结 `@wemux/web-client` 和 `@wemux/web-contract/browser-host`，无旧UI/路由/客户端反向导入。宿主发现先于集群账号请求；Worker入口明确转回本机工作台，不伪装成本地Task迁移。
- 内联密码登录、Cookie恢复、退出、401过期清空、身份代次防止迟到项目结果重现。退出网络失败保留错误，不假称已清除HttpOnly Cookie。
- 默认获权项目列表，中文角色/共享范围，搜索、空态与恢复；`/next/projects/:id`是获权列表概要，不增加详情API，不伪造不存在项目。缺失列表项显示“不存在或当前账号无权访问”。完整项目管理留03，旧版链接可达。
- 404路由、真实HTTP403/404、网络、503、合同错误、渲染异常分别显示。登录保留原深链接query/hash；`returnTo`只允许规范化同源`/next/`目标。刷新/后退、每history entry滚动恢复、桌面可调整侧栏、移动modal导航、Tab/Esc焦点、命令搜索及登录未保存离开提醒。
- HTTP不安全上下文使用共享randomId；复制失败选择文本并提示Ctrl+C/长按复制，不调用execCommand。登录提示明文HTTP风险。index资源加载失败有静态兜底。

## 证据

统一原始目录：`/tmp/wemux-ticket01-component3/`。临时HTTP服务只属于故障测试夹具，动态端口、随脚本关闭；不是第二套用户预览实例或真实数据验收。

| 命令/行为 | 结果 / 原始路径 |
| --- | --- |
| 先写application测试再实现 | `red.log`，模块不存在时按预期失败 |
| `npm test --workspace @wemux/web-next` | `tests-final.log`，14/14通过、0跳过：9个应用状态/路由行为，2个源码辅助合同，加01B原3交付测试 |
| `npm run typecheck --workspace @wemux/web-next` | `typecheck-final.log`，通过 |
| `npm run build --workspace @wemux/web-next` | `build-final.log`，通过，独立`/next/assets/`产物；不是完整根build |
| `node apps/web-next/tests/browser.mjs` | `browser-final.log`，6组桌面/手机真实Chromium受控场景通过 |
| `npm test --workspace @wemux/web --workspace @wemux/web-client` | `legacy-shared-regression.log`，旧Web295/295，共享客户端13/13；未更改旧测试 |
| 两浏览器脚本`node --check`、`git diff --check`、无暂存检查 | `review-checks.log`，通过；无提交 |

浏览器原始证据：
- `browser/result.json`：全部场景组及pageerror/console/requestfailed分类；无非预期错误。
- `browser/desktop-projects.png`（1440×900深色）；`browser/mobile-login.png`、`browser/mobile-projects.png`（390×844亮色）。截图可供人工复核，本执行环境图像读取器不支持模型图像展示，不声称已进行像素级视觉审查。
- 桌面：登录深链接query/hash、HTTP复制选择、侧栏键盘调整、项目搜索、Ctrl+K命令、刷新/后退/滚动恢复。
- 故障：路由不存在、隐去项目、HTTP403/404/503、断网重试、空态、401过期、退出；故意注入非法项目字段触发React渲染异常并重新加载恢复。
- 手机：内联登录returnTo、touch打开导航、15次Tab不逸出、Esc恢复触发按钮焦点、项目导航、无水平溢出。
- Worker：只有`/api/host`请求，没有集群凭据请求；仅证明选择边界，不算13。

红绿修复：`browser-first.log`暴露原生dialog Tab可到浏览器chrome，增加显式Tab环绕后通过。`browser-second.log`把已收到401/204、共享传输销毁身份产生的ERR_ABORTED误记为非预期；现在仅允许“指定身份API+具体状态+ERR_ABORTED”组合，其余失败仍失败。故意渲染错误与网络/HTTP故障单独标注，未吞掉真实非预期错误。新测试没有删除或放宽旧业务安全断言。

## 集成交接门（本组件未执行）

1. 沿统一发布流程构建冻结release，完整根 `npm run build`、`npm test`、Worker `pack:check`；01B仍保留旧Worker bundle。本组件不改实际release、pid或过时release-path标记。
2. 当前运行路径仍由integration复核；工作树build不能冒充已上线。01B已发现运行release与标记漂移，需按其报告修复部署而不是用cwd预览代替。
3. 同现有实例、已有账号/项目执行 `node apps/web-next/tests/real-instance.mjs`。环境：`WEMUX_NEXT_BASE_URL`、`WEMUX_NEXT_PROJECT_ID`、`WEMUX_NEXT_LOGIN_FILE`（私有JSON文件含login/password）；凭据不得放命令文字、报告或截图。脚本不创建账号/项目、不调用模型；等待真实获权项目标题、检查旧新入口同Cookie、桌面/手机刷新后退和退出。`WEMUX_NEXT_EVIDENCE`指定私有/tmp目录，真实截图可能有项目名，不公开原图。
4. 真实账号过期、旧根重新登录与现存Session稳定加载由integration补验，不能用受控401替代真实会话撤销。真实脚本在此仅语法验证，未运行。
5. 操作清单见 `web-next-operation-migration.md`；逐Runtime版本/认证/模型切换/工具/讨论限制见 `web-next-runtime-inventory.md`。未知项保留待核验，05首次协调就必须完成强制安全门，08不能追认未受限讨论。

无数据清理、数据库克隆、全局认证读取、模型调用、联网安装、外部写入或提交。未改父Ticket25或其他票状态，未勾选本票完成。
