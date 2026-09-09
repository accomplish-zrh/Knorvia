'use strict';

// Exclusive local ownership. A slow but live process is never stolen from
// merely because a timer was delayed. O_EXCL decides ownership, not a
// read-then-write heartbeat. Short mutation locks also serialize checkpoints
// across two desktop hosts sharing one personal home.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const alive = pid => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
function tryLock(file, { staleMs = 25000 } = {}, depth = 0) {
  // Each recovery guard has the same owned format, so a process dying during
  // recovery cannot leave an unowned sentinel that blocks the job forever.
  if (depth > 8) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID();
  const value = JSON.stringify({ pid: process.pid, token, at: Date.now() });
  const write = () => { const fd = fs.openSync(file, 'wx'); try { fs.writeFileSync(fd, value); } finally { fs.closeSync(fd); } };
  try { write(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize reclaimers so a second contender cannot delete the fresh
    // lock another contender just acquired after a dead owner was removed.
    let observed;
    try { observed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
    if (alive(observed?.pid)) return null;
    const guard = tryLock(`${file}.reclaim`, { staleMs }, depth + 1);
    if (!guard) return null;
    try {
      let current;
      try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { age = staleMs + 1; }
      if (alive(current?.pid) || (!current?.pid && age < staleMs)) return null;
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      try { write(); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
    } finally { guard.release(); }
  }
  return {
    owns() { try { return JSON.parse(fs.readFileSync(file, 'utf8')).token === token; } catch { return false; } },
    release() { if (this.owns()) { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } } },
  };
}
async function withLock(file, action, { timeoutMs = 15000, signal, staleMs } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const lock = tryLock(file, { staleMs });
    if (lock) { try { return await action(); } finally { lock.release(); } }
    if (Date.now() >= until) { const e = new Error('另一个窗口正在更新，请稍后重试'); e.rpc = { code: -32005, message: e.message }; throw e; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
module.exports = { tryLock, withLock };
