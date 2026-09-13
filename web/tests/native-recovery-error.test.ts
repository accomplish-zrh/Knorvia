import test from "node:test";
import assert from "node:assert/strict";
import { NativeClientError } from "../lib/knorvia-native-types";
import { kindFromCode, recoveryKindOf, recoveryKindOfMessage } from "../lib/native-recovery-error";

test("transport failures classify as connection, so reconnect stays the offered action", () => {
  for (const code of ["CONNECTION_CLOSED", "CONNECTION_LOST", "CONNECTION_TIMEOUT", "CONNECTION_UNAVAILABLE", "CONNECT_TIMEOUT", "SEND_FAILED", "SESSION_EXPIRED"]) {
    assert.equal(kindFromCode(code), "connection", code);
  }
  assert.equal(recoveryKindOf(new NativeClientError("Native WebSocket connection failed", { code: "CONNECTION_LOST" })), "connection");
});

test("a param conflict or missing record never suggests reconnecting", () => {
  for (const [code, label] of [[-32602, "invalid argument"], [-32004, "not found"], [-32005, "conflict"], [-32006, "precondition"]] as const) {
    assert.equal(kindFromCode(code), "conflict", label);
  }
  const rejected = new NativeClientError("Conflict: turn is no longer running", { code: -32005 });
  assert.equal(recoveryKindOf(rejected), "conflict");
});

test("plain strings fall back to connection wording; daemon business text stays generic", () => {
  assert.equal(recoveryKindOfMessage("Native WebSocket is not connected"), "connection");
  assert.equal(recoveryKindOfMessage("Knorvia is connecting"), "connection");
  assert.equal(recoveryKindOfMessage("Native session bootstrap failed (502)"), "connection");
  assert.equal(recoveryKindOfMessage("Conflict: turn is no longer running"), "generic");
  assert.equal(recoveryKindOfMessage("Task state needs recovery"), "generic");
  assert.equal(recoveryKindOf(new Error("turn does not belong to threadId")), "generic");
});

test("a plain error with an unknown shape is generic rather than connection", () => {
  assert.equal(recoveryKindOf(undefined), "generic");
  assert.equal(recoveryKindOf("operation failed"), "generic");
});
