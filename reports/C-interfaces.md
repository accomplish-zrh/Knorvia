# Lane C 跨路接口

## C15/C20 → D：SSH / 终端 / 媒体服务的结构化关闭与活动状态契约

- 状态：开放（本路已按"现有 close/dispose 语义"完成总退出编排；未修改 D 模块）
- 目标 owner：D（desktop/ssh-session.js、desktop/workspace-terminal.js、desktop/media-studio.js）
- 需求 1（C15）：`close()/dispose()` 返回 `{ confirmed: boolean, ownedPids?: number[], detail?: string }`；
  期限内无法确认退出时必须 `confirmed:false`，不得抛出或永久挂起。C 的
  `asShutdownStep`（desktop/shutdown-controller.js）已按此契约透传结果：`confirmed:false`
  记为 unconfirmed 并带 detail；void 关闭在期限内完成只算 confirmed；超时/异常如实分级。
  本地验证：desktop/tests/shutdown-controller.test.js（11/11，含 confirmed:false/挂起/失败三类宿主层反例）。
- 需求 2（C20，03:01 主审卡第 3 项——精确接口请求，待 D 交付）：在 desktop/media-studio.js
  的返回对象上暴露只读活动计数 `get pendingActivityCount()`，直接返回其内部
  `mediaOps.pendingCount`（media-operations.js:158，运行中 + 排队，权威且单调可比较）。
  语义约束：返回值必须为 number ≥ 0；未知/不可判定时返回 0 而不是抛错（C 侧将 0 视为
  "无活动"，绝不虚构活跃）。C 已完成消费端接线：desktop/main.js reconcileManagedActivity
  仅在 `typeof mediaStudio?.pendingActivityCount === 'number' && > 0` 时保活
  `media:host`，接口缺席时静默跳过（不虚构活跃）；D 交付后无需 C 再改动即生效。
  验收（媒体独占执行）：长帧导出运行期间取得 media:host 保活；取消/成功/失败后 30 秒
  轮询内释放；接口缺席不保活。

## C18 → C（已接线，待整合树验证）

- D 交付 `desktop/terminal-profiles.js`（`createTerminalProfiles({ home })`）与
  `createWorkspaceTerminal({ rpc, env, home, profiles })`。C 已在 desktop/main.js 守卫接入：
  模块存在时传入 `home: workspace` 与 profiles，缺失时保持旧行为（shell 可启动，配置能力关闭）。
- SettingsView/SettingsLayout（C 拥有）已注册 `terminal` 设置段并静态导入 D 的
  `web/components/native/TerminalSettings.tsx`（`export function TerminalSettings`）——
  该导入仅在包含 D 交付的整合树中构建，本工作树不构建 web。
- 验收：整合树中 terminal/profiles/list 返回 `available:true`，持久默认 shell 生效。

## C19 → C（已接线，待整合树验证）与 C19 → B（开放）

- C 已完成：main.js 守卫创建 `createWorkspaceMediaPreview({})` 并作为 `mediaPreview`
  传入 `createWorkspacePreview({ rpc, mediaPreview })`；公开注册 C 拥有的
  `preview/revoke`（64-hex token）与 `preview/revokeScope`（workspaceId|threadId 二选一）
  —— desktop/preview-revoke.js + desktop/tests/preview-revoke.test.js（4/4）；
  有界关闭阶段调用 `workspaceMediaPreview.close()`。
- B 待接（B 拥有 web/components/native/PanelPreview.tsx）：`preview/read` 返回
  `{ supported:true, stream:true, size, mime, url, expiresAt }` 时以 url 为
  video/audio/PDF 源；面板关闭或路径/版本切换时经 native request 调
  `preview/revoke { token }`（或 `preview/revokeScope`）。
- 共享类型：web/lib/knorvia-native-types.ts（C 拥有）已增补 preview/revoke、preview/revokeScope。

## C04 → B：library/move、library/trash 身份守卫（已落地）

- `expectedId`/`expectedSha256` 可选字段：在 scan 之后、任何文件系统访问之前按目录核对；
  替换、重命名、内容变化与"移走且未替换"（含旧路径为空）一律 Conflict(-32005)；
  字段缺省保持旧单项行为。本地验证：desktop/tests/library-storage.test.js（含 vanish 反例）。
  B 侧保持待集成，由 I 在组合 B02+C04 后做逐项冲突/重试验证。
