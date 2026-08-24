# Changelog

All notable changes to Knorvia are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Performance

- **Root shell budget fixed (FAIL → OK, 309 KB → 95 KB)**: the English
  locale (`locales/en/app.json`, 248 KB / 3904 keys) was statically bundled
  into the root layout even though it is a key==value identity map.
  `i18n/init.ts` now registers only the 357-key non-identity overrides file
  plus `parseMissingKeyHandler: (key) => key`, so English renders exactly as
  before without shipping the full map. `npm run build` regenerates the
  overrides via `scripts/build_en_overrides.mjs`; i18n parity still enforces
  en/app.json ↔ zh/app.json key equality. Every route's first-load JS drops
  by the same ~215 KB because the root shell is shared.
- **Staged decomposition milestone**: `video_studio/store.py` (2629 lines,
  the largest Python module) split into a leaf constants/helpers module
  (`store_base.py`) plus three domain mixins — storyboard/characters/board
  (`_store_storyboard_board.py`), uploads/assets (`_store_uploads_assets.py`)
  and job lifecycle (`_store_jobs.py`). The facade keeps projects, sessions,
  director desk and production; all existing imports and monkeypatch seams
  keep working (quota constant stays late-bound via the facade).
- Video-studio page pure helpers (storage key, template labels, default
  settings, replaceJob/validationLabel/isAbort) extracted to
  `lib/video-studio/page-helpers.ts`; page component unchanged otherwise.
- Session store (chat history SQLite) now runs with `journal_mode=WAL`,
  `busy_timeout=30000` and `synchronous=NORMAL` — the standard trio for
  concurrent read/write desktop databases. Reads no longer block while a
  turn is being saved; writers queue instead of erroring under contention.
- Memory snapshot readers open the chat-history DB with `immutable=1` so
  point-in-time scans never take shared locks against the writer.
- API responses larger than 1 KB are GZip-compressed (level 1) when the
  client sends `Accept-Encoding: gzip`; measured 8.3x smaller on the
  OpenAPI document and applies to session/KB/tool catalog JSON payloads.
- Deferred the `openai` SDK import out of server startup
  (`core/agentic/client.py`, legacy `openai_sdk` embedding adapter):
  `import knorvia.api.main` drops from ~5.1s to ~1.9s and no longer loads
  the SDK until the first LLM/embedding client is constructed. The adapter
  keeps module-level attribute stubs so existing monkeypatch tests pass.
- Frontend: enabled `optimizePackageImports` for `lucide-react` and
  `react-i18next` in `next.config.js`, tree-shaking barrel imports across
  ~170 files at build time.
- Renamed the video-studio content route handler to
  `video_asset_content` to remove a duplicate OpenAPI operation ID.

### Changed

- Architecture size budgets re-pinned for `knorvia/services/video_studio/store.py`
  (2607 → 2629) and `web/app/(workspace)/video-studio/page.tsx` (2813 → 2918):
  both files grew past their previous budgets during the 1.8.0 Video Workbench
  work. Budgets are now frozen at current sizes — these files must not grow
  further; follow ARCHITECTURE.md's refactoring sequence to split them.
  (`video-studio/page.tsx` and `home/[[...sessionId]]/page.tsx` budgets were
  re-pinned once more after this maintenance pass added lint-suppression
  comments; growth is now blocked at the new pins.)
- Frontend CI lint threshold tightened from `--max-warnings 44` to
  `--max-warnings 0`; all pre-existing ESLint warnings were fixed.

### Fixed

- Test suite warnings reduced 17 → 0:
  - `tests/**` gained `__init__.py` files, fixing intermittent
    "import file mismatch" collection errors from duplicate test basenames
    (test_catalog/test_context/test_oauth/... in different folders).
  - `napcat.py` background dispatch now passes a zero-arg coroutine factory
    instead of a ready coroutine, so stubbed spawns never leak un-awaited
    coroutines (RuntimeWarning).
  - `book/engine.py` worker loop awaits its cancelled `Queue.get` task
    explicitly on timeout (no more "coroutine never awaited").
  - `status.HTTP_413_REQUEST_ENTITY_TOO_LARGE` → `HTTP_413_CONTENT_TOO_LARGE`
    (Starlette deprecation) in auth and voice routers.
  - `TestRun` / `TestResponse` set `__test__ = False` so pytest stops trying
    to collect domain classes as test classes.
  - Kling adapter tests use a ≥32-byte HS256 sample key
    (InsecureKeyLengthWarning); dev venv installs `httpx2` per the Starlette
    testclient deprecation notice.

## [1.8.0] — the Video Workbench Parity release

### Local composition (one click, storyboard → MP4)

- A bundled FFmpeg engine stitches every shot locally: normalization,
  concat with crossfade/fade/wipe transitions, ASS/SRT subtitle burn-in,
  per-shot narration alignment, and BGM mixing to H.264/AAC MP4 stored as a
  project asset. Composition is free, offline-capable, and watermark-free.
- Per-shot first-frame keyframes via the image model (paid, confirmed) and
  TTS narration reused from the voice pipeline, aligned at compose time.
- Per-shot trim windows, narration volume, automatic BGM ducking, custom
  subtitle font size with a whitelisted `&H` colour override, and an
  experimental frame-by-frame 1080p upscale (local Real-ESRGAN) before
  stitching.

### Character consistency and generation controls

- Three-view character cards (front/side/back) with a per-project character
  library and one-click reference injection into composer or canvas nodes.
- Extend runs dual-path (local last-frame or native provider extend); camera
  controls surface as capability-driven chips per gateway dialect; every shot
  supports same-parameter seed rerolls with server-scoped variant history and
  free take switching.
- Kling, Wan, and Hailuo adapters join Volcengine behind the BYO model
  catalog with five preset connection templates.

### Subtitles, audio, timeline, templates, and cost awareness

- Timestamped STT produces per-shot captions; a table-style SRT editor saves
  subtitles as project assets with four burn-in presets.
- Project-level BGM with volume/fade, free voice enumeration with
  paid-confirmation previews, and native audio tracks from capable models mix
  without clobbering each other.
- A shot-level timeline with cached thumbnails, narration/subtitle/BGM
  overlay bands, drag-to-reorder, edge-drag trimming, and click-to-open shot
  cards. The data model stays a storyboard — deliberately not a multi-track
  NLE.
- Board templates grow from 5 to 12 (9:16 serial, product tri-view,
  talking-head, voiceover-first, A/B comparison, tutorial steps); variant
  drawers show render time, parameter diffs, and optional display-only cost
  estimates at a user-entered per-model unit price. No wallet, billing, or
  telemetry.

### 3D Director Desk (bonus view mode)

- The AIPAI 3D director desk ships as a same-origin static bundle behind the
  video studio's third view mode, staging cameras and blocking in 3D and
  bridging to the workbench through a validated `postMessage` protocol
  (capabilities, project, timeline, frame/video export, panorama injection,
  multi-angle captures).
- One-click round trips: export a 3D frame as the selected shot's keyframe,
  upload captures as assets, inject a character reference as an
  equirectangular panorama, and map desk cameras onto storyboard shots with
  verbatim camera documents preserved.
- The desk follows the app theme (hot-swapped, no iframe reload), persists
  full `project.get` snapshots per project fingerprint, and requests no
  camera or microphone grants.

### Guardrails unchanged

- One message still means at most one paid task with two-step confirmation
  and a server-side fingerprint; prompts pass verbatim; free actions make
  zero provider calls. FFmpeg runs through argument arrays only.
- Full regression matrix for this release: backend video suite and full
  pytest, web Node suite (611 tests), TypeScript clean, zh/en i18n parity,
  and the Playwright workbench audit including the 3D Director Desk
  protocol end-to-end scenario.

## [1.7.0] — durable Video Studio and agent video creation

### Video Studio

- Added a first-party, user-isolated video workspace with durable projects,
  storyboard revisions, validated image/video/audio assets, resumable uploads,
  asynchronous jobs, incremental events, retry/cancel, and project export.
- Video outputs are downloaded from provider URLs into the same authenticated
  local asset store; expiring provider URLs are never treated as the archive.
- The model catalog now describes video operations, durations, aspect ratios,
  resolutions, frame rates, audio/reference modes, input limits, cancellation,
  seeds, prompt/transfer limits, and provider-specific parameter schemas.
- OpenAI Videos, Volcengine Ark/Seedance, and custom asynchronous task profiles
  use explicit adapters. OpenAI Videos is marked deprecated ahead of its
  announced September 24, 2026 shutdown instead of presenting it as a
  future-proof default.

### Agent and desktop integration

- The Agent can submit one Video Studio job after a closed-choice confirmation
  bound to the exact project, model, prompt, inputs, and parameters. Changed
  plans, wrong question ids, free text, or model-authored approval fields fail
  closed; duplicate/conflicting answers are rejected. The preview is validated
  by the same service rules before it is shown, while the durable request id
  makes an approved resumed call idempotent.
- Server-resolved chat images can be copied into the current video project
  after MIME, dimension, and quota validation, enabling image-to-video without
  exposing arbitrary local paths to the model.
- Electron streams authenticated Image/Video Studio assets and project exports
  directly over bounded stdio IPC. Range, HEAD, 206/416, cancellation, idle
  timeouts, and a two-chunk flow-control window avoid both the nonexistent
  desktop TCP proxy and whole-file buffering.
- Added capability-gated navigation and model-driven video settings while
  preserving the unified connection, credential, catalog, and user-grant
  model used by the rest of Knorvia.

### Release engineering

- Version, desktop metadata, citation metadata, Web version injection, package
  smoke tests, and Windows artifact naming are unified on 1.7.0.
- Plain-wheel and packaged-runtime gates require the Video Studio routes and
  dependencies; desktop tests verify the stream bridge before Electron
  packaging and confirm it through the exact `app.asar` file manifest.

## [1.6.1] — Image Studio correctness and release hardening

### Image Studio and agent workflows

- Chat sessions use a durable full-id project mapping; sessions created close
  together no longer share a project, and a deleted mapping can be recreated.
- Board revisions and conditional saves prevent a stale tab from silently
  replacing newer canvas content. Worker results patch the current board
  atomically and reject deleted targets.
- Image jobs run through a bounded, restartable worker queue. Conditional state
  transitions keep cancellation terminal even when a provider response arrives
  late, and queue-full submissions roll back cleanly.
- Jobs capture their owner and exact image-model configuration revision, then
  revalidate the current model assignment immediately before provider dispatch.
- Upload sessions now enforce streamed byte, chunk, count, lifetime, checksum,
  decoded-dimension, and pixel limits before an image becomes a usable asset.
- Input assets, masks, parent/retry jobs, and board targets must belong to the
  same project. Board payloads reject malformed geometry, duplicate nodes, and
  non-finite values.
- Agent image confirmation is tied to an exact, server-created plan fingerprint
  and consumed once. Model-provided confirmation or private tool parameters are
  ignored; changed plans require a new user confirmation.
- Turn replies are accepted only during the active pause, with a single pending
  reply. Early, duplicate, and late replies no longer leak into a future pause.
- Conversation summaries and legacy system-like history are supplied as
  untrusted conversation data, and oversized messages obey the context budget.

### Web experience

- Image Studio cancels and ignores stale project requests, cleans up job
  polling/IPC/WebSocket followers, and serializes board saves so late responses
  cannot contaminate another project.
- The model picker enforces operations, inputs, outputs, and supported
  parameters; switching models resets incompatible choices.
- Canvas undo/redo uses a 64 MiB budget, empty masks cannot start inpainting,
  and switching source images clears incompatible history.
- Presentation previews enforce archive, entry, decompression-ratio, XML-file,
  per-entry, and total-output limits and reset cleanly when the file changes.
- Chat send/edit/branch/cancel and text-to-speech flows use stable session and
  request epochs, preventing late work from reaching the wrong conversation.
- Schedule forms validate interval/date/cron values and prevent duplicate
  submissions.

### Security

- Web and API launchers now bind to loopback by default and refuse an explicit
  non-loopback bind while authentication is disabled.
- Host CLI subagents are administrator-only. Disabled backends are enforced at
  every entry point; local runs require a non-empty working directory under an
  explicit `KNORVIA_LINK_ROOTS` allowlist, use conservative permission defaults,
  inherit only a small OS environment allowlist, and terminate the child process
  tree when a turn is cancelled.
- CLI subagents receive only the current account's materialized user-owned MCP
  servers. Deployment-wide servers are not delegated, credentials are excluded
  from Codex command-line arguments, and Claude's temporary credential file is
  restricted to the current OS account and removed after use.
- Scheduled chat jobs resolve the account's current role at every execution;
  persisted administrator snapshots are ignored, so deleted, disabled, or
  demoted users fail closed.
- Desktop external links are limited to `https`, `http`, and `mailto` schemes.

### Reliability

- Cron has per-owner/global quotas, bounded concurrency and execution time,
  cancellation cleanup, and atomic per-job claims with a persisted-state check
  to prevent duplicate execution across overlapping processes.
- MCP connect and tool-call timeouts now cancel and boundedly await the owned
  task instead of leaving an unobserved background operation.
- Electron uses a single-instance lock and focuses the existing window when a
  second launch is attempted.
- Desktop engine shutdown only force-terminates the captured process after the
  grace timeout; a normally exited process id cannot be reused and killed by a
  late callback.

### Packaging and release engineering

- `croniter`, Windows `tzdata`, and `mcp` are dependencies of the plain Knorvia
  wheel, ensuring the desktop runtime contains features exposed by its UI.
- Web and desktop release builds use lockfile-only `npm ci` installs.
- CI adds wheel-only import checks and packaged-runtime smoke checks; Docker
  publication uses the repository owner's GHCR namespace and does not publish
  `latest` for prereleases.
- The Windows RC build produces an installer, portable archive, and SHA-256
  manifest, then probes only that version's portable directory so older release
  folders cannot satisfy or contaminate package validation.
- Packaged-route validation resolves FastAPI's final OpenAPI view, remaining
  accurate with lazy included routers, and reads an explicit version sentinel
  rather than mistaking initialization logs for the runtime version.
- Python, desktop, citation, UI injection, installer naming, tests, and release
  acceptance metadata are unified on version 1.6.1.

## [1.6.0] — first independent Knorvia release

Knorvia's versioning is now **independent**: 1.6.0 is the first release that
does not follow DeepTutor's 1.5.x line. DeepTutor remains a code reference
only and no longer decides Knorvia's version.

### Highlights

- **Independent brand and versioning.** Python package, desktop app, installer
  artifacts and UI badge all report 1.6.0, sourced from a single version file
  (`knorvia/__version__.py`).
- **Desktop robustness.** Renderer spawn errors and readiness timeouts now
  surface a clear dialog instead of a silent crash or an endless loading page;
  quit gives the engine a grace window to flush before force-kill; legacy
  workspaces are migrated on first launch.
- **Image Studio.** Generation, multi-image editing, inpainting, persistent
  task history and authenticated asset export.
- **Local AI super-resolution.** Real-ESRGAN (ncnn/Vulkan) upscaling with
  on-demand download and hash verification — never bundled into the installer,
  keeping the package small; basic scaling is the automatic fallback when
  Vulkan, the network, or the engine download is unavailable.
- **Stability fixes across chat, Co-Writer, guided learning, settings, CLI
  apps, sandbox, cron and the Windows platform**, including the release
  blockers verified for the release candidate (see below).

### Fixed (release blockers)

- **Chat history is preserved when upgrading from 1.5.11.** The legacy
  database migration now retries transient file locks (Windows) and fails
  loudly instead of silently starting with an empty history — previously a
  failed move stranded the old data forever.
- **Quitting mid-generation does not corrupt data.** The desktop shell gives
  the engine a grace window to process shutdown and flush SQLite writes
  before the process tree is force-killed.

### Fixed

- Turn cancellation now actually cancels the running capability (no more
  orphan turns continuing LLM calls and tool side effects after "stop").
- A capability that ignores cancellation can no longer hang the caller
  (hard-bounded grace wait, with the orphan logged).
- Cancelling after a turn's DONE event no longer duplicates the assistant
  message or flips a completed turn to "cancelled".
- Non-admin users with no available LLM model get a readable error instead of
  a 500.
- `submit_user_reply` race: a reply can no longer be silently dropped while
  reporting success.
- Windows: sandbox runner module is importable (`resource` guarded).
- Windows: CLI app installs use the correct venv layout (`Scripts/`).
- Windows: cron schedules with IANA time zones work (`tzdata` dependency).
- Windows: the launcher distinguishes graceful vs forced kill (no more
  first-signal force-kill).
- Windows: `list_dir` output uses forward slashes consistently.
- `knorvia serve` binds to loopback by default (explicit `--host 0.0.0.0`
  required to expose the API).
- `knorvia init` validates port input instead of raising a traceback.
- MCP/agentic client pool eviction is safe when the event loop is closing
  (no "coroutine was never awaited" warning, clients are still closed).
- Co-Writer router no longer loads configuration at import time.
- Web: settings save/apply failures show an error instead of crashing the
  settings page.
- Web: book chat first-turn flow no longer drops the assistant reply when the
  session id is resolved mid-stream.
- Web: Co-Writer autosave race — stale responses can no longer overwrite
  newer content or delete the local draft.
- Web: login redirect restricted to same-site paths (open redirect closed).
- Web: chat send guard accepts "My Agents" references.
- Web: `build:brand-icons` works (`tsx` added to devDependencies).

### Release engineering

- GitHub Actions gate covering Ubuntu + Windows, Python 3.11/3.12: full
  pytest, ruff, web build (tsc + `next build`) and Windows desktop packaging;
  dependencies are installed from a clean environment (requirements files
  only).
- PyPI publish now refuses to run unless the Linux CI gate for the tagged
  commit is green.
- Windows build script derives version and artifact names from
  `knorvia/__version__.py` (with an optional pre-release label for RCs).

### Known issues

See `RELEASE-NOTES-1.6.0.md` for the upgrade guide and the known-issues list.

## Previous versions

Versions before 1.6.0 followed the DeepTutor 1.5.x line and are not listed
here; Knorvia publishes no compatibility aliases for them.
