# 命令速查

Kernel 通过学习 MCP 工具调用；外部 Agent 通过 Knorvia 创作 CLI 的同名命令调用。

| 工具（MCP） | CLI 命令 | 用途 |
| --- | --- | --- |
| `learning_sources` | `learning.sources` | 列出可用的文本资料与固定版本 |
| `learning_lecture` (create/read) | `learning.lecture.create` / `learning.lecture.read` | 讲义 Artifact；deterministic=结构推导，agent=模型讲解+证据 |
| `learning_quiz` (create/read) | `learning.quiz.create` / `learning.quiz.read` | 练习 Artifact；题目必须带证据；无模型拒绝 |
| `learning_review` (record/correct/mastery/due/rebuild) | `learning.attempt.record` / `learning.attempt.correct` / `learning.mastery.read` / `learning.review.due` / `learning.mastery.rebuild` | 尝试去重、判卷修正、掌握度、复习到期、确定性重建 |
| `openmaic_course` (save/read/sample) | CLI `tools.call` | 课程 Artifact 切片（模块/课时/块 + 引用） |
| `catalog_list` / `catalog_preflight` | `catalog.list` / `catalog.preflight` | 精选能力目录与依赖预检 |
| `library_image_process` / `library_video_extract_frame` | `library.image.process` / `library.video.extract-frame` | 图片本地加工、视频尾帧提取（本地 FFmpeg） |

存储位置：资料库 `learning/` 目录（`讲座/`、`练习/`、`课程/`、`掌握度.json`）。版本冲突返回 -32005（CLI 冲突错误），先重读再保存，不要覆盖他人修改。
