# 证据与版本规则

## 为什么固定版本

资料库每次保存都产生新版本（sha256）。学习 Artifact 引用的是**固定版本**；当资料被更新后，读取 Artifact 会把该证据标为 `superseded`（被取代），而不是悄悄指向新版本。

## 证据的最小结构

- 讲座（lecture）段落：`evidence = { libraryId, version, line, quote }`
- 练习（quiz）每道题：同上
- 课程（course）quote 块：`evidence.libraryId + evidence.version`
- 原文引用 `quote` ≤ 400 字符，`line` 从 1 开始

## 禁止事项

- 不得引用未在 `sourceRefs` 中声明的资料
- 不得在无模型时生成讲解或题目（`authorship` 必须如实标注）
- 不得把模型推断写成资料原文；推断要显式说明
- 不得凭对话文本改掌握度；掌握度只来自结构化尝试记录
