# 新版入口 Paperclip 来源与适配记录

状态：Ticket 01C 实现记录，不是整票验收。版本固定后离线取用，无外部写入或安装。

## 可核验来源

- 上游：`https://github.com/paperclipai/paperclip.git`
- 固定 commit：`53aad90b9e83dc147707797bf224bec12600b171`
- 本机核验仓库：`/opt/data/profiles/hacker/workspace/project/research/paperclip/paperclip`
- 核验命令：`git rev-parse HEAD`、`git remote -v`、`git status --short`；工作树 clean。
- 此次没有使用缺少 `.git` 的 `paperclip-upstream/paperclip` 归档来猜测 commit。
- `git show HEAD:ui/src/components/SidebarShell.tsx | sha256sum` 与磁盘文件一致：`a8ee5166e9c01bae1d24bc7c9ccca8faa3cbdacf5c890aa80b14d2d1711a3880`。
- 实际阅读 `DESIGN.md`、`Layout.tsx`、`SidebarShell.tsx`、`EmptyState.tsx`、`ui/button.tsx`、`ui/input.tsx`、`lib/main-content-focus.ts`、`lib/navigation-scroll.ts`。前端 skill：`/opt/data/skills/creative/popular-web-designs/SKILL.md`；本项目已指定 Paperclip，不另套其他品牌模板，不引入 CDN 字体或公共预览隧道。

## 取用清单

| 固定来源路径 | Wemux 文件 | 取用与变化 |
| --- | --- | --- |
| `ui/src/components/SidebarShell.tsx` | `apps/web-next/src/components/SidebarShell.tsx` | 实际移植持久宽度、边界夹紧、PointerCapture 拖动、Arrow/Home/End 键盘调整、展开/rail 层次；240 默认、208–420 范围、16 步进。替换 cn 导入、存储键和中文 aria-label。当前仅启用展开可调整，未展示未验收的 rail 功能。 |
| `ui/src/components/ui/button.tsx` | `apps/web-next/src/components/primitives.tsx` | 保留 Button 语义、data-slot、默认/ghost/outline、禁用和焦点；只采用需要的变体，不引入 cva/Radix，样式转到 Wemux token。 |
| `ui/src/components/ui/input.tsx` | 同上 | 保留原生输入 props、data-slot、最小宽度、placeholder/selection/focus/invalid 语义，中文关联 label，手机输入16px。 |
| `ui/src/components/EmptyState.tsx` | 同上 | 实际采用 icon/title/message/action 的单一空态结构；无操作时不渲染按钮，不引入 Issue/NewProject 对话框。 |
| `ui/src/lib/main-content-focus.ts` | `apps/web-next/src/lib/main-content-focus.ts` | 保留 requestAnimationFrame 后焦点调度与不抢内容内焦点判断。 |
| `ui/src/lib/navigation-scroll.ts` | `apps/web-next/src/lib/navigation-scroll.ts` | 采用 NavigationScrollMemory 及 main scroll 恢复实现；按 history entry key 记录，POP 恢复，其他导航归零；删去 Issue 专用路径判断。 |
| `ui/src/components/Layout.tsx` | `apps/web-next/src/components/Shell.tsx` | 参考单一 main 滚动区、侧栏、移动导航、命令入口与焦点组合；不复制 Company、插件、预算、Issue 业务上下文；原生 modal dialog 加 Tab 环绕和 Esc 返回触发器。 |
| `DESIGN.md` | `apps/web-next/src/styles.css` | 密集可扫描、结构表达层级、空态指导下一步、错误就地恢复；配色沿用 Wemux dark-first 与自动亮色，不复制上游品牌。 |

Company 不映射为 Team；项目数据来自 `@wemux/web-client.projects` 真实获权列表；不存在列表项时不猜测是403还是404。Server/Worker 由 bootstrap 合同选择，Worker 明确回本机工作台，不能以此算 Ticket13。

## 许可与分发

完整 MIT 文本保留在 `apps/web-next/src/PAPERCLIP-LICENSE.txt`，含 `Copyright (c) 2025 Paperclip AI` 和全部授权/免责条款。`PaperclipNotice.tsx` 使用 `?raw` 导入，在登录与侧栏提供“开源许可”，使完整文本进入发行 JS，而不是只留源码。改编文件含来源注释；本文固定取用范围。未移植 Company/插件等无关模块或其依赖。

验证：`apps/web-next/tests/application.test.mjs`、`browser.mjs`；本组件日志见 `docs/acceptance/web-next-entry-component.md`。保留版权不等于上游为 Wemux 提供业务、安全或验收背书。
