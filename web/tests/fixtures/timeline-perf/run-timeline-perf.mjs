'use strict';
// P07 performance + interaction harness. Drives the real Chrome browser
// against the real Next dev server with the native gateway WebSocket
// intercepted, so every measurement and interaction below runs the actual
// product components (TaskTimeline, ConversationNavigation, TaskComposer,
// approvals and user-input cards) with no daemon and no model involved.
//
// Phases:
//   perf          – 3000-item render, typing latency, live streaming cost
//   boundedness   – DOM size at 1000 vs 5000 items (window must not scale)
//   interactions  – approvals/user-input present, mid-history prepend with
//                   scroll anchoring, tool expand/collapse mounting, reading-
//                   position restore after reload, locating an unmounted
//                   message through ConversationNavigation, long-text
//                   selection, built-in find.
//
// Usage: node run-timeline-perf.mjs --out <path> [--webroot <web dir>] [--port 4477]

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const webRoot = path.resolve(arg('webroot', path.resolve(__dirname, '..', '..', '..')));
const PORT = Number(arg('port', 4477));
const OUT = arg('out', path.join(webRoot, 'dist', 'timeline-perf', 'result.json'));

// --- synthetic threads ---------------------------------------------------------

const markdownChunk = (seed) => `### 分析 ${seed}\n\n这是第 ${seed} 条助手消息，包含**加粗**、\`代码\`与列表：\n\n1. 第一项说明\n2. 第二项说明\n\n\`\`\`js\nconsole.log(${seed});\n\`\`\`\n\n结论：性能测量样本 ${seed}。`;
const outputChunk = (seed) => Array.from({ length: 240 }, (_, i) => `[${seed}:${i}] step ok, elapsed 12ms, bytes 4096`).join('\n');

function buildItem(index) {
  const id = `it-${String(index).padStart(5, '0')}`;
  const turnId = `turn-${Math.floor(index / 4)}`;
  const kindCycle = index % 5;
  if (kindCycle === 0) {
    return { id, threadId: 'perf', turnId, kind: 'userMessage', status: 'completed', seq: index + 1, payload: { text: `这是第 ${index} 条用户输入，请继续处理并给出分析。` } };
  }
  if (kindCycle === 1) {
    return { id, threadId: 'perf', turnId, kind: 'agentMessage', status: 'completed', seq: index + 1, payload: { text: markdownChunk(index) } };
  }
  if (kindCycle === 2) {
    return { id, threadId: 'perf', turnId, kind: 'commandExecution', status: 'completed', seq: index + 1, payload: { command: `node scripts/build-${index}.js`, exitCode: 0, aggregatedOutput: outputChunk(index) } };
  }
  if (kindCycle === 3) {
    return { id, threadId: 'perf', turnId, kind: 'reasoning', status: 'completed', seq: index + 1, payload: { summary: [`步骤 ${index}：先读取上下文，再决定工具调用顺序。`] } };
  }
  return { id, threadId: 'perf', turnId, kind: 'web_search', status: 'completed', seq: index + 1, payload: { query: 'performance measurement', results: Array.from({ length: 12 }, (_, i) => ({ title: `result ${i}`, snippet: 'x'.repeat(400) })) } };
}

function threadSnapshot({ count, offset = 0, approvals = false, userInput = false, hasMore = false, subAgentSpan = false }) {
  const items = Array.from({ length: count }, (_, index) => buildItem(index + offset));
  if (subAgentSpan) {
    // A sub-agent group whose members straddle a chunk boundary: index 299
    // closes chunk 0 and index 300 opens chunk 1. The provider orders items
    // by seq, so the pair replaces the regular items at those positions.
    items[299] = { id: 'sub-1', threadId: 'perf', turnId: 'turn-span', kind: 'subAgent', status: 'completed', seq: 300, payload: { kernelThreadId: 'k-span', kernelTurnId: 'kt-span', event: 'turn/completed', data: { turn: { status: 'completed' } } } };
    items[300] = { id: 'sub-2', threadId: 'perf', turnId: 'turn-span', kind: 'subAgent', status: 'completed', seq: 301, payload: { kernelThreadId: 'k-span', kernelTurnId: 'kt-span', event: 'turn/completed', data: { turn: { status: 'completed' } } } };
  }
  return {
    id: 'perf',
    workspaceId: 'ws1',
    title: 'P07 性能夹具',
    status: 'ready',
    revision: 1,
    createdAt: '2026-09-10T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
    items,
    turns: [{ id: 'turn-0', status: 'completed', createdAt: '2026-09-10T00:00:00Z' }],
    pendingApprovals: approvals ? [{ id: 'ap-1', threadId: 'perf', turnId: 'turn-0', action: 'kernel.commandExecution', status: 'pending', target: { command: 'npm test', cwd: '/tmp/project' } }] : [],
    pendingUserInputs: userInput ? [{ id: 'ui-1', threadId: 'perf', turnId: 'turn-0', kind: 'userInput', status: 'waiting_input', seq: count + 1, payload: { request: { questions: [{ id: 'q1', header: '需求', question: '请补充目标读者和篇幅要求' }] } } }] : [],
    activeTurn: null,
    hasMoreItems: hasMore,
    itemsNextCursor: hasMore ? 400 : null,
  };
}

// --- mock gateway ---------------------------------------------------------------

function attachGateway(page, state) {
  let deltaListeners = [];
  return {
    async install() {
      await page.route('**/api/knorvia/native/session', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'perf-token', expiresAt: Date.now() + 3600_000 }),
      }));
      await page.routeWebSocket(/\/api\/knorvia\/native$/, ws => {
        ws.onMessage(message => {
          try {
            const parsed = JSON.parse(message);
            if (parsed && parsed.id !== undefined) {
              const { method } = parsed;
              const startedAt = Date.now();
              let result = {};
              if (method === 'connection/read') result = { capabilities: {}, providers: [] };
              else if (method === 'model/list') result = [{ id: 'mock-model', displayName: 'Mock', isDefault: true }];
              else if (method === 'workspace/list') result = [{ id: 'ws1', title: 'Perf', revision: 1, createdAt: 'x', updatedAt: 'x' }];
              else if (method === 'thread/list') result = { threads: [{ id: 'perf', workspaceId: 'ws1', title: 'P07 性能夹具', status: 'ready', revision: 1, createdAt: 'x', updatedAt: 'x', pendingApprovals: [], pendingUserInputs: [], activeTurn: null, lastTurn: null }], nextCursor: null };
              else if (method === 'thread/read') {
                if (typeof parsed.params?.beforeItemSeq === 'number' && !state.prepended) {
                  state.prepended = true;
                  state.thread = threadSnapshot({ count: 1200 });
                  result = threadSnapshot({ count: 400 });
                } else {
                  result = state.thread;
                }
              }
              const body = JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result });
              diagnostics.push(`${method} -> ${body.length} bytes in ${Date.now() - startedAt}ms`);
              ws.send(body);
            }
          } catch { /* ignore malformed frames */ }
        });
        deltaListeners.push(ws);
        ws.onClose(() => { deltaListeners = deltaListeners.filter(item => item !== ws); });
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'connection/state', params: { engineState: 'ready' } }));
      });
    },
    appendItem(item) {
      state.thread = { ...state.thread, items: [...state.thread.items, item] };
      for (const socket of deltaListeners) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'item/updated', params: { threadId: 'perf', item } }));
      }
    },
    sendDeltas(burst, chunk) {
      for (let i = 0; i < burst; i += 1) {
        const frame = { jsonrpc: '2.0', method: 'turn/event', params: { threadId: 'perf', turnId: 'turn-live', kind: 'agentMessage.delta', payload: { itemId: 'item-live', text: `实时片段 ${i}：${'流'.repeat(chunk) }` } } };
        for (const socket of deltaListeners) socket.send(JSON.stringify(frame));
      }
      return deltaListeners.length;
    },
  };
}

// --- measurement helpers ----------------------------------------------------------

const countItems = (page) => page.evaluate(() => document.querySelectorAll('[data-item-id]').length);
const countDom = (page) => page.evaluate(() => document.getElementsByTagName('*').length);

async function openTask(page, port) {
  const started = Date.now();
  await page.goto(`http://127.0.0.1:${port}/workbench/task/perf`, { timeout: 240000, waitUntil: 'commit' });
  // Manual polling (same mechanism proven to work in interactive debugging):
  // rAF-based waitForFunction can stall on a blank dev-compiling document.
  for (;;) {
    await page.waitForTimeout(2000);
    const state = await page.evaluate(() => ({
      timeline: Boolean(document.querySelector('.nw-timeline')),
      readyState: document.readyState,
      body: document.body ? document.body.innerText.slice(0, 120) : '',
    })).catch(error => ({ evaluateError: String(error).slice(0, 200) }));
    if (state.timeline) return Date.now() - started;
    if (Date.now() - started > 230000) {
      diagnostics.push(`openTask state: ${JSON.stringify(state)}`);
      throw new Error(`timeline did not mount: ${JSON.stringify(state)}`);
    }
  }
}

let diagnostics = [];

async function main() {
  const devServer = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-p', String(PORT)], {
    cwd: webRoot,
    env: { ...process.env, KNORVIA_NEXT_DIST_DIR: '.next-night-dev' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const report = { phases: {}, measuredAt: new Date().toISOString() };
  try {
    const deadline = Date.now() + 240000;
    for (;;) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/workbench`, { method: 'GET' }); if (r.ok || r.status === 404) break; } catch { /* warming */ }
      if (Date.now() > deadline) throw new Error('next dev did not become ready');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('pageerror', error => diagnostics.push(`pageerror: ${String(error).slice(0, 400)}`));
      page.on('console', message => { if (message.type() === 'error') diagnostics.push(`console: ${message.text().slice(0, 300)}`); });
      const state = { thread: threadSnapshot({ count: 3000 }) };
      const gateway = attachGateway(page, state);
      await gateway.install();

      // ---- phase: perf (3000 items) ----
      const renderMs = await openTask(page, PORT);
      await page.waitForFunction(() => document.querySelectorAll('[data-item-id]').length >= 1, null, { timeout: 60000 });
      const perf = { renderMs };
      perf.typing = await page.evaluate(async () => {
        const textarea = document.querySelector('.nw-composer textarea, textarea');
        if (!textarea) return null;
        const samples = [];
        textarea.focus();
        for (let i = 0; i < 20; i += 1) {
          const start = performance.now();
          textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
          textarea.value = `${textarea.value}a`;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(resolve => requestAnimationFrame(() => resolve()));
          samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        return { median: samples[10], worst: samples[samples.length - 1] };
      });
      const beforeDom = await countDom(page);
      const streamStart = Date.now();
      gateway.sendDeltas(60, 400);
      await page.waitForFunction(() => document.body.innerText.includes('实时片段 59'), null, { timeout: 60000 });
      perf.liveStreamMs = Date.now() - streamStart;
      perf.domNodes = await countDom(page);
      perf.domGrewDuringLive = perf.domNodes - beforeDom;
      perf.heapMB = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
      report.phases.perf = perf;

      // ---- phase: boundedness (DOM must not scale with history length) ----
      state.thread = threadSnapshot({ count: 1000 });
      await page.reload({ waitUntil: 'commit' });
      await page.waitForFunction(() => document.querySelectorAll('[data-item-id]').length >= 1, null, { timeout: 120000 });
      await page.waitForTimeout(500);
      const dom1000 = await countDom(page);
      state.thread = threadSnapshot({ count: 5000 });
      await page.reload({ waitUntil: 'commit' });
      await page.waitForFunction(() => document.querySelectorAll('[data-item-id]').length >= 1, null, { timeout: 120000 });
      await page.waitForTimeout(500);
      const dom5000 = await countDom(page);
      const interactions = { dom1000, dom5000, growthRatio: Number((dom5000 / dom1000).toFixed(3)) };

      // ---- phase: interactions (bounded window + real controls) ----
      state.thread = threadSnapshot({ count: 1200, approvals: true, userInput: true, hasMore: true });
      await page.reload({ waitUntil: 'commit' });
      await page.waitForFunction(() => document.querySelectorAll('[data-item-id]').length >= 1, null, { timeout: 120000 });
      await page.waitForTimeout(500);

      // (a) approval and additional-input cards are usable while history is windowed
      interactions.approvalCard = await page.getByText(/这一步需要你确认|This step needs your approval/).count() > 0;
      interactions.userInputCard = await page.getByText(/请补充目标读者和篇幅要求|Target readers/).count() > 0
        || (await page.locator('.nw-timeline').innerText()).includes('请补充目标读者和篇幅要求');

      // (b) the window shows a slice, and older chunks mount on demand
      interactions.mountedRows1200 = await countItems(page);

      // (b0) review: the default window must hold the NEWEST messages in
      // strict chronological DOM order.
      const order = await page.evaluate(() => [...document.querySelectorAll('[data-item-id]')].map(node => node.getAttribute('data-item-id')));
      const indexes = order.map(id => Number((id ?? '').replace('it-', '')));
      interactions.defaultWindow = {
        newestPresent: order[order.length - 1] === 'it-01199',
        strictlyAscending: indexes.every((value, i) => i === 0 || value > indexes[i - 1]),
        firstMounted: order[0],
      };
      interactions.defaultWindow.ok = interactions.defaultWindow.newestPresent
        && interactions.defaultWindow.strictlyAscending
        && interactions.defaultWindow.firstMounted === 'it-00300';

      const mountOlder = page.getByRole('button', { name: /显示更早的消息|Show earlier messages/ }).first();
      interactions.olderChunkButton = await mountOlder.count() > 0;
      await mountOlder.click();
      await page.waitForFunction(() => {
        const first = document.querySelector('[data-item-id]');
        return first?.getAttribute('data-item-id') === 'it-00000';
      }, null, { timeout: 30000 }).catch(() => {});
      const afterOlderOrder = await page.evaluate(() => [...document.querySelectorAll('[data-item-id]')].map(node => node.getAttribute('data-item-id')));
      const afterOlderIndexes = afterOlderOrder.map(id => Number((id ?? '').replace('it-', '')));
      interactions.olderChunk = {
        firstMounted: afterOlderOrder[0],
        ascending: afterOlderIndexes.every((value, i) => i === 0 || value > afterOlderIndexes[i - 1]),
        ok: afterOlderOrder[0] === 'it-00000' && afterOlderIndexes.every((value, i) => i === 0 || value > afterOlderIndexes[i - 1]),
      };
      // (b1) "show later" returns the tail to the page
      const showLater = page.getByRole('button', { name: /显示较新的消息|Show later messages/ }).first();
      interactions.laterChunkButton = await showLater.count() > 0;
      if (interactions.laterChunkButton) {
        await showLater.click();
        await page.waitForFunction(() => {
          const rows = [...document.querySelectorAll('[data-item-id]')];
          return rows.length > 0 && rows[rows.length - 1]?.getAttribute('data-item-id') === 'it-01199';
        }, null, { timeout: 30000 }).catch(() => {});
      }
      interactions.tailAfterLater = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-item-id]')];
        return rows.length ? rows[rows.length - 1]?.getAttribute('data-item-id') : null;
      });
      const beforeOlderDom = await countDom(page);
      interactions.afterOlderChunkDom = await countDom(page);
      interactions.olderChunkDomDelta = interactions.afterOlderChunkDom - beforeOlderDom;

      // (c) tool expand mounts the body; collapse unmounts it again
      const summary = page.locator('details.nw-tool summary').first();
      await summary.scrollIntoViewIfNeeded();
      const details = page.locator('details.nw-tool').first();
      const preBefore = await details.locator('pre').count();
      await summary.click();
      await page.waitForTimeout(200);
      const preOpen = await details.locator('pre').count();
      await summary.click();
      await page.waitForTimeout(200);
      const preClosed = await details.locator('pre').count();
      interactions.lazyDetails = { preBefore, preOpen, preClosed, unmountsOnClose: preBefore === 0 && preOpen > 0 && preClosed === 0 };

      // (d) reading-position anchor survives a reload (compare the anchor
      // item, not raw scrollTop: the mounted window is smaller after reload)
      const anchorBefore = await page.evaluate(() => {
        const el = document.querySelector('.nw-task-scroll');
        const rows = el.querySelectorAll('[data-item-id]');
        const target = rows[Math.floor(rows.length / 2)];
        el.scrollTop = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 120;
        el.dispatchEvent(new Event('scroll'));
        const bounds = el.getBoundingClientRect();
        const visible = [...el.querySelectorAll('[data-item-id]')].find(node => node.getBoundingClientRect().bottom > bounds.top + 1);
        return { id: visible?.dataset.itemId ?? null };
      });
      await page.waitForTimeout(400);
      await page.reload({ waitUntil: 'commit' });
      await page.waitForFunction(() => document.querySelectorAll('[data-item-id]').length >= 1, null, { timeout: 120000 });
      await page.waitForTimeout(600);
      const anchorAfter = await page.evaluate(() => {
        const el = document.querySelector('.nw-task-scroll');
        const bounds = el.getBoundingClientRect();
        const visible = [...el.querySelectorAll('[data-item-id]')].find(node => node.getBoundingClientRect().bottom > bounds.top + 1);
        return { id: visible?.dataset.itemId ?? null, scrollTop: el.scrollTop };
      });
      const index = (id) => Number((id ?? '').replace('it-', ''));
      const drift = anchorBefore.id && anchorAfter.id ? Math.abs(index(anchorBefore.id) - index(anchorAfter.id)) : null;
      interactions.readingRestore = { anchorBefore: anchorBefore.id, anchorAfter: anchorAfter.id, driftRows: drift, restored: drift !== null && drift <= 5 };

      // (e) locating an unmounted message through ConversationNavigation
      await page.evaluate(() => {
        const el = document.querySelector('.nw-task-scroll');
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      });
      await page.waitForTimeout(300);
      const findButton = page.getByRole('button', { name: /在对话中查找|Find in conversation/ }).first();
      await findButton.click();
      await page.getByLabel(/查找对话内容|Find conversation text/).fill('分析 5');
      await page.waitForFunction(() => Boolean(document.querySelector('[data-find-current="true"]')), null, { timeout: 15000 }).catch(() => {});
      interactions.unmountedLocate = await page.evaluate(() => {
        const item = document.querySelector('[data-find-current="true"]');
        return item ? { id: item.getAttribute('data-item-id'), visible: item.getBoundingClientRect().height >= 0 } : null;
      });
      await page.keyboard.press('Escape');

      // (f) long text selection inside a mounted message
      interactions.longTextSelection = await page.evaluate(() => {
        const row = document.querySelector('.nw-agent-message');
        const paragraph = row?.querySelector('p, li, code');
        if (!paragraph) return false;
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const ok = String(selection).length > 10;
        selection.removeAllRanges();
        return ok;
      });

      // (f1) CODEX-0615-C01/C02: server PREPEND of an older page while
      // reading mid-history. The page first waits for scroll/layout
      // stability across consecutive frames, then captures the first visible
      // message and clicks in the SAME evaluate, so the anchor the component
      // records is measured in a settled layout. Strict assertion: the SAME
      // message id back within 2px of its pre-click viewport offset, DOM
      // order ascending, and the window bounded (not the whole history).
      state.thread = threadSnapshot({ count: 800, offset: 400, hasMore: true });
      await page.reload({ waitUntil: 'commit' });
      await page.waitForFunction(() => document.querySelectorAll('[data-item-id]').length > 0, null, { timeout: 120000 });
      await page.waitForTimeout(400);
      const stableCapture = await page.evaluate(() => new Promise((resolve) => {
        const scroller = document.querySelector('.nw-task-scroll');
        const bounds = scroller.getBoundingClientRect();
        const firstVisible = () => {
          const rows = [...scroller.querySelectorAll('[data-item-id]')];
          return rows.find(node => node.getBoundingClientRect().bottom > bounds.top + 1);
        };
        let lastId = null;
        let lastTop = null;
        let stableFrames = 0;
        let frames = 0;
        const tick = () => {
          frames += 1;
          const row = firstVisible();
          const id = row?.getAttribute('data-item-id') ?? null;
          const top = row ? row.getBoundingClientRect().top - bounds.top : null;
          if (id !== null && id === lastId && Math.abs(top - lastTop) <= 0.5) stableFrames += 1;
          else { stableFrames = 0; lastId = id; lastTop = top; }
          if (stableFrames >= 12) {
            // capture and click in one synchronous block: no layout change in between
            const row2 = firstVisible();
            const capture = {
              id: row2?.getAttribute('data-item-id') ?? null,
              top: row2 ? row2.getBoundingClientRect().top - bounds.top : null,
            };
            const button = [...document.querySelectorAll('button')].find(x => /加载更早的记录|Load earlier history/.test(x.innerText));
            button?.click();
            resolve(capture);
            return;
          }
          if (frames > 240) { resolve({ id: null, top: null }); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }));
      const serverButton = await page.getByRole('button', { name: /加载更早的记录|Load earlier history/ }).count();
      interactions.serverPrependButton = serverButton > 0;
      // wait until the prepended page is merged and the reader's message is
      // stable again at its viewport position
      const anchorTarget = { id: stableCapture.id, top: stableCapture.top };
      await page.waitForFunction(target => {
        const el = document.querySelector('.nw-task-scroll');
        const item = el && el.querySelector(`[data-item-id="${target.id}"]`);
        if (!el || !item) return false;
        const bounds = el.getBoundingClientRect();
        return Math.abs(item.getBoundingClientRect().top - bounds.top - target.top) <= 2;
      }, anchorTarget, { timeout: 60000 }).catch(() => {});
      const prepAnchorBefore_offset = stableCapture.top;
      const prepAnchorAfter = await page.evaluate(id => {
        const el = document.querySelector('.nw-task-scroll');
        const item = el.querySelector(`[data-item-id="${id}"]`);
        const bounds = el.getBoundingClientRect();
        const ids = [...el.querySelectorAll('[data-item-id]')].map(n => Number((n.getAttribute('data-item-id') ?? '').replace('it-', '')));
        let ascending = true;
        for (let i = 1; i < ids.length; i += 1) if (!(ids[i] > ids[i - 1])) ascending = false;
        return {
          mounted: Boolean(item),
          offset: item ? item.getBoundingClientRect().top - bounds.top : null,
          rows: el.querySelectorAll('[data-item-id]').length,
          ascending,
        };
      }, stableCapture.id);
      // the component's own pendingAnchor capture equals the test's stable
      // measurement (same settled layout); final drift must be ≤2px
      interactions.serverPrepend = {
        anchorId: stableCapture.id,
        capturedTop: stableCapture.top,
        offsetBefore: stableCapture.top,
        offsetAfter: prepAnchorAfter.offset,
        pixelDrift: prepAnchorBefore_offset !== null && prepAnchorAfter.offset !== null ? Math.abs(prepAnchorAfter.offset - prepAnchorBefore_offset) : null,
        rowsAfter: prepAnchorAfter.rows,
        ascending: prepAnchorAfter.ascending,
        ok: Boolean(prepAnchorAfter.mounted) && prepAnchorAfter.ascending
          && stableCapture.top !== null && prepAnchorAfter.offset !== null
          && Math.abs(prepAnchorAfter.offset - stableCapture.top) <= 2
          && prepAnchorAfter.rows < 1200,
      };

      // (g) a durable append while a reader sits in a detached older window
      // keeps that window anchored
      const detachedBefore = await page.evaluate(() => {
        const el = document.querySelector('.nw-task-scroll');
        return el.querySelector('[data-item-id]')?.getAttribute('data-item-id') ?? null;
      });
      const beforeAppendOrder = await page.evaluate(() => [...document.querySelectorAll('[data-item-id]')].map(node => node.getAttribute('data-item-id')));
      gateway.appendItem({ id: 'it-01200', threadId: 'perf', turnId: 'turn-3000', kind: 'agentMessage', status: 'completed', seq: 999999, payload: { text: 'append 分析 1200' } });
      await page.waitForTimeout(2000);
      const afterAppendOrder = await page.evaluate(() => [...document.querySelectorAll('[data-item-id]')].map(node => node.getAttribute('data-item-id')));
      interactions.appendAnchor = {
        firstBefore: detachedBefore,
        firstAfter: afterAppendOrder[0],
        anchored: detachedBefore !== null && detachedBefore === afterAppendOrder[0] && beforeAppendOrder.length === afterAppendOrder.length,
      };

      // (h) switching to a shorter thread resets the window without an empty page
      state.thread = threadSnapshot({ count: 100 });
      await page.reload({ waitUntil: 'commit' });
      await page.waitForFunction(() => document.querySelectorAll('[data-item-id]').length > 0, null, { timeout: 120000 });
      await page.waitForTimeout(400);
      const shortOrder = await page.evaluate(() => [...document.querySelectorAll('[data-item-id]')].map(node => node.getAttribute('data-item-id')));
      interactions.shorterThread = {
        rows: shortOrder.length,
        newestPresent: shortOrder[shortOrder.length - 1] === 'it-00099',
        ok: shortOrder.length === 100 && shortOrder[shortOrder.length - 1] === 'it-00099',
      };

      // (i) a sub-agent group spanning a chunk boundary stays visible:
      // locate an item in chunk 1 so the window covers sub-2 (position 300)
      // while sub-1 (position 299, chunk 0) stays unmounted.
      state.thread = threadSnapshot({ count: 1200, subAgentSpan: true });
      await page.reload({ waitUntil: 'commit' });
      await page.waitForFunction(() => document.querySelectorAll('[data-item-id]').length > 0, null, { timeout: 120000 });
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('knorvia:locate-timeline-item', { detail: { id: 'it-00350' } }));
      });
      await page.waitForFunction(() => document.querySelector('[data-item-id="it-00350"]'), null, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(800);
      interactions.subAgentSpan = {
        groupVisible: await page.locator('.nw-subagent').count() > 0,
        spanText: await page.evaluate(() => document.body.innerText.includes('Span agent') || document.body.innerText.includes('协作代理')),
        located: await page.evaluate(() => Boolean(document.querySelector('[data-item-id="it-00350"]'))),
        sub1Row: await page.evaluate(() => Boolean(document.querySelector('[data-item-id="sub-1"]'))),
      };

      report.phases.boundedness = interactions;
      report.browser = await browser.version();
      if (diagnostics.length) report.diagnostics = diagnostics.slice(0, 20);
      report.measuredAt = new Date().toISOString();
      mkdirSync(path.dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
    } finally {
      await browser.close();
    }
  } finally {
    devServer.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 1200));
    if (!devServer.killed) devServer.kill('SIGKILL');
  }
}

main().catch(async error => {
  try {
    const fs = await import('node:fs');
    fs.writeFileSync(OUT, JSON.stringify({ fatal: String(error && error.stack || error).slice(0, 1500), diagnostics, measuredAt: new Date().toISOString() }, null, 2));
    console.error('fatal written to', OUT);
  } catch { /* ignore */ }
  console.error(error);
  process.exit(1);
});
