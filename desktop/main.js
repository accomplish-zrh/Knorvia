const { app, BrowserWindow, dialog, ipcMain, protocol, nativeTheme, safeStorage, shell, powerSaveBlocker, powerMonitor } = require("electron");
const { spawn } = require("child_process");
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
const { startupScreen, recoveryScreen } = require("./startup-screen");
const {
  resolveWorkspaceRoot,
  writePendingMigration,
  readPendingMigration,
  clearPendingMigration,
  retryPendingMigration,
} = require("./workspace-migration");
const wallpaper = require("./wallpaper");
const updateCheck = require("./update-check");
const { createUpdateController } = require("./update-controller");
const { createUpdateDownloadManager, resolveDownloadsRoot } = require("./update-download");
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
const { createRuntimeDiagnostics, createErrorRing, saveReportTo, knownEnvSecretValues, METHODS: RUNTIME_DIAGNOSTICS_METHODS } = require("./runtime-diagnostics");
const { NATIVE_METHODS, LOCAL_METHODS } = require("./native-rpc-router");
// C05/C09: local desktop handlers enter through this explicit allow-list
// registration (named methods only, no generic passthrough).
const LOCAL_DESKTOP_METHODS = [
  "home/backup/plan", "home/backup/schedule", "home/backup/cancel", "home/backup/status",
  "home/restore/preview", "home/restore/perform",
  "runtimeIntegrity/check",
  "power/read", "power/update",
  "extension/export", "extension/import/plan", "extension/import/perform",
  "extension/convert/plan", "extension/convert/perform",
];
for (const desktopMethod of LOCAL_DESKTOP_METHODS) {
  NATIVE_METHODS.add(desktopMethod);
  LOCAL_METHODS.add(desktopMethod);
}
// C05: the diagnostics RPC enters through this explicit allow-list
// registration (named methods only, no generic passthrough).
for (const diagnosticsMethod of RUNTIME_DIAGNOSTICS_METHODS) {
  NATIVE_METHODS.add(diagnosticsMethod);
  LOCAL_METHODS.add(diagnosticsMethod);
}
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
const { createFrontendSupervisor } = require("./frontend-supervisor");
const { createOpenThreadBridge } = require("./open-thread-bridge");
const { createShutdownController, asShutdownStep, monotonicNow } = require("./shutdown-controller");
const {
  createHomeBackup,
  resolvePendingHomeOverride,
  writePendingHomeOverride,
  clearPendingHomeOverride,
  runPendingBackupRequest,
} = require("./home-backup");
const { createRuntimeIntegrity } = require("./runtime-integrity");
const { createPowerPolicy, turnReferenceFromNotification } = require("./power-policy");
const { createExtensionExport } = require("./extension-export");
const { createExtensionConverter } = require("./extension-convert");
// C18/C19: these services are delivered by lane D and activate when the
// integration tree contains them. In a tree without the modules the shell
// keeps the pre-existing behaviour instead of failing to start.
let createWorkspaceMediaPreview = null;
let createTerminalProfiles = null;
try { ({ createWorkspaceMediaPreview } = require("./workspace-media-preview")); } catch { /* D module absent in this tree */ }
try { ({ createTerminalProfiles } = require("./terminal-profiles")); } catch { /* D module absent in this tree */ }
const { createPreviewRevocationHandlers } = require("./preview-revoke");

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
let runtimeDiagnostics;
let diagnosticsErrors;
let learningPack;
let curatedCatalog;
let creativeCliService;
let personalLibrary;
let shutdownPromise;
let removeNativeRpcNotification;
let turnNotifier;
let removeRuntimeEngine;
let domainWorker;
let frontend;
let frontendSupervisor;
let currentWorkspaceRoot = null;
let workspaceMediaPreview = null;
let powerPolicy;
let powerReconcileTimer;
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

function migrationBlockedError(blocked) {
  // The message carries the OS error code only — no paths, no user content.
  const error = new Error(`无法迁移旧版工作区数据（${blocked.code}）`);
  error.code = "KNORVIA_WORKSPACE_MIGRATION_BLOCKED";
  error.info = { code: blocked.code, operation: blocked.operation, legacy: blocked.legacy, target: blocked.target };
  return error;
}

function workspaceRoot() {
  // C09: a verified restore can nominate a brand-new Home for the next
  // start; only directories carrying a restore receipt are honoured.
  const override = resolvePendingHomeOverride(app.getPath("userData"));
  if (override) {
    clearPendingHomeOverride(app.getPath("userData"));
    capture(`Restored Home override applied for this start.\n`);
    return override.root;
  }
  const resolved = resolveWorkspaceRoot({
    envRoot: process.env.KNORVIA_WORKSPACE_ROOT,
    packaged: app.isPackaged,
    devFallbackRoot: path.resolve(__dirname, "..", "desktop-data"),
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    exeDir: app.isPackaged ? path.dirname(app.getPath("exe")) : undefined,
    // An explicit Home and development/portable roots do not use AppData.
    // Resolving this unrelated Windows known folder can itself fail on a
    // redirected or newly created profile, before the selected Home is used.
    appDataPath: !process.env.KNORVIA_WORKSPACE_ROOT && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR
      ? app.getPath("appData") : undefined,
    userDataPath: app.getPath("userData"),
  });
  if (resolved.status === "invalid-env") throw new Error("KNORVIA_WORKSPACE_ROOT must be an absolute path");
  if (resolved.status === "blocked") {
    // Keep the legacy directory exactly where it is and record a bounded,
    // code-only pending state so the recovery screen can offer an idempotent
    // retry. Never fall back to an empty root: that would look like data loss.
    try {
      writePendingMigration(app.getPath("userData"), {
        parent: resolved.parent,
        target: resolved.target,
        legacy: resolved.legacy,
        code: resolved.code,
        operation: resolved.operation,
        at: new Date().toISOString(),
      });
    } catch (error) {
      capture(`Migration state write failed: ${error.message}\n`);
    }
    throw migrationBlockedError(resolved);
  }
  clearPendingMigrationBestEffort();
  fs.mkdirSync(resolved.root, { recursive: true });
  return resolved.root;
}

function clearPendingMigrationBestEffort() {
  try { clearPendingMigration(app.getPath("userData")); } catch (error) {
    capture(`Migration state cleanup failed: ${error.message}\n`);
  }
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
  traceStartup("window-preferences");
  const theme = storedUiTheme();
  const backdropSupported = nativeBackdropSupported(process.platform, os.release());
  const frost = storedUiFrost() && backdropSupported;
  if (theme && Object.hasOwn(palettes, theme)) nativeTheme.themeSource = palettes[theme].dark ? "dark" : "light";
  const chrome = browserWindowChrome(process.platform, {
    dark: nativeTheme.shouldUseDarkColors,
    theme,
    frost,
  });
  traceStartup("window-construct");
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
  traceStartup("window-constructed");
  liveBackdrop = frost;
  if (frost) applyWindowMaterial(mainWindow, process.platform, windowMaterialForFrost(true, theme || "snow", process.platform));
  traceStartup("loading-page-create");
  const initialPage = loadingPage(frost);
  traceStartup("loading-page-load");
  mainWindow.loadURL(initialPage);
  traceStartup("loading-page-requested");
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
  mainWindow.webContents.on("did-finish-load", () => { openThreadBridge?.flush(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternal(url); return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("knorvia://app/")) {
      event.preventDefault();
      openAllowedExternal(url);
    }
  });

  traceStartup("window-helpers");
  setupTray();
  keepWindowInBackground(mainWindow, () => Boolean(tray) && !shuttingDown && !process.env.KNORVIA_DESKTOP_SMOKE);
  setupGlobalHotkey();
  scheduleUpdateChecks();
}

// C06: notification click-through to the right task. The renderer may not be
// on the workbench shell yet (startup, reload, recovery screen); the bridge
// keeps the most recent request for a bounded time and replays it exactly
// once when the shell finishes loading. Malformed ids never reach the
// renderer, so a notification cannot trigger arbitrary navigation.
let openThreadBridge;

function createMainWindowOpenThreadBridge() {
  return createOpenThreadBridge({
    deliver: (id) => mainWindow?.webContents.send("knorvia:open-thread", id),
    isShellReady: () => {
      try {
        return Boolean(mainWindow && !mainWindow.isDestroyed()
          && (mainWindow.webContents.getURL() || "").startsWith("knorvia://app/"));
      } catch { return false; }
    },
    activate: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    },
  });
}

openThreadBridge = createMainWindowOpenThreadBridge();

// --- C09: full Home backup --------------------------------------------------
// Consistency comes from ordering, not from hot-copy tricks: the export runs
// at the very end of shutdown when every writer has exited and the known
// lock files are gone. While running, the UI can only preview the plan or
// schedule the export for the next safe shutdown.

function homeBackupLockPaths(home) {
  return [
    path.join(home, "personal-library", ".knorvia-library", "write.lock"),
    path.join(home, "extensions", "catalog.lock"),
  ];
}

function pendingHomeBackupFile() {
  return path.join(app.getPath("userData"), "pending-home-backup.json");
}

function readPendingHomeBackup() {
  try {
    const pending = JSON.parse(fs.readFileSync(pendingHomeBackupFile(), "utf8"));
    if (pending?.version !== 1 || !path.isAbsolute(pending.destination || "")) return null;
    return pending;
  } catch { return null; }
}

function writePendingHomeBackup(destination) {
  const file = pendingHomeBackupFile();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, destination, at: new Date().toISOString() }), "utf8");
  fs.renameSync(temp, file);
}

function readLastHomeBackupResult() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "last-home-backup-result.json"), "utf8"));
  } catch { return null; }
}

async function runPendingHomeBackup(workspace, blockedWriters = [], signal) {
  return runPendingBackupRequest({
    home: workspace,
    userDataDir: app.getPath("userData"),
    appVersion: DESKTOP_VERSION,
    pendingFile: pendingHomeBackupFile(),
    resultFile: path.join(app.getPath("userData"), "last-home-backup-result.json"),
    lockPaths: homeBackupLockPaths(workspace),
    blockedWriters,
    signal,
  });
}

function installHomeBackupHandlers(rpcHandlers, workspace) {
  rpcHandlers["home/backup/plan"] = async () => createHomeBackup({
    home: workspace, appVersion: DESKTOP_VERSION, lockPaths: homeBackupLockPaths(workspace),
  }).plan();
  rpcHandlers["home/backup/schedule"] = async (params) => {
    if (!params?.destination || !path.isAbsolute(params.destination)) {
      const error = new Error("请选择一个绝对路径作为备份位置");
      error.rpc = { code: -32602, message: error.message };
      throw error;
    }
    writePendingHomeBackup(params.destination);
    return { scheduled: true, destination: params.destination, requiresSafeShutdown: true };
  };
  rpcHandlers["home/backup/cancel"] = async () => {
    try { fs.unlinkSync(pendingHomeBackupFile()); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { scheduled: false };
  };
  rpcHandlers["home/backup/status"] = async () => ({
    pending: readPendingHomeBackup(),
    lastResult: readLastHomeBackupResult(),
  });
  rpcHandlers["home/restore/preview"] = async (params) => createHomeBackup({
    home: workspace, appVersion: DESKTOP_VERSION,
  }).previewRestore(params?.backupDir || "");
  rpcHandlers["home/restore/perform"] = async (params) => {
    const result = await createHomeBackup({
      home: workspace, appVersion: DESKTOP_VERSION,
    }).restore({ backupDir: params?.backupDir || "", targetHome: params?.targetHome || "" });
    if (params?.switchOnNextStart) writePendingHomeOverride(app.getPath("userData"), result.targetHome);
    return result;
  };
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
// 24h. Manual checks (tray / renderer) always report; automatic ones notify
// once per version and honour "remind later" / "skip this version" choices
// persisted through the update controller.

let updateTimer = null;
// C08: the in-app update download task. Created once the app is ready so the
// user's real Downloads directory is known.
let updateDownload = null;
let updateDownloadError = null;

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

function handleUpdateNotification(decision) {
  if (decision.kind === "available") {
    promptUpdate(decision);
    return;
  }
  if (!decision.manual) return;
  if (decision.kind === "up-to-date") reportUpdateOutcome(true, decision.release);
  else reportUpdateOutcome(false, null, decision.message);
}

const updateController = createUpdateController({
  currentVersion: app.getVersion(),
  token: process.env.KNORVIA_GITHUB_TOKEN || "",
  readState: readUpdateState,
  writeState: writeUpdateState,
  notify: handleUpdateNotification,
  openExternal: (url) => { void shell.openExternal(url); },
});

async function runUpdateCheck(manual) {
  return updateController.check({ manual });
}

function reportUpdateOutcome(success, release, errorMessage) {
  const options = success
    ? { type: "info", title: "检查更新", message: "已是最新版本", detail: `当前 ${app.getVersion()} 已是最新（最新正式版本 ${release ? release.version : "-"}）。` }
    : { type: "warning", title: "检查更新", message: "检查更新失败", detail: errorMessage || "暂时无法连接 GitHub，请稍后再试。" };
  dialog.showMessageBox(mainWindow, options)
    .catch((error) => console.warn("[desktop] update result dialog failed:", error.message));
}

function promptUpdate(decision) {
  const { release, installer, downloadUrl, downloadHint, previouslySkipped } = decision;
  const detailParts = [];
  const excerpt = releaseNotesExcerpt(release);
  if (excerpt) detailParts.push(excerpt);
  if (downloadHint) detailParts.push(downloadHint);
  if (previouslySkipped) detailParts.push("你此前选择跳过此版本，可忽略本提示。");
  const detail = detailParts.join("\n\n") || "前往发布页下载安装包。";
  const buttons = [installer ? "下载安装包" : "打开发布页", "稍后提醒", "跳过此版本"];
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: `发现新版本 Knorvia ${release.version}`,
    message: `当前版本 ${app.getVersion()} → 新版本 ${release.version}`,
    detail,
    buttons,
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }).then(({ response }) => {
    if (response === 2) {
      updateController.applyChoice({ version: release.version, choice: "skip" });
      return;
    }
    if (response === 1) {
      updateController.applyChoice({ version: release.version, choice: "remind-later" });
      return;
    }
    if (!installer) {
      updateController.applyChoice({ version: release.version, choice: "install", downloadUrl });
      return;
    }
    // C08: download in-app with progress, cancellation and digest
    // verification; the release page stays available as a fallback.
    updateController.applyChoice({ version: release.version, choice: "download-in-app", downloadUrl });
    const outcome = updateDownload.start({
      url: installer.url,
      name: installer.name,
      version: release.version,
      digest: installer.digest || "",
      size: installer.size,
    });
    if (!outcome.ok) {
      updateController.applyChoice({ version: release.version, choice: "install", downloadUrl });
    }
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

// Explicit diagnostics for startup stalls; emits fixed labels, never paths,
// provider settings or message content. The external owner bounds native waits.
function traceStartup(stage) {
  if (process.env.KNORVIA_STARTUP_TRACE !== "1") return;
  try { fs.writeSync(2, `${JSON.stringify({ startupStage: stage, pid: process.pid, at: Date.now() })}\n`); } catch {}
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
  ipcMain.handle("knorvia:update-download-start", (event, params) => {
    if (!trusted(event)) return { ok: false, error: "请求来源不受信任" };
    if (!updateDownload) return { ok: false, unavailable: true, error: updateDownloadError || "下载目录不可用，请先选择下载目录" };
    return updateDownload.start(params || {});
  });
  ipcMain.handle("knorvia:update-download-status", () => ({
    managerAvailable: Boolean(updateDownload),
    unavailableError: updateDownloadError || null,
    task: updateDownload?.status() ?? null,
  }));
  ipcMain.handle("knorvia:update-download-cancel", (event) => {
    if (!trusted(event)) return { cancelled: false };
    return updateDownload?.cancel() ?? { cancelled: false };
  });
  ipcMain.handle("knorvia:update-download-choose-dir", async (event) => {
    if (!trusted(event)) return { ok: false, error: "请求来源不受信任" };
    const hasActiveDownload = () => ["downloading", "cancelling"].includes(updateDownload?.status()?.state);
    const busy = { ok: false, error: "下载仍在进行，请完成或取消后再更换目录。" };
    if (hasActiveDownload()) return busy;
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const outcome = await dialog.showOpenDialog(owner, {
      title: "选择更新下载目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (outcome.canceled || !outcome.filePaths?.[0]) return { ok: false, error: "canceled" };
    // A download can start while the asynchronous directory dialog is open.
    if (hasActiveDownload()) return busy;
    const dir = outcome.filePaths[0];
    try {
      updateDownload = createUpdateDownloadManager({
        defaultDownloadDir: dir,
        readState: readUpdateState,
        writeState: writeUpdateState,
      });
      updateDownloadError = null;
      return { ok: true, dir };
    } catch (error) {
      updateDownloadError = String(error?.message || error).slice(0, 200);
      return { ok: false, error: updateDownloadError };
    }
  });
  ipcMain.handle("knorvia:update-download-open", (event) => {
    if (!trusted(event)) return { opened: false };
    const target = updateDownload?.revealTarget();
    if (!target || !fs.existsSync(target)) return { opened: false };
    shell.showItemInFolder(target);
    return { opened: true };
  });
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
  traceStartup("runtime-root");
  const runtime = runtimeRoot();
  // C14: verify core components against the manifest built from the actual
  // frozen inputs before anything is spawned. A replaced daemon, an old
  // Kernel, or a swapped node.exe blocks startup and names the component;
  // an old package without a manifest continues explicitly unverified.
  traceStartup("integrity-create");
  const runtimeIntegrity = createRuntimeIntegrity({ runtimeRoot: runtime, packaged: app.isPackaged });
  traceStartup("integrity-gate");
  const integrityGate = runtimeIntegrity.startupGate();
  traceStartup("integrity-gate-complete");
  if (!integrityGate.allow) {
    throw new Error(`${integrityGate.reason}\n组件位置：${integrityGate.componentPath}`);
  }
  traceStartup("workspace-resolve");
  const workspace = workspaceRoot();
  traceStartup("workspace-resolved");
  currentWorkspaceRoot = workspace;
  ensureDesktopDefaults(workspace);
  traceStartup("workspace-defaults-ready");
  // C20: one prevent-app-suspension blocker covers all authoritative active
  // references (durable running Turns, managed CLI jobs; managed media
  // activity plugs into the same provider list when D's interface lands).
  const powerPreferencesFile = path.join(workspace, "data", "user", "settings", "power.json");
  powerPolicy = createPowerPolicy({
    powerSaveBlocker,
    readPreferences: () => {
      try { return JSON.parse(fs.readFileSync(powerPreferencesFile, "utf8")); } catch { return { version: 1, enabled: true, onBattery: "keep" }; }
    },
  });
  try { powerPolicy.setBattery(powerMonitor.isOnBatteryPower()); }
  catch (error) { capture(`Initial battery state could not be read: ${error?.message || "unknown error"}\n`); }
  const reconcileManagedActivity = () => {
    if (shuttingDown) return;
    powerPolicy?.poll();
    // Managed CLI jobs admitted by the daemon are an authoritative activity
    // source; unknown states must never hold the blocker indefinitely.
    if ((cliDispatch?.activeCount || 0) > 0) powerPolicy.acquire("cli:host", "受管 CLI 任务");
    else powerPolicy.release("cli:host");
    // C20/D: media activity is consumed ONLY from a delivered authoritative
    // count (media-studio get pendingActivityCount -> mediaOps.pendingCount,
    // requested in reports/C-interfaces.md). An absent interface is never
    // invented into activity.
    const mediaActive = typeof mediaStudio?.pendingActivityCount === "number"
      && mediaStudio.pendingActivityCount > 0;
    if (mediaActive) powerPolicy.acquire("media:host", "受管媒体任务");
    else powerPolicy.release("media:host");
  };
  reconcileManagedActivity();
  clearInterval(powerReconcileTimer);
  powerReconcileTimer = setInterval(reconcileManagedActivity, 30_000);
  powerReconcileTimer.unref?.();
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
  // C19: scoped, revocable stream URLs for large/media previews. Without
  // lane D's module this stays null and preview/read keeps the inline
  // base64 behaviour.
  workspaceMediaPreview = createWorkspaceMediaPreview ? createWorkspaceMediaPreview({}) : null;
  const desktopPaths = createDesktopPathActions({
    rpc: nativeRuntime.rpc,
    dialog,
    shell,
    getWindow: () => mainWindow,
  });
  personalLibrary = createPersonalLibrary({ home: workspace, rpc: nativeRuntime.rpc });
  mediaStudio = createMediaStudio({ home: workspace, rpc: nativeRuntime.rpc, library: personalLibrary, safeStorage });
  // C18: hand the terminal host the workspace Home and the profile service
  // so shell detection and the persisted default live in the app's data.
  workspaceTerminals = createWorkspaceTerminal({
    rpc: nativeRuntime.rpc, env,
    ...(createTerminalProfiles ? { home: workspace, profiles: createTerminalProfiles({ home: workspace }) } : {}),
  });
  sshSessions = createSshSessions({ home: workspace, safeStorage, rpc: nativeRuntime.rpc });
  worktreeSnapshots = createWorktreeSnapshots({ home: workspace, rpc: nativeRuntime.rpc });
  extensionManager = createExtensionManager({
    home: workspace,
    rpc: nativeRuntime.rpc,
    getBuiltinSkills: () => kernelEngine?.builtinSkills || [],
  });
  await extensionManager.restore();
  learningPack ??= createLearningPack({ home: workspace, library: personalLibrary, studio: mediaStudio, rpc: nativeRuntime.rpc });
  curatedCatalog ??= createCuratedCatalog({ home: workspace, library: personalLibrary, studio: mediaStudio, extensionManager, rpc: nativeRuntime.rpc });
  creativeCliService = createCreativeCliService({ home: workspace, rpc: nativeRuntime.rpc, library: personalLibrary, studio: mediaStudio, extensionManager, learning: learningPack, catalog: curatedCatalog, course: createOpenmaicCourse({ library: personalLibrary }), imageOps: createLibraryImageOps({ library: personalLibrary }), version: DESKTOP_VERSION });
  await creativeCliService.listen();
  cliBackendHost = createCliBackendHandlers({ env });
  cliDispatch = createCliDispatchBridge({ rpc: nativeRuntime.rpc, handlers: cliBackendHost.handlers, backendIds: () => cliBackendHost.host.availableBackendIds() });
  void cliDispatch.start();
  diagnosticsErrors = createErrorRing({});
  runtimeDiagnostics = createRuntimeDiagnostics({
    identity: {
      appVersion: DESKTOP_VERSION,
      channel: app.isPackaged ? "packaged" : "dev",
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      runtimeComponents: "knorvia-daemon engine + fixed Kernel app-server",
      // C14: the real source identity recorded in the build manifest —
      // "unknown" for old packages, never a fabricated value.
      sourceSha: integrityGate.core?.status === "unknown" ? null : runtimeIntegrity.identity().sourceSha,
      sourceDirty: runtimeIntegrity.identity().sourceDirty,
    },
    // Known local roots become short labels so the report never carries a
    // real Home or userData location.
    pathRoots: [
      { label: "~", path: workspace },
      { label: "[userData]", path: app.getPath("userData") },
      { label: "[app]", path: app.getAppPath() },
      { label: "[temp]", path: os.tmpdir() },
    ],
    secretValues: knownEnvSecretValues(env),
    collectors: {
      components: async () => [
        { name: "daemon-engine", status: engine && !engine.killed ? "ready" : "offline", detail: engine ? `daemon engine bound (pid recorded)` : "daemon engine is not running" },
        { name: "renderer", status: mainWindow && !mainWindow.isDestroyed() ? "ready" : "offline", detail: mainWindow ? "named-pipe renderer host" : "renderer window missing" },
        { name: "extensions", status: extensionManager ? "ready" : "offline", detail: "extension manager instance" },
        { name: "terminals", status: workspaceTerminals ? "ready" : "offline", detail: "workspace terminal host" },
        { name: "cli-backends", status: cliBackendHost ? "ready" : "offline", detail: "external CLI adapter" },
      ],
      capabilities: async () => [
        { name: "terminal", available: Boolean(workspaceTerminals) },
        { name: "ssh", available: Boolean(sshSessions) },
        { name: "extensions", available: Boolean(extensionManager) },
        { name: "cliBackends", available: Boolean(cliBackendHost && cliBackendHost.host.availableBackendIds().length > 0), reason: cliBackendHost ? undefined : "host not initialized" },
      ],
      ports: async () => [
        // The desktop renderer rides a Windows named pipe, not a TCP port.
        { label: "renderer", port: null, state: mainWindow && !mainWindow.isDestroyed() ? "named-pipe" : "closed", host: "local" },
      ],
      recentErrors: async () => diagnosticsErrors.snapshot(),
      checks: async () => [{ name: "desktop-shell", passed: Boolean(mainWindow && !mainWindow.isDestroyed()) }],
    },
  });
  nativeRpc = createNativeRpcRouter({
    rpc: nativeRuntime.rpc,
    onNotification: nativeRuntime.onNotification,
    handlers: (() => {
      const rpcHandlers = {
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
      ...createWorkspacePreview({ rpc: nativeRuntime.rpc, ...(workspaceMediaPreview ? { mediaPreview: workspaceMediaPreview } : {}) }),
      ...personalLibrary.handlers,
      ...mediaStudio.handlers,
      ...workspaceTerminals.handlers,
      ...cliBackendHost.handlers,
      ...learningPack.commands,
      ...runtimeDiagnostics.handlers,
      "runtimeDiagnostics/save": async (params) => {
        if (!mainWindow || mainWindow.isDestroyed()) throw new Error("The desktop window is not available for saving");
        const picked = await dialog.showSaveDialog(mainWindow, {
          title: "保存运行诊断报告",
          defaultPath: `knorvia-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (picked.canceled || !picked.filePath) return { saved: false, reason: "canceled" };
        return saveReportTo({ text: params?.text, destination: picked.filePath });
      },
      };
      installHomeBackupHandlers(rpcHandlers, workspace);
      // C19: public revocation RPCs so the renderer can drop preview
      // capabilities on panel close or scope switch.
      if (workspaceMediaPreview) {
        const { handlers: revokeHandlers } = createPreviewRevocationHandlers(workspaceMediaPreview);
        Object.assign(rpcHandlers, revokeHandlers);
      }
      const extensionExport = createExtensionExport({ home: workspace });
      rpcHandlers["extension/export"] = (params) => extensionExport.exportExtensions({ destination: params?.destination, ids: params?.ids });
      rpcHandlers["extension/import/plan"] = (params) => extensionExport.planImport({ exportDir: params?.exportDir, manager: extensionManager });
      rpcHandlers["extension/import/perform"] = (params) => extensionExport.performImport({ exportDir: params?.exportDir, manager: extensionManager, items: params?.ids || params?.items });
      const extensionConverter = createExtensionConverter({ home: workspace });
      rpcHandlers["extension/convert/plan"] = (params) => extensionConverter.plan({ entryId: params?.entryId });
      rpcHandlers["extension/convert/perform"] = (params) => extensionConverter.perform({ entryId: params?.entryId, outputDir: params?.outputDir, commands: params?.commands, expectedPackageSha256: params?.expectedPackageSha256 });
      rpcHandlers["runtimeIntegrity/check"] = async () => createRuntimeIntegrity({
        runtimeRoot: runtimeRoot(),
        packaged: app.isPackaged,
        webDistDir: renderer.distDir,
      }).verifyAll();
      rpcHandlers["power/read"] = async () => powerPolicy?.state() ?? null;
      rpcHandlers["power/update"] = async (params) => {
        if (!params || typeof params !== "object") return powerPolicy?.state() ?? null;
        const next = {};
        if (typeof params.enabled === "boolean") next.enabled = params.enabled;
        if (params.onBattery === "keep" || params.onBattery === "release") next.onBattery = params.onBattery;
        if (Object.keys(next).length) {
          const temp = `${powerPreferencesFile}.${process.pid}.tmp`;
          try {
            const current = (() => { try { return JSON.parse(fs.readFileSync(powerPreferencesFile, "utf8")); } catch { return { version: 1, enabled: true, onBattery: "keep" }; } })();
            fs.writeFileSync(temp, JSON.stringify({ version: 1, ...current, ...next }, null, 2), "utf8");
            fs.renameSync(temp, powerPreferencesFile);
          } catch (error) { capture(`Power preferences write failed: ${error.message}\n`); }
          powerPolicy?.setPreferences(next);
        }
        return powerPolicy?.state() ?? null;
      };
      return rpcHandlers;
    })(),
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
      openThreadBridge?.open(threadId);
    },
  });
  removeNativeRpcNotification = nativeRpc.subscribe((notification) => {
    try { turnNotifier?.handle(notification); } catch { /* notification failures never break streaming */ }
    // C20: durable Turn events are the authoritative wake-lock references.
    try {
      const turnReference = turnReferenceFromNotification(notification);
      if (turnReference) {
        if (turnReference.active) powerPolicy?.acquire(turnReference.key, turnReference.key);
        else powerPolicy?.release(turnReference.key);
      }
    } catch { /* power policy failures never break streaming */ }
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
        diagnosticsErrors?.record("engine", new Error("knorvia-daemon exited unexpectedly; see the shutdown dialog for the bounded tail"));
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
  // The renderer host spawn and its READY handshake are reusable so the
  // supervisor can relaunch the identical child after a runtime crash.
  const spawnFrontend = (fatalSpawnErrors) => {
    const child = spawn(nodeLauncher.command, [frontendHost], {
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
    let markRendererReady;
    let failRendererReady;
    const rendererReady = new Promise((resolve, reject) => {
      markRendererReady = resolve;
      failRendererReady = reject;
    });
    const output = readline.createInterface({ input: child.stdout });
    output.on("line", (line) => line.trim() === "READY" ? markRendererReady() : capture(`${line}\n`));
    child.on("exit", (code) => failRendererReady(new Error(`桌面渲染器退出（代码 ${code}）。\n${recentOutput.slice(-3000)}`)));
    child.on("error", (error) => {
      if (!fatalSpawnErrors) {
        failRendererReady(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (shuttingDown || fatalErrorShown) return;
      fatalErrorShown = true;
      diagnosticsErrors?.record("renderer", error);
      dialog.showErrorBox("Knorvia 无法启动", `桌面渲染器无法启动。\n\n${error?.message || error}\n${recentOutput.slice(-3000)}`);
      app.quit();
    });
    child.stderr.on("data", capture);
    // Bound the readiness wait: a renderer that neither prints READY nor exits
    // (e.g. a hung Next.js prepare) must not pin the window on the loading
    // page forever.
    const readyTimeout = setTimeout(() => {
      failRendererReady(new Error(`桌面渲染器启动超时（${RENDERER_READY_TIMEOUT_S}s）。\n${recentOutput.slice(-3000)}`));
    }, RENDERER_READY_TIMEOUT_S * 1000);
    readyTimeout.unref?.();
    rendererReady.then(() => clearTimeout(readyTimeout), () => {});
    return { child, ready: rendererReady };
  };
  const initialFrontend = spawnFrontend(true);
  frontend = initialFrontend.child;
  try {
    await initialFrontend.ready;
  } catch (error) {
    if (shuttingDown || fatalErrorShown) return;
    throw error;
  }
  if (shuttingDown) return;
  installRendererProtocol(pipeName);
  frontendSupervisor = createFrontendSupervisor({
    startChild: () => Promise.resolve(spawnFrontend(false)),
    isShuttingDown: () => shuttingDown,
    onRestart: (info) => {
      diagnosticsErrors?.record("renderer", new Error(`桌面渲染器意外退出（代码 ${info.lastExitCode}）；正在进行有界恢复重启（第 ${info.attempt} 次）`));
    },
    onReady: (next) => {
      frontend = next;
      // Durable Thread/Turn state lives in the daemon; reloading the shell
      // restores the workbench from the native snapshots.
      if (mainWindow && !mainWindow.isDestroyed()) {
        void mainWindow.loadURL("knorvia://app/")
          .catch((error) => capture(`Renderer reload failed: ${error.message}\n`));
      }
    },
    onExhausted: (info) => {
      diagnosticsErrors?.record("renderer", new Error(`桌面渲染器恢复预算耗尽（${JSON.stringify(info)}），已停止自动重启`));
      if (fatalErrorShown || shuttingDown || !mainWindow || mainWindow.isDestroyed()) return;
      dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Knorvia 页面服务持续崩溃",
        message: "桌面页面服务多次重启仍未恢复。",
        detail: "任务数据保存在本地引擎中，没有丢失。可以重试页面服务，或退出应用后重新启动 Knorvia。",
        buttons: ["重试页面服务", "退出"],
        defaultId: 0, cancelId: 1, noLink: true,
      }).then(({ response }) => {
        if (response === 0) frontendSupervisor?.resume();
        else app.quit();
      }).catch((error) => capture(`Renderer recovery dialog failed: ${error.message}\n`));
    },
  });
  frontendSupervisor.monitor(frontend);
  try {
    await mainWindow.loadURL("knorvia://app/");
  } catch (error) {
    // A restored task or an early user navigation may replace the initial
    // workbench load. Electron rejects that superseded load with ERR_ABORTED;
    // a live page on our own origin remains a valid startup destination.
    const currentUrl = !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : "";
    let internalNavigation = false;
    try { const url = new URL(currentUrl); internalNavigation = url.protocol === "knorvia:" && url.hostname === "app"; } catch {}
    if (error?.code !== "ERR_ABORTED" || !internalNavigation) throw error;
  }
  traceStartup("startup-complete");
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
  frontendSupervisor?.stop();
  frontendSupervisor = undefined;
  clearInterval(powerReconcileTimer);
  powerReconcileTimer = undefined;
  powerPolicy?.reset("shutdown");

  const shutdownStartedAt = monotonicNow();
  const totalHostBudgetMs = Number(process.env.KNORVIA_SHUTDOWN_BUDGET_MS) || 15_000;
  const shutdownDeadline = shutdownStartedAt + totalHostBudgetMs;
  let shutdownReport = null;
  const alive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
  };
  const waitForOwnedChild = async (child, context, requestStop) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return { confirmed: true, ownedPids: [], detail: "owned child already exited" };
    const pid = child.pid;
    try { requestStop?.(child); } catch (error) {
      return { confirmed: false, ownedPids: Number.isInteger(pid) ? [pid] : [], detail: `child stop signal failed: ${error?.message || error}` };
    }
    if (child.exitCode !== null || child.signalCode !== null || !alive(pid)) return { confirmed: true, ownedPids: [], detail: "owned child confirmed exit" };
    if (context.signal?.aborted) return { confirmed: false, ownedPids: Number.isInteger(pid) ? [pid] : [], detail: "owned child did not exit before shutdown deadline" };
    const exited = new Promise(resolve => {
      const done = () => resolve(true);
      child.once?.("exit", done);
      child.once?.("close", done);
    });
    const aborted = new Promise(resolve => context.signal?.addEventListener("abort", () => resolve(false), { once: true }));
    const confirmed = context.signal ? await Promise.race([exited, aborted]) : await exited;
    return confirmed
      ? { confirmed: true, ownedPids: [], detail: "owned child confirmed exit" }
      : { confirmed: false, ownedPids: Number.isInteger(pid) ? [pid] : [], detail: "owned child did not exit before shutdown deadline" };
  };
  const runTaskkill = (pid, context) => new Promise(resolve => {
    if (context.signal?.aborted || context.now() >= context.deadline) { resolve(false); return; }
    let settled = false;
    let killer;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { context.signal?.removeEventListener("abort", onAbort); } catch {}
      resolve(value);
    };
    const onAbort = () => { try { killer?.kill(); } catch {} finish(false); };
    const remaining = Math.max(1, Math.min(2_000, context.deadline - context.now()));
    const timer = setTimeout(() => { try { killer?.kill(); } catch {} finish(false); }, remaining);
    timer.unref?.();
    context.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => finish(false));
      killer.once("exit", () => finish(true));
    } catch { finish(false); }
  });
  const reapOwnedPids = async (pending, context) => {
    const done = [];
    const seen = new Set();
    for (const item of pending) {
      if (!Number.isInteger(item?.pid) || item.pid <= 0 || seen.has(item.pid)) continue;
      seen.add(item.pid);
      if (!alive(item.pid)) { done.push(item); continue; }
      if (context.signal?.aborted || context.now() >= context.deadline) break;
      if (process.platform === "win32") await runTaskkill(item.pid, context);
      else { try { process.kill(item.pid, "SIGKILL"); } catch {} }
      while (alive(item.pid) && !context.signal?.aborted && context.now() < context.deadline) {
        const delay = Math.max(1, Math.min(25, context.deadline - context.now()));
        await new Promise(resolve => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            context.signal?.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, delay);
          timer.unref?.();
          context.signal?.addEventListener("abort", finish, { once: true });
        });
      }
      if (!alive(item.pid)) done.push(item);
    }
    return done;
  };

  const controller = createShutdownController({
    totalBudgetMs: totalHostBudgetMs,
    now: monotonicNow,
    startedAt: shutdownStartedAt,
    deadline: shutdownDeadline,
    reapPids: reapOwnedPids,
    steps: [
      asShutdownStep("native-rpc-router", (ctx) => nativeRpc?.beginClose?.(ctx)),
      asShutdownStep("creative-cli-service", (ctx) => creativeCliService?.close?.(ctx)),
      asShutdownStep("studio-mcp", (ctx) => studioMcp?.close?.(ctx)),
      asShutdownStep("cli-dispatch", (ctx) => cliDispatch?.close?.(ctx)),
      asShutdownStep("media-studio", (ctx) => mediaStudio?.close?.(ctx), {
        ownedPids: () => (typeof mediaStudio?.activePids === "function" ? mediaStudio.activePids() : []),
      }),
      asShutdownStep("workspace-terminals", (ctx) => workspaceTerminals?.dispose?.(ctx), {
        ownedPids: () => (typeof workspaceTerminals?.activePids === "function" ? workspaceTerminals.activePids() : []),
      }),
      asShutdownStep("cli-backends", async (ctx) => {
        if (!cliBackendHost?.host?.closeAll) return;
        const timeoutMs = Number.isFinite(ctx.remainingMs) ? Math.max(0, Math.min(ctx.remainingMs, 20_000)) : 20_000;
        const teardown = await cliBackendHost.host.closeAll({ timeoutMs, signal: ctx.signal });
        if (teardown?.exitedWithinTimeout !== true) {
          return {
            confirmed: false,
            ownedPids: typeof cliBackendHost?.host?.activePids === "function" ? cliBackendHost.host.activePids() : [],
            detail: `CLI teardown unconfirmed runs: ${(teardown?.unconfirmedRuns || []).join(", ") || "(unknown)"}; ${teardown?.reason || "termination could not be verified"}`,
          };
        }
      }, {
        timeoutMs: 20_000,
        ownedPids: () => (typeof cliBackendHost?.host?.activePids === "function" ? cliBackendHost.host.activePids() : []),
      }),
      asShutdownStep("ssh-sessions", (ctx) => sshSessions?.dispose?.(ctx), {
        ownedPids: () => (typeof sshSessions?.activePids === "function" ? sshSessions.activePids() : []),
      }),
      asShutdownStep("worktree-snapshots", (ctx) => worktreeSnapshots?.close?.(ctx)),
      asShutdownStep("extension-manager", (ctx) => extensionManager?.close?.(ctx)),
      asShutdownStep("personal-library", (ctx) => personalLibrary?.close?.(ctx)),
      asShutdownStep("workspace-media-preview", (ctx) => workspaceMediaPreview?.close?.(ctx), { timeoutMs: 2_000 }),
      asShutdownStep("native-runtime", (ctx) => nativeRuntime?.close?.(ctx), {
        timeoutMs: 10_000,
        ownedPids: () => [nativeRuntime?.pid, engine?.pid].filter(pid => Number.isInteger(pid) && pid > 0),
      }),
      asShutdownStep("domain-worker", (ctx) => waitForOwnedChild(domainWorker, ctx, child => {
        if (child.stdin?.writable && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ kind: "shutdown" })}\n`, () => {});
        else child.kill();
      }), { ownedPids: () => [domainWorker?.pid].filter(pid => Number.isInteger(pid) && pid > 0) }),
      asShutdownStep("renderer-host", (ctx) => waitForOwnedChild(frontend, ctx, child => child.kill()), {
        ownedPids: () => [frontend?.pid].filter(pid => Number.isInteger(pid) && pid > 0),
      }),
    ],
  });

  try {
    shutdownReport = await controller.run();
  } catch (error) {
    const finished = monotonicNow();
    shutdownReport = {
      steps: [],
      unconfirmed: [`shutdown-controller: ${error?.message || error}`],
      reaped: [],
      totalMs: Math.max(0, finished - shutdownStartedAt),
      withinBudget: finished <= shutdownDeadline,
      budgetMs: totalHostBudgetMs,
      deadline: shutdownDeadline,
    };
  }

  for (const step of shutdownReport.steps) {
    if (step.status !== "confirmed") {
      try { diagnosticsErrors?.record("shutdown", new Error(`${step.name} ${step.status}: ${step.detail || "component did not confirm shutdown"}`)); } catch {}
    }
  }
  if (shutdownReport.unconfirmed.length) capture(`Shutdown finished with unconfirmed components: ${shutdownReport.unconfirmed.join(", ")}\n`);

  resolvePendingRequests(503, "Knorvia 正在关闭");
  assetStreamBroker?.failAll(new Error("Knorvia is shutting down"));
  try { removeNativeRpcNotification?.(); } catch {}
  try { nativeRpc?.dispose(); } catch {}
  try { removeRuntimeEngine?.(); } catch {}

  const blockedWriters = [...shutdownReport.unconfirmed];
  const backupPending = Boolean(readPendingHomeBackup());
  if (currentWorkspaceRoot && backupPending) {
    const configuredBackupBudget = Number(process.env.KNORVIA_BACKUP_BUDGET_MS);
    const hostRemaining = Math.max(0, shutdownDeadline - monotonicNow());
    const remainingForBackup = Number.isFinite(configuredBackupBudget) && configuredBackupBudget >= 0
      ? Math.min(hostRemaining, configuredBackupBudget)
      : hostRemaining;
    const backupStarted = monotonicNow();
    if (remainingForBackup < 1) {
      shutdownReport.unconfirmed.push("pending-home-backup");
      shutdownReport.steps.push({
        name: "pending-home-backup", status: "unconfirmed", ms: 0,
        detail: "shutdown budget exhausted before backup could start; pending request preserved for retry",
      });
    } else {
      const abortController = new AbortController();
      const backupTimer = setTimeout(() => abortController.abort(new Error("backup shutdown deadline reached")), remainingForBackup);
      backupTimer.unref?.();
      try {
        const outcome = await runPendingHomeBackup(currentWorkspaceRoot, blockedWriters, abortController.signal);
        const backupMs = Math.max(0, monotonicNow() - backupStarted);
        if (outcome?.ok === true && outcome?.committed === true) {
          shutdownReport.steps.push({
            name: "pending-home-backup", status: "confirmed", committed: true, ms: backupMs,
            detail: outcome.completedAfterDeadline
              ? "verified Home backup committed atomically while the shutdown deadline fired"
              : "verified Home backup committed atomically",
          });
        } else {
          shutdownReport.unconfirmed.push("pending-home-backup");
          shutdownReport.steps.push({
            name: "pending-home-backup", status: "unconfirmed", ms: backupMs,
            detail: abortController.signal.aborted ? "backup cancelled at the host shutdown deadline and joined without a late commit" : (outcome?.error || "backup failed or was blocked"),
          });
        }
      } catch (error) {
        const backupMs = Math.max(0, monotonicNow() - backupStarted);
        shutdownReport.unconfirmed.push("pending-home-backup");
        shutdownReport.steps.push({
          name: "pending-home-backup", status: abortController.signal.aborted ? "unconfirmed" : "failed", ms: backupMs,
          detail: String(error?.message || error),
        });
        capture(`Home backup export failed: ${String(error?.message || error)}\n`);
      } finally {
        clearTimeout(backupTimer);
      }
    }
  }

  const finishedAt = monotonicNow();
  shutdownReport.totalMs = Math.max(0, finishedAt - shutdownStartedAt);
  shutdownReport.withinBudget = finishedAt <= shutdownDeadline;

  cliDispatch = undefined;
  creativeCliService = undefined;
  studioMcp = undefined;
  mediaStudio = undefined;
  workspaceTerminals = undefined;
  cliBackendHost = undefined;
  sshSessions = undefined;
  workspaceMediaPreview = null;
  worktreeSnapshots = undefined;
  extensionManager = undefined;
  personalLibrary = undefined;
  runtimeDiagnostics = undefined;
  diagnosticsErrors = undefined;
  nativeRpc = undefined;
  removeNativeRpcNotification = undefined;
  removeRuntimeEngine = undefined;
  nativeRuntime = undefined;
  frontend = undefined;
  engine = undefined;
  domainWorker = undefined;
  kernelEngine = undefined;
  return shutdownReport;
}

let migrationRecoveryActive = false;

function showMigrationRecovery(blockedInfo) {
  if (migrationRecoveryActive) return;
  migrationRecoveryActive = true;
  try {
    void mainWindow.loadURL(loadingPage(storedUiFrost() && nativeBackdropSupported(process.platform, os.release())));
  } catch { /* keep the current page if the loading document cannot render */ }
  const logo = fs.readFileSync(path.join(__dirname, "build", "logo.png")).toString("base64");
  mainWindow.webContents.once("did-finish-load", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.webContents.executeJavaScript("true").catch(() => {});
    void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(recoveryScreen({ logo, theme: storedUiTheme(), frost: false, code: blockedInfo?.code }))}`);
  });
}

async function retryWorkspaceMigration() {
  const outcome = retryPendingMigration(app.getPath("userData"));
  if (outcome.status !== "ready") return outcome;
  migrationRecoveryActive = false;
  try { fs.mkdirSync(outcome.root, { recursive: true }); } catch (error) {
    capture(`Recovery workspace prepare failed: ${error.message}\n`);
    return { status: "blocked", code: error.code || "UNKNOWN" };
  }
  void startKnorvia().catch((error) => {
    if (error?.code === "KNORVIA_WORKSPACE_MIGRATION_BLOCKED") {
      showMigrationRecovery(error.info);
      return;
    }
    dialog.showErrorBox("Knorvia 无法启动", error.stack || error.message);
    app.quit();
  });
  return outcome;
}

function installMigrationRecoveryHandlers() {
  ipcMain.handle("knorvia:migration-retry", () => retryWorkspaceMigration());
  ipcMain.on("knorvia:migration-open-legacy", () => {
    const pending = readPendingMigration(app.getPath("userData"));
    const target = pending?.legacy || pending?.parent;
    if (typeof target === "string" && target) void shell.openPath(target);
  });
  ipcMain.on("knorvia:migration-exit", () => app.quit());
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
    traceStartup("app-ready");
    // A downloads-path failure must not block
    // startup. Resolve defensively; when unavailable the download entries
    // surface a clear state and the user can pick a directory to recover.
    const resolvedDownloads = resolveDownloadsRoot((name) => app.getPath(name));
    traceStartup("downloads-resolved");
    if (resolvedDownloads.dir) {
      try {
        updateDownload = createUpdateDownloadManager({
          defaultDownloadDir: resolvedDownloads.dir,
        });
      } catch (error) {
        updateDownload = null;
        updateDownloadError = String(error?.message || error);
        capture(`Update download manager init failed: ${updateDownloadError}
`);
      }
    } else {
      updateDownload = null;
      updateDownloadError = resolvedDownloads.error;
      capture(`Update downloads unavailable: ${updateDownloadError}
`);
    }
    // C20: after a manual suspend the OS state is unknown — drop references
    // and let real authoritative events re-acquire. Never replay side effects.
    try {
      traceStartup("power-events");
      powerMonitor.on("resume", () => powerPolicy?.reset("resumed"));
      powerMonitor.on("suspend", () => powerPolicy?.reset("suspended"));
      traceStartup("power-battery-read");
      powerPolicy?.setBattery(powerMonitor.isOnBatteryPower?.() ?? false);
      traceStartup("power-battery-read-complete");
      powerMonitor.on("on-ac", () => powerPolicy?.setBattery(false));
      powerMonitor.on("on-battery", () => powerPolicy?.setBattery(true));
    } catch (error) { console.warn("[desktop] powerMonitor unavailable:", error.message); }
    traceStartup("create-window");
    createWindow();
    traceStartup("install-ipc");
    installIpcHandlers(); installMigrationRecoveryHandlers();
    traceStartup("start-knorvia");
    startKnorvia().catch((error) => {
      traceStartup("start-knorvia-rejected");
      if (error?.code === "KNORVIA_WORKSPACE_MIGRATION_BLOCKED") {
        // The old data is intact; offer the bounded recovery screen instead of
        // dying with no way back to the legacy workspace.
        showMigrationRecovery(error.info);
        return;
      }
      dialog.showErrorBox("Knorvia 无法启动", error.stack || error.message);
      app.quit();
    });
  }).catch((error) => {
    traceStartup("ready-failed");
    capture(`Desktop initialization failed: ${error?.stack || error}\n`);
    dialog.showErrorBox("Knorvia 无法启动", error?.message || "桌面初始化失败");
    app.quit();
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
