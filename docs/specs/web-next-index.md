# Web-next spec 与 ticket 索引

当前工作只按功能 spec 和 ticket 跟踪，不再维护 GSD 阶段或按编号串行推进。下表顺序不是执行顺序；开工条件以 ticket 的 `Blocked by:` 为准，状态以对应文件的 `Status:` 和验收记录为准。`ready-for-agent` 表示分诊角色，不代表依赖已解除或工作已完成。

## 功能规格

| Spec | Ticket 数 | 范围 |
| --- | --- | --- |
| [外部服务与独立验收](../../.scratch/web-next-external-gates/spec.md) | 2 | 真实 OAuth/SMTP、外部死信、独立视觉复审与真实运行时 |
| [协调执行边界收口](../../.scratch/web-next-coordination-closure/spec.md) | 4 | L1 会话作用域、工具网关与命令授权、门证据、人工开门 |
| [计划修订、批准与交接](../../.scratch/web-next-plan-handoff/spec.md) | 2 | revision 批准、幂等交接、创建与启动分离、跨 Runtime 闭环 |
| [会话协作界面](../../.scratch/web-next-collaboration-surfaces/spec.md) | 3 | 画布/Fork、文件/终端/成果、Connector/Channel |
| [资源管理与独立 Worker 双宿主](../../.scratch/web-next-dual-host/spec.md) | 2 | Worker/Agent/Model/Skill/Preset/Provider、本地宿主与入退群 |
| [迁移收口与旧版移除条件](../../.scratch/web-next-migration-closure/spec.md) | 3 | 旁路勘察、操作级迁移登记、调用方转换、授权与全链路验收 |
| [备份、重置、切根与旧版删除](../../.scratch/web-next-cutover/spec.md) | 2 | 恢复演练、干净实例验收、人工 go/no-go 与切根 |

共 7 份 spec、18 张 ticket。每份 spec 的 Tickets 表链接具体票据并保留合并来源；票号只在该 spec 内有效，跨 spec 使用文件链接。

## 需求追溯

NEXT 编号是需求标识，不是工作阶段或当前票号。以下保留既有完成裁定，不因跟踪方式变化新增完成项；尚未完成项的细则以对应 spec/ticket 与[产品规格](web-next-project-agent-platform.md)为准。

| 需求 | 验收目标 | 当前追溯 |
| --- | --- | --- |
| NEXT-01 | 同实例 `/next/` 真实账号入口、获权项目、深链接/刷新/后退、可诊断失败态、桌面手机、Paperclip 来源与迁移盘点 | 本地候选已确认；[真实外部服务](../../.scratch/web-next-external-gates/issues/01-real-external-services.md)未签收 |
| NEXT-02 | 账号自助、Team 邀请/成员、资源授权、真实邮件/OAuth 与撤权 | 本地候选已确认；[真实外部服务](../../.scratch/web-next-external-gates/issues/01-real-external-services.md)未签收 |
| NEXT-03 | Project/Repository/Workspace Placement/普通 Task 管理、定向重试、不误删外部文件 | 已签收，见[候选证据](../acceptance/web-next-phase1-candidate.md)；不是后续新增功能的完成证明 |
| NEXT-04 | Task 下创建/复用 Session，流式/审批/队列/停止/恢复，同 Session 模型切换只影响下一 Turn | 既有八项有界行为已签收，见[候选证据](../acceptance/web-next-phase1-candidate.md)；独立宿主完整验收仍属[双宿主 ticket](../../.scratch/web-next-dual-host/issues/02-local-host-enrollment-acceptance.md) |
| NEXT-05 | 可信项目 API 与 task.sessions；Team 协调的 L1 作用域及平台中介写通道强制收口，不承诺 OS/网络隔离 | [协调收口](../../.scratch/web-next-coordination-closure/spec.md)未完成；已有[受控切片证据](../acceptance/web-next-phase2-controlled-slice.md)，入口仍关闭，风险接受与开门待人工确认 |
| NEXT-06 | revision 批准、授权/幂等/一致交接，携带计划/验收/来源且讨论继续 | [计划批准与交接](../../.scratch/web-next-plan-handoff/issues/01-plan-approval-and-handoff.md)及[闭环验收](../../.scratch/web-next-plan-handoff/issues/02-cross-runtime-loop-acceptance.md)未完成 |
| NEXT-07 | Run/取消竞态、显式成果提交、配置审查与真实待办 | 本地候选已确认；[外部服务](../../.scratch/web-next-external-gates/issues/01-real-external-services.md)与[独立复审/真实运行时](../../.scratch/web-next-external-gates/issues/02-visual-runtime-acceptance.md)未签收 |
| NEXT-08 | 全部现有有效 Runtime 以适宜入口真实完成查询/交接/执行/报告并明示差异 | [跨 Runtime 闭环](../../.scratch/web-next-plan-handoff/issues/02-cross-runtime-loop-acceptance.md)未完成；单个 Runtime 证据不能代替全部验收 |
| NEXT-09 | 按权限共享会话/画布、同 Task 固定 cursor Fork、撤权过滤列表/血缘/缓存/实时流 | [画布/Fork](../../.scratch/web-next-collaboration-surfaces/issues/01-canvas-fork.md)及[协作界面验收](../../.scratch/web-next-collaboration-surfaces/issues/03-connector-channel-acceptance.md)未完成 |
| NEXT-10 | 获权实施用户浏览/改文件、Diff、终端与成果下载，协调无实施写权 | [文件/终端/成果](../../.scratch/web-next-collaboration-surfaces/issues/02-files-terminal-artifacts.md)及[协作界面验收](../../.scratch/web-next-collaboration-surfaces/issues/03-connector-channel-acceptance.md)未完成 |
| NEXT-11 | 管理 Worker/Agent/Model/Skill/Preset/Provider，区分配置/认证/分发/可执行 | [资源管理](../../.scratch/web-next-dual-host/issues/01-resource-management.md)及[双宿主验收](../../.scratch/web-next-dual-host/issues/02-local-host-enrollment-acceptance.md)未完成 |
| NEXT-12 | Connector/Channel 授权配置、外部写审批、投递/死信/幂等重试、Secret 不泄漏 | [连接器/渠道验收](../../.scratch/web-next-collaboration-surfaces/issues/03-connector-channel-acceptance.md)未完成 |
| NEXT-13 | 无 Server 的 Worker 本地鉴权/Task/Session/结果，入群不自动上传 | [独立宿主/入群验收](../../.scratch/web-next-dual-host/issues/02-local-host-enrollment-acceptance.md)未完成 |
| NEXT-14 | 本地身份/Agent 配置、入退集群与失败恢复，本地任务/凭据不混用集群身份 | [独立宿主/入群验收](../../.scratch/web-next-dual-host/issues/02-local-host-enrollment-acceptance.md)未完成 |
| NEXT-15 | 有效功能逐操作迁移，跨页/宿主/Runtime、桌面手机全链路验证，转换调用方后移除无 Task 旁路 | [迁移收口](../../.scratch/web-next-migration-closure/spec.md)未完成 |
| NEXT-16 | NEXT-01–15 通过后固定候选、备份/成组重置/恢复、切根删旧版、构建/测试/打包及真实双宿主验收 | [切根](../../.scratch/web-next-cutover/spec.md)未完成；每项破坏性操作仍需明确实例与人工授权 |

FUTURE-01（新增 Codex 等 Runtime）与 FUTURE-02（未经逐项验收的额外企业连接器/未来功能）不纳入当前切换门槛。付费调用、风险接受、对外投递及数据清理不因 spec/ticket 可执行而自动获授权。

## 历史与证据

- GSD 规划与旧状态入口见[历史记录说明](../../.planning/README.md)，不再续写为当前工作流。
- `43966aa` 保存最初转换的 7 份 spec / 30 张 ticket；`99ef850` 保存合并后的 18 张 ticket。当前目录去除 `phaseN-`，协调人工签收票改为 `04-coordination-acceptance.md`；内容与来源可通过 Git 追溯。
- 历史验收报告的文件名、候选、测试数字和结论不改写。原始证据可能仅在原机器或被忽略的 `.scratch/` 中，摘要不等于在当前机器重跑通过。
