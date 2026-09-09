# Knorvia Office Artifact Runtime v2 — 能力规格

Knorvia 的 Office 能力是一个 **Agent 原生的制品运行时**（Office Artifact
Runtime，简称 OAR）：XLSX 是首个完整纵向切片，DOCX/PPTX 目前只支持生成与
导出，导入的 docx/pptx 一律失败关闭。Agent 与人共用同一套严格、类型安全的
操作协议与写入服务。

本文是当前已实现能力的规格说明；设计取舍与演进路线见
`knorvia/services/office_artifacts/ARCHITECTURE.md`。

## 核心原则

1. **确定性修订**：任何修改都必须基于已读取的确定修订
   （`base_revision`，CAS）。修订不匹配返回冲突（HTTP 409 /
   `REVISION CONFLICT`），绝不 last-writer-wins。
2. **隔离草稿**：所有编辑发生在 `task_dir/office_drafts/<draft_id>/` 的
   隔离草稿中，原始文件在用户确认合并（merge）前不被触碰。
3. **原子事务**：一个操作批次要么全部生效，要么全部不生效（失败时草稿
   修订号不变、字节不变）。
4. **可理解的语义差异**：每次提交产出语义 diff（单元格、合并、冻结、
   行高/列宽、维度），供审查卡与 Agent 汇报使用。
5. **提交前验证**：ZIP 结构（CRC/必备部件）→ openpyxl 重开 → 目标回读 →
   未触碰 OOXML 部件的 SHA-256 逐一比对。任何一项失败则整个批次失败。
6. **失败关闭**：不能证明安全、正确或格式保真的操作一律拒绝并给出稳定
   的 `reason`（如 `protected_sheet`、`shared_formula`、
   `date_value_unsupported_on_import`、`external_link_present`）。

## 模块结构

```
knorvia/services/office_artifacts/
  contracts.py      # Pydantic v2 操作协议、限额、错误层级、A1 解析
  sources.py        # 来源解析（attachment/library/workspace/generated）+ ZIP 安全筛查
  store.py          # 内容寻址 blob + 修订日志 + 历史 cursor + v1→v2 迁移
  service.py        # OfficeArtifactService：读写/应用批次/undo/redo/merge
  diff.py           # 语义 diff
  verification.py   # 未触碰部件哈希、ZIP 结构验证
  adapters/         # xlsx_reader / xlsx_patch（lxml 窄修补）/ xlsx_adapter /
                    # generated_docx / generated_pptx / univer_container
```

工具层：

| 工具 | 常驻/延迟加载 | 职责 |
| ---- | ---- | ---- |
| `office_artifact` | 常驻（小 schema） | open / create / status / ready / undo / redo |
| `office_read` | 延迟加载（load_tools） | overview / range / find / features / diff / history |
| `office_apply` | 延迟加载（load_tools） | 单批次严格操作应用（含冻结选区检查） |
| `office_document` | 常驻（兼容门面） | v1 全量 action 面向后兼容；v2 路径复用同一 service |

## 操作协议（XLSX）

`set_cell`（text/number/boolean/value_date/value_datetime/empty 六选一）、
`set_formula`（必须以 `=` 开头）、`clear_cells`、`set_range`、`copy_style`、
`merge_cells`、`unmerge_cells`、`set_row_height`、`set_column_width`、
`freeze_panes`。每个模型 `extra="forbid"`；批次上限 200 个操作 /
20,000 个触碰单元格。

导入工作簿采用 **窄 OOXML 修补**：原始 ZIP 是事实来源，仅目标工作表 XML、
`workbook.xml`（fullCalcOnLoad）与 `calcChain.xml`（公式操作时删除）可变，
其余部件逐字节保留；字符串以 `inlineStr` 写入，避免触碰 sharedStrings。
生成工作簿走 openpyxl 全量重写。

## 来源与合并

- `attachment:<id>`（会话清单 + MIME 门禁）、`library:<entry-id>`
  （创意库，merge 时以 `origin_base_hash` 做 CAS）、`workspace:<ref>`
  （turn 工作区）、`generated:new`（新建制品）。
- merge 是用户确认后的动作：审查卡 PATCH `action=merge`（draft 状态下
  服务端自动补 ready）；工具永远不能跳过 ready 语义。

## 冻结选区

前端预览选择的单元格/区域随 `start_turn` 的 `office_selection`
（draft_id/artifact_id/sheet/range/revision）上传，服务端白名单化后冻结进
turn 上下文；`office_apply` 拒绝任何越出选区工作表/范围或基于过期修订的
批次。

## API（`/api/v1/chat/office-drafts`）

- `GET /{draft_id}`、`PATCH /{draft_id}`（merge/discard）——同时服务 v1 与
  v2 草稿（按 `meta.json` 的 `schema_version` 只读判别；API 侧绝不迁移）。
- v2 制品端点：`/artifacts/{id}/overview|range|find|diff|history|content`、
  `POST .../operations`（actor="user"）、`POST .../undo|redo`、
  `POST /open`（library/workspace 来源打开为编辑草稿，创意库编辑器的
  人工保存链路即此：open → 分批 operations → merge）。

## 兼容与迁移

- `office_document` 保留 v1 全部 action 与错误文案；v1 草稿在 **Agent 通过
  工具触碰时** 原地迁移到 v2（`_migrate_v1`），API 只读不迁移。
- v2 修订镜像同步到 `office_drafts/<id>/<filename>`，保持 v1 时代物理布局
  （`/api/outputs` 直接可服务，旧测试与卡片 URL 不变）。

## 质量门禁

后端：`python -m pytest tests`（office 专项 + 全量）、
`ruff check knorvia tests scripts`、`scripts/architecture_guard.py`。
前端：`npm run test:node`、`npm run lint:ci`、`npm run i18n:check`、
`npx tsc --noEmit`、`npm run build`。
