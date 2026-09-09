# Knorvia 创作 CLI（creative-cli）

外部 Agent 操作 Knorvia 创作台的正式入口。与桌面创作台、Kernel Agent 共用同一受控服务（媒体任务、资料库、扩展、学习 Pack、精选目录），**不新建第二套生成管线或 Agent 循环**。

```bash
node desktop/creative-cli.js --help          # 用法
node desktop/creative-cli.js schema          # 机器可读命令契约
node desktop/creative-cli.js --home <Home> status
```

## 连接模型与鉴权范围

- **连接模式（默认）**：读取 `<Home>/state/creative-cli.json` 发现文件（由桌面/网关内的 `creative-cli-service` 写入），通过 `http://127.0.0.1:<port>/creative-cli` + Bearer token 调用**桌面正在使用**的同一服务。发现文件只含回环地址、token、pid；仅本机用户可读。
- **独立模式（`--standalone --home <dir>`）**：桌面未运行时，CLI 自举完整栈（knorvia-daemon + 资料库 + 媒体 worker + 扩展 + 学习 Pack）。daemon 持有 Home 锁，因此两种模式天然互斥；串行访问同一 Home 时，UI 与 CLI 看到的是**同一份持久 Job/Artifact**。
- **serve 常驻**：`--standalone serve --home <dir>` 自举后常驻，供多个外部 Agent 进程附着复用。停止方式：Ctrl+C、关闭 stdin，或**删除 `<home>/state/creative-cli.json`**（看门狗 3 秒内优雅退出并回收 daemon；Windows 硬杀进程会跳过信号处理，删除文件是始终可靠的停机开关）。
- CLI 永远只绑定 127.0.0.1；固定端口限 B 路 4420–4429（默认临时端口）。

## 输出与错误合同

- stdout：**恰好一条 JSON 文档** `{"ok":true,"result":…}` 或 `{"ok":false,"error":{"code":…,"message":…}}`；诊断信息走 stderr。
- 退出码：`0` 成功；`2` 用法错误（含未知命令、参数校验失败）；`3` 未找到；`4` 冲突/忙（资料库 -32005/-32042）；`5` 超时；`6` 缺依赖（如 FFmpeg/whisper 未配置，`error.reason` 给出机器原因）；`7` 执行失败；`8` 服务不可用/拒绝。
- 每条命令可设 `--timeout <ms>`（默认 30s）；`jobs.wait` 内部受 `timeoutMs` 参数约束（≤10 分钟）。
- 版本约定：过期的 `revision` / `expectedSha256` 会被拒绝（错误信息含“更新/重新读取”），CLI **从不**自动重试或覆盖；未知结局的任务**从不**自动重提。

## 命令面（白名单，无任意 RPC 透传）

| 组 | 命令 |
| --- | --- |
| 工具 | `tools.list` / `tools.describe {name}` / `tools.call {name,arguments}`（与 Kernel MCP 完全同一分发函数 `callMediaTool`） |
| 任务 | `jobs.list {typePrefix?,offset?,limit?}` / `jobs.read {id}` / `jobs.wait {id,timeoutMs}` / `jobs.cancel {id}` / `jobs.resume {id}` |
| 资料库 | `library.list` / `library.read {id}` / `library.versions` / `library.write` / `library.put {sourcePath,destination[,expectedSha256]}` / `library.trash` / `library.restore` / `library.search` |
| 学习 | `learning.sources`、`learning.lecture.create|read`、`learning.quiz.create|read`、`learning.attempt.record|correct`、`learning.mastery.read|rebuild`、`learning.review.due` |
| 目录 | `catalog.list` / `catalog.preflight {id}` |
| 成果 | `artifacts.list {folder?}`、课程经 `tools.call`（`openmaic_course` save/read/sample） |
| 扩展 | `extension.list|enable|uninstall|rollback` |

### 素材加工（本地、无模型费用）

```bash
# 视频尾帧（按 PTS 解码真实最后一帧），结果带来源版本 provenance
node desktop/creative-cli.js --home <Home> library.video.extract-frame '{"libraryId":"…","version":"…"}'
# 图片裁切/缩放/格式转换，另存为新库条目并记录来源
node desktop/creative-cli.js --home <Home> library.image.process '{"libraryId":"…","crop":{…},"scale":{…},"format":"jpg"}'
```

### 完整剪辑往返示例

```bash
H=--home:$HOME/.knorvia; CLI="node desktop/creative-cli.js --home $H"
$CLI library.put '{"sourcePath":"D:/素材/夜景.mp4","destination":"素材/夜景.mp4"}'
$CLI tools.call '{"name":"media_edit","arguments":{"action":"import","title":"夜景成片","references":[{"id":"…","version":"…"}],"idempotencyKey":"n1"}}'
$CLI tools.call '{"name":"media_edit","arguments":{"action":"update","id":"job_…","revision":1,"edit":{"clips":[{"id":"import-0","rotation":90,"mirror":true,"fit":"cover"}]}}}'
$CLI tools.call '{"name":"media_edit","arguments":{"action":"export","id":"job_…","revision":2,"idempotencyKey":"e1"}}'
$CLI jobs.wait '{"id":"job_…","timeoutMs":120000}'
```

## 安全边界

- 命令是**显式白名单**；没有万能 RPC、没有任意主机文件读取。`library.put` 只把显式给定的文件**复制进**资料库（与 UI 上传同语义），产物全部落在 `<Home>/personal-library` 下并在工作台可见。
- 生成类工具（imagegen/videogen/sequence/retake）只在用户已配置并允许 Agent 使用的模型连接上运行；未配置时返回明确错误，不伪造任务。
- 扩展命令不安装任何东西；`catalog.preflight` 只报告依赖事实与修复提示。
- 学习工具遵守：证据必须带 libraryId+版本+行号+原文；`authorship` 如实标注；无模型拒绝生成；掌握度只来自结构化尝试记录。

## 与桌面/Kernel 的关系

`desktop/studio-mcp.js` 的 `callMediaTool` 是 Kernel MCP 与本 CLI 的同一分发函数；学习/目录工具经 `learning-pack.js`、`curated-catalog.js` 暴露给两者。桌面主进程和本地开发网关启动时，均用同一 Home、资料库和学习实例启动创作 CLI 服务；关闭时撤销连接信息。

发现协议版本为 `serviceVersion: 1`，位于 `<Home>/state/creative-cli.json`，包含回环 `url`、Bearer `token`、`pid`、`startedAt` 和 `scope: creative`。该文件属于本机凭据，不应输出到日志或复制给远端。CLI 只允许 HTTP 回环 IP 的 `/creative-cli` 地址，并拒绝重定向；服务拒绝浏览器 Origin 和无效令牌。关闭旧实例时仅删除令牌仍匹配的发现记录。`status` 在媒体服务初始化期间仍可返回，此时 `mediaReady` 为 false。

学习页面位于 `/workbench/learning`，通过原生 RPC 读取同一资料库。讲义和练习的内容保存在资料库的不可变版本中；返回的 `revision` 和 `sha256` 与实际文件版本一致。此处的学习成果是资料库成果，当前不额外复制成 Rust Artifact 内容。更新来源后，旧讲义显示引用已过期，但固定版本仍可读取。

本地验收：`node --test desktop/tests/creative-cli.test.js desktop/tests/learning-live-kernel.test.js desktop/tests/creative-cli-gateway.test.js`。后两项需要已有 Knorvia daemon 与 Kernel 可执行文件，实际启动独立 CLI 进程和本机 Responses 夹具，覆盖 Kernel 学习工具调用、原生网关附连、来源与成果版本一致、关机清理；不会访问收费模型。它们不代表真实供应商或安装包验收。
