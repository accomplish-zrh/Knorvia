"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const os = require("node:os");
const { resolvePowerShell, createCornerCommandSender } = require("../win32-corners");

function fakeChild() {
  const child = new EventEmitter();
  child.writes = [];
  child.stdin = new EventEmitter();
  child.stdin.setDefaultEncoding = () => {};
  child.stdin.write = (data, callback) => { child.writes.push(data); callback?.(); return true; };
  child.stdin.end = () => {};
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; child.emit("exit", 0); };
  return child;
}

test("Windows PowerShell resolves from the system directory without PATH", () => {
  const expected = "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  assert.equal(resolvePowerShell({ env: { SYSTEMROOT: "D:\\Windows", PATH: "" }, arch: "x64", exists: (file) => file === expected }), expected);
  assert.equal(resolvePowerShell({ env: { windir: "D:\\Windows" }, arch: "x64", exists: (file) => file === expected }), expected);
});

test("32-bit processes prefer the native PowerShell directory on 64-bit Windows", () => {
  const expected = "D:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe";
  assert.equal(resolvePowerShell({ env: { SystemRoot: "D:\\Windows" }, arch: "ia32", exists: (file) => file === expected }), expected);
});

test("a missing system shell disables decoration once without PATH fallback", () => {
  const warnings = [];
  let spawns = 0;
  const sender = createCornerCommandSender({ platform: "win32", resolveCommand: () => null, spawnProcess: () => { spawns += 1; }, warn: (message) => warnings.push(message) });
  for (let i = 0; i < 100; i++) assert.equal(sender.send("resize"), false);
  assert.equal(spawns, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ENOENT/);
});

test("a real spawn ENOENT is handled without an uncaught error or resize respawn", async () => {
  let spawns = 0;
  const warnings = [];
  const sender = createCornerCommandSender({
    platform: "win32",
    resolveCommand: () => path.join(os.tmpdir(), `knorvia-missing-shell-${process.pid}-${Date.now()}`, "powershell.exe"),
    spawnProcess: (...args) => { spawns += 1; return spawn(...args); },
    warn: (message) => warnings.push(message),
  });
  try {
    assert.equal(sender.send("resize"), true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(sender.send("resize again"), false);
    assert.equal(spawns, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ENOENT/);
  } finally { sender.dispose(); }
});

test("the helper accepts a split READY marker and coalesces pending window sizes", () => {
  const child = fakeChild();
  const sender = createCornerCommandSender({ platform: "win32", resolveCommand: () => "C:\\Windows\\powershell.exe", spawnProcess: () => child });
  try {
    sender.send("old size", "window-a");
    sender.send("latest size", "window-a");
    sender.send("second window", "window-b");
    assert.equal(child.writes.length, 1);
    child.stdout.write("RE");
    child.stdout.write("ADY\r\n");
    assert.deepEqual(child.writes.slice(1), ["latest size\n", "second window\n"]);
    assert.equal(sender.send("live resize", "window-a"), true);
    assert.equal(child.writes.at(-1), "live resize\n");
  } finally { sender.dispose(); }
});

test("stdin EPIPE and follow-on exit are contained and logged only once", () => {
  const child = fakeChild();
  const warnings = [];
  const sender = createCornerCommandSender({ platform: "win32", resolveCommand: () => "C:\\Windows\\powershell.exe", spawnProcess: () => child, warn: (message) => warnings.push(message) });
  sender.send("resize");
  child.stdout.write("READY\n");
  child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  child.emit("error", new Error("already stopped"));
  assert.equal(sender.send("resize"), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EPIPE/);
  assert.equal(child.killed, true);
});

test("synchronous startup failures and write callbacks cannot escape into Electron", () => {
  const warnings = [];
  const throwing = createCornerCommandSender({ platform: "win32", resolveCommand: () => { throw new Error("inaccessible system directory"); }, warn: (message) => warnings.push(message) });
  assert.equal(throwing.send("resize"), false);
  const child = fakeChild();
  child.stdin.write = (_data, callback) => callback(Object.assign(new Error("closed"), { code: "EPIPE" }));
  const writing = createCornerCommandSender({ platform: "win32", resolveCommand: () => "C:\\Windows\\powershell.exe", spawnProcess: () => child, warn: (message) => warnings.push(message) });
  assert.equal(writing.send("resize"), false);
  assert.equal(warnings.length, 2);
});

test("a helper that never becomes ready is stopped without retrying every resize", async () => {
  const child = fakeChild();
  const warnings = [];
  const sender = createCornerCommandSender({ platform: "win32", resolveCommand: () => "C:\\Windows\\powershell.exe", spawnProcess: () => child, warn: (message) => warnings.push(message), startupTimeoutMs: 10 });
  try {
    sender.send("resize");
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(sender.send("resize"), false);
    assert.equal(child.killed, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /timed out/);
  } finally { sender.dispose(); }
});

test("installed Windows PowerShell starts with an empty PATH", { skip: process.platform !== "win32", timeout: 20000 }, async () => {
  const command = resolvePowerShell();
  assert.ok(command, "this Windows acceptance host must have Windows PowerShell");
  assert.ok(path.win32.isAbsolute(command));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  env.PATH = "";
  const { stdout } = await promisify(execFile)(command, ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Write('KNORVIA_PATHLESS_OK')"], { env, windowsHide: true, timeout: 15000 });
  assert.equal(stdout.trim(), "KNORVIA_PATHLESS_OK");
});

test("the real decoration helper boots and accepts commands with an empty PATH", { skip: process.platform !== "win32", timeout: 20000 }, async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  env.PATH = "";
  let resolveDone;
  let rejectDone;
  let output = "";
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const timeout = setTimeout(() => rejectDone(new Error("helper did not accept its queued command")), 15000);
  const sender = createCornerCommandSender({
    spawnProcess: (command, args, options) => {
      const child = spawn(command, args, { ...options, env });
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("KNORVIA_CORNER_PIPE_OK")) resolveDone();
      });
      return child;
    },
    warn: (message) => rejectDone(new Error(message)),
  });
  try {
    assert.equal(sender.send("Write-Output KNORVIA_CORNER_PIPE_OK"), true);
    await done;
    assert.match(output, /READY/);
  } finally { clearTimeout(timeout); sender.dispose(); }
});
