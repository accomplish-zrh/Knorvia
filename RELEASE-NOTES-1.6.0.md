# Knorvia 1.6.0 — Release Notes

Release candidate: **Knorvia 1.6.0-rc.1**

This is the first independent Knorvia release. Versioning no longer follows
DeepTutor's 1.5.x line (DeepTutor remains a code reference only).

---

## Upgrade guide

### From 1.5.11 (installed desktop build)

1. Close any running Knorvia instance (tray and window).
2. Run `Knorvia-1.6.0-rc.1-setup.exe` and install over the existing location,
   or install to a new location — the workspace (chat history, knowledge
   bases, memory, settings) is stored separately and is picked up
   automatically.
3. On first launch, legacy data (`DeepTutor-data`, `data/chat_history.db`) is
   migrated into the new layout once.

**Release blocker — history preservation:** the first-launch migration was
hardened in this release. If the old database file is momentarily locked
(e.g. an old instance is still closing), migration retries and, if it still
cannot proceed, the app reports a clear error instead of silently starting
empty. **Do not delete the old data folder before confirming your chat
history appears in 1.6.0.**

### From 1.5.11 (portable)

1. Quit the old portable copy.
2. Unzip `Knorvia-1.6.0-rc.1-portable.zip` **beside** the old folder (a new
   folder is created — do not extract over the old one).
3. Copy the old data folder (`Knorvia-data` next to the old portable exe)
   into the new portable folder if you want to keep it with the new copy,
   then launch. History is read from the workspace and migrated on first run.

### Uninstalling

The uninstaller removes the application files only. Your workspace and user
data (chat history, knowledge bases, settings, downloads, upscaled images)
are kept by design, so a reinstall continues where you left off. To remove
user data as well, delete the workspace folder manually (see below for its
location) — the uninstaller will not do this for you.

| Installation | Workspace location |
| --- | --- |
| Installed build | `%APPDATA%\Knorvia\workspace` |
| Portable build | `<portable-folder>\Knorvia-data` |

---

## Known issues

1. **Unsigned build — SmartScreen warning.** The RC installer is not code
   signed. Windows SmartScreen may show "Windows protected your PC" — click
   *More info → Run anyway*. The SHA-256 checksums below let you verify the
   files are the ones produced by this release.
2. **Real-ESRGAN engine downloads on first use.** The AI upscaler is not
   bundled; on first use it downloads the engine (the official package is
   about 45–52 MB; budget up to 80 MB as a safety ceiling), verifies its
   hash, and installs it under `data/engines`. This requires network access
   once. Without Vulkan, without network, or if the download fails, upscaling
   falls back to basic resizing — the feature degrades gracefully.
3. **MCP servers.** External MCP servers that go offline are retried with
   backoff; a turn simply runs without that server's tools. Some servers
   return 403 to the OAuth probe and show repeated warnings in the log —
   check the server's credentials in Settings → MCP.
4. **Image Studio jobs do not survive an app restart mid-task** (task history
   is preserved, in-flight generations are not resumed). Known limitation of
   the current task scheduler.
5. **Embedding model is not configured by default** — knowledge-base
   retrieval asks you to pick an embedding model in Settings → Catalog.
6. **Perf notes.** First web start after install compiles/copies caches and
   can take tens of seconds; subsequent starts are fast.

---

## Release acceptance checklist (RC)

Automated items were verified in CI and on the Windows build machine; the
manual items below must be completed before GA.

### Release blockers (must pass)

- [ ] **Upgrade from 1.5.11 keeps chat history** — install RC over an existing
  1.5.11 install (or point a portable copy at an old workspace) and confirm
  all conversations are listed.
  *(✅ Automated check passed with the packaged runtime: both the modern
  `data/user/chat_history.db` re-open and the legacy `data/chat_history.db`
  migration preserved all sessions — `scripts/release/check_upgrade_history.py`.
  Caveat: that check simulates a 1.5.11-era layout using a database produced
  by the current code; it is not a frozen 1.5.11 database, so this manual
  verification against a REAL 1.5.11 workspace remains a release blocker.)*
- [ ] **Quitting mid-generation does not corrupt data** — start a long answer,
  close the window mid-stream, relaunch: the session must open and the
  database must be intact.
  *(✅ Automated check passed with the packaged runtime: the store survived a
  `taskkill /t /f` mid-write with `integrity_check = ok` and all committed
  rows readable — `scripts/release/check_graceful_exit_db.py`.)*

### Functional checklist

- [ ] Fresh install + first launch (loading page → home UI).
- [ ] Overwrite upgrade from 1.5.11 (see above).
- [ ] Uninstall: app removed, user data retained (check workspace folder).
- [ ] Normal chat turn, tool call (web search / RAG), cancel generation.
- [ ] MCP: disconnect a server mid-session; rotate credentials; error
  messages must not leak API keys.
- [ ] Image Studio: generate, edit, 1K/2K/4K outputs.
- [ ] Upscaling: with Vulkan (engine download + upscale); without Vulkan /
  offline / failed download → basic scaling fallback.
- [ ] Desktop: broken-runtime error dialog; graceful close while busy.
- [ ] Login redirect (multi-user on) and Co-Writer autosave (type, reload).
- [ ] Paths containing Chinese characters, spaces; run as a non-admin account.

---

## Artifacts & checksums (rc.1)

SHA-256 (verify with `certutil -hashfile <file> SHA256`):

```
Knorvia-1.6.0-rc.1-setup.exe     SHA256: 5D8CC940D7A59C92845F90BD42144DB1CD399031F2E83B1CD0785C496E7DB67F
Knorvia-1.6.0-rc.1-portable.zip  SHA256: 405D5FA174B481083AC81CF64CC94FDBFBC8D366D5B5BF4CB78E12E89ACB77FA
```

Sizes: installer 233.5 MB; portable zip 336.0 MB. The Real-ESRGAN engine is
**not** included in either artifact (verified during the release candidate
check) — it downloads on first use and is hash-verified.

Third-party licenses: see `THIRD_PARTY_NOTICES.md`.

---

## Post-release backlog (second tier)

Deferred until after 1.6.0 GA, in suggested priority order:

1. Image Studio polling and task cleanup (cancel on unmount, `followingJobs`
   cleanup in `finally`).
2. Co-Writer Enter-key duplicate submission.
3. Stable keys for the message list (delete / branch edit state integrity).
4. Crash log & diagnostic bundle export.
5. Automatic update mechanism.
6. Image workbench batch processing, local inpainting and model preset
   management.


