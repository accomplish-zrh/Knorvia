# 短剧制作端到端编排流程与工具调用指南

本指南描述 Knorvia 短剧制作技能的完整工作流与底层工具调用规范。本技能编排 Knorvia 现有的 Agent 与媒体工具，不重造 Agent 运行时，不修改系统配置。

---

## 一、生命周期全景图

```
┌─────────────────────────────────────────────────────────────┐
│ 阶段一：剧本构思与分镜策划 (Ideation & Planning)               │
│ • 用户灵感/剧情提炼 → 角色/场景/道具设定 → 视听分镜设计       │
│ • 严谨纪律：用户仅要求策划时，停留在 Plan v1 草稿，不建画布/生成 │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 阶段二：资产核验与确定性编译 (Asset Pinning & Compilation)       │
│ • 资产查验：调用 media_references 检阅个人资料库现有图像      │
│ • 导演决策：确定分镜 continuity ("none" vs "previous-tail")   │
│ • 编译分流：调用 compile-story.cjs 转换为画布或分镜队列         │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
         [画布路径 Canvas]              [队列路径 Sequence]
               ▼                              ▼
┌─────────────────────────────┐┌──────────────────────────────┐
│ • media_canvas: create      ││ • media_sequence_create      │
│ • 适合：多角色参考图网络、     ││ • 适合：线性连贯自动化生产   │
│   带 lastFrame 尾帧约束、   ││ • 强制 start: false (待机)   │
│   可视化自由微调与生成      ││ • 队列不支持 lastFrame/aspect│
└──────────────┬──────────────┘└──────────────┬───────────────┘
               │                              │
               └──────────────┬───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 阶段三：分步生成与执行管控 (Execution & Generation Control)    │
│ • 权限纪律：已获用户明确授权时直接生成，不反复索取许可；       │
│   未获授权时停在创建就绪；绝不调用未经 Agent 启用的收费模型   │
│ • 画布生图/生视频：media_canvas generate (带 CAS revision)   │
│ • 队列推进与监控：media_sequence_control + media_sequence_status│
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 阶段四：本地剪辑与后期精修 (Zero-Cost Local Post-Production)   │
│ • 剪辑拼接/比例裁剪：media_edit (本地 FFmpeg，无模型扣费)     │
│ • 语音转录与字幕：media_subtitles (本地 whisper.cpp)         │
│ • 可选局部重拍：media_retake (调用视频模型，会消耗额度)       │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、各阶段操作指南与纪律

### 阶段一：剧本构思与分镜策划 (Ideation & Planning)

1. **用户意图判定与停机保护**：
   - 若用户仅说明“帮我写个短剧剧本”、“想一个关于雨天茶馆的故事”、“看看分镜设计”，**必须停在 Plan v1 草稿阶段**。向用户呈现格式规范的剧本、角色设定与分镜拆解，绝不私自调用任何生图、建画布或入队列工具。
   - 若用户输入已明确包含执行授权（如“策划并把第一镜生成出来”、“创建画布”），则在策划后连贯推进后续编译与执行，**无需反复二次确认相同的许可**。
2. **设定与分镜创作**：
   - 角色（characters）：提炼外貌、服饰、气质等利于生图的稳定视觉特征（≤1800 字符）。
   - 场景（scenes）：明确光影、色调、年代风格与环境氛围（≤1800 字符）。
   - 道具（props）：明确材质、造型与关键交互物（≤1800 字符）。
   - 镜头（shots）：设计运镜景别（camera）、动作走向（prompt）、分镜首帧图提示词（imagePrompt）、人物对白（dialogue）与环境音效（sound）。时长（seconds）设为 1–60 秒整数。

### 阶段二：资产核验与确定性编译 (Asset Pinning & Compilation)

1. **查验已有个人资产**：
   - 调用 `media_references` 检索个人资料库中已有的图片条目（获得 `id` 和 64 位 SHA-256 `version`）。
   - 若用户指定某张图片为角色设定或镜头首帧，将 `{ id, version }` 填入对应的 `reference` 或 `firstFrame`。
2. **分镜连续性（Continuity）决策**：
   - 默认连续性为 `"none"`。每一镜的连续性是导演构思，并非按顺序自动接续。
   - 首个镜头（Shot 1）的 `continuity` 严禁为 `"previous-tail"`，必须为 `"none"`。
   - **不同场景禁止自动续接**：当相邻两镜头的 `sceneId` 不同时，禁止使用 `"previous-tail"`（跨场景必须设置 `continuity: "none"`）。
   - 同一分镜若已指定 `firstFrame`，严禁再设 `"previous-tail"`。
3. **编译路径选择**：
   - **路径 A：原生媒体画布（Canvas Route）**
     - 适用情形：涉及角色与场景参考图网络、分镜需要尾帧约束（`lastFrame`）、需要直观可视化交互审查。
     - 运行编译命令：
       ```bash
       node "<skill-dir>/scripts/compile-story.cjs" plan.json --mode canvas --thread <threadId> --output canvas-params.json
       ```
     - 产物符合 `media_canvas` 的 `create` 参数格式。
   - **路径 B：分镜视频队列（Sequence Route）**
     - 适用情形：线性故事连续生成，无需复杂的网状参考或复杂的尾帧约束。
     - 运行编译命令：
       ```bash
       node "<skill-dir>/scripts/compile-story.cjs" plan.json --mode sequence --video-profile <profileId> --output sequence-params.json
       ```
     - 产物符合 `media_sequence_create` 参数格式，强制 `start: false`。
     - 命令中的 `<skill-dir>` 是当前 `SKILL.md` 所在绝对目录，使用已可用的 Node.js。输出参数 JSON 后读取文件内容，再调用对应 MCP 工具；编译本身不会创建产品数据。
     - **边界约束**：当前队列工具缺少 `lastFrame` 与 `aspect` 输入字段。若计划包含 `lastFrame`，必须使用画布路径；不能声称竖屏计划已约束原始视频比例，应核对提供商默认值或在 `media_edit` 设置成片画幅。
     - **资产防丢约束**：若实体有参考图，而分镜 `continuity: "none"` 且无 `firstFrame`，队列编译将报错拒绝，引导先生成或选定分镜图作为 `firstFrame`。

### 阶段三：分步生成与执行管控 (Execution & Generation Control)

1. **模型能力与环境核验**：
   - 调用 `media_models` 查看已配置且 `agentEnabled: true` 的生图与视频模型 Profile。
   - 严禁擅自修改用户系统设置，严禁硬编码付费模型或写入外部 API 凭据。
2. **画布执行流（Canvas Execution）**：
   - 创建画布：`media_canvas({ action: 'create', title, globalPrompt, nodes, edges, idempotencyKey, threadId })`。
   - 读取最新状态（获取 CAS `revision`）：`media_canvas({ action: 'read', id: canvasId })`。
   - 在生成前通过 `media_models` 核对 `inputCapabilities`、参考图数量和首尾帧支持，使用 Agent 已启用的真实 Profile ID。编译器不做模型能力检查。
   - 生成单个分镜图或视频：`media_canvas({ action: 'generate', id: canvasId, revision, nodeId, idempotencyKey })`。图像节点先生成完成，视频才能使用其首帧；视频续接节点须等前镜完成。每步重新 read 获取 revision。
   - `generate` 返回任务后用 `media_status({id: jobId})` 查看实际完成状态。需要入队列或后期的图像/视频，用 `media_save({id: jobId})` 保存到个人资料库，并把真实 id + SHA-256 写回计划；不同类型的任务 ID、素材 ID、画布节点 ID 不能混用。
3. **队列执行流（Sequence Execution）**：
   - 创建队列（默认暂停）：`media_sequence_create({ title, globalPrompt, defaults: { profileId }, shots, start: false, idempotencyKey })`。
   - 启动生产（仅在用户明确要求生成时）：`media_sequence_control({ id: sequenceId, action: 'start' })`。
   - 查看进度与阻断状态：`media_sequence_status({ id: sequenceId })`。
   - 仅在当前镜指定 `continuity: 'previous-tail'` 时，队列才会提取前镜真实尾帧并作为当前镜首帧；`none` 不继承。接上同一帧有助连续，但不保证动作和角色外观完全一致。
   - 已授权整段生成时，创建后直接启动；若仅要求草稿则保留 ready。暂停只阻止后续派发，不撤销已提交的请求；未知结果必须保留并检查，不得重发。

### 阶段四：本地剪辑与后期精修 (Zero-Cost Local Post-Production)

确认所需镜头均完成并检查画面、声音后再剪辑；不能把只有部分完成镜头的片段说成全片。下述剪辑和转录在本地运行；第 3 项重拍会重新调用视频模型。

1. **视频剪辑与画幅裁剪 (`media_edit`)**：
   - 打开工程：`media_edit({ action: 'create', sequenceId })` 或从资料库导入 `media_edit({ action: 'import', title, references: [{ id, version }], idempotencyKey })`。
   - 调整剪辑时间线与画幅：读取当前 `revision`，调用 `media_edit({ action: 'update', id, revision, edit: { aspect: '16:9' | '9:16' | '1:1', clips: [{ id, startFrame, endFrame, volume, fadeFrames, fit, rotation, mirror }] } })`。
   - 导出成片：`media_edit({ action: 'export', id, revision, idempotencyKey })`。用 `media_edit({ action: 'status', id: renderJobId })` 等待成功后，导出视频才会保存至个人资料库。导出会重新编码，不能承诺无损；FFmpeg 需已可用。
2. **本地语音转录与字幕 (`media_subtitles`)**：
   - 需用户已在设置中配置可用的 whisper.cpp 程序和模型，免远程费用；缺少配置时报告具体缺口，也可手工编写或导入 SRT，不擅自下载模型。
   - 启动转录：`media_subtitles({ action: 'start', id: editProjectId, revision, idempotencyKey })`。
   - 检查任务状态：`media_subtitles({ action: 'status', id: subtitleJobId })`。
   - 先校对识别文本、时间，再将字幕应用回剪辑工程：`media_subtitles({ action: 'apply', id: subtitleJobId, revision: unchangedProjectRevision })`。项目已被修改则停止应用并重新核对。
3. **瑕疵片段局部重拍 (`media_retake`)**：
   - 这是需授权的视频模型生成，会消耗额度。它按区间首尾帧生成替换候选，不是直接理解、编辑原视频；需模型支持双向帧约束，完成后先预览再应用：
     `media_retake({ action: 'start', id: editProjectId, revision, clipId, startFrame, endFrame, profileId, prompt, idempotencyKey })`。

---

## 三、Studio MCP 工具入参规范速查

所有工具严格映射 `desktop/studio-mcp.js` 中的现存 Schema，严禁自造字段：

| 工具名称 | 核心操作 (`action` 或方法) | 必须参数与精确字段 | 关键说明 |
| :--- | :--- | :--- | :--- |
| `media_models` | 查询模型列表 | `{}` | 查询已配置模型及 `agentEnabled` 状态 |
| `media_references`| 查询资料库图片 | `{}` | 获取已有资产的 `{ id, name, version }`（version 为 64 位 SHA-256） |
| `media_canvas` | `create` | `{ action: "create", title, globalPrompt?, nodes, edges, idempotencyKey, threadId? }` | 创建原生媒体无限画布 |
| `media_canvas` | `read` | `{ action: "read", id }` | 读取画布当前节点、连线与最新 `revision` |
| `media_canvas` | `generate` | `{ action: "generate", id, revision, nodeId, idempotencyKey }` | 对画布中指定图像/视频节点触发生成 |
| `media_sequence_create` | 创建分镜队列 | `{ title, globalPrompt?, defaults: { profileId, seconds? }, shots: [{ id?, prompt, seconds?, continuity?, firstFrame? }], start: false, idempotencyKey? }` | 创建分镜生成队列。必须设 `start: false`；不支持 `lastFrame` 与 `aspect` |
| `media_sequence_control`| 队列状态控制 | `{ id, action: "start" \| "pause" \| "resume" \| "cancel" }` | 控制分镜队列启停，启动前校验模型启用状态 |
| `media_sequence_status` | 队列状态查询 | `{ id }` | 读取每镜完成状态、尾帧提取与受阻原因 |
| `media_extract_frame` | 视频尾帧提取 | `{ id, index? }` | 导出已完成视频的真实显示尾帧至个人资产库 |
| `media_edit` | `create` / `read` / `update` / `export` | `create`: `{ action: "create", sequenceId }`<br>`update`: `{ action: "update", id, revision, edit: { aspect?, clips, captions? } }`<br>`export`: `{ action: "export", id, revision, idempotencyKey }` | 本地 FFmpeg 剪辑工程，不消耗模型费用。支持 30fps 帧级别精修与画幅裁剪 |
| `media_subtitles` | `start` / `status` / `apply` | `start`: `{ action: "start", id, revision, idempotencyKey }`<br>`apply`: `{ action: "apply", id, revision }` | 本地 whisper.cpp 语音转录与字幕加载，需已有程序和模型配置 |
| `media_retake` | `start` / `apply` / `undo` | `start`: `{ action: "start", id, revision, clipId, startFrame, endFrame, profileId, prompt, idempotencyKey }` | 首尾帧约束视频片段定向重拍 |
