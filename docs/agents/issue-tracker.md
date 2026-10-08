# Issue tracker：本地 Markdown

本仓库的 issues 与 specs 以 markdown 文件形式存放在 `.scratch/` 下。

## 约定

- 每个功能一个目录：`.scratch/<feature-slug>/`
- 规格文档：`.scratch/<feature-slug>/spec.md`
- 实施票据：每票一个文件，位于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 起编号，不合并成单个 tickets 文件
- 分诊状态记录在每个票据文件顶部附近的 `Status:` 行（角色字符串见 `triage-labels.md`）
- 评论与对话历史追加到文件底部 `## Comments` 标题下

结合本仓库既有惯例（AGENTS.md「票据与证据」）：原始证据留在 `.scratch/`，脱敏验收摘要与可重复测试纳入仓库。

## 当 skill 说 "publish to the issue tracker"

在 `.scratch/<feature-slug>/` 下创建新文件（需要时创建目录）。

## 当 skill 说 "fetch the relevant ticket"

读取所引用路径的文件。用户通常会直接给出路径或票据编号。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个文件，每个票据对应一个 **child** 文件。

- **Map**：`.scratch/<effort>/map.md`（Notes / Decisions-so-far / Fog 正文）。
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，正文写问题。`Type:` 行记录票据类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **Blocking**：文件顶部附近的 `Blocked by: NN, NN` 行。所列文件全部 `resolved` 时票据解除阻塞。
- **Frontier**：扫描 `.scratch/<effort>/issues/`，找未解决、未阻塞、未认领的文件；编号最小者胜。
- **Claim**：任何工作开始前先写入 `Status: claimed` 并保存。
- **Resolve**：在 `## Answer` 标题下追加答案，置 `Status: resolved`，再向 `map.md` 的 Decisions-so-far 追加上下文指针（gist + 链接）。
