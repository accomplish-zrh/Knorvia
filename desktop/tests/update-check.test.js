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
  skipFor,
  buildRequest,
  fetchLatestRelease,
  DEFAULT_REPO,
  CHECK_INTERVAL_MS,
} = require("../update-check");

test("parseSemver accepts plain and v-prefixed versions, rejects junk", () => {
  assert.deepEqual(parseSemver("1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: [],
    build: "",
    raw: "1.2.3",
  });
  assert.equal(parseSemver("v1.0.0").major, 1);
  assert.deepEqual(parseSemver("v2.10.4-beta.2").prerelease, ["beta", "2"]);
  assert.equal(parseSemver("1.2"), null);
  assert.equal(parseSemver("not-a-version"), null);
  assert.equal(parseSemver("01.2.3"), null); // no leading zeroes
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

test("P08 fix: prerelease identifiers compare numerically, not lexically", () => {
  assert.equal(compareSemver("1.2.0-beta.10", "1.2.0-beta.2"), 1);
  assert.equal(compareSemver("1.2.0-beta.2", "1.2.0-beta.10"), -1);
  assert.equal(compareSemver("1.0.0-alpha.1", "1.0.0-alpha"), 1);
});

test("P08 fix: full SemVer precedence order", () => {
  // Example ordering straight from the spec.
  const order = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let i = 0; i < order.length; i += 1) {
    for (let j = 0; j < order.length; j += 1) {
      const expected = Math.sign(i - j);
      assert.equal(Math.sign(compareSemver(order[i], order[j])), expected, `${order[i]} vs ${order[j]}`);
    }
  }
});

test("P08 fix: build metadata is parsed but ignored by comparison", () => {
  const parsed = parseSemver("1.2.0+build.7");
  assert.deepEqual(parsed.prerelease, []);
  assert.equal(parsed.build, "build.7");
  assert.equal(compareSemver("1.2.0+build.7", "1.2.0"), 0);
  assert.equal(compareSemver("1.2.0", "1.2.0+build.7"), 0);
  assert.equal(compareSemver("1.2.0+build.7", "1.2.0+build.99"), 0);
  assert.equal(compareSemver("1.2.1+build.7", "1.2.0+build.99"), 1);
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

test("P08 fix: normalisation is idempotent across the main.js round trip", () => {
  const payload = {
    tag_name: "v1.2.0",
    html_url: "https://github.com/o/r/releases/tag/v1.2.0",
    body: "notes",
    assets: [{ name: "Knorvia-1.2.0-setup.exe", browser_download_url: "https://u/setup", size: 300 }],
  };
  // main.js used to re-wrap the normalised release (url assets) into a
  // decideUpdate call, which dropped every installer.
  const normalized = extractLatestRelease(payload);
  const decision = decideUpdate({
    currentVersion: "1.0.0",
    latest: { tag_name: normalized.version, html_url: normalized.url, body: normalized.notes, assets: normalized.assets },
  });
  assert.equal(decision.kind, "available");
  assert.ok(decision.installer, "installer survives the round trip");
  assert.equal(decision.installer.url, "https://u/setup");
  assert.equal(decision.downloadKind, "installer");
  assert.equal(decision.downloadUrl, "https://u/setup");

  // Passing the normalised release directly also works.
  const direct = decideUpdate({ currentVersion: "1.0.0", release: normalized });
  assert.equal(direct.installer.url, "https://u/setup");
  // And normalising twice is a no-op.
  assert.deepEqual(extractLatestRelease(normalized), normalized);
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
  assert.equal(pickInstaller({ assets }, { platform: "win32", arch: "x64" }).name, "Knorvia-1.2.0-setup.exe");
  assert.equal(pickInstaller({ assets: [assets[0], assets[2]] }, { platform: "win32", arch: "x64" }).name, "Knorvia-1.2.0-portable.zip");
  assert.equal(pickInstaller({ assets: [] }, { platform: "win32", arch: "x64" }), null);
  assert.equal(pickInstaller(null), null);
});

test("P08 fix: installer selection honours platform and architecture", () => {
  const mixed = {
    version: "1.2.0",
    url: "https://x/rel",
    assets: [
      { name: "Knorvia-1.2.0-x64-setup.exe", url: "https://u/x64-setup", size: 300 },
      { name: "Knorvia-1.2.0-arm64-setup.exe", url: "https://u/arm64-setup", size: 300 },
      { name: "Knorvia-1.2.0-x64-portable.zip", url: "https://u/x64-zip", size: 300 },
      { name: "SHA256SUMS.txt", url: "https://u/sums", size: 10 },
    ],
  };
  assert.equal(pickInstaller(mixed, { platform: "win32", arch: "x64" }).url, "https://u/x64-setup");
  assert.equal(pickInstaller(mixed, { platform: "win32", arch: "arm64" }).url, "https://u/arm64-setup");

  // Only wrong-arch assets → no local installer; callers fall back to the
  // release page.
  const armOnly = { version: "1.2.0", url: "https://x/rel", assets: [mixed.assets[1]] };
  assert.equal(pickInstaller(armOnly, { platform: "win32", arch: "x64" }), null);

  // Arch-neutral assets remain eligible when no arch-tagged match exists.
  const neutral = { version: "1.2.0", url: "https://x/rel", assets: [{ name: "Knorvia-1.2.0-setup.exe", url: "https://u/setup" }] };
  assert.equal(pickInstaller(neutral, { platform: "win32", arch: "x64" }).url, "https://u/setup");

  // Explicit arch match outranks an arch-neutral candidate of the same type.
  const both = { version: "1.2.0", url: "https://x/rel", assets: [neutral.assets[0], mixed.assets[0]] };
  assert.equal(pickInstaller(both, { platform: "win32", arch: "x64" }).url, "https://u/x64-setup");

  // Non-Windows platforms have no local installer.
  assert.equal(pickInstaller(mixed, { platform: "darwin", arch: "arm64" }), null);
  assert.equal(pickInstaller(mixed, { platform: "linux", arch: "x64" }), null);
});

test("P08 fix: decideUpdate reports errors instead of silently claiming up-to-date", () => {
  const latest = { tag_name: "v1.1.0", html_url: "https://x", assets: [{ name: "Knorvia-1.1.0-setup.exe", browser_download_url: "https://x/i" }] };
  const up = decideUpdate({ currentVersion: "1.0.0", latest });
  assert.equal(up.kind, "available");
  assert.equal(up.installer.name, "Knorvia-1.1.0-setup.exe");

  assert.equal(decideUpdate({ currentVersion: "1.1.0", latest }).kind, "up-to-date");
  assert.equal(decideUpdate({ currentVersion: "2.0.0", latest }).kind, "up-to-date");

  // Invalid installed version → error, never "up to date".
  const badCurrent = decideUpdate({ currentVersion: "not-a-version", latest });
  assert.equal(badCurrent.kind, "error");
  assert.match(badCurrent.message, /installed version unreadable/);

  // Invalid payload → error.
  assert.equal(decideUpdate({ currentVersion: "1.0.0", latest: { message: "404" } }).kind, "error");
  assert.equal(decideUpdate({ currentVersion: undefined, latest }).kind, "error");
});

test("P08 fix: no matching installer falls back to the release page", () => {
  const linuxOnly = {
    tag_name: "v1.1.0",
    html_url: "https://github.com/o/r/releases/tag/v1.1.0",
    assets: [{ name: "Knorvia-1.1.0.tar.gz", browser_download_url: "https://x/tar" }],
  };
  const decision = decideUpdate({ currentVersion: "1.0.0", latest: linuxOnly, platform: "win32", arch: "x64" });
  assert.equal(decision.kind, "available");
  assert.equal(decision.installer, null);
  assert.equal(decision.downloadKind, "release-page");
  assert.equal(decision.downloadUrl, "https://github.com/o/r/releases/tag/v1.1.0");
  assert.match(decision.downloadHint, /发布页/);
});

test("suppression window is honoured by isSuppressed", () => {
  const now = Date.parse("2026-09-02T12:00:00Z");
  const s = suppressionFor("1.1.0", now);
  assert.equal(isSuppressed(s, "1.1.0", now), true);
  assert.equal(isSuppressed(s, "1.2.0", now), false);
  assert.equal(isSuppressed(s, "1.1.0", s.until + 1), false);
  assert.equal(isSuppressed(null, "1.1.0", now), false);
});

test("P08 fix: skip suppression is persistent (until === null)", () => {
  const s = skipFor("1.1.0");
  assert.equal(isSuppressed(s, "1.1.0", Date.now()), true);
  assert.equal(isSuppressed(s, "1.1.0", Date.parse("2099-01-01T00:00:00Z")), true);
  assert.equal(isSuppressed(s, "1.2.0", Date.now()), false);
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
