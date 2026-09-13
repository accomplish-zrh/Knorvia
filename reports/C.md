# Lane C 夜班报告（2026-09-11）

工作树：`D:/tools/knorvia-nightshift-20260911/runner/state/434034efd94d/batches/C/worktree`
快照提交：a2bcbfe（隔离快照）。基线用户改动已保留；REVIEW-0152 反馈的返修已在本树完成并提交。

## 状态总览（14/14 原方向已实现并验证，待主审逐项复核）

| ID | 简述 | 提交 | 验证 |
| --- | --- | --- | --- |
| C02 | 前端服务崩溃后有界恢复 | d9c26a2 | tests/frontend-supervisor.test.js 6/6 |
| C03+C06 | 迁移失败可恢复启动 / 通知导航桥接 | 94bbced | tests/workspace-migration.test.js 6/6 + tests/open-thread-bridge.test.js 7/7 |
| C15 | 全后台服务有界退出 | a7367f0（REVIEW 返修追加） | tests/shutdown-controller.test.js 11/11 |
| C01 | 内置技能升级与用户修改保护 | 3b602be | tests/builtin-skills-upgrade.test.js + builtin-skills.test.js 9/9 |
| C04 | 资料库空间管理 + B02 身份守卫 | 3d4a401（REVIEW 返修追加） | tests/library-storage.test.js + personal-library.test.js 17/17 |
| C05 | 扩展残留包回收 | f9fe4cf | tests/extension-storage.test.js 5/5 |
| C08 | 应用内可取消校验的更新下载 | d9378eb | tests/update-download.test.js 7/7（真实 HTTP 夹具） |
| C09 | 完整离线备份与恢复 | 7d7e481 | tests/home-backup.test.js 6/6 |
| C12 | GitHub 固定版本子目录导入 | b7f1207 | tests/github-extension-source.test.js 5/5（本地 git 对象夹具） |
| C14 | 安装包来源与组件完整性 | 2fa9e77 | tests/runtime-integrity.test.js 5/5（真实执行清单生成脚本） |
| C20 | 长任务防休眠管理 | fe74265 | tests/power-policy.test.js 7/7（注入 powerSaveBlocker） |
| C10 | 扩展可搬迁导出/重建 | 0a4cc70 | tests/extension-export.test.js 4/4 |
| C11 | Claude 命令到 Skill 迁移 | f471432 | tests/extension-convert.test.js 3/3 |
| 打包闭合（REVIEW） | build.files 补齐 + 检查 | 本次追加 | tests/package-files.test.js 4/4 |
| C18/C19 接线（REVIEW） | 终端 Home/profiles、媒体预览服务与公开撤销 RPC | 本次追加 | tests/preview-revoke.test.js 4/4 + main.js 接线 |

REVIEW-0152 反馈返修明细（已入 .nightshift/task-outbox.jsonl）：
1. C15 `safeClose` 丢弃结构化关闭结果 → `asShutdownStep`（shutdown-controller.js）保留
   `{confirmed:false, detail, ownedPids}` 并以宿主层三类反例（未确认/挂起/失败）验证。
2. build.files 补 home-backup.js、github-extension-source.js、preview-revoke.js 及 D 的
   media-operations/ssh-forward/ssh-jump/ssh-transfer/terminal-profiles/workspace-media-preview，
   并以 package-files.test.js 做打包输入闭包检查（D 模块仅按名单验证存在性，存在性证明在整合树）。
3. C18：createWorkspaceTerminal 接收 home + createTerminalProfiles({home})（D 模块缺失时守卫跳过，
   行为同旧版）；SettingsView/SettingsLayout 注册 terminal 设置页（组件文件 D 提供，整合树解析）。
4. C19：main.js 守卫创建 workspaceMediaPreview 并传入 createWorkspacePreview；新增 C 拥有的
   preview/revoke + preview/revokeScope 注册（preview-revoke.js，64-hex token 校验）；
   shutdown 有界回收该服务；knorvia-native-types.ts 增补两个方法类型。
5. C04/B02：expectIdentity 移至 checked() 之前按目录校验，"移走且未替换"路径归为 Conflict(-32005)
   而非裸 ENOENT，补对应反例。

## 测试汇总（受变更影响的全部文件）

`node --test`（Node v26.3.0，本机 Git Bash，无 daemon/Chrome 环境变量）：受影响的 19 个测试文件
135 项断言组全部通过（0 fail）。全量 desktop 套件 552 项中 499 过 / 31 skip（live/daemon/Chrome
门控）/ 22 fail——全部失败位于需要 `KNORVIA_DAEMON_BIN`、Chrome/CDP 或真实 SSH 夹具的文件或
并行进程级超时（约 29s 文件级超时），与本次修改的文件无交集。

## 未覆盖边界（如实）

- Electron 整壳级场景（真实杀渲染进程、真实退出链、打包后完整性）未在本夜运行；对应逻辑以
  真实子进程/夹具单测覆盖，端到端留给 I 整合树。
- C19 的 B 侧 PanelPreview 流式消费是 B 拥有文件，C 已注册并可测试的撤销契约；见 C-interfaces.md。
- C20 的受管媒体活动引用仍等 D 的活动接口；provider 形态已就绪。
- C15/C20 的跨路接口请求记录在 reports/C-interfaces.md；补充方向未新增（primary 已占满整轮），
  增补账本见 .nightshift/task-outbox.jsonl（返修与接口记录）。
