const { app, BrowserWindow, dialog, ipcMain, protocol, shell } = require("electron");
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

function loadingPage() {
  const logo = fs.readFileSync(path.join(__dirname, "build", "logo.png")).toString("base64");
  const html = `<!doctype html><meta charset="utf-8"><title>Knorvia</title>
  <style>body{margin:0;background:#f7f8fc;color:#18181b;font:15px system-ui;display:grid;place-items:center;height:100vh}.box{text-align:center}.logo{width:96px;height:96px;object-fit:contain;filter:drop-shadow(0 16px 22px #24324a24)}h1{font-size:25px;margin:18px 0 8px;letter-spacing:-.03em}.muted{color:#71717a}.dot{display:inline-block;animation:p 1.2s infinite}@keyframes p{50%{opacity:.25}}</style>
  <div class="box"><img class="logo" src="data:image/png;base64,${logo}" alt=""><h1>Knorvia</h1><div class="muted">正在启动桌面 AI 引擎… <span class="dot">●</span></div></div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1050, minHeight: 700, show: false,
    autoHideMenuBar: true, backgroundColor: "#f7f8fc",
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), contextIsolation: true,
      nodeIntegration: false, sandbox: true,
    },
  });
  mainWindow.loadURL(loadingPage());
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternal(url); return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("knorvia://app/")) {
      event.preventDefault();
      openAllowedExternal(url);
    }
  });
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
app.on("before-quit", stopKnorvia);
app.on("window-all-closed", () => app.quit());
