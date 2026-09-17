# Wemux Lite Web

AI Agent 集群管理与协作平台的主要客户端。产品定位见 [产品方向](../../docs/product-direction.md)，实施安排见 [路线图](../../docs/roadmap.md)。Web 展示 Server 的资源与执行投影，不在浏览器编排持久任务，不使用模拟数据掩盖请求失败。

## 运行

在仓库根目录执行：

```sh
npm run build:packages
npm run dev --workspace @wemux/web
npm run typecheck --workspace @wemux/web
npm run build --workspace @wemux/web
npm test --workspace @wemux/web
```

Web 测试使用 Node 原生 TypeScript strip，按本地值导入的 `.ts` 扩展名执行源码；源码契约只是补充，不替代浏览器验收。

开发服务通过 Vite 将 `/api` 代理到 Server，目标可由 `WEMUX_SERVER_ORIGIN` 配置。生产可由 Server 托管 `apps/web/dist`，提供同源 API 和静态资源，详见根 README。公共或不可信网络必须使用 TLS。

## 两条使用路径

- 直接对话：Project → Workspace → 选择具体 Worker Placement、可执行 Agent 和模型 → Session，不要求先建 Task。
- 任务协作：Task → Assignment → Run → Session → 人工 Review，复用同一会话与执行链路。

Workspace 是逻辑环境；路径与物化状态属于具体 Placement。不同 Worker 副本不自动同步；同一 Placement 的会话共享文件。Session 的执行绑定不能通过改选列表项静默迁移。

## 连接与数据

首屏使用内联连接表单，应用内重连使用连接对话框。管理员 bootstrap 接入与管理会话凭证不等于完整的多用户授权。连接保存策略见 `src/lib/connection-storage.ts`，不能宣称所有凭证仅保存在页内内存；Agent 和 Git 凭据不应传到 Web。

- `src/api/client.ts`：HTTP 路由、鉴权、错误与 fetch SSE；不依赖原生 EventSource 查询参数传递长期 Token。
- `src/api/dto.ts`：Web 资源契约与展示适配。
- `src/api/journal.ts`、`src/api/use-session.ts`：会话事件、序号、历史与同步处理。
- `src/features/`：项目、任务、会话、基础设施等产品入口。

页面须分别显示客户端连接、Worker 在线、执行状态与历史新鲜度。命令 pending/accepted 只是收据，Journal 才确定执行事实；未知状态不能伪装为空闲或已同步。变更连接作用域时须隔离旧请求、缓存与流。

## 浏览器硬约束

- HTTP 局域网或 Tailscale 地址可能是不安全上下文，不直接调用 `crypto.randomUUID()`；使用 `src/lib/random.ts`。
- 剪贴板不可用时引导用户手动复制，不用 `execCommand` 的假成功掩盖失败。
- `index.html` 保留启动失败兜底，但是否能正常启动必须用构建产物的真实浏览器验证，不能只调整提示文案。
- 中文文案，桌面与窄屏均能完成核心操作；键盘、加载、空态、错误、重试与禁用原因都纳入验收。

## 验证边界

当前已有源码契约和部分行为测试，不据此宣称真实 Agent、权限、断线恢复或全部交互已验收。M1 优先梳理功能缺口和交互设计，M2 优先落地会话工作台；浏览器验证随功能切片进行，系统性发布验证归 M7，不以全面基线审计或旧 MVP 限制阻挡功能完善。
