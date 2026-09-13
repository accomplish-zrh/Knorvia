# Lane A 跨路接口契约

本文件是 A 路对外发布的真实接口契约与请求。A 只拥有 `native/knorvia-rs` 下的 Rust 源与测试；
web/desktop 归 B/C/D。以下 schema 一经本文件发布即按此实现，后续修改会在本文件追加变更记录。

## A03 → B：审批系统收口的 durable 时间线 Item

背景：`store/src/lib.rs::resolve_approval_system` 与重启恢复
`store/src/turn_lifecycle.rs::recover_incomplete_turns` 目前只写
`approval.systemResolved` WAL 事件与 Approval 投影，时间线上没有可见原因。

A 交付（已按本契约实现）：

- 新增 durable Item，与系统 resolution 在**同一个原子 WAL 事务**内落盘；
  重启恢复路径在**同一恢复批次**内补写。`thread/read` 的 items 列表原样返回，
  无需新 RPC。
- Item 结构（knorvia 协议 `Item`，字段 camelCase）：
  - `kind`: `"approvalResolution"`
  - `status`: `"completed"`
  - `turnId`: 所属 Turn（与 approval.turnId 相同）
  - `payload`:
    ```json
    {
      "approvalId": "appr_...",
      "turnId": "turn_...",
      "resolution": "timed_out" | "cancelled" | "owner_lost",
      "source": "system"
    }
    ```
- 幂等：同一 `(approvalId, resolution)` 只有一个 Item；重复恢复/重放不产生重复项；
  用户 `deny`（`approval.responded`，status `denied`）路径**不产生**该 Item。
- B 端展示要求（TaskTimeline）：
  - `timed_out` → "审批已超时，系统自动拒绝执行"；`cancelled` → "任务取消，审批已关闭"；
    `owner_lost` → "任务失去执行者，系统关闭审批"。
  - 这三种是**系统收口，不是用户拒绝**；不得复用 `approvalDecision` 的
    allowed/拒绝 二分渲染。用户拒绝仍只来自 Approval `denied` 投影。
- 验收入口：真实 `thread/read` 返回的 items 进入真实 TaskTimeline 组件，
  不接受手写 payload 的组件测试。

## A08 → B/C：event/replay 与 activity/list 的有界分页 schema

现状：`event/replay` 与 `activity/list` 一次返回 `afterSeq` 之后全部事件，
`store::replay_page` 全量 replay 后截断。A 正在实现真正的有界分页；
B（web provider / knorvia-native-types）与 C（desktop/knorvia-protocol-client.js）
需要按下面的契约消费。

- `event/replay` 请求参数（全部可选，向后兼容）：
  - `streamId`（或沿用现有字段）、`afterSeq`: number、`limit`: number（事件数上限，
    服务端另有字节上限）、`maxBytes`: number（可选字节上限）。
- `event/replay` 响应新增字段（旧字段保留；数组字段沿用现有 `events` 命名）：
  - `events`: EventEnvelope[]（seq 严格递增，全部 `> afterSeq`）
  - `nextSeq`: number — 最后包含事件的 seq（空页时等于 `afterSeq`），下一页游标
  - `hasMore`: boolean — 冻结快照内是否还有未返回事件
  - `upperSeq`: number — **本页打开时冻结的流头部 seq（含）**；并发新写入不会
    改变它，`hasMore=false` 表示已补齐到冻结点，之后的事件是新快照。
- 消费循环（B/C 必须实现）：
  1. `afterSeq` 从断点（通常 0 或已持久化 cursor）开始；
  2. 每页消费后 `afterSeq = nextSeq`；`hasMore=true` 立即续读；
  3. `hasMore=false` 后，补齐完成，之后按现有订阅/轮询节奏用
     `afterSeq = upperSeq` 继续追新；
  4. 收到 typed error `event_exceeds_page_budget`（单条事件序列化后超过
     页预算，含响应封套开销）时：保留 last-good cursor，不得把缺页当成
     "没有事件"或执行收据；按错误里的 `seq`/`bytes` 显式升限重试或上报。
  5. 任何页失败保留 last-good cursor 重试；不得跳 seq。
- `activity/list` 同步获得 `afterSeq`/`limit` 参数与相同响应形状。
- A 会接通 control 内部的真实消费点并保证旧行为（单次小结果）兼容；
  `web/lib/knorvia-native-types.ts` 与 desktop 客户端的具体接线归 B/C，
  schema 即本节。迁移期内旧调用（无 `limit`）仍返回全量结果，行为不变。

## A19 ↔ C09：Home 静止、daemon.lock 与 state swap

A（native 迁移回滚）与 C09（桌面全 Home 离线备份）共享同一 Home 的独占资格。

事实与契约：

1. 原生侧唯一生产锁身份是 `state/daemon.lock` 上的 OS 文件锁
   （`control/src/lib.rs:178` 打开并加锁）。**文件存在与否不是持锁证据**；
   C09 的独占必须真的持有这把 OS 锁（或经 daemon 静止 API 获得让渡），
   不得另造无人遵守的 `backup.lock`。
2. A19 的 `migration/rollback` 将引入控制层静止闸门：冻结 admission 后要求
   running Turn = 0、无两轮之间活跃 runner、无活跃 Pack worker、
   无已 claim 未 dispatch 的 room/automation 工作；失败时恢复原 admission
   状态并返回 typed 错误（列出阻塞事实）。
3. **state swap 的锁身份**：migration restore/rollback 会替换 `state/` 目录。
   锁文件随目录被换掉会让新 writer 绕过原锁。A 的实现保证：swap 各阶段
   结束后，原持有者先释放旧锁再由恢复路径在同一 Home 上重新建立锁身份，
   期间不接受新 mutation；C09 不得在 swap 窗口内假定 daemon.lock 句柄仍指向
   同一文件对象。A 会在 A-interfaces.md 记录最终语义。
4. 对 C09 的请求（写入 reports/C-interfaces.md 回执即可）：
   - 备份导出的"安全离线"阶段应通过 `system/prepareRestart`（已有）确认
     `ready:true` 后再取锁；A19 落地后 `prepareRestart` 的静止集合会扩展
     （见第 2 条），C09 直接复用其结果即可，无需自行推断。
   - 复制窗口的独占资格证明 = 实际持有 `state/daemon.lock` OS 锁；
     native 侧不做备份专用锁。

## 变更记录

- 2026-09-12 初版：发布 A03 Item schema、A08 分页 schema 与消费循环、
  A19/C09 静止与锁契约。
