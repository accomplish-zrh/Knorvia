# Changelog

All notable changes to Knorvia are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Native workbench update — 2026-09-09

- Publish the current Knorvia Rust runtime under `native/knorvia-rs`, with the
  exact upstream App Server baseline and reproducible source-build instructions.
- Consolidate the native conversation/project workbench, scoped right panel,
  terminal, SSH, Git/worktrees, approvals and turn notifications.
- Add the personal library, editable previews, image/video creation with pinned
  references and first/last frames, sequential shots and tail-frame continuity.
- Include optional composition, subtitle, article-video, Remotion and media CLI
  workflows; the ordinary image/video studio remains available.
- Include Bot roles, direct/group rooms and persistent conversation bindings;
  provider profiles, reasoning controls, usage/cache accounting, memory,
  extension compatibility and bundled learning/creation skills.
- Refine desktop settings, themes, acrylic/background controls, startup and tool
  activity presentation, responsive layouts and reduced-motion behavior.
- Rebuild the product website around an original interactive Three.js brand
  sculpture, material/lighting controls, scroll-pinned real product screens,
  keyboard-operable previews and graceful non-WebGL/non-JavaScript fallbacks.
- Correct integration-test synchronization: await media finalization and usage
  ledger writes after model-turn completion, and continue waiting when a child
  wait call times out. Explicit child cancellation is verified durably while its
  peer finishes. Status/count/token and no-late-write checks remain strict.

The source version is 1.1.0 development. This source update does not publish a
new stable installer or change the public v1.0.0 release assets.

Verification for this snapshot on Windows: 821 web tests, 359 desktop tests,
271 Rust tests and 55 scoped Python tests passed, along with TypeScript and
the production web build. Desktop reported 12 skips; Rust reported four
explicitly gated/manual checks. Model integrations used local fixtures, not
paid live providers. The deployed product site passed 14 Chrome acceptance
categories covering interaction, responsive layout and graceful fallbacks.

### Added
- **AI Classroom lesson editing (T4)**: generated lessons are editable via
  minimal atomic ops (OpenMAIC patch/edit_deck discipline) —
  `set` (whitelisted fields incl. sanitized `html`), `str_replace`
  (exact-match, ambiguous hits rejected), `retitle`, `insert_blank`
  (scenes + outlines shift together), `delete_scene`, `reorder` (full
  id permutation required), `quiz_edit` (server revalidates types,
  options, answer indexes, short-answer rubrics). `apply_ops` clones →
  applies → validates → hands back; any failure raises with the offending
  op index and nothing is written (`version` bumps only on success, scene
  and question ids stay stable). `PATCH /api/v1/classroom/{id}` (admin)
  returns 409 with the op reason or the updated document; `GET
  ?revision=N` answers lite when unchanged. The store gained a locked
  `save_edit` read-modify-write transaction (concurrent edits cannot
  clobber). The player gains an edit toggle rendering the new
  `ClassroomEditor` (rename/objective/key points/narration, quiz editor,
  widget-HTML source with a client-side safety preview, per-page
  move/insert/delete) — every save is one PATCH op list, and the player
  refreshes from the response document (21 new tests in
  `tests/services/classroom/test_classroom_edit.py`).
- **AI Classroom interactive scenes (T3)**: a fourth scene type —
  self-contained HTML widgets rendered in a sandboxed iframe
  (`sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`, no
  `allow-same-origin`). Two widget kinds: `simulation` (real draggable
  inputs bound to `key_variables` with a live canvas/SVG redraw) and
  `diagram` (`flow`/`hierarchy`, clickable nodes highlight their path).
  Outlines must carry a structured `WidgetOutline` (validated at outline
  time through the T1 checker; `MAX_INTERACTIVE_SCENES=2`, consecutive
  interactive banned for hands-on, whose `allowed_types` now include
  `interactive`). A deterministic regex safety gate (`sanitize.py`)
  strips `fetch(`/XHR/WebSocket/`import(`/`window.top`/`window.parent`/
  `localStorage`/`<form action>` in place; document-tier hits
  (`<script src>`, nested `srcdoc`, `javascript:` URIs) degrade the whole
  scene to a slide (title/key_points kept, `scene_degraded` event, lesson
  continues). Player gains the interactive card (concept strip + iframe +
  narration points); widget context joins discussions and notebook export.
  Legacy lessons read back unchanged (26 new tests in
  `tests/services/classroom/test_classroom_interactive.py`).
- **AI Classroom durable generation jobs (T2)**: `POST /api/v1/classroom/generate`
  now returns `{job_id}` immediately and the lesson keeps generating in a
  request-independent background task — closing the tab, refreshing or even a
  client crash never aborts a class. Every protocol event is appended to
  `data/classrooms/_jobs/{job_id}.json` (atomic tmp+replace; payload stores
  names/references only, never KB text). New `GET /jobs/{id}` snapshot and
  `GET /jobs/{id}/events` SSE (replay the full history, then follow live,
  close on terminal). The frontend holds the job_id, reconnects via
  snapshot-then-stream with retries, and the list page shows a 「生成中…
  点击查看」 recovery bar for unfinished jobs (localStorage-tracked). On
  process startup leftover running jobs are honestly marked
  `failed("interrupted by restart")`; `store.list()` provably ignores
  `_jobs` (13 new tests in `tests/services/classroom/test_classroom_jobs.py`).
- **AI Classroom teaching styles (OpenMAIC-inspired skill packs)**: the
  generation form gains a card-style style picker — 「大师讲授 / 动手实验 /
  讲义速览」 plus the previous default behavior. Each style ships a Chinese
  pedagogy directive injected into the outline prompt and a machine-checkable
  `OutlineConstraints` contract (scene-count bounds, allowed types, opening
  type, quiz/discussion budgets, `no_consecutive_types`, slide-ratio floor)
  enforced by a deterministic validator (`styles/verify.py`): violating
  outlines get one diagnostic re-plan, then a delete-only deterministic
  repair (over-budget quiz/discussion degrade to slide keeping title/points,
  surplus tail truncates, opening type swapped in) with an
  `outline_repaired` SSE progress event — never a hard failure. New readonly
  `GET /api/v1/classroom/styles`, `style_id` persisted on the document and
  shown as a player-header badge; zh/en copy included (21 new tests in
  `tests/services/classroom/test_classroom_styles.py`).
- **Desktop self-update check**: the Electron shell now polls
  `releases/latest` on the public GitHub repo (start + every 24 h, plus a
  manual 「检查更新…」 tray item and `knorviaDesktop.update.check()` IPC).
  Semver compare → native dialog offers 现在更新 / 稍后提醒 / 跳过此版本
  (skips are suppressed for 7 days in `update-state.json`). Pure logic in
  `desktop/update-check.js` with 10 unit tests; automatic checks never
  nag on network errors. Release line bumped to `1.1.0-dev` so the next
  build can't collide with the shipped `v1.0.0` assets.

### Changed
- **GitHub deployment (2026-09-02)**: repo gains a `origin` remote and is
  published for auto-update pulls. Pre-publish gates all green (pytest
  4552 passed / 43 skipped, ruff, eslint, i18n parity, tsc, route budgets,
  architecture guard). Size-guard pins raised for turn_runtime (2350),
  co-writer page (2580), home shell (2410). `scripts/_apply_v100_*`,
  `scripts/_peek.py`, `scripts/_retry_nsis*` and `release-pack/` are now
  gitignored (one-shot migration scripts / packaging scratch). Setup.exe +
  portable.zip + SHA256SUMS ship as GitHub Release assets, rebuilt from the
  tagged commit.

### Fixed
- `ShortcutCheatsheet` leaked a literal `Esc` into JSX (eslint
  `i18n/no-literal-ui-text`); wrapped in `t()` (词条 both locales 已有)。
- Import ordering in new v1.0.0 modules (ruff I001 ×20, auto-fixed).

### Added

- **Hermes-style group rooms**: after you speak, a room runs up to three
  serial rounds. @named members answer (everyone, when nobody is named);
  a member may pass (`PASS` / `[SILENT]`) or pull a teammate with `@Name`.
  `@user` raises a **Needs you** badge on the roster. Hard caps: 10 spoken
  replies per send, 3 rounds. IM group channels can *observe* unmentioned
  chatter without dispatching a turn (`observe_unmentioned_group_messages`
  on Telegram/Discord); a `[SILENT]` final reply is kept off the wire.

## [1.0.0] — glass mark, classroom, and stabilization

### Added
- **Local chat UX**: truncated replies offer 「继续写」 on the same assistant bubble; 502/timeout auto-retries twice before the existing Retry button; already-loaded Ollama (`:11434`) and LM Studio (`:1234`) models appear in the top-bar switcher (no download/store); `?` opens a shortcut cheatsheet, plus Ctrl+N new chat, Esc stop generation, and Ctrl+R retry (Ctrl+K unchanged).

- **Library offline conversion toolbox (flyingmouse-format inspired)** —
  design ideas absorbed from LaoFeng's FlyingMouse Format (non-commercial
  license; ideas only, no code reused — see THIRD_PARTY_NOTICES.md):
  capability discovery per file ("what can this become?"), an engine
  resolution chain (`KNORVIA_<NAME>_PATH` env → managed `data/engines/` →
  system PATH), and quality-aware conversion (alpha-channel flattening
  before yuv encoding). The `library` chat tool gains a `convert_id`
  action — agents can now convert uploaded images (png/jpg/webp), PDFs
  (→ text / page PNG via PyMuPDF), and audio/video (FFmpeg: mp3/wav/ogg/
  m4a/mp4/webm) by themselves; results land as new library entries. HTTP
  surface: `GET/POST /api/v1/library/assets/{id}/convert-targets|convert`.

- **AI Classroom organically wired into Knorvia's own organs**: generation
  can ground lessons in a selected knowledge base (RAG retrieval feeding the
  outline stage), saved Personas seat as the classmate agents, graded wrong
  answers push into the 题库 question bank (SQLite notebook entries under a
  stable `classroom:{id}` session), and the whole lesson exports to a
  Notebook ("AI 课堂") as markdown cards.

- **AI Classroom (learning space)** — an OpenMAIC-inspired interactive
  lesson generator and player (MIT, © 2026 THU-MAIC; see
  THIRD_PARTY_NOTICES.md): one topic produces a full micro-lesson via
  three-stage generation (reviewable outline → scene content → action
  timeline, with the quiz/discussion resource budget), played back as a
  deterministic scene timeline (AI teacher + AI classmates with
  length-derived speech beats), interactive two-tier-graded quizzes
  (objective auto-graded, short answers via LLM, results feed the
  discussion), and per-scene live discussions driven by a stateless
  director router (unanswered-learner-question escalates to the teacher,
  no repeat speakers, client-held state, abort-safe). Surfaces:
  `knorvia/services/classroom/`, `/api/v1/classroom`, 学习空间 → AI 课堂.

### Security

- **Dependency security sweep**:
  - `python-jose` → `pyjwt[crypto]`: token signing/verification migrated in
    `knorvia/services/auth.py`; `python-jose` and its vulnerable `ecdsa`
    transitive are gone from the tree, and CI no longer ignores
    PYSEC-2026-1325 (the 2026-10-01 exception is resolved early).
  - ExcelJS's vulnerable `uuid` (GHSA-w5hq-g745-h8pq): scoped npm `overrides`
    pins `exceljs`'s uuid to `^11.1.1`; `npm audit --omit=dev` reports zero
    findings (the 2026-10-01 exception is resolved early).
  - RAG stack: `rag-lightrag` now floors `lightrag-hku` at `1.5.6` (with
    `raganything>=1.3.1`); compat verified against our adapter surface.
  - `liteparse` pinned exactly to `2.14.2` (Windows CPython 3.12 wheels;
    2.13.0 had none). `pyarrow` 22.x (PYSEC-2026-113, via graphrag 3.x which
    caps `pyarrow<23`) is the one open, documented time-bounded exception in
    SECURITY.md, expiring 2027-01-01.

### Changed

- **App icon**: the book-and-K mark is replaced by a glass folded-K
  squircle everywhere the product identity shows — desktop installer /
  window / tray (`desktop/build/icon.ico`, `logo.png`), web logo and
  favicons (`web/public/logo.png`, `logo_black.png`, `favicon-16x16.png`,
  `favicon-32x32.png`, `favicon.ico`, `apple-touch-icon.png`, `banner.png`),
  and the source brand set under `assets/figs/logo/`.
- **Boot splash v4**: the entrance animation is restaged around the glass
  mark — mint/lavender aura, squircle hairline, one diagonal sheen —
  kept in lockstep between `web/components/common/BootSplash.tsx` and
  the desktop loading page.
- **UI chrome polish**: a shared `BrandMark` (hairline ring so the glass
  plate reads on cream and dark rails) on the sidebar, mobile bar, empty
  chat, session load, login and register; quieter mint/lavender auth
  wash; command palette / confirm dialogs share the 20px card radius;
  buttons gain a focus ring; selection tint follows the mark.
- **Version discipline**: the tree ships as `1.0.0`. Interim work after
  this cut uses `1.1.0-dev` so installers never reuse a shipped name
  (see `docs/MAINTENANCE.md`).

### Added

- **Partner inference router (grok-bot parity)**: a partner's config gains a
  `routing` block — the product LLM pipeline (default) or a local agent CLI
  (Claude Code / Codex / Gemini CLI / …) driven through the subagent registry
  with the partner's Soul injected as the CLI system prompt and per-(partner,
  session, backend) session continuity. Router failures fall back to the LLM
  path and surface "Router error: …" in-band. Configured from the partner
  Configure tab or the new-partner wizard (Router section); `/status` shows
  the active route; invalid kinds 422 at the API and degrade to `llm` on disk.
- **Per-partner usage ledger**: every completed turn appends a row to
  `data/partners/{id}/usage.jsonl` (turns, prompt/completion/total tokens,
  estimated cost from the pricing table for LLM turns; one request row for
  CLI-routed turns). `GET /api/v1/partners/{id}/usage?days=N` folds it into
  totals + per-day + per-backend, shown in the Configure tab's Usage panel.
- **Message reactions**: session records gain a stable `message_id` and an
  emoji-reaction sidecar (`sessions/_reactions.json`, follows archives).
  `POST /api/v1/partners/{id}/history/reaction` toggles idempotently; the
  history API merges reactions; the partner chat renders hover reactions with
  optimistic toggling.
- **Real /stop + typing indicators**: `/stop` (IM) and the web stop button
  now cancel the in-flight turn through one shared per-session turn map —
  the user message is kept, no half answer is persisted, and the channel is
  told. Channels gain a `set_typing(chat_id, active)` contract (Telegram and
  Discord drive their native typing indicators; `send_typing` per-channel
  flag), and the web chat shows typing dots until the first streamed token.

### Performance

- **Desktop wallpaper + frost as separate layers**: a 16:9 campus photo sits
  under the real chrome; frosted panels stay the existing window-frost
  switch. Built-in presets, custom PNG/JPG/WebP upload, and restore-original
  live in Appearance. Default is wallpaper off.

### Performance

- **Session listing no longer scans every message per poll**: the sidebar /
  dashboard / history summary query replaced its `LEFT JOIN messages … GROUP BY`
  materialisation with a correlated scalar count over `idx_messages_session_created`,
  so cost scales with the *page* rather than the whole transcript table.
- **SQLite reads stop queueing behind writes**: pure read paths (session get/
  list/search/export, message fetch, turn events, message path) bypass the
  store-wide asyncio lock — WAL plus a fresh connection per call already keep
  them correct, and one long turn-write no longer stalls history/dashboard
  polls from every session.
- **Runtime settings & model catalog are mtime-cached**: hot paths (every chat
  turn's language/model/tool resolution, admin settings polls, attachment
  limits) re-read + re-normalized those JSON files several times per request;
  a stat-guarded memo now serves them without disk hits, invalidated by any
  write, returning deep copies so caller-mutation semantics are unchanged.
  Missing/empty settings files also no longer rewrite defaults on *every*
  read.
- **Chat streaming renders O(n) not O(n²)**: pairing assistant rows with their
  user message does one forward pass instead of copy+reverse+find per row; WS
  event dedupe compares a bounded recent tail instead of the whole turn; the
  subagent-tab watcher re-opens panels only when a group's event count grew;
  viewer/reader panels get stable callbacks so their `memo` works; the
  save-to-notebook transcript mapping only runs while that modal is open.
- **Long transcripts render in windows**: ChatMessageList mounts the newest 80
  rows with "Show earlier messages" prepending one window per click instead of
  mounting every trace panel/KaTeX/Mermaid row at once.
- **API reads default to `cache: no-store`** in `apiFetch` for GET/HEAD —
  endpoints whose wrapper forgot it were serving stale JSON from the browser's
  heuristic cache after cross-page mutations.
- Smaller: tab-refocus refreshes coalesce within 5 s (was issuing duplicated
  KB/tools GETs); DirectorDesk timeline polling pauses on hidden tabs and skips
  identical payloads; Image Studio multi-file uploads run 3-at-a-time; the cron
  run journal keeps an in-memory line counter instead of recounting its file
  after each append; `npm run dev` now regenerates `app.overrides.json` like
  builds do; singletons (`get_sqlite_session_store`, cron service) guard lazy
  init behind a lock; dashboard `limit` is bounded (`1..200`).

### Added

- **Desktop wallpaper skin**: Appearance can set a campus photo (or an
  uploaded PNG/JPG/WebP) as the app background. Frosted glass stays an
  independent control and sits on top of the picture; clearing the
  wallpaper restores the original solid canvas. Custom files stay in
  desktop userData, not the repository.
- **Automation hub** (`/settings/schedule`, relabelled 定时任务 → 自动化):
  the page now has three tabs — 已配置 (configured tasks), 执行历史
  (aggregated run history with status/duration/error) and 任务模板
  (a built-in catalog of eight curated automations: daily AI news brief,
  brand sentiment weekly, competitor watch, stock monitor, security scan,
  commit bug hunt, test backfill, change digest). Templates are served by
  `GET /api/v1/cron/templates?language=zh|en` from the new catalog module
  `knorvia/services/cron/templates.py`; applying one prefills the create
  form (never bypassing `CronService` validation/quotas), and a hover
  action sends the template straight to the chat agent instead. Tasks can
  be edited in place (name/message/schedule/conversation via the existing
  PATCH endpoint). Run history merges per-job `run_history` with the new
  cross-job journal (append-only `jobs.runs.jsonl`, capped at 500 entries)
  exposed at `GET /api/v1/cron/jobs/runs`, so runs stay visible after a
  task is deleted or finishes as a one-shot. Schedule descriptions are
  humanized per locale ("Weekdays at 09:00" / "工作日 09:00"), run statuses
  and timestamps follow the UI language, and live data re-syncs on window
  focus or tab switch. "在对话中创建" stashes a starter sentence in
  sessionStorage and opens chat with it prefilled via the new
  `web/lib/composer-draft.ts` handoff — the agent schedules it with its
  existing cron tool.
- **Desktop window chrome**: the Electron shell no longer uses a separate
  Win32 caption bar. Content owns the surface to the top edge; Windows 11
  min/max/close overlay the client area; the sidebar header and a titlebar
  slot are the drag regions.
- **Restored desktop windows use 16px corners** via `SetWindowRgn` so
  maximize/restore stay native (a layered HWND cannot unmaximize).
  Maximized and fullscreen stay square. Picker dialogs clip to their
  own radius instead of filling a sharp wrapper rectangle.
- **Frosted dialogs and search fields keep their CSS radius** on Windows.
  The dialog role wrapper is no longer filled as a sharp rectangle behind
  rounded picker cards. Native textareas drop the Win32 Edit fill (the
  white rectangle inside the composer) by using a zero-alpha background
  instead of the `transparent` keyword.
- **Window frost is independent of colour theme**: Appearance now has a
  Frosted glass switch plus See-through and Panels sliders. Any palette
  (Default, Cream, Dark, Glass) can enable live Windows acrylic / macOS
  vibrancy. See-through controls how much of the desktop and other apps
  shows through the canvas; Panels keeps cards, dialogs and the composer
  solid enough to read. Existing Glass-theme users keep frost on. Glass
  itself is now just a cool mist palette.

- **Fine-grained UX pass** (third sweep, GitHub parity details):
  - Code blocks in AI answers gained a copy button with copied-state
    feedback (`RichCodeBlock` header, all markdown surfaces).
  - Main sidebar session rows now expose pin/unpin, archive/unarchive and
    Markdown export (previously only the history picker had them); pinned
    sessions sort first via the backend.
  - Offline banner across the app shell when `navigator.onLine` flips false
    (the chat page previously only toasted on a failed stream).
  - KB URL import: `POST /knowledge/{kb}/import-url` fetches a page,
    converts HTML to Markdown (zero-dependency converter) and reuses the
    standard upload-processing task for indexing; status flows unchanged.
  - Image Studio batch download of visible results with sequential browser
    downloads (favorites filter respected).
- **Session management suite** (sidebar upgrade, inspired by Open WebUI):
  - Full-history search: SQLite FTS5 index over every message (trigger-synced,
    rebuilt on startup) with `GET /api/v1/sessions/search?q=` returning ranked
    session hits + highlighted snippets; title-substring fallback included.
    The sidebar switches from client-side filtering to this deep search as
    soon as the query reaches two characters.
  - Pinned sessions: `pinned` column, PATCH support, pinned-first ordering.
  - Archived sessions: `archived_at` column; default list hides them,
    `?include_archived=true` reveals them, search still finds them.
  - Transcript export: `GET /api/v1/sessions/{id}/export?format=md|json`
    returns Markdown (human-readable) or JSON (lossless); the sidebar row
    menu gains a one-click Markdown download.
  - Store/router covered by tests/services/session/test_session_management.py
    (9 cases: pinning order, archive visibility, FTS snippets, literal-query
    safety, export completeness).

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
