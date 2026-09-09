# Learning / creative CLI delivery — 2026-09-09

Files owned by this delivery:

- `creative-cli.js`, `creative-cli-service.js`, `creative-cli.README.md`: authenticated loopback discovery, external CLI attachment, instance-safe shutdown, command validation and startup readiness.
- `learning-pack.js`: durable revision/hash parity, pinned multi-chunk reads, explicit source-version validation, corrected mastery recomputation and duplicate-question rejection.
- `web/components/learning/LearningWorkspace.tsx`, `learning-workspace.css`, `web/app/workbench/learning/page.tsx`: native learning workspace for materials, outlines, tutoring tasks, practice and review. Uses the existing workbench RPC; no Python API or new execution loop.
- `tests/creative-cli.test.js`, `tests/learning-live-kernel.test.js`, `tests/creative-cli-gateway.test.js`: command/error/provenance coverage, real Kernel learning-tool execution through local Responses, independent-process CLI and native gateway parity.
- `tests/window-background-live.test.js`, `tests/fixtures/window-background-live.js`: actual Electron BrowserWindow running the shared window lifecycle helper, actual gateway/daemon/Kernel slow turn, independent CLI check while hidden, restored same thread, explicit shutdown cleanup.
- `tests/cli-bot-live.test.js`: real daemon + production CLI dispatch bridge + injected local Node process backend; separate first sessions across two rooms, same-room resume, durable completion retry without duplicate side effects/replies, bounded interruption and rejected late output. No installed production CLI is executed.

Verification performed:

- Combined CLI + Kernel learning + native gateway suite: 12 passed; the existing media test was initially environment-gated.
- Re-ran the environment-gated real daemon + FFmpeg media test with the local binaries: 1 passed.
- Actual Electron background-window acceptance: 1 passed. It uses a minimal fixture window with a durable thread reference, not the packaged product renderer.
- CLI Bot full-chain acceptance: 1 passed after finding and fixing a real interrupt mutex deadlock. The test now requires `room/interrupt` to return within 5 seconds. Final evidence is `work/non-login-followup-20260909/evidence/cli-bot-live.json` / `.log`; the original failed run is preserved separately as `cli-bot-live-cancel-deadlock.log` and `cli-bot-live-cancel-deadlock-invocations.jsonl`. Child runs: 4; successful child completions: 3; model requests: 0.
- Web TypeScript check `tsc --noEmit --incremental false`: passed after page changes.
- Installed Google Chrome via Playwright, real `/workbench/learning`, isolated gateway Home and local Responses: source selection → outline creation → reload → persisted lecture reopened passed; practice/review empty states verified. Screenshots at 1600 and 900 px have no horizontal overflow, and console/page errors are empty. Outline operations made zero model requests. Evidence: `work/non-login-followup-20260909/evidence/learning-chrome/report.json` and the two PNG files. Fixed an ambiguous material-select accessible label found during the first browser run.

All model traffic in these tests uses a local Responses fixture. Learning artifacts are versioned personal-library files; no claim is made that they have a separate Rust Artifact mirror. Final packaged-installer acceptance remains with the integrating owner.
