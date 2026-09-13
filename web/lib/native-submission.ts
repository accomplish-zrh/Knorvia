type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Retrying an unchanged submission reuses admission keys, even after a reload. */
export async function submissionAttempt(storage: DraftStorage | undefined, scope: string, body: unknown, action: { kind: 'start' | 'steer'; turnId?: string }) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
  const fingerprint = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const key = `${scope}:submission`;
  try {
    const previous = JSON.parse(storage?.getItem(key) ?? 'null');
    if (previous?.fingerprint === fingerprint && typeof previous.id === 'string' && /^[\w-]{36}$/.test(previous.id) && ['start', 'steer'].includes(previous.action?.kind)) return { id: previous.id as string, fingerprint, action: previous.action as typeof action };
  } catch { /* Storage can be unavailable; the mounted composer retains its attempt. */ }
  const attempt = { id: crypto.randomUUID(), fingerprint, action };
  try { storage?.setItem(key, JSON.stringify(attempt)); } catch { /* The current attempt is still reusable in memory. */ }
  return attempt;
}

export function clearSubmission(storage: DraftStorage | undefined, scope: string, id: string) {
  try { if (JSON.parse(storage?.getItem(`${scope}:submission`) ?? 'null')?.id === id) storage?.removeItem(`${scope}:submission`); } catch { /* optional draft storage */ }
}

export type StoredSubmission = { id: string; fingerprint: string; action: { kind: 'start' | 'steer'; turnId?: string } };

/** Read the retained attempt without changing its identity. */
export function readStoredSubmission(storage: DraftStorage | undefined, scope: string): StoredSubmission | undefined {
  try {
    const stored = JSON.parse(storage?.getItem(`${scope}:submission`) ?? 'null');
    if (stored && typeof stored.id === 'string' && typeof stored.fingerprint === 'string' && ['start', 'steer'].includes(stored.action?.kind)) return stored as StoredSubmission;
  } catch { /* optional draft storage */ }
  return undefined;
}

/**
 * Record that a retained attempt failed so recovery flows can find it after a
 * reload. The id and fingerprint stay untouched: the attempt must remain the
 * same admission identity, whether it is retried or explicitly recovered.
 */
export function markSubmissionFailed(storage: DraftStorage | undefined, scope: string, id: string) {
  try {
    const stored = JSON.parse(storage?.getItem(`${scope}:submission`) ?? 'null');
    if (stored?.id === id) storage?.setItem(`${scope}:submission`, JSON.stringify({ ...stored, outcome: 'failed' }));
  } catch { /* optional draft storage */ }
}
