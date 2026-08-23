# Knorvia 1.6.1 — Release Notes

Release candidate: **Knorvia 1.6.1-rc.1**

Knorvia 1.6.1 is a correctness, stability, and release-quality update. It
concentrates on Image Studio, long-running chat work, the desktop lifecycle,
scheduled work, and making sure the shipped application matches the source
that was tested. Existing 1.6.0 candidate artifacts are superseded.

## Highlights

### Image Studio keeps the right project and the right result

- Chat sessions now map to projects by their complete session id, eliminating
  collisions between sessions created close together. Deleted mappings can be
  recreated cleanly.
- Projects and jobs validate that referenced assets, parent jobs, retry jobs,
  masks, and board nodes belong to the same project.
- Board saves carry a revision. A stale tab receives an explicit conflict
  instead of silently erasing a newly generated card; worker updates are
  applied atomically to the latest board.
- Project switching cancels stale requests and ignores late responses. Job
  followers are disposed when their project changes or the page unmounts.
- Job transitions are conditional and cancellation is persisted first. A late
  provider response can no longer turn a cancelled job back into a success or
  overwrite an already completed job.
- The queue is bounded and restartable, with a fixed worker count and durable
  recovery of queued work. Queue-full failures are explicit and rolled back.
- Uploads are streamed and bounded by declared size, chunk index, active
  upload count, total pending bytes, lifetime, checksum, decoded dimensions,
  and pixel count. Invalid or incomplete images are rejected before becoming
  project assets.
- Canvas undo/redo history has a 64 MiB budget. Empty inpaint masks and invalid
  model/operation/parameter combinations are blocked before a request is sent.
- 1K, 2K, and 4K requests continue to prefer native model output. Unsupported
  target sizes fall back to the configured local super-resolution path and
  report that fallback in the result metadata.

### Agent-driven visual creation is predictable

- Image generation that needs confirmation uses a server-created fingerprint
  of the exact plan. Confirmation is one-shot: changing the prompt, model,
  operation, references, or output parameters asks again.
- Model-authored `confirmed` values and private/internal tool arguments are
  ignored. Only the user's reply to the active confirmation pause can resume
  that exact plan.
- Replies are accepted only while a turn is genuinely paused, with capacity
  for one reply. Early, duplicate, and late replies return a clear failure
  instead of being consumed by a later confirmation.
- Queued image work records its owner and exact model-configuration revision.
  It rechecks the current assignment immediately before dispatch, so revoked
  access or a changed endpoint requires an explicit retry.
- Conversation summaries and legacy system-like history are treated as
  untrusted conversation data, not new application instructions. Oversized
  messages are truncated to the context budget.

### Smoother Web and desktop behavior

- Chat sending, branching, cancellation, and text-to-speech now guard against
  late responses from an earlier session or message.
- Presentation previews use a strict file allowlist and decompression limits.
- Schedule forms validate their values before submission.
- The Windows desktop starts one application instance, focuses the existing
  window on a second launch, waits a bounded time for renderer startup, and
  avoids killing a reused process id after the engine has already exited.
- MCP connection and call timeouts cancel the underlying operation. Credential
  changes trigger a fresh connection, and surfaced errors remain redacted.
- Scheduled jobs use atomic claims, bounded concurrency and runtime, and the
  owner's current account state rather than a stale role snapshot.

### Safer defaults for local integrations

- `knorvia start` and `knorvia serve` listen on the local machine by default.
  Listening on a wider interface requires authentication to be enabled.
- Host CLI subagents honor their enabled switch, require an administrator and
  an explicitly configured working-root allowlist, receive a minimal process
  environment, and stop their process tree when cancelled.
- CLI subagents receive only the current account's materialized MCP
  connections. MCP credentials are excluded from Codex command-line arguments,
  and temporary Claude configuration is access-restricted and removed.
- External desktop links are limited to HTTP(S) and email schemes.

### Complete, reproducible packages

The default wheel and desktop runtime explicitly include `croniter`, Windows
`tzdata`, and `mcp`. Release builds use lockfile-only dependency installs and
verify the packaged runtime, routes, Web assets, version, portable archive, and
SHA-256 manifest from the current 1.6.1 directory only.

## Upgrade

1. Back up the existing Knorvia workspace.
2. Close every running Knorvia window.
3. Install `Knorvia-1.6.1-rc.1-setup.exe`, or extract the matching portable
   archive to a new directory.
4. Start Knorvia and confirm the sidebar reports **1.6.1**.
5. Open an existing conversation and an existing Image Studio project before
   starting new work.
6. If local CLI subagents are used, set `KNORVIA_LINK_ROOTS` to the smallest
   directories they need, restart Knorvia, and reconnect them.

No data-schema downgrade is required when moving from 1.6.0 to 1.6.1. Do not
run two Knorvia versions against the same workspace at the same time.

## RC acceptance checklist

- [ ] Linux and Windows CI are green on the exact tagged commit.
- [x] Full Python, Web Node, TypeScript, lint, i18n, and production-build gates
      pass from the release source.
- [x] Plain-wheel and packaged-runtime probes import `knorvia`, `croniter`,
      `mcp`, and Windows `tzdata` without editable/source paths.
- [x] Packaged desktop smoke reports backend online and chat `pong`.
- [ ] A second desktop launch focuses the first instance and starts no second
      backend or scheduler.
- [ ] Existing 1.5.11/1.6.0 chat history and Image Studio projects remain
      visible after upgrade.
- [ ] Generate, edit, and inpaint work with at least two configured image-model
      families; model capabilities enable only supported controls.
- [ ] 1K, 2K, and 4K generation is labelled correctly, including local upscale
      fallback when native output is unavailable.
- [ ] Cancelling queued and running image jobs remains cancelled after the
      provider returns and after restart.
- [ ] Rapid project switching never displays or saves the previous project's
      board, assets, or job status.
- [ ] Two tabs editing one board produce an explicit revision conflict rather
      than silently dropping a generated node.
- [ ] Changing an agent-generated image plan after confirmation asks again;
      early, duplicate, and late replies are rejected.
- [ ] Oversized, incomplete, wrong-checksum, malformed, and decompression-heavy
      uploads/previews fail cleanly without leaving usable partial assets.
- [ ] Demoting, disabling, or deleting a scheduled-job owner prevents the next
      run; two processes do not execute the same due job twice.
- [x] Installer, portable archive, and checksum manifest all use
      `1.6.1-rc.1`; their final sizes and SHA-256 values appear below.

## Known release constraints

- The Windows installer is unsigned unless a signing certificate is supplied;
  SmartScreen may require **More info → Run anyway**.
- Local super-resolution is downloaded on first use and requires a supported
  Vulkan device for the fast path. Knorvia falls back to basic scaling if the
  engine cannot be downloaded or started.
- CLI subagents remain unavailable until an administrator configures an
  explicit local-root allowlist.
- A cancellation-resistant third-party process is detached after a bounded
  grace period and logged; Knorvia does not wait indefinitely.

## Artifacts

- `Knorvia-1.6.1-rc.1-setup.exe` — 317,187,917 bytes (302.5 MiB)  
  SHA-256: `72E53DFC07C701EE5DBA9AEB71BA3EFDC6D707B83B51A37EFAD99BA178132AFF`
- `Knorvia-1.6.1-rc.1-portable.zip` — 440,006,557 bytes (419.6 MiB)  
  SHA-256: `E2A5A904D19D6EB47523C321E5CA1D24EABD57294921C5338FDABE130BABEB94`
- `Knorvia-1.6.1-rc.1-SHA256SUMS.txt` — the machine-readable checksum manifest.

Any earlier 1.6.0 executable or archive is stale and must not be published as
the current release.
