"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseSemver,
  compareSemver,
  extractLatestRelease,
  pickInstaller,
  decideUpdate,
  isSuppressed,
  suppressionFor,
  buildRequest,
  fetchLatestRelease,
  DEFAULT_REPO,
  CHECK_INTERVAL_MS,
} = require("../update-check");

test("parseSemver accepts plain and v-prefixed versions, rejects junk", () => {
  assert.deepEqual(parseSemver("1.2.3"), { major: 1, minor: 2, patch: 3, pre: "", raw: "1.2.3" });
  assert.equal(parseSemver("v1.0.0").major, 1);
  assert.equal(parseSemver("v2.10.4-beta.2").pre, "beta.2");
  assert.equal(parseSemver("1.2"), null);
  assert.equal(parseSemver("not-a-version"), null);
  assert.equal(parseSemver(undefined), null);
});

test("compareSemver orders numbers and keeps releases above prereleases", () => {
  assert.equal(compareSemver("1.0.0", "1.0.1"), -1);
  assert.equal(compareSemver("1.10.0", "1.9.9"), 1);
  assert.equal(compareSemver("2.0.0", "1.99.99"), 1);
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("1.0.1", "v1.0.1"), 0);
  assert.equal(compareSemver("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0"), -1);
});

test("extractLatestRelease normalises the GitHub payload", () => {
  const release = extractLatestRelease({
    tag_name: "v1.2.0",
    html_url: "https://github.com/o/r/releases/tag/v1.2.0",
    body: "notes",
    assets: [
      { name: "Knorvia-1.2.0-setup.exe", browser_download_url: "https://u/setup", size: 300, digest: "sha256:ab" },
      { name: "notes.txt", browser_download_url: "https://u/notes", size: 10 },
      { name: "broken-no-url" },
    ],
  });
  assert.equal(release.version, "1.2.0");
  assert.equal(release.assets.length, 2);
  assert.equal(release.assets[0].digest, "sha256:ab");
});

test("extractLatestRelease rejects payloads without a usable tag", () => {
  assert.equal(extractLatestRelease(null), null);
  assert.equal(extractLatestRelease({}), null);
  assert.equal(extractLatestRelease({ tag_name: "nightly" }), null);
});

test("pickInstaller prefers NSIS setup over exe over portable zip", () => {
  const assets = [
    { name: "Knorvia-1.2.0-portable.zip", url: "u1", size: 1 },
    { name: "Knorvia-1.2.0-setup.exe", url: "u2", size: 2 },
    { name: "SHA256SUMS.txt", url: "u3", size: 3 },
  ];
  assert.equal(pickInstaller({ assets }).name, "Knorvia-1.2.0-setup.exe");
  assert.equal(pickInstaller({ assets: [assets[0], assets[2]] }).name, "Knorvia-1.2.0-portable.zip");
  assert.equal(pickInstaller({ assets: [] }), null);
  assert.equal(pickInstaller(null), null);
});

test("decideUpdate flags a newer release and honours suppression", () => {
  const latest = { tag_name: "v1.1.0", html_url: "https://x", assets: [{ name: "Knorvia-1.1.0-setup.exe", browser_download_url: "https://x/i" }] };
  const up = decideUpdate({ currentVersion: "1.0.0", latest });
  assert.equal(up.kind, "available");
  assert.equal(up.installer.name, "Knorvia-1.1.0-setup.exe");

  const same = decideUpdate({ currentVersion: "1.1.0", latest });
  assert.equal(same.kind, "up-to-date");

  const older = decideUpdate({ currentVersion: "2.0.0", latest });
  assert.equal(older.kind, "up-to-date");

  const hidden = decideUpdate({ currentVersion: "1.0.0", latest, suppressed: "1.1.0" });
  assert.equal(hidden.kind, "up-to-date");

  const garbage = decideUpdate({ currentVersion: "1.0.0", latest: { message: "404" } });
  assert.equal(garbage.kind, "error");
});

test("suppression window is honoured by isSuppressed", () => {
  const now = Date.parse("2026-09-02T12:00:00Z");
  const s = suppressionFor("1.1.0", now);
  assert.equal(isSuppressed(s, "1.1.0", now), true);
  assert.equal(isSuppressed(s, "1.2.0", now), false);
  assert.equal(isSuppressed(s, "1.1.0", s.until + 1), false);
  assert.equal(isSuppressed(null, "1.1.0", now), false);
});

test("buildRequest targets releases/latest with GitHub headers", () => {
  const req = buildRequest({});
  assert.ok(req.url.endsWith(`/repos/${DEFAULT_REPO}/releases/latest`));
  assert.equal(req.headers.Accept, "application/vnd.github+json");
  assert.ok(!("Authorization" in req.headers));
  const auth = buildRequest({ token: "ghp_x" });
  assert.equal(auth.headers.Authorization, "Bearer ghp_x");
});

test("fetchLatestRelease parses a Response and propagates failures", async () => {
  const fakeFetch = async (url, init) => {
    assert.ok(url.includes("releases/latest"));
    assert.ok(init.signal);
    return { ok: true, json: async () => ({ tag_name: "v9.9.9", assets: [] }) };
  };
  const release = await fetchLatestRelease({ fetchImpl: fakeFetch });
  assert.equal(release.version, "9.9.9");

  const failFetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(() => fetchLatestRelease({ fetchImpl: failFetch }), /403/);
});

test("update cadence constant is 24 hours", () => {
  assert.equal(CHECK_INTERVAL_MS, 24 * 60 * 60 * 1000);
});
