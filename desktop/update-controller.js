"use strict";

// Update discovery controller for the Knorvia desktop shell.
//
// Sits between the pure update-check logic and the Electron shell (main.js):
// it owns the *policy* around update notifications so the shell only has to
// render decisions.
//
//  - manual checks always report their outcome (update available, up to date,
//    or failure);
//  - background checks notify once per version, honour "remind later"
//    (time-boxed) and "skip this version" (persistent) settings, and stay
//    silent on failures;
//  - failures back off subsequent background checks (15m → 1h → 4h) while
//    manual retries always go through;
//  - all persistent state goes through an injected store so restarts keep the
//    user's choices and do not re-prompt.
//
// No Electron imports: notify/openExternal/state are injected, which keeps
// the whole flow unit-testable with `node --test`.

const updateCheck = require("./update-check");

const BACKOFF_STEPS_MS = [15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000];

function errorMessage(error) {
  return String((error && error.message) || error || "unknown error");
}

function createUpdateController(options = {}) {
  const {
    currentVersion,
    token = "",
    fetchImpl = null,
    fetchLatestRelease = null,
    readState = () => ({}),
    writeState = () => {},
    notify = () => {},
    openExternal = () => {},
    platform = process.platform,
    arch = process.arch,
    now = () => Date.now(),
    remindLaterMs = updateCheck.CHECK_INTERVAL_MS * 7,
  } = options;

  const doFetchRelease = fetchLatestRelease || ((req) => updateCheck.fetchLatestRelease({ ...req, fetchImpl }));
  let checking = false;

  function loadState() {
    let state;
    try {
      state = readState();
    } catch {
      state = {};
    }
    return state && typeof state === "object" ? state : {};
  }

  function saveState(patch) {
    try {
      writeState({ ...loadState(), ...patch });
    } catch {
      // Persistence failures must never crash the update flow; the next check
      // simply re-prompts at worst.
    }
  }

  function skippedVersions(state) {
    return Array.isArray(state.skippedVersions) ? state.skippedVersions.filter((v) => typeof v === "string") : [];
  }

  async function check({ manual = false } = {}) {
    if (checking) return { kind: "busy" };
    checking = true;
    const at = now();
    const state = loadState();
    try {
      if (!manual && typeof state.backoffUntil === "number" && state.backoffUntil > at) {
        return { kind: "skipped-backoff", until: state.backoffUntil };
      }
      const release = await doFetchRelease({ token });
      const decision = updateCheck.decideUpdate({ currentVersion, release, platform, arch });
      saveState({
        lastCheck: new Date(at).toISOString(),
        // `release` may be a raw payload or a normalised release; the decided
        // release is always normalised and carries the comparable version.
        lastVersion: decision.release ? decision.release.version : "",
        lastError: "",
        backoffAttempts: 0,
        backoffUntil: 0,
      });
      if (decision.kind !== "available") {
        if (manual) notify({ ...decision, manual });
        return decision;
      }
      const version = decision.release.version;
      // A pending remind-later entry only influences background prompts; a
      // manual check must never cancel the user's scheduled reminder.
      const pendingRemindLater = manual
        ? null
        : state.remindLater && state.remindLater.version === version
          ? state.remindLater
          : null;
      if (!manual) {
        if (skippedVersions(state).includes(version)) {
          return { ...decision, notified: false, reason: "skipped" };
        }
        if (pendingRemindLater && pendingRemindLater.until > at) {
          return { ...decision, notified: false, reason: "remind-later" };
        }
        // An expired remind-later promise is exactly why the checker should
        // prompt again, so it bypasses the already-notified guard below.
        if (!pendingRemindLater && state.notifiedVersion === version) {
          return { ...decision, notified: false, reason: "already-notified" };
        }
      }
      saveState({
        notifiedVersion: version,
        notifiedAt: new Date(at).toISOString(),
        // The scheduled reminder has now fired; it must not fire twice.
        ...(pendingRemindLater ? { remindLater: undefined } : {}),
      });
      notify({ ...decision, manual, previouslySkipped: skippedVersions(state).includes(version) });
      return { ...decision, notified: true };
    } catch (error) {
      const message = errorMessage(error);
      const attempts = Number(state.backoffAttempts) || 0;
      const step = BACKOFF_STEPS_MS[Math.min(attempts, BACKOFF_STEPS_MS.length - 1)];
      saveState({
        lastCheck: new Date(at).toISOString(),
        lastError: message,
        backoffAttempts: attempts + 1,
        // Manual retries never silence the periodic checker: only background
        // failures set a backoff window.
        backoffUntil: manual ? 0 : at + step,
      });
      if (manual) notify({ kind: "error", message, manual: true });
      return { kind: "error", message };
    } finally {
      checking = false;
    }
  }

  // Called by the shell when the user answers the update prompt. `downloadUrl`
  // must be the URL shown in the dialog (guards against state drift between
  // prompt and click).
  function applyChoice({ version, choice, downloadUrl = "" }) {
    if (!version) return { kind: "error", message: "missing version" };
    if (choice === "install") {
      if (!downloadUrl) return { kind: "error", message: "missing download url" };
      openExternal(downloadUrl);
      saveState({ lastAction: { kind: "install", version, url: downloadUrl, at: new Date(now()).toISOString() } });
      return { kind: "install", url: downloadUrl };
    }
    if (choice === "download-in-app") {
      // The shell starts its own download task; this only records the choice.
      if (!downloadUrl) return { kind: "error", message: "missing download url" };
      saveState({ lastAction: { kind: "download-in-app", version, url: downloadUrl, at: new Date(now()).toISOString() } });
      return { kind: "download-in-app", version };
    }
    if (choice === "remind-later") {
      saveState({
        remindLater: { version, until: now() + remindLaterMs },
        lastAction: { kind: "remind-later", version, at: new Date(now()).toISOString() },
      });
      return { kind: "remind-later", version };
    }
    if (choice === "skip") {
      const next = Array.from(new Set([...skippedVersions(loadState()), version]));
      saveState({
        skippedVersions: next,
        remindLater: undefined,
        lastAction: { kind: "skip", version, at: new Date(now()).toISOString() },
      });
      return { kind: "skip", version };
    }
    return { kind: "error", message: `unknown choice: ${String(choice)}` };
  }

  // Manual check results can mention a previously skipped version so the user
  // understands why the prompt carries a note.
  function skipNote(version) {
    return skippedVersions(loadState()).includes(version)
      ? "（你此前选择跳过此版本，可忽略本提示。）"
      : "";
  }

  return { check, applyChoice, skipNote };
}

module.exports = { createUpdateController, BACKOFF_STEPS_MS };
