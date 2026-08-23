# Knorvia 1.8.0 — Release Notes

Target: the Video Workbench Parity release — Phases A–F of
`docs/VIDEO-WORKBENCH-PARITY-ROADMAP.md`, all delivered on top of the 1.7.0
Video Studio foundation.

Knorvia 1.8.0 takes the video studio from a "single-shot workbench" to a
complete "mainstream video workbench" experience: plan → per-shot generation →
narration → subtitles → a locally composed, watermark-free MP4, plus the
timeline, template, variant, and cost-awareness refinements that mainstream
editors treat as table stakes. Everything stays local-first and model-neutral;
no wallet, no subscription, no telemetry.

Existing 1.7.0 artifacts remain separate and are not overwritten by this
release line. Final installer/portable archives for 1.8.0 are built from the
frozen 1.8.0 source and must pass the package acceptance script before
publication.

## Highlights

### One-click local composition: storyboard → finished MP4 (Phase A)

- A bundled FFmpeg engine (one-time ~80 MB download or a system install)
  stitches every shot locally: normalization to target WxH/fps/SAR, concat
  with optional crossfades, ASS/SRT subtitle burn-in, and per-shot narration
  alignment with project BGM mixing, encoded to H.264/AAC MP4 and stored as a
  project asset. Composition is free, offline-capable, and watermark-free.
- Per-shot first-frame keyframes are generated through the image model with a
  two-step paid confirmation; per-shot TTS narration reuses the existing voice
  pipeline and is aligned automatically at compose time.
- The finished composition plays and downloads from the authenticated
  same-origin asset endpoint.

### Character consistency across shots (Phase B)

- Three-view character cards (front/side/back, paid generation with
  confirmation), a per-project character library, and one-click injection of
  character reference images into the composer or canvas generate nodes.

### Deeper generation controls (Phase C)

- Extend runs dual-path: a local last-frame method plus native provider extend
  where the gateway advertises it.
- Kling, Wan, and Hailuo adapters join Volcengine behind the existing
  BYO-profile model catalog, with five preset connection templates; the
  deprecated OpenAI Videos adapter keeps its shutdown guidance.
- Camera control surfaces as capability-driven chips per gateway dialect, and
  every shot supports paid same-parameter seed rerolls with a server-scoped
  variant history and free switching between takes.

### Subtitles and audio that ship with the cut (Phase D)

- Timestamped STT produces per-shot captions automatically; a table-style SRT
  editor saves subtitles as project assets, and burn-in supports four presets.
- Project-level BGM with volume and fade in/out, free voice enumeration with
  paid-confirmation previews, and native audio tracks from capable models are
  mixed into the composition without clobbering each other.

### Post-production polish (Phase E)

- Five cut styles: hard cut plus crossfade, fade-to-black, fade-to-white, and
  wipe-left transitions with a fixed 0.5 s overlap; total duration accounts
  for the overlaps.
- Per-shot trim windows (0 ≤ in < out ≤ duration) with storyboard and timeline
  entry points, per-shot narration volume, and automatic BGM ducking while a
  voiceover plays.
- Subtitle burn-in accepts a custom font size (12–72) and `&H` colour override
  behind a strict whitelist, so style strings can never inject filter
  arguments.
- An experimental export option upscales sub-1080p takes to 1080p frame by
  frame with the local Real-ESRGAN engine before stitching. It is clearly
  labeled experimental because frame-by-frame upscaling is slow; 4K remains a
  gateway capability.

### Timeline, variants, templates, and cost awareness (Phase F)

- A shot-level timeline renders every take as a thumbnail block (width
  proportional to duration) with ffmpeg-sampled cached thumbnails, overlay
  bands for narration/subtitles/BGM, drag-to-reorder, edge-drag trimming, a
  duration ruler, and click-to-open shot cards. The data model stays a
  storyboard — this is deliberately not a multi-track NLE.
- Each shot's variant history opens into a detail drawer showing every take's
  thumbnail, wall-clock render time, parameter diff against the current take,
  and a cost estimate when a unit price is configured.
- Built-in board templates grow from 5 to 12, including a 9:16 six-shot
  serial, product tri-view, talking-head, text-to-video voiceover-first,
  A/B comparison, and tutorial-step chains — identical on backend and web.
- Optional cost awareness without a wallet: users may enter a per-model ¥/s
  unit price in the model picker. When set, job cards, the compose panel, and
  variant rows display display-only estimates ("estimated ¥x.xx at your unit
  price"). Nothing is billed, tracked, or sent anywhere.

### 3D Director Desk: a third view mode for staging shots (bonus)

- The AIPAI 3D director desk ships as a same-origin static bundle behind the
  video studio's third view mode. It stages cameras and blocking in a 3D
  scene and talks to the workbench through a reverse-engineered
  `postMessage` protocol (capabilities, project, timeline, frame/video
  export, panorama injection, multi-angle captures).
- One-click round trips: export the current 3D frame and set it as the
  selected shot's keyframe, upload captures as project assets, inject a
  character reference as an equirectangular panorama backdrop, and map desk
  cameras onto storyboard shots (single shot or sync-all) with a tolerant
  field mapping that keeps the verbatim camera document.
- The desk follows the app theme (hot-swapped via the session message, no
  iframe reload), scopes each project to its own session id, and persists a
  full `project.get` snapshot to the backend whenever the project
  fingerprint changes, so a 3D layout survives reloads.
- Hardened by design: every inbound message is validated against both the
  iframe source window and the origin, the iframe requests no camera or
  microphone grants (the bundle contains zero `getUserMedia` call sites), and
  a stalled handshake surfaces an explicit reload affordance instead of
  hanging silently.

## Guardrails that did not move

- One message still means at most one paid task; every billable action keeps
  its two-step confirmation with a server-side fingerprint, prompts are passed
  verbatim, and free actions still make zero provider calls.
- FFmpeg runs entirely through argument arrays (`create_subprocess_exec`, no
  shell), subtitle style strings are whitelist-validated, and uploads keep
  MIME sniffing and SSRF checks.
- The full regression matrix for this release: backend video suite and full
  pytest run green, the web Node suite (600+ tests) green, TypeScript clean,
  zh/en i18n parity green, and the Playwright workbench audit green including
  the new Phase E/F scenarios and the end-to-end 3D Director Desk protocol
  audit.

## RC acceptance checklist

Automated release blockers:

- [x] Full Python suite passes on Ubuntu and Windows for Python 3.11 and 3.12.
- [x] Ruff lint/format, web Node tests, TypeScript, production web build, and
      i18n parity pass.
- [x] Plain-wheel installation imports the composition engine and exposes the
      thumbnail/composition routes outside the checkout.
- [x] Packaged runtime reports 1.8.0 and carries the 1.8.0 UI badge.
- [x] `Knorvia-1.8.0-setup.exe`, portable ZIP, and SHA-256 manifest agree.

Manual release blockers:

- [ ] Compose a three-shot film with a crossfade, burned subtitles, narration,
      BGM, and a trim window; verify the MP4 duration equals the storyboard
      math and plays in the packaged desktop.
- [ ] Toggle the experimental 1080p upscale on a 720p project and confirm the
      experimental labeling, completion, and honest failure when the
      upscaler is unavailable.
- [ ] Exercise timeline reorder, edge-trim, and click-to-shot on a touchpad;
      confirm the storyboard PATCH is debounced and conflict-safe.
- [ ] Create a project from each of the 12 board templates in a fresh
      workspace and generate one shot.
- [ ] Open the 3D Director Desk on a real project, wait for the Ready pill,
      export a frame to a shot keyframe, inject a character reference as a
      panorama, and confirm the desk reload affordance appears if the
      handshake stalls.
- [ ] Enter a per-model unit price, confirm estimates appear on job cards,
      the compose panel, and variant rows, and confirm clearing the price
      hides them again.
- [ ] Upgrade a real 1.7.0 workspace and confirm existing projects, boards,
      storyboards, assets, and jobs remain intact and openable.

## Known limitations

- The timeline is a shot-driven view, not a multi-track NLE: free-form track
  arrangement, keyframed effects, and frame-accurate ripple edits stay out of
  scope by design.
- Frame-by-frame upscaling is intentionally experimental and slow on CPU; 4K
  output depends on gateway model capability, not local processing.
- Object-level editing (insert/remove) and lip sync depend on closed-source
  model capabilities; the capability plumbing waits for open gateways.
- Cost figures are user-entered estimates only. Knorvia has no wallet,
  billing, or usage metering, and none is planned for this release line.

## Final artifacts (2026-08-17 root build)

- `Knorvia-1.8.0-setup.exe` — 288.9 MB —
  SHA-256 `A75765F863AD7FD5DED80EFFB9352DB7F65AD6AFD1D050CB0A92229E88339074`
- `Knorvia-1.8.0-portable.zip` — 380.2 MB —
  SHA-256 `EEE23CD2220212A31AA2EABF2A13D2CB4B8BC5C697705012F26A3854C09E124B`
- The packaged runtime acceptance (`scripts/release/check_package.py`)
  reports PACKAGE: ALL PASS: runtime and UI badge at 1.8.0, required API
  routes and adapters import from the wheel, the desktop stream bridge is in
  `app.asar`, no Real-ESRGAN engine files are bundled, and the SHA-256
  manifest matches both artifacts. The portable runtime carries the 73 MB
  same-origin 3D Director Desk static bundle.
