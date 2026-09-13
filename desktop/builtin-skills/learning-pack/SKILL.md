---
name: learning-pack
description: 对 Knorvia 资料库内容做解读、辅导、逐题练习、错题与到期复习，以及教回练习。保存带来源版本的学习成果和真实作答记录；可将所学衔接到文章、讲解稿等创作任务。
user-invocable: true
---

# Knorvia 学习基础包（Learning Pack）

三种薄技能共用本说明。它们只编排工具与教学策略；讲解文字与题目由当前会话的模型生成，确定性数据（来源、结构、尝试记录、掌握度）由学习工具提供。本技能不运行第二个 Agent 循环。

## 共同纪律（先读）

1. 永远先 `learning_sources` 拿到资料与其 `version`（sha256）。引用证据时必须带上 id+version+行号+原文引用（≤400 字）。
2. 讲解、题目这类生成内容的 `authorship` 是 `agent`：没有可用模型连接时，**明确告知用户无法生成并停止**，不要用模板文本冒充讲解。
3. `authorship: deterministic` 只用于服务从来源结构推导的大纲（不消耗模型）；不要给它传 outline。
4. 学习成果保存后是资料库版本化 JSON（`learning/讲座/`、`learning/练习/`、`learning/课程/`），读取时若来源已更新会标记 `superseded`——要向用户说明证据对应旧版本。
5. 旧课题级统计来自 `learning_review record`，新逐题复习来自 `learning_practice` 保存的作答；不得根据聊天文本猜测掌握度。开放题自评不等于客观判卷，两种统计分别报告。
6. 用户纠正判卷用 `learning_review correct`，保留原始记录并追加修正。

## 技能一：解读（interpret）

用途：把一份资料转成可定位的讲义。

1. `learning_sources` → 请用户确认资料与版本（或按上下文选择）。
2. 无模型时：`learning_lecture create` + `authorship: deterministic`，得到结构大纲（每节带行号证据）；如实说明这是结构推导而非生成讲解。
3. 有模型时：先 deterministic 大纲打底，再对每节补充你自己的讲解段落，然后以 `authorship: agent` 重建：每节 `evidence` 必须是来源原文引用+行号，`points` 逐条给出 `{quote, evidence.line}`。不引用原文的段落不要写。
4. 保存后向用户报告讲义路径与证据状态。

## 技能二：辅导（tutor）

用途：围绕课题进行苏格拉底式讲解并落到可复核材料。

1. 用 `learning_lecture read` / `learning_sources` 打底，确认用户当前课题与已有讲义。
2. 讲解时每个关键结论后跟来源引用（`资料名 行号："原文"`）；来源没写的要明确说"这是推断/拓展，不来自资料"。
3. 结束时建议固化：生成或更新讲义（技能一第 3 步），并视需要出练习（技能三）。

## 技能三：练习与复习（practice-review）

用途：出题、批改、记录掌握度、安排复习。

1. 出题：`learning_quiz create` + `authorship: agent`；每题必须有 `evidence`（libraryId+version+行号+原文）。选择题给 `options`+`answerIndex`，可加 `explanation`。没有模型就停下来，不出题。
2. 新练习优先用 `learning_practice start` 固定题库并开始会话；读取当前题后让用户先尝试，不提前展示答案、解释或含答案的来源引用。`learning_practice answer` 保存用户实际提交的答案：选择题由工具判分，开放题记录回答并明确区分自评与客观判分。参数以当前工具描述为准；不要替用户编造作答或自评。
3. 用户对判卷有异议：`learning_review correct` 修正并留痕。
4. 逐题复习用 `learning_practice due`，再选择错题或到期模式；会话进度保存在资料库，续接用 `read`。同一次创建或提交的重试使用原 `sessionId` / `submissionId` 和原参数。已有整卷记录仍可通过 `learning_review mastery` / `due` 查看；两种统计说明各自来源，不混算为统一掌握度。
5. 状态损坏时可 `learning_review rebuild` 从练习 Artifact 确定性重建，不要手工编数据。

### 教回与创作衔接

教回练习先邀请用户用自己的话解释、举例或比较，再针对实际回答指出遗漏和误解，必要时定位原文。回答未到达时等待用户，不把等待、阅读完成或助手写好的解释记为学习者掌握。

用户希望把所学写成文章、讲解稿或分镜时，沿用已经固定的来源，通过 `creative_brief` 建立受众、作品目标与验收条件，可关联本次学习成果。作品保存与评审按内置 `creative-brief` 技能执行。

## 参考

- 证据与版本规则：`references/evidence.md`
- 命令与参数速查：`references/commands.md`
