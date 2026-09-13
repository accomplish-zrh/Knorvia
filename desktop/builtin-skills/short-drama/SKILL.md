---
name: short-drama
description: 编排短剧剧本、角色与场景设定，编译为原生媒体画布或分镜队列，按需推进生成与本地剪辑。当用户需要策划短剧、拆解分镜、生成短剧视频或做后期精修时使用。仅策划时停在草稿，不新造运行时，不擅自调用付费模型。
---

# 短剧制作技能 (Short Drama)

编排 Knorvia 现有的 Agent 与媒体工具，连接故事构思、分镜拆解、角色参考、原生画布、视频队列和本地剪辑。由 Agent 写故事和 Plan v1；脚本只校验、转换数据，不生成剧情或媒体。

本技能不新造 Agent 运行时，不修改系统环境配置，不擅自调用未经启用的收费模型。

---

## 核心执行纪律（必读）

1. **意图定界与草稿停机**：
   - 若用户仅要求“写剧本”、“策划短剧”、“看分镜设计”或“提构思”，**必须停在 Plan v1 剧本草稿阶段**。向用户完整展示结构化设定与分镜内容，绝不提前调用建画布、入队列或任何模型生成工具。
   - 若用户已明确发出执行指令（如“按此构思建画布并生成第 1 镜”、“开始排队生成”），则直接编译并推进后续动作，**已授权生成无需重复询问相同的许可**。
2. **场景连续性严禁越界**：
   - 镜头连续性（`continuity`）默认必须为 `"none"`。
   - 镜头 1 必须为 `"none"`（严禁 `"previous-tail"`）。
   - **跨不同场景（`sceneId` 发生变化）严禁使用 `"previous-tail"`**；不同场景之间必须设为 `"none"`。
   - 同一分镜若已提供 `firstFrame`，严禁再设 `"previous-tail"`。
3. **零臆造字段与队列边界**：
   - 所有 MCP 工具调用参数必须严格匹配当前 `desktop/studio-mcp.js` 定义。
   - 分镜队列 MCP (`media_sequence_create`) 目前**不支持 `lastFrame` 与 `aspect`** 字段，严禁自造入参。若分镜含有尾帧约束，必须引导用户走原生画布路径。
   - 编译的队列保持 `start: false`（尚未启动的草稿）；若用户已授权整段生成，创建后直接调用 `media_sequence_control` 启动，无需再次询问。
4. **CAS 状态保护与并发防重**：
   - 修改画布（`media_canvas`）或剪辑工程（`media_edit`）必须先执行 `read` 获取最新 `revision`，以 CAS（Compare-And-Swap）机制提交变更。
   - 严禁重复提交处于运行中或未知状态的任务。
5. **本地后期零额度消耗**：
   - 粗剪、精修、画幅裁剪与多镜头拼接优先使用 `media_edit`（本地处理，不消耗模型算力）。
   - 语音转录与字幕生成使用 `media_subtitles`，需用户已配置本地 whisper.cpp 和模型；没有时仍可手工编写或导入字幕。
   - `media_retake` 是再次调用视频模型，会消耗该提供商额度。对白、音效仅是生成提示，成片是否有正确音轨须实际试听；不能承诺配音或角色外观完全一致。

---

## 核心工作流入口

```
[用户需求]
   │
   ├─► 仅策划/写剧本 ──► 输出 Plan v1 JSON 草稿 ──► 停止并等待用户指令
   │
   └─► 授权制作/生成
         │
         ├─► 1. 资产核验: 调用 media_references 检阅并固定资料库图片 (id + sha256)
         │
         ├─► 2. 确定性编译:
         │      • 画布路径: compile-story.cjs plan.json --mode canvas
         │      • 队列路径: compile-story.cjs plan.json --mode sequence --video-profile <profileId>
         │
         ├─► 3. 触发与监控:
         │      • 画布: media_canvas (generate 节点)
         │      • 队列: media_sequence_control (start) + media_sequence_status 跟踪
         │
         └─► 4. 本地后期:
                • media_edit: 裁切画幅 (aspect)、调整剪辑片段 (clips)、导出 MP4
                • media_subtitles: 本地生成并加载字幕
```

---

## 支持文档与参考资源

以当前 `SKILL.md` 所在目录为技能根目录，通过已可用的 Node.js 运行其中 `scripts/compile-story.cjs`。使用绝对脚本路径和任务目录中的计划路径，不能假定用户安装了 Knorvia 源码或正在源码根目录。Node 不可用时说明依赖缺口，保留已写好的计划；不要擅自下载安装环境。

根据当前任务模式，适时查阅以下详细参考：

- **数据契约与校验规则**：详细查看 [references/plan.md](references/plan.md)。包含 Plan v1 完整 TypeScript 类型定义、字符长度上限、防错校验与 CLI 参数。
- **全流程编排与 MCP 工具速查**：详细查看 [references/workflow.md](references/workflow.md)。包含策划、画布流、队列流、本地剪辑、字幕与重拍的全部工具入参范例。
- **标准故事示例**：查看 [assets/example-story.json](assets/example-story.json)。提供符合 Plan v1 契约的 3 镜头温暖治愈短剧范例（多场景不自动续接）。
