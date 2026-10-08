# Domain Docs

工程类 skill 在探索本仓库代码前，应如何消费领域文档。

## 探索前先读

- **`CONTEXT.md`**（仓库根）：本仓库的领域词汇表，定义 Wemux Lite 的领域语言（Server、Worker、Agent、Task、Session 等），每条术语附 `_Avoid_` 列表。
- **`docs/adr/`**：读与本次工作区域相关的 ADR。

文件不存在时**静默继续**：不标记缺失、不预先建议创建。`/domain-modeling` skill（经 `/grill-with-docs`、`/improve-codebase-architecture` 触达）会在术语或决策实际敲定时更新它们；本仓库新术语沉淀进 `CONTEXT.md`，不新建 `GLOSSARY.md`。

## 使用词汇表的词汇

输出（issue 标题、重构提案、假设、测试名）命名领域概念时，使用 `CONTEXT.md` 定义的术语，不漂移到词汇表 `_Avoid_` 列表里的同义词。

需要的概念不在词汇表里时，这是个信号：要么你在发明项目不用的语言（重新考虑），要么存在真实缺口（记给 `/domain-modeling`）。

## 标记 ADR 冲突

输出与现有 ADR 矛盾时显式指出，而非静默覆盖：

> _与 ADR-0007（task-bound conversation direction）矛盾，但值得重开，因为……_
