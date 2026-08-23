# Knorvia 1.7.0 — Release Notes

Release candidate target: **Knorvia 1.7.0-rc.1**

Knorvia 1.7.0 adds a durable Video Studio to the same local-first workspace as
chat, Image Studio, writing, books, and learning. Video creation is not a thin
provider demo: projects, source assets, jobs, events, outputs, authorization,
and recovery remain under Knorvia's control while provider adapters stay
replaceable.

Existing 1.6.1 artifacts remain separate and are not overwritten by this
release line. The installer and portable archive for 1.7.0-rc.1 must be built
from the frozen 1.7.0 source and pass the package acceptance script before
publication.

## Highlights

### A workspace for long-running video creation

- Create isolated projects, upload validated image/video/audio references,
  arrange a revisioned storyboard, submit work, follow incremental events,
  cancel or retry jobs, and export the complete project.
- Upload and stored-media limits cover declared bytes, chunks, active sessions,
  MIME sniffing, checksums, decoded image dimensions, per-project storage, and
  provider-transfer budgets.
- Jobs have durable idempotency keys and explicit queued, submitting, running,
  succeeded, failed, cancelled, and interrupted states. A restart can recover
  unfinished work without inventing a success. After a provider task is
  accepted, transient poll/download failures use bounded retry against the
  same remote task; they do not create a second billable render. Manual Retry
  is limited to failed, cancelled, or interrupted jobs.
- Provider output is downloaded and validated into the local project. The UI
  previews and downloads the authenticated same-origin asset rather than an
  expiring provider URL.

### One model catalog, not a second settings silo

- Video models use the existing profile, shared connection, credential,
  per-user grant, and active-default system.
- Capabilities are data driven: text/image/video generation operations,
  extend/remix/edit, durations, ratios, resolutions, FPS, audio/reference
  modes, image/video/audio/total input limits, seed/cancel support, prompt and
  transfer limits, plus an advanced provider parameter schema.
- Built-in provider modes cover OpenAI Videos, Volcengine Ark/Seedance, and a
  custom asynchronous-task endpoint. Google Veo is not shown as natively
  available until a tested first-party adapter exists; it may be configured
  only through an accurate custom provider contract.
- OpenAI's Videos API is marked deprecated with its announced **September 24,
  2026** shutdown date. It is retained for migration, not recommended as a new
  long-lived integration.

### Agent video creation with a real authorization boundary

- The `videogen` tool submits exactly one asynchronous Video Studio job and
  returns its durable job/project link; chat renders a live video task card and
  can open the exact project and job. It does not keep a chat turn alive while
  polling or claim that a queued render has finished.
- A potentially billable call always pauses on a closed choice. Approval is
  bound to a server-created fingerprint of the exact project, model, operation,
  prompt, reference assets, and parameters, plus a one-shot idempotency key.
- Before showing that choice, the Agent applies the same grant, operation,
  parameter-schema, input-kind, byte and count validation as durable
  submission; the service repeats the checks after approval in case state changed.
- Only the matching confirmation question and exact affirmative option can
  approve. Free text, cancellation, duplicate/conflicting answers, the
  image-workspace question id, private arguments authored by the model, or a
  changed plan cannot spend money.
- Image attachments supplied by the current chat can be imported server-side
  for image-to-video. Inline bytes, local attachment URLs, and same-user Image
  Studio assets still pass Video Studio's MIME, dimension, and quota checks;
  unsupported references ask the user to upload them in Video Studio.

### Desktop playback and exports without a hidden TCP server

- Packaged Knorvia continues to run the Python engine over private stdio. Asset
  content and project ZIP exports bypass the Next proxy and use a dedicated
  authenticated stream bridge.
- The bridge preserves `Range`, `HEAD`, `206`, `416`, `Content-Range`, and
  `Content-Disposition`, propagates cancellation and shutdown, refreshes a
  bounded idle deadline, and limits in-flight data with a two-chunk window.
  Video preview therefore does not base64-buffer an entire file in Electron.
- The Windows build runs desktop transport tests before packaging and verifies
  `protocol-stream.js` is present in `app.asar`.

## Design references and clean-room boundary

The implementation is original Knorvia code. No source, UI assets, prompts, or
branding were copied from the projects below.

- [LibTV skills](https://github.com/libtv-labs/libtv-skills) (MIT) informed
  session/project isolation, uploads, incremental `after-seq` progress, and
  result download as an agent workflow.
- [Livepeer Storyboard](https://github.com/livepeer/storyboard) informed the
  separation between an artifact store and a capability resolver. Its
  repository did not provide a standard open-source license grant during this
  review, so only high-level public architecture descriptions were considered.
- [LTX Desktop](https://github.com/Lightricks/LTX-Desktop) (Apache-2.0) informed
  the distinction between local and cloud execution modes.
- [Velorn](https://github.com/VelornLabs/velorn) (GPL-3.0) and
  [Pireel](https://github.com/pireel/pireel) (AGPL-3.0-only) were evaluated only
  at the product-concept level. No copyleft implementation or asset was copied
  into Knorvia.
- A local packaged copy of AIPAI-Code was observed only for its asynchronous
  queue, paid-action confirmation, and local-archive interactions. Its installed
  distribution did not provide a complete license/provenance chain, so no code,
  prompt, UI, asset, or brand element was copied into Knorvia.

## RC acceptance checklist

Automated release blockers:

- [ ] Full Python suite passes on Ubuntu and Windows for Python 3.11 and 3.12.
- [ ] Ruff lint/format, Web tests, TypeScript, and production Web build pass.
- [ ] Plain-wheel installation imports Video Studio and exposes its required
      model, asset-content, and project-export routes outside the checkout.
- [ ] Desktop Node tests cover asset Range/HEAD/416, ZIP disposition, slow
      consumers, idle timeout, cancellation, shutdown, and strict route allowlist.
- [ ] Packaged runtime reports 1.7.0, includes the stream bridge and Video
      Studio routes/dependencies, and carries the 1.7.0 UI badge.
- [ ] `Knorvia-1.7.0-rc.1-setup.exe`, portable ZIP, and SHA-256 manifest agree.

Manual release blockers:

- [ ] Upgrade a real 1.6.1 workspace and confirm existing chat, Image Studio,
      settings, MCP, schedules, and agents remain visible.
- [ ] Configure one granted Volcengine/custom test model; create text-to-video
      and image-to-video jobs, cancel a running job, retry a transient failure,
      restart during a render, and verify the final output remains local.
- [ ] In the packaged desktop, seek through a large MP4, preview with a bounded
      Range request, download it, export a project ZIP, cancel midway, and close
      the application while a stream is active.
- [ ] Confirm a basic user cannot see or use another user's project, asset,
      event stream, job, model grant, or shared credential.
- [ ] Confirm wrong confirmation question, Cancel, free text, duplicate resume,
      and changed prompt/model/reference never submit a provider task.
- [ ] Exercise Chinese/space-containing paths, non-administrator Windows user,
      offline start, provider timeout, credential change, and redacted errors.

## Known limitations

- Video Studio 1.7.0 is a generation/storyboard workspace, not a full nonlinear
  timeline editor. Frame-accurate cuts, transitions, captions, audio mixing,
  and local FFmpeg composition remain post-1.7 work.
- Direct chat attachment import is intentionally limited to safely resolvable
  image references. Large video/audio references must first be uploaded in
  Video Studio.
- OpenAI Videos is a migration-only adapter because of the announced shutdown.
- Final RC file sizes and SHA-256 values are added only after the root release
  build; this source note intentionally contains no placeholder hashes.
