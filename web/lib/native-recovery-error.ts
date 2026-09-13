import { NativeClientError } from "@/lib/knorvia-native-types";

/**
 * Structured recovery categories for workbench errors. The banner action must
 * match the cause: only connection loss may suggest reconnecting, business
 * conflicts need their own wording, and a persistence error is not an error
 * banner at all but a transient "state unconfirmed" recovery.
 */
export type RecoveryErrorKind = "connection" | "conflict" | "generic";

/** Transport-level failure codes from the native client. */
export const CONNECTION_ERROR_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_LOST",
  "CONNECTION_TIMEOUT",
  "CONNECTION_UNAVAILABLE",
  "CONNECT_TIMEOUT",
  "SEND_FAILED",
  "SESSION_EXPIRED",
]);

/**
 * RPC categories that a retry after reconnect cannot fix: invalid arguments,
 * missing records, precondition and conflict responses.
 */
export const CONFLICT_RPC_CODES = new Set([-32602, -32004, -32005, -32006]);

const CONNECTION_MESSAGE = /websocket|session bootstrap|unable to connect|could not connect|is connecting|not connected|connection (was |is )?(closed|lost|unavailable|failed)|fetch failed|network/i;

export function kindFromCode(code: number | string | undefined): RecoveryErrorKind {
  if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return "connection";
  if (typeof code === "number" && CONFLICT_RPC_CODES.has(code)) return "conflict";
  return "generic";
}

/** Classify a thrown value; plain strings fall back to message patterns. */
export function recoveryKindOf(error: unknown): RecoveryErrorKind {
  if (error instanceof NativeClientError) return kindFromCode(error.code);
  const code = (error as { code?: number | string } | null)?.code;
  if (typeof code === "string" || typeof code === "number") return kindFromCode(code);
  const message = error instanceof Error ? error.message : String(error ?? "");
  return CONNECTION_MESSAGE.test(message) ? "connection" : "generic";
}

export function recoveryKindOfMessage(message: string): RecoveryErrorKind {
  return CONNECTION_MESSAGE.test(message) ? "connection" : "generic";
}

/** Durable-state recovery: a persistence error means status is unconfirmed. */
export type PersistenceRecovery = { threadId?: string; message: string };
