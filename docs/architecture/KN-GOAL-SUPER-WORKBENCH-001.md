# Knorvia 超级工作台换核：长期指导 Goal

> Goal ID：`KN-GOAL-SUPER-WORKBENCH-001`  
> 状态：`ACTIVE / 尚未动工`  
> 配套执行宪章：《Knorvia 超级工作台：Codex 内核换代最终定案与 Agent 执行总纲》  
> 用途：粘贴到长期编码任务的 Goal/Objective，并作为每次续接、压缩上下文和 Agent 交接时的方向锚点。

---

## 1. 可直接粘贴的 Goal 正文

> 将 Knorvia 全面重建为一个本地优先、模型中立、Agent 原生、可扩展、可审计并能长期演进的超级工作台。完整 Fork `openai/codex` 开源仓库与 Git 历史，以固定上游基线建立可持续同步 upstream 的 Rust Knorvia Kernel，而不是调用外部 Codex CLI、摘抄零散模块或机械换皮；建立与 Codex 完全隔离的 `knorvia` CLI、`knorvia-daemon`、Home、配置、数据、凭据、进程、IPC、日志、遥测、更新、协议和发行体系。以稳定 Knorvia Protocol 连接 Desktop/Web/CLI，以 Workspace、Goal、Task、Thread、Turn、Item、Artifact、Revision、Job、Agent、Automation、Connection、Capability Pack 和 Policy 统一承载数字工作；建立模型中立 Provider Gateway、Capability Host、强类型 Worker RPC、Artifact/Job Runtime、安全沙盒、权限审批、事件审计、断线恢复和版本迁移。保留现有 Knorvia 在 RAG、Memory、Office/GenOffice、Media、Learning、Partners、Automations、多 Provider、Next.js/Electron 和用户数据上的价值，但允许基于长期质量自由选择复用、重构或重写，并将这些能力迁为 Pack、Tool、Worker、Artifact 或 Job；最终彻底删除 Python `ChatOrchestrator`、自研 Agent Loop、`StreamBus`、重复 Session/Provider 控制和 FastAPI 公共控制面的生产路径。按“基线与治理 → 完整 Fork → 身份隔离 → Protocol/Daemon → 真实黄金纵向切片 → 安全工具与 Provider → Capability/领域迁移 → 超级工作台产品重构 → 全量数据迁移与切流 → 删除旧底座与发行”的依赖顺序持续执行；保护用户现有未提交改动，不以空脚手架、mock-only、TODO、静默降级、部分迁移或永久双轨冒充完成。每个切片都必须包含真实实现、权威状态、协议、数据、权限、安全、UI、取消/恢复、迁移、测试和可复现证据。只有新 Kernel 成为唯一生产 Agent Runtime，Knorvia 与 Codex 同机完全不冲突，现有重要能力与数据无实质回退，用户能在统一 Workspace 中跨研究、Office、开发、数据、媒体、学习和运营持续完成可验证任务并产出版本化 Artifact，所有协议、Provider、Pack、迁移、安全、性能、跨平台、安装升级回退和发布门禁全部通过，且旧 Runtime 已从源码依赖、发行包和运行路径中删除时，才将本 Goal 标记完成。

这段文字是 Goal 本体。若系统只接受一个 objective，就粘贴这一段；若支持附件或长期上下文，同时附上配套总纲。

---

## 2. Goal 的冻结不变量

无论上下文如何压缩、Agent 如何更换、工程如何分阶段，以下内容不得漂移：

1. **完整 Fork，不是套壳。** 新底座继承 Codex 开源 Runtime 和历史，并能持续同步 upstream；最终运行不依赖用户另装 `codex`。
2. **Knorvia 身份独立。** 不创建或覆盖 `codex` 命令，不默认读写 `.codex`，不复用 Codex 凭据、IPC、锁、日志、更新和遥测身份。
3. **产品不限领域。** 学习、创作、Office、代码、研究、数据、媒体和运营都只是能力，不是产品边界。
4. **Chat 不是事实中心。** Workspace、Goal/Task、Artifact、Job 和 Activity 是长期产品骨架。
5. **模型中立。** Codex 提供 Agent Runtime；Provider Gateway 保证 OpenAI、其他云模型、本地模型和企业网关可按真实能力工作。
6. **单一生产 Runtime。** 双轨只用于受控迁移、shadow 和回退；终局删除旧 Agent 底座。
7. **领域逻辑不污染核心。** RAG、Office、Media、Learning 等进入 Pack/Worker/Tool/Artifact/Job，不继续膨胀核心循环。
8. **数据不可牺牲。** 迁移可预演、幂等、可校验、可审计、可回退；不覆盖迁移源。
9. **安全不是后补。** 所有副作用有 Sandbox/Policy/Approval/audit；secret 不进入 Renderer、事件或日志。
10. **完成必须有证据。** 文档、代码或演示不等于完成；干净环境能复现的测试、迁移报告和发行物才是完成证据。

任何实现决定若破坏这些不变量，必须停止该实现并回到总纲；不能以“工程量太大”“先上线再说”或“兼容旧结构”作为例外。

---

## 3. Goal 的推进状态

本 Goal 只有以下宏观状态：

```text
ACTIVE
  ├─ establishing_baseline
  ├─ building_kernel_identity
  ├─ building_protocol_and_daemon
  ├─ proving_vertical_slice
  ├─ migrating_runtime_and_providers
  ├─ migrating_capabilities_and_product
  ├─ migrating_data_and_cutover
  └─ decommissioning_and_release

COMPLETE
BLOCKED（只用于真正外部阻塞）
```

局部 Work Package 完成不改变总 Goal 为 COMPLETE。每次续接先从 `MIGRATION_LEDGER.md` 找到：

- 最近一个有证据的完成点；
- 当前正在进行的 Work Package；
- 唯一或最优的下一原子动作；
- 仍未关闭的最高风险；
- 是否存在用户改动或外部阻塞。

若台账与聊天总结冲突，以仓库中的源码、测试、Git 状态和证据为准，并修正台账。

---

## 4. 每次 Agent 回合的固定执行循环

1. **定位**：读取 Goal、总纲、作用域 `AGENTS.md`、ledger、相关 ADR 和当前 Git 状态。
2. **保护**：识别用户已有修改；不 reset、clean、覆盖、擅自 stash 或做无关格式化。
3. **验证**：用源码和最小实验验证当前假设；不依据旧总结臆测接口。
4. **选择**：在复用、重构和重写中选择长期边界最清晰的一项；关键取舍写 ADR。
5. **实现**：完成最小但真实的纵向切片，不停在类型、桥接空壳或 mock。
6. **验证**：依次运行受影响 unit、contract、integration、failure/recovery、E2E 和必要发布门禁。
7. **记录**：更新 generated Schema、ledger、风险、兼容矩阵和可复现证据。
8. **清理**：确认没有静默旧路径 fallback、双重事实源、新的 secret 泄漏或无编号核心 Patch。
9. **继续**：依赖已满足就推进下一原子动作；未达总验收不得因一个里程碑结束而停止。

Agent 不应每轮重新设计整个项目，也不应只汇报“下一步可以做什么”。除真正外部阻塞外，应完成当前安全可做的工作并留下可接续状态。

---

## 5. 当前第一动作与首个里程碑

由于项目尚未动工，接手 Agent 的第一动作固定为：

### `GOV-001` — 建立可信起点

- 只读盘点 `D:\tools\Knorvia` 和 `D:\tools\knorvia-kernel` 是否存在、Git/remote/branch/worktree、作用域指令、构建测试、数据路径、发行入口和用户未提交改动；
- 将两份定案文件纳入仓库权威文档，记录 hash；
- 建立 Migration Ledger、Legacy Inventory、ADR、风险和证据目录；
- 冻结旧 Agent Runtime 的新增架构扩张；
- 不在盘点完成前触碰用户当前 Office/Creative Library 未提交改动。

随后是 `FORK-001/FORK-002`：从官方 Git 历史建立固定上游基线，在零 Knorvia 行为改动时先完成原版构建、测试和 App Server handshake 证据。

首个产品里程碑不是“新 daemon 能输出 Hello”，而是一个真实黄金纵向切片：Electron 启动隔离的 `knorvia-daemon`，完成协议握手，新建并恢复 Thread，流式运行 Turn，展示 typed Item，执行只读工具和需审批写操作，支持补充输入/拒绝/批准/interrupt，重启后 replay 无重复，产出一个版本化 Artifact，并在 Activity 中形成完整证据链，同时与官方 Codex 同机无冲突。

---

## 6. Agent 的自主权与停线条件

### 可自主决定

- 某个旧模块复用、重构还是重写；
- 新 crate/module 的内部划分；
- 测试、算法、局部 UI 和迁移实现；
- 在不破坏公共契约时优化 Work Package 粒度和并行方式；
- 根据源码证据修正未冻结的实现假设。

判断标准依次为：长期边界清晰 → 正确与安全 → 可测试和可恢复 → 可持续同步 upstream → 跨平台和发行可靠 → 开发便利。不能单纯以改动少或短期快作为“更好”。

### 必须请求决策者

- 想改变完整 Fork、模型中立、单一 Runtime 或超级工作台定位；
- 需要生产凭据、付费资源、外部发布、商标或法律承诺；
- 将不可逆删除真实用户数据；
- 必需工作与用户未提交改动无法安全分离；
- 必须破坏仍受支持的公开契约且无迁移路径。

### 可以标记 BLOCKED

只有必要外部权限、凭据、硬件、决策或不可获得依赖真正阻止继续，并且安全替代路径已被验证无效，才可标记。报告必须写清证据、已经尝试的路径、最小解阻请求，以及仍可并行推进的工作。工程量大、构建慢、测试失败或实现复杂都不是 Goal 阻塞。

---

## 7. Goal 完成判定

标记 COMPLETE 前，执行者必须逐项回答“是”，并附证据位置：

- 是否保留完整 upstream 历史并完成至少一次可重复同步演练？
- 是否只有 Knorvia 公共命令/身份，且与官方 Codex 全维度并存？
- 是否由新 Kernel 唯一拥有生产 Thread/Turn/Item 与 Agent 生命周期？
- 是否由稳定 Knorvia Protocol 服务 Desktop/Web/CLI，且能版本协商和断线恢复？
- 是否具备模型中立 Provider Gateway 与统一 conformance tests？
- 是否具备 Pack/Worker 生命周期、权限、取消、恢复和卸载语义？
- 是否具备 Workspace、Goal/Task、Artifact/Revision、Job、Automation、Connection、Policy 和 Activity 的真实产品闭环？
- 是否无损迁移重要会话、设置、附件、知识库、记忆、Artifact 和领域数据，并完成回退演练？
- 是否有 Office/GenOffice、Research、Developer、Data、Media、Learning 的真实端到端工作流？
- 是否删除旧 `ChatOrchestrator`、Agent Loop、StreamBus、重复 Session/Provider 控制和 FastAPI 公共控制路径？
- 是否所有安全、协议、迁移、Provider、性能、跨平台、安装升级卸载、许可、签名和发布门禁通过？
- 是否由另一名 Agent 在干净环境复现最终证据包？

只要有一项不是，Goal 仍为 ACTIVE。若某项经正式 ADR 被替代，必须证明替代方案仍完整满足同一北极星结果，不能仅降低标准。

---

## 8. 每次交接的最小摘要模板

```text
Goal: KN-GOAL-SUPER-WORKBENCH-001（ACTIVE）
当前阶段：
当前 Work Package / 状态：
已完成且有证据：
本回合实际修改：
测试命令与结果：
用户已有改动保护情况：
未关闭风险/假设：
真正阻塞（没有则写无）：
下一原子动作：
关键文件/证据位置：
```

交接摘要只用于导航；它不能替代 ledger、源码、测试和证据。

---

## 9. 最后一句

**以 Codex 的成熟 Rust Agent Runtime 赢得底座，以 Knorvia 自己的协议、数据、能力生态和超级工作台赢得未来；不惧重构，不恋旧形状，不牺牲用户数据，不停在半成品，直到单一新内核和完整工作台真正交付。**
