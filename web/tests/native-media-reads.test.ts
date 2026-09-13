import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readStudioOutput, type StudioJob } from "../lib/native-studio";
import { MediaReadPool } from "../lib/native-media-read-pool";

const raw = Buffer.from("the actual immutable output");
const output = { name: "a.png", mime: "image/png", size: raw.length, sha256: createHash("sha256").update(raw).digest("hex") };
const job = { id: "first-job", outputs: [output] } as StudioJob;
const response = (patch = {}) => ({ ...output, base64: raw.toString("base64"), nextOffset: null, ...patch });
const read = (patch: Record<string, unknown>) => readStudioOutput((async () => response(patch)) as never, job);

test("media reader verifies exact bytes and chunk continuity against immutable output", async () => {
  const calls: number[] = [];
  const blob = await readStudioOutput((async (_method: string, params: { offset: number }) => {
    calls.push(params.offset);
    const end = Math.min(raw.length, params.offset + 7);
    return response({ base64: raw.subarray(params.offset, end).toString("base64"), nextOffset: end < raw.length ? end : null });
  }) as never, job);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), raw);
  assert.deepEqual(calls, [0, 7, 14, 21]);
  await assert.rejects(read({ base64: raw.subarray(0, 7).toString("base64") }), /incomplete/);
  await assert.rejects(read({ nextOffset: 0 }), /out of order/);
  await assert.rejects(read({ nextOffset: raw.length }), /out of order/);
  await assert.rejects(read({ name: "different.png" }), /source changed/);
  await assert.rejects(read({ size: raw.length + 1 }), /source changed/);
  await assert.rejects(read({ base64: Buffer.alloc(raw.length, 42).toString("base64") }), /digest changed/);
  await assert.rejects(read({ base64: Buffer.alloc(raw.length + 4).toString("base64") }), /Invalid media chunk/);
});

test("media reader validates allocation bounds and stops after an aborted in-flight chunk", async () => {
  for (const size of [-1, 1.1, Number.NaN, 256 * 1024 * 1024 + 1]) {
    await assert.rejects(readStudioOutput((async () => { throw Error("must not call"); }) as never, { ...job, outputs: [{ ...output, size }] }), /Media unavailable/);
  }
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(readStudioOutput((async () => {
    calls += 1; controller.abort();
    return response({ base64: raw.subarray(0, 7).toString("base64"), nextOffset: 7 });
  }) as never, job, 0, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("cancelled transport retains its pool slot until it settles, including remounts", async () => {
  const pool = new MediaReadPool(2);
  const first = new AbortController(), queued = new AbortController();
  let finishFirst!: () => void, finishSecond!: () => void;
  let active = 0, max = 0, thirdStarted = false, canceledStarted = false;
  const hold = (save: (done: () => void) => void) => async () => {
    active += 1; max = Math.max(max, active);
    await new Promise<void>(resolve => save(resolve)); active -= 1;
  };
  const a = pool.run(first.signal, hold(done => { finishFirst = done; }));
  const b = pool.run(new AbortController().signal, hold(done => { finishSecond = done; }));
  const c = pool.run(queued.signal, async () => { canceledStarted = true; });
  const caught = assert.rejects(c, { name: "AbortError" });
  const d = pool.run(new AbortController().signal, async () => { thirdStarted = true; active += 1; max = Math.max(max, active); active -= 1; });
  await Promise.resolve(); first.abort(); queued.abort(); await caught;
  assert.equal(thirdStarted, false); assert.equal(canceledStarted, false);
  finishFirst(); await a; await d; finishSecond(); await b;
  assert.equal(thirdStarted, true); assert.equal(max, 2); assert.equal(active, 0);
});
