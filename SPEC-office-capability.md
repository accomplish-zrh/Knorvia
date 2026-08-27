# Knorvia 结构化办公能力规格书（A/B/C 三档）

你要在 Knorvia 项目（`D:\tools\Knorvia-1.8.0`）里实现类似 dsh-univer-office 的结构化办公能力。
分 A、B、C 三档，**按顺序做，每档做完必须跑验收命令，全绿才能进下一档**。

## 项目背景（必读）

- 后端：Python FastAPI，包 `knorvia/`；测试用 `.venv/Scripts/python.exe -m pytest`
- 前端：Next.js 16 + TS + Tailwind（CSS 变量主题），目录 `web/`
- 工具注册表：`knorvia/tools/builtin/__init__.py` 的 `BUILTIN_TOOL_TYPES`
  （新工具类写好后在此注册；参考同文件里 `ExecTool`/`code_execution` 的写法）
- 工具基类：`knorvia/core/tool_protocol.py` 的 `BaseTool/ToolDefinition/ToolParameter/ToolResult`
- 产物服务：聊天 turn 的任务目录 `task_dir`，落到其中的文件经 `/api/v1/outputs/*` 公开服务；
  前端有现成的下载卡。流水线注入点见 `knorvia/agents/chat/agentic_pipeline.py`
  搜 `_sandbox_workdir` / `_workspace_dir`（code_execution 和 exec 已把 task_dir 挂为沙盒工作区）
- 现有可复用资产：
  - `web/components/chat/preview/previewers/XlsxPreview.tsx`（exceljs 网格+公式条+sheet tabs）
  - `web/components/chat/preview/previewers/SpreadsheetGrid.tsx`
  - `web/components/chat/preview/previewers/DocxPreview.tsx`、`PptxPreview.tsx`
  - `web/lib/xlsx-workbook.ts`（loadExcelWorkbook/spreadsheetFromWorkbook/workbookToXlsxFile）
  - `web/components/library/LibraryExcelEditor.tsx`（可编辑表格网格，写回 xlsx）
  - 后端 `knorvia/services/path_service.py`：`get_public_outputs_root()` / `is_public_output_path()`
  - venv 里已装 openpyxl / python-docx / python-pptx / Pillow（不要引入新依赖！）
- 测试基线：后端全绿零警告；前端 tsc=0、eslint=0（--max-warnings 0）、649 node 测试
- 行数红线：新文件 ≤800 行起步没问题；改大文件前查 `scripts/architecture_guard.py` LIMITS

## 项目规范（硬性）

1. 每个新文件都写清楚模块 docstring
2. ruff 干净：`C:/Users/17018/AppData/Local/Programs/Python/Python313/python.exe -m ruff check knorvia tests`
3. i18n：前端所有 UI 文案必须 `t("...")`，中英文 key 加进
   `web/locales/en/app.json` 与 `web/locales/zh/app.json`（en 的值=key 本身，zh 给翻译）
   改完跑 `node scripts/i18n_parity.mjs` 必须 OK
4. 新功能必须有 pytest 单测（mock 外部 IO），每个公开函数至少正例+一例失败路径
5. 提交规范：每档一个 commit，message 写清做了什么；**绝不 push**（本地 git 无远程）
6. 不要动 web/i18n/init.ts、web/scripts/build_en_overrides.mjs
7. Windows 环境，bash（MSYS）语法

## ── A 档：结构化办公工具 `office_document` ──

### 目标
给模型一个结构化工具替代"盲写 openpyxl 代码"，降低失败率。

### 后端 `knorvia/tools/office_document.py`

新建 `OfficeDocumentTool(BaseTool)`，name=`office_document`。

参数 schema（全部 JSON 可描述）：
```
action: string  — 必填，枚举: create | add_sheet | write_cells | formula | style |
                       chart | read | export_doc | export_slide | screenshot_hint
file: string    — 输出文件名(相对本轮工作区)，create 时必填
sheet: string   — 表单名/页名
cells: object   — {"A1": "标题", "B2": 123, ...} 或二维数组 [["a","b"],[1,2]]
formula_cells: object — {"D2": "=SUM(B2:C2)"}
styles: array   — [{target:"A1:D1", bold:true, bg:"#B0501E", color:"#FFFFFF", font_size:12}]
chart: object   — {type:"bar|line|pie", data_range:"A1:B5", title:"..."}
content: string — export_doc/export_slide 时: Markdown 或大纲文本（按段落/标题/列表渲染）
read_range: string — 如 "A1:D10"
```

行为约定：
- 所有文件操作相对本轮沙盒工作区（kwargs 里会有 `_workspace_dir`，
  参照 agentic_pipeline 对 code_execution 的注入方式——如果拿不到就落 CWD 并在结果里给出绝对路径）
- `export_doc`: 用 python-docx 把 Markdown 子集（#/##/### 标题、- 列表、表格行 |a|b|、普通段落）
  渲染成 .docx；heading 层级映射 Heading 1-3；列表用 List Bullet 样式
- `export_slide`: 用 python-pptx 按大纲生成幻灯片——一级标题=新页标题，页内要点=bullets；
  设置 16:9 (Inches(13.333)x(7.5))
- `read`: openpyxl 读回区域返回 CSV 文本（这样模型能自检写入结果）
- 每次 action 成功后在 ToolResult.metadata 里带 `{"output_file": 相对路径}`，
  content 里给人话摘要（如 "已写入 B2:D10 共 24 格, 含 2 条公式"）
- 失败（如 file 未创建就 write_cells）→ success=False + 明确错误提示，不抛异常穿透
- 工具 description 要教模型典型流程：create → add_sheet/write_cells → formula → style → chart → read 自检 → (可选) export_*

### 注册与挂载
- 在 `knorvia/tools/builtin/__init__.py` 导入并加入 BUILTIN_TOOL_TYPES
- 若 BUILTIN_TOOL_TYPES 有 CONFIGURABLE_BUILTIN_TOOL_NAMES 白名单机制则同步加名字
  （看现有注释决定）；观察 agentic_pipeline 里 code_execution 的 kwargs 注入分支，
  为 office_document 注入同样的 `_sandbox_user_id/_sandbox_workdir`（复用 exec_dir 分支即可，
  或直接走 code_execution 同款任务目录）

### 测试 `tests/tools/test_office_document_tool.py`（新建 tests/tools/__init__.py 若无）
- create+xlsx 写入读回 round-trip
- formula 写入后 read 能看到公式串
- style 应用不炸
- chart 创建成功（openpyxl BarChart 即可，别追求花哨）
- export_doc 从 markdown 渲染出 heading/table/list 且文件字节数>0
- export_slide 生成多页 pptx
- 无效 action → success=False
- 未 create 就 write_cells → 明确报错

### 验收（A 档完成标准）
```bash
cd D:/tools/Knorvia-1.8.0
./.venv/Scripts/python.exe -m pytest tests/tools/test_office_document_tool.py -q --override-ini="addopts="
C:/Users/17018/AppData/Local/Programs/Python/Python313/python.exe -m ruff check knorvia tests
git add -A && git commit -m "office_document tool: structured xlsx/docx/pptx authoring for the agent"
```
然后我（调用方）会亲自在真实对话里冒烟测试，你等我的反馈再进 B 档。

## ── B 档：草稿审阅工作流 ──

### 目标
抄 dsh-univer-office 的核心体验：agent 的修改先进隔离草稿，用户在消息尾部的审阅卡片里预览，确认才落正式文件。

### 后端
1. `knorvia/services/office_draft.py` 新建 `OfficeDraftStore`：
   - 目录 `<task_dir>/office_drafts/<draft_id>/` 存 draft 文件
   - 状态机 `draft -> ready -> merged | discarded`（draft_id 用 uuid4 前 8 位）
   - 方法：create(files)→id、mark_ready(id)、merge(id)（覆盖回 workspace 正式路径）、
     discard(id)、status(id)、diff(id)（简单版：文件大小+mtime 列表即可，不做内容 diff）
   - 全部方法带类型标注和 docstring
2. `office_document` 工具新增参数 `as_draft: boolean`（默认 true！）和
   `draft_action: create|ready|merge|discard|status`（独立 action 枚举值）。
   所有写操作默认写进草稿目录而不是直接写工作区；`merged` 终态后拒绝继续写
3. agentic_pipeline：当 turn 内出现 office_document 草稿操作时，把 draft 元数据
   （draft_id、files、状态）写进 context.metadata，随事件流到前端
   （模仿现有 video_confirmation_fingerprint 的 metadata 传递模式）

### 前端
1. `web/components/chat/home/OfficeDraftCard.tsx` 新建审阅卡片：
   - props: `{ draftId, files: {name,url}[], status }`（url 走 /api/v1/outputs/…）
   - draft 态显示文件列表 + [预览](点击弹出已有的 XlsxPreview/DocxPreview 于弹层或内嵌 iframe/对象标签)
     + [确认合并] [放弃] 两按钮（危险操作用 destructive 色）
   - ready 态显示等待确认文案；merged/discarded 显示终态徽标
   - 按钮点击调 PATCH `/api/v1/chat/office-drafts/{draftId}`（新建这个路由，
     放在合适的现有 router 里或 outputs.py 旁，接受 action=merge|discard）
2. TracePanels.tsx 的消息渲染层接入：识别流里的 office draft 事件→渲染 OfficeDraftCard
   （模仿 ChatTaskCards 的挂载方式，别破坏现有逻辑——这是用户的底线要求：
   **不得破坏前端已有功能，tsc/eslint/全部 node 测试必须保持绿**）

### 测试
- 后端：draft store 状态机全路径（含非法转换 draft→merged 直接 discard 等）、
  merge 覆盖正确、路由权限（非管理员拒绝？跟 outputs 一致即可）
- 前端：node 测试至少 3 个（卡片渲染三态、按钮回调）

### 验收
```bash
./.venv/Scripts/python.exe -m pytest tests/tools tests/api -q --override-ini="addopts="
cd web && npx tsc --noEmit && npx eslint app components lib && npm run test:node | tail -5 && node scripts/i18n_parity.mjs
git add -A && git commit -m "office draft review workflow: isolated drafts + review card in chat"
```

## ── C 档：Univer 多 Unit 容器（.univer 文件）──

### 目标
一个 `.univer` 文件装 Sheet+Doc+Slide 多 Unit，Sheet 数据能被 Slide 图表引用。

### 方案（务实版，不引入 Univer Node Gateway——太重）
`.univer` = ZIP 容器（仿 OOXML）：内含 `manifest.json`（units 数组:
{id,type:"sheet|doc|slide",file}）+ 各 unit 的原生格式文件
（unit.xlsx / unit.docx / unit.pptx）。

1. 后端 `knorvia/services/univer_container.py`：
   - `pack_univer(manifest_entries, out_path)` / `open_univer(path)` /
     `add_unit(path, type, name, source_bytes?)` / `remove_unit` / `list_units`
   - 数据引用：Slide 里插入"数据来源: Sheet!A1:B5"文本占位 + manifest 里记 reference 关系
     （真图表联动超出本档范围，但 manifest 结构预留 `refs` 字段并在文档里说明路线）
2. `office_document` 工具加 actions: `container_new/container_add/container_export_unit`
3. 前端：打开 `.univer` 时按 manifest 分 unit 交给对应 Preview 组件（tab 切换），
   新建 `web/lib/univer-container.ts` 用 JSZip？——不行，禁止新依赖；
   用浏览器 Compression Streams 太麻烦，改为：后端加
   `GET /api/v1/outputs/../container?unit=<id>` 解包代理路由，前端只管要单个 unit 的 url
4. 测试：容器打包/解包 round-trip、跨 Unit 引用记录、损坏 zip 报错

### 验收
```bash
./.venv/Scripts/python.exe -m pytest tests/tools tests/services -q --override-ini="addopts="
（前端同 B 档全套）
git add -A && git commit -m ".univer multi-unit container: pack/open/units + chat preview routing"
```

## 协作纪律

- 你(grok)全程自主推进，不需要每步问我；但**每档结尾停下等我冒烟反馈**
- 我会在你提交后跑全量验证；若发现坏味我会发反馈，你优先修
- 报告进度时列出：新增文件清单、关键决策、跑过的验收命令及输出摘要
- 如果某个方案跑不通，换个思路再来，别死磕一条路
