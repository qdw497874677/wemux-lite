# 02-06 SUMMARY — 阶段 2 受控切片总账

状态：自动任务全部完成（候选冻结、同候选重跑、追踪状态更新、GSD 校验通过）；**收尾口径待用户签收**（checkpoint 未确认前阶段保持 OPEN，票据与前置门状态未改）。

## 交付

- `docs/acceptance/web-next-phase2-controlled-slice.md`：候选身份（HEAD `54585bc`、Node v26.5.1、Chromium `chromium-1228` + `playwright-core@1.61.0`、一次性 Next 静态产物 `/tmp/wemux-next-dist-head`）、同候选门表、逐计划证据索引、剩余缺口与资格门重跑清单。
- `.planning/REQUIREMENTS.md`：`NEXT-05` 行更新为"In Progress, 受控切片已交付（`web-next-phase2-controlled-slice.md`：模型/入口禁用态/查询缺口 a+b/写通道矩阵），#52 决策门与隔离资格门未过"（**未勾选**）。
- `.planning/ROADMAP.md`：Phase 2 `Plans` 段记录受控切片完成与阶段保持 OPEN，指向总账文档。

## 验证结果（本次运行，全部在同一候选 HEAD `54585bc`）

- `npm run build:packages` 通过；`npm run typecheck --workspace @wemux/{server,worker,web-next}` 三者通过。
- `npm test --workspace @wemux/server`：930 / 930 pass，0 fail；`@wemux/worker`：440 pass / 4 skip（既有浏览器配置门）；`@wemux/web`：297 / 297；`@wemux/web-next` `test:prepared`：168 / 168（带 `PLAYWRIGHT_CORE_PATH` / `PLAYWRIGHT_CHROMIUM_PATH`）。
- 三个 e2e 在同一候选重跑并复现结论：02-02 入口禁用态（退出码 0、14 项、零 `pageerror`、截图覆盖）；02-04 断连重放配对（退出码 0、7 项、`stalledAt 9`、`withheld [10,136]`、`gapStatesSeen 0`）；02-05 写入通道探针（退出码 0、10 项、六行结论与已提交矩阵逐条一致）。
- `node /opt/data/.pi/agent/gsd-core/bin/gsd-tools.cjs validate consistency --raw` → `passed`（退出码 0）。
- 候选漂移处置：切片提交至 HEAD 之间的源码改动（02-03 能力面投影与共享解析）已包含在本次重跑内，无"不同 HEAD 绿灯相加"。

## 口径（未获确认前不得改写）

票05 保持 in-progress、`NEXT-05` 不勾选、Ticket06 前置门不解除、协调入口保持禁用；本总账不构成风险接受（D-02 未选）；资格门环境方案未预选（选项 E 未选），重跑清单只列 §五选项与 §六岔路，决策留给用户。

## 待决 checkpoint

- **02-06 收尾口径人审**（本计划 checkpoint）：对照总账逐项抽查证据路径、确认无"受控切片 = 票05完成"表述、确认未替用户预选环境方案。
- 另有两项早期 checkpoint 仍未批：02-02 禁用态 UX 人审、02-05 矩阵签收（两者共同支撑关闭态结论）。
- 异议处置：指出条目并保持草案；阶段保持 OPEN，不做完成宣告。