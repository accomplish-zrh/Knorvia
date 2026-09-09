# Legacy inventory — production paths that must leave the Agent Runtime

Captured GOV-002 from source at HEAD `5827b20d1cde742b22597c8c7f25c76eeacf2247`
plus the dirty Office/Creative Library worktree (protected, not inventoried as
“done”). This is the deletion/cutover map, not a rewrite plan.

Status key: **LIVE** = still on the production path; **KEEP-VALUE** = behavior
must survive as Pack/Tool/Worker/Artifact/Job; **DELETE-AFTER-CUTOVER** = must
be unreachable from source, release packages, and run path when the Goal completes.

## 1. Agent Runtime (DELETE-AFTER-CUTOVER)

| Path | Role | Status |
| --- | --- | --- |
| `knorvia/runtime/orchestrator.py` | `ChatOrchestrator` unified entry | LIVE |
| `knorvia/core/agentic/loop.py` | Python Agent Loop | LIVE |
| `knorvia/core/agentic/client.py` | LLM client inside loop | LIVE |
| `knorvia/core/agentic/tool_dispatch.py` | Tool dispatch | LIVE |
| `knorvia/core/agentic/messages.py` | Chat Completions message array as state | LIVE |
| `knorvia/core/stream.py` | `StreamEvent` public protocol | LIVE |
| `knorvia/core/stream_bus.py` | `StreamBus` fan-out | LIVE |
| `knorvia/runtime/registry/` | Tool + Capability registries owning turn routing | LIVE |
| `knorvia/runtime/providers/` | Duplicate provider control | LIVE |
| `knorvia/services/session/` | Session store / turn events | LIVE |
| `knorvia/agents/chat/` | Chat capability wrapping the loop | LIVE |

## 2. Public control plane (DELETE-AFTER-CUTOVER as public Thread/Turn)

| Path | Role | Status |
| --- | --- | --- |
| `knorvia_cli/main.py` | Typer `knorvia` CLI (`pyproject.toml` script) | LIVE — Python CLI remains until Rust CLI cutover; must not dual-register |
| `knorvia/api/main.py` | FastAPI app | LIVE |
| `knorvia/api/routers/unified_ws.py` | Unified WebSocket | LIVE |
| `knorvia/api/routers/chat.py` | Chat HTTP | LIVE |
| `knorvia/api/routers/sessions.py` | Sessions HTTP | LIVE |
| `desktop/main.js` | Electron spawns `python -m knorvia.desktop.ipc_bridge` | LIVE |
| `knorvia/desktop/ipc_bridge.py` | Desktop JSON-line engine | LIVE |
| `web/` | Next.js UI talking to FastAPI/WS | LIVE — keep product; retarget to Knorvia Protocol |

## 3. KEEP-VALUE domains (migrate, do not drop)

| Area | Primary paths | Target shape |
| --- | --- | --- |
| RAG / knowledge | `knorvia/services/rag/`, `knorvia/knowledge/`, `knorvia/tools/rag_tool.py` | Pack + Worker |
| Memory | `knorvia/services/memory/` | Pack / Kernel memory seam |
| Office / GenOffice | `knorvia/services/office_artifacts/`, `office_draft.py`, `tools/office_*` | Artifact runtime + Pack (**dirty tree — do not edit now**) |
| Creative library | `knorvia/services/creative_library/` | Pack (**dirty tree — do not edit now**) |
| Media | `services/image_studio`, `video_studio`, `imagegen`, `videogen`, `voice` | Pack + Job |
| Learning | `knorvia/learning/`, `capabilities/mastery`, `agents/question` | Pack |
| Research | `knorvia/agents/research/` | Pack |
| Partners / automations | `knorvia/partners/`, `services/cron/`, `services/partners/` | Automation + Connection |
| MCP / skills | `services/mcp/`, `services/skill/`, `skills/builtin/` | Connection + Pack |
| Multi-provider | `services/llm/`, `services/provider_registry.py`, `data/user/settings/model_catalog.json` | Provider Gateway |
| Parsing / embedding | `services/parsing/`, `services/embedding/` | Workers |
| Sandbox (legacy) | `services/sandbox/` | Replace with Kernel sandbox + Policy |
| Notebook / book | `knorvia/book/`, `services/notebook/` | Pack / Artifact |
| Classroom | `services/classroom/` | Pack |
| Visualize / Manim | `agents/visualize/`, `agents/math_animator/` | Pack + Job |

## 4. Data locations (migrate with preflight/snapshot/import/verify/activate/rollback)

| Location | Contents |
| --- | --- |
| `D:\tools\Knorvia\data/` | Project runtime data (settings JSON/YAML, jsonl, attachments, media) |
| `D:\tools\Knorvia\data\user\settings/` | `main.yaml`, `system.json`, `model_catalog.json`, `auth.json`, integrations, RAG engines |
| `D:\tools\Knorvia\desktop-data/` | Dev Electron `KNORVIA_HOME` |
| Packaged desktop workspace | `%LOCALAPPDATA%` / portable sibling (see `desktop/main.js` `workspaceRoot`) |
| `C:\Users\17018\.codex` | **Official Codex home — not a Knorvia source.** Import only if the user explicitly triggers Codex import. Never default-write. |

## 5. Identity collisions to prevent

| Surface | Current | Required after isolation |
| --- | --- | --- |
| CLI | Python `knorvia` | Rust `knorvia`; no Knorvia-published `codex` binary |
| Daemon | none | `knorvia-daemon` private sidecar |
| Home | `KNORVIA_HOME` or cwd/`desktop-data`/`data` | `knorvia-platform-paths`; Windows `%LOCALAPPDATA%\Knorvia` |
| Codex | npm `codex` + `~/.codex` live on this machine | Unchanged; Knorvia must not touch |

## 6. Tests that currently bind the old runtime

`python -m pytest` (`tests/`, `knorvia/learning/tests`), `web` `lint:ci` + `test:node` + `build`, `desktop` `npm test`. Characterization tests stay until cutover; new Kernel tests live in `knorvia-kernel` and must drive shipped functions.

## 7. Freeze

No new permanent abstractions on the rows in sections 1–2. Feature flags that keep the old loop need an owner, expiry, and a delete gate (DEL-001).
