"use strict";

// GitHub Releases self-update checker for the Knorvia desktop shell.
// Pure logic lives here (no Electron imports) so it is unit-testable with
// `node --test` and reusable by the updater stub script.
//
// Flow (v1): launch + every 24h, and a manual "检查更新" tray item, call
// https://api.github.com/repos/<owner>/<repo>/releases/latest, compare the
// semver tag with the installed version, and offer a browser download of
// the installer. Silent-check failures never surface to the user; manual
// checks report the outcome.

const DEFAULT_REPO = "accomplish-zrh/Knorvia";
const DEFAULT_API_BASE = "https://api.github.com";
const LATEST_RELEASE_PATH = (repo) => `/repos/${repo}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const USER_AGENT = "Knorvia-Desktop-Updater";

// --- semver -----------------------------------------------------------------

function parseSemver(value) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (text.toLowerCase().startsWith("v")) text = text.slice(1);
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] || "",
    raw: value,
  };
}

function compareSemver(a, b) {
  const pa = typeof a === "string" ? parseSemver(a) : a;
  const pb = typeof b === "string" ? parseSemver(b) : b;
  if (!pa || !pb) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  // Release > prerelease; prerelease labels compared lexicographically.
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

// --- release payload normalisation -------------------------------------------

function extractLatestRelease(payload) {
  if (!payload || typeof payload !== "object") return null;
  const version = parseSemver(payload.tag_name || payload.name || "");
  if (!version) return null;
  return {
    version: [version.major, version.minor, version.patch].join(".") + (version.pre ? `-${version.pre}` : ""),
    url: typeof payload.html_url === "string" ? payload.html_url : "",
    notes: typeof payload.body === "string" ? payload.body : "",
    assets: Array.isArray(payload.assets)
      ? payload.assets
          .filter((a) => a && typeof a.name === "string" && typeof a.browser_download_url === "string")
          .map((a) => ({
            name: a.name,
            url: a.browser_download_url,
            size: Number(a.size) || 0,
            digest: typeof a.digest === "string" ? a.digest : "",
          }))
      : [],
  };
}

function pickInstaller(release) {
  if (!release || !Array.isArray(release.assets) || release.assets.length === 0) return null;
  const score = (a) => {
    const n = a.name.toLowerCase();
    if (n.endsWith("-setup.exe")) return 3;
    if (n.endsWith(".exe")) return 2;
    if (n.endsWith("-portable.zip")) return 1;
    return 0;
  };
  let best = null;
  let bestScore = 0;
  for (const asset of release.assets) {
    const s = score(asset);
    if (s > bestScore) {
      best = asset;
      bestScore = s;
    }
  }
  return best;
}

// --- decision ----------------------------------------------------------------

// currentVersion: installed release ("1.0.0"). A plain semver comparison is
// the whole rule: portable swaps replace package.json together with the app,
// so the shell's version is always the truth on disk.
function decideUpdate({ currentVersion, latest, suppressed = "" }) {
  const release = extractLatestRelease(latest);
  if (!release) return { kind: "error", message: "release payload invalid" };
  const cmp = compareSemver(release.version, currentVersion);
  if (cmp > 0) {
    if (suppressed === release.version) return { kind: "up-to-date", release };
    return { kind: "available", release, installer: pickInstaller(release) };
  }
  return { kind: "up-to-date", release };
}

// --- suppression ------------------------------------------------------------

// "Remind me later" hides an exact version for 7 days.
function isSuppressed(suppression, version, now = Date.now()) {
  if (!suppression || suppression.version !== version) return false;
  return typeof suppression.until === "number" && suppression.until > now;
}

function suppressionFor(version, now = Date.now(), ms = CHECK_INTERVAL_MS * 7) {
  return { version, until: now + ms };
}

// --- network -----------------------------------------------------------------

function buildRequest({ repo = DEFAULT_REPO, apiBase = DEFAULT_API_BASE, token = "" }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return {
    url: `${apiBase}${LATEST_RELEASE_PATH(repo)}`,
    headers,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}

// fetchImpl mirrors node's fetch (returns a Response-like object).
async function fetchLatestRelease(options = {}) {
  const { fetchImpl, ...reqOpts } = options;
  const doFetch = fetchImpl || fetch;
  const req = buildRequest(reqOpts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const response = await doFetch(req.url, {
      headers: req.headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub replied ${response.status}`);
    return extractLatestRelease(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_REPO,
  CHECK_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  parseSemver,
  compareSemver,
  extractLatestRelease,
  pickInstaller,
  decideUpdate,
  isSuppressed,
  suppressionFor,
  buildRequest,
  fetchLatestRelease,
};
