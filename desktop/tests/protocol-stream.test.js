"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DesktopAssetStreamBroker,
  isDesktopDirectFilePath,
} = require("../protocol-stream");

test("only same-origin studio content and project exports use the direct stream", () => {
  assert.equal(isDesktopDirectFilePath("/api/v1/video-studio/assets/a/content"), true);
  assert.equal(isDesktopDirectFilePath("/api/v1/image-studio/assets/a/content"), true);
  assert.equal(isDesktopDirectFilePath("/api/v1/video-studio/projects/p/export"), true);
  assert.equal(isDesktopDirectFilePath("/api/v1/image-studio/projects/p/export"), true);
  assert.equal(isDesktopDirectFilePath("/api/v1/video-studio/jobs/a"), false);
  assert.equal(isDesktopDirectFilePath("/api/v1/video-studio/assets/a/content/extra"), false);
});

test("desktop broker preserves Range response status and streams chunks", async () => {
  const sent = [];
  const broker = new DesktopAssetStreamBroker((message) => {
    sent.push(message);
    return true;
  });
  const pending = broker.open(
    new Request("knorvia://app/api/v1/video-studio/assets/a/content", {
      headers: { Range: "bytes=4-9" },
    }),
    "/api/v1/video-studio/assets/a/content",
  );
  const id = sent[0].id;
  assert.equal(sent[0].headers.range, "bytes=4-9");
  broker.handle({
    kind: "http_stream_start",
    id,
    status: 206,
    headers: { "content-range": "bytes 4-9/20", "content-length": "6" },
  });
  broker.handle({ kind: "http_stream_chunk", id, body: Buffer.from("456789").toString("base64") });
  broker.handle({ kind: "http_stream_end", id });
  const response = await pending;
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 4-9/20");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "456789");
});

test("HEAD and 416 responses keep their status without a response body", async () => {
  for (const [method, status] of [["HEAD", 200], ["GET", 416]]) {
    const sent = [];
    const broker = new DesktopAssetStreamBroker((message) => {
      sent.push(message);
      return true;
    });
    const pending = broker.open(
      new Request("knorvia://app/api/v1/video-studio/assets/a/content", { method }),
      "/api/v1/video-studio/assets/a/content",
    );
    const id = sent[0].id;
    broker.handle({ kind: "http_stream_start", id, status, headers: {} });
    broker.handle({ kind: "http_stream_end", id });
    const response = await pending;
    assert.equal(response.status, status);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
});

test("cancelling the response body propagates to the Python stream", async () => {
  const sent = [];
  const broker = new DesktopAssetStreamBroker((message) => {
    sent.push(message);
    return true;
  });
  const pending = broker.open(
    new Request("knorvia://app/api/v1/video-studio/assets/a/content"),
    "/api/v1/video-studio/assets/a/content",
  );
  const id = sent[0].id;
  broker.handle({ kind: "http_stream_start", id, status: 200, headers: {} });
  const response = await pending;
  await response.body.cancel();
  assert.equal(sent.at(-1).kind, "http_stream_cancel");
  assert.equal(sent.at(-1).id, id);
  assert.equal(broker.pending.size, 0);
});

test("a request aborted before open never starts a Python stream", async () => {
  const sent = [];
  const controller = new AbortController();
  controller.abort();
  const broker = new DesktopAssetStreamBroker((message) => {
    sent.push(message);
    return true;
  });
  const response = broker.open(
    new Request("knorvia://app/api/v1/video-studio/assets/a/content", {
      signal: controller.signal,
    }),
    "/api/v1/video-studio/assets/a/content",
  );

  await assert.rejects(response, { name: "AbortError" });
  assert.deepEqual(sent, []);
  assert.equal(broker.pending.size, 0);
});

test("project ZIP export preserves disposition and streams without the Next proxy", async () => {
  const sent = [];
  const broker = new DesktopAssetStreamBroker((message) => {
    sent.push(message);
    return true;
  });
  const pending = broker.open(
    new Request("knorvia://app/api/v1/video-studio/projects/p/export"),
    "/api/v1/video-studio/projects/p/export",
  );
  const id = sent[0].id;
  broker.handle({
    kind: "http_stream_start",
    id,
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="project.zip"',
    },
  });
  broker.handle({ kind: "http_stream_chunk", id, body: Buffer.from("PK-test").toString("base64") });
  broker.handle({ kind: "http_stream_end", id });
  const response = await pending;
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="project.zip"');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "PK-test");
});

test("slow consumers keep at most one pending chunk and acknowledge on pull", async () => {
  const sent = [];
  const broker = new DesktopAssetStreamBroker((message) => {
    sent.push(message);
    return true;
  });
  const pending = broker.open(
    new Request("knorvia://app/api/v1/video-studio/assets/a/content"),
    "/api/v1/video-studio/assets/a/content",
  );
  const id = sent[0].id;
  broker.handle({ kind: "http_stream_start", id, status: 200, headers: {} });
  const response = await pending;
  broker.handle({ kind: "http_stream_chunk", id, body: Buffer.from("one").toString("base64") });
  broker.handle({ kind: "http_stream_chunk", id, body: Buffer.from("two").toString("base64") });
  assert.equal(sent.filter((message) => message.kind === "http_stream_ack").length, 0);
  assert.equal(broker.pending.get(id).pendingChunk.toString(), "two");

  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), "one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.filter((message) => message.kind === "http_stream_ack").length, 1);
  broker.handle({ kind: "http_stream_end", id });
  assert.equal(Buffer.from((await reader.read()).value).toString(), "two");
  assert.equal((await reader.read()).done, true);
});

test("an idle stream is cancelled and errors the response body", async () => {
  const sent = [];
  const broker = new DesktopAssetStreamBroker(
    (message) => {
      sent.push(message);
      return true;
    },
    { startTimeoutMs: 100, idleTimeoutMs: 15 },
  );
  const pending = broker.open(
    new Request("knorvia://app/api/v1/video-studio/assets/a/content"),
    "/api/v1/video-studio/assets/a/content",
  );
  const id = sent[0].id;
  broker.handle({ kind: "http_stream_start", id, status: 200, headers: {} });
  const response = await pending;
  const reader = response.body.getReader();
  await assert.rejects(reader.read(), /became idle/);
  assert.equal(sent.at(-1).kind, "http_stream_cancel");
  assert.equal(broker.pending.size, 0);
});

test("shutdown cancels every active Python stream before rejecting it", async () => {
  const sent = [];
  const broker = new DesktopAssetStreamBroker((message) => {
    sent.push(message);
    return true;
  });
  const pending = broker.open(
    new Request("knorvia://app/api/v1/video-studio/assets/a/content"),
    "/api/v1/video-studio/assets/a/content",
  );
  const rejection = assert.rejects(pending, /shutting down/);
  broker.failAll(new Error("shutting down"));
  await rejection;
  assert.equal(sent.at(-1).kind, "http_stream_cancel");
  assert.equal(broker.pending.size, 0);
});
