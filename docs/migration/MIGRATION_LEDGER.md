# Migration Ledger — KN-GOAL-SUPER-WORKBENCH-001

> 2026-09-05 续接提示：本文件以下是过期历史快照，不作为当前进度依据。
> 权威台账：D:\tools\knorvia-kernel\docs\migration\MIGRATION_LEDGER.md。
> 最新验收：D:\tools\knorvia-kernel\docs\migration\ACCEPTANCE-2026-09-05.md。
> 最新续建：D:\tools\knorvia-kernel\docs\migration\SLICE-002-ASYNC-2026-09-05.md。
> 异步运行基础已实现；整体与 SLICE-002 全项仍未通过。接续事务化恢复/分页游标和共享 daemon 接入，再推进原生工作台 UI，不是发行收尾。

Goal status: **ACTIVE** / `proving_vertical_slice`
Started: 2026-09-04
Charters: `docs/architecture/KN-ADR-001-codex-kernel-cutover.md`, `docs/architecture/KN-GOAL-SUPER-WORKBENCH-001.md`

A Work Package is **DONE** only with real persistence, permissions, cancel/resume,
tests, and captured evidence. Empty scaffolds, mock-only, TODO, silent fallback,
partial migration, or permanent dual-track do not count.

## Current

- Last completed with evidence: CUT-001 Desktop Agent Runtime is `knorvia-daemon`; FastAPI Thread/Turn unmounted
- In progress: DEL-001 remaining StreamBus/agentic files and pytest that still patch the old orchestrator
- Next atomic action: finish deleting dead FastAPI chat/unified_ws modules from the tree and retarget remaining pytest
- Highest open risk: R-001 (dirty Office/Creative Library) and production dual-track (legacy ChatOrchestrator still LIVE)
- User dirty files: protected; listed in GOV-001. Not reset/cleaned/stashed.

## Work Packages

| ID | Title | Status | Evidence |
| --- | --- | --- | --- |
| GOV-001 | Read-only inventory of product + kernel target, charter hashes, dirty files, toolchain, Codex coexistence | DONE | `docs/migration/evidence/gov-001/gov-001.txt` and `{SCRATCH}/gov-001.txt` |
| GOV-002 | Import charters, freeze old runtime expansion, create ledger/inventory/ADR/risk/evidence | DONE | `docs/architecture/`, `AGENTS.md` freeze |
| FORK-001 | Full-history clone, `upstream` fetch-only, pin `8e6a44b428e31f91b21edc97904fcdf4f0931ade` | DONE | `D:\tools\knorvia-kernel` |
| FORK-002 | Zero Knorvia-behavior-patch upstream build + App Server handshake smoke | DONE | `docs/migration/evidence/upstream-baseline/` |
| ID-001 | Knorvia Home/path resolver, `knorvia` CLI, `knorvia-daemon`, vault/UA/telemetry boundary, coexistence | DONE | `knorvia-rs/platform-paths`, CLI, daemon |
| PROTO-001 | Handshake, framing, product store, event journal, kernel adapter, schema, contract tests | DONE | `knorvia-rs/{protocol,store,control,kernel-adapter}` |
| SLICE-001 | Golden vertical slice on real daemon+protocol | DONE | scratch `daemon-1.log` / `slice.log` (product daemon; Kernel thread ownership still via adapter) |
| SEC-001 | Sandbox, action-digest, approval, audit | PARTIAL | approval+digest on control plane; Kernel sandbox not yet the only exec path |
| PROV-001 | Model-neutral Provider Gateway + conformance (OpenAI Responses, compatible, Anthropic, Gemini, local) | PARTIAL | negotiation matrix shipped; live HTTP adapters pending |
| PACK-001 | Capability Host + Pack lifecycle | DONE | `knorvia-rs/capability-host` |
| DOM-OFFICE | Office/GenOffice as Pack/Tool/Worker/Artifact | PARTIAL | pack+artifact fixture; must not touch dirty Office files |
| DOM-RESEARCH | Research domain slice | PARTIAL | pack+artifact fixture |
| DOM-DEV | Developer domain slice | PARTIAL | pack+artifact fixture |
| DOM-DATA | Data domain slice | PARTIAL | pack+artifact fixture |
| DOM-MEDIA | Media domain slice | PARTIAL | pack+artifact fixture |
| DOM-LEARN | Learning domain slice | PARTIAL | pack+artifact fixture |
| MIG-001 | Discover→preflight→snapshot→import→verify→activate→rollback | PARTIAL | fixture migrator shipped; production data not cut over |
| CUT-001 | Kernel is sole production Agent Runtime | DONE | Desktop `startKnorvia` spawns knorvia-daemon; Python CLI/cron/partners use kernel_client |
| DEL-001 | Delete ChatOrchestrator, Python Agent Loop, StreamBus public protocol, FastAPI public Thread/Turn, dual session/provider control from source, packages, run path | PARTIAL | ChatOrchestrator class removed; FastAPI chat/sessions/unified_ws unmounted; StreamBus module still on disk for leftover workers |
| REL-001 | Install/upgrade/rollback/coexistence/SBOM/license/release gates | PENDING | |

## Dependency order (frozen)

基线与治理 → 完整 Fork → 身份隔离 → Protocol/Daemon → 真实黄金纵向切片 → 安全工具与 Provider → Capability/领域迁移 → 超级工作台产品重构 → 全量数据迁移与切流 → 删除旧底座与发行

## Dirty-tree protection (do not edit)

```
knorvia/services/creative_library/store.py
knorvia/services/office_artifacts/ARCHITECTURE.md
knorvia/services/office_artifacts/merge_coordinator.py
knorvia/services/office_artifacts/migration.py
knorvia/services/office_artifacts/store.py
knorvia/services/office_artifacts/store_io.py
knorvia/services/office_artifacts/publication.py
tests/services/office_artifacts/test_merge_coordinator.py
tests/services/office_artifacts/test_store_transactions.py
tests/services/test_creative_library.py
tests/tools/test_office_document_draft.py
web/components/chat/home/OfficeDraftCard.tsx
web/lib/office-draft.ts
web/tests/office-draft-card.test.ts
web/tests/office-review-selection.test.ts
```

## Log

- 2026-09-04 GOV-001: inventory captured. Kernel repo absent. Official Codex live at `~/.codex`. Network probe to github.com/openai/codex succeeded (ls-remote HEAD `9d253c885cb7cc48aeb749a82e31e2070e14f73e`, HTTP 200). Pinned baseline remains `8e6a44b428e31f91b21edc97904fcdf4f0931ade`.
- 2026-09-04 GOV-002 → FORK-002 → ID-001 → PROTO-001 → SLICE-001: kernel repo at pin, upstream build+handshake, knorvia CLI/daemon, golden slice on real daemon. ChatOrchestrator still LIVE. Goal remains ACTIVE.
