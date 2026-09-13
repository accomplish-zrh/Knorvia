'use strict';

// Controlled local SSH port forwarding (RF-D01). On an explicitly opened,
// trusted session the user may expose a fixed remote host:port on a local
// loopback listener. First version constraints, enforced by this API's shape:
// only 127.0.0.1 is ever bound (no bind host is accepted), channels are
// bounded, and each forward owns exactly its listener and streams. Closing
// the forward, the session or the app releases them; nothing auto-restarts
// and no SOCKS or public binding exists.
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { connectionError } = require('./connection-config');

const fail = (code, message) => { throw connectionError(code, message); };

const MAX_FORWARDS_PER_SESSION = 8;
const MAX_CONCURRENT_CHANNELS = 16;
const HOST_PATTERN = /^[a-zA-Z0-9.:%_-]{1,253}$/;
const TERMINAL = ['closed', 'failed', 'detached'];

function createSshForwards({ maxForwardsPerSession = MAX_FORWARDS_PER_SESSION, maxConcurrentChannels = MAX_CONCURRENT_CHANNELS } = {}) {
  const forwards = new Map();   // forwardId -> record
  const bySession = new Map();  // sessionId -> Set(forwardId)
  const channelCounts = new Map(); // sessionId -> active channel count

  const track = record => {
    forwards.set(record.forwardId, record);
    if (!bySession.has(record.sessionId)) bySession.set(record.sessionId, new Set());
    bySession.get(record.sessionId).add(record.forwardId);
  };
  const untrack = record => {
    forwards.delete(record.forwardId);
    bySession.get(record.sessionId)?.delete(record.forwardId);
    if (!bySession.get(record.sessionId)?.size) bySession.delete(record.sessionId);
  };
  const publicRecord = record => ({
    forwardId: record.forwardId, sessionId: record.sessionId, hostId: record.hostId,
    remoteHost: record.remoteHost, remotePort: record.remotePort,
    localPort: record.localPort, status: record.status,
    connectionsServed: record.connectionsServed, connectionsActive: record.sockets.size,
    error: record.error, startedAt: record.startedAt, closedAt: record.closedAt || undefined,
  });
  function finalize(record, status, error) {
    if (record.status !== 'active' && TERMINAL.includes(record.status)) return;
    record.status = status;
    record.error = error || '';
    record.closedAt = Date.now();
  }
  function teardown(record) {
    if (record.server) {
      const server = record.server;
      record.server = undefined;
      try { server.close(); } catch { /* already closed */ }
      server.closeAllConnections?.();
    }
    for (const socket of [...record.sockets]) socket.destroy();
    record.sockets.clear();
  }

  async function start({ sessionId, hostId, client, remoteHost, remotePort, localPort }) {
    if (typeof remoteHost !== 'string' || !HOST_PATTERN.test(remoteHost)) fail(-32602, 'Remote forward host looks invalid');
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) fail(-32602, 'Remote forward port must be 1-65535');
    if (localPort !== undefined && localPort !== null && (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535)) fail(-32602, 'Local forward port must be 0 (automatic) or 1-65535');
    if (localPort === 0) localPort = undefined; // ephemeral
    const activeForSession = [...(bySession.get(sessionId) ?? [])].filter(id => forwards.get(id)?.status === 'active').length;
    if (activeForSession >= maxForwardsPerSession) fail(-32082, `At most ${maxForwardsPerSession} forwards per SSH session; close one first`);
    const record = {
      forwardId: randomUUID(), sessionId, hostId, remoteHost, remotePort,
      localPort: localPort ?? 0, status: 'starting', connectionsServed: 0,
      error: '', startedAt: Date.now(), closedAt: 0,
      sockets: new Set(), server: undefined, closing: false,
    };
    track(record);
    const server = net.createServer(socket => {
      if (record.closing || record.status !== 'active') { socket.destroy(); return; }
      const count = channelCounts.get(sessionId) ?? 0;
      if (count >= maxConcurrentChannels) {
        socket.destroy();
        record.error = `Concurrent channel limit (${maxConcurrentChannels}) reached; a stream was refused`;
        return;
      }
      channelCounts.set(sessionId, count + 1);
      record.sockets.add(socket);
      socket.on('error', () => socket.destroy());
      const cleanup = () => {
        record.sockets.delete(socket);
        channelCounts.set(sessionId, Math.max(0, (channelCounts.get(sessionId) ?? 1) - 1));
      };
      socket.once('close', cleanup);
      client.forwardOut('127.0.0.1', socket.localPort || 0, remoteHost, remotePort, (error, channel) => {
        if (error || !channel) {
          cleanup();
          record.error = 'The remote side refused a forwarded connection';
          socket.destroy();
          return;
        }
        if (record.closing || !record.sockets.has(socket)) { channel.close(); socket.destroy(); return; }
        record.connectionsServed += 1;
        channel.on('error', () => socket.destroy());
        channel.on('close', () => socket.destroy());
        socket.pipe(channel);
        channel.pipe(socket);
      });
    });
    record.server = server;
    // The caller gets the real local port only once the listener is up, or a
    // clear failure (port occupied, listener error) instead of a half-open
    // forward. Other forwards and listeners are never touched.
    await new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening);
        const inUse = error?.code === 'EADDRINUSE';
        record.error = inUse ? `Local port ${record.localPort} is already in use` : 'The local listener failed';
        teardown(record);
        finalize(record, 'failed', record.error);
        reject(connectionError(-32053, record.error));
      };
      const onListening = () => {
        server.off('error', onError);
        record.localPort = server.address().port;
        record.status = 'active';
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(localPort ?? 0, '127.0.0.1');
    });
    return publicRecord(record);
  }

  function list(sessionId) {
    return [...(bySession.get(sessionId) ?? [])].map(id => forwards.get(id)).filter(Boolean).map(publicRecord);
  }

  function get(sessionId, forwardId) {
    const record = forwards.get(forwardId);
    if (!record || record.sessionId !== sessionId) fail(-32004, 'Forward not found');
    return record;
  }

  function close(sessionId, forwardId) {
    const record = get(sessionId, forwardId);
    if (TERMINAL.includes(record.status)) return { forward: publicRecord(record), closed: false };
    record.closing = true;
    teardown(record);
    finalize(record, 'closed', '');
    untrackLater(record);
    return { forward: publicRecord(record), closed: true };
  }
  // Closed forwards stay listed briefly so the UI can show the outcome, then
  // the record is dropped on the next list()/sweep.
  const tombstones = new Map();
  function untrackLater(record) { tombstones.set(record.forwardId, Date.now()); }
  function sweep(now = Date.now()) {
    for (const [id, at] of tombstones) {
      if (now - at > 60000) { const record = forwards.get(id); if (record && TERMINAL.includes(record.status)) untrack(record); tombstones.delete(id); }
      else { const record = forwards.get(id); if (!record) tombstones.delete(id); }
    }
  }

  // The SSH transport died: every forward of the session is torn down and
  // honestly marked detached. Listeners are released immediately.
  function detachSession(sessionId, message = 'The SSH connection ended; forwards were released') {
    for (const id of [...(bySession.get(sessionId) ?? [])]) {
      const record = forwards.get(id);
      if (!record || TERMINAL.includes(record.status)) continue;
      record.closing = true;
      teardown(record);
      finalize(record, 'detached', message);
      untrackLater(record);
    }
    channelCounts.delete(sessionId);
  }

  function dispose(message = 'The SSH service is shutting down; forwards were released') {
    for (const sessionId of [...bySession.keys()]) detachSession(sessionId, message);
  }

  return { start, list, get, close, detachSession, dispose };
}

module.exports = { createSshForwards, MAX_FORWARDS_PER_SESSION, MAX_CONCURRENT_CHANNELS };
