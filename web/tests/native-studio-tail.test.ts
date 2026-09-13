import test from "node:test";
import assert from "node:assert/strict";
import { TailExportRunner, tailCancelParams } from "../lib/native-studio-tail";
import type { StudioFrameExport } from "../lib/native-studio";

const frame: StudioFrameExport = {
  jobId: "job-1", outputIndex: 0, path: "p", sha256: "s", sourceVideoSha256: "v", streamIndex: 0,
  pts: 1, timeBase: "1/1000", width: 640, height: 360, libraryId: "lib", libraryVersion: "sha", name: "tail.png", file: "f", decoder: "ffmpeg",
};

type Script = {
  exportError?: Error;
  cancelReply?: unknown;
  cancelError?: Error;
  holdCancel?: boolean;
  holdExport?: boolean;
};

const harness = (script: Script) => {
  const cancelRequests: Record<string, unknown>[] = [];
  const pendingCancels: Array<(value: unknown) => void> = [];
  const pendingExports: Array<(value: StudioFrameExport) => void> = [];
  const runner = new TailExportRunner(async (method, params) => {
    if (method === "studio/frame/cancel") {
      cancelRequests.push(params);
      if (script.cancelError) return Promise.reject(script.cancelError);
      if (script.holdCancel) return new Promise(resolve => { pendingCancels.push(resolve); });
      return Promise.resolve(script.cancelReply ?? { canceled: true, stopped: 1, jobId: params.id, outputIndex: params.index });
    }
    if (script.exportError) return Promise.reject(script.exportError);
    if (script.holdExport) return new Promise<StudioFrameExport>(resolve => { pendingExports.push(resolve); });
    return Promise.resolve(frame);
  });
  return { runner, cancelRequests, pendingCancels, pendingExports };
};

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

test("counterexample A: host already published, cancel declined, export succeeds → done, frame applied", async () => {
  const { runner, cancelRequests } = harness({ cancelReply: { canceled: false, stopped: 0, jobId: "job-1", outputIndex: 0 } });
  let frames = 0;
  assert.equal(await runner.run("job-1", 0, async () => { frames += 1; }), "done");
  assert.equal(frames, 1);
  // Second export with an explicit cancel click the host declines.
  const run = runner.run("job-1", 1, async () => { frames += 1; });
  assert.equal(await runner.cancel(), "declined");
  assert.equal(await run, "done");
  assert.equal(frames, 2);
  assert.equal(cancelRequests.length, 1);
});

test("counterexample B: cancel RPC fails, export succeeds → done, not cancelled", async () => {
  const { runner } = harness({ cancelError: new Error("transport down") });
  let frames = 0;
  const run = runner.run("job-1", 0, async () => { frames += 1; });
  assert.equal(await runner.cancel(), "failed");
  assert.equal(await run, "done");
  assert.equal(frames, 1);
});

test("host-confirmed cancel before publication yields cancelled and drops the frame", async () => {
  const { runner, cancelRequests, pendingExports } = harness({ holdExport: true, cancelReply: { canceled: true, stopped: 1, jobId: "job-1", outputIndex: 0 } });
  let frames = 0;
  const run = runner.run("job-1", 0, async () => { frames += 1; });
  await wait(0);
  // The cancel lands while the export is still in flight: the host wins.
  assert.equal(await runner.cancel(), "confirmed");
  pendingExports[0](frame);
  assert.equal(await run, "cancelled");
  assert.equal(frames, 0);
  assert.deepEqual(cancelRequests[0], tailCancelParams({ jobId: "job-1", index: 0 }));
});

test("repeat clicks send at most one request; deferred receipt confirms and both terminal states settle", async () => {
  const { runner, cancelRequests, pendingCancels, pendingExports } = harness({ holdCancel: true, holdExport: true });
  let frames = 0;
  let releaseFrame: () => void = () => {};
  const frameGate = new Promise<void>(resolve => { releaseFrame = resolve; });
  const run = runner.run("job-1", 0, async () => {
    frames += 1;
    await frameGate;
  });
  await wait(0);
  // First click: save the promise without awaiting (the RPC is pending).
  const cancelPromise1 = runner.cancel();
  await wait(0);
  assert.equal(cancelRequests.length, 1);
  // Repeat click: no new request; settles immediately as already-requested.
  const cancelPromise2 = runner.cancel();
  assert.equal(await cancelPromise2, "already-requested");
  assert.equal(cancelRequests.length, 1);
  // Release the host receipt: the pending request confirms…
  pendingCancels[0]({ canceled: true, stopped: 1, jobId: "job-1", outputIndex: 0 });
  assert.equal(await cancelPromise1, "confirmed");
  // …and the confirmed cancel decides the export outcome (frame dropped).
  releaseFrame();
  pendingExports[0](frame);
  assert.equal(await run, "cancelled");
  assert.equal(frames, 0);
  assert.equal(runner.isCancelConfirmed(), true);
});

test("export settles first: a late confirmed receipt cannot overturn done or pollute the next task", async () => {
  const { runner, pendingCancels, pendingExports, cancelRequests } = harness({ holdCancel: true, holdExport: true });
  let frames = 0;
  let runSettled = false;
  // The cancel request is sent while the export is still in flight.
  const run = runner.run("job-1", 0, async () => {
    frames += 1;
    runSettled = true;
  });
  const cancelPromise = runner.cancel();
  await wait(0);
  assert.equal(cancelRequests.length, 1);
  // The export settles BEFORE the cancel receipt lands.
  pendingExports[0](frame);
  assert.equal(await run, "done");
  assert.equal(frames, 1);
  assert.equal(runSettled, true);
  // The receipt arrives after the export settled: the runner declines it —
  // the completed "done" outcome stands and is not polluted.
  pendingCancels[0]({ canceled: true, stopped: 1, jobId: "job-1", outputIndex: 0 });
  assert.equal(await cancelPromise, "declined");
  assert.equal(runner.isCancelConfirmed(), false);
});

test("a receipt bound to another job or output confirms nothing", async () => {
  const { runner } = harness({ cancelReply: { canceled: true, stopped: 1, jobId: "other", outputIndex: 0 } });
  let frames = 0;
  const run = runner.run("job-1", 0, async () => { frames += 1; });
  assert.equal(await runner.cancel(), "declined");
  assert.equal(await run, "done");
  assert.equal(frames, 1);
  assert.equal(runner.isCancelConfirmed(), false);
});

test("cancel with no active export is inactive and sends nothing", async () => {
  const { runner, cancelRequests } = harness({});
  assert.equal(await runner.cancel(), "inactive");
  assert.equal(cancelRequests.length, 0);
});
