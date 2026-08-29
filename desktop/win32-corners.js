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

let helper;
let helperReady = false;
const pending = [];

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

function send(line) {
  if (process.platform !== "win32") return;
  if (!helper || helper.killed || helper.exitCode != null) {
    helperReady = false;
    helper = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", "-"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    helper.stdin.setDefaultEncoding("utf8");
    helper.stdout.on("data", (chunk) => {
      if (String(chunk).includes("READY")) {
        helperReady = true;
        const queue = pending.splice(0, pending.length);
        for (const item of queue) helper.stdin.write(item);
      }
    });
    helper.on("exit", () => {
      helperReady = false;
      helper = null;
    });
    helper.stdin.write(BOOTSTRAP);
  }
  const payload = `${line}\n`;
  if (helperReady) helper.stdin.write(payload);
  else pending.push(payload);
}

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
    send(`[KnorviaRgn]::Clear(${hwnd}L)`);
    return true;
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
  send(`[KnorviaRgn]::Round(${hwnd}L, ${width}, ${height}, ${diameter})`);
  return true;
}

module.exports = { applyWindowCornerRegion };
