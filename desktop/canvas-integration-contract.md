# Canvas integration contract — 2026-09-10

User: integrate inspiration from 大雄 Infinite-Canvas into the Knorvia Agent. Keep the original studio, add an optional canvas there and in the thread's right panel. No new primary navigation, no new Agent execution loop, no login or paid-provider tests. Reference: https://github.com/hero8152/Infinite-Canvas ; upstream LICENSE restricts commercial reuse. Independently implement the interaction with React Flow (MIT); do not copy upstream source, assets or shaders. Existing Jobs, media profiles, immutable references and studio MCP remain the owners of execution.

## Shared wire types

Authoritative frontend contract is `web/lib/native-canvas.ts`. Backend returns a CanvasDocument directly for create/read/save and `{ canvases: CanvasSummary[] }` for list. Generated node job fields are server-owned and only hydrated on reads; arbitrary saves cannot replace or erase a job. The graph has at most 80 nodes and 200 directed edges, no dangling endpoints, duplicate edges, self edges or cycles. Validate finite coordinates, unique IDs, bounded strings, role and kind. Reject invalid data instead of silently losing it.

## RPC

- `studio/canvas/list`: optional threadId filter, return `{ canvases }`.
- `studio/canvas/create`: title, optional threadId/globalPrompt/nodes/edges/idempotencyKey; return document. Empty creation is valid.
- `studio/canvas/read`: id; return document with current job data.
- `studio/canvas/save`: id, revision, title, globalPrompt, nodes, edges; CAS against revision. Preserve runtime fields. Stale edits return conflict. Never overwrite another client silently.
- `studio/canvas/generate`: id, revision, nodeId, idempotencyKey; return `{ canvas, job }`. Explicit invocation only. Save a durable generation intent before submitting and reuse its arguments/key for retry after process restart. Never repeat provider side effects on retry or uncertainty. Preserve intent if create throws; a new unrelated key must not silently bypass unresolved work. Running nodes cannot be regenerated or removed while pending.

Canvas documents live in the personal library as `画布/<uuid>.knorvia-canvas.json`, using its real versioned writes and cross-instance CAS. No credentials or media base64 in graph JSON. Validate ID/path boundaries and document byte limits; preserve old versions. Only generate image/video nodes. Compose global prompt + incoming text context nodes (including transitive text ancestry) + own prompt. `reference` edges supply pinned image references; `firstFrame`/`lastFrame` supply distinct image references. Completed image output can be stored through `studio/library` and used downstream. Completed video connected as firstFrame means `studio/frame/export` of the actual displayed last frame. Unfinished/missing/unsupported upstream input fails before provider submission; do not silently drop it. Existing model inputCapabilities and Agent-enabled rules apply. Drawing/saving connections never auto-generates.

## Agent / CLI

Expose one `media_canvas` tool (list/create/read/save/generate) through the existing `studio-mcp.js` TOOLS + callMediaTool. External creative CLI discovers the same tool automatically. Tool description must direct read-before-edit, revision CAS, pinned references, no resubmitting uncertain jobs, and no generation without user intent. Agent requests must call canvas.generate with the server-enforced agentEnabled flag. CLI can use tool call. Do not expose generic arbitrary RPC.

## Ownership

- Main agent: this contract, web/lib/native-canvas.ts, Canvas UI/CSS, StudioView/TaskPanel/TaskComposer integration, dependency manifests, docs and full acceptance.
- Antigravity implementation (after explicit next assignment): desktop/studio-canvas.js, desktop/media-studio.js wiring, desktop/studio-mcp.js tool wiring, desktop/tests/studio-canvas.test.js and necessary existing studio-mcp assertions. No other files without handoff.
- Grok implementation (after explicit next assignment): web/lib/native-canvas-graph.ts, web/tests/native-canvas-graph.test.ts. Pure graph UI helpers (cycle checks, edges, stable auto-layout) only; no frontend component or backend edits.

## Acceptance

Use real personal-library operations with isolated temporary data, existing media service and local provider fixture. Verify two-client edit conflicts, graph validation, file refresh/restart, pinned reference propagation, prompt composition, duplicate generate retries, late save/runtime protections, unsupported inputs, failed upstream and Agent-disabled providers. Main agent will check actual Kernel MCP execution and Chrome UI drag/connect/edit/save/reload/generate. No claim of paid-provider compatibility from fixtures.
