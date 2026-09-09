# Knorvia desktop and native workbench

Knorvia desktop starts one private `knorvia-daemon` sidecar and communicates
with it through the allow-listed Knorvia JSON-RPC transport. The workbench does
not start the legacy Python domain worker or StreamEvent chat bridge.

## Package the Windows 1.1.0 native desktop

The native release keeps its renderer in `resources/runtime/web` and the
daemon, CLI, pack worker and Kernel App Server in `resources/runtime/bin`.
It can start without the source checkout or a Python installation. Domain
workers remain optional extensions and require their own runtimes.

From the repository root, run `scripts/build_windows_native.ps1 -RuntimeSource
<native-runtime-directory>`. The input directory must contain `bin/knorvia.exe`,
`bin/knorvia-daemon.exe`, `bin/knorvia-pack-worker.exe`, and
`bin/knorvia-kernel-appserver.exe`. The script builds Next standalone, bundles
Node and the renderer, then creates the NSIS installer, portable ZIP and SHA-256
manifest under `release`. `-SkipWebBuild` reuses an already verified
`web/.next-knorvia` production build. Existing portable releases are protected.

The supplied brand master lives at `assets/figs/logo/knorvia-source.png`.
Run `node web/scripts/build-app-icons.mjs` to reproduce the web and desktop
PNG/ICO sizes without redrawing the image.

## Run from source

For source development, build the current Next standalone output and point the
desktop shell at it. `KNORVIA_WEB_DIR` is checked first, so source runs no
longer depend on the old staged Python static-renderer layout. It may name the
standalone directory itself or the web root that contains it.

First build `native/knorvia-rs` and the pinned execution engine described in
[native/README.md](../native/README.md). From the repository root:

```powershell
$project = (Get-Location).Path
Set-Location (Join-Path $project 'web')
npm ci --legacy-peer-deps
npm run build

Set-Location (Join-Path $project 'desktop')
npm ci
$env:KNORVIA_DAEMON_BIN = Join-Path $project 'native/knorvia-rs/target/release/knorvia-daemon.exe'
$env:KNORVIA_KERNEL_BIN = 'PATH_TO_ENGINE/codex-rs/target/release/codex-app-server.exe'
$env:KNORVIA_WEB_DIR = Join-Path $project 'web'
npm start
```

Replace `PATH_TO_ENGINE` with the execution-engine checkout. The web root is
resolved to its current standalone build without depending on a developer's
drive layout.

If a standalone output is unavailable, desktop retains the packaged staged
runtime as a compatibility fallback. Set `KNORVIA_NODE_BIN` only when Electron
cannot run the renderer host itself and no staged Node runtime is present.

The Electron preload exposes only the native JSON-RPC request and notification
bridge. The sidecar creates durable workspaces, tasks, turns, approvals,
user-input requests, artifacts, and automations in the selected local home.

## Model connection contract

`connection/read` and `connection/update` return `ConnectionInfo` directly,
never a `{ connection: … }` wrapper. The API key is never returned.

| Method | Parameters | Behavior |
| --- | --- | --- |
| `connection/read` | `{}` | Returns model, Responses base URL, key presence, storage/source metadata, engine state, and desktop-file capability flags. |
| `connection/update` | `{ model?, baseUrl?, apiKey?, clearKey? }` | Changes the engine only after it confirms no task is active. Omitted `apiKey` keeps it. `apiKey: ""` or `clearKey: true` deliberately clears it. |
| `connection/test` | `{ probeProvider?: boolean }` | The default asks the real daemon-to-Kernel `model/list` path and reports `kernelReady: true`, `providerVerified: false`. With `probeProvider: true`, it sends one bounded low-output Responses request to a custom endpoint and reports provider verification separately. |

`connection/test` never calls a provider unless `probeProvider: true` is
explicitly requested. The provider probe has a short timeout, does not follow
redirects, returns no response body or raw provider error, and is unsupported
for the standard OpenAI endpoint. A user-facing “send test request” control
should state that this explicit probe sends a small request and can consume
provider usage.

On desktop, an entered API key persists only when Electron `safeStorage` is
available. The settings file has non-secret settings and opaque safeStorage
ciphertext; it never has a plaintext key. When secure storage is unavailable,
an entered key lives only for the current process. Environment configuration is
reported as `source: "env"`, without re-exposing the key.

The browser development gateway has no Electron `safeStorage`. Its changes are
session-only, and `connection/read` reports `transport: "browser"` plus a
`session` or `env` credential source. They are not written to disk.

Changing model, base URL, or key blocks new work and waits for an already
admitted `turn/start`. It then asks the daemon owner to atomically freeze new
admissions and check active turns, including scheduler work. An active task
produces a conflict with `activeTurnCount` and leaves the engine intact. If a
stop fails before the old daemon exits, desktop cancels that freeze. If idle,
desktop stops the old daemon, waits for it to release the local Home owner,
and starts a new daemon with the new provider environment. It does not replay
mutations. `connection/state` notifications expose `checking`, `restarting`,
`ready`, or `unavailable` so the UI can refresh.

## Desktop folder and file actions

`connection/read.capabilities` tells the UI whether native file affordances are
available:

```json
{ "selectFolder": true, "openPath": true, "revealPath": true }
```

Desktop-only `desktop/select-folder` accepts `{ defaultPath?: string }` and
returns `{ cancelled: boolean, path?: string }`. Its path comes from the native
user dialog. Store it through `workspace/update` or `thread/update` before
using it as a project scope.

`desktop/open-path` and `desktop/reveal-path` accept
`{ workspaceId?, threadId?, path: string }`. They require a relative path; an
empty string means the workspace root. Electron first invokes
`workspace/path/resolve`, then canonicalizes the result and confirms it remains
inside the persistent workspace/task folder before calling the OS shell.
Renderer-supplied absolute paths and parent escapes are rejected, as are
symlink or junction escapes. An in-scope link opens only its canonical target.
There is no arbitrary shell IPC.

In browser mode all three desktop methods return a clear restricted/unsupported
result. Scoped browser RPC remains available for `workspace/path/resolve`,
`workspace/files/list`, `workspace/files/read`, `workspace/git/status`,
`workspace/git/diff`, and `workspace/worktree/create`.

## Run `/workbench` in a browser during development

Start the development-only loopback gateway in one terminal. It runs the same
daemon engine as desktop, validates the local browser origin, issues a
short-lived one-use WebSocket token, and permits only native workbench RPCs.

```powershell
cd D:\tools\Knorvia\desktop
$env:KNORVIA_DAEMON_BIN = 'D:\tools\knorvia-kernel\knorvia-rs\target\debug\knorvia-daemon.exe'
$env:KNORVIA_KERNEL_BIN = 'D:\tools\knorvia-kernel\codex-rs\target\debug\codex-app-server.exe'
$env:KNORVIA_NATIVE_HOME = 'D:\tools\Knorvia\work\native-browser-home'
$env:KNORVIA_NATIVE_GATEWAY_PORT = '4318'
$env:KNORVIA_PROVIDER_MODEL = '<model>'
$env:KNORVIA_PROVIDER_BASE_URL = '<responses-base-url>'
$env:KNORVIA_PROVIDER_API_KEY = '<provider-key>'
npm run native-gateway
```

In another terminal:

```powershell
cd D:\tools\Knorvia\web
$env:KNORVIA_NATIVE_GATEWAY_URL = 'http://127.0.0.1:4318'
npm run dev
```

Open `http://127.0.0.1:3000/workbench`. The browser client gets a short-lived
token through `/api/knorvia/native/session`, then connects through
`/api/knorvia/native`; provider credentials stay in the gateway process. Add a
custom Next origin to `KNORVIA_NATIVE_ALLOWED_ORIGINS` before starting it.

## Run the deterministic local acceptance fixture

The fixture uses a local scripted Responses endpoint while exercising the real
daemon, Kernel App Server, approval bridge, filesystem tool, user-input bridge,
steer, cancellation, and durable snapshots. It uses only an isolated home.

```powershell
cd D:\tools\Knorvia\desktop
$env:KNORVIA_NATIVE_GATEWAY_PORT = '4318'
$env:KNORVIA_NATIVE_FIXTURE_HOME = 'D:\tools\Knorvia\work\native-acceptance-home'
npm run native-gateway:fixture
```

The launcher prints non-secret gateway and fixture addresses. Point Next at the
printed gateway with `KNORVIA_NATIVE_GATEWAY_URL`, then open `/workbench`.
Use `[approval]`, `[user-input]`, or `[slow]` in a task to exercise the
corresponding control paths.

## Validate the transport

```powershell
cd D:\tools\Knorvia\desktop
npm test

cd D:\tools\Knorvia\web
node .\node_modules\tsx\dist\cli.mjs --test tests\native-client.test.ts
```

The desktop suite covers encrypted configuration semantics, scoped shell
actions, controlled runtime replacement, a bounded local provider probe,
protocol routing, gateway framing, and the real local fixture. It uses no real
provider credential or paid model.
