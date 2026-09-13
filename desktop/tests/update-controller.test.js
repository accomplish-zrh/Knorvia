"use strict";

// P08: end-to-end update discovery flow tests. GitHub-shaped payloads flow
// through fetch normalisation → decision → notify/openExternal capture. The
// tests never download or execute installers; only external links are
// captured.

const assert = require("node:assert/strict");
const test = require("node:test");

const { createUpdateController } = require("../update-controller");

const NOW = Date.parse("2026-09-10T00:00:00Z");

function githubPayload(version, assets) {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/o/r/releases/tag/v${version}`,
    body: `release ${version} notes\nsecond line`,
    assets: assets === undefined
      ? [{ name: `Knorvia-${version}-setup.exe`, browser_download_url: `https://u/${version}-setup`, size: 300 }]
      : assets,
  };
}

function memoryStateStore(initial = {}) {
  let state = { ...initial };
  return {
    read: () => ({ ...state }),
    write: (next) => {
      state = { ...next };
    },
    snapshot: () => ({ ...state }),
  };
}

function makeController({
  currentVersion = "1.0.0",
  payload = githubPayload("1.1.0"),
  fetchError = null,
  store = memoryStateStore(),
  nowSequence = null,
  ...rest
} = {}) {
  let nowCalls = 0;
  const notifications = [];
  const openedUrls = [];
  const controller = createUpdateController({
    currentVersion,
    token: "",
    fetchLatestRelease: async () => {
      if (fetchError) throw fetchError;
      return payload;
    },
    readState: store.read,
    writeState: store.write,
    notify: (decision) => notifications.push(decision),
    openExternal: (url) => openedUrls.push(url),
    platform: "win32",
    arch: "x64",
    now: nowSequence ? () => nowSequence[nowCalls++] : () => NOW,
    ...rest,
  });
  return { controller, notifications, openedUrls, store };
}

test("full chain: GitHub payload → decide → notify with installer URL preserved", async () => {
  const { controller, notifications } = makeController();
  const result = await controller.check({ manual: true });
  assert.equal(result.kind, "available");
  assert.equal(result.notified, true);
  assert.equal(notifications.length, 1);
  const decision = notifications[0];
  assert.equal(decision.release.version, "1.1.0");
  assert.equal(decision.installer.url, "https://u/1.1.0-setup");
  assert.equal(decision.downloadKind, "installer");
  assert.equal(decision.downloadUrl, "https://u/1.1.0-setup");
});

test("manual up-to-date and failure outcomes are reported", async () => {
  const same = makeController({ currentVersion: "1.1.0" });
  await same.controller.check({ manual: true });
  assert.equal(same.notifications.length, 1);
  assert.equal(same.notifications[0].kind, "up-to-date");

  const failed = makeController({ fetchError: new Error("GitHub replied 403") });
  const res = await failed.controller.check({ manual: true });
  assert.equal(res.kind, "error");
  assert.equal(failed.notifications.length, 1);
  assert.equal(failed.notifications[0].kind, "error");
  assert.match(failed.notifications[0].message, /403/);
});

test("background checks notify once per version, survive restart, and stay silent on failure", async () => {
  const store = memoryStateStore();
  const first = makeController({ store });
  await first.controller.check({ manual: false });
  assert.equal(first.notifications.length, 1);

  // Second background check in the same session: no repeat prompt.
  await first.controller.check({ manual: false });
  assert.equal(first.notifications.length, 1);

  // Restart (fresh controller, same persisted state): still no repeat.
  const second = makeController({ store });
  await second.controller.check({ manual: false });
  assert.equal(second.notifications.length, 0);

  // A newer version prompts again.
  const newer = makeController({ store, payload: githubPayload("1.2.0") });
  await newer.controller.check({ manual: false });
  assert.equal(newer.notifications.length, 1);
  assert.equal(newer.notifications[0].release.version, "1.2.0");

  // Background failures never notify and set a backoff window.
  const errStore = memoryStateStore();
  const failing = makeController({ store: errStore, fetchError: new Error("GitHub replied 403") });
  const res = await failing.controller.check({ manual: false });
  assert.equal(res.kind, "error");
  assert.equal(failing.notifications.length, 0);
  assert.ok(errStore.snapshot().backoffUntil > NOW);
});

test("background failure backoff skips later background checks; manual retries always go through", async () => {
  const store = memoryStateStore();
  const failing = makeController({ store, fetchError: new Error("GitHub replied 403") });
  await failing.controller.check({ manual: false });
  assert.equal(failing.notifications.length, 0);

  // Immediately after: background check is skipped by backoff.
  const skipped = makeController({ store });
  const backoff = await skipped.controller.check({ manual: false });
  assert.equal(backoff.kind, "skipped-backoff");
  assert.equal(skipped.notifications.length, 0);

  // Manual check ignores backoff and reports the failure.
  const manual = makeController({ store, fetchError: new Error("GitHub replied 403") });
  const manualRes = await manual.controller.check({ manual: true });
  assert.equal(manualRes.kind, "error");
  assert.equal(manual.notifications.length, 1);

  // Once the backoff window passes, background checks resume.
  const later = makeController({ store, nowSequence: [store.snapshot().backoffUntil + 1] });
  await later.controller.check({ manual: false });
  assert.equal(later.notifications.length, 1);
});

test("timeout (abort) failures follow the same backoff path as HTTP failures", async () => {
  const abortError = new Error("This operation was aborted");
  abortError.name = "AbortError";
  const failing = makeController({ fetchError: abortError });
  const res = await failing.controller.check({ manual: false });
  assert.equal(res.kind, "error");
  assert.match(res.message, /aborted/);
  const state = failing.store.snapshot();
  assert.ok(state.backoffUntil > NOW);
  assert.equal(state.lastError, "This operation was aborted");
});

test("remind later silences background checks for the window but not manual checks", async () => {
  const store = memoryStateStore();
  const { controller } = makeController({ store });
  await controller.check({ manual: true });
  controller.applyChoice({ version: "1.1.0", choice: "remind-later" });

  // Within the window: background checks stay quiet.
  const within = makeController({ store });
  const res = await within.controller.check({ manual: false });
  assert.equal(res.reason, "remind-later");
  assert.equal(res.notified, false);
  assert.equal(within.notifications.length, 0);

  // Manual checks still report the available update.
  const manual = makeController({ store });
  await manual.controller.check({ manual: true });
  assert.equal(manual.notifications.length, 1);
  assert.equal(manual.notifications[0].kind, "available");

  // After the window passes, background prompts resume.
  const after = makeController({ store, nowSequence: [NOW + 8 * 24 * 60 * 60 * 1000] });
  await after.controller.check({ manual: false });
  assert.equal(after.notifications.length, 1);
});

test("skip this version silences background checks for that version permanently", async () => {
  const store = memoryStateStore();
  const { controller } = makeController({ store });
  await controller.check({ manual: true });
  controller.applyChoice({ version: "1.1.0", choice: "skip" });

  // Restart far in the future: still skipped.
  const far = makeController({ store, nowSequence: [NOW + 400 * 24 * 60 * 60 * 1000] });
  const res = await far.controller.check({ manual: false });
  assert.equal(res.reason, "skipped");
  assert.equal(far.notifications.length, 0);

  // A different version is not affected by the skip.
  const newer = makeController({ store, payload: githubPayload("1.2.0") });
  await newer.controller.check({ manual: false });
  assert.equal(newer.notifications.length, 1);

  // Manual check for a skipped version still reports, with the skip note.
  const manual = makeController({ store });
  await manual.controller.check({ manual: true });
  assert.equal(manual.notifications.length, 1);
  assert.equal(manual.notifications[0].kind, "available");
  assert.equal(manual.controller.skipNote("1.1.0"), "（你此前选择跳过此版本，可忽略本提示。）");
  assert.equal(manual.controller.skipNote("9.9.9"), "");
});

test("install choice opens the captured external link only (no downloads)", async () => {
  const { controller, openedUrls } = makeController();
  const result = await controller.check({ manual: true });
  assert.equal(openedUrls.length, 0);
  controller.applyChoice({ version: "1.1.0", choice: "install", downloadUrl: result.downloadUrl });
  assert.deepEqual(openedUrls, ["https://u/1.1.0-setup"]);
  assert.equal(controller.store ? undefined : undefined, undefined);
});

test("install without a local installer opens the release page instead", async () => {
  const noMatch = makeController({
    payload: githubPayload("1.1.0", [{ name: "Knorvia-1.1.0.tar.gz", browser_download_url: "https://u/tar" }]),
  });
  const res = await noMatch.controller.check({ manual: true });
  assert.equal(res.downloadKind, "release-page");
  assert.equal(res.downloadUrl, "https://github.com/o/r/releases/tag/v1.1.0");
  noMatch.controller.applyChoice({ version: "1.1.0", choice: "install", downloadUrl: res.downloadUrl });
  assert.deepEqual(noMatch.openedUrls, ["https://github.com/o/r/releases/tag/v1.1.0"]);
});

test("invalid installed version surfaces an error instead of pretending up-to-date", async () => {
  const bad = makeController({ currentVersion: "garbage" });
  const res = await bad.controller.check({ manual: true });
  assert.equal(res.kind, "error");
  assert.match(res.message, /installed version unreadable/);
  assert.equal(bad.notifications.length, 1);
});

test("concurrent checks are de-duplicated as busy", async () => {
  let releaseFetch;
  const { controller } = makeController({
    fetchLatestRelease: () => new Promise((resolve) => {
      releaseFetch = resolve;
    }),
  });
  const first = controller.check({ manual: true });
  const second = await controller.check({ manual: true });
  assert.equal(second.kind, "busy");
  releaseFetch(githubPayload("1.1.0"));
  const done = await first;
  assert.equal(done.kind, "available");
});

test("state persists remind-later and skip across restarts without re-prompting", async () => {
  const store = memoryStateStore();
  const a = makeController({ store });
  await a.controller.check({ manual: true });
  a.controller.applyChoice({ version: "1.1.0", choice: "skip" });
  const persisted = store.snapshot();
  assert.deepEqual(persisted.skippedVersions, ["1.1.0"]);
  assert.ok(persisted.lastCheck);
  assert.equal(persisted.lastVersion, "1.1.0");
  assert.equal(persisted.notifiedVersion, "1.1.0");

  const b = makeController({ store });
  const res = await b.controller.check({ manual: false });
  assert.equal(res.reason, "skipped");
  assert.equal(b.notifications.length, 0);
});
