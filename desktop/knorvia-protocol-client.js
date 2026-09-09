'use strict';

const { spawn } = require('child_process');
const path = require('path');
const {
  encodeFrame,
  tryDecode,
  initializeRequest,
} = require('./protocol-framing');

/**
 * Spawn knorvia-daemon as a private sidecar. Never execs a user `codex`.
 */
function startKnorviaDaemon({ daemonBin, home, env = process.env, requestTimeoutMs = 660000 }) {
  if (!daemonBin) {
    throw new Error('knorvia-daemon binary path required');
  }
  const childEnv = { ...env, KNORVIA_HOME: home };
  delete childEnv.CODEX_HOME;
  const child = spawn(daemonBin, ['--home', home], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: home,
  });
  return attachProtocol(child, { requestTimeoutMs });
}

// Responses correlate by ID; unsolicited events must never consume a waiter.
function attachProtocol(child, { requestTimeoutMs = 660000 } = {}) {
  let buf = Buffer.alloc(0);
  let closedError = null;
  const pending = new Map();
  const listeners = new Set();
  function fail(error) {
    if (closedError) return;
    closedError = error;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }
  child.on('error', fail);
  child.on('close', (code, signal) => fail(new Error(`knorvia-daemon closed (${signal || code})`)));
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  // Drain diagnostics to prevent pipe backpressure. Do not expose raw stderr
  // to the renderer, where it could contain provider details.
  child.stderr?.resume();
  child.stdout.on('data', (chunk) => {
    if (closedError) return;
    try {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const decoded = tryDecode(buf);
        if (!decoded) break;
        buf = decoded.rest;
        const message = decoded.message;
        if (Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'method')) {
          const waiter = pending.get(message.id);
          if (!waiter) continue;
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        } else {
          for (const listener of listeners) listener(message);
        }
      }
    } catch (error) {
      fail(error);
      child.kill();
    }
  });
  function request(obj, { timeoutMs = requestTimeoutMs } = {}) {
    if (closedError) return Promise.reject(closedError);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('request timeout must be positive'));
    if (!['string', 'number'].includes(typeof obj.id)) return Promise.reject(new Error('request ID required'));
    if (pending.has(obj.id)) return Promise.reject(new Error(`duplicate request ID: ${obj.id}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(obj.id);
        reject(new Error(`knorvia-daemon request timed out: ${obj.method}`));
      }, timeoutMs);
      pending.set(obj.id, { resolve, reject, timer });
      try {
        child.stdin.write(encodeFrame(JSON.stringify(obj)), (error) => { if (error) fail(error); });
      } catch (error) { fail(error); }
    });
  }
  function notify(obj) {
    if (closedError) throw closedError;
    child.stdin.write(encodeFrame(JSON.stringify(obj)));
  }
  function onNotification(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  return { child, request, notify, onNotification, initializeRequest };
}

function engineCommand({ daemonBin, home }) {
  if (!daemonBin) throw new Error('knorvia-daemon path required');
  return {
    bin: daemonBin,
    args: ['--home', home],
    env: { KNORVIA_HOME: home },
    identity: 'knorvia-daemon',
  };
}

module.exports = {
  startKnorviaDaemon,
  attachProtocol,
  encodeFrame,
  tryDecode,
  initializeRequest,
  engineCommand,
  path,
};
