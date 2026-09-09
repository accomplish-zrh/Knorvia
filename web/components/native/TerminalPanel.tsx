"use client";

import { useEffect, useRef, useState } from 'react';
import { Accessibility, Copy, Eraser, Plus, RefreshCw, Square, TerminalSquare, Trash2 } from 'lucide-react';
import type { ITheme, Terminal } from '@xterm/xterm';
import type { TerminalRead, TerminalSession } from '@/lib/native-terminal';
import { useWorkbench } from './NativeWorkbenchProvider';
import '@xterm/xterm/css/xterm.css';

function terminalTheme(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  const ink = style.getPropertyValue('--nw-ink').trim() || '#242528';
  const dark = element.ownerDocument.documentElement.classList.contains('dark');
  return {
    background: '#00000000', foreground: ink, cursor: ink, selectionBackground: '#7896a855',
    ...(dark ? {
      black: '#1f2126', red: '#ff8b8b', green: '#8ddeae', yellow: '#eace8b', blue: '#91b9fa', magenta: '#d7a4f4', cyan: '#86d9dc', white: '#e7e7e7',
      brightBlack: '#94949e', brightRed: '#ffa0a0', brightGreen: '#a0edbe', brightYellow: '#ffe1a2', brightBlue: '#aac9ff', brightMagenta: '#e0b9ff', brightCyan: '#a0edf0', brightWhite: '#ffffff',
    } : {
      black: '#24292f', red: '#ad2c32', green: '#2a6631', yellow: '#85590f', blue: '#195bb6', magenta: '#7950b6', cyan: '#146c84', white: '#5a6470',
      brightBlack: '#646970', brightRed: '#b62324', brightGreen: '#287747', brightYellow: '#856b00', brightBlue: '#0550ae', brightMagenta: '#8250b6', brightCyan: '#176f87', brightWhite: '#24292f',
    }),
  };
}

export function TerminalPanel({ threadId, sessionId, restore = false, active, onClose, onNew }: {
  threadId: string; sessionId: string; restore?: boolean; active: boolean; onClose: () => void; onNew: () => void;
}) {
  const { request, t, theme } = useWorkbench();
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const input = useRef<(data: string) => void>(() => {});
  const activeRef = useRef(active);
  const openedOnce = useRef(restore);
  const [session, setSession] = useState<TerminalSession>();
  const [failure, setFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [trimmed, setTrimmed] = useState(false);
  const [screenReader, setScreenReader] = useState(false);
  useEffect(() => { if (terminal.current) terminal.current.options.screenReaderMode = screenReader; }, [screenReader, session?.sessionId]);
  useEffect(() => { activeRef.current = active; if (active) { const timer = requestAnimationFrame(() => terminal.current?.focus()); return () => cancelAnimationFrame(timer); } }, [active]);
  useEffect(() => {
    const term = terminal.current;
    if (term && host.current) {
      term.options.theme = terminalTheme(host.current);
    }
  }, [theme, session?.sessionId]);

  useEffect(() => {
    let disposed = false, ready = false, fault = false, cursor = 0, seq = 0, queued = '', writing = false;
    let timer: ReturnType<typeof setTimeout> | undefined, observer: ResizeObserver | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let term: Terminal | undefined;
    const scope = { threadId, sessionId };
    const stopInput = () => { fault = true; ready = false; queued = ''; clearTimeout(timer); if (!disposed) { setFailure(true); if (term) term.options.disableStdin = true; } };
    const flush = async () => {
      if (writing || !ready || disposed) return;
      writing = true;
      try {
        while (queued && ready && !disposed) {
          let length = Math.min(8192, queued.length);
          if (queued.charCodeAt(length - 1) >= 0xD800 && queued.charCodeAt(length - 1) <= 0xDBFF) length--;
          if (!length) break;
          const data = queued.slice(0, length); queued = queued.slice(length);
          await request('terminal/write', { ...scope, data, seq: ++seq });
        }
      } catch { stopInput(); } finally { writing = false; }
    };
    input.current = data => {
      if (!ready || disposed) return;
      if (queued.length + data.length > 65536) { stopInput(); return; }
      queued += data; void flush();
    };
    const init = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (disposed || !host.current) return;
      term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000,
        allowProposedApi: false, allowTransparency: true, disableStdin: true,
        theme: terminalTheme(host.current) });
      terminal.current = term;
      const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current);
      if (host.current.clientWidth && host.current.clientHeight) fit.fit();
      term.textarea?.setAttribute('aria-label', t('终端输入', 'Terminal input'));
      term.attachCustomKeyEventHandler(event => {
        // Global workspace shortcuts remain available; terminal keys (Tab,
        // Escape, Ctrl+C and full-screen app keys) stay inside the emulator.
        if (event.ctrlKey && (event.code === 'Backquote' || (event.altKey && event.key.toLowerCase() === 'b'))) return false;
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'm') {
          if (event.type === 'keydown') host.current?.closest('aside')?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
          event.preventDefault(); return false;
        }
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
          if (event.type === 'keydown' && term?.hasSelection()) void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          event.preventDefault(); return false;
        }
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') return false;
        return true;
      });
      term.onData(data => input.current(data));
      const opened = openedOnce.current || attempt > 0
        ? await request<TerminalSession>('terminal/read', { ...scope, cursor: 0 })
        : await request<TerminalSession>('terminal/open', { ...scope, cols: term.cols, rows: term.rows });
      openedOnce.current = true;
      if (disposed) return;
      seq = opened.inputSeq; setFailure(false);
      if (opened.platform === 'win32') term.options.windowsPty = { backend: 'conpty', buildNumber: opened.windowsBuild };
      const resize = () => {
        if (!host.current?.clientWidth || !host.current?.clientHeight || disposed || !term) return;
        fit.fit();
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (term && !disposed) void request('terminal/resize', { ...scope, cols: term.cols, rows: term.rows }).catch(stopInput); }, 80);
      };
      observer = new ResizeObserver(resize); observer.observe(host.current!); resize();
      const poll = async () => {
        try {
          const value = await request<TerminalRead>('terminal/read', { ...scope, cursor });
          if (disposed || fault || !term) return;
          if (value.truncated) { term.reset(); setTrimmed(true); }
          if (value.data) await new Promise<void>(resolve => term!.write(value.data, resolve));
          if (disposed || fault) return;
          cursor = value.cursor;
          setSession(current => current?.status === value.status && current?.exitCode === value.exitCode ? current : value);
          if (!value.hasMore) { ready = value.status === 'running'; term.options.disableStdin = !ready; }
          if (value.status !== 'exited' || value.hasMore) timer = setTimeout(() => void poll(), value.hasMore ? 0 : activeRef.current ? 80 : 400);
        } catch { stopInput(); }
      };
      await poll();
      if (activeRef.current) term.focus();
    };
    void init().catch(stopInput);
    return () => {
      disposed = true; ready = false; queued = ''; clearTimeout(timer); clearTimeout(resizeTimer); observer?.disconnect();
      term?.dispose(); if (terminal.current === term) terminal.current = null;
      // Navigation / hiding is a detach. Explicit tab close owns termination;
      // terminal/list restores the host session on return or renderer refresh.
    };
  }, [threadId, sessionId, request, attempt, t]);

  return <section className="nw-terminal" aria-label={t('终端会话', 'Terminal session')} data-session-id={sessionId} data-status={failure ? 'disconnected' : session?.status ?? 'connecting'}>
    <header className="nw-terminal-toolbar"><TerminalSquare size={15} /><span title={session?.cwd}>{session?.shell ?? t('终端', 'Terminal')}<small>{session?.cwd ?? t('正在连接…', 'Connecting…')}</small></span>
      <button className="nw-icon" onClick={() => setScreenReader(value => !value)} aria-pressed={screenReader} title={t('屏幕阅读支持', 'Screen reader support')} aria-label={t('屏幕阅读支持', 'Screen reader support')}><Accessibility size={14} /></button>
      <button className="nw-icon" onClick={() => { const value = terminal.current?.getSelection(); if (value) void navigator.clipboard.writeText(value).catch(() => {}); }} title={t('复制选中内容', 'Copy selection')} aria-label={t('复制选中内容', 'Copy selection')}><Copy size={14} /></button>
      <button className="nw-icon" onClick={() => terminal.current?.clear()} title={t('清屏', 'Clear screen')} aria-label={t('清屏', 'Clear screen')}><Eraser size={14} /></button>
      <button className="nw-icon" disabled={failure || session?.status !== 'running'} onClick={() => { input.current('\x03'); terminal.current?.focus(); }} title={t('中断命令 · Ctrl+C', 'Interrupt command · Ctrl+C')} aria-label={t('中断命令', 'Interrupt command')}><Square size={12} /></button>
      <button className="nw-icon" onClick={onNew} title={t('新终端', 'New terminal')} aria-label={t('新终端', 'New terminal')}><Plus size={15} /></button>
      <button className="nw-icon" onClick={onClose} title={t('结束并关闭终端', 'End and close terminal')} aria-label={t('结束并关闭终端', 'End and close terminal')}><Trash2 size={14} /></button>
    </header>
    {failure && <div className="nw-terminal-notice" role="alert">{t('终端连接中断，未确认的输入不会自动重发。', 'Terminal disconnected. Unconfirmed input will not be replayed.')}<button onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13} />{t('重新连接', 'Reconnect')}</button></div>}
    {trimmed && <div className="nw-terminal-notice">{t('较早输出已超出保留范围，正在显示最近记录。', 'Older output exceeded the buffer. Showing recent history.')}</div>}
    <div className="nw-terminal-screen" ref={host} />
    {session?.status === 'exited' && <div className="nw-terminal-notice">{t('进程已退出，退出码', 'Process exited with code')} {session.exitCode}<button onClick={onNew}>{t('打开新终端', 'Open new terminal')}</button></div>}
    <footer>{t('收起后仍会运行 · Ctrl+Shift+M 移出终端', 'Keeps running when hidden · Ctrl+Shift+M leaves terminal focus')}</footer>
  </section>;
}
