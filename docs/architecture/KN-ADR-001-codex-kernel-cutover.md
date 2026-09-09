# Knorvia 超级工作台：Codex 内核换代最终定案与 Agent 执行总纲

> 决策编号：`KN-ADR-001`  
> 文档版本：`2.0`  
> 状态：`ACCEPTED / GO / 尚未动工`  
> 定案日期：2026-09-04  
> Codex 审阅基线：`openai/codex@8e6a44b428e31f91b21edc97904fcdf4f0931ade`  
> 现有产品仓库：`D:\tools\Knorvia`  
> 目标内核仓库：`D:\tools\knorvia-kernel`  
> 配套长期目标：桌面文件《Knorvia-超级工作台-指导GOAL.md》

---

## 0. 如何使用这份总纲

这不是讨论稿、灵感清单或可选建议，而是 Knorvia 换核计划的**执行宪章**。接手的编码 Agent 应以此为已批准架构，直接完成调查、建基线、实现、验证、迁移和收尾；不得把“再写一份方案”当作进度。

本文件回答五件事：

1. 最终要建成什么；
2. 哪些决定已经冻结，哪些实现细节仍可由 Agent 自主选择；
3. 新旧系统如何分层、迁移和切流；
4. 第一批工作如何按依赖顺序落地；
5. 以什么证据判定一个切片、阶段和整个换核真正完成。

### 0.1 指令优先级

执行时按以下顺序处理冲突：

1. 当前运行环境的系统、安全和用户最新明确指令；
2. 本总纲中的冻结决策与不可妥协项；
3. 两个仓库作用域内最新的 `AGENTS.md`；
4. 已接受 ADR、协议和迁移规范；
5. 工单、阶段计划和局部实现偏好。

现有 `D:\tools\Knorvia\AGENTS.md` 描述的是旧 Agent Runtime。它的工作树保护、测试和代码质量要求继续有效；其中把 `ChatOrchestrator`、`StreamBus`、Python Agent Loop 视为长期中心的架构描述，已被本定案取代。首阶段必须更新该文件，避免后续 Agent 收到相互矛盾的指导。

### 0.2 决策分类

文中使用三类标签：

- **冻结决定**：不得由实现 Agent 私自重开讨论；若确需改变，必须写 ADR，说明新证据、迁移代价和对北极星目标的影响，并由项目决策者接受。
- **实现授权**：Agent 可基于源码和测试选择最优实现，不需要逐项请示，但必须记录关键取舍。
- **待验证假设**：开始改动前用源码、实验或最小原型验证；验证失败时调整实现，不改变冻结目标。

### 0.3 冻结项、授权项与待验证项

| 类型 | 内容 |
|---|---|
| 冻结 | 超级工作台定位；完整 Git 历史 Fork；Knorvia/Codex 全维度隔离；稳定 Knorvia Protocol；模型中立；单一最终 Runtime；领域能力 Pack/Worker 化；无损迁移；旧底座最终删除 |
| 实现授权 | Daemon 与 Kernel 最终采用进程内还是私有子进程；具体 crate/module 划分；数据库引擎和表设计；前端局部重构或重写；首个领域 Pack；算法和测试组织 |
| 待验证 | 固定基线在开工工具链上的构建状态；上游 Extension/Model Provider 的最窄接入点；当前全部用户数据位置；各 Provider 的真实能力；跨平台 Sandbox/IPC 差异 |

实现 Agent 可以大胆改变“怎么做”，不能私自降低“做到什么程度”。待验证项失败时应换实现路径，而不是把冻结目标降级。

### 0.4 一句话定案

**完整 Fork OpenAI Codex 开源仓库与 Git 历史，以其 Rust Agent Runtime 为 Knorvia 新内核；彻底建立 Knorvia 自有的命令、协议、数据、凭据、进程、发行、扩展和产品控制面；把现有领域能力迁成 Capability Pack、Tool、Artifact、Job 或 Worker；最终删除 Python `ChatOrchestrator`、自研 Agent Loop、`StreamBus` 和重复会话控制的生产路径，将 Knorvia 建成不限于学习、创作或代码的 Agent 原生超级工作台。**

**冻结决定：GO。后续不再讨论“是否换核”，只优化“如何以最高长期质量完成”。**

---

## 1. 最终产品定义

### 1.1 北极星

Knorvia 是一个本地优先、模型中立、Agent 原生、可扩展、可审计并能长期演进的超级工作台。用户应能在同一 Workspace 中：

- 提出并持续推进跨轮次、跨任务、跨设备的 Goal；
- 组织文件、知识、数据、应用、人员、Agent 和环境；
- 让一个或多个 Agent 规划、执行、协作、请求输入和接受审阅；
- 安全调用本机、浏览器、云服务、数据库、Office、开发和媒体工具；
- 将结果沉淀为可版本化、可比较、可回滚、有来源的 Artifact；
- 让长任务在后台暂停、恢复、重试、取消和定时运行；
- 在 Activity 中看到“谁在何时因何目标做了什么、获得了何种授权、改变了什么、结果和证据是什么”。

Chat 是重要交互方式，但不再是产品中心。产品中心是 **Workspace + Goal/Task + 可验证行动 + Artifact**。

### 1.2 一级产品对象

| 对象 | 责任 | 不应退化成 |
|---|---|---|
| Workspace | 工作的长期边界；包含资源、成员、策略、环境和默认能力 | 一个聊天文件夹 |
| Goal | 可跨会话持续推进的目标，带状态、预算和完成条件 | 一段临时提示词 |
| Task | 有负责人、依赖、状态、输入、输出和验收的工作单元 | 隐藏在思维链里的计划项 |
| Thread | 人与 Agent 围绕任务协作的可恢复上下文 | 纯消息列表 |
| Turn | 一次请求引发的完整执行周期 | 一次 HTTP 调用 |
| Item | 消息、计划、工具、命令、文件、审批、进度、错误等强类型事件 | 无结构日志文本 |
| Artifact | 文档、表格、幻灯片、代码、图像、视频、数据集等成果 | 工具返回的一大段 Base64 或临时路径 |
| Revision | Artifact 的不可变版本与 lineage | 原地覆盖文件 |
| Job | 可持久、可恢复、可取消的长任务 | 内存中的后台协程 |
| Agent | 有身份、角色、权限、模型、工具和记忆边界的执行者 | 一个 provider 名称 |
| Automation | 由时间、事件或状态触发的长期工作 | 只存 cron 字符串 |
| Connection | MCP、App、CLI、API、数据库、云盘和外部系统连接 | 散落的密钥字段 |
| Capability Pack | 可安装、授权、升级、禁用、卸载的领域能力单元 | 硬编码进主循环的功能开关 |
| Policy | 模型、成本、网络、文件、审批、隐私和治理规则 | UI 上没有执行力的设置 |

### 1.3 长期一级界面

- Home
- Workspaces
- Goals & Tasks
- Artifacts
- Automations
- Agents
- Connections
- Library
- Capability Packs
- Activity & Review
- Settings

Learning、Research、Office、Developer、Data、Media、Personal Knowledge、Operations、Enterprise 是 Workspace 模板和 Capability Pack，不再定义整个产品边界。

### 1.4 非目标

以下不是本项目目标：

- 复制 Codex TUI、IDE Extension 或 Codex Cloud 产品；
- 用 Knorvia Logo 包装一个外部 `codex` 子进程；
- 对上游全部 `codex-*` crate 做机械改名；
- 为“代码原创率”从零重写成熟的执行、沙盒和会话机制；
- 为保住旧页面和旧 REST 形状而扭曲新内核；
- 第一阶段就建设完整多租户云平台；
- 把 Python、Node 或现有领域库全部改写成 Rust；
- 永久维护两套 Agent Runtime；
- 只支持 OpenAI、只支持代码任务，或仍把产品限定在学习与创作。

---

## 2. 起点事实与资产处置

### 2.1 当前起点快照

截至定案时，`D:\tools\Knorvia`：

- 位于 `main`，相对 `origin/main` ahead 9；
- 工作树已有用户未提交改动，集中在 Office Artifacts、Creative Library 及对应 Web/Test 文件；
- Python 公共命令由 `pyproject.toml` 的 `knorvia = "knorvia_cli.main:main"` 提供；
- 产品入口覆盖 Typer CLI、FastAPI/Unified WebSocket、Next.js Web 与 Electron Desktop；
- 核心链路为 `ChatOrchestrator → Capability/Tool Registry → StreamBus → CLI/WS/SDK`；
- 已有 SessionStore、Turn Event、RAG、Memory、Office Artifact、GenOffice、Media、Classroom、Partners、Cron、MCP、Skills、多 Provider 和大量测试。

该快照只用于提醒风险，不能替代开工时重新执行只读盘点。**不得 reset、checkout、clean、覆盖、移动或擅自 stash 用户已有改动。** 若改动表面重叠，先选择不重叠工作面、独立 worktree 或请用户决定归属。

### 2.2 必须保留并升级的资产

- RAG、知识库、解析、检索和索引能力；
- 分层记忆、Persona、Skills、MCP 和外部连接；
- Office Artifact Runtime 的事务、Revision、Diff、Verification、Publication 思路；
- GenOffice 接入及 Office 生产能力；
- 图片、视频、语音、课堂、题库、研究和创意库；
- Partners、Cron、外部 CLI Agent 和多 Agent 使用场景；
- 多供应商模型目录、能力探测、错误映射和配置经验；
- Next.js、Electron、双语产品界面和发行经验；
- 已存在的数据、测试、兼容处理和用户路径。

“保留”指保留价值与行为，不强制保留当前代码形状。可以原地复用、封装、迁移或重写，判断标准是长期边界、可靠性和维护成本。

### 2.3 最终必须退出生产路径的旧底座

- `knorvia/runtime/orchestrator.py` 中的 `ChatOrchestrator`；
- `knorvia/core/agentic/*` 自研 Agent Loop；
- `knorvia/core/stream.py` 与 `stream_bus.py` 作为公共事实协议；
- Python 对 Thread/Turn、取消、恢复、工具调度和上下文压缩的重复控制；
- 把 Chat Completions 消息数组当作产品状态模型的实现；
- 由 FastAPI Router、进程内注册表或全局字典共同拥有的执行状态；
- 领域能力直接“接管整个聊天回合”的长期扩展模式；
- 把外部 CLI 拼装当作统一多 Agent 内核的方式；
- 未形成完整策略、审批和审计链的自研沙盒路径。

旧代码可在迁移期作为 Oracle、兼容层和回滚来源；禁止继续增加新的永久抽象。

### 2.4 Codex 可复用边界

Codex 开源 Rust Workspace 已提供适合作为底座的能力：Thread/Turn/Item、上下文与压缩、工具与命令、文件修改、终端、Sandbox/Approval、MCP、Skills、Plugins、Hooks、Goal、Memory、Worktree、多 Agent、Thread Store、Rollout、App Server 和 Schema 生成。

官方 App Server 的定位正是为自有产品提供认证、会话历史、审批和流式 Agent 事件。其协议要求连接后先 `initialize` 再 `initialized`，并区分稳定面与需显式启用的 `experimentalApi`。Knorvia 应借用这一成熟语义，但不把上游内部协议未经隔离地永久暴露给产品。

### 2.5 法律、品牌与认证事实

- Codex 仓库采用 Apache License 2.0；派生与再发行必须保留适用 LICENSE、NOTICE、版权和变更说明。
- Apache 2.0 不授予 OpenAI/Codex 商标权；Knorvia 不得暗示自己是 OpenAI 官方产品。
- 当前 Knorvia 固定上游 OAuth Client ID 和 `chatgpt.com/backend-api/codex/*` 的实现不能成为新产品的商业基础。
- `clientInfo.name`、User-Agent、Telemetry 和登录身份必须真实标识 Knorvia，不得伪装为 `codex_cli_rs`、`codex_vscode` 或其他官方客户端。
- 若未来接入 OpenAI 企业 Compliance Logs，按官方要求联系 OpenAI 登记 Knorvia client identity；登记完成前也不得借用已知官方 client 名称。
- 用户自有 API Key、企业网关、Knorvia 官方网关和本地模型必须是一等路径；受支持的 ChatGPT/Codex 登录只能是可选集成。

---

## 3. 核心架构定案

### 3.1 Fork-first，而不是 SDK 套壳或零散摘抄

**冻结决定：完整 Fork `openai/codex` 仓库和 Git 历史。**

正确起步：

1. 以审阅基线提交建立可重复的上游基线；
2. 原样编译并记录上游行为与测试证据；
3. 建立独立 Knorvia 发行面与身份隔离；
4. 再增加 Daemon、Protocol、Provider Gateway 和 Capability Host；
5. 最后按纵向切片迁移现有产品。

不接受：下载源码压缩包、只复制 `core`/`app-server`、把外部 `codex` CLI 当生产依赖、先大规模品牌替换再尝试编译。

### 3.2 为什么这样最利于未来

- 完整保留成熟 Runtime 的边缘条件、安全修复和跨平台演进；
- 可以持续吸收 upstream，而不是形成一次性源码快照；
- Knorvia 掌握自己的发行、协议、扩展和产品节奏；
- 领域创新被隔离在稳定门面之外，不污染核心；
- 未来可替换模型、UI、Worker 和云部署，而不重造 Agent 生命周期。

### 3.3 最终分层

```text
┌──────────────────────────────────────────────────────────────────────┐
│                       Experience Plane                               │
│ Desktop · Web · CLI · Mobile · Review · Notifications · SDK         │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ Knorvia Protocol（稳定公共契约）
┌───────────────────────────────▼──────────────────────────────────────┐
│                    knorvia-daemon / Control Plane                    │
│ Workspace · Goal · Task · Artifact · Job · Automation · Policy      │
│ Auth · Vault · Event Journal · Projection · Scheduler · Supervisor  │
├──────────────────────────────────────────────────────────────────────┤
│                    Knorvia Agent Kernel                              │
│           Codex-derived Rust Runtime；不是外部 Codex CLI             │
│ Thread · Turn · Item · Context · Tool · Sandbox · Approval           │
│ Terminal · Files · MCP · Skills · Plugins · Memory · Multi-agent     │
├──────────────────────────────────────────────────────────────────────┤
│                 Stable Knorvia Extension Boundary                    │
│ Extension API · Provider Gateway · Capability RPC · Pack Runtime     │
├──────────────────────┬─────────────────────┬─────────────────────────┤
│ Python Workers       │ Node/TS Workers     │ Native/Remote Workers   │
│ RAG/Parsing/ML/Data  │ Office/Render       │ OS/Browser/Enterprise   │
│ Media/Legacy Bridge  │ UI-side engines     │ Apps/Cloud services     │
└──────────────────────┴─────────────────────┴─────────────────────────┘
```

### 3.4 各层唯一职责

| 层 | 唯一职责 | 禁止承担 |
|---|---|---|
| Experience | 展示、编辑、用户输入、本地 UI 状态 | Provider Secret、Agent 真相状态、任意命令执行 |
| Daemon | 产品控制面、生命周期、策略、持久业务对象、Worker 管理、对外协议 | 模型供应商私有细节、领域算法 |
| Kernel | Agent 执行、上下文、工具生命周期、Sandbox、Approval、Thread/Turn/Item | Office/RAG/学习等领域对象、产品导航 |
| Provider Gateway | 模型能力协商、请求/事件转换、重试、用量 | 产品 Task/Artifact 状态 |
| Capability Host | 发现、授权、启动、调用、取消、回收 Worker | 直接决定用户全局策略 |
| Worker/Pack | 领域能力和重依赖 | 公共端口、主会话所有权、读取全部环境变量 |

### 3.5 本地与云端同构

- 本地版：单用户 Daemon + 本地 Kernel/Worker + SQLite/对象目录；
- 团队/云版：多租户 Control Plane + Postgres/对象存储 + 分布式 Worker；
- 二者共享对象标识、协议语义、Capability Manifest、Policy 和事件类型；
- 本地版不依赖云端才能完成核心工作；
- 同步是显式、版本化服务，不直接把活动数据库目录交给云盘同步。

云端实现不是初始切片阻塞项，但所有本地接口不得把 `localhost`、单进程、单用户或 SQLite 行为写死为公共语义。

### 3.6 Kernel 进程拓扑

长期首选由 `knorvia-daemon` 通过 Rust library/facade 在同一受控发行中拥有 Kernel 生命周期，减少重复协议和状态竞争。若上游结构使第一阶段进程内集成风险过高，可先由 Daemon 监督一个**随 Knorvia 签名发行、使用 Knorvia Home、没有公共 PATH 入口**的私有 Kernel/App Server 子进程；它只是内部实现细节，不能让客户端直接连接，也不能调用系统中现有的 `codex`。

从私有子进程转为进程内不是必须为了形式而做；最终判断依据是崩溃隔离、升级、内存、调试和上游同步质量。但无论拓扑如何，Daemon 都是唯一产品控制面，Kernel store 只有一个权威实例，公开行为只由 Knorvia Protocol 定义。

---

## 4. 仓库、分支与上游治理

### 4.1 仓库边界

```text
D:\tools\knorvia-kernel     # Codex 全历史派生；Rust Kernel/Daemon/Protocol/CLI
D:\tools\Knorvia            # 现有产品、Web/Desktop、领域 Worker、迁移来源
```

目标内核结构如下；目录按纵向切片需要创建，禁止一次性生成大量空 crate：

```text
knorvia-kernel/
├─ codex-rs/                       # 保持上游布局和大部分内部 crate 名称
├─ knorvia-rs/
│  ├─ daemon/                      # 产品控制面与进程监督
│  ├─ cli/                         # 最终唯一公共 knorvia CLI
│  ├─ protocol/                    # 稳定 Knorvia Protocol 与生成器
│  ├─ platform-paths/              # Home、配置、数据、缓存、日志、run 目录
│  ├─ extension-api/               # 对上游 Extension API 的稳定门面
│  ├─ provider-gateway/            # 模型能力与协议转换
│  ├─ capability-protocol/         # Worker RPC 与 Manifest
│  ├─ capability-host/             # Worker 监督、权限和资源限制
│  ├─ workspace-store/             # Workspace/Goal/Task 等产品对象
│  ├─ artifact-runtime/            # Artifact/Revision/Transaction
│  ├─ job-runtime/                 # Job 状态机、重试、恢复
│  ├─ policy/                      # Policy/Approval/Grant
│  └─ migration/                   # 旧 Knorvia 导入器
├─ docs/architecture/
├─ docs/migration/
├─ LICENSE
├─ NOTICE
├─ THIRD_PARTY_NOTICES.md
├─ UPSTREAM.md
└─ PATCHES.md
```

### 4.2 首次建仓的不可变工序

`FORK-001` 必须按以下原子步骤完成：

1. 检查目标目录是否已存在；存在则只读识别，不覆盖。
2. 从官方 Git 仓库取得完整历史，而不是从临时源码包创建新仓库。
3. 将官方仓库配置为只用于拉取的 `upstream`；将 Knorvia 仓库配置为发布远端。
4. 创建并提交 `UPSTREAM.md` 和机器可读 `docs/migration/baseline.lock.json`，记录上游 URL、完整 SHA、取得时间、工具链、平台和初始测试结果。
5. 在**不含任何 Knorvia 行为改动**的提交上完成原版 build、相关 tests 和 App Server handshake smoke。
6. 将原版证据保存到 `docs/migration/evidence/upstream-baseline/`；大体积日志由清单引用，不应全部塞进 Git。
7. 只有基线可重复后，才建立首个 Knorvia Patch Set。

如果审阅基线在当前工具链上无法构建，先记录可复现故障并验证官方 main 是否已修复；通过 ADR 决定最小前置补丁或更新基线。不得悄悄换提交。

### 4.3 分支模型

- `upstream/main`：官方镜像，不含 Knorvia commit；
- `knorvia/main`：可发布主线；
- `integration/upstream-<short-sha>`：每次吸收上游的临时集成分支；
- `release/<version>`：必要时的稳定发布分支；
- 功能分支按 Work Package ID 命名。

已发布历史不强制改写；上游同步保留可追踪的 merge 边界。每次同步必须：

1. 更新上游提交和 changelog；
2. 在集成分支解决 Patch Set 冲突；
3. 重新生成上游与 Knorvia 协议 Schema；
4. 运行上游基线、Knorvia 差异、数据迁移和并存测试；
5. 更新 `UPSTREAM.md`、`PATCHES.md` 和兼容矩阵；
6. 证据齐全后合入 `knorvia/main`。

### 4.4 上游 Patch Budget

不以“修改行数少”冒充可维护，而以**核心触面少、理由清楚、可测试、可删除**衡量。所有对 `codex-rs` 上游目录的 Knorvia 修改必须归入编号 Patch Set：

| Patch Set | 允许目的 | 首选替代 |
|---|---|---|
| `KPS-001 Identity & Paths` | Home、锁、日志、凭据、客户端身份隔离 | 新 `platform-paths` crate 与依赖注入 |
| `KPS-002 Distribution` | `knorvia`/daemon 构建与打包接线 | 新发行 crate，不改内部 crate 名 |
| `KPS-003 Extension Envelope` | 让通用 Knorvia Item 进入核心生命周期和 Rollout | 单一泛型 envelope，不按领域增加 enum variant |
| `KPS-004 Provider Seam` | 接入模型中立 Gateway | 上游 Model Provider 门面/新 adapter |
| `KPS-005 Daemon Integration` | 生命周期、事件与状态桥 | 在 Knorvia Daemon 适配，不污染 `codex-core` |
| `KPS-006 Auth/Telemetry Boundary` | 真实 Knorvia 身份、关闭或替换上游产品耦合 | 可插拔 Auth/Telemetry 实现 |

每个 Patch Set 在 `PATCHES.md` 记录：目的、涉及文件、为何无法外置、行为测试、上游冲突热点、安全影响、负责人、删除/上游化条件。新增 Patch Set 或扩大核心触面必须有 ADR。

### 4.5 改名纪律

必须改为 Knorvia：

- 公共二进制、安装包、帮助、品牌和错误文案；
- Home、配置、数据、缓存、日志、运行时目录；
- Keychain/Vault service 名；
- Socket、Named Pipe、锁、进程、服务和更新通道；
- User-Agent、Client Info、Telemetry namespace；
- 公共 SDK、协议、包和扩展 namespace；
- 默认产品指令和非代码工作语义。

允许保留 Codex：

- 上游内部 crate、module、test fixture 和历史；
- LICENSE、NOTICE、版权与来源说明；
- 显式的“导入 Codex”或“连接外部 Codex Agent”功能。

禁止全仓字符串替换。品牌扫描需要 allowlist，不能把合法归属文本改掉。

---

## 5. 发行与 Codex 完全隔离

### 5.1 公共进程定案

- 最终唯一公共 CLI：`knorvia`；
- 产品控制进程：`knorvia-daemon`，桌面安装时作为私有 sidecar，不抢占全局命令；
- 不发布名为 `codex` 的 Knorvia 二进制；
- 不把 `knorvia-kernel` 作为永久用户命令；该名称只描述仓库和内部组件；
- 迁移期 Python `knorvia` 继续服务旧发行，Rust CLI 达到门禁后以一次受控发行接管；同一安装环境不得同时注册两个 `knorvia` 可执行入口。

### 5.2 隔离矩阵

| 维度 | Codex | Knorvia 要求 |
|---|---|---|
| 命令 | `codex` | `knorvia` |
| Home override | `CODEX_HOME` | `KNORVIA_HOME` |
| 默认目录 | `.codex` / Codex 平台目录 | 由 `knorvia-platform-paths` 解析的 Knorvia 目录 |
| 配置 | Codex config | Knorvia config/catalog/policy |
| Thread/State | Codex sessions/state | Knorvia Kernel store + Product store |
| 凭据 | Codex/OpenAI keychain | Knorvia Vault namespace |
| IPC | Codex stdio/socket | Knorvia stdio/pipe/socket namespace |
| 锁/服务 | Codex namespace | Knorvia namespace |
| 更新 | Codex channel | Knorvia channel与签名 |
| 遥测 | Codex client | Knorvia client；未审计前默认关闭派生产品遥测 |
| 崩溃报告 | Codex namespace | Knorvia namespace；强制脱敏 |

硬门禁：

- 默认路径解析不得读取或写入 `.codex`；
- 只有用户明确触发导入时，迁移器才可只读访问 Codex 数据；
- `CODEX_HOME` 与 `KNORVIA_HOME` 同时存在时互不覆盖；
- Codex 与 Knorvia 同时安装、启动、升级、登录、运行任务和卸载均互不影响；
- Knorvia 不复用 Codex 的端口、pipe、锁文件、keychain key、自动更新 feed 或 telemetry client id；
- 并存测试必须监视两个 Home 的文件变化，不能只验证进程“看似能启动”。

### 5.3 Knorvia Home 契约

`knorvia-platform-paths` 是全系统唯一的路径解析入口；其他 crate、Worker 和前端不得自行拼接用户目录。`KNORVIA_HOME` 存在时，它覆盖整个可迁移 Home；未设置时采用平台应用数据目录：Windows `%LOCALAPPDATA%\Knorvia`、macOS `~/Library/Application Support/Knorvia`、Linux `${XDG_DATA_HOME:-~/.local/share}/knorvia`。若后续决定分离 XDG config/cache，必须保持逻辑 API 和备份语义不变并写 ADR。

逻辑目录固定为：

```text
config/       # versioned config，不能含明文 secret
state/        # product/kernel databases and manifests
artifacts/    # content-addressed artifact/blob storage
packs/        # installed pack manifests and immutable payloads
cache/        # 可安全重建
logs/         # 脱敏、有限 retention
run/          # pipe/lock/pid/ephemeral leases，不进入备份
backups/      # 迁移与升级快照及清单
```

所有写入采用原子替换或事务；`run/` 中的旧锁必须通过进程身份和启动 token 判定，不能仅因文件存在拒绝启动；备份默认排除 cache/log/run，但必须包含恢复所需 manifest。凭据始终放系统 Keychain/Knorvia Vault，不放 Home 文本文件。

---

## 6. Knorvia Protocol：公共稳定边界

### 6.1 三层协议，不直接裸露上游

1. **Upstream App Server Protocol**：Kernel 内部兼容面，按固定上游版本生成；
2. **Kernel Adapter**：把上游 Thread/Turn/Item、server request 和 error 归一化；
3. **Knorvia Protocol**：Desktop/Web/CLI/SDK 唯一依赖的版本化公共契约。

产品代码不得大面积 import 上游生成类型。上游实验字段只能进入隔离 adapter，并受 feature flag、契约测试和 fallback 保护。

### 6.2 传输定案

- Desktop main process 启动 `knorvia-daemon`，首选 framed stdio；无监听端口即可完成本地核心功能；
- Renderer 通过类型化 Electron IPC 连接 main process，不直接持有 daemon 句柄或 secret；
- CLI 可连接本地 daemon 或使用同一 Rust 库的 in-process facade，但行为必须与协议一致；
- 本地多进程 Worker 使用 stdio、Unix Domain Socket 或 Windows Named Pipe，由 Daemon 创建随机实例地址并鉴权；
- 未来远程连接使用 Knorvia 自己的 TLS、身份、租户、版本和重连层；不得把上游 App Server transport 原样暴露为 Knorvia 公网公共协议；
- stdout 只承载协议帧，日志全部去 stderr 或结构化日志 sink，任何 stray output 都必须在测试中使协议启动失败。

Protocol v1 的 stdio/pipe framing 采用 LSP 风格 `Content-Length: <bytes>\r\n\r\n<UTF-8 JSON>`；帧大小上限在握手协商，v1 不传内联大 Blob。上游 App Server 自身的 transport framing 由固定上游 adapter 处理，不泄漏给 Knorvia 客户端。若实测证明需要改变 framing，必须先提供跨 Rust/Node/Python 的兼容原型和 ADR。

### 6.3 初始化握手

每个连接只允许一次初始化：

```json
{
  "jsonrpc": "2.0",
  "id": "req_01",
  "method": "initialize",
  "params": {
    "protocol": {"major": 1, "minor": 0},
    "client": {"name": "knorvia_desktop", "version": "...", "platform": "..."},
    "capabilities": ["thread", "artifact", "job", "approval", "reconnect"],
    "locale": "zh-CN"
  }
}
```

服务端返回协商后的 protocol、server identity、稳定能力、preview 能力、session id、resume support 和限制；客户端随后发送 `initialized`。初始化前的其他请求、重复初始化和不兼容 major 均返回强类型错误。

Knorvia 转接上游 App Server 时也必须完成其 `initialize`/`initialized`，并使用真实的 Knorvia `clientInfo`。默认不启用 `experimentalApi`；每个确需实验字段的功能单独列入兼容矩阵。

### 6.4 版本规则

- Major：破坏兼容；客户端与服务端 major 不同则拒绝并给出升级信息；
- Minor：向后兼容增加；双方选择共同支持的最大能力集；
- Preview：使用独立 namespace/capability，不能悄悄进入 stable；
- 所有 enum 接收 `unknown` 保底；未知字段忽略并保留，未知 Item 显示通用卡片而非崩溃；
- 协议 Schema、生成 SDK、daemon 和桌面版本在 release manifest 中绑定；
- 不用 UI 版本号猜协议能力，必须通过握手协商。

### 6.5 请求、事件与幂等

每个变更请求携带：

- `requestId`：请求关联；
- `idempotencyKey`：重试不产生重复副作用；
- `expectedRevision`：需要乐观并发控制时使用；
- `traceId`：跨 Daemon/Kernel/Worker 追踪；
- `deadline`：可选截止；
- `actor`：用户、Agent、Automation 或系统身份。

每个持久事件至少携带：

- `eventId`：全局稳定 ID；
- `streamId`：Workspace/Thread/Job 等事件流；
- `seq`：该流严格递增；
- `emittedAt`：UTC 时间；
- `causationId` 与 `correlationId`；
- `schemaVersion`；
- 对应 `workspaceId/threadId/turnId/itemId/jobId/artifactId`（适用者）。

客户端确认的是 cursor，不以“最后看到的一段文字”判断状态。重复事件按 `eventId` 去重；缺口触发 replay/snapshot，而不是继续猜测。

### 6.6 核心生命周期

保持并扩展成熟的 Thread → Turn → Item 语义：

- Thread：start、resume、fork、read、list、archive、unarchive、delete；
- Turn：start、steer、interrupt、completed/failed/cancelled；
- Item：started、delta、completed/failed；
- Server Request：approval、user input、MCP elicitation、credential grant；
- Goal/Task：作为产品对象引用 Thread，不塞进消息 metadata；
- Artifact/Job：有独立状态机，并通过 Item/Activity 与执行关联。

终态只能写入一次；晚到 delta 被拒绝并记录诊断。`interrupt` 是协作式取消起点，不等于所有子进程已结束；Daemon 必须等待工具/Worker 清理并给出最终取消证据。

### 6.7 单一通用 `knorvia.item` 扩展信封

上游 extension item 是封闭枚举，新增 variant 还需 App Server 公共 wrapper。Knorvia 不按 Office、RAG、视频等领域不断修改核心枚举，而只维护一个窄 Patch：

```json
{
  "kind": "knorvia.item",
  "id": "item_...",
  "namespace": "office.presentation",
  "type": "artifact.preview",
  "schemaVersion": 1,
  "status": "running",
  "payload": {},
  "refs": {
    "artifactId": "art_...",
    "jobId": "job_..."
  }
}
```

规则：

- `namespace + type + schemaVersion` 唯一决定 payload schema；
- payload 有大小上限，文件、媒体和大数据只用 Artifact/Blob 引用；
- `uiHints` 仅是非可信展示建议，不可授予权限或决定业务状态；
- 核心只理解 ID、状态、生命周期和引用，不理解领域 payload；
- Pack 注册 Schema 与 renderer；未知 Pack 仍显示通用、可审计的 Item；
- 持久化前验证 Schema，敏感字段按策略脱敏。

### 6.8 错误模型

统一错误至少包含：

```text
code · category · message · userMessage · retryable · retryAfter
requestId · traceId · details(sanitized) · causeChain(redacted)
```

稳定类别：`INVALID_ARGUMENT`、`NOT_INITIALIZED`、`UNSUPPORTED_PROTOCOL`、`NOT_FOUND`、`CONFLICT`、`PRECONDITION_FAILED`、`UNAUTHENTICATED`、`PERMISSION_DENIED`、`POLICY_DENIED`、`CAPABILITY_UNAVAILABLE`、`PROVIDER_AUTH`、`PROVIDER_RATE_LIMIT`、`PROVIDER_UNSUPPORTED`、`CANCELLED`、`DEADLINE_EXCEEDED`、`RESOURCE_EXHAUSTED`、`TRANSIENT`、`INTERNAL`。

不得把异常堆栈、密钥、完整提示词或供应商原始响应直接送到 UI。不得吞错后发送成功终态。

### 6.9 Legacy StreamEvent 迁移

迁移存在两个方向，但只有新协议是未来事实源：

| Legacy 事件 | 新语义 |
|---|---|
| `content` | `agentMessage` delta/completed |
| `thinking` | reasoning/summary Item；遵守可见性策略 |
| `tool_call` / `tool_result` | typed tool Item lifecycle |
| `stage_start` / `stage_end` | `knorvia.item` stage lifecycle |
| `progress` | Job/Item progress |
| `sources` | citation/source-set Item |
| `result` | typed result，通常引用 Artifact/Job |
| `wait_for_input` | server request；不再用普通事件模拟 |
| `error` | failed Item/Turn + structured error |
| `done` | Turn terminal state |
| `session` / `session_meta` | Thread metadata/projection |

- 旧 UI 临时由 `NewProtocol → LegacyViewAdapter` 驱动；
- 旧 Capability Worker 由 `LegacyEvent → KnorviaItemAdapter` 驱动；
- 新代码不得主动生产 `StreamEvent`；
- Adapter 必须有 Golden Fixtures 和双向不可丢字段报告；
- 最后一个旧消费者删除后，立即删除 Adapter 和旧协议。

### 6.10 Schema 工程

- 每个固定上游版本生成 TypeScript/JSON Schema；官方生成物与版本一一对应；
- 上游基线用该版本官方命令 `codex app-server generate-ts --out <dir>` 与 `codex app-server generate-json-schema --out <dir>` 取证；Knorvia 发行另设内部生成任务，不要求用户安装 `codex`；
- Knorvia Protocol 由 Rust 类型生成 TS/Python 类型与 JSON Schema，禁止三份手写漂移；
- CI 检查 generated diff、round-trip、unknown-field、旧客户端兼容和错误快照；
- `PROTOCOL_COMPATIBILITY.md` 记录 daemon × desktop × CLI × worker × upstream matrix；
- 协议变更必须先有 fixture 和迁移策略，再改消费者。

### 6.11 Protocol v1 最小方法面

命名可在 Schema 评审时做一致化，但 v1 的能力不能缺失：

```text
system/health · system/version · event/replay
workspace/create · workspace/read · workspace/list · workspace/update
goal/create · goal/read · goal/update · goal/complete
task/create · task/read · task/list · task/update
thread/start · thread/read · thread/list · thread/resume · thread/fork · thread/archive
turn/start · turn/steer · turn/interrupt
approval/respond · userInput/respond
artifact/create · artifact/read · artifact/list · artifact/stage · artifact/commit · artifact/diff
job/create · job/read · job/list · job/cancel · job/retry · job/resume
capability/list · capability/invoke · capability/cancel
provider/list · provider/capabilities · provider/test
activity/list · activity/subscribe
```

创建/变更方法必须支持幂等和 revision；列表支持稳定 cursor；订阅与 replay 共享同一事件语义。`delete`、永久发布、凭据和 Pack 安装等高风险方法只有在对应 Policy/审计完成后进入 stable。

---

## 7. 状态所有权与数据迁移

### 7.1 单一事实源矩阵

| 数据 | 权威写入者 | 其他层如何使用 |
|---|---|---|
| Kernel Thread/Turn/Core Item/Rollout | Agent Kernel store | Daemon 只建索引、引用和产品投影 |
| Workspace/Goal/Task/Policy/Connection metadata | Daemon Product Store | UI/Worker 经协议访问 |
| Artifact metadata/head/lineage | Artifact Runtime | Worker 写 staging，Runtime 验证后提交 |
| Artifact/Blob bytes | Content-addressed Object Store | 数据库只存 hash/ref/metadata |
| Job 状态、attempt、checkpoint | Job Runtime | Worker 通过租约更新 |
| Capability domain data | 对应 Worker Store | Daemon 存稳定引用、权限和活动投影 |
| Credentials | OS Keychain/Knorvia Vault | 只下发短期 secret lease/handle |
| UI layout/draft view state | Client Store | 不作为任务完成真相 |
| Activity/Event Journal | Daemon append-only journal | Projection 可重建；Kernel 事件保留 source ref |

禁止两个数据库同时拥有同一事实的写权限。投影损坏应能从权威数据重建；不能反向覆盖源。

### 7.2 基础数据规则

- 稳定 ID 使用带类型前缀的不可变标识；迁移后保留 `legacySource + legacyId` 唯一映射；
- 所有表/事件/manifest 有 schema version；
- 变更使用事务、幂等键、revision 和 optimistic concurrency；
- 列表与事件流使用稳定 cursor，不使用易漂移 offset 承担同步；
- 删除默认 tombstone + retention；真正不可恢复删除需要显式能力和审计；
- 大对象不进事件 payload；采用 content hash、MIME、size、storage ref；
- 时间统一存 UTC，显示时本地化；
- 所有路径经安全 path service 解析，防止 traversal、符号链接逃逸和 Windows 大小写/长路径问题。

### 7.3 迁移状态机

```text
discovered → preflighted → snapshotted → imported → verified
           → activated → observed → legacy_retired
                    ↘ failed / rolled_back
```

迁移必须满足：

1. **Discover**：扫描所有历史 Home、PocketBase/SQLite、文件目录、知识库、Artifact、Memory、Settings 和附件；
2. **Preflight**：版本、空间、权限、坏文件、重复 ID、缺失 Blob 和兼容性报告；
3. **Snapshot**：迁移源只读，创建带 hash 的清单与可恢复快照；
4. **Import**：以幂等批次写新 Store，记录 migration run、cursor、mapping、warning；
5. **Verify**：数量、hash、引用完整性、抽样打开、Golden Session replay；
6. **Activate**：原子切换 active schema/home pointer，不覆盖旧源；
7. **Observe**：在回退窗口内对照关键数据和行为；
8. **Retire**：门禁通过后才移除旧写路径，旧备份按公开策略保留。

失败重跑不能重复创建对象。任何 warning 必须可导出；“部分成功”不能被显示成完整成功。

### 7.4 迁移映射

| 旧 Knorvia | 新目标 |
|---|---|
| session/message/turn_event | Kernel Thread/Turn/Item + Product projection |
| session preferences/persona | Thread config / Agent profile / Workspace defaults |
| attachments | Blob + Artifact/source reference |
| `data/user/settings/*.json` | Versioned Knorvia Config Store |
| knowledge bases/indexes | Library object + Pack-owned index；保留源和 embedding signature |
| memory documents/snapshots | Memory domain store + lineage |
| Office drafts/artifacts | Artifact/Revision/Transaction/Publication |
| image/video/classroom jobs | Job + Artifact + Pack domain state |
| cron | Automation + trigger + policy + run history |
| partner sessions | Connection + identity + Workspace/Thread mapping |
| installed skills/MCP/CLI apps | Capability/Connection catalog + permission grant |
| provider settings | Provider Gateway config + Vault handles |

### 7.5 回滚

- 每次 schema migration 有 forward 与 recovery 说明；不要求所有结构可自动 downgrade，但必须能恢复迁移前快照并启动旧版本；
- 激活前不修改旧源；激活使用原子 pointer/manifest；
- 回滚演练包含 daemon、desktop、worker 和数据，不只回滚代码；
- 新版本产生的新数据若回滚无法被旧版理解，必须导出或明确隔离，不能静默丢弃；
- 删除旧 Runtime 之前完成最后一次完整恢复演练并保存证据。

---

## 8. 模型中立的 Provider Gateway

### 8.1 冻结原则

Codex 是 Agent Runtime 上游，不是 Knorvia 的单一模型商业绑定。Kernel 不应充斥各供应商品牌分支；产品也不应把“能填 base_url”误认为完整兼容。

### 8.2 分层

```text
Kernel Model Request
        ↓
Knorvia Provider Facade
        ↓ capability negotiation / policy / budget
Canonical Model Request & Event Stream
        ↓
OpenAI Responses · Anthropic · Gemini · OpenAI-compatible · Local · Enterprise
```

上游公开自定义 Provider 主要以 Responses API 线协议工作。为了保留其他供应商的完整语义，Knorvia 必须建立受测 Gateway/adapter，而不是把所有模型假装成 OpenAI 后静默丢能力。

### 8.3 能力矩阵

按 provider + model 实测记录：

- streaming / non-streaming；
- system/developer instruction；
- tool calling、parallel tools、strict schema；
- reasoning effort/summary；
- vision/audio/file input；
- prompt caching；
- context window、max output；
- usage/cost；
- cancellation；
- retry、rate limit、auth refresh；
- response continuation/compaction；
- data residency 与企业策略。

能力协商返回 `supported / emulated / degraded / unavailable` 和原因。禁止根据模型名称猜能力，禁止静默删除图片、工具或结构化输出。

### 8.4 接入顺序

1. OpenAI Responses：建立 Kernel 基线；
2. OpenAI-compatible：验证 Gateway 抽象，不以供应商字符串分支扩散；
3. Anthropic；
4. Gemini；
5. 本地 Ollama/LM Studio 等；
6. 现有其他 Gateway 和 OAuth Provider；
7. 图像、视频、语音、Embedding 作为独立 model capability，不强塞进文本 Agent 接口。

每个 Provider 必须通过同一契约套件：流式顺序、工具参数畸形、并行工具、取消、上下文溢出、认证过期、限流、超时、未知事件、用量和降级。

### 8.5 认证边界

- 配置只存 credential reference，不存明文 secret；
- Kernel 和 Worker 按调用获得最小、短期凭据；
- UI 永不接触 Provider Secret；
- OAuth 回调、refresh token 和 account metadata 属于 Vault/Auth 服务；
- 上游 ChatGPT/Codex 登录仅在官方支持的契约内使用，并明确标注提供方；
- 无可用 Provider 时产品仍可管理本地 Workspace、Artifact 和数据。

---

## 9. Capability Pack 与 Worker Runtime

### 9.1 扩张的唯一正规方式

新领域能力不得继续修改主 Agent Loop。它必须成为以下一种或组合：

- Native Tool / Native Extension；
- MCP Server / App Connection；
- Capability Pack；
- Python/Node/Native/Remote Worker；
- Artifact editor/renderer；
- Job processor；
- Workspace template / Agent role / Skill。

### 9.2 Pack Manifest 最低字段

```text
id · version · publisher · compatibility
capabilities · tools · agents · artifactTypes · jobTypes
entrypoints · runtime · healthcheck
permissions(files/network/process/secrets/apps)
resourceLimits · concurrency · cancellation
schemas · migrations · uiContributions
dependencies · signatures · updatePolicy
```

Manifest 安装前可查看；权限变更要求重新同意；禁用/卸载不能让历史 Item 和 Artifact 无法查看。

### 9.3 Capability RPC v1

最低方法：

- `initialize` / `initialized`；
- `capability/list`；
- `capability/invoke`；
- `capability/cancel`；
- `capability/checkpoint` / `resume`（适用长任务）；
- `health/readiness`；
- `shutdown`。

调用上下文至少包含：`invocationId`、`workspaceId`、`threadId`、`turnId`、`actor`、`capabilityId/version`、输入 Schema、Artifact/Blob refs、deadline、policy grant、traceId 和 idempotencyKey。

Worker 事件有 monotonic seq 和明确终态。Daemon 负责：启动、握手、租约、心跳、超时、取消、资源限制、崩溃重启、日志归集和审计。Worker 不得：

- 自己开放未经认证的公共端口；
- 继承全部父进程环境；
- 直接写 Kernel Thread store；
- 把任意本地路径当 Artifact；
- 忽略取消后继续产生副作用；
- 用 stdout 混发日志和协议。

### 9.4 首批官方 Pack

1. Knowledge & Research；
2. Office & GenOffice；
3. Developer；
4. Data；
5. Media；
6. Learning；
7. Personal Knowledge；
8. Operations；
9. Enterprise Connections。

迁移顺序按依赖和验证价值决定，不按旧导航位置决定。首个 Worker slice 应选择依赖适中、能验证 Tool + Job + Artifact 的能力；Office/GenOffice 是强候选，但不得触碰用户当前未提交的 Office 文件，除非已明确接管其归属。

### 9.5 GenOffice 定位

GenOffice 不是新内核，也不拥有 Thread/Turn。它作为 Office Pack 的生成/编辑引擎：

- 接收结构化 Office 操作和 Artifact refs；
- 在 staging revision 上执行；
- 输出可验证的 DOCX/XLSX/PPTX 与预览；
- 复用现有 Office Artifact Runtime 的事务、Diff、验证、合并和发布能力；
- 失败不覆盖已发布 revision；
- UI 通过 Artifact/Job/Review 工作流交互，而非读取 Worker 私有状态。

---

## 10. Artifact 与 Job 是一等公民

### 10.1 Artifact Runtime

最低模型：

```text
Artifact
  id / workspace / type / title / currentRevision / lifecycle
Revision (immutable)
  id / parent(s) / contentRef / metadata / author / createdAt / lineage
Transaction
  baseRevision / staged changes / lock-or-expectedRevision / validation
Publication
  selectedRevision / target / verification / result
```

硬规则：

- Agent 先写 staging，再验证，再原子发布；
- revision 内容不可变，head pointer 可变；
- 合并冲突显式呈现，不采用 last-write-wins 覆盖；
- 每次生成、转换、编辑和导出记录 lineage、模型/工具版本与输入 refs；
- 大文件采用 content-addressed storage；
- Renderer 不能把预览当源文件；
- 所有 Artifact 类型提供打开、导出、版本、Diff/Review 或合理替代。

### 10.2 Job Runtime

稳定状态：

```text
queued → running → succeeded
                 ↘ failed
                 ↘ cancelled
        ↘ waiting_for_input / waiting_for_approval
        ↘ interrupted → queued(resume/retry)
```

每个 Job 记录：输入 refs、attempt、lease、worker、progress、checkpoint、outputs、error、resource usage、policy decision 和 trace。重试必须区分幂等阶段与不可重复副作用；取消完成的定义是所有受管子进程/远程调用已停止或明确进入不可取消状态并告知用户。

---

## 11. 安全、权限与审计

### 11.1 信任边界

| 边界 | 默认信任 | 主要风险 | 强制控制 |
|---|---|---|---|
| Renderer | 低 | XSS、恶意内容、secret 泄漏 | 无 secret、CSP、typed IPC、内容隔离 |
| Desktop main | 中 | 进程/路径滥用 | allowlist、签名 sidecar、最小 IPC |
| Daemon | 高但受策略 | 权限集中、状态损坏 | policy、audit、事务、认证 IPC |
| Kernel tool execution | 条件信任 | 命令、文件、网络副作用 | sandbox、approval、exec policy |
| Pack/Worker | 低到中 | 供应链、资源耗尽、越权 | manifest、签名、隔离、resource limit |
| Remote Connection | 不可信 | 数据外泄、提示注入 | scopes、egress、redaction、user approval |
| Imported data | 不可信 | 路径穿越、恶意文档 | quarantine、parser sandbox、MIME/hash validation |

### 11.2 审批语义

- 审批绑定 action digest：工具名、规范化参数、cwd、目标路径/域名、执行身份和预计副作用；参数变化后旧审批失效；
- 支持 deny、allow once、allow for turn、allow scoped rule；永久规则必须可查看、撤销和审计；
- 高风险动作不得由 Pack 自称“已获授权”；Policy Engine 是唯一裁决者；
- 请求审批期间 Turn/Job 进入明确等待状态，可在重启后恢复；
- UI 显示人能理解的影响和精确目标，不只显示原始 JSON；
- 删除、发布、外发、付费、安装、凭据使用和越出 Workspace 的写入有独立风险策略。

### 11.3 Secret 与日志

- secret 只存在 Vault 和最短必要进程内存；
- Worker 通过 handle/lease 取用，不能遍历凭据；
- 所有协议、event、trace、崩溃报告和测试 fixture 执行 redaction；
- stdout 绝不记录 secret 或普通日志；
- 日志目录、retention、导出和删除可配置；
- 未建立 Knorvia 自有遥测、隐私说明和同意机制前，派生产品遥测默认关闭；模型 API 必需流量与产品遥测严格区分。

### 11.4 供应链和发行

- 锁定工具链和依赖；生成 SBOM、第三方通知和许可证扫描；
- Daemon/Worker/Pack/更新包签名并验证；
- 自动更新支持 staged rollout 与 rollback；
- Pack 安装验证 publisher、hash、权限变更和兼容版本；
- CI secret 不出现在构建产物；
- 发布前进行 threat model、依赖审计、恶意 Pack 和路径攻击测试。

---

## 12. Desktop/Web 改造定案

### 12.1 保留什么、重做什么

保留：Next.js、React、Electron、现有组件资产、双语体系、Office/Media 编辑器和已验证交互。

重做：信息架构、连接层、状态模型、Item renderer、Activity、Workspace/Goal/Task/Artifact/Job 页面，以及任何直接依赖旧 StreamEvent/FastAPI 会话形状的逻辑。

是否局部重构或重写由长期质量决定，不以“已有代码必须保留”为前提；但不得在协议、状态和设计系统都未冻结时盲目全页重写。

### 12.2 客户端结构

```text
Electron main
  ├─ signed daemon discovery/start/stop
  ├─ framed protocol transport
  ├─ crash/restart/update coordination
  └─ narrow typed IPC

Web/Renderer
  ├─ generated Knorvia Protocol client
  ├─ normalized entity store
  ├─ connection/replay/reconciliation state machine
  ├─ Item Renderer Registry
  ├─ Workspace/Goal/Task/Artifact/Job surfaces
  └─ Activity & Approval UX
```

### 12.3 首个黄金纵向切片

在扩展页面前，必须先完成一个真实闭环：

1. Electron 启动签名/固定路径的 `knorvia-daemon`；
2. 完成 handshake 并显示真实版本/连接状态；
3. 新建 Workspace/Thread，启动 Turn；
4. 流式显示 Agent message 与至少一种 typed tool Item；
5. 执行一个只读工具和一个需要审批的写操作；
6. 用户可补充输入、拒绝/批准、interrupt；
7. daemon 或 renderer 重启后 resume/replay，无重复 Item；
8. 产生一个版本化 Artifact 或可验证文件变更；
9. Activity 能串起请求、审批、工具、结果与证据；
10. 同机运行官方 Codex，不发生目录、命令、凭据或 IPC 冲突。

这个切片必须使用真实 Kernel、真实协议和真实持久化；mock 只用于测试，不能作为里程碑演示。

### 12.4 UI 状态规则

- UI 以 ID/Revision 规范化存储，不嵌套复制整个 Thread；
- stream delta 只改变临时组装态，completed Item 成为稳定记录；
- 断连后先 replay/catch-up，再接受新事件；
- 不从文案、图标或日志文本推断状态；
- 未知 Item 以通用 renderer 显示 raw-safe summary、来源和引用；
- optimistic update 必须能由 server revision 驳回；
- approval 和 user input request 不能在刷新后消失。

---

## 13. 现有模块到新架构的迁移地图

| 当前资产 | 迁移期用途 | 最终归宿 |
|---|---|---|
| `runtime/orchestrator.py` | 行为 Oracle、shadow compare | 删除生产路径 |
| `core/agentic/*` | Golden behavior 来源 | 由 Kernel 替代 |
| `core/stream*.py` | Legacy adapter 输入/输出 | 删除 |
| `api/routers/unified_ws.py` | 旧 UI bridge | 由 Daemon Protocol 替代 |
| `services/session/*` | 导入源、旧客户端 projection | Kernel/Product Store + migration |
| `services/provider_registry.py`、`services/llm/*` | Provider 知识与过渡实现 | Provider Gateway adapters/tests |
| `services/codex_auth/*` | 仅作兼容调查 | 支持契约内的独立 Auth provider；删除硬编码耦合 |
| `runtime/registry`、Tools | 工具清单与行为来源 | Native Tool/MCP/Pack |
| Capabilities | Worker/Pack 迁移来源 | Capability Pack + Job/Artifact |
| `services/rag/*`、parsing、memory | 保留领域实现 | Knowledge/Research/Memory Worker |
| `services/office_artifacts/*` | 高价值现有 Runtime | Artifact Runtime + Office Pack |
| image/video/voice/classroom | 保留算法和数据 | Media/Learning Pack + Job/Artifact |
| cron | 迁移源 | Automation Runtime |
| partners/subagent/cli_apps | 连接与代理行为来源 | Connection + Agent/Pack adapters |
| FastAPI Routers | 兼容 API 与能力入口 | 产品控制面迁 Rust；领域 RPC 留 Worker |
| Next.js/Electron | 体验资产 | 适配新协议并重做超级工作台 IA |

每个 Router 必须先归类：`Control Plane`、`Capability`、`Legacy Compatibility` 或 `Delete`。不得逐个机械翻译成 Rust；只有 Control Plane 应进入 Daemon。

---

## 14. 工作流与依赖图

### 14.1 九条工作流

- `GOV`：基线、ADR、台账、上游和许可证；
- `KER`：Fork、身份、Kernel、发行、上游 Patch；
- `PRO`：Knorvia Protocol、Schema、SDK、兼容桥；
- `CTL`：Daemon、Store、Supervisor、Policy、Activity；
- `ART`：Artifact、Revision、Object Store、Job 与恢复；
- `MOD`：Provider Gateway 和模型契约；
- `CAP`：Capability Host、Pack、领域 Worker；
- `EXP`：Desktop/Web/CLI 产品体验；
- `MIG`：数据、切流、回退、旧底座删除与发布。

### 14.2 关键依赖

```text
GOV-001
   └─ FORK-001 → FORK-002 upstream baseline
        ├─ KER-001 → KER-002 → KER-003 identity/isolation
        │                        └─ CTL-001 daemon bootstrap
        ├─ PRO-001 → PRO-002 protocol facade/kernel adapter
        │              ├─ EXP-001 desktop connection
        │              └─ PRO-003 legacy adapters
        └─ MOD-001 provider seam

CTL-001 + PRO-002 + EXP-001 + ART-001 + JOB-001 + CTL-002
   └─ SLICE-001 golden chat/action/artifact slice
        ├─ MIG-001 session/settings import
        ├─ CAP-001 worker protocol/host
        │    └─ CAP-002 first real Pack
        └─ EXP-002 workbench information architecture

All validated slices
   └─ MIG-900 cutover → MIG-999 legacy deletion
```

没有协议、身份和基线时，不允许同时展开大量领域迁移。允许并行的工作必须边界清楚、Schema 已冻结、文件不重叠。

---

## 15. 阶段战役卡

### Phase 0 — 治理与旧底座冻结

**入口**：本总纲已接受，尚未实施。  
**动作**：

- 重新盘点两个目标目录、Git 状态、AGENTS、构建、测试、数据路径和发行方式；
- 将本总纲和 Goal 复制进产品仓库的 `docs/architecture/`，记录 source hash；
- 更新根 `AGENTS.md` 的未来架构与旧底座冻结声明；
- 建立 `MIGRATION_LEDGER.md`、ADR 目录、风险表和能力/API/数据清单；
- 为旧 Chat、工具、审批、会话恢复、Office/RAG 等关键行为录制 Golden Fixtures；
- 旧 Runtime 只接受安全、缺陷和迁移支持修改。

**出口证据**：盘点可复现；每项迁移资产有目标归属、Owner/Work Package、验收样例；用户脏工作树未受影响。  
**回退**：仅文档与 fixture，无生产切换。

### Phase 1 — 完整 Fork 与 Knorvia 发行身份

**入口**：Phase 0 台账存在。  
**动作**：完成 `FORK-001` 原版基线；建立 upstream 治理；实现 Knorvia paths、二进制、进程、凭据、日志、telemetry 和打包隔离；保留内部 crate 名。  
**出口证据**：原版与 Knorvia 版均可构建；`knorvia-daemon` 能启动/停止并跑 App Server smoke；Codex/Knorvia 同机并存测试通过；许可证清单存在。  
**禁止捷径**：外部 `codex` 子进程、源码压缩包、机械改名、只改 UI 字符串。  
**回退**：Knorvia 分支/二进制尚未接产品流量，可直接停止使用。

### Phase 2 — 稳定协议与 Daemon 骨架

**入口**：隔离 Kernel 可运行。  
**动作**：建立 Protocol v1、handshake、Schema 生成、Kernel adapter、Product Store、Event Journal、replay、structured errors、Legacy adapters、Electron supervisor，以及黄金切片所需的最小 Policy/Approval、Artifact/Revision 与 Job 状态机。  
**出口证据**：协议 round-trip、unknown field、disconnect/replay、stray stdout、schema drift 和旧 UI fixture 全部通过。  
**回退**：旧 UI 仍走旧后端；新 daemon 无权威写入。

### Phase 3 — 黄金纵向切片与默认 Chat 换核

**入口**：Phase 2 协议稳定。  
**动作**：完成第 12.3 节闭环；迁移 Persona、附件、基本 Memory/Skill、模型选择、取消、补充输入、resume/fork；进行 shadow compare；逐步把默认 Chat 切到 Kernel。  
**出口证据**：常用 Chat 无实质回退；崩溃/重启/断连/取消受测；旧循环只在受控 feature flag 下回滚。  
**回退**：按 Thread cohort 切回旧 Runtime，保留新事件和诊断，不双写同一权威记录。

### Phase 4 — 安全执行、工具与 Provider Gateway

**入口**：Kernel 已承载默认 Chat。  
**动作**：接管 Tool、Command、File Change、Terminal、Sandbox、Permission、Approval、Network Policy；建立 Provider Gateway 并迁移主要供应商。  
**出口证据**：所有副作用有 action digest、审批和 Activity；OpenAI、OpenAI-compatible、Anthropic、Gemini、本地模型各有受测路径；不支持能力明确失败/降级。  
**回退**：按 provider/tool capability 回退，不回退 Thread 所有权。

### Phase 5 — Capability Host 与领域 Pack

**入口**：工具、安全、Job/Artifact 最小能力可用。  
**动作**：完成 Worker RPC、Manifest、权限、资源限制、取消、恢复；迁移 Knowledge/Research、Office/GenOffice，随后 Developer、Data、Media、Learning、Personal Knowledge、Operations。  
**出口证据**：每个 Pack 可安装、授权、运行、禁用、升级和卸载；至少一个真实 Job + Artifact 工作流跨重启恢复；领域代码不进入核心循环。  
**回退**：逐 Pack feature flag；历史结果仍可读。

### Phase 6 — 超级工作台产品重构

**入口**：核心对象和至少两个 Pack 有真实闭环。  
**动作**：Workspace 成为容器；Goal/Task 支持长期和多 Agent；Artifacts、Jobs、Automations、Connections、Activity 成为一级面；旧学习/创作页面降为模板/Pack 入口。  
**出口证据**：用户不打开聊天也能创建目标、启动任务、编辑/审阅 Artifact、查看 Job 和 Activity；Office、研究、开发、数据、媒体、学习各有一条端到端路径。  
**回退**：新旧导航可短期切换，但对象与数据不分叉。

### Phase 7 — 控制面迁 Rust 与全量迁移

**入口**：新对象覆盖主要产品路径。  
**动作**：对 40 个左右 Router 分类；产品控制 API 迁 Daemon；Python 降为内部 Worker；执行全量数据预演、导入、校验和回退演练；Electron/Web 只连 Daemon。  
**出口证据**：重启 Python Worker 不丢 Thread/Task/Job；无公共 Python 控制端口依赖；旧数据完整可见；迁移报告可审计。  
**回退**：恢复迁移前 snapshot + 旧发行，保留新数据导出包。

### Phase 8 — 切流、删旧与发布

**入口**：所有门禁与回退演练通过。  
**动作**：默认关闭旧 Runtime；观察；删除 `ChatOrchestrator`、Agent Loop、StreamBus、重复 Session/Provider 调度、永久兼容分支和死代码；完成跨平台安装升级卸载与签名发布。  
**出口证据**：发行包只有一套 Agent Runtime；源码搜索与运行时 trace 均证明旧路径不可达；全部最终验收通过。  
**回退**：删除前保留最后可恢复 release/data snapshot；删除后只通过正式版本回退，不在新代码里保留暗门。

---

## 16. 首批 23 个可执行 Work Package

Agent 必须先完成依赖靠前的包，不能从页面美化或领域重写开始。

| ID | 工作 | 依赖 | 完成证据 |
|---|---|---|---|
| `GOV-001` | 双仓状态、能力、API、数据、测试与脏文件盘点 | 无 | ledger + inventory + hashes |
| `GOV-002` | 导入定案、更新 AGENTS、建 ADR/风险/证据结构 | GOV-001 | 文档校验与无冲突说明 |
| `FORK-001` | 完整 Git 历史 Fork 并锁定基线 | GOV-001 | remote/history/baseline lock |
| `FORK-002` | 原版 Codex build/test/App Server smoke | FORK-001 | baseline evidence |
| `KER-001` | `knorvia-platform-paths` 与 Home 隔离 | FORK-002 | path matrix + Codex no-touch test |
| `KER-002` | Knorvia binary/daemon identity 与发行骨架 | KER-001 | build/start/help/process tests |
| `KER-003` | Auth、Vault、User-Agent、telemetry 边界 | KER-002 | secret/client identity tests |
| `PRO-001` | Protocol v1 types、handshake、error、schema generation | FORK-002 | TS/Python/JSON schema + contract tests |
| `PRO-002` | Kernel/App Server adapter 与实验面隔离 | PRO-001 | upstream compatibility matrix |
| `CTL-001` | Daemon 生命周期、framing、Product Store、Event Journal | KER-002, PRO-001 | crash/restart/replay tests |
| `CTL-002` | Policy/Approval/Grant 最小闭环 | CTL-001, PRO-002 | action digest + restart-safe approval tests |
| `ART-001` | Artifact/Revision/Object Store 最小闭环 | CTL-001, PRO-001 | stage→verify→publish→rollback tests |
| `JOB-001` | Job/attempt/lease/checkpoint/cancel 最小闭环 | CTL-001, PRO-001 | worker-loss + resume/cancel tests |
| `EXP-001` | Electron main supervisor + typed IPC + generated client | CTL-001 | real daemon connection smoke |
| `EXP-002` | normalized store + Item renderer registry | EXP-001, PRO-002 | stream/replay/unknown item tests |
| `PRO-003` | Legacy Event 双向临时 adapter | PRO-002 | Golden fixture parity report |
| `SLICE-001` | Chat/Tool/Approval/Interrupt/Resume/Artifact 黄金切片 | EXP-002, CTL-002, ART-001, JOB-001 | 第 12.3 节完整录像/自动测试 |
| `MOD-001` | Provider facade 和能力 Schema | PRO-002 | capability negotiation tests |
| `MOD-002` | 五类主 Provider 契约实现 | MOD-001, SLICE-001 | provider conformance matrix |
| `CAP-001` | Capability RPC/Host/Manifest/permission | CTL-001, PRO-001 | worker crash/cancel/restart tests |
| `CAP-002` | 首个真实 Pack 迁移 | CAP-001, SLICE-001 | install→invoke→artifact→uninstall E2E |
| `MIG-001` | Session/Settings/Attachment 预演导入 | CTL-001, SLICE-001 | idempotent migration + rollback |
| `MIG-002` | 领域数据导入、切流和旧路径可达性清单 | CAP-002, MIG-001 | migration report + delete readiness |

每个包拆成可审查的纵向 commit。不得为了让表格变绿提交空 crate、TODO、假实现或永远关闭的 feature flag。

### 16.1 强制风险登记

以下风险从第一天进入 ledger，不能等出事故再补：

| 风险 | 早期信号 | 主控制 |
|---|---|---|
| Fork 与 upstream 永久分裂 | 核心触面扩张、同步只能手工猜 | Patch Set、集成分支、定期 merge rehearsal、优先外置 |
| 只换品牌未换身份 | `.codex`、Codex keychain/UA/pipe 被访问 | path/identity allowlist + filesystem coexistence tests |
| Daemon 与 Kernel 双重真相 | 同一 Thread 两边都可写终态 | owner matrix、单写入者、projection rebuild tests |
| Legacy 双轨无法退出 | 新功能继续落旧 Loop、fallback 无删除条件 | 旧底座冻结、每个 flag 写 owner/expiry/delete gate |
| Provider “兼容”实为静默降级 | 图片/工具/reasoning 被丢弃 | capability negotiation + conformance suite |
| App Server 上游变化穿透 UI | 升级后 generated type 大面积爆炸 | Knorvia facade、stable-only 默认、compat matrix |
| Worker 越权或失控 | 全环境继承、公共端口、取消后仍写入 | manifest、secret lease、sandbox、process-tree cleanup |
| 大爆炸前端重写失去反馈 | 长期无真实闭环、页面依赖 mock | 黄金纵向切片、normalized store、逐对象替换 |
| 数据迁移造成静默丢失 | warning 无报告、旧源被边迁边改 | read-only snapshot、hash/count/ref verify、idempotent journal |
| Office 用户改动被覆盖 | 工作面与当前 dirty files 重叠 | 开工盘点、独立 worktree、明确归属后再碰 |
| Rust + Python + Node 发行失控 | 开发机能跑、安装包找不到 Worker | release manifest、signed sidecar、clean-machine E2E |
| 体积/启动/内存不可接受 | 每个 Pack 默认常驻、全依赖打包 | lazy worker、optional pack、性能基线与预算 |

风险关闭必须附验证证据；“目前没遇到”不是关闭理由。

### 16.2 Work Package 卡片模板

每个包开工前在 ledger 或独立文件写：

```text
ID / Title / Status / Owner
Goal outcome
In scope / Out of scope
Prerequisites and fixed revisions
State owner and protocol/data changes
Security/permission impact
Files or crates expected to change
Acceptance scenarios
Failure/restart/rollback scenarios
Exact verification commands
Evidence location
Known risks and next atomic action
```

实现过程可以修正预计文件，但必须在交付时记录实际触面。若包变得无法独立审查，应拆分；拆分不能把真实闭环拆成永远不集成的水平层。

---

## 17. Definition of Ready / Done

### 17.1 一个 Work Package 可以开工的条件

- 依赖包已通过，不只是“代码已写”；
- 输入/输出、状态所有者、权限边界和失败语义明确；
- 目标文件与其他 Agent 工作面无冲突；
- 有至少一个验收场景和一个失败/恢复场景；
- 协议或数据变更已有版本/迁移计划；
- 不确定点已标记为待验证假设，而非隐含猜测。

### 17.2 一个纵向切片完成的条件

- 真实实现，不是 mock-only；
- 强类型协议与生成物；
- 权威存储、revision/幂等和迁移；
- Policy、Permission、Approval 与 audit；
- UI loading/progress/error/empty/cancel/recover；
- Artifact/Job 集成（适用时）；
- unit、integration、contract、migration、E2E；
- Windows 目标环境验证；跨平台影响已评估；
- 中文/英文文案与可访问性；
- 文档、台账、风险和证据已更新；
- 无静默 fallback 到旧路径；
- Reviewer 能从干净环境复现。

### 17.3 不算完成

- 只有方案、脚手架、类型定义或空目录；
- 只在开发者机器手工成功；
- 只跑 happy path；
- 测试被 skip、删掉或降低断言；
- 异常被吞并返回成功；
- 新旧双写但没有 owner/reconciliation；
- “以后再迁数据/安全/发行”；
- 依靠用户手动清理 `.codex`、端口或旧进程；
- 仅支持文本 Chat 或 OpenAI；
- 以 TODO 列表替代最终收尾。

---

## 18. 测试与质量门禁

### 18.1 已知基线命令

执行 Agent 必须先核对当前 manifest/文档，再把实际命令写入 `QUALITY_GATES.md`。审阅时已知：

- Codex Rust：`just fmt`、`just fix -p <crate>`、`just test -p <crate>`、`just test`；Routine 不盲目加 `--all-features`；
- Knorvia Python：项目现有 pytest 套件；
- Web：`npm run lint:ci`、`npm run test:node`、`npm run build`、发布 smoke/audit；
- Desktop：`npm test`，并补 daemon supervisor/installer E2E。

命令必须从正确目录执行；若环境缺少工具，记录 bootstrap，不通过关闭门禁绕过。

### 18.2 分层门禁

**每个 commit/PR：** format、lint、受影响 unit、generated clean、无 secret、无越界依赖。  
**每个 Work Package：** integration、contract、failure/recovery、ledger/evidence。  
**每个 Phase：** Golden E2E、migration rehearsal、performance/security 差异。  
**每次 Release：** full suite、跨平台、安装升级卸载、签名/SBOM/license、Codex 并存、回退演练。

### 18.3 必测场景

- Thread start/resume/fork/steer/interrupt/compact；
- delta 顺序、重复、缺口、晚到、断连 replay；
- daemon/kernel/worker/renderer 分别崩溃和重启；
- approval 与 user input 跨重启；
- tool/command/terminal 子进程树清理；
- malformed tool args、巨大输出、Unicode、空格、长路径、符号链接；
- provider auth expiry、rate limit、timeout、context overflow、unsupported capability；
- migration 中断、重跑、重复 ID、坏 Blob、空间不足；
- Artifact 冲突、验证失败、发布失败、回滚；
- Job cancel/retry/checkpoint/worker lease 过期；
- malicious Pack、越权文件/网络、secret redaction；
- Codex 与 Knorvia Home/Keychain/IPC/command/update 并存；
- 中文/英文与无障碍关键路径。

### 18.4 性能与资源基线

在优化前测量并冻结：安装体积、daemon 冷启动/热启动、首次事件/首 token、空闲内存、长 Thread 恢复、10k Item replay、并发 Job、Worker 启动、Artifact 打开、升级时间。

每个阶段报告绝对值和相对旧版/上游差异。预算由测量后在 `PERFORMANCE_BASELINE.md` 接受；未经说明的显著回退阻断发布。禁止通过减少安全检查、截断数据或关闭恢复能力换指标。

---

## 19. 必须持续维护的工程资料

开工后在仓库内建立并维护：

| 文件 | 内容 |
|---|---|
| `docs/architecture/KNORVIA_SUPER_WORKBENCH.md` | 本定案的仓库内权威副本 |
| `docs/architecture/decisions/ADR-*.md` | 新证据引发的关键决策 |
| `UPSTREAM.md` | 上游 URL/SHA、同步流程、差异和最近演练 |
| `PATCHES.md` | KPS 清单、触面、测试、删除条件 |
| `docs/migration/MIGRATION_LEDGER.md` | Work Package 状态、依赖、文件、证据、下一步 |
| `docs/migration/LEGACY_INVENTORY.md` | API/数据/功能/测试/路径归属 |
| `docs/protocol/PROTOCOL_COMPATIBILITY.md` | 上游与 Knorvia/客户端/Worker 兼容矩阵 |
| `docs/data/DATA_OWNERSHIP_AND_MIGRATION.md` | owner、schema、mapping、回滚 |
| `docs/security/THREAT_MODEL.md` | 信任边界、风险、控制和测试 |
| `docs/capabilities/CAPABILITY_PACK_SPEC.md` | Manifest、RPC、权限、生命周期 |
| `docs/providers/PROVIDER_CONFORMANCE.md` | 能力矩阵和契约证据 |
| `docs/quality/QUALITY_GATES.md` | 精确可运行命令与分层门禁 |
| `docs/quality/PERFORMANCE_BASELINE.md` | 资源基线和预算 |
| `docs/release/RELEASE_CHECKLIST.md` | 构建、签名、许可、迁移、回退、并存 |
| `THIRD_PARTY_NOTICES.md` | 上游和依赖归属 |

台账每行至少包含：ID、状态、依赖、负责人/Agent、目标、实际修改面、测试命令、证据链接、风险、阻塞原因、下一原子动作。状态只能是 `not_started / investigating / implementing / verifying / blocked / done / superseded`；`done` 必须带证据。

---

## 20. Agent 执行与协作协议

### 20.1 单 Agent 循环

对每个 Work Package：

1. 读当前 Goal、总纲、作用域 `AGENTS.md`、ledger 和相关源码；
2. 检查 Git/用户改动，确认工作面；
3. 用只读证据验证假设，写清最小纵向交付；
4. 先补失败测试/fixture，再实现；
5. 完成真实路径，不停在 facade 或 mock；
6. 运行受影响门禁，再逐级扩大测试；
7. 更新 generated artifacts、文档、ledger、风险和证据；
8. 检查是否引入旧路径 fallback、双 owner 或新核心 Patch；
9. 提交可审查结果，并明确下一原子动作；
10. 若依赖已满足，继续下一个包；未达到总验收不得宣布整个目标完成。

### 20.2 多 Agent 协作

- 一个 Root/Integrator 持有架构不变量、ledger、合并顺序和最终门禁；
- 子 Agent 只接边界清楚的 Work Package，不能各自重定义公共协议；
- 每个 Agent 使用独立 branch/worktree；两个 Agent 不同时编辑同一 Patch Set 或 Schema；
- 公共 Schema/owner 变更先由 Integrator 合并，消费者再基于固定 revision 开工；
- 交接必须包含：目标、实际文件、行为变化、测试及结果、未决风险、兼容影响、下一动作；
- Agent 输出的总结不是证据；测试日志、fixture、schema diff、migration report 和可复现命令才是证据；
- 冲突优先通过边界调整解决，禁止用复制代码制造第二事实源。

### 20.3 自主权

Agent 可自主：选择重构或重写、内部 crate 划分、算法、测试结构、局部 UI 方案、是否复用旧实现，只要满足冻结架构和门禁。

必须请求决策者输入：

- 改变 Fork-first、模型中立、单一新 Runtime 或产品北极星；
- 需要生产凭据、付费资源、商标/法律承诺或外部发布；
- 将不可逆删除真实用户数据；
- 发现用户改动与必要修改无法安全分离；
- 需要破坏已公开且仍受支持的外部契约，而无兼容路径。

一般实现困难、测试耗时、代码量大或存在多种都合理的内部方案，不构成停止理由；选择长期更清晰、可测试、可同步上游的一项并记录。

### 20.4 真正阻塞

只有以下情况可标记 `blocked`：缺少必要外部权限/凭据/硬件/决策；关键依赖不可获得；或三次以上不同安全尝试仍由同一外部条件阻断。标记时必须提供已验证事实、尝试、最小解阻请求和不依赖该条件仍可推进的其他包。

---

## 21. 切流与删旧纪律

### 21.1 切流单位

按可追踪 cohort 切换：内部开发 → 新建 Thread → 选定用户/Workspace → 默认新 Thread → 旧 Thread 迁移。不能用两个 Runtime 同时写同一 Thread 来“提高安全感”。Shadow run 的输出只用于比较，不产生用户可见副作用。

### 21.2 旧路径删除前置条件

- 新路径功能、数据、安全、性能和发行门禁通过；
- 回退演练通过并有 snapshot；
- 运行时 telemetry/trace 显示旧路径在观察期不可达；
- 源码 dependency graph 和搜索清单完成；
- 所有旧消费者已迁移；
- 文档、安装器、配置和测试不再引用旧入口。

### 21.3 删除清单

最终至少删除或彻底退出生产发行：

- `ChatOrchestrator` 和自研 Agent Loop；
- `StreamBus`/`StreamEvent` 公共协议；
- 重复 Session/Turn runtime；
- 旧 Provider 调度进入 Agent Loop 的路径；
- FastAPI 公共会话/执行控制；
- 永久 Legacy adapter 和 fallback flags；
- 旧 CLI 入口与重复命令注册；
- 无消费者的 Router、页面、配置、迁移 shim 和测试。

删除后运行完整 dead-code、package-content 和安装升级验证。不能仅把代码留着“暂时不调用”。

---

## 22. 最终验收标准

只有以下全部为真，换核才完成：

1. Knorvia 与官方 Codex 同机安装、运行、登录、升级、卸载，命令/Home/数据/凭据/IPC/日志/更新无冲突。
2. `knorvia-daemon` 与 Rust `knorvia` CLI 是正式发行组件，不依赖外部 `codex` 可执行文件。
3. 默认 Thread、Turn、Item、上下文、取消、恢复、分叉、补充输入、工具和审批由新 Kernel 承载。
4. Desktop/Web 只依赖稳定 Knorvia Protocol，不直接依赖大面积上游内部类型。
5. Python Worker 重启不会丢失 Thread/Task/Job 权威状态；Python 不再是公共控制面。
6. 旧会话、设置、附件、知识库、记忆、Artifact、Job 和关键领域数据无损迁移，映射与报告可审计。
7. OpenAI、OpenAI-compatible、Anthropic、Gemini 和至少一种本地模型均通过统一契约；能力缺失不静默伪装。
8. 所有有副作用动作具备 Sandbox/Policy/Approval/audit；secret 不进入 UI、事件和日志。
9. Goal/Task 能跨轮次与重启持续推进，多 Agent 行为可观察、限制、中断和审阅。
10. Artifact 有 Revision、Diff/Review、Lineage、验证和安全发布；Job 可后台、取消、重试、恢复。
11. Capability Pack 可发现、安装、授权、调用、升级、禁用和卸载；历史结果不因卸载不可读。
12. Office/GenOffice、Research、Developer、Data、Media、Learning 各有真实端到端工作流。
13. 即使不打开 Chat，用户也能在 Workspace 内组织目标、任务、成果、自动化和活动。
14. 本地优先成立；没有 Knorvia 云服务时核心工作台仍可使用。
15. 新内核能持续同步 upstream，所有核心 Patch 有清单、测试和删除条件。
16. 发行包不存在两套 Agent Runtime；旧 `ChatOrchestrator`、Agent Loop、StreamBus 等生产路径已删除。
17. Windows、macOS、Linux 的适用门禁，以及安装、升级、回退、许可证、SBOM、签名和安全门禁全部通过。
18. 最终证据包可由另一名 Agent 在干净环境复现。

“能聊天”“能启动 Codex 派生二进制”“新旧都能用”“页面已经换 Logo”“大部分测试通过”均不算完成。

---

## 23. 最终证据包

总任务关闭时交付：

- 两个仓库的精确 revision、clean/known-dirty 状态与 release manifest；
- upstream 基线与最近同步报告；
- Patch Set 报告和核心触面 diff；
- Protocol Schema/SDK/compatibility matrix；
- Provider conformance matrix；
- Capability Pack conformance 与首批 Pack 清单；
- 数据 inventory、migration run、mapping、hash verification、warning 和 rollback rehearsal；
- Threat model、approval、安全、secret redaction、SBOM、license 和签名报告；
- 跨平台 build/test/install/upgrade/uninstall/coexistence 结果；
- 性能基线与最终差异；
- 黄金工作流 E2E 证据；
- 旧 Runtime 删除清单、不可达证明和 package-content audit；
- 面向维护者的 upstream sync、release、recovery 和 incident runbook。

---

## 24. 可直接交给编码 Agent 的完整启动指令

> 你负责完整执行 Knorvia 超级工作台换核，而不是再写一份方案。首先完整阅读本总纲、配套《Knorvia-超级工作台-指导GOAL.md》以及 `D:\tools\Knorvia` 和未来 `D:\tools\knorvia-kernel` 作用域内全部 `AGENTS.md`。将本总纲视为已接受架构：完整 Fork `openai/codex` 与 Git 历史，以固定基线建立可持续同步 upstream 的 Rust Knorvia Kernel；公共命令、Home、配置、凭据、进程、IPC、日志、遥测、更新、协议和发行必须与 Codex 完全隔离；建立 `knorvia-daemon`、稳定 Knorvia Protocol、Provider Gateway、Capability Host、Workspace/Goal/Task/Artifact/Job/Automation/Policy；把现有 Knorvia 领域资产迁为 Pack/Tool/Worker/Artifact/Job，最终删除 Python `ChatOrchestrator`、自研 Agent Loop、`StreamBus`、重复 Session 控制和 FastAPI 公共控制面。开工前只读盘点 Git 与用户未提交改动，严禁 reset、clean、覆盖或擅自 stash。按 `GOV-001 → FORK-001/FORK-002 → 身份隔离 → Protocol/Daemon → Desktop 黄金切片 → Provider/Capability → 数据与产品迁移 → 切流删旧` 的依赖顺序推进；每个包必须包含真实实现、失败与恢复测试、协议/数据/安全/UI、文档和可复现证据，禁止空脚手架、mock-only、静默 fallback、永久双轨或用 TODO 冒充完成。持续维护 Migration Ledger、ADR、UPSTREAM、PATCHES、兼容矩阵、迁移/安全/质量/发行资料。实现细节可自主选择重构、复用或重写，以长期质量、边界清晰、可测试、可恢复和可同步上游为准。只在需要外部权限、生产凭据、法律/品牌承诺、不可逆用户数据删除或确实无法分离用户改动时请求决策；其余情况以证据作决定并继续。只有总纲第 22 节全部成立、证据包可复现且旧 Runtime 已从发行和生产路径删除时，才可宣布完成。

Agent 的第一条实际动作不是改源码，而是完成 `GOV-001`；第一条实现动作是可重复的 `FORK-001/FORK-002`；第一个产品里程碑是第 12.3 节的真实黄金纵向切片。

---

## 25. 参考依据

- OpenAI Codex 开源范围：<https://learn.chatgpt.com/docs/open-source>
- Codex App Server：<https://learn.chatgpt.com/docs/app-server>
- Codex SDK：<https://learn.chatgpt.com/docs/codex-sdk>
- Agent Approvals & Security：<https://learn.chatgpt.com/docs/agent-approvals-security>
- Codex 配置与模型供应商：<https://learn.chatgpt.com/zh-Hans/docs/config-file/config-reference>
- Codex Apache 2.0 License：<https://github.com/openai/codex/blob/main/LICENSE>
- 审阅基线：<https://github.com/openai/codex/commit/8e6a44b428e31f91b21edc97904fcdf4f0931ade>

这些来源用于确认上游当前公开能力和边界；最终实现仍必须以固定提交源码、生成 Schema、测试和实际发行行为为准。

---

## 26. 最终命令

**GO。先建可重复基线，再完成身份与协议隔离；先打穿黄金纵向切片，再全面迁移；最终只保留一套 Knorvia Runtime，把产品推进为真正的超级工作台。**
