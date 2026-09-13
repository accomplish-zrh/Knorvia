# 命令速查

Kernel 通过学习 MCP 工具调用；外部 Agent 通过 Knorvia 创作 CLI 的同名命令调用。

| 工具（MCP） | CLI 命令 | 用途 |
| --- | --- | --- |
| `learning_sources` | `learning.sources` | 列出可用的文本资料与固定版本 |
| `learning_lecture` (create/read) | `learning.lecture.create` / `learning.lecture.read` | 讲义 Artifact；deterministic=结构推导，agent=模型讲解+证据 |
| `learning_quiz` (create/read) | `learning.quiz.create` / `learning.quiz.read` | 练习 Artifact；题目必须带证据；无模型拒绝 |
| `learning_practice` (start/read/answer/assess/due) | `learning.practice.start` / `learning.practice.read` / `learning.practice.answer` / `learning.practice.assess` / `learning.practice.due` | 固定题库版本的逐题练习、服务端选择题判分、开放题自评、错题与到期队列 |
| `creative_brief` (create/read/review) | `creative.brief.create` / `creative.brief.read` / `creative.brief.review` | 从学习材料或学习成果建立带来源的创作简报，关联真实作品并逐项评审 |
| `learning_review` (record/correct/mastery/due/rebuild) | `learning.attempt.record` / `learning.attempt.correct` / `learning.mastery.read` / `learning.review.due` / `learning.mastery.rebuild` | 尝试去重、判卷修正、掌握度、复习到期、确定性重建 |
| `openmaic_course` (save/read/sample) | CLI `tools.call` | 课程 Artifact 切片（模块/课时/块 + 引用） |
| `catalog_list` / `catalog_preflight` | `catalog.list` / `catalog.preflight` | 精选能力目录与依赖预检 |
| `library_image_process` / `library_video_extract_frame` | `library.image.process` / `library.video.extract-frame` | 图片本地加工、视频尾帧提取（本地 FFmpeg） |

存储位置：资料库 `learning/` 目录（`讲座/`、`练习/`、`练习会话/`、`课程/`、`掌握度.json`）以及 `creative/简报/`。版本冲突返回 -32005（CLI 冲突错误），先重读再保存，不要覆盖他人修改。

新练习优先使用 `learning_practice`，旧 `learning_review` 的整卷记录仍可读取，但不能用它替代逐题统计：

1. `start` 提供 `quizPath`、稳定的 `sessionId`，`mode` 为 `all`、`wrong` 或 `due`。空队列不写入会话。保存返回的 `path`，以后用 `read` 恢复。
2. `answer` 提供 `path`、当前 `questionId`、稳定的 `submissionId`。选择题只传用户选择的 `answerIndex`；开放题只传用户原话 `answerText`。重试使用同一编号与内容，不自行传入判分结果。
3. 开放题保存后，才向用户展示来源与解释。只有用户明确给出自评时，调用 `assess`，传入 `path`、`questionId`、稳定的 `assessmentId` 和 `selfRating: correct | wrong`，可附 `feedback`。不得替用户虚构自评；返回的 `self-reported` 不能表述为客观评分。
4. `due` 返回逐题 `due` / `wrong`、`quizStatus` 及统计覆盖情况；旧版或已移除题库的记录保留历史，不用于当前版本练习。调度是简单间隔规则，并非 FSRS 或掌握度预测。
