'use strict';

const {
  TurnStreamState,
  errorText,
  isTerminalStatus,
  kernelItemId,
  nonEmptyId,
  normalizedTurn,
  rendererStatus,
} = require('./kernel-turn-stream');

// Temporary renderer compatibility boundary. Thread/Turn truth belongs to the
// daemon; this adapter must not manufacture completion, cancellation, or an
// approval decision. The daemon's durable Item is authoritative over live
// deltas, and a terminal notification is only a prompt to reconcile turn/read.
function createChatBridge({ rpc, workspaceId }) {
  const sockets = new Map();
  // threadId -> { turnId: string | null, uncertain: boolean }. An uncertain
  // entry prevents a duplicate start after a transport failure whose remote
  // acceptance cannot be known.
  const activeThreads = new Map();
  // turnId -> Set<socket state>. A reconnect may subscribe to an existing
  // turn, so this deliberately is not one socket per turn.
  const turnSubscribers = new Map();
  // A notification can race the turn/start response. Once thread/start has
  // returned, the thread id is enough to bind that event safely: overlapping
  // starts for a thread are rejected before this point.
  const startingThreads = new Map();
  // A recovery read has the inverse race: the daemon may publish a terminal
  // event after the caller asks for a snapshot but before that snapshot is
  // returned. These short-lived registrations retain only terminal/persistence
  // signals long enough to bind the snapshot and re-read it. They are not a
  // persisted cursor and intentionally do not claim cross-daemon replay.
  const recoveringTurns = new Map();
  let disposed = false;

  function isLive(sock) {
    return !disposed
      && !sock?.closed
      && !sock?.suppressOutput
      && sockets.get(sock.id) === sock
      && typeof sock.send === 'function';
  }

  function isAttached(sock) {
    return !disposed && !sock?.closed && sockets.get(sock.id) === sock;
  }

  function emit(sock, partial) {
    if (!isLive(sock)) return false;
    sock.send({
      type: 'message',
      id: sock.id,
      data: JSON.stringify({
        source: 'knorvia-daemon',
        stage: '',
        content: '',
        metadata: {},
        session_id: sock.threadId,
        turn_id: sock.turnId,
        timestamp: Date.now() / 1000,
        ...partial,
      }),
    });
    return true;
  }

  function ensureTurnState(sock, turnId) {
    if (!sock.turnState || sock.turnState.turnId !== turnId) {
      sock.turnState = new TurnStreamState(turnId);
    }
    return sock.turnState;
  }

  function emitStreamAction(sock, action) {
    if (!action) return false;
    if (action.type === 'userMessage' || !action.emit) return true;
    emit(sock, {
      type: action.type,
      content: action.content,
      seq: action.seq,
      metadata: action.metadata,
    });
    return true;
  }

  function emitItem(sock, item, options = {}) {
    if (!sock.turnId) return false;
    const action = ensureTurnState(sock, sock.turnId).acceptItem(item, {
      threadId: sock.threadId,
      ...options,
    });
    return emitStreamAction(sock, action);
  }

  function emitDelta(sock, payload) {
    if (!sock.turnId) return;
    emitStreamAction(sock, ensureTurnState(sock, sock.turnId).acceptDelta(payload));
  }

  function reserveThread(threadId, turnId, uncertain = false) {
    activeThreads.set(threadId, { turnId: turnId || null, uncertain });
  }

  function releaseThread(threadId, turnId) {
    const active = activeThreads.get(threadId);
    if (active && (!turnId || !active.turnId || active.turnId === turnId)) activeThreads.delete(threadId);
  }

  function threadIsBusy(threadId, permittedTurnId) {
    const active = activeThreads.get(threadId);
    return Boolean(active && active.turnId !== permittedTurnId);
  }

  function addStartingSocket(sock, threadId) {
    let set = startingThreads.get(threadId);
    if (!set) {
      set = new Set();
      startingThreads.set(threadId, set);
    }
    set.add(sock);
  }

  function removeStartingSocket(sock, threadId) {
    const set = startingThreads.get(threadId);
    if (!set) return;
    set.delete(sock);
    if (!set.size) startingThreads.delete(threadId);
  }

  function addRecoveringSocket(sock, turnId) {
    const recovery = {
      sock,
      turnId,
      expectedThreadId: sock.threadId || null,
      terminalHints: new Map(),
      persistenceErrors: new Map(),
      active: true,
    };
    let set = recoveringTurns.get(turnId);
    if (!set) {
      set = new Set();
      recoveringTurns.set(turnId, set);
    }
    set.add(recovery);
    sock.recovery = recovery;
    return recovery;
  }

  function removeRecoveringSocket(recovery) {
    if (!recovery) return;
    recovery.active = false;
    const set = recoveringTurns.get(recovery.turnId);
    if (set) {
      set.delete(recovery);
      if (!set.size) recoveringTurns.delete(recovery.turnId);
    }
    if (recovery.sock?.recovery === recovery) recovery.sock.recovery = null;
  }

  function recordRecoveryNotification(recovery, event, isPersistenceError) {
    if (!recovery.active) return;
    if (recovery.expectedThreadId && recovery.expectedThreadId !== event.threadId) return;
    if (isPersistenceError) {
      recovery.persistenceErrors.set(event.threadId, event);
    } else if (isTerminalStatus(event.status)) {
      recovery.terminalHints.set(event.threadId, event);
    }
  }

  function recoverySignals(recovery, threadId) {
    return {
      terminalHint: recovery.terminalHints.get(threadId),
      persistenceError: recovery.persistenceErrors.get(threadId),
    };
  }

  function detachSocketFromTurn(sock) {
    const turnId = sock.turnId;
    if (!turnId) return;
    const set = turnSubscribers.get(turnId);
    if (set) {
      set.delete(sock);
      if (!set.size) turnSubscribers.delete(turnId);
    }
  }

  function bindSocketToTurn(sock, threadId, turnId, { resetLocalFailure = false } = {}) {
    if (!threadId || !turnId) return false;
    if (sock.threadId && sock.threadId !== threadId) return false;
    if (sock.turnId && sock.turnId !== turnId) return false;
    sock.threadId = threadId;
    sock.turnId = turnId;
    sock.suppressOutput = false;
    if (resetLocalFailure && sock.turnState?.turnId === turnId && sock.turnState.localEnded) {
      sock.turnState = new TurnStreamState(turnId);
    } else {
      ensureTurnState(sock, turnId);
    }
    let set = turnSubscribers.get(turnId);
    if (!set) {
      set = new Set();
      turnSubscribers.set(turnId, set);
    }
    set.add(sock);
    reserveThread(threadId, turnId, false);
    return true;
  }

  function emitMissingTerminalError(sock, turn, terminalHint) {
    const state = ensureTurnState(sock, sock.turnId);
    if (state.sawError) return;
    const error = turn.error ?? terminalHint?.error;
    if (error) {
      state.sawError = true;
      emit(sock, {
        type: 'error',
        content: errorText(error, 'Kernel turn failed'),
        metadata: { kind: 'error', payload: error },
      });
    } else if (turn.status === 'failed') {
      state.sawError = true;
      emit(sock, { type: 'error', content: 'Kernel turn failed', metadata: { kind: 'error' } });
    }
  }

  function finishAuthoritative(sock, turn, terminalHint) {
    if (!sock.turnId || turn.id !== sock.turnId || turn.threadId !== sock.threadId) return;
    if (!isTerminalStatus(turn.status)) {
      emit(sock, {
        type: 'progress',
        metadata: {
          status: turn.status || 'unknown',
          remoteStatus: terminalHint?.status,
          terminalConfirmed: false,
        },
      });
      return;
    }
    const state = ensureTurnState(sock, sock.turnId);
    // A local connection/persistence failure already ended this renderer's
    // wait. A late terminal snapshot may release our daemon-local guard but
    // must not send a second, contradictory terminal event to that socket.
    if (!state.localEnded) {
      for (const item of turn.items || []) emitItem(sock, item);
      emitMissingTerminalError(sock, turn, terminalHint);
      emit(sock, {
        type: 'done',
        turn_id: turn.id,
        metadata: {
          status: rendererStatus(turn.status),
          remoteStatus: turn.status,
          terminalConfirmed: true,
          runtime: 'knorvia-daemon',
        },
      });
    }
    const threadId = sock.threadId;
    const turnId = sock.turnId;
    detachSocketFromTurn(sock);
    releaseThread(threadId, turnId);
    sock.busy = false;
    sock.remoteUncertain = false;
    sock.turnId = undefined;
    sock.turnState = null;
  }

  function emitLocalRecoveryFailure(sock, error, details = {}) {
    const state = sock.turnId ? ensureTurnState(sock, sock.turnId) : null;
    if (state?.localEnded) return;
    if (state) state.localEnded = true;
    const status = details.status || 'connection_error';
    const remoteStatus = details.remoteStatus || 'unknown';
    const metadata = {
      status,
      remoteStatus,
      terminalConfirmed: false,
      localOnly: true,
      recoveryRequired: true,
      phase: details.phase || 'transport',
    };
    emit(sock, { type: 'error', content: errorText(error, 'Lost connection to knorvia-daemon'), metadata });
    // This ends the renderer's spinner only. A local recovery failure is
    // expressly not a statement about the remote turn's terminal state.
    emit(sock, { type: 'done', metadata });
    // Do not retain a renderer subscription after it has been told to
    // recover. Later terminal notifications still clean the global guard,
    // while this socket can explicitly resume_from a durable snapshot.
    detachSocketFromTurn(sock);
    sock.busy = true;
    sock.remoteUncertain = true;
    if (sock.threadId) reserveThread(sock.threadId, sock.turnId, true);
  }

  function emitConnectionError(sock, error, details = {}) {
    emitLocalRecoveryFailure(sock, error, { ...details, status: 'connection_error' });
  }

  function emitPersistenceError(sock, error) {
    emitLocalRecoveryFailure(sock, error, {
      status: 'persistence_error',
      phase: 'turn/persistenceError',
      remoteStatus: 'unknown',
    });
  }

  async function reconcileTerminal(sock, terminalHint) {
    const turnId = sock.turnId;
    const threadId = sock.threadId;
    if (!turnId || !threadId) return;
    const state = ensureTurnState(sock, turnId);
    if (state.reconciling) return state.reconciling;
    let pending;
    pending = (async () => {
      try {
        const result = await rpc('turn/read', { id: turnId });
        const turn = normalizedTurn(result, threadId);
        if (!turn || turn.id !== turnId || turn.threadId !== threadId) {
          throw new Error('Daemon returned a mismatched terminal turn snapshot');
        }
        finishAuthoritative(sock, turn, terminalHint);
      } catch (error) {
        emitConnectionError(sock, error, {
          phase: 'turn/read',
          remoteStatus: terminalHint?.status || 'unknown',
        });
      } finally {
        if (state.reconciling === pending) state.reconciling = null;
      }
    })();
    state.reconciling = pending;
    return pending;
  }

  function deliverTurnEvent(sock, event) {
    if (sock.threadId !== event.threadId || sock.turnId !== event.turnId) return;
    if (event.item) {
      emitItem(sock, event.item, { kind: event.kind, payload: event.payload });
    } else if (event.kind === 'agentMessage.delta') {
      emitDelta(sock, event.payload || {});
    } else if (event.kind) {
      const upstream = kernelItemId(null, event.payload);
      const legacyKey = nonEmptyId(event.itemId)
        ? `event:${event.itemId}`
        : upstream ? `kernel:${event.kind}:${upstream}`
          : Number.isFinite(Number(event.seq)) ? `seq:${event.seq}` : null;
      emitItem(sock, null, {
        kind: event.kind,
        payload: event.payload,
        legacyKey,
      });
    }
    if (isTerminalStatus(event.status)) return reconcileTerminal(sock, event);
  }

  // Called by the single daemon notification listener installed in
  // kernel-engine. It intentionally filters before touching renderer state:
  // items from another Thread or Turn can never enter this compatibility UI.
  function handleNotification(notification) {
    if (disposed) return Promise.resolve();
    const isTurnEvent = notification?.method === 'turn/event';
    const isPersistenceError = notification?.method === 'turn/persistenceError';
    if (!isTurnEvent && !isPersistenceError) return Promise.resolve();
    const params = notification.params;
    const threadId = nonEmptyId(params?.threadId ?? params?.thread_id);
    const turnId = nonEmptyId(params?.turnId ?? params?.turn_id);
    if (!threadId || !turnId) return Promise.resolve();
    const event = { ...params, threadId, turnId };

    // Record terminal/persistence notifications for recovery reads before
    // looking up live subscribers. A different socket may already be live;
    // that must not make this recovering socket miss its own recheck signal.
    const recoveries = recoveringTurns.get(turnId);
    if (recoveries?.size) {
      for (const recovery of [...recoveries]) {
        recordRecoveryNotification(recovery, event, isPersistenceError);
      }
    }

    let subscribers = turnSubscribers.get(turnId);
    if (!subscribers?.size) {
      const starters = startingThreads.get(threadId);
      if (starters?.size) {
        for (const sock of [...starters]) bindSocketToTurn(sock, threadId, turnId);
        subscribers = turnSubscribers.get(turnId);
      }
    }
    if (!subscribers?.size) {
      // No renderer is attached. A terminal event can still release the
      // daemon-local duplicate-start guard; no renderer `done` is emitted
      // without a turn/read snapshot.
      if (isTurnEvent && isTerminalStatus(event.status)) releaseThread(threadId, turnId);
      return Promise.resolve();
    }
    if (isPersistenceError) {
      for (const sock of [...subscribers]) {
        if (sock.threadId === threadId && sock.turnId === turnId) {
          emitPersistenceError(sock, new Error(errorText(params?.message, 'Unable to persist Kernel turn state')));
        }
      }
      return Promise.resolve();
    }
    const reconciliations = [];
    for (const sock of [...subscribers]) {
      const pending = deliverTurnEvent(sock, event);
      if (pending) reconciliations.push(pending);
    }
    return Promise.all(reconciliations).then(() => undefined);
  }

  async function startTurn(sock, msg) {
    if (sock.busy || sock.recovery) {
      emit(sock, { type: 'error', content: 'A turn is already active on this connection' });
      return;
    }
    const explicitSession = Object.hasOwn(msg, 'session_id') ? msg.session_id : undefined;
    const existingId = explicitSession !== undefined
      ? explicitSession
      : msg.thread_id || sock.threadId;
    if (existingId != null && !nonEmptyId(existingId)) {
      emit(sock, { type: 'error', content: 'Invalid thread identity' });
      return;
    }
    if (existingId && threadIsBusy(String(existingId))) {
      emit(sock, { type: 'error', content: 'A turn is already active or uncertain in this thread' });
      return;
    }

    sock.busy = true;
    sock.remoteUncertain = false;
    sock.suppressOutput = false;
    sock.turnId = undefined;
    sock.turnState = null;
    let threadId = existingId ? String(existingId) : null;
    let turnRequestSent = false;
    try {
      const thread = existingId
        ? await rpc('thread/resume', { id: String(existingId) })
        : await rpc('thread/start', {
          workspaceId,
          title: String(msg.content || 'turn').slice(0, 80),
        });
      threadId = nonEmptyId(thread?.id);
      if (!threadId) throw new Error('Daemon returned no thread identity');
      if (!isAttached(sock)) return;
      if (threadIsBusy(threadId)) {
        throw new Error('A turn is already active or uncertain in this thread');
      }
      sock.threadId = threadId;
      reserveThread(threadId, null, true);
      addStartingSocket(sock, threadId);
      emit(sock, { type: 'session', metadata: { status: 'starting' } });

      turnRequestSent = true;
      const result = await rpc('turn/start', {
        threadId,
        input: String(msg.content || ''),
        // The temporary compatibility bridge deliberately ignores renderer
        // tool requests. It must not silently grant write authority.
        tools: { readOnly: true, write: false },
      });
      const turn = normalizedTurn(result, threadId);
      if (!turn || turn.threadId !== threadId) throw new Error('Daemon returned an invalid turn');
      if (!isAttached(sock)) {
        removeStartingSocket(sock, threadId);
        if (isTerminalStatus(turn.status)) releaseThread(threadId, turn.id);
        else reserveThread(threadId, turn.id, false);
        return;
      }
      if (!bindSocketToTurn(sock, threadId, turn.id)) {
        throw new Error('Daemon turn did not match this socket');
      }
      removeStartingSocket(sock, threadId);
      emit(sock, { type: 'session', metadata: { status: turn.status } });
      for (const item of turn.items || []) emitItem(sock, item);
      if (isTerminalStatus(turn.status)) {
        // Do not await this: turn/start is the asynchronous admission path.
        void reconcileTerminal(sock, turn);
      }
    } catch (error) {
      if (threadId) removeStartingSocket(sock, threadId);
      // A request may have reached the daemon even if its response did not.
      // Keep the thread guarded until an authoritative later resume/read.
      if (turnRequestSent && threadId) reserveThread(threadId, sock.turnId, true);
      else if (threadId) releaseThread(threadId);
      emitConnectionError(sock, error, { phase: turnRequestSent ? 'turn/start' : 'thread/start' });
    }
  }

  async function interruptTurn(sock, msg) {
    const turnId = nonEmptyId(msg.turn_id) || sock.turnId;
    if (!turnId) {
      emit(sock, { type: 'error', content: 'No turn identity available for cancellation' });
      return;
    }
    if (sock.turnId && sock.turnId !== turnId) {
      emit(sock, { type: 'error', content: 'Cancellation turn does not match this connection' });
      return;
    }
    try {
      const result = await rpc('turn/interrupt', { turnId });
      const turn = normalizedTurn(result, sock.threadId);
      if (!turn || turn.id !== turnId || (sock.threadId && turn.threadId !== sock.threadId)) {
        throw new Error('Daemon returned an invalid interrupt state');
      }
      if (!sock.turnId && turn.threadId) bindSocketToTurn(sock, turn.threadId, turn.id);
      if (isTerminalStatus(turn.status)) {
        // The immediate interrupt response is not the durable terminal proof.
        void reconcileTerminal(sock, turn);
      } else {
        emit(sock, {
          type: 'progress',
          metadata: { status: turn.status, remoteStatus: turn.status, runtime: 'knorvia-daemon' },
        });
      }
    } catch (error) {
      emitConnectionError(sock, error, { phase: 'turn/interrupt' });
    }
  }

  async function subscribeTurn(sock, msg) {
    const turnId = nonEmptyId(msg.turn_id);
    if (!turnId) {
      emit(sock, { type: 'error', content: 'A turn identity is required for recovery' });
      return;
    }
    if (sock.turnId && sock.turnId !== turnId) {
      emit(sock, { type: 'error', content: 'A different turn is already bound to this connection' });
      return;
    }
    if (sock.recovery) {
      emit(sock, { type: 'error', content: 'Turn recovery is already active on this connection' });
      return;
    }
    const after = Number(msg.after_seq ?? msg.seq ?? 0);
    const afterSeq = Number.isFinite(after) && after > 0 ? after : 0;
    // Register before turn/read so a terminal notification cannot disappear
    // between the snapshot request and this socket's normal subscription.
    const recovery = addRecoveringSocket(sock, turnId);
    try {
      const result = await rpc('turn/read', { id: turnId });
      if (!recovery.active || !isAttached(sock)) return;
      const turn = normalizedTurn(result, sock.threadId);
      if (!turn || turn.id !== turnId || !turn.threadId) {
        throw new Error('Daemon returned an invalid recovery snapshot');
      }
      if (sock.threadId && sock.threadId !== turn.threadId) {
        throw new Error('Recovery turn belongs to a different thread');
      }
      if (threadIsBusy(turn.threadId, turnId)) {
        throw new Error('A different turn is already active in this thread');
      }
      if (!bindSocketToTurn(sock, turn.threadId, turn.id, { resetLocalFailure: true })) {
        throw new Error('Unable to bind recovered turn');
      }
      sock.busy = !isTerminalStatus(turn.status);
      // Mark skipped durable Items before any terminal path can re-read or
      // replay a complete snapshot. `finishAuthoritative` uses this same
      // state, so after_seq remains effective for terminal recovery too.
      for (const item of turn.items || []) {
        const seq = Number(item?.seq);
        if (afterSeq && Number.isFinite(seq) && seq <= afterSeq) {
          ensureTurnState(sock, turn.id).rememberSnapshotItem(item);
        }
      }
      const signals = recoverySignals(recovery, turn.threadId);
      if (isTerminalStatus(turn.status)) {
        // turn/read is already the authoritative terminal snapshot.
        finishAuthoritative(sock, turn, turn);
        return;
      }
      if (signals.persistenceError) {
        emitPersistenceError(sock, new Error(errorText(
          signals.persistenceError.message,
          'Unable to persist Kernel turn state',
        )));
        return;
      }
      if (signals.terminalHint) {
        // The first snapshot may have been taken just before terminal
        // persistence. Re-read after binding; the terminal notification is
        // only a prompt, never terminal proof on its own.
        await reconcileTerminal(sock, signals.terminalHint);
        return;
      }
      emit(sock, {
        type: 'session',
        metadata: {
          status: turn.status,
          recovery: 'snapshot',
          realtimeCursor: 'current-daemon-only',
          crossDaemonRealtimeCursor: false,
        },
      });
      for (const item of turn.items || []) {
        const seq = Number(item?.seq);
        if (afterSeq && Number.isFinite(seq) && seq <= afterSeq) {
          continue;
        }
        emitItem(sock, item);
      }
      emit(sock, {
        type: 'progress',
        metadata: {
          status: turn.status,
          recovery: 'snapshot',
          realtimeCursor: 'current-daemon-only',
          crossDaemonRealtimeCursor: false,
        },
      });
    } catch (error) {
      if (recovery.active && isAttached(sock)) {
        emitConnectionError(sock, error, { phase: 'turn/recover' });
      }
    } finally {
      removeRecoveringSocket(recovery);
    }
  }

  async function handleWsOpen({ id }) {
    if (disposed) return { type: 'error', id, error: 'knorvia-daemon is unavailable' };
    if (sockets.has(id)) handleWsClose({ id });
    sockets.set(id, { id, send: null, closed: false, busy: false, threadId: undefined, turnId: undefined });
    return { type: 'open', id };
  }

  async function handleWsSend({ id, data }, send) {
    if (disposed) return;
    const sock = sockets.get(id) || { id, closed: false, busy: false };
    sockets.set(id, sock);
    sock.send = send;
    let msg;
    try { msg = typeof data === 'string' ? JSON.parse(data) : data; }
    catch { emit(sock, { type: 'error', content: 'invalid json' }); return; }
    if (msg?.type === 'ping') { emit(sock, { type: 'pong' }); return; }
    if (msg?.type === 'message' || msg?.type === 'start_turn') return startTurn(sock, msg);
    if (msg?.type === 'cancel_turn') return interruptTurn(sock, msg);
    if (msg?.type === 'subscribe_turn' || msg?.type === 'resume_from') return subscribeTurn(sock, msg);
    if (msg?.type === 'unsubscribe') {
      removeRecoveringSocket(sock.recovery);
      detachSocketFromTurn(sock);
      // A terminal read already in flight still owns cleanup of the local
      // active-turn guard. Suppress renderer output until it settles rather
      // than clearing its identity underneath that reconciliation.
      if (sock.turnState?.reconciling) {
        sock.suppressOutput = true;
        return;
      }
      sock.turnId = undefined;
      sock.turnState = null;
      sock.busy = false;
      return;
    }
    // Kernel explicitly declares userInput/respond unsupported. Do not
    // acknowledge those messages as model delivery.
    emit(sock, { type: 'error', content: `Unsupported desktop message: ${msg?.type || 'missing type'}` });
  }

  function handleWsClose({ id }) {
    const sock = sockets.get(id);
    if (!sock) return;
    sock.closed = true;
    removeRecoveringSocket(sock.recovery);
    removeStartingSocket(sock, sock.threadId);
    detachSocketFromTurn(sock);
    sock.send = null;
    sockets.delete(id);
  }

  // Engine-level daemon shutdown is distinct from a remote terminal event.
  // It gives each active renderer an explicit local connection state before
  // engine disposal removes listener references.
  function handleTransportClosed(error) {
    if (disposed) return;
    for (const sock of [...sockets.values()]) {
      if (sock.busy || sock.turnId) emitConnectionError(sock, error, { phase: 'daemon-closed' });
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const sock of sockets.values()) {
      sock.closed = true;
      sock.send = null;
    }
    sockets.clear();
    activeThreads.clear();
    turnSubscribers.clear();
    startingThreads.clear();
    recoveringTurns.clear();
  }

  return {
    handleWsOpen,
    handleWsSend,
    handleWsClose,
    handleNotification,
    handleTransportClosed,
    dispose,
  };
}

module.exports = { createChatBridge };
