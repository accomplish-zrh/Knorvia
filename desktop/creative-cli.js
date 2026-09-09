#!/usr/bin/env node
'use strict';

// Knorvia creative CLI — the external-Agent entrance to the creation studio.
//
//   node creative-cli.js [--home <dir>] [--url <u> --token <t>] [--standalone]
//                        [--timeout <ms>] <command> [json-params]
//
// Contract (B02/B16): one JSON document on stdout ({ok:true,result} or
// {ok:false,error:{code,message}}), human diagnostics on stderr, stable exit
// codes (see EXIT_CODES below). Commands are the allow-listed set exported by
// creative-cli-service; there is no raw RPC pass-through. The CLI talks to the
// same controlled service the desktop UI uses: either by attaching to a
// running desktop/gateway (discovery file) or by booting its own equivalent
// stack against an explicit --home (the daemon Home lock keeps the two modes
// mutually exclusive).

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const { createCreativeCliService, EXIT_CODES, SERVICE_VERSION } = require('./creative-cli-service');

const DEFAULT_HOME = process.env.KNORVIA_NATIVE_HOME || path.resolve(__dirname, '..', 'desktop-data');
const DEFAULT_TIMEOUT_MS = 30_000;

function usage(stderr) {
  stderr.write(`Knorvia 创作 CLI（外部 Agent 操作创作台）

用法:
  creative-cli [选项] <command> [JSON参数]
  creative-cli schema
  creative-cli serve [--port 4420-4429]

连接选项:
  --home <dir>      Knorvia Home（默认 ${DEFAULT_HOME}）。
                    优先读取 <home>/state/creative-cli.json 连接运行中的桌面服务。
  --url --token     直连一个 creative-cli 回环服务。
  --standalone      不连接现有服务；针对 --home 自举完整创作栈（需要 knorvia-daemon）。
  --daemon-bin <p>  standalone 模式守护进程路径（否则自动探测 KNORVIA_DAEMON_BIN）。
  --timeout <ms>    单命令超时（默认 ${DEFAULT_TIMEOUT_MS}）。
  --port <n>        仅 serve 模式：固定端口（4420–4429）或临时端口。

命令（参数为 JSON 对象，'-' 表示从 stdin 读取）:
  status
  tools list | tools describe {"name":...} | tools call {"name":...,"arguments":{...}}
  jobs list {"typePrefix":"media.","offset":0,"limit":20} | jobs read {"id":...}
          | jobs wait {"id":...,"timeoutMs":60000} | jobs cancel {"id":...}
  library list | library read {"id":...} | library versions {"id":...}
          | library write {"path":...,"text":...,"expectedSha256":...}
          | library put {"sourcePath":...,"destination":...}
          | library trash {"path":...} | library restore {"id":...} | library search {"query":...}
  artifacts list {"folder":"learning/"}
  extension list | extension enable {"id":...,"revision":...,"enabled":true}
          | extension uninstall {"id":...,"revision":...} | extension rollback {"id":...,"revision":...,"version":...}

错误码: 0 成功; 2 用法错误; 3 未找到; 4 冲突/正在忙; 5 超时; 6 缺依赖;
        7 执行失败; 8 服务不可用/拒绝。
输出: stdout 仅一条 JSON 文档；stderr 为诊断信息。
`);
}

function parseArgs(argv) {
  const options = { timeoutMs: DEFAULT_TIMEOUT_MS, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') options._.push('help');
    else if (arg === '--home') options.home = argv[++i];
    else if (arg === '--url') options.url = argv[++i];
    else if (arg === '--token') options.token = argv[++i];
    else if (arg === '--standalone') options.standalone = true;
    else if (arg === '--daemon-bin') options.daemonBin = argv[++i];
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]);
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (!arg.startsWith('--')) options._.push(arg);
    else throw Object.assign(new Error(`未知选项 ${arg}`), { cliCode: 'usage' });
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw Object.assign(new Error('--timeout 必须是正整数毫秒'), { cliCode: 'usage' });
  if (Boolean(options.url) !== Boolean(options.token)) throw Object.assign(new Error('--url 与 --token 必须一起提供'), { cliCode: 'usage' });
  for (const flag of ['--home', '--daemon-bin', '--url', '--token', '--port', '--timeout']) {
    const index = argv.indexOf(flag);
    if (index >= 0 && (!argv[index + 1] || argv[index + 1].startsWith('--'))) throw Object.assign(new Error(`${flag} 缺少参数`), { cliCode: 'usage' });
  }
  if (!options._.length) throw Object.assign(new Error('缺少命令'), { cliCode: 'usage' });
  const items = options._;
  // Grammar: `group.action` (e.g. `tools list`) or a dotted command
  // (e.g. `learning.lecture.create`); the next positional is the JSON params.
  if (items[0].includes('.') || (items[1] && (items[1].startsWith('{') || items[1] === '-'))) {
    options.command = items[0];
    options.paramsText = items.slice(1).join(' ');
  } else {
    options.command = items.length >= 2 ? `${items[0]}.${items[1]}` : items[0];
    options.paramsText = items.slice(2).join(' ');
  }
  return options;
}

async function readParams(text) {
  if (!text || !text.trim()) return {};
  const raw = text.trim() === '-' ? fs.readFileSync(0, 'utf8') : text;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON 对象');
    return parsed;
  } catch (error) {
    throw Object.assign(new Error(`参数不是有效 JSON 对象：${error.message}`), { cliCode: 'usage' });
  }
}

function discoveryFor(home) {
  const file = path.join(home, 'state', 'creative-cli.json');
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (record?.serviceVersion !== SERVICE_VERSION || typeof record.url !== 'string' || typeof record.token !== 'string') return null;
  try { validateEndpoint(record); } catch { return null; }
  return { ...record, file };
}

function validateEndpoint({ url, token }) {
  let target;
  try { target = new URL(url); } catch { throw Object.assign(new Error('创作服务地址无效'), { cliCode: 'usage' }); }
  if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password || target.pathname !== '/creative-cli' || target.search || target.hash || typeof token !== 'string' || !token) {
    throw Object.assign(new Error('创作服务必须使用带鉴权的本机回环 /creative-cli 地址'), { cliCode: 'usage' });
  }
}

async function sendCommand({ url, token, command, params, timeoutMs, stderr }) {
  validateEndpoint({ url, token });
  const response = await fetch(url, {
    redirect: 'error',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: `cli-${Date.now()}`, command, params }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(error => {
    if (error.name === 'TimeoutError') throw Object.assign(new Error(`命令超时（${timeoutMs}ms）`), { cliCode: 'timeout' });
    throw Object.assign(new Error(`无法连接创作服务 ${url}：${error.message}。可尝试 --standalone --home <目录> 自举本地栈。`), { cliCode: 'unavailable' });
  });
  let body;
  try { body = await response.json(); } catch { throw Object.assign(new Error(`创作服务返回非 JSON 响应（HTTP ${response.status}）`), { cliCode: 'failed' }); }
  if (response.status === 403) throw Object.assign(new Error('创作服务拒绝了本次连接（token 或来源不符）'), { cliCode: 'unavailable' });
  if (!response.ok) throw Object.assign(new Error(`创作服务 HTTP ${response.status}`), { cliCode: 'failed' });
  return body;
}

function emit(stdout, body) {
  stdout.write(`${JSON.stringify(body)}\n`);
}

function exitFor(body) {
  if (body.ok) return 0;
  return EXIT_CODES[body.error?.code] ?? 7;
}

async function runStandalone(options, command, params, stderr) {
  const { createKernelEngine } = require('./kernel-engine');
  const { createPersonalLibrary } = require('./personal-library');
  const { createMediaStudio } = require('./media-studio');
  const { createExtensionManager } = require('./extension-manager');
  const { createLearningPack } = require('./learning-pack');
  const { createOpenmaicCourse } = require('./openmaic-course');
  const { createLibraryImageOps } = require('./library-image-ops');
  const { createCuratedCatalog } = require('./curated-catalog');
  if (!options.home) throw Object.assign(new Error('standalone 模式需要 --home 指向一个 Knorvia Home'), { cliCode: 'usage' });
  const home = path.resolve(options.home);
  const env = { ...process.env };
  if (options.daemonBin) env.KNORVIA_DAEMON_BIN = path.resolve(options.daemonBin);
  stderr.write(`[creative-cli] standalone：Home=${home}\n`);
  let engine; let studio; let service;
  try {
    engine = await createKernelEngine({ home, env, version: 'creative-cli' });
    const rpc = async (method, params2 = {}) => {
      const message = await engine.rpc(method, params2);
      return message;
    };
    const library = createPersonalLibrary({ home, rpc });
    studio = createMediaStudio({ home, rpc, library });
    await studio.initialize();
    const extensionManager = createExtensionManager({ home, rpc });
    await extensionManager.restore().catch(error => stderr.write(`[creative-cli] 扩展恢复未完成：${error.message}\n`));
    const learning = createLearningPack({ home, library, studio, rpc });
    const catalog = createCuratedCatalog({ home, library, studio, extensionManager, rpc });
    const course = createOpenmaicCourse({ library });
    const imageOps = createLibraryImageOps({ library });
    service = createCreativeCliService({ home, rpc, library, studio, extensionManager, learning, catalog, course, imageOps });
    await service.listen();
    stderr.write(`[creative-cli] 服务已就绪 ${service.address}\n`);
    return await service.dispatch(command, params);
  } finally {
    try { await service?.close(); } catch {}
    try { await studio?.close(); } catch {}
    try { await engine?.shutdown(); } catch {}
  }
}

async function main() {
  const stdout = process.stdout;
  const stderr = process.stderr;
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) {
    stderr.write(`${error.message}\n\n`);
    usage(stderr);
    emit(stdout, { ok: false, error: { code: 'usage', message: error.message } });
    process.exitCode = EXIT_CODES.usage;
    return;
  }
  if (options.command === 'help' || options.command === '--help') { usage(stderr); process.exitCode = 0; return; }
  if (options.command === 'schema') {
    emit(stdout, {
      ok: true,
      result: {
        serviceVersion: SERVICE_VERSION,
        exitCodes: EXIT_CODES,
        commands: [
          'status', 'tools.list', 'tools.describe', 'tools.call',
          'jobs.list', 'jobs.read', 'jobs.wait', 'jobs.cancel',
          'library.list', 'library.read', 'library.versions', 'library.write', 'library.put',
          'library.trash', 'library.restore', 'library.search',
          'artifacts.list', 'extension.list', 'extension.enable', 'extension.uninstall', 'extension.rollback',
          'learning.sources', 'learning.lecture.create', 'learning.lecture.read',
          'learning.quiz.create', 'learning.quiz.read', 'learning.attempt.record',
          'learning.mastery.read', 'learning.review.due',
          'catalog.list', 'catalog.preflight',
        ],
      },
    });
    return;
  }
  let params;
  try { params = await readParams(options.paramsText); } catch (error) {
    emit(stdout, { ok: false, error: { code: 'usage', message: error.message } });
    process.exitCode = EXIT_CODES.usage;
    return;
  }

  try {
    let result;
    if (options.command === 'serve') {
      await serve(options, stderr);
      return;
    }
    if (options.standalone) {
      result = await runStandalone(options, options.command, params, stderr);
      emit(stdout, { ok: true, result });
      return;
    }
    const endpoint = options.url && options.token
      ? { url: options.url, token: options.token }
      : discoveryFor(path.resolve(options.home || DEFAULT_HOME));
    if (!endpoint) {
      throw Object.assign(
        new Error(`没有发现运行中的创作服务（${path.resolve(options.home || DEFAULT_HOME)}）。若桌面应用未开启，可用 --standalone --home <目录> 自举。`),
        { cliCode: 'unavailable' },
      );
    }
    const body = await sendCommand({ ...endpoint, command: options.command, params, timeoutMs: options.timeoutMs, stderr });
    emit(stdout, body);
    process.exitCode = exitFor(body);
    return;
  } catch (error) {
    const code = error.cliCode ?? 'failed';
    emit(stdout, { ok: false, error: { code, message: error.rpc?.message || error.message, ...(error.rpc?.reason ? { reason: error.rpc.reason } : {}) } });
    process.exitCode = EXIT_CODES[code] ?? 7;
  }
}

// serve 模式：standalone 栈常驻，供同一终端/外部 Agent 连续调用；stdin 关闭或
// SIGINT 时退出。stdout 只在启动完成时输出一次 JSON 就绪文档。
async function serve(options, stderr) {
  const discovery = discoveryFor(path.resolve(options.home || DEFAULT_HOME));
  if (discovery && !options.standalone) {
    stderr.write('[creative-cli] 已有运行中的创作服务，无需 serve；直接使用普通命令即可。\n');
    process.stdout.write(`${JSON.stringify({ ok: true, result: { attached: true, url: discovery.url, pid: discovery.pid } })}\n`);
    return;
  }
  const { createKernelEngine } = require('./kernel-engine');
  const { createPersonalLibrary } = require('./personal-library');
  const { createMediaStudio } = require('./media-studio');
  const { createExtensionManager } = require('./extension-manager');
  const { createLearningPack } = require('./learning-pack');
  const { createOpenmaicCourse } = require('./openmaic-course');
  const { createLibraryImageOps } = require('./library-image-ops');
  const { createCuratedCatalog } = require('./curated-catalog');
  if (!options.home) throw Object.assign(new Error('serve 模式需要 --home'), { cliCode: 'usage' });
  const home = path.resolve(options.home);
  const env = { ...process.env };
  if (options.daemonBin) env.KNORVIA_DAEMON_BIN = path.resolve(options.daemonBin);
  const engine = await createKernelEngine({ home, env, version: 'creative-cli' });
  const rpc = (method, params2 = {}) => engine.rpc(method, params2);
  const library = createPersonalLibrary({ home, rpc });
  const studio = createMediaStudio({ home, rpc, library });
  await studio.initialize();
  const extensionManager = createExtensionManager({ home, rpc });
  await extensionManager.restore().catch(() => {});
  const learning = createLearningPack({ home, library, studio, rpc });
  const catalog = createCuratedCatalog({ home, library, studio, extensionManager, rpc });
  const course = createOpenmaicCourse({ library });
  const imageOps = createLibraryImageOps({ library });
  const service = createCreativeCliService({ home, rpc, library, studio, extensionManager, learning, catalog, course, imageOps, port: options.port ?? 0 });
  const record = await service.listen();
  stderr.write('[creative-cli] serve 就绪；Ctrl+C、关闭 stdin 或删除发现文件即可退出。\n');
  process.stdout.write(`${JSON.stringify({ ok: true, result: { serving: true, url: record.url, pid: record.pid, home } })}\n`);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { await service.close(); } catch {}
    try { await studio.close(); } catch {}
    try { await engine.shutdown(); } catch {}
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.on('end', stop);
  // Windows hard-kills skip signal handlers and orphan the daemon; deleting
  // the discovery file is the operator's clean-stop switch that always works.
  const watchdog = setInterval(() => {
    if (!discoveryFor(home)) { clearInterval(watchdog); void stop(); }
  }, 3000);
  watchdog.unref?.();
  await new Promise(() => {});
}

if (require.main === module) {
  main().catch(error => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error.cliCode ?? 'failed', message: error.message } })}\n`);
    process.exitCode = EXIT_CODES[error.cliCode ?? 'failed'] ?? 7;
  });
}

module.exports = { parseArgs, readParams, discoveryFor, sendCommand, exitFor, runStandalone, DEFAULT_HOME, DEFAULT_TIMEOUT_MS };
