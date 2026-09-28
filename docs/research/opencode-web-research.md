# opencode web 样式调研

> 调研日期：2026-09-27。源码：/opt/data/profiles/hacker/workspace/project/opencode-upstream（按文件级下载，692 个 ui/session-ui/app 样式相关文件）。
> 注意：sst/opencode 已重定向至 anomalyco/opencode；MIT；210k stars；默认分支 dev；v1.18.32 @2026-09-21。

## 1. web 形态

官方**全功能 web/桌面客户端**（不是 TUI 预览）：
- `packages/app`：Vite + **SolidJS** 完整客户端（路由/session 页/composer/timeline）
- `packages/desktop`：Electron 壳
- `packages/web`：Astro 官网 + 会话分享页 /s/[id]
- **v1.18.x 正在推行 'v2/new-layout' 新设计系统**（settings.general.newLayoutDesigns 开关，body[data-new-layout] 双轨样式）

## 2. 样式体系

- 三层 token：background/text/icon/border/overlay/state/agent/elevation 分组 + grey-50..1200 + alpha 标尺（`packages/ui/src/v2/styles/theme.css`）
- 分层 elevation shadow（含 inset 高光、button-contrast 的 text-shadow）
- 46 套 JSON 主题系统（不照搬）
- 组件库：Kobalte（SolidJS）——架构层不适用我们（React），只搬 CSS 模式

## 3. 值得借鉴的差异化样式点（t3code 没有的）

1. **v2 三层 token + elevation 分层阴影**（theme.css）
2. **工具计数汇总微动画**：grid-template-columns 0fr→1fr + blur + translateY 展开（tool-count-summary.css，尊重 prefers-reduced-motion）
3. **Composer dock 堆栈**：permission/question/todo/followup/revert 停靠条在输入框上方按 dockProgress 展开，输入区 lift 负 margin 上移（session-composer-region.tsx）——审批/排队消息的展示形态比 t3code 更优雅
4. **半像素 hairline 边框**（0.5px / inset box-shadow overlay）+ hover/pressed 双层 linear-gradient 叠加而非换背景（button-v2.css、message-part.css）
5. **contenteditable 着色**：@提及按语法色（data-mention → syntax-property/type/keyword）、附件横条 edge 渐隐、shell 模式等宽（prompt-input/index.tsx）
6. **CSS scroll-driven 边缘渐隐**：scroll-timeline + @supports 守护（index.css）
7. **agent 身份色 token**：--v2-agent-plan/build/explore 的 solid/border/background 三件套（theme.css）——多 agent 场景的身份区分
8. 杂项：tabular-nums、字重 530/440 精细档、focus-visible 2px offset 2.5px、折叠面板 inert、64px rail + 拖拽排序、text-shimmer 流式占位

## 4. 结论

**补充价值集中在微交互与材质层**：dock 停靠堆栈（审批/排队）、hairline 边框、elevation 分层、工具计数动画、agent 身份色、scroll-driven 渐隐。
t3code 已覆盖的布局骨架（侧栏折叠/右面板 tab）opencode 形态相近，无需二次对齐。
不搬：Kobalte/SolidJS 架构、46 套 JSON 主题系统。

## 5. 融入 G 计划

- G6（审批面板）→ 参照 opencode dock 堆栈形态（停靠条 + dockProgress 展开）优于 t3code 的面板堆叠
- G7（排队消息）→ dock 停靠模式
- 新增 G21（agent 身份色）：画布/会话中多 agent 身份色三件套 token
- 新增 G22（hairline 边框 + elevation）：全站边框升级 0.5px + 分层阴影（可选，在 task13 边界优化之上）
