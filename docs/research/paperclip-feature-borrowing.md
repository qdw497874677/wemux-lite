# Paperclip 功能层借鉴清单(对照 wemux-mini 路线图)

日期:2026-09-28。输入:`docs/research/paperclip-deep-dive.md`(机制层)+ 本次功能层盘点(paperclip 147 个 UI 页面/全部 server services 对照我们的 features 与 roadmap M3-M8)。本文只回答:功能层面还有什么值得抄,对应我们哪个里程碑。

## 一、总判断

paperclip 与我们的功能重叠区是"任务+会话+Agent 管理",但它的功能想象力在"把 agent 当员工运营"这条线上走得远。按我们 roadmap 的 M3-M8 里程碑对照,以下按价值排序。

## 二、按价值排序的借鉴项

### 1. Approvals 统一审批中心(对应我们 M5/现有审批链,估计 3-5 人日)

paperclip 有独立的 Approvals 页面+`approvals.ts` 服务:所有治理动作(雇佣、策略变更、高危执行)进同一队列,带 approval 详情页、执行策略的 review/approve 阶段、决策追踪。我们已有会话内审批(ToolExecutionGateway),但**缺跨 Session 的统一审批收件箱**——连接器 destructive 调用、Run 审查、成员邀请现在散在各自流程里。抄法:一个 `approvals` 只读投影(谁/什么/为什么/等待多久)+ 通知,不新造审批引擎,复用现有各域的审批事实。

### 2. Routines(定时/触发例程,对应 M8,估计 5-8 人日)

`Routines.tsx` + heartbeat 服务:cron/webhook/API 三种触发、并发与追赶(catch-up)策略、每次执行生成一个 tracked issue 并唤醒指派 agent。这是 M8"受控自动化"的最成熟参照;配合 deep-dive 报告里的队列语义(durable receipt/coalescing/原子签出)一起抄。**注意**:触发器形态和我们的 H4 Channel(Webhook/飞书/钉钉)同构——Routine 的 webhook 触发可以复用我们已有的 generic webhook 入站面,这是 paperclip 没有的优势。

### 3. WhatNeedsMe / Attention 收件箱(对应 M5/M8,估计 3-4 人日)

`WhatNeedsMe.tsx` + `attention.ts` 路由:跨项目聚合"需要我处理的事"(待审批/被 @/被指派/阻塞上游),一页看全。我们任务看板是按 Project 切的,缺个人视角的跨项目聚合页。轻量:一个聚合查询+一页 UI,数据全在现有表里。

### 4. Skill Studio(组织级技能库,对应 M4/M8,估计 6-10 人日)

`SkillStudio.tsx` + `company-skills.ts`/`runtime-skill-injections`:共享技能目录、版本、按公司/agent 授权、运行时注入(runs 时挂载,不重训)。我们的 Agent 已有 skills 概念(pi/claude 原生),但缺**平台层的共享技能库与授权**——同一团队多个 agent 复用"怎么写周报/怎么查内部系统"这类知识。抄法:Project 级 skill 目录+`agent.use` 授权+运行时注入到 workspace,不碰 agent 原生 skill 机制。

### 5. Artifacts 与 Work Products(对应 M5 交付追踪,估计 4-6 人日)

`Artifacts.tsx` + `company-artifacts.ts`:run 产出的文件/截图/报告作为一等公民挂到 task,带 review 状态(artifact-review-documents)。我们的 Run 已有输出,但产物没有"交付物"语义(可审查/可引用/可下载聚合)。抄法:task 下挂 `artifacts` 表(引用 workspace 文件+mime+来源 run)+ review 状态机,复用我们 session-files 通道。

### 6. Activity Timeline 全局时间线(对应 M6 审计,估计 2-3 人日)

`Timeline.tsx` + `activity-log.ts`:跨实体(公司/项目/agent/task)统一活动流,操作者归因。我们已有 audit(NET json 导出),但缺**面向人的时间线视图**(排障时"这个 project 最近发生了什么"一页看全)。抄法:audit 表加一个聚合只读投影+分页 UI,不加新采集。

### 7. Evals(Agent 评测,对应 M4 诊断,估计 5-8 人日,建议推迟)

`paperclip-eval-kernel` 包+agent 评测:对 agent/skill 跑回归评测集、保存测试运行、质量指标。价值真实但依赖"agent 稳定复现"前提,建议等 M4 Agent 管理成熟后再排。

### 8. Board Chat(对应未来,暂不抄)

`BoardChat.tsx`:对"公司"整体对话(向 CEO agent 发指令)。我们 Session 模型不同,且 M8 之前没有编排层,现在抄会变成无锚功能。

## 三、明确不抄的

- **Org Chart/预算/雇佣隐喻**:与我们 Project/Session 模型冲突,我们的差异化是集群与分布执行,不是公司模拟。
- **多"公司"租户**:我们已有 Team→Project,语义足够。
- **Agent 人设头像池/agent-personas**:装饰性,不符合必要依赖原则。
- **Cases(工单)**:与 Task 线重叠,我们的 Task+Channel 已经覆盖。

## 四、建议的落地顺序

M5 前插 1(Approvals 收件箱)+6(Timeline);M8 做 2(Routines,复用 H4 webhook)+3(WhatNeedsMe);M4/M8 之间做 4(Skill Studio)与 5(Artifacts);7(Evals)等 M4 稳定。合计约 28-44 人日,分四个里程碑消化。
