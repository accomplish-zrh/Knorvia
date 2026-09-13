# 短剧制作 Plan v1 数据规范与编译契约

本规范定义 Knorvia 短剧制作技能的核心数据契约（Plan v1）。该格式连接用户意图、Agent 创意编排与底层的媒体生成/画布系统，由独立脚本 `compile-story.cjs` 统一进行确定性校验与编译。

---

## 一、Plan v1 数据结构与字段定义

Plan v1 为单集或单批次短剧的完整策划描述，JSON 根对象包含剧本全局设定、实体池（角色、场景、道具）及分镜列表：

```typescript
interface PlanV1 {
  schemaVersion: 1;              // 必填，固定整数 1
  id: string;                    // 必填，计划全局唯一标识（ASCII）
  title: string;                 // 必填，短剧标题（≤100 字符）
  globalPrompt?: string;         // 可选，全局风格/画面基调提示词（≤6000 字符）
  aspect?: "16:9" | "9:16" | "1:1"; // 可选，画面画幅比例，默认 "16:9"
  characters?: Entity[];         // 可选，角色列表（与场景、道具共享实体容量与唯一性）
  scenes?: Entity[];             // 可选，场景列表
  props?: Entity[];              // 可选，道具列表
  shots: Shot[];                 // 必填，分镜列表（1–40 个镜头）
}

interface Entity {
  id: string;                    // 必填，实体唯一标识（ASCII，全表唯一）
  name: string;                  // 必填，实体名称（≤100 字符）
  description: string;           // 必填，实体具体视觉与设定描述（≤1800 字符）
  reference?: AssetReference;    // 可选，个人资料库中固化的真实资产引用
}

interface AssetReference {
  id: string;                    // 必填，个人资料库条目 ID（来自 media_references）
  version: string;               // 必填，精确 64 位十六进制 SHA-256 哈希版本
}

interface Shot {
  id: string;                    // 必填，分镜唯一标识（ASCII）
  title: string;                 // 必填，分镜标题（≤100 字符）
  prompt: string;                // 必填，镜头视频动态生成提示词（≤4000 字符）
  imagePrompt?: string;          // 可选，单帧定妆/分镜静图提示词（≤4000 字符）
  camera?: string;               // 可选，运镜与机位描述（≤400 字符）
  dialogue?: string;             // 可选，台词内容（≤1600 字符）
  sound?: string;                // 可选，环境音效与背景配乐（≤1600 字符）
  seconds: number;               // 必填，镜头时长秒数，整数 1–60
  sceneId?: string;              // 可选，所属场景 ID（必须存在于 scenes 列表中）
  characterIds?: string[];       // 可选，出镜角色 ID 列表（必须存在于 characters 中）
  propIds?: string[];            // 可选，出镜道具 ID 列表（必须存在于 props 中）
  continuity?: "none" | "previous-tail"; // 可选，分镜连续性，默认 "none"
  firstFrame?: AssetReference;   // 可选，指定视频首帧参考图片
  lastFrame?: AssetReference;    // 可选，指定视频尾帧参考图片（画布原生支持）
}
```

---

## 二、字段约束与边界限制

1. **标识符规范 (ID Rules)**：
   - 所有的 `id`（包含 plan id、entity id、shot id）必须为纯 ASCII 字符，满足正则 `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`。
   - 实体 ID（`characters`、`scenes`、`props`）必须在三张列表中**全局唯一**，互不重名。
   - 分镜 ID（`shots[].id`）在当前 plan 内部唯一。
2. **数量与容量上限 (Capacity Limits)**：
   - 分镜数量：每份计划允许 1–40 个分镜（超过 40 镜应分拆为多集）。
   - 实体总量：`characters` + `scenes` + `props` 总数不能超过 30 个。
3. **文本长度硬限制 (Text Length Limits)**：
   - `title`、`name`：≤ 100 字符。
   - 实体 `description`：≤ 1800 字符。
   - 镜头 `prompt`、`imagePrompt`：≤ 4000 字符。
   - 运镜 `camera`：≤ 400 字符。
   - 台词 `dialogue`、音效 `sound`：≤ 1600 字符。
   - 全局提示词 `globalPrompt`：≤ 6000 字符。
   - 镜头时长 `seconds`：必须为整数 1–60。

---

## 三、硬性校验与拒绝规则 (Rejection Invariants)

编译器与校验器严格执行以下防错与安全不变量：

1. **未知字段与空白内容拒绝**：
   - 严禁出现未定义的额外属性；严禁必填字段出现空白字符串或类型不符。
2. **悬空引用拒绝 (Dangling References)**：
   - 镜头的 `sceneId` 必须在 `scenes` 中声明。
   - 镜头的 `characterIds` 中的每一个 ID 必须在 `characters` 中声明。
   - 镜头的 `propIds` 中的每一个 ID 必须在 `props` 中声明。
   - 同一镜头中禁止出现重复的关联 ID。
3. **真实资产引用纪律 (Asset References)**：
   - `reference`、`firstFrame`、`lastFrame` 必须通过 `media_references` 获得真实资料库条目的 `id` 和 64 位 SHA-256 `version`。
   - 绝不允许填写外部 HTTP URL 或 API Key。
4. **镜头连续性规则 (Continuity Rules)**：
   - 默认连续性为 `"none"`。镜头连续性属于导演构思，并非相邻镜头的必然物理延伸。
   - **首镜禁止续接**：第一个镜头的 `continuity` 严禁设为 `"previous-tail"`，必须为 `"none"`。
   - **跨场景严禁续接**：当相邻两镜的 `sceneId` 不同时，严禁使用 `"previous-tail"`（必须分场景处理或设为 `"none"`）。
   - **首帧冲突拒绝**：严禁在同一分镜中同时指定 `firstFrame` 和 `"previous-tail"`，二者互斥，不可隐式覆盖。
5. **分镜队列路径特定限制 (Sequence Route Invariants)**：
   - 当前分镜队列 MCP (`media_sequence_create`) 工具底层**缺少 `lastFrame` 与 `aspect` 字段**，严禁在队列模式中发明未知字段。若分镜要求 `lastFrame` 尾帧约束，队列编译必须拒绝，并向用户明确建议切换到原生画布（Canvas）路径。
   - **参考图防丢保护**：当镜头连续性为 `"none"`，且出镜角色/场景/道具已有关联参考图时，必须提供已生成的定妆图作为 `firstFrame`，否则队列编译必须拒绝，防止在视频生成过程中静默丢失已有的设定参考。

---

## 四、编译器 CLI 与接口规范

编译脚本位于本技能根目录的 `scripts/compile-story.cjs`，只使用 Node.js 原生模块。下面 `<skill-dir>` 必须替换为当前 `SKILL.md` 所在的绝对目录；计划和输出文件放在当前任务的工作目录内。安装后的技能不依赖 Knorvia 源码路径。

### 1. CLI 命令行调用

```bash
node "<skill-dir>/scripts/compile-story.cjs" PLAN.json --mode validate|canvas|sequence [--image-profile ID] [--video-profile ID] [--thread ID] [--output FILE.json]
```

- `--mode validate`（默认）：仅校验 Plan v1 数据合规性，通过则输出格式化后的标准化 JSON。
- `--mode canvas`：编译为原生画布 `media_canvas` 的 `create` 动作入参。
- `--mode sequence`：编译为分镜队列 `media_sequence_create` 的创建入参（强制 `start: false`）。
- `--image-profile` / `--video-profile`：指定生图与视频模型 Profile ID（通过 `media_models` 检索）。
- `--thread`：关联会话线程 ID。
- `--output`：输出到目标文件（必须独占创建，不静默覆盖已有文件）。
- 上述是参数语法，`validate|canvas|sequence` 表示三选一，方括号表示可选参数；不要把竖线或方括号原样作为命令运行。
- 画布最多 80 节点、200 连线；实体、参考图也占节点。40 镜只是计划格式上限，较复杂的计划须拆成更小的画布批次。单个图像节点最多接 6 张参考图，模型实际支持数量可能更少。
- `--thread` 仅用于画布关联对话。队列当前不接收画幅字段，竖屏计划的原始素材比例不能由编译成功保证，须核对视频提供商或后期裁剪。

### 2. CommonJS API 导出

- `normalizePlan(input: unknown): PlanV1`：解析、清洗、验证 Plan v1，生成标准化内存对象。
- `compileCanvas(input: unknown, options?: CanvasOptions): CanvasCreateParams`：生成原生媒体画布图节点与连接线。
- `compileSequence(input: unknown, options: SequenceOptions): SequenceCreateParams`：生成分镜队列任务参数。
