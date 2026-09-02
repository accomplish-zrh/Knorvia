# Knorvia

Knorvia is a private AI learning and knowledge workspace. It brings chat,
research, guided learning, writing, visualization, reusable skills, and local
knowledge bases into one extensible application.

## Product identity

- Product: **Knorvia**
- Python package: `knorvia`
- Command line: `knorvia`
- Runtime home: `KNORVIA_HOME`
- Desktop protocol: `knorvia://`

Knorvia does not publish compatibility aliases for earlier package, command,
protocol, or environment-variable names. Existing desktop workspaces and
browser preferences are migrated once when the new application starts.

Knorvia is maintained as an independent codebase. It contains no automatic
upstream source synchronizer, Git remote, or desktop update feed; releases are
adopted only through Knorvia's own review and distribution process.

Knorvia versioning is independent (current release: **1.0.0**). The version
is defined once in `knorvia/__version__.py` and is followed by the Python
package, the desktop shell, installer artifact names and the in-app version
badge. DeepTutor remains a code reference only and does not decide Knorvia's
version. See [CHANGELOG.md](CHANGELOG.md).

## Requirements

- Python 3.11–3.13
- Node.js 20 or newer
- Windows, macOS, or Linux for source development

## Install from source

```bash
python -m venv .venv
python -m pip install --upgrade pip
python -m pip install -e ".[app]"
cd web
npm ci --legacy-peer-deps
cd ..
knorvia init
knorvia start --dev
```

For a production-style local run:

```bash
knorvia start
```

The default frontend is available at `http://127.0.0.1:3782`. Runtime data is
stored below the current workspace, or below the directory selected with
`KNORVIA_HOME` or `knorvia start --home`.

## Main areas

- Chat and agent-assisted problem solving
- Knowledge bases with pluggable retrieval engines
- Guided learning, quizzes, books, and question notebooks
- Co-Writer and document workflows
- Image Studio projects with generation, multi-image editing, inpainting,
  persistent task history, and authenticated asset export
- Video Studio projects with validated reference uploads, storyboards, durable
  asynchronous jobs, local output archival, and resumable progress
- Video workbench composition: local FFmpeg stitching into watermark-free MP4s
  with crossfades, burned subtitles, per-shot narration, and BGM ducking;
  three-view character cards, camera controls, seed rerolls with variant
  history, a shot timeline, 12 board templates, optional per-model cost
  estimates, and a same-origin 3D Director Desk view for staging cameras and
  blocking (`web/lib/director-desk/README.md`)
- Memory, personas, partners, MCP services, and CLI apps
- Local skills plus optional imports from ClawHub
- Desktop and browser interfaces backed by the same Python runtime

## Common commands

```bash
knorvia init
knorvia start
knorvia run "Explain Bayesian updating"
knorvia skill list
```

Run `knorvia --help` for the complete command reference.

## Installation profiles

The default `pip install knorvia` is the lightweight agent/CLI runtime. Add
only the product surfaces required by the deployment:

```bash
pip install "knorvia[providers]"  # additional model providers
pip install "knorvia[rag]"        # LlamaIndex + FAISS retrieval
pip install "knorvia[documents]"  # Office/PDF ingestion
pip install "knorvia[media]"      # image/media primitives
pip install "knorvia[server]"     # FastAPI/WebSocket service
pip install "knorvia[app]"        # complete browser/desktop product
```

Provider auth (`openai-codex` OAuth login; `github-copilot` validates an existing Copilot auth session; `codebuddy` validates CodeBuddy SDK auth and starts login when needed)
is available through `knorvia provider login <provider>`.

Container deployments, including the
[temporary local Codex OAuth bridge](CONTAINERIZATION.md#temporary-local-codex-oauth-bridge),
are documented in the container guide.

Image models reuse provider connections from Settings, while their models,
capabilities, defaults, and multi-user grants are governed separately from chat
models. Set `KNORVIA_IMAGE_STUDIO_ENABLED=false` before starting Knorvia to
disable all Image Studio HTTP and WebSocket endpoints as a release rollback.
Video models follow the same shared-connection and per-user-grant design while
keeping video-specific operations and limits in their own catalog capability;
set `KNORVIA_VIDEO_STUDIO_ENABLED=false` for the equivalent Video Studio
rollback.

## Development checks

```bash
python -m pytest
python -m ruff check knorvia knorvia_cli tests
cd web
npm run lint
npm run build
```

## License and attribution

Knorvia is distributed under the Apache License 2.0. Third-party software and
upstream attribution are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
