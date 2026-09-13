"use strict";

/**
 * Custom restored-window radius on Windows.
 *
 * DWM only offers ~8px. A layered HWND can fake a larger CSS radius but
 * then maximize/restore breaks. Clip the HWND with SetWindowRgn instead.
 * Calls go through a long-lived PowerShell helper so we do not ship a
 * native addon.
 */

const { spawn } = require("child_process");
const fs = require("node:fs");
const path = require("node:path");

const BOOTSTRAP = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class KnorviaRgn {
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
  public static void Round(long hwnd, int w, int h, int dia) {
    SetWindowRgn((IntPtr)hwnd, CreateRoundRectRgn(0, 0, w, h, dia, dia), true);
  }
  public static void Clear(long hwnd) {
    SetWindowRgn((IntPtr)hwnd, IntPtr.Zero, true);
  }
}
"@

Write-Output READY
`;

function resolvePowerShell({ env = process.env, arch = process.arch, exists = fs.existsSync } = {}) {
  const envValue = (name) => env[Object.keys(env).find((key) => key.toLowerCase() === name)];
  const roots = [envValue("systemroot"), envValue("windir"), "C:\\Windows"];
  for (const root of new Set(roots)) {
    if (typeof root !== "string" || !path.win32.isAbsolute(root)) continue;
    // A 32-bit helper on 64-bit Windows needs the unredirected system directory.
    for (const system of arch === "ia32" ? ["Sysnative", "System32"] : ["System32"]) {
      const command = path.win32.join(root, system, "WindowsPowerShell", "v1.0", "powershell.exe");
      if (exists(command)) return command;
    }
  }
  return null;
}

function createCornerCommandSender({
  spawnProcess = spawn,
  platform = process.platform,
  resolveCommand = resolvePowerShell,
  warn = (message) => console.warn(message),
  startupTimeoutMs = 15000,
} = {}) {
  let helper = null;
  let ready = false;
  let disabled = false;
  let timer;
  let output = "";
  const pending = new Map();

  function stop(error) {
    if (disabled) return;
    disabled = true;
    ready = false;
    clearTimeout(timer);
    pending.clear();
    const child = helper;
    helper = null;
    // This is optional window decoration. A missing shell or broken pipe must
    // never become an unhandled main-process error or a spawn loop on resize.
    try { child?.stdin?.end(); } catch { /* already closed */ }
    try { child?.kill(); } catch { /* already exited */ }
    if (error) warn(`[Knorvia] Custom window corners unavailable (${error.code || error.message}); using system corners.`);
  }

  function write(payload) {
    if (disabled || !helper) return false;
    try {
      helper.stdin.write(payload, (error) => { if (error) stop(error); });
      return !disabled;
    } catch (error) {
      stop(error);
      return false;
    }
  }

  function flush() {
    const queue = [...pending.values()];
    pending.clear();
    for (const payload of queue) if (!write(payload)) break;
  }

  function send(line, windowKey = "main") {
    if (platform !== "win32" || disabled) return false;
    pending.set(windowKey, `${line}\n`);
    if (!helper) {
      try {
        const command = resolveCommand();
        if (!command) throw Object.assign(new Error("Windows PowerShell is unavailable"), { code: "ENOENT" });
        helper = spawnProcess(command, ["-NoProfile", "-NonInteractive", "-STA", "-Command", "-"], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        helper.on("error", stop);
        helper.on("exit", (code) => stop(new Error(`helper exited: ${code}`)));
        helper.stdin.on("error", stop);
        helper.stdout.on("error", stop);
        helper.stderr.on("error", stop);
        helper.stderr.on("data", () => {});
        helper.stdout.on("data", (chunk) => {
          if (disabled || ready) return;
          output = (output + String(chunk)).slice(-4096);
          if (/(?:^|\r?\n)READY\r?\n/.test(output)) {
            ready = true;
            clearTimeout(timer);
            flush();
          }
        });
        helper.stdin.setDefaultEncoding("utf8");
        timer = setTimeout(() => stop(new Error("helper startup timed out")), startupTimeoutMs);
        timer.unref?.();
        write(BOOTSTRAP);
      } catch (error) {
        stop(error);
      }
    }
    if (ready) flush();
    return !disabled;
  }

  return { send, dispose: () => stop() };
}

const cornerCommands = createCornerCommandSender();

function hwndOf(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  } catch {
    return null;
  }
}

function applyWindowCornerRegion(win, radiusDip, { square = false } = {}) {
  if (process.platform !== "win32" || !win || win.isDestroyed?.()) return false;
  const hwnd = hwndOf(win);
  if (hwnd == null) return false;
  const forceSquare = Boolean(
    square || win.isMaximized?.() || win.isFullScreen?.(),
  );
  if (forceSquare) {
    return cornerCommands.send(`[KnorviaRgn]::Clear(${hwnd}L)`, String(hwnd));
  }
  const [dipW, dipH] = win.getSize();
  let factor = 1;
  try {
    const { screen } = require("electron");
    factor = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
  } catch {
    factor = 1;
  }
  const width = Math.max(1, Math.round(dipW * factor));
  const height = Math.max(1, Math.round(dipH * factor));
  const diameter = Math.max(2, Math.round(radiusDip * 2 * factor));
  return cornerCommands.send(`[KnorviaRgn]::Round(${hwnd}L, ${width}, ${height}, ${diameter})`, String(hwnd));
}

module.exports = { applyWindowCornerRegion, resolvePowerShell, createCornerCommandSender };
