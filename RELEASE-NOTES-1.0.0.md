# Knorvia 1.0.0 — Release Notes

The current product line ships as **1.0.0**. Highlights below are unchanged
from the previous cut; only the version number was reset.

The installer, window, tray, web favicons, and in-app logo carry the glass
folded-K; the boot splash is restaged around that mark. Classroom, offline
conversion, partner routing, and a security sweep ride in the same cut.

Final installer/portable archives for 1.0.0 are built from this tree and
must pass the package acceptance script before publication.

## Highlights

### Glass folded-K mark

- New app icon (rounded glass plate, mint-to-lavender K) on the Windows
  installer, window, tray, web logo, favicons (`16`/`32`/`ico`), Apple
  touch icon, and brand banner.
- Boot splash v4: mint/lavender aura, squircle hairline, one diagonal sheen.
  Web `BootSplash` and the desktop loading page stay in lockstep.
- Shared `BrandMark` on sidebar, mobile bar, empty chat, session load,
  login and register, with a hairline ring so the plate reads on cream
  and dark rails.

### AI Classroom

- One topic produces a micro-lesson (outline → scene content → action
  timeline) played back as a deterministic teacher + classmate timeline,
  with graded quizzes and per-scene live discussion.
- Lessons can ground in a knowledge base, seat saved Personas as classmates,
  push wrong answers into the question bank, and export to a Notebook.

### Library conversion toolbox

- Agents convert uploaded images, PDFs, and audio/video through a discovered
  engine chain (`KNORVIA_<NAME>_PATH` → `data/engines/` → PATH). Results
  land as new library entries.

### Partner runtime

- Per-partner inference router (product LLM or a local agent CLI), usage
  ledger, message reactions, real `/stop`, and typing indicators.

### Desktop chrome and performance

- Wallpaper + frost as separate layers; 16px restored-window corners;
  session listing, SQLite reads, settings cache, and chat streaming no
  longer scale with the whole transcript.
- English locale overrides shrink the root shell (~215 KB off every route).

### Security

- `python-jose` / `ecdsa` removed in favour of `pyjwt[crypto]`.
- ExcelJS `uuid` pinned via npm overrides.
- `lightrag-hku` floored at 1.5.6; `liteparse` pinned to 2.14.2.
- Open exception: `pyarrow` 22.x via graphrag 3.x (`SECURITY.md`, 2027-01-01).

## RC acceptance checklist

Automated release blockers:

- [x] Packaged runtime reports 1.0.0 and carries the 1.0.0 UI badge.
- [x] `Knorvia-1.0.0-setup.exe`, portable ZIP, and SHA-256 manifest agree.
- [x] `scripts/release/check_package.py` reports PACKAGE: ALL PASS.

## Final artifacts

- `Knorvia-1.0.0-setup.exe` — 294.3 MB —
  SHA-256 `22511CBD9B5335C704AA6FAA8755FDA7C10630100445FD57D88C59FF02C6EEFF`
- `Knorvia-1.0.0-portable.zip` — 385.9 MB —
  SHA-256 `6E81E5757AA5BADB1F31004D78737C490849CC67E31DE866679C2EA8A6E3DFE2`
- `knorvia-1.0.0-py3-none-any.whl` — 70.3 MB (Python wheel under `dist/`)
- The packaged runtime acceptance (`scripts/release/check_package.py`)
  reports PACKAGE: ALL PASS: runtime and UI badge at 1.0.0, required API
  routes and adapters import from the wheel, the desktop stream bridge is in
  `app.asar`, no Real-ESRGAN engine files are bundled, and the SHA-256
  manifest matches both artifacts.
