const { app, BrowserWindow, dialog, ipcMain, protocol, nativeTheme, shell } = require("electron");
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
  TITLEBAR_HEIGHT,
  WINDOW_CORNER_RADIUS,
  browserWindowChrome,
  sanitizeOverlay,
  windowMaterialForFrost,
  applyWindowMaterial,
  fromMainWindow,
} = require("./window-chrome");
const { applyWindowCornerRegion } = require("./win32-corners");
const wallpaper = require("./wallpaper");

let mainWindow;
let engine;
let frontend;
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
      sidebar_description: "Knorvia 智能学习与知识工作台",
    }, null, 2), "utf8");
  } else {
    try {
      const settings = JSON.parse(fs.readFileSync(interfaceFile, "utf8"));
      if (settings.sidebar_description === "Knorvia 智能学习助手") {
        settings.sidebar_description = "Knorvia 智能学习与知识工作台";
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
  const parsed = readInterfaceSettings();
  return parsed && typeof parsed.theme === "string" ? parsed.theme : null;
}

function storedUiFrost() {
  const parsed = readInterfaceSettings();
  if (!parsed) return false;
  if (typeof parsed.window_frost === "boolean") return parsed.window_frost;
  return parsed.theme === "glass";
}

function loadingPage(glass) {
  const logo = fs.readFileSync(path.join(__dirname, "build", "logo.png")).toString("base64");
  // Palette mirrors globals.css cream / warm dark. Choreography mirrors
  // BootSplash v4 (web/components/common/BootSplash.tsx): mint/lavender aura,
  // squircle hairline, one glass sheen, tracking wordmark, centre-grown rule.
  // No breathe, motes, or dual spinners. Frost keeps the canvas transparent
  // so DWM acrylic / macOS vibrancy show through. Restored windows clip
  // to 16px here too.
  const html = `<!doctype html><meta charset="utf-8"><title>Knorvia</title>
  <style>
    :root { --bg:#fdfcf9; --fg:#1c1816; --muted:#6d645a; --halo:#8bb8c4; }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#1a1918; --fg:#e8e4de; --muted:#9b9590; --halo:#a8c8d4; }
    }
    * { box-sizing:border-box; }
    html, body { border-radius:${WINDOW_CORNER_RADIUS}px; overflow:hidden; clip-path:inset(0 round ${WINDOW_CORNER_RADIUS}px); }
    body { margin:0; background:${glass ? "transparent" : "var(--bg)"}; color:var(--fg); font:15px system-ui,-apple-system,"Segoe UI",sans-serif;
           display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; overflow:hidden; user-select:none; }
    .chrome { position:fixed; top:0; left:0; right:0; height:${TITLEBAR_HEIGHT}px; -webkit-app-region:drag; z-index:10; }
    .chrome .caption { position:absolute; top:0; right:0; height:100%; display:none; -webkit-app-region:no-drag; }
    .chrome .caption button { width:46px; height:100%; border:0; background:transparent; color:var(--fg); font-size:12px; }
    .chrome .caption button:hover { background:rgba(127,127,127,.18); }
    .chrome .caption button.close:hover { background:#e81123; color:#fff; }
    .emblem { position:relative; width:136px; height:136px; display:grid; place-items:center; }
    .aura { position:absolute; left:50%; top:50%; width:420px; height:280px; margin-left:-210px; margin-top:-140px;
      border-radius:50%; pointer-events:none; filter:blur(16px);
      background: radial-gradient(circle at 34% 38%, rgba(143,212,200,.34), transparent 48%),
                  radial-gradient(circle at 68% 62%, rgba(183,182,227,.3), transparent 50%),
                  radial-gradient(circle at 50% 50%, rgba(186,206,214,.16), transparent 58%);
      animation:auraIn 1.4s cubic-bezier(.16,1,.3,1) both; }
    @media (prefers-color-scheme: dark) {
      .aura { filter:blur(18px);
              background: radial-gradient(circle at 34% 38%, rgba(143,212,200,.48), transparent 48%),
                          radial-gradient(circle at 68% 62%, rgba(183,182,227,.44), transparent 50%),
                          radial-gradient(circle at 50% 50%, rgba(186,206,214,.22), transparent 60%); }
    }
    .halo { position:absolute; inset:0; width:136px; height:136px; color:var(--halo); pointer-events:none; }
    .halo rect { fill:none; stroke:currentColor; stroke-width:1.15; stroke-linecap:round; stroke-dasharray:150 432;
                 opacity:.7; animation:draw 1.15s .22s cubic-bezier(.22,1,.36,1) both, orbit 28s 1.4s linear infinite; }
    .mark { position:relative; z-index:2; width:100px; height:100px; overflow:hidden; border-radius:22px; }
    .mark img { width:100px; height:100px; object-fit:contain; display:block;
                animation:arrive .95s .1s cubic-bezier(.16,1,.3,1) both; }
    .sheen { position:absolute; inset:-30%; pointer-events:none;
             background:linear-gradient(115deg, transparent 36%, rgba(255,255,255,.55) 50%, transparent 64%);
             animation:sheen 1.15s .4s cubic-bezier(.22,1,.36,1) both; }
    @media (prefers-color-scheme: dark) {
      .sheen { background:linear-gradient(115deg, transparent 36%, rgba(255,255,255,.28) 50%, transparent 64%); }
    }
    h1 { font-size:21px; font-weight:600; margin:28px 0 0; letter-spacing:.06em;
         font-family:Georgia,'Times New Roman',serif;
         animation:word .9s .48s cubic-bezier(.16,1,.3,1) both; }
    .muted { color:var(--muted); font-size:12px; line-height:1; margin:10px 0 0;
             animation:statusIn .7s .64s cubic-bezier(.16,1,.3,1) both; }
    .rule { margin-top:28px; width:56px; height:1px; overflow:hidden; }
    .rule i { display:block; height:100%; width:100%; transform-origin:center;
              background:linear-gradient(90deg, #8fd4c8, #b7b6e3);
              animation:ruleIn .85s .78s cubic-bezier(.22,1,.36,1) both; }
    @keyframes auraIn { from{opacity:0;transform:scale(.78)} to{opacity:1;transform:scale(1)} }
    @keyframes arrive { from{opacity:0;transform:translateY(10px) scale(.94);filter:blur(8px)}
                        to{opacity:1;transform:none;filter:blur(0)} }
    @keyframes sheen { from{transform:translateX(-130%);opacity:0} 18%{opacity:1} to{transform:translateX(130%);opacity:0} }
    @keyframes draw { from{stroke-dashoffset:150;opacity:0} to{stroke-dashoffset:0;opacity:.7} }
    @keyframes orbit { to { stroke-dashoffset:-432 } }
    @keyframes word { from{opacity:0;transform:translateY(6px);letter-spacing:.2em}
                      to{opacity:1;transform:none;letter-spacing:.06em} }
    @keyframes statusIn { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
    @keyframes ruleIn { from{transform:scaleX(0);opacity:0} to{transform:scaleX(1);opacity:1} }
    @media (prefers-reduced-motion: reduce) {
      .aura,.mark img,.sheen,.halo rect,h1,.muted,.rule i { animation:none !important; }
      .mark img,.halo rect,h1,.muted,.rule i { opacity:1 !important; transform:none !important; filter:none !important; }
      .aura { opacity:1 !important; transform:none !important; }
      .sheen { opacity:0 !important; }
      .halo rect { stroke-dashoffset:0 !important; }
    }
  </style>
  <div class="chrome"><div class="caption" id="caption"></div></div>
  <div class="emblem">
    <span class="aura"></span>
    <svg class="halo" viewBox="0 0 136 136" fill="none"><rect x="8" y="8" width="120" height="120" rx="28" ry="28"/></svg>
    <div class="mark"><img src="data:image/png;base64,${logo}" alt=""><span class="sheen"></span></div>
  </div>
  <h1>Knorvia</h1>
  <div class="muted">正在启动桌面 AI 引擎…</div>
  <div class="rule"><i></i></div>
  <script>
    (function () {
      var chrome = window.knorviaDesktop && window.knorviaDesktop.chrome;
      if (!chrome || chrome.captionOverlay || chrome.trafficLights) return;
      var el = document.getElementById("caption");
      el.style.display = "flex";
      el.innerHTML = '<button id="min" aria-label="Minimize">&#x2013;</button><button id="max" aria-label="Maximize">&#x25A1;</button><button id="cls" class="close" aria-label="Close">&#x2715;</button>';
      document.getElementById("min").onclick = function () { chrome.windowMinimize(); };
      document.getElementById("max").onclick = function () { chrome.windowMaximize(); };
      document.getElementById("cls").onclick = function () { chrome.windowClose(); };
    })();
  </script>`;
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
  const frost = storedUiFrost();
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
  setupGlobalHotkey();
}

let tray = null;

function setupTray() {
  try {
    const { Tray, Menu, nativeImage } = require("electron");
    const iconPath = path.join(__dirname, "build", "icon.ico");
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip("Knorvia");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open Knorvia", click: () => {
          if (!mainWindow) return;
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show(); mainWindow.focus();
        } },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
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
  recentOutput = (recentOutput + chunk.toString("utf8")).slice(-12000);
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
  if (shuttingDown || !engine?.stdin?.writable || engine.stdin.destroyed) return false;
  try {
    engine.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error && error.code !== "EPIPE") capture(`AI engine write failed: ${error.message}\n`);
    });
    return true;
  } catch (error) {
    if (error?.code !== "EPIPE") capture(`AI engine write failed: ${error.message}\n`);
    return false;
  }
}

function installIpcHandlers() {
  const trusted = (event) => event.senderFrame.url.startsWith("knorvia://app/");
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
  ipcMain.handle("knorvia:fetch", (event, request) => {
    if (!trusted(event)) return encodedHttpError(403, "请求来源不受信任");
    if (typeof request?.path !== "string" || !request.path.startsWith("/api/"))
      return encodedHttpError(400, "无效的桌面接口路径");
    const id = String(++requestSequence);
    return new Promise((resolve) => {
      pendingRequests.set(id, { resolve });
      if (!sendBridge({ ...request, kind: "http", id })) {
        pendingRequests.delete(id);
        resolve({ id, ...encodedHttpError(503, "AI 引擎正在关闭或尚未就绪") });
      }
    });
  });
  for (const [channel, kind] of [
    ["knorvia:ws-open", "ws_open"], ["knorvia:ws-send", "ws_send"],
    ["knorvia:ws-close", "ws_close"],
  ]) ipcMain.on(channel, (event, payload) => {
    if (!trusted(event)) return;
    if (!sendBridge({ ...payload, kind }) && kind === "ws_open") {
      event.sender.send(`knorvia:ws-event:${payload?.id}`, {
        type: "close", error: "AI 引擎正在关闭或尚未就绪",
      });
    }
  });
}

async function startKnorvia() {
  const runtime = runtimeRoot();
  const python = path.join(runtime, "python", "python.exe");
  const node = path.join(runtime, "node", "node.exe");
  if (!fs.existsSync(python) || !fs.existsSync(node))
    throw new Error("桌面运行时不完整，请重新构建应用。");

  const workspace = workspaceRoot();
  ensureDesktopDefaults(workspace);
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const linkRoots = [home, workspace].filter(Boolean).join(path.delimiter);
  const env = {
    ...process.env,
    PATH: `${path.dirname(node)};${process.env.PATH || ""}`,
    PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8:replace",
    KNORVIA_HOME: workspace, KNORVIA_DESKTOP: "1", UI_LANGUAGE: "zh",
    KNORVIA_LINKED_FOLDER_ROOTS: process.env.KNORVIA_LINKED_FOLDER_ROOTS || linkRoots,
  };
  engine = spawn(python, ["-m", "knorvia.desktop.ipc_bridge"], {
    cwd: workspace, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  engine.stderr.on("data", capture);
  engine.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") capture(`AI engine input failed: ${error.message}\n`);
  });
  assetStreamBroker = new DesktopAssetStreamBroker(sendBridge);
  const lines = readline.createInterface({ input: engine.stdout });
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.kind === "ready") markReady();
    else if (message.kind?.startsWith("http_stream_") || (message.kind === "error" && assetStreamBroker.pending.has(message.id))) {
      assetStreamBroker.handle(message);
    } else if (message.kind === "http_response" || (message.kind === "error" && pendingRequests.has(message.id))) {
      const pending = pendingRequests.get(message.id);
      if (!pending) return; // late/duplicate response after timeout or shutdown
      pendingRequests.delete(message.id);
      message.kind === "error"
        ? pending.resolve({ id: message.id, ...encodedHttpError(502, message.error || "AI 引擎请求失败") })
        : pending.resolve(message);
    } else if (message.kind?.startsWith("ws_")) {
      mainWindow?.webContents.send(`knorvia:ws-event:${message.id}`, {
        type: message.kind.slice(3), data: message.data, error: message.error,
      });
    }
  });
  engine.on("error", (error) => {
    capture(`AI engine process failed: ${error.message}\n`);
    resolvePendingRequests(503, "AI 引擎已断开");
    assetStreamBroker?.failAll(new Error("Knorvia engine disconnected"));
    if (!shuttingDown && !fatalErrorShown) {
      fatalErrorShown = true;
      dialog.showErrorBox("Knorvia 已停止", `桌面 AI 引擎无法运行。\n\n${recentOutput.slice(-3000)}`);
      app.quit();
    }
  });
  engine.on("exit", (code) => {
    resolvePendingRequests(503, "AI 引擎已断开");
    assetStreamBroker?.failAll(new Error("Knorvia engine disconnected"));
    if (!shuttingDown && !fatalErrorShown) {
      fatalErrorShown = true;
      dialog.showErrorBox("Knorvia 已停止", `桌面 AI 引擎意外退出（代码 ${code}）。\n\n${recentOutput.slice(-3000)}`);
      app.quit();
    }
  });
  const webRoot = path.join(runtime, "python", "Lib", "site-packages", "knorvia_web");
  if (!fs.existsSync(webRoot))
    throw new Error(`桌面渲染器资源缺失：${webRoot}`);
  const frontendHost = app.isPackaged
    ? path.join(process.resourcesPath, "desktop", "frontend-host.js")
    : path.join(__dirname, "frontend-host.js");
  if (!fs.existsSync(frontendHost))
    throw new Error(`桌面渲染器入口缺失：${frontendHost}`);
  const pipeName = `\\\\.\\pipe\\knorvia-ui-${process.pid}`;
  frontend = spawn(node, [frontendHost], {
    cwd: webRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, KNORVIA_WEB_ROOT: webRoot, KNORVIA_UI_PIPE: pipeName, KNORVIA_NEXT_DIST_DIR: ".next-knorvia" },
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
      const response = await window.knorviaDesktop.fetch({
        method: "GET", path: "/api/v1/system/status", headers: {}
      });
      const body = JSON.parse(new TextDecoder().decode(
        Uint8Array.from(atob(response.body), c => c.charCodeAt(0))
      ));
      const socketId = crypto.randomUUID();
      const pong = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("IPC chat timeout")), 5000);
        const remove = window.knorviaDesktop.onWsEvent(socketId, (event) => {
          if (event.type === "open") window.knorviaDesktop.wsSend(socketId, JSON.stringify({ type: "ping" }));
          if (event.type === "message" && JSON.parse(event.data).type === "pong") {
            clearTimeout(timeout); remove(); window.knorviaDesktop.wsClose(socketId); resolve("pong");
          }
        });
        window.knorviaDesktop.wsOpen(socketId, "/api/v1/ws");
      });
      return { url: location.href, status: response.status, backend: body.backend?.status, chat: pong };
    })()`);
    process.stdout.write(`DESKTOP_SMOKE=${JSON.stringify(result)}\n`, () => {});
    setTimeout(() => app.quit(), 250);
  }
  // The interface can paint while the heavier AI engine continues warming up.
  // Requests are safely buffered by the child-process pipe until ASGI is ready.
  void ready;
}

function stopKnorvia() {
  if (shuttingDown) return;
  shuttingDown = true;
  resolvePendingRequests(503, "Knorvia 正在关闭");
  assetStreamBroker?.failAll(new Error("Knorvia is shutting down"));
  if (engine?.stdin?.writable && !engine.stdin.destroyed) {
    try { engine.stdin.write(`${JSON.stringify({ kind: "shutdown" })}\n`, () => {}); } catch {}
  }
  // The renderer is stateless — kill it right away.
  if (frontend?.pid) spawnSync("taskkill", ["/pid", String(frontend.pid), "/t", "/f"], { windowsHide: true });
  // The engine gets a short grace window to process the shutdown message and
  // flush SQLite writes; it is force-killed only after the window elapses or
  // the child exits on its own first.
  const enginePid = engine?.pid;
  const killEngine = () => {
    if (enginePid) spawnSync("taskkill", ["/pid", String(enginePid), "/t", "/f"], { windowsHide: true });
  };
  if (!enginePid) {
    frontend = undefined; engine = undefined;
    return;
  }
  const forceKillTimer = setTimeout(killEngine, ENGINE_SHUTDOWN_GRACE_MS);
  forceKillTimer.unref?.();
  const onExit = () => { clearTimeout(forceKillTimer); };
  if (engine.exitCode !== null || engine.signalCode !== null) onExit();
  else engine.once("exit", onExit);
  frontend = undefined; engine = undefined;
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
app.on("before-quit", () => {
  try { require("electron").globalShortcut.unregisterAll(); } catch {}
  stopKnorvia();
});
app.on("window-all-closed", () => app.quit());
