const { app, BrowserWindow, dialog, ipcMain, protocol, nativeTheme, safeStorage, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { Readable } = require("stream");
const {
  DesktopAssetStreamBroker,
  isDesktopDirectFilePath,
} = require("./protocol-stream");
const {
  WINDOW_CORNER_RADIUS,
  browserWindowChrome,
  sanitizeOverlay,
  windowMaterialForFrost,
  applyWindowMaterial,
  fromMainWindow,
} = require("./window-chrome");
const { applyWindowCornerRegion } = require("./win32-corners");
const { nativeBackdropSupported, readAppearance, saveAppearance, validAppearance, palettes } = require("./window-appearance");
const { startupScreen } = require("./startup-screen");
const wallpaper = require("./wallpaper");
const updateCheck = require("./update-check");
const { isAgentApiPath } = require("./kernel-engine");
const { createNativeRpcRouter, errorResponse } = require("./native-rpc-router");
const { createNativeRuntime } = require("./native-runtime");
const { createWorkspacePreview } = require("./workspace-preview");
const { createPersonalLibrary } = require("./personal-library");
const { createMediaStudio } = require("./media-studio");
const { createTurnNotifier } = require("./turn-notifications");
const { createExtensionManager, extensionConnectionHandlers } = require("./extension-manager");
const { createSshSessions } = require("./ssh-session");
const { createWorktreeSnapshots } = require("./worktree-snapshots");
const { createCliBackendHandlers } = require("./cli-backends");
const { createLearningPack } = require("./learning-pack");
const { createCuratedCatalog } = require("./curated-catalog");
const { createStudioMcp } = require("./studio-mcp");
const { createCreativeCliService } = require("./creative-cli-service");
const { createOpenmaicCourse } = require("./openmaic-course");
const { createLibraryImageOps } = require("./library-image-ops");
const { keepWindowInBackground } = require("./window-lifecycle");
const { createCliDispatchBridge } = require("./cli-dispatch");
const { createWorkspaceTerminal } = require("./workspace-terminal");
const { createEncryptedConnectionStore } = require("./connection-config");
const { createDesktopPathActions } = require("./desktop-path-actions");
const { resolveNodeLauncher, resolveWebRenderer } = require("./web-renderer");

let mainWindow;
let engine;
let kernelEngine;
let nativeRuntime;
let nativeRpc;
let workspaceTerminals;
let mediaStudio;
let studioMcp;
let extensionManager;
let sshSessions;
let worktreeSnapshots;
let cliBackendHost;
let cliDispatch;
let learningPack;
let curatedCatalog;
let creativeCliService;
let shutdownPromise;
let removeNativeRpcNotification;
let turnNotifier;
let removeRuntimeEngine;
let domainWorker;
let frontend;
const kernelSockets = new Set();
let shuttingDown = false;
let requestSequence = 0;
let recentOutput = "";
let fatalErrorShown = false;
let assetStreamBroker;
const pendingRequests = new Map();
const RENDERER_READY_TIMEOUT_S = 60;
const ENGINE_SHUTDOWN_GRACE_MS = 3000;
// Keep the desktop shell's version in lockstep with desktop/package.json so
// the dev-mode runtime path never needs a manual edit on release bumps.
const DESKTOP_VERSION = require("./package.json").version;

protocol.registerSchemesAsPrivileged([
  { scheme: "knorvia", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// Win32 stays non-layered so maximize/restore work. 16px corners are
// applied with SetWindowRgn (win32-corners.js).

let liveBackdrop = false;

function runtimeRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "runtime")
    : path.resolve(__dirname, "..", "dist", `Knorvia-${DESKTOP_VERSION}-portable`, "runtime");
}

function moveLegacyWorkspace(parent, target) {
  const legacyProduct = ["Deep", "Tutor"].join("");
  const candidates = [
    path.join(parent, `${legacyProduct}-data`),
    path.join(parent, legacyProduct, "workspace"),
  ];
  if (fs.existsSync(target)) return target;
  for (const legacy of candidates) {
    if (!fs.existsSync(legacy)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(legacy, target);
      capture(`Migrated legacy workspace to ${target}\n`);
      return target;
    } catch (error) {
      throw new Error(`无法迁移旧版工作区：${error.message}`);
    }
  }
  return target;
}

function workspaceRoot() {
  let root;
  if (!app.isPackaged) root = path.resolve(__dirname, "..", "desktop-data");
  else if (process.env.PORTABLE_EXECUTABLE_DIR) {
    const parent = process.env.PORTABLE_EXECUTABLE_DIR;
    root = moveLegacyWorkspace(parent, path.join(parent, "Knorvia-data"));
  } else if (fs.existsSync(path.join(path.dirname(app.getPath("exe")), "portable.marker"))) {
    const parent = path.dirname(app.getPath("exe"));
    root = moveLegacyWorkspace(parent, path.join(parent, "Knorvia-data"));
  }
  else {
    root = moveLegacyWorkspace(
      app.getPath("appData"),
      path.join(app.getPath("userData"), "workspace"),
    );
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function ensureDesktopDefaults(root) {
  const settingsDir = path.join(root, "data", "user", "settings");
  const interfaceFile = path.join(settingsDir, "interface.json");
  if (!fs.existsSync(interfaceFile)) {
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(interfaceFile, JSON.stringify({
      theme: "snow",
      language: "zh",
      response_language: "zh",
      sidebar_description: "Knorvia 通用 Agent 工作台",
    }, null, 2), "utf8");
  } else {
    try {
      const settings = JSON.parse(fs.readFileSync(interfaceFile, "utf8"));
      if (
        settings.sidebar_description === "Knorvia 智能学习助手"
        || settings.sidebar_description === "Knorvia 智能学习与知识工作台"
      ) {
        settings.sidebar_description = "Knorvia 通用 Agent 工作台";
        fs.writeFileSync(interfaceFile, JSON.stringify(settings, null, 2), "utf8");
      }
    } catch (error) {
      capture(`Could not migrate interface branding: ${error.message}\n`);
    }
  }
}

function readInterfaceSettings() {
  try {
    const file = path.join(workspaceRoot(), "data", "user", "settings", "interface.json");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function storedUiTheme() {
  const appearance = readAppearance(app.getPath("userData"));
  if (appearance) return appearance.theme;
  const parsed = readInterfaceSettings();
  return parsed && typeof parsed.theme === "string" ? parsed.theme : null;
}

function storedUiFrost() {
  const appearance = readAppearance(app.getPath("userData"));
  if (appearance) return appearance.frost;
  const parsed = readInterfaceSettings();
  if (!parsed) return false;
  if (typeof parsed.window_frost === "boolean") return parsed.window_frost;
  return parsed.theme === "glass";
}

function loadingPage(glass) {
  const logo = fs.readFileSync(path.join(__dirname, "build", "logo.png")).toString("base64");
  const selected = storedUiTheme();
  const theme = Object.hasOwn(palettes, selected) ? selected : nativeTheme.shouldUseDarkColors ? "dark" : "snow";
  const appearance = readAppearance(app.getPath("userData"));
  const html = startupScreen({ logo, theme, frost: glass, reducedMotion: appearance?.reducedMotion === true });
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function isFilledScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isMaximized() || mainWindow.isFullScreen();
}

function emitWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("knorvia:window-state", {
    maximized: isFilledScreen(),
  });
}

function refreshWindowShape() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  applyWindowCornerRegion(mainWindow, WINDOW_CORNER_RADIUS, {
    square: isFilledScreen(),
  });
  emitWindowState();
}

function createWindow() {
  const theme = storedUiTheme();
  const backdropSupported = nativeBackdropSupported(process.platform, os.release());
  const frost = storedUiFrost() && backdropSupported;
  if (theme && Object.hasOwn(palettes, theme)) nativeTheme.themeSource = palettes[theme].dark ? "dark" : "light";
  const chrome = browserWindowChrome(process.platform, {
    dark: nativeTheme.shouldUseDarkColors,
    theme,
    frost,
  });
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1050, minHeight: 700, show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.ico"),
    ...chrome,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), contextIsolation: true,
      nodeIntegration: false, sandbox: true,
      additionalArguments: [`--knorvia-backdrop-supported=${backdropSupported}`],
    },
  });
  liveBackdrop = frost;
  if (frost) applyWindowMaterial(mainWindow, process.platform, windowMaterialForFrost(true, theme || "snow", process.platform));
  mainWindow.loadURL(loadingPage(frost));
  mainWindow.once("ready-to-show", () => {
    if (liveBackdrop) applyWindowMaterial(mainWindow, process.platform, windowMaterialForFrost(true, storedUiTheme() || "snow", process.platform));
    mainWindow.show();
    refreshWindowShape();
  });
  const refreshBackdrop = () => {
    refreshWindowShape();
    if (!liveBackdrop || !mainWindow || mainWindow.isDestroyed()) return;
    applyWindowMaterial(mainWindow, process.platform, windowMaterialForFrost(true, storedUiTheme() || "snow", process.platform));
  };
  mainWindow.on("maximize", refreshBackdrop);
  mainWindow.on("unmaximize", refreshBackdrop);
  mainWindow.on("restore", refreshBackdrop);
  mainWindow.on("resized", refreshBackdrop);
  mainWindow.on("enter-full-screen", refreshBackdrop);
  mainWindow.on("leave-full-screen", refreshBackdrop);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternal(url); return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("knorvia://app/")) {
      event.preventDefault();
      openAllowedExternal(url);
    }
  });

  setupTray();
  keepWindowInBackground(mainWindow, () => Boolean(tray) && !shuttingDown && !process.env.KNORVIA_DESKTOP_SMOKE);
  setupGlobalHotkey();
  scheduleUpdateChecks();
}

let tray = null;

function setupTray() {
  try {
    const { Tray, Menu, nativeImage } = require("electron");
    const iconPath = path.join(__dirname, "build", "icon.ico");
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip("Knorvia · 关闭窗口后任务继续运行");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 Knorvia", click: () => {
          if (!mainWindow) return;
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show(); mainWindow.focus();
        } },
      { type: "separator" },
      { label: "检查更新…", click: () => { void runUpdateCheck(true); } },
      { type: "separator" },
      { label: "退出并停止后台任务", click: () => app.quit() },
    ]));
    tray.on("click", () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
    });
  } catch (error) {
    console.warn("[desktop] tray unavailable:", error.message);
  }
}

// --- self-update check ------------------------------------------------------
// Poll GitHub Releases (public repo, no token needed) at startup and every
// 24h. Manual checks (tray / renderer) always report; automatic ones stay
// silent on success-with-no-update and on every failure.

let updateTimer = null;
let updateChecking = false;

function updateStatePath() {
  return path.join(app.getPath("userData"), "update-state.json");
}

function readUpdateState() {
  try {
    return JSON.parse(fs.readFileSync(updateStatePath(), "utf8")) || {};
  } catch {
    return {};
  }
}

function writeUpdateState(state) {
  try {
    fs.writeFileSync(updateStatePath(), JSON.stringify(state, null, 2));
  } catch (error) {
    console.warn("[desktop] update state write failed:", error.message);
  }
}

function releaseNotesExcerpt(release) {
  if (!release || !release.notes) return "";
  const lines = release.notes.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, 3).join("\n");
}

async function runUpdateCheck(manual) {
  if (updateChecking) return { kind: "busy" };
  updateChecking = true;
  try {
    const state = readUpdateState();
    const release = await updateCheck.fetchLatestRelease({
      token: process.env.KNORVIA_GITHUB_TOKEN || "",
    });
    if (!release) return { kind: "error", message: "release payload invalid" };
    const decision = updateCheck.decideUpdate({
      currentVersion: app.getVersion(),
      latest: { tag_name: release.version, html_url: release.url, body: release.notes, assets: release.assets },
      suppressed: updateCheck.isSuppressed(state.suppressed, release.version) ? release.version : "",
    });
    writeUpdateState({ ...state, lastCheck: new Date().toISOString(), lastVersion: release.version });
    if (manual) {
      if (decision.kind === "available") promptUpdate(decision);
      else reportUpdateOutcome(decision.kind === "up-to-date", release);
    }
    return decision;
  } catch (error) {
    console.warn("[desktop] update check failed:", error.message);
    if (manual) reportUpdateOutcome(false, null, error.message);
    return { kind: "error", message: error.message };
  } finally {
    updateChecking = false;
  }
}

function reportUpdateOutcome(success, release, errorMessage) {
  const options = success
    ? { type: "info", title: "检查更新", message: "已是最新版本", detail: `当前 ${app.getVersion()} 已是最新（最新正式版本 ${release ? release.version : "-"}）。` }
    : { type: "warning", title: "检查更新", message: "检查更新失败", detail: errorMessage || "暂时无法连接 GitHub，请稍后再试。" };
  dialog.showMessageBox(mainWindow, options)
    .catch((error) => console.warn("[desktop] update result dialog failed:", error.message));
}

function promptUpdate(decision) {
  const { release, installer } = decision;
  const detail = releaseNotesExcerpt(release);
  const buttons = ["现在更新", "稍后提醒", "跳过此版本"];
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: `发现新版本 Knorvia ${release.version}`,
    message: `当前版本 ${app.getVersion()} → 新版本 ${release.version}`,
    detail: detail || "前往发布页下载安装包。",
    buttons,
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }).then(({ response }) => {
    if (response === 2) {
      writeUpdateState({ ...readUpdateState(), suppressed: updateCheck.suppressionFor(release.version) });
      return;
    }
    if (response === 1) return;
    const url = installer?.url || release.url;
    if (url) void shell.openExternal(url);
  }).catch((error) => console.warn("[desktop] update dialog failed:", error.message));
}

function scheduleUpdateChecks() {
  setTimeout(() => { void runUpdateCheck(false); }, 30 * 1000);
  updateTimer = setInterval(() => { void runUpdateCheck(false); }, updateCheck.CHECK_INTERVAL_MS);
  updateTimer.unref?.();
}

function setupGlobalHotkey() {
  try {
    const { globalShortcut } = require("electron");
    globalShortcut.register("Control+Alt+K", () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    });
  } catch (error) {
    console.warn("[desktop] global hotkey unavailable:", error.message);
  }
}

function openAllowedExternal(rawUrl) {
  try {
    const target = new URL(rawUrl);
    if (!["https:", "http:", "mailto:"].includes(target.protocol)) {
      capture(`Blocked external URL scheme: ${target.protocol}\n`);
      return false;
    }
    void shell.openExternal(target.toString());
    return true;
  } catch (error) {
    capture(`Blocked invalid external URL: ${error.message}\n`);
    return false;
  }
}

function capture(chunk) {
  // Never retain a provider credential in the in-memory diagnostics shown by
  // the crash dialog. The native connection code does not log keys; this is a
  // defense-in-depth scrub for child-process diagnostics we do not control.
  const text = String(chunk || "")
    .replace(/(KNORVIA_PROVIDER_API_KEY\s*[=:]\s*)[^\s"']+/gi, "$1[redacted]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, "$1[redacted]");
  recentOutput = (recentOutput + text).slice(-12000);
}

// Packaged Windows applications do not own a console. Electron or a dependency
// may still try to log while the inherited pipe is being closed; consuming the
// stream error keeps that routine condition from becoming an uncaught EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", (error) => {
    if (error?.code !== "EPIPE") capture(`Desktop log stream failed: ${error?.message || error}\n`);
  });
}

function encodedHttpError(status, message) {
  return {
    kind: "http_response",
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(JSON.stringify({ detail: message }), "utf8").toString("base64"),
  };
}

function resolvePendingRequests(status, message) {
  for (const [id, pending] of pendingRequests) {
    pendingRequests.delete(id);
    pending.resolve({ id, ...encodedHttpError(status, message) });
  }
}

function installRendererProtocol(pipeName) {
  protocol.handle("knorvia", async (request) => {
    const source = new URL(request.url);
    if (source.hostname !== "app") return new Response("Not found", { status: 404 });
    if (isDesktopDirectFilePath(source.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return assetStreamBroker.open(request, `${source.pathname}${source.search}`);
    }
    const body = request.method === "GET" || request.method === "HEAD"
      ? null : Buffer.from(await request.arrayBuffer());
    const forward = () => new Promise((resolve, reject) => {
      const outgoing = http.request({
          socketPath: pipeName,
          method: request.method,
          path: `${source.pathname}${source.search}`,
          headers: Object.fromEntries(request.headers.entries()),
        }, (incoming) => {
          resolve(new Response(request.method === "HEAD" ? null : Readable.toWeb(incoming), {
            status: incoming.statusCode || 500,
            headers: incoming.headers,
          }));
        });
      outgoing.on("error", reject);
      if (body) outgoing.write(body);
      outgoing.end();
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try { return await forward(); }
      catch (error) {
        capture(`Renderer request failed (${attempt + 1}/4): ${error.message}\n`);
        if (attempt < 3 && !shuttingDown)
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    return new Response("Knorvia 页面服务暂时不可用，请重新打开应用。", {
      status: 503, headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });
}

function sendBridge(message) {
  const worker = domainWorker;
  if (shuttingDown || !worker?.stdin?.writable || worker.stdin.destroyed) return false;
  try {
    worker.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error && error.code !== "EPIPE") capture(`Domain worker write failed: ${error.message}\n`);
    });
    return true;
  } catch (error) {
    if (error?.code !== "EPIPE") capture(`Domain worker write failed: ${error.message}\n`);
    return false;
  }
}

function installIpcHandlers() {
  const trusted = (event) => {
    if (!fromMainWindow(event, mainWindow)) return false;
    try {
      const source = new URL(event.senderFrame?.url || "");
      return source.protocol === "knorvia:" && source.hostname === "app";
    } catch {
      return false;
    }
  };
  ipcMain.on("knorvia:titlebar-overlay", (event, payload) => {
    if (!fromMainWindow(event, mainWindow) || process.platform !== "win32") return;
    const overlay = sanitizeOverlay(payload);
    if (!overlay || !mainWindow || mainWindow.isDestroyed()) return;
    try { mainWindow.setTitleBarOverlay(overlay); } catch (error) {
      capture(`Title bar overlay update failed: ${error.message}\n`);
    }
  });
  ipcMain.on("knorvia:window-material", (event, payload) => {
    if (!fromMainWindow(event, mainWindow) || !mainWindow || mainWindow.isDestroyed()) return;
    if (validAppearance(payload)) {
      nativeTheme.themeSource = palettes[payload.theme].dark ? "dark" : "light";
      try { saveAppearance(app.getPath("userData"), payload); } catch (error) { capture(`Window appearance save failed: ${error.message}\n`); }
    }
    liveBackdrop = payload?.material === "acrylic" || payload?.vibrancy === "under-window";
    try { applyWindowMaterial(mainWindow, process.platform, payload); } catch (error) {
      capture(`Window material update failed: ${error.message}\n`);
    }
  });
  ipcMain.on("knorvia:window-minimize", (event) => {
    if (!fromMainWindow(event, mainWindow) || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.minimize();
  });
  ipcMain.on("knorvia:window-maximize", (event) => {
    if (!fromMainWindow(event, mainWindow) || !mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
      return;
    }
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on("knorvia:window-close", (event) => {
    if (!fromMainWindow(event, mainWindow) || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.close();
  });
  ipcMain.handle("knorvia:window-is-maximized", (event) => {
    if (!fromMainWindow(event, mainWindow) || !mainWindow || mainWindow.isDestroyed()) return false;
    return isFilledScreen();
  });
  ipcMain.handle("knorvia:wallpaper-state", (event) => {
    if (!fromMainWindow(event, mainWindow)) return { id: "none", src: null, builtins: [] };
    return wallpaper.getState();
  });
  ipcMain.handle("knorvia:wallpaper-set", (event, id) => {
    if (!fromMainWindow(event, mainWindow)) return { id: "none", src: null, builtins: [] };
    return wallpaper.setBuiltin(id);
  });
  ipcMain.handle("knorvia:wallpaper-import", async (event) => {
    if (!fromMainWindow(event, mainWindow) || !mainWindow || mainWindow.isDestroyed()) {
      return { id: "none", src: null, builtins: [] };
    }
    return wallpaper.importCustom(mainWindow);
  });
  ipcMain.handle("knorvia:wallpaper-clear", (event) => {
    if (!fromMainWindow(event, mainWindow)) return { id: "none", src: null, builtins: [] };
    return wallpaper.clear();
  });
  ipcMain.handle("knorvia:update-check", () => runUpdateCheck(true));
  ipcMain.handle("knorvia:native-request", (event, message) => {
    if (!trusted(event)) {
      return errorResponse(message?.id, -32001, "Native request source is not trusted");
    }
    if (!nativeRpc) {
      return errorResponse(message?.id, -32000, "Knorvia native runtime is not ready");
    }
    return nativeRpc.handle(message);
  });
  ipcMain.handle("knorvia:fetch", (event, request) => {
    if (!trusted(event)) return encodedHttpError(403, "请求来源不受信任");
    if (typeof request?.path !== "string" || !request.path.startsWith("/api/"))
      return encodedHttpError(400, "无效的桌面接口路径");
    if (kernelEngine && isAgentApiPath(request.path)) {
      return kernelEngine.handleHttp(request);
    }
    const id = String(++requestSequence);
    return new Promise((resolve) => {
      pendingRequests.set(id, { resolve });
      if (!sendBridge({ ...request, kind: "http", id })) {
        pendingRequests.delete(id);
        resolve({ id, ...encodedHttpError(503, "领域 Worker 尚未就绪") });
      }
    });
  });
  ipcMain.on("knorvia:ws-open", (event, payload) => {
    if (!trusted(event)) return;
    const wsPath = String(payload?.path || "");
    if (kernelEngine && isAgentApiPath(wsPath)) {
      kernelSockets.add(payload?.id);
      kernelEngine.handleWsOpen(payload).then((open) => {
        if (open?.type === "error") {
          kernelSockets.delete(payload?.id);
          event.sender.send(`knorvia:ws-event:${payload?.id}`, {
            type: "close", error: open.error || "Legacy chat bridge is unavailable",
          });
          return;
        }
        event.sender.send(`knorvia:ws-event:${payload?.id}`, open);
      }).catch((error) => {
        event.sender.send(`knorvia:ws-event:${payload?.id}`, {
          type: "close", error: error.message,
        });
      });
      return;
    }
    if (!sendBridge({ ...payload, kind: "ws_open" })) {
      event.sender.send(`knorvia:ws-event:${payload?.id}`, {
        type: "close", error: "领域 Worker 尚未就绪",
      });
    }
  });
  ipcMain.on("knorvia:ws-send", (event, payload) => {
    if (!trusted(event)) return;
    if (kernelEngine && kernelSockets.has(payload?.id)) {
      const send = (msg) => event.sender.send(`knorvia:ws-event:${payload?.id}`, msg);
      kernelEngine.handleWsSend(payload, send);
      return;
    }
    sendBridge({ ...payload, kind: "ws_send" });
  });
  ipcMain.on("knorvia:ws-close", (event, payload) => {
    if (!trusted(event)) return;
    if (kernelEngine && kernelSockets.has(payload?.id)) {
      kernelEngine.handleWsClose(payload || {});
      kernelSockets.delete(payload?.id);
      return;
    }
    sendBridge({ ...payload, kind: "ws_close" });
  });
}

async function startKnorvia() {
  const runtime = runtimeRoot();
  const workspace = workspaceRoot();
  ensureDesktopDefaults(workspace);
  // Prefer a current source Next standalone build when requested. The staged
  // Python package remains a release-layout fallback only.
  const renderer = resolveWebRenderer({ webDir: process.env.KNORVIA_WEB_DIR, runtimeRoot: runtime });
  const nodeLauncher = resolveNodeLauncher({ runtimeRoot: runtime, env: process.env, electronExecPath: process.execPath });
  const python = path.join(runtime, "python", "python.exe");
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const linkRoots = [home, workspace].filter(Boolean).join(path.delimiter);
  const env = {
    ...process.env,
    PATH: `${path.dirname(nodeLauncher.command)};${process.env.PATH || ""}`,
    PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8:replace",
    KNORVIA_HOME: workspace, KNORVIA_DESKTOP: "1", UI_LANGUAGE: "zh",
    KNORVIA_LINKED_FOLDER_ROOTS: process.env.KNORVIA_LINKED_FOLDER_ROOTS || linkRoots,
  };

  const connectionStore = createEncryptedConnectionStore({
    filePath: path.join(workspace, "data", "user", "settings", "model-connection.json"),
    safeStorage,
  });
  let personalLibrary;
  // Learning/catalog packs are constructed lazily on first tool use: the
  // library, media studio and extension manager are created below.
  studioMcp = await createStudioMcp({
    getStudio: () => mediaStudio,
    getLibrary: () => personalLibrary,
    getLearning: () => (learningPack ??= createLearningPack({ home: workspace, library: personalLibrary, studio: mediaStudio, rpc: nativeRuntime.rpc })),
    getCatalog: () => (curatedCatalog ??= createCuratedCatalog({ home: workspace, library: personalLibrary, studio: mediaStudio, extensionManager, rpc: nativeRuntime.rpc })),
    home: workspace,
  });
  Object.assign(env, studioMcp.env);
  nativeRuntime = await createNativeRuntime({
    home: workspace,
    env,
    runtimeRoot: runtime,
    packaged: app.isPackaged,
    version: DESKTOP_VERSION,
    legacyChatBridge: env.KNORVIA_ENABLE_LEGACY_CHAT_BRIDGE === "1",
    mode: "desktop",
    connectionStore,
    capabilities: { selectFolder: true, openPath: true, revealPath: true },
  });
  const desktopPaths = createDesktopPathActions({
    rpc: nativeRuntime.rpc,
    dialog,
    shell,
    getWindow: () => mainWindow,
  });
  personalLibrary = createPersonalLibrary({ home: workspace, rpc: nativeRuntime.rpc });
  mediaStudio = createMediaStudio({ home: workspace, rpc: nativeRuntime.rpc, library: personalLibrary, safeStorage });
  workspaceTerminals = createWorkspaceTerminal({ rpc: nativeRuntime.rpc, env });
  sshSessions = createSshSessions({ home: workspace, safeStorage, rpc: nativeRuntime.rpc });
  worktreeSnapshots = createWorktreeSnapshots({ home: workspace, rpc: nativeRuntime.rpc });
  extensionManager = createExtensionManager({ home: workspace, rpc: nativeRuntime.rpc });
  await extensionManager.restore();
  learningPack ??= createLearningPack({ home: workspace, library: personalLibrary, studio: mediaStudio, rpc: nativeRuntime.rpc });
  curatedCatalog ??= createCuratedCatalog({ home: workspace, library: personalLibrary, studio: mediaStudio, extensionManager, rpc: nativeRuntime.rpc });
  creativeCliService = createCreativeCliService({ home: workspace, rpc: nativeRuntime.rpc, library: personalLibrary, studio: mediaStudio, extensionManager, learning: learningPack, catalog: curatedCatalog, course: createOpenmaicCourse({ library: personalLibrary }), imageOps: createLibraryImageOps({ library: personalLibrary }), version: DESKTOP_VERSION });
  await creativeCliService.listen();
  cliBackendHost = createCliBackendHandlers({ env });
  cliDispatch = createCliDispatchBridge({ rpc: nativeRuntime.rpc, handlers: cliBackendHost.handlers, backendIds: () => cliBackendHost.host.availableBackendIds() });
  void cliDispatch.start();
  nativeRpc = createNativeRpcRouter({
    rpc: nativeRuntime.rpc,
    onNotification: nativeRuntime.onNotification,
    handlers: {
      "connection/read": nativeRuntime.connectionRead,
      "connection/provider/save": nativeRuntime.providerSave,
      "connection/provider/delete": nativeRuntime.providerDelete,
      "connection/provider/activate": nativeRuntime.providerActivate,
      "connection/update": nativeRuntime.connectionUpdate,
      "connection/test": nativeRuntime.connectionTest,
      "notifications/read": () => turnNotifier.handlers["notifications/read"](),
      "notifications/update": params => turnNotifier.handlers["notifications/update"](params),
      ...extensionManager.handlers,
      ...extensionConnectionHandlers(nativeRuntime, extensionManager),
      ...sshSessions.handlers,
      ...worktreeSnapshots.handlers,
      ...desktopPaths.handlers,
      ...createWorkspacePreview({ rpc: nativeRuntime.rpc }),
      ...personalLibrary.handlers,
      ...mediaStudio.handlers,
      ...workspaceTerminals.handlers,
      ...cliBackendHost.handlers,
      ...learningPack.commands,
    },
  });
  turnNotifier = createTurnNotifier({
    home: workspace,
    // The user is actively looking at the app while its window is focused and
    // visible; banners would only interrupt. Background completion still
    // notifies, and with no window at all the app is effectively background.
    deliverability: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return true;
      return !mainWindow.isVisible() || !mainWindow.isFocused() || mainWindow.isMinimized();
    },
    onClick: (threadId) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("knorvia:open-thread", threadId);
    },
  });
  removeNativeRpcNotification = nativeRpc.subscribe((notification) => {
    try { turnNotifier?.handle(notification); } catch { /* notification failures never break streaming */ }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("knorvia:native-notification", notification);
  });
  removeRuntimeEngine = nativeRuntime.onEngineChange((next) => {
    kernelEngine = next;
    engine = next?.child;
    if (!next?.child) return;
    capture(`Agent Runtime: knorvia-daemon (${next.daemonBin})\n`);
    const failCurrentEngine = () => {
      // A planned provider restart deliberately terminates this child. Only a
      // failure of the currently bound engine is fatal to the desktop shell.
      if (shuttingDown || nativeRuntime?.restarting || nativeRuntime?.engine !== next) return;
      resolvePendingRequests(503, "AI 引擎已断开");
      assetStreamBroker?.failAll(new Error("Knorvia engine disconnected"));
      if (!fatalErrorShown) {
        fatalErrorShown = true;
        dialog.showErrorBox("Knorvia 已停止", `knorvia-daemon 意外退出。\n\n${recentOutput.slice(-3000)}`);
        app.quit();
      }
    };
    // Do not copy daemon stderr into the desktop diagnostic buffer: provider
    // implementations may include request headers in their own diagnostics.
    next.child.stderr?.resume?.();
    next.child.on("error", failCurrentEngine);
    next.child.on("exit", failCurrentEngine);
  });

  assetStreamBroker = new DesktopAssetStreamBroker(sendBridge);
  const legacyDomainWorker = env.KNORVIA_ENABLE_LEGACY_DOMAIN_WORKER === "1";
  if (legacyDomainWorker && fs.existsSync(python)) {
    domainWorker = spawn(python, ["-m", "knorvia.desktop.ipc_bridge"], {
      cwd: workspace, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    domainWorker.stderr.on("data", capture);
    domainWorker.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") capture(`Domain worker input failed: ${error.message}\n`);
    });
    const lines = readline.createInterface({ input: domainWorker.stdout });
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.kind?.startsWith("http_stream_") || (message.kind === "error" && assetStreamBroker.pending.has(message.id))) {
        assetStreamBroker.handle(message);
      } else if (message.kind === "http_response" || (message.kind === "error" && pendingRequests.has(message.id))) {
        const pending = pendingRequests.get(message.id);
        if (!pending) return;
        pendingRequests.delete(message.id);
        message.kind === "error"
          ? pending.resolve({ id: message.id, ...encodedHttpError(502, message.error || "领域 Worker 请求失败") })
          : pending.resolve(message);
      } else if (message.kind?.startsWith("ws_")) {
        mainWindow?.webContents.send(`knorvia:ws-event:${message.id}`, {
          type: message.kind.slice(3), data: message.data, error: message.error,
        });
      }
    });
  } else if (legacyDomainWorker) {
    capture("Legacy domain worker was requested but its Python runtime is absent.\n");
  } else {
    capture("Legacy Python domain worker disabled; native workbench uses knorvia-daemon directly.\n");
  }
  const webRoot = renderer.webRoot;
  const frontendHost = app.isPackaged
    ? path.join(process.resourcesPath, "desktop", "frontend-host.js")
    : path.join(__dirname, "frontend-host.js");
  if (!fs.existsSync(frontendHost))
    throw new Error(`桌面渲染器入口缺失：${frontendHost}`);
  const pipeName = `\\\\.\\pipe\\knorvia-ui-${process.pid}`;
  frontend = spawn(nodeLauncher.command, [frontendHost], {
    cwd: webRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env,
      ...(nodeLauncher.useElectronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      KNORVIA_WEB_ROOT: webRoot,
      KNORVIA_UI_PIPE: pipeName,
      KNORVIA_NEXT_DIST_DIR: renderer.distDir,
    },
  });
  // A spawn failure (bad cwd, missing node.exe) surfaces as an async 'error'
  // event, NOT through 'exit' — without a listener it is an uncaught
  // exception that kills the whole main process with no dialog.
  frontend.on("error", (error) => {
    if (shuttingDown || fatalErrorShown) return;
    fatalErrorShown = true;
    dialog.showErrorBox("Knorvia 无法启动", `桌面渲染器无法启动。\n\n${error?.message || error}\n${recentOutput.slice(-3000)}`);
    app.quit();
  });
  let markRendererReady;
  let failRendererReady;
  const rendererReady = new Promise((resolve, reject) => {
    markRendererReady = resolve;
    failRendererReady = reject;
  });
  {
    const output = readline.createInterface({ input: frontend.stdout });
    output.on("line", (line) => line.trim() === "READY" ? markRendererReady() : capture(`${line}\n`));
    frontend.on("exit", (code) => failRendererReady(new Error(`桌面渲染器启动失败（代码 ${code}）。\n${recentOutput.slice(-3000)}`)));
  }
  frontend.stderr.on("data", capture);
  // Bound the readiness wait: a renderer that neither prints READY nor exits
  // (e.g. a hung Next.js prepare) must not pin the window on the loading
  // page forever. The timer rejects the SAME promise `startKnorvia` awaits,
  // so the outer catch shows the dialog and quits — the promise never stays
  // pending semantically, and there is exactly one failure path.
  const readyTimeout = setTimeout(() => {
    if (shuttingDown || fatalErrorShown) return;
    failRendererReady(new Error(
      `桌面渲染器启动超时（${RENDERER_READY_TIMEOUT_S}s）。\n${recentOutput.slice(-3000)}`
    ));
  }, RENDERER_READY_TIMEOUT_S * 1000);
  readyTimeout.unref?.();
  try {
    await rendererReady;
  } finally {
    clearTimeout(readyTimeout);
  }
  if (shuttingDown) return;
  installRendererProtocol(pipeName);
  await mainWindow.loadURL("knorvia://app/");
  if (process.env.KNORVIA_DESKTOP_SMOKE === "1") {
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const health = await window.knorviaDesktop.native.request({
        jsonrpc: "2.0", id: "desktop-smoke", method: "system/health", params: {}
      });
      return { url: location.href, native: health.result?.ok === true, server: health.result?.server, error: health.error?.message };
    })()`);
    process.stdout.write(`DESKTOP_SMOKE=${JSON.stringify(result)}\n`, () => {});
    setTimeout(() => app.quit(), 250);
  }
}

function stopKnorvia() {
  if (shuttingDown) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = stopServices();
  return shutdownPromise;
}

async function stopServices() {
  try { await cliDispatch?.close(); } catch {}
  cliDispatch = undefined;
  try { await creativeCliService?.close(); } catch {}
  creativeCliService = undefined;
  // Stop accepting media tools before closing their worker. The worker must
  // settle while the durable daemon is still available.
  try { await studioMcp?.close(); } catch {}
  studioMcp = undefined;
  try { await mediaStudio?.close(); } catch {}
  mediaStudio = undefined;
  workspaceTerminals?.dispose();
  workspaceTerminals = undefined;
  for (const runId of cliBackendHost?.host.activeRuns() ?? []) {
    cliBackendHost.host.cancel({ runId });
  }
  cliBackendHost = undefined;
  sshSessions?.dispose(); sshSessions = undefined;
  try { await worktreeSnapshots?.close(); } catch {}
  worktreeSnapshots = undefined;
  try { await extensionManager?.close(); } catch {}
  extensionManager = undefined;
  const enginePid = engine?.pid;
  const workerPid = domainWorker?.pid;
  resolvePendingRequests(503, "Knorvia 正在关闭");
  assetStreamBroker?.failAll(new Error("Knorvia is shutting down"));
  try { removeNativeRpcNotification?.(); } catch {}
  try { nativeRpc?.dispose(); } catch {}
  try { removeRuntimeEngine?.(); } catch {}
  nativeRpc = undefined;
  removeNativeRpcNotification = undefined;
  removeRuntimeEngine = undefined;
  const runtime = nativeRuntime;
  nativeRuntime = undefined;
  try { await runtime?.close?.(); } catch {}
  if (!runtime) {
    try { kernelEngine?.kill?.(); } catch {}
  }
  if (domainWorker?.stdin?.writable && !domainWorker.stdin.destroyed) {
    try { domainWorker.stdin.write(`${JSON.stringify({ kind: "shutdown" })}\n`, () => {}); } catch {}
  }
  // The renderer is stateless — kill it right away.
  if (frontend?.pid) spawnSync("taskkill", ["/pid", String(frontend.pid), "/t", "/f"], { windowsHide: true });
  // The engine gets a short grace window to process the shutdown message and
  // flush SQLite writes; it is force-killed only after the window elapses or
  // the child exits on its own first.
  const killEngine = () => {
    if (enginePid) spawnSync("taskkill", ["/pid", String(enginePid), "/t", "/f"], { windowsHide: true });
    if (workerPid) spawnSync("taskkill", ["/pid", String(workerPid), "/t", "/f"], { windowsHide: true });
  };
  if (!enginePid && !workerPid) {
    frontend = undefined; engine = undefined; domainWorker = undefined; kernelEngine = undefined;
    return;
  }
  const forceKillTimer = setTimeout(killEngine, ENGINE_SHUTDOWN_GRACE_MS);
  forceKillTimer.unref?.();
  const onExit = () => { clearTimeout(forceKillTimer); };
  if (engine && engine.exitCode === null && engine.signalCode === null) engine.once("exit", onExit);
  else onExit();
  frontend = undefined; engine = undefined; domainWorker = undefined; kernelEngine = undefined;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    createWindow(); installIpcHandlers();
    startKnorvia().catch((error) => {
      dialog.showErrorBox("Knorvia 无法启动", error.stack || error.message);
      app.quit();
    });
  });
}
let shutdownFinished = false;
app.on("before-quit", (event) => {
  try { require("electron").globalShortcut.unregisterAll(); } catch {}
  if (shutdownFinished) return;
  event.preventDefault();
  void Promise.resolve(stopKnorvia()).finally(() => {
    shutdownFinished = true;
    app.quit();
  });
});
app.on("window-all-closed", () => app.quit());
