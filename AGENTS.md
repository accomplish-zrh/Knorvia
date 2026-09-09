# Knorvia — Agent-Native Architecture

> **Public source snapshot (2026-09-09):** The current custom Rust runtime is
> checked in at `native/knorvia-rs`. `native/README.md` pins the unchanged
> upstream App Server source. This makes the public repository reproducible;
> build caches and local runtime homes stay outside source control. A separate
> existing engine checkout may still be used for execution and build caches,
> but new custom runtime changes must be kept consistent with the checked-in
> source rather than silently diverging between two copies.

> **Browser preference (user, 2026-09-06):** Use the installed Google Chrome
> for debugging and browser acceptance by default. Prefer the installed Chrome
> control extension through the trusted Node REPL browser runtime. Use dedicated
> task tabs and isolated product test data. Report an unavailable extension
> connection accurately; do not inherit a Tabbit-only workflow.

> **CURRENT (2026-09-05): General Agent Workbench.** The current product decision
> is `docs/architecture/KN-ADR-002-general-agent-workbench.md`, which supersedes
> earlier fixed navigation, learning/creative feature parity, and implementation
> ordering. The user explicitly authorized this change of standard.
>
> The default product lives at `web/app/workbench` and `web/components/native`.
> Its project/task/history/output/extension flows use Knorvia JSON-RPC through
> the desktop preload or the loopback development gateway. Durable Thread,
> Turn, Item, Approval and Artifact state belongs to the Rust control/store;
> the full Codex-derived Kernel is the sole task execution owner. Streaming
> text is provisional; only durable snapshots can declare task completion.
>
> Learning and creation are optional domain capabilities, not mandatory root
> providers, navigation, or startup services. Legacy routes and user data remain
> migration sources. Do not reconnect the default workbench to the Python loop
> or expand the legacy bridge to implement new task features. Retain explicit
> opt-in compatibility switches where needed.
>
> Validate native changes against the actual daemon and Kernel with an isolated
> local Responses fixture as well as scoped tests and browser interactions.
> Report this accurately as local fixture coverage, not live-provider or packaged
> cross-platform release coverage. Preserve unrelated user changes.

> **FROZEN (GOV-002, 2026-09-04).** The body of this file still describes the
> **legacy** Python Agent Runtime (`ChatOrchestrator`, `StreamBus`, Python
> Agent Loop, FastAPI/WebSocket public control plane). That description is
> **historical inventory**, not the long-term center.
>
> Accepted architecture: `docs/architecture/KN-ADR-001-codex-kernel-cutover.md`
> and Goal `docs/architecture/KN-GOAL-SUPER-WORKBENCH-001.md`. Progress:
> `docs/migration/MIGRATION_LEDGER.md`.
>
> **Do not expand** ChatOrchestrator, StreamBus/`StreamEvent` as a public
> fact protocol, the Python Agent Loop, duplicate Session/Provider agent
> control, or FastAPI as the public Thread/Turn control plane. New work
> belongs on the in-tree Rust Knorvia Kernel (full-history fork of
> `openai/codex`), `knorvia` CLI, `knorvia-daemon`, Knorvia Protocol, and
> Pack / Tool / Worker / Artifact / Job. The old runtime may be an oracle
> or temporary adapter during migration only; dual-track is not the end
> state.
>
> Worktree protection, tests, and code-quality rules below remain in force.
> Uncommitted Office Artifact / Creative Library files listed in the
> ledger must not be reset, cleaned, overwritten, or stashed without
> explicit owner handoff.

## Overview

Knorvia is an **agent-native** intelligent learning companion organized
around a two-layer plugin model — single-shot **Tools** invoked by the
LLM, and multi-stage **Capabilities** that take over a turn — exposed
through three entry points: CLI, WebSocket API, and Python SDK.

## Architecture

```
Entry Points:  CLI (Typer)  |  WebSocket /api/v1/ws  |  Python SDK
                    ↓                   ↓                   ↓
              ┌─────────────────────────────────────────────────┐
              │              ChatOrchestrator                    │
              │   routes UnifiedContext → selected Capability    │
              │   (defaults to `chat`)                           │
              └──────────┬──────────────┬───────────────────────┘
                         │              │
              ┌──────────▼──┐  ┌────────▼──────────┐
              │ ToolRegistry │  │ CapabilityRegistry │
              │  (Level 1)   │  │   (Level 2)        │
              └──────────────┘  └────────────────────┘
```

All capabilities emit on a shared `StreamBus`; the orchestrator fans
events out to consumers. Runtime settings live in
`data/user/settings/*.json` — project-root `.env` files are intentionally
ignored.

### Level 1 — Tools

Single-function tools the LLM picks on demand. Four user-toggleable tools
surface in `/settings/tools`:

| Tool           | Description                                   |
| -------------- | --------------------------------------------- |
| `brainstorm`   | Breadth-first idea exploration with rationale |
| `web_search`   | Web search with citations                     |
| `paper_search` | arXiv preprint search                         |
| `reason`       | Dedicated deep-reasoning LLM call             |

The rest are **context-gated**: the chat capability auto-mounts them from
`ToolMountFlags` (presence of a KB, attachments, sandbox availability, …), and
any of them can also be force-enabled via `--tool`. Auto-mounted set: `rag`,
`read_source`, `read_memory`, `write_memory`, `read_skill`, `load_tools`,
`exec`, `code_execution` (sandboxed Python: NL intent → code → run),
`list_notebook`, `write_note`, `web_fetch`, `github`, `cron`,
`ask_user` (pauses the turn and resumes with the user's reply), plus the
mastery-path tools. `geogebra_analysis` is parked under
`COMING_SOON_TOOL_TYPES`.

### Level 2 — Capabilities

Multi-stage pipelines that own the turn:

| Capability       | Stages                                                |
| ---------------- | ----------------------------------------------------- |
| `chat`           | exploring → responding (single agentic loop, default) |
| `mastery_path`   | responding (Guided Learning — chat loop + mastery tools, gated per topic type) |
| `deep_solve`     | planning → reasoning → writing                        |
| `deep_question`  | ideation → generation                                 |
| `deep_research`  | rephrasing → decomposing → researching → reporting    |
| `visualize`      | analyzing → generating → reviewing (SVG / Chart.js / Mermaid / HTML; or routes to Manim sub-stages via `render_type`) |
| `math_animator`  | concept_analysis → concept_design → code_generation → code_retry → summary → render_output |

All capabilities converge on `emit_capability_result()` in
`knorvia/capabilities/_shared.py` so every turn emits the same envelope
(response payload + `cost_summary` from `UsageTracker`). Status copy and
prompts are i18n'd via `capabilities/prompts/{en,zh}/<name>.yaml`.

## CLI Usage

```bash
# Install
pip install knorvia      # Lightweight agent/CLI runtime
pip install "knorvia[app]" # Full app (Web/API + RAG + media)
pip install knorvia-cli  # CLI-only

# Run any capability
knorvia run chat "Explain Fourier transform"
knorvia run deep_solve "Solve x^2=4" -t rag --kb my-kb
knorvia run visualize "Animate sine wave" --config render_mode=manim_video

# Interactive REPL
knorvia chat
# (inside the REPL: /regenerate or /retry re-runs the last user message)

# Partners (IM-connected companions)
knorvia partner list

# Knowledge bases, memory, server
knorvia kb list
knorvia kb create my-kb --doc textbook.pdf
knorvia memory show
knorvia serve --port 8001       # API server only
knorvia start                   # backend + frontend together
```

## Key Files

| Path                                       | Purpose                              |
| ------------------------------------------ | ------------------------------------ |
| `knorvia/runtime/kernel_client.py`       | Python adapter to `knorvia-daemon`   |
| `knorvia/runtime/launcher.py`            | Backend + frontend lifecycle / port discovery |
| `knorvia/runtime/registry/`              | Tool + Capability registries         |
| `knorvia/runtime/bootstrap/builtin_capabilities.py` | Built-in capability class paths |
| `knorvia/services/config/runtime_settings.py` | JSON settings + process-env overrides |
| `knorvia/services/cron/service.py`      | Scheduled-task store + scheduler     |
| `knorvia/services/cron/templates.py`    | Built-in automation template catalog |
| `knorvia/core/stream.py`, `stream_bus.py` | StreamEvent protocol + async fan-out |
| `knorvia/core/tool_protocol.py`          | `BaseTool` + `ToolDefinition`         |
| `knorvia/core/capability_protocol.py`    | `BaseCapability` + `CapabilityManifest` |
| `knorvia/core/context.py`                | `UnifiedContext` dataclass            |
| `knorvia/tools/builtin/__init__.py`      | All built-in tool wrappers           |
| `knorvia/capabilities/`                  | Built-in capability implementations  |
| `knorvia/app.py`                         | `KnorviaApp` — Python SDK facade    |
| `knorvia_cli/main.py`                    | Typer CLI entry point                |
| `desktop/kernel-engine.js`               | Desktop Agent Runtime: knorvia-daemon |

## Dependency Layers

Public install paths and source extras are defined in `pyproject.toml`.
Requirements files mirror the same dependency groups for Docker/CI installs.

```
pip install knorvia      — Lightweight agent/CLI runtime
pip install "knorvia[app]" — Full browser/desktop product
pip install knorvia-cli  — CLI-only (LLM + RAG + providers + document parsing)
pip install -e .           — Source install for development

Source extras (.[ extra ], defined in pyproject.toml):
.[cli]            — Additional CLI provider integrations
.[rag]            — LlamaIndex + FAISS retrieval
.[documents]      — Office/PDF ingestion
.[media]          — Image/media primitives
.[app]            — Full browser/desktop product
.[server]         — Web/API server dependencies
.[partners]       — Partner channel SDKs + MCP client  (legacy alias: .[tutorbot])
.[matrix]         — Matrix channel for Partners (matrix-nio; needs libolm)
.[matrix-e2e]     — Matrix with end-to-end encryption (matrix-nio[e2e])
.[math-animator]  — Manim addon (powers `visualize` Manim renders + `knorvia run math_animator`)
.[dev]            — Test / lint tooling
.[all]            — Everything above
```
