import test from "node:test";
import assert from "node:assert/strict";
import { decidePreviewMediaEffect, planMediaRender, streamTokenFromUrl, type MediaReadResult } from "../lib/native-media-render";

const TOKEN = "a".repeat(32) + "b".repeat(32);
const streamResponse = (mime: string | undefined): MediaReadResult =>
  ({ supported: true, stream: true, size: 9_000_000, mime, url: `http://127.0.0.1:4529/${TOKEN}`, expiresAt: Date.now() + 600_000 });

test("regression: a stream response with no base64 renders media from the loopback URL", () => {
  // Before the fix this response produced an empty mediaUrl and NO media
  // element at all — the panel showed nothing for a healthy video.
  const plan = planMediaRender(streamResponse("video/mp4"), "");
  assert.deepEqual(plan, { kind: "video", url: `http://127.0.0.1:4529/${TOKEN}`, source: "stream" });

  assert.deepEqual(planMediaRender(streamResponse("image/png"), "").kind, "image");
  assert.deepEqual(planMediaRender(streamResponse("audio/wav"), "").kind, "audio");
  assert.deepEqual(
    planMediaRender(streamResponse("application/pdf"), ""),
    { kind: "pdf", url: `http://127.0.0.1:4529/${TOKEN}`, source: "stream" },
  );
});

test("an unsupported stream mime degrades to none instead of guessing", () => {
  assert.deepEqual(planMediaRender(streamResponse("application/zip"), ""), { kind: "none" });
  assert.deepEqual(planMediaRender(streamResponse(undefined), ""), { kind: "none" });
});

test("the legacy base64 blob path is unchanged", () => {
  const media: MediaReadResult = { supported: true, size: 4096, mime: "image/png", base64: "aGk=" };
  assert.deepEqual(planMediaRender(media, "blob:legacy"), { kind: "image", url: "blob:legacy", source: "blob" });
  assert.equal(planMediaRender(media, "").kind, "none");
});

test("no media result means no render, and expiresAt never breaks the decision", () => {
  assert.deepEqual(planMediaRender(undefined, "blob:x"), { kind: "none" });
  const withExpiry = { ...streamResponse("video/mp4"), expiresAt: 1 };
  assert.equal(planMediaRender(withExpiry, "").kind, "video");
});

test("stream tokens are extracted from the URL's 64-hex tail only", () => {
  assert.equal(streamTokenFromUrl(`http://127.0.0.1:4529/${TOKEN}`), TOKEN);
  assert.equal(streamTokenFromUrl(`http://127.0.0.1:4529/${TOKEN}?range=0-1`), TOKEN);
  assert.equal(streamTokenFromUrl("http://127.0.0.1:4529/not-a-token"), null);
  assert.equal(streamTokenFromUrl("not a url"), null);
});

// --- X review item 3: component-effect sequences (runnable counterexamples) ---

const streamVideo = (): MediaReadResult =>
  ({ supported: true, stream: true, size: 5_242_880, mime: "video/mp4", url: `http://127.0.0.1:4529/${TOKEN}` });

test("counterexample: a stream-only video response (no base64) applies and registers its token", () => {
  const d = decidePreviewMediaEffect({ cancelled: false, result: streamVideo() });
  assert.equal(d.apply, true);
  assert.equal(d.registerToken, TOKEN);
  assert.deepEqual(d.revokeTokens, []);
});

test("counterexample: a 5MiB stream image applies identically to a small image", () => {
  const big = { supported: true, stream: true, size: 5_242_880, mime: "image/png", url: `http://127.0.0.1:4529/${TOKEN}` };
  const d = decidePreviewMediaEffect({ cancelled: false, result: big });
  assert.equal(d.apply, true);
  assert.equal(d.registerToken, TOKEN);
});

test("panel closed first, then the response lands: apply nothing, revoke the token immediately", () => {
  const d = decidePreviewMediaEffect({ cancelled: true, result: streamVideo() });
  assert.equal(d.apply, false);
  assert.deepEqual(d.revokeTokens, [TOKEN]);
});

test("path A's late response cannot overwrite path B: it is dropped and its token revoked", () => {
  // Path B is already applied (registered its token); path A's response lands late.
  const registered = decidePreviewMediaEffect({ cancelled: false, result: streamVideo() });
  assert.equal(registered.apply, true);
  const stale = decidePreviewMediaEffect({ cancelled: true, result: { supported: true, stream: true, size: 1, mime: "video/mp4", url: `http://127.0.0.1:4529/${"f".repeat(64)}` } });
  assert.equal(stale.apply, false);
  assert.deepEqual(stale.revokeTokens, ["f".repeat(64)]);
  // Path B's registration is untouched by A's revocation decision.
  assert.equal(registered.registerToken, TOKEN);
});

test("a non-stream result after cancel applies nothing and revokes nothing", () => {
  const d = decidePreviewMediaEffect({ cancelled: true, result: { supported: true, size: 10, mime: "image/png", base64: "aGk=" } });
  assert.equal(d.apply, false);
  assert.deepEqual(d.revokeTokens, []);
});

test("current text, base64 and unsupported results must update the real preview", () => {
  for (const result of [undefined, { supported: true, size: 10, mime: "image/png", base64: "aGk=" }, { supported: false, size: 10 }]) {
    const decision = decidePreviewMediaEffect({ cancelled: false, result });
    assert.equal(decision.apply, true);
    assert.equal(decision.registerToken, undefined);
    assert.deepEqual(decision.revokeTokens, []);
  }
});
