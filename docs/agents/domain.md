# 领域文档（Domain Docs）

工程技能在本仓库探索代码时，应如何消费领域文档。

## 本仓库布局：single-context

本仓库为 **single-context**：一个仓库共用一份根目录 `GLOSSARY.md`（领域术语表），架构决定放 `docs/adr/`。不使用 `GLOSSARY-MAP.md`，也不设各子项目自己的 `GLOSSARY.md`——这些留到第一次真正写下词条时再按需创建。

## 探索前先读

- 根目录 **`GLOSSARY.md`**——本仓库唯一的领域术语表
- **`docs/adr/`**——读与你要改动的区域相关的 ADR

任一文件不存在时**静默继续**：不提示缺失，不建议预先创建。`/domain-modeling`（经 `/grill-with-docs`、`/improve-codebase-architecture` 触达）会在词条或决定真正落定时惰性创建它们。

## 文件结构

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
└── src/
```

## 使用术语表的词汇

输出（issue 标题、重构提案、假设、测试名）命名领域概念时，使用 `GLOSSARY.md` 定义的术语，不用术语表明确 _Avoid_ 的同义词。

所需概念不在术语表里 = 信号：要么在发明项目不用的语言（重新考虑），要么是真实缺口（记给 `/domain-modeling`）。

## 标记 ADR 冲突

输出与既有 ADR 矛盾时显式提出，不静默覆盖：

> _与 ADR-0007（…）矛盾——但值得重开，因为…_
