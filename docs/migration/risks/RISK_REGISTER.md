# Risk register — Knorvia kernel cutover

Started: 2026-09-04 (GOV-002). Highest open risks first.

| ID | Risk | Status | Mitigation |
| --- | --- | --- | --- |
| R-001 | Uncommitted Office/Creative Library work in `D:\tools\Knorvia` | OPEN | Non-overlapping paths only. No reset/clean/stash/overwrite without owner handoff. Files listed in GOV-001. |
| R-002 | `D:\tools\knorvia-kernel` absent at inventory; clone depends on GitHub | OPEN | Full-history `git clone` of `openai/codex`. Failure must be captured; never fake with a zip. |
| R-003 | Pinned SHA `8e6a44b428e31f91b21edc97904fcdf4f0931ade` may not build on rustc 1.97 / Windows MSVC | OPEN | Record reproducible failure + ADR before any retarget. |
| R-004 | Official Codex is live on this machine (`~/.codex`, npm `codex` CLI) | OPEN | Coexistence tests watch both homes. Never default-read/write `.codex`. |
| R-005 | `just` not installed; `rustup` not on PATH | OPEN | Use `cargo` / `rustc` directly. Do not redirect `CARGO_HOME` to scratch. |
| R-006 | Default Python 3.13 cannot `import knorvia` | OPEN | Product is source-tree; do not casually `pip install` over user env. |
| R-007 | Headless Electron/pixel readback and macOS/Linux install gates may be unavailable | OPEN | Honest launch fallback; do not synthesize screenshots. |
| R-008 | Upstream ChatGPT/Codex OAuth client IDs are not a legal/commercial foundation | OPEN | ChatGPT login optional; Knorvia client identity only. |
| R-009 | Declaring the Goal complete after fork/daemon hello/mock slice | OPEN | Goal stays ACTIVE until cutover + deletion of old runtime. |

Closed risks are moved to the bottom with evidence pointers; they are not deleted.
