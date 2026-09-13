'use strict';

// Loopback control service for the external creative CLI (KNORVIA-NIGHT B02).
// It exposes the SAME controlled handler objects the desktop workbench and the
// Kernel use (media studio, personal library, extensions, learning pack,
// curated catalog). It is not a second agent loop and never forwards raw RPC:
// every command is an allow-listed mapping with a stable JSON contract.
// Discovery: the service writes <home>/state/creative-cli.json (bearer token,
// loopback URL, pid) so `desktop/creative-cli.js` can attach to the running
// desktop stack; when absent, the CLI may boot its own equivalent stack.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TOOLS, callMediaTool } = require('./studio-mcp');

const SERVICE_VERSION = 1;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Stable machine codes surfaced to CLI clients. Exit codes live in
// creative-cli.js; this mapping is the single source of truth for both.
const EXIT_CODES = {
  usage: 2,
  'not-found': 3,
  conflict: 4,
  busy: 4,
  timeout: 5,
  'dependency-missing': 6,
  failed: 7,
  refused: 8,
  unavailable: 8,
};

function rpcToErrorCode(error) {
  if (error?.reason && EXIT_CODES[error.reason]) return error.reason;
  const code = error?.rpc?.code;
  if (code === -32602) return 'usage';
  if (code === -32601) return 'usage';
  if (code === -32004) return 'not-found';
  if (code === -32005) return 'conflict';
  if (code === -32042) return 'busy';
  if (code === -32091 || code === -32093) return 'unavailable';
  if (code === -32094) return 'conflict';
  return 'failed';
}

function commandError(code, message, details) {
  const error = new Error(message);
  error.cliCode = code;
  if (details !== undefined) error.cliDetails = details;
  return error;
}

const intParam = (value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw commandError('usage', `参数 ${name} 必须是 ${min}–${max} 的整数`);
  return value;
};

// The tool surface is the single media tool list shared with the Kernel MCP
// endpoint, plus learning/catalog tools contributed by their own modules.
function mediaToolDescriptors() {
  return TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, source: 'media' }));
}

function createCreativeCliService({
  home,
  rpc,
  library,
  studio,
  extensionManager,
  learning,
  catalog,
  imageOps,
  course,
  port = 0,
  version = '0.0.0-dev',
  bootTime = Date.now(),
}) {
  if (!path.isAbsolute(home || '')) throw new Error('creative-cli service requires an absolute Home');
  const token = crypto.randomBytes(32).toString('base64url');
  const discoveryFile = path.join(home, 'state', 'creative-cli.json');
  const startedAt = new Date().toISOString();

  // Command registry. Every entry is an explicit allow-listed mapping; there
  // is deliberately no pass-through RPC command.
  const COMMANDS = {
    'status': async () => {
      let workspaceId;
      try { workspaceId = typeof studio?.workspaceId === 'function' ? studio.workspaceId() : undefined; } catch { /* media can still be warming up while library commands are ready */ }
      return ({
      product: 'Knorvia',
      version,
      serviceVersion: SERVICE_VERSION,
      home,
      workspaceId,
      mediaReady: Boolean(workspaceId),
      pid: process.pid,
      startedAt,
      mode: 'attached',
    }); },
    'tools.list': async () => {
      const extra = [];
      if (learning?.toolDescriptors) extra.push(...learning.toolDescriptors());
      if (catalog?.toolDescriptors) extra.push(...catalog.toolDescriptors());
      if (course?.toolDescriptors) extra.push(...course.toolDescriptors());
      if (imageOps?.toolDescriptors) extra.push(...imageOps.toolDescriptors());
      return { tools: [...mediaToolDescriptors(), ...extra] };
    },
    'tools.describe': async params => {
      const all = [
        ...mediaToolDescriptors(),
        ...(learning?.toolDescriptors?.() ?? []),
        ...(catalog?.toolDescriptors?.() ?? []),
        ...(course?.toolDescriptors?.() ?? []),
        ...(imageOps?.toolDescriptors?.() ?? []),
      ];
      const tool = all.find(item => item.name === params.name);
      if (!tool) throw commandError('not-found', `没有名为 ${params.name} 的创作工具`);
      return tool;
    },
    'tools.call': async params => {
      const name = params.name;
      const args = params.arguments ?? {};
      if (typeof name !== 'string') throw commandError('usage', 'tools.call 需要 name');
      const handled = await learning?.callTool?.(name, args);
      if (handled !== undefined) return handled;
      const catalogResult = await catalog?.callTool?.(name, args);
      if (catalogResult !== undefined) return catalogResult;
      const courseResult = await course?.callTool?.(name, args);
      if (courseResult !== undefined) return courseResult;
      const imageResult = await imageOps?.callTool?.(name, args);
      if (imageResult !== undefined) return imageResult;
      return callMediaTool({ studio, library, name, params: args });
    },
    'jobs.list': async params => {
      if (!rpc) throw commandError('unavailable', '当前服务没有可用的任务存储连接');
      return rpc('job/list', {
        workspaceId: studio.workspaceId(),
        typePrefix: typeof params.typePrefix === 'string' ? params.typePrefix.slice(0, 60) : '',
        offset: intParam(params.offset, 'offset') ?? 0,
        limit: intParam(params.limit, 'limit', { max: 100 }) ?? 20,
      });
    },
    'jobs.read': async params => {
      if (!rpc) throw commandError('unavailable', '当前服务没有可用的任务存储连接');
      const job = await rpc('job/read', { id: params.id });
      // The personal creation workspace holds media.* generations and the
      // studio.* edit/render/subtitle/retake/sequence jobs — nothing else.
      if (job.workspaceId !== studio.workspaceId() || !/^(media\.|studio\.)/.test(String(job.type || ''))) throw commandError('not-found', '不是本资料库工作区的创作任务');
      return job;
    },
    'jobs.wait': async params => {
      const timeoutMs = Math.min(intParam(params.timeoutMs, 'timeoutMs', { max: 10 * 60 * 1000 }) ?? 60_000, 10 * 60 * 1000);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const job = await COMMANDS['jobs.read']({ id: params.id });
        if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return { job, outcome: 'terminal' };
        if (Date.now() >= deadline) return { job, outcome: 'timeout' };
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    },
    'jobs.resume': async params => {
      if (typeof studio.handlers['studio/resume'] !== 'function') throw commandError('unavailable', '当前服务不支持任务恢复');
      return studio.handlers['studio/resume'](params);
    },
    'jobs.cancel': async params => {
      // Cancellation is per job family: generations, edit renders, subtitle,
      // retake and sequence jobs each own their durable cancel path.
      const job = await COMMANDS['jobs.read']({ id: params.id });
      const type = String(job.type || '');
      if (type === 'studio.render') return studio.handlers['studio/edit/render/cancel'](params);
      if (type === 'studio.subtitle') return studio.handlers['studio/edit/subtitles/cancel'](params);
      if (type === 'studio.retake') return studio.handlers['studio/edit/retake/cancel'](params);
      if (type.startsWith('studio.sequence')) return studio.handlers['studio/sequence/cancel']({ id: params.id, agentRequested: true });
      return studio.handlers['studio/cancel'](params);
    },
    'library.list': async () => library.handlers['library/list'](),
    'library.read': async params => {
      const part = await library.handlers['library/read']({ ...params, offset: intParam(params.offset, 'offset') ?? 0 });
      // Reading bytes is bounded: one chunk per call, explicit continuation.
      return part;
    },
    'library.versions': async params => library.handlers['library/versions'](params),
    'library.write': async params => library.handlers['library/write'](params),
    'library.put': async params => {
      // Ingesting an existing host file into the user's library mirrors the
      // UI upload action; the CLI can never read files back outside the
      // library and every import is visible in the workbench.
      if (typeof params.sourcePath !== 'string' || !params.sourcePath.trim()) throw commandError('usage', 'library.put 需要 sourcePath');
      return library.put(path.resolve(params.sourcePath), params.destination, params.expectedSha256);
    },
    'library.trash': async params => library.handlers['library/trash'](params),
    'library.restore': async params => library.handlers['library/restore'](params),
    'library.search': async params => library.handlers['library/search'](params),
    'artifacts.list': async params => {
      // Creation artifacts = versioned learning/library documents plus durable
      // media render outputs; both are visible in the workbench.
      const index = await library.handlers['library/list']();
      const folder = typeof params.folder === 'string' ? params.folder : '';
      const entries = index.entries
        .filter(entry => !entry.trashedAt && /\.(json|md|srt|mp4|webm|png|jpe?g|webp|gif)$/i.test(entry.name))
        .filter(entry => !folder || entry.path.startsWith(folder))
        .slice(0, 200)
        .map(entry => ({ id: entry.id, path: entry.path, name: entry.name, sha256: entry.sha256, size: entry.size, modifiedAt: entry.modifiedAt }));
      return { entries };
    },
    'extension.list': async () => {
      if (!extensionManager) throw commandError('unavailable', '当前服务没有扩展管理器');
      return extensionManager.handlers['extension/list']();
    },
    'extension.enable': async params => {
      if (!extensionManager) throw commandError('unavailable', '当前服务没有扩展管理器');
      return extensionManager.handlers['extension/enable'](params);
    },
    'extension.uninstall': async params => {
      if (!extensionManager) throw commandError('unavailable', '当前服务没有扩展管理器');
      return extensionManager.handlers['extension/uninstall'](params);
    },
    'extension.rollback': async params => {
      if (!extensionManager) throw commandError('unavailable', '当前服务没有扩展管理器');
      return extensionManager.handlers['extension/rollback'](params);
    },
    ...learning?.commands,
    ...catalog?.commands,
    ...course?.commands,
    ...imageOps?.commands,
  };

  function writeDiscovery() {
    const record = {
      serviceVersion: SERVICE_VERSION,
      url: `http://127.0.0.1:${server.address().port}/creative-cli`,
      token,
      pid: process.pid,
      startedAt,
      scope: 'creative',
    };
    fs.mkdirSync(path.dirname(discoveryFile), { recursive: true });
    const temporary = `${discoveryFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, discoveryFile);
    return record;
  }

  function removeDiscovery() {
    try {
      const record = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
      if (record?.pid !== process.pid || record?.token !== token) return;
    } catch { return; }
    fs.unlinkSync(discoveryFile);
  }

  const activeRequests = new Set();
  let closing = false;
  async function dispatch(command, params) {
    if (closing) throw commandError('temporary', 'Creative CLI is shutting down');
    if (typeof command !== 'string' || !command || (params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params)))) throw commandError('usage', '命令需要名称和 JSON 对象参数');
    // Learning/catalog modules use the codebase's slash convention
    // (learning/sources); the CLI contract is dot-form, so normalize.
    const key = Object.hasOwn(COMMANDS, command) ? command : command.replaceAll('.', '/');
    const handler = Object.hasOwn(COMMANDS, key) ? COMMANDS[key] : null;
    if (!handler) throw commandError('usage', `未知命令 ${command}；用 schema 查看可用命令`);
    const operation = Promise.resolve().then(() => handler(params ?? {}));
    activeRequests.add(operation);
    try { return await operation; }
    finally { activeRequests.delete(operation); }
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
    const url = new URL(req.url || '/', 'http://knorvia.local');
    if (url.pathname !== '/creative-cli' || req.headers.authorization !== `Bearer ${token}` || req.headers.origin) { send(403, { error: 'forbidden' }); return; }
    if (req.method !== 'POST') { send(405, { error: 'method_not_allowed' }); return; }
    let length = 0; const chunks = []; let message;
    try {
      for await (const chunk of req) { length += chunk.length; if (length > MAX_BODY_BYTES) { send(413, { error: 'request_too_large' }); return; } chunks.push(chunk); }
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { send(400, { error: 'invalid_json' }); return; }
    const id = message?.id;
    try {
      const result = await dispatch(message.command, message.params);
      send(200, { id, ok: true, result });
    } catch (error) {
      const code = error.cliCode ?? rpcToErrorCode(error);
      send(200, { id, ok: false, error: { code, message: error.rpc?.message || error.message, ...(error.cliDetails !== undefined ? { details: error.cliDetails } : {}), ...(error.rpc?.reason ? { reason: error.rpc.reason } : {}) } });
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 15 * 60 * 1000; // jobs.wait may hold a long poll.

  async function listen() {
    if (Number(port) !== 0 && !(Number.isSafeInteger(Number(port)) && Number(port) >= 4420 && Number(port) <= 4429)) {
      throw new Error('creative-cli 固定端口必须在 B 路区间 4420–4429，或留空使用临时端口');
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port) || 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    const record = writeDiscovery();
    return record;
  }

  async function close(context = {}) {
    closing = true;
    try { removeDiscovery(); } catch {}
    server.closeAllConnections?.();
    const serverClosed = new Promise(resolve => server.close(() => resolve()));
    const drained = Promise.allSettled([serverClosed, ...activeRequests]).then(() => true);
    if (!context.signal) { await drained; return { confirmed: true, ownedPids: [], detail: 'Creative CLI admissions frozen and requests drained' }; }
    if (context.signal.aborted) return { confirmed: false, ownedPids: [], detail: `${activeRequests.size} Creative CLI request(s) remained in flight` };
    const aborted = new Promise(resolve => context.signal.addEventListener('abort', () => resolve(false), { once: true }));
    if (!await Promise.race([drained, aborted])) return { confirmed: false, ownedPids: [], detail: `${activeRequests.size} Creative CLI request(s) remained in flight` };
    return { confirmed: true, ownedPids: [], detail: 'Creative CLI admissions frozen and requests drained' };
  }

  return { COMMANDS, dispatch, listen, close, get address() { return `http://127.0.0.1:${server.address()?.port}/creative-cli`; }, token, discoveryFile };
}

module.exports = { createCreativeCliService, rpcToErrorCode, EXIT_CODES, SERVICE_VERSION, MAX_BODY_BYTES };
