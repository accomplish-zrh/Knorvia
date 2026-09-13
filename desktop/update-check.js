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
//
// v2 (P08): spec-faithful SemVer comparison (numeric prerelease identifiers,
// build metadata ignored), idempotent release normalisation (raw GitHub
// payloads and already-normalised releases both accepted), and platform/arch
// aware installer selection with an explicit release-page fallback.

const DEFAULT_REPO = "accomplish-zrh/Knorvia";
const DEFAULT_API_BASE = "https://api.github.com";
const LATEST_RELEASE_PATH = (repo) => `/repos/${repo}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const USER_AGENT = "Knorvia-Desktop-Updater";

// --- semver (https://semver.org/#backus-naur-form-grammar-for-valid-semver-versions) ---

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseSemver(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const body = text.toLowerCase().startsWith("v") ? text.slice(1) : text;
  const match = SEMVER_RE.exec(body);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
    build: match[5] || "",
    raw: value,
  };
}

function isNumericIdentifier(s) {
  return /^\d+$/.test(s);
}

function comparePrereleaseIdentifier(a, b) {
  const aNumeric = isNumericIdentifier(a);
  const bNumeric = isNumericIdentifier(b);
  if (aNumeric && bNumeric) {
    const an = Number(a);
    const bn = Number(b);
    if (an !== bn) return an < bn ? -1 : 1;
    return 0;
  }
  // Numeric identifiers always have lower precedence than alphanumeric.
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}

// Build metadata is parsed but ignored: it does not affect precedence, and
// "1.2.0+build.7" equals "1.2.0".
function compareSemver(a, b) {
  const pa = typeof a === "string" ? parseSemver(a) : a;
  const pb = typeof b === "string" ? parseSemver(b) : b;
  if (!pa || !pb) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  const preA = Array.isArray(pa.prerelease) ? pa.prerelease : [];
  const preB = Array.isArray(pb.prerelease) ? pb.prerelease : [];
  if (preA.length === 0 && preB.length === 0) return 0;
  // A release has higher precedence than a prerelease.
  if (preA.length === 0) return 1;
  if (preB.length === 0) return -1;
  const shared = Math.min(preA.length, preB.length);
  for (let i = 0; i < shared; i += 1) {
    const c = comparePrereleaseIdentifier(preA[i], preB[i]);
    if (c !== 0) return c;
  }
  // A larger set of prerelease identifiers has higher precedence.
  if (preA.length !== preB.length) return preA.length < preB.length ? -1 : 1;
  return 0;
}

// --- release payload normalisation -------------------------------------------

function normalizeAsset(asset) {
  if (!asset || typeof asset.name !== "string") return null;
  const url =
    (typeof asset.browser_download_url === "string" && asset.browser_download_url) ||
    (typeof asset.url === "string" && asset.url) ||
    "";
  if (!url) return null;
  return {
    name: asset.name,
    url,
    size: Number(asset.size) || 0,
    digest: typeof asset.digest === "string" ? asset.digest : "",
  };
}

// Accepts a raw GitHub release payload (browser_download_url assets, tag_name,
// html_url, body) or an already-normalised release (url assets, version,
// notes). Normalising twice yields the same result, so decideUpdate can run
// directly on a release that came from this function.
function extractLatestRelease(payload) {
  if (!payload || typeof payload !== "object") return null;
  const version = parseSemver(payload.tag_name || payload.version || payload.name || "");
  if (!version) return null;
  return {
    version:
      [version.major, version.minor, version.patch].join(".") +
      (version.prerelease.length ? `-${version.prerelease.join(".")}` : ""),
    tag: (typeof payload.tag_name === "string" && payload.tag_name) ||
      (typeof payload.tag === "string" && payload.tag) || "",
    build: version.build,
    url:
      (typeof payload.html_url === "string" && payload.html_url) ||
      (typeof payload.url === "string" && payload.url) ||
      "",
    notes:
      (typeof payload.body === "string" && payload.body) ||
      (typeof payload.notes === "string" && payload.notes) ||
      "",
    assets: Array.isArray(payload.assets)
      ? payload.assets.map(normalizeAsset).filter(Boolean)
      : [],
  };
}

// --- installer selection ------------------------------------------------------

const ARCH_ALIASES = [
  ["arm64", ["arm64", "aarch64"]],
  ["x64", ["x64", "x86_64", "amd64"]],
];

function detectAssetArch(name) {
  const lower = name.toLowerCase();
  for (const [arch, aliases] of ARCH_ALIASES) {
    for (const alias of aliases) {
      if (lower.includes(alias)) return arch;
    }
  }
  return "";
}

// Picks the best Windows installer for the running device. Assets tagged with
// a different architecture are excluded; arch-neutral assets are eligible but
// ranked below an exact arch match. Non-Windows platforms have no local
// installer in this distribution and return null so callers fall back to the
// release page.
function pickInstaller(release, { platform = process.platform, arch = process.arch } = {}) {
  if (!release || !Array.isArray(release.assets)) return null;
  if (platform !== "win32") return null;
  let best = null;
  let bestScore = 0;
  for (const asset of release.assets) {
    if (!asset || typeof asset.name !== "string" || !asset.url) continue;
    const n = asset.name.toLowerCase();
    const assetArch = detectAssetArch(n);
    if (assetArch && arch && assetArch !== arch) continue;
    let score = 0;
    if (n.endsWith("-setup.exe")) score = 6;
    else if (n.endsWith(".exe")) score = 5;
    else if (n.endsWith("-portable.zip")) score = 3;
    else if (n.endsWith(".zip")) score = 2;
    if (score === 0) continue;
    if (assetArch) score += 1; // prefer an explicit arch match over arch-neutral
    if (score > bestScore) {
      best = asset;
      bestScore = score;
    }
  }
  return best;
}

// --- decision ----------------------------------------------------------------

// currentVersion: installed release ("1.0.0"). An unusable installed version
// is an error, never a silent "up to date". `release` accepts an
// already-normalised release; `latest` accepts a raw GitHub payload (at most
// one of them is required).
function decideUpdate({ currentVersion, latest, release, platform, arch } = {}) {
  const rel = release ? extractLatestRelease(release) : extractLatestRelease(latest);
  if (!rel) return { kind: "error", message: "release payload invalid", release: null };
  const current = parseSemver(currentVersion);
  if (!current) {
    return {
      kind: "error",
      message: `installed version unreadable: ${JSON.stringify(currentVersion)}`,
      release: rel,
    };
  }
  const cmp = compareSemver(rel.version, current);
  if (cmp <= 0) return { kind: "up-to-date", release: rel };
  const installer = pickInstaller(rel, { platform, arch });
  return {
    kind: "available",
    release: rel,
    installer,
    downloadKind: installer ? "installer" : "release-page",
    downloadUrl: installer ? installer.url : rel.url,
    downloadHint: installer
      ? ""
      : "未找到与当前设备匹配的安装包，将打开发布页选择下载。",
  };
}

// --- reminder / skip suppression ---------------------------------------------

// "Remind me later" hides an exact version for a window (default 7 days).
function isSuppressed(suppression, version, now = Date.now()) {
  if (!suppression || suppression.version !== version) return false;
  if (suppression.until === null) return true; // permanent skip
  return typeof suppression.until === "number" && suppression.until > now;
}

function suppressionFor(version, now = Date.now(), ms = CHECK_INTERVAL_MS * 7) {
  return { version, until: now + ms };
}

// "Skip this version" persists until a different version is published.
function skipFor(version) {
  return { version, until: null };
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
  normalizeAsset,
  pickInstaller,
  decideUpdate,
  isSuppressed,
  suppressionFor,
  skipFor,
  buildRequest,
  fetchLatestRelease,
};
