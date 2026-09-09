'use strict';

// Pure per-Turn stream assembly. This intentionally knows nothing about RPC,
// sockets, Electron, or daemon lifetime so the temporary renderer bridge can
// keep those concerns at its boundary.

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function nonEmptyId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value);
  return id ? id : null;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function rendererStatus(remoteStatus) {
  return remoteStatus === 'interrupted' ? 'cancelled' : remoteStatus;
}

function errorText(error, fallback = 'Kernel request failed') {
  if (typeof error === 'string' && error) return error;
  if (error && typeof error.message === 'string' && error.message) return error.message;
  if (error && typeof error.error?.message === 'string' && error.error.message) return error.error.message;
  try {
    if (error) return JSON.stringify(error);
  } catch {}
  return fallback;
}

function itemText(payload) {
  if (typeof payload?.text === 'string') return payload.text;
  if (typeof payload?.message === 'string') return payload.message;
  return '';
}

// The final ProductStore Item carries `payload.kernelItemId`; deltas use the
// same upstream item id as `payload.itemId`. ProductStore Item.id remains the
// durable de-duplication key and must not be confused with it.
function kernelItemId(item, payload) {
  return nonEmptyId(
    item?.payload?.kernelItemId
    ?? item?.kernelItemId
    ?? payload?.kernelItemId
    ?? payload?.itemId
    ?? item?.id,
  );
}

function persistentItemKey(item, turnId) {
  const itemId = nonEmptyId(item?.id);
  if (itemId) return `item:${itemId}`;
  const seq = Number(item?.seq);
  if (Number.isFinite(seq)) return `seq:${turnId}:${seq}`;
  const upstream = kernelItemId(item, item?.payload);
  if (upstream) return `kernel:${item?.kind || ''}:${upstream}`;
  // Do not use content: equal text in separate persisted Items is valid.
  return null;
}

function normalizedTurn(result, fallbackThreadId) {
  const nested = result?.turn && typeof result.turn === 'object' ? result.turn : result;
  if (!nested || typeof nested !== 'object') return null;
  const id = nonEmptyId(nested.id);
  const status = typeof nested.status === 'string' ? nested.status : null;
  if (!id || !status) return null;
  return {
    ...nested,
    id,
    threadId: nonEmptyId(nested.threadId ?? nested.thread_id) || fallbackThreadId,
    status,
    items: Array.isArray(result?.items)
      ? result.items
      : Array.isArray(nested.items) ? nested.items : [],
    error: nested.error ?? result?.error,
  };
}

class TurnStreamState {
  constructor(turnId) {
    this.turnId = turnId;
    this.seenPersistentItems = new Set();
    this.seenLegacyItems = new Set();
    this.deltaText = new Map();
    this.finalizedKernelItems = new Set();
    this.sawError = false;
    this.reconciling = null;
    this.localEnded = false;
  }

  matches(item, threadId) {
    const itemTurnId = nonEmptyId(item?.turnId ?? item?.turn_id);
    const itemThreadId = nonEmptyId(item?.threadId ?? item?.thread_id);
    return (!itemTurnId || itemTurnId === this.turnId)
      && (!itemThreadId || itemThreadId === threadId);
  }

  metadata(item, kind, payload, upstream) {
    return {
      itemId: nonEmptyId(item?.id),
      kernelItemId: upstream || undefined,
      kind,
      payload,
    };
  }

  acceptItem(item, { threadId, kind: fallbackKind, payload: fallbackPayload, legacyKey } = {}) {
    if (!this.matches(item, threadId)) return null;
    const kind = String(item?.kind || fallbackKind || 'progress');
    const payload = item?.payload ?? fallbackPayload ?? {};
    const durableKey = item ? persistentItemKey(item, this.turnId) : null;
    if (durableKey) {
      if (this.seenPersistentItems.has(durableKey)) return null;
      this.seenPersistentItems.add(durableKey);
    } else if (legacyKey) {
      if (this.seenLegacyItems.has(legacyKey)) return null;
      this.seenLegacyItems.add(legacyKey);
    }

    const upstream = kernelItemId(item, payload);
    const metadata = this.metadata(item, kind, payload, upstream);
    const seq = Number.isFinite(Number(item?.seq)) ? Number(item.seq) : undefined;
    if (kind === 'userMessage') return { type: 'userMessage' };
    if (kind === 'agentMessage') {
      if (upstream && this.finalizedKernelItems.has(upstream)) return { type: 'agentMessage', emit: false };
      const text = itemText(payload);
      const assembled = upstream ? this.deltaText.get(upstream) || '' : '';
      const content = assembled && text.startsWith(assembled) ? text.slice(assembled.length) : text;
      if (upstream) {
        this.finalizedKernelItems.add(upstream);
        this.deltaText.delete(upstream);
      }
      return { type: 'content', content, seq, metadata, emit: Boolean(content) };
    }
    if (kind === 'error') {
      this.sawError = true;
      return {
        type: 'error',
        content: itemText(payload) || errorText(payload, 'Kernel turn failed'),
        seq,
        metadata,
        emit: true,
      };
    }
    return { type: 'progress', content: itemText(payload), seq, metadata, emit: true };
  }

  acceptDelta(payload) {
    const upstream = nonEmptyId(payload?.itemId ?? payload?.kernelItemId);
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!upstream || !text || this.finalizedKernelItems.has(upstream)) return null;
    this.deltaText.set(upstream, `${this.deltaText.get(upstream) || ''}${text}`);
    return {
      type: 'content',
      content: text,
      metadata: {
        kernelItemId: upstream,
        kind: 'agentMessage.delta',
        transient: true,
      },
      emit: true,
    };
  }

  rememberSnapshotItem(item) {
    const key = persistentItemKey(item, this.turnId);
    if (key) this.seenPersistentItems.add(key);
    const upstream = kernelItemId(item, item?.payload);
    if (item?.kind === 'agentMessage' && upstream) this.finalizedKernelItems.add(upstream);
  }
}

module.exports = {
  TurnStreamState,
  errorText,
  isTerminalStatus,
  kernelItemId,
  nonEmptyId,
  normalizedTurn,
  rendererStatus,
};
