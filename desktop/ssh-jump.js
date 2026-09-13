'use strict';

// Single-hop bastion support (C13). A saved host may name one other saved
// host as its jump point; the connection is ssh2 direct-tcpip (forwardOut)
// through the bastion, with each side verified against its own fingerprint
// and authenticated with its own credentials. Chained jumps, self-reference
// and cycles are rejected. No ProxyCommand is executed and no agent is
// forwarded; closing the session tears down both hops.
const { createHash } = require('node:crypto');
const { connectionError } = require('./connection-config');

const fail = (code, message) => { throw connectionError(code, message); };
const fingerprint = key => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

function validateJumpTarget(host, jumpHost) {
  if (!jumpHost) fail(-32004, 'The selected jump host no longer exists; pick another one');
  if (jumpHost.id === host.id) fail(-32602, 'A host cannot use itself as its jump host');
  if (jumpHost.jumpHostId) fail(-32602, 'Only a single jump hop is supported; the selected jump host is itself behind a jump host');
}

function authOptions(host, secret, env) {
  const options = {};
  if (host.auth === 'password') options.password = secret;
  else if (host.auth === 'privateKey') {
    if (!host.keyPath) fail(-32602, 'Select a private key file');
    const fs = require('node:fs');
    const stat = fs.lstatSync(host.keyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) fail(-32602, 'Private key must be a regular file under 64 KB');
    options.privateKey = fs.readFileSync(host.keyPath);
    if (secret) options.passphrase = secret;
  } else {
    options.agent = env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
    if (!options.agent) fail(-32086, 'SSH agent is unavailable; choose a private key or password');
  }
  return options;
}

// Connects to the bastion with its own challenge registration and returns an
// opened direct-tcpip stream to the target plus the bastion client (the
// caller owns closing it). `challenges` is the shared per-host challenge map;
// `onError(jumpHost)` lets the session surface bastion fingerprint challenges
// with the right hostId.
async function openJumpStream({ Client, jumpHost, secret, env, readyTimeout = 15000, challenges, targetHostname, targetPort, onError, onClient, signal }) {
  const options = {
    host: jumpHost.hostname,
    port: jumpHost.port,
    username: jumpHost.username,
    readyTimeout,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    hostVerifier(key) {
      const observed = fingerprint(key);
      if (jumpHost.fingerprint === observed) return true;
      challenges.set(jumpHost.id, { fingerprint: observed, previousFingerprint: jumpHost.fingerprint || null, revision: jumpHost.revision, expiresAt: Date.now() + 120000 });
      return false;
    },
    ...authOptions(jumpHost, secret, env),
  };
  const BastionClient = Client || require('ssh2').Client;
  const client = new BastionClient();
  // Register ownership before authentication or forwardOut can suspend. A
  // cancelled session must be able to release this transport at either stage.
  onClient?.(client);
  let started = false, timer, cleanup = () => {};
  const closed = new Promise(resolve => client.once('close', resolve));
  client.on('error', () => onError?.(jumpHost));
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, stream) => {
        if (settled) { stream?.destroy(); return; }
        settled = true;
        cleanup();
        if (error) reject(error); else resolve({ client, stream });
      };
      const onAbort = () => finish(connectionError(-32085, 'SSH connection cancelled'));
      const onClose = () => finish(connectionError(-32085, 'The jump host connection ended'));
      const onConnectError = error => finish(error);
      const onReady = () => {
        if (settled) return;
        try { client.forwardOut('127.0.0.1', 0, targetHostname, targetPort, finish); }
        catch (error) { finish(error); }
      };
      cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        client.removeListener('ready', onReady);
        client.removeListener('error', onConnectError);
        client.removeListener('close', onClose);
      };
      client.once('ready', onReady);
      client.once('error', onConnectError);
      client.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      // ssh2 readyTimeout only covers authentication, not a pending forwardOut.
      timer = setTimeout(() => finish(connectionError(-32085, 'The jump host connection timed out')), readyTimeout);
      timer.unref?.();
      try { started = true; client.connect(options); } catch (error) { started = false; finish(error); }
    });
  } catch (error) {
    client.destroy();
    // Destroy only this chain's socket, then join its close before rejecting.
    // No authenticated client may become unreachable on a failed forwardOut.
    if (started) await closed;
    throw error;
  } finally {
    cleanup();
  }
}

// The bastion died after the session was ready: a distinct, honest status.
function jumpChallengeError(challenges, jumpHost) {
  const challenge = challenges.get(jumpHost.id);
  if (challenge && challenge.revision === jumpHost.revision) {
    return connectionError(-32087, challenge.previousFingerprint ? 'The jump host key changed. Verify its fingerprint before reconnecting' : 'Verify the jump host fingerprint before connecting', { hostId: jumpHost.id, ...challenge });
  }
  return connectionError(-32085, 'The jump host connection failed');
}

module.exports = { validateJumpTarget, openJumpStream, jumpChallengeError, fingerprint };
