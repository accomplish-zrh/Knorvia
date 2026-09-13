"use strict";

// In-app update download task for the Knorvia desktop shell.
//
// The pre-existing flow handed the download URL to the browser. This module
// owns a real download task instead: it pins the user-chosen release/asset
// (URL + declared SHA-256 + size), streams to a unique temp file, reports
// progress, and can be cancelled — removing exactly this task's temp file.
// On completion the content is verified against the declared digest and only
// then published atomically to the user's download directory. Publishing
// refuses when the target already exists, and a missing digest is reported
// as unverified — never as verified. The installer is never launched here.

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

function parseDigest(digest) {
  if (typeof digest !== "string") return "";
  const match = /^sha256:([0-9a-fA-F]{64})$/.exec(digest.trim());
  return match ? match[1].toLowerCase() : "";
}

function safeFileName(name, version) {
  const base = String(name || "update-download")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .slice(0, 120);
  const tag = String(version || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "").slice(0, 40);
  return tag ? `${tag}-${base}` : base;
}

function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    url: task.url,
    name: task.name,
    version: task.version,
    sha256: task.sha256 || "",
    verified: task.verified,
    state: task.state,
    receivedBytes: task.receivedBytes,
    totalBytes: task.totalBytes,
    destinationDir: task.destinationDir,
    publishedPath: task.publishedPath || "",
    error: task.error || "",
    startedAt: task.startedAt,
  };
}

function createUpdateDownloadManager({
  fetchImpl = null,
  defaultDownloadDir,
  now = () => Date.now(),
  progressIntervalMs = 200,
} = {}) {
  if (!defaultDownloadDir || !path.isAbsolute(defaultDownloadDir)) {
    throw new Error("update download requires an absolute default download directory");
  }
  const doFetch = fetchImpl || ((url, options) => fetch(url, options));
  let task = null; // one download at a time; the last finished task stays inspectable
  let controller = null;

  async function removeTemp(task_) {
    if (task_?.tempPath) await fsp.unlink(task_.tempPath).catch(() => {});
  }

  async function run(task_) {
    const progress = { at: 0 };
    let handle = null;
    try {
      const response = await doFetch(task_.url, { signal: controller.signal, redirect: "error" });
      if (!response.ok || !response.body) throw Object.assign(new Error(`下载响应异常（${response.status}）`), { code: "EUPDATEHTTP" });
      const declared = Number(task_.totalBytes) || 0;
      const hash = createHash("sha256");
      let received = 0;
      handle = await fsp.open(task_.tempPath, "r+");
      for await (const chunk of response.body) {
        received += chunk.length;
        if (declared && received > declared) {
          throw Object.assign(new Error("下载内容超过声明大小"), { code: "EUPDATESIZE" });
        }
        hash.update(chunk);
        await handle.write(chunk);
        task_.receivedBytes = received;
        const at = now();
        if (at - progress.at >= progressIntervalMs) {
          progress.at = at;
          task_.onProgress?.(publicTask(task_));
        }
      }
      task_.receivedBytes = received;
      if (declared && received !== declared) {
        throw Object.assign(new Error("传输中断：内容不完整"), { code: "EUPDATEINCOMPLETE" });
      }
      const actualSha256 = hash.digest("hex");
      await handle.sync();
      await handle.close();
      handle = null;
      if (task_.sha256 && actualSha256 !== task_.sha256) {
        throw Object.assign(new Error("下载内容与声明的 SHA-256 摘要不一致"), { code: "EUPDATEDIGEST" });
      }
      // Publish atomically; an existing target is never overwritten.
      const finalPath = path.join(task_.destinationDir, safeFileName(task_.name, task_.version));
      let exists = true;
      try { await fsp.access(finalPath); } catch { exists = false; }
      if (exists) {
        throw Object.assign(new Error("目标位置已存在同名文件，未覆盖；请移动或删除后重试"), { code: "EUPDATEEXISTS" });
      }
      await fsp.rename(task_.tempPath, finalPath);
      task_.tempPath = "";
      task_.publishedPath = finalPath;
      task_.verified = Boolean(task_.sha256);
      task_.state = "published";
      task_.onProgress?.(publicTask(task_));
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await removeTemp(task_);
      if (task_.state === "cancelling") {
        task_.state = "cancelled";
        task_.error = "已取消";
      } else {
        task_.state = "failed";
        task_.error = String(error?.message || error).slice(0, 300);
      }
      task_.onProgress?.(publicTask(task_));
    }
  }

  return {
    // Starts the single download task. Retrying the exact same request while
    // it is still active returns the running task instead of spawning a
    // second download; a different request is refused until it finishes.
    start({
      url,
      name,
      version = "",
      sha256 = "",
      digest = "",
      size = 0,
      destinationDir = "",
      onProgress,
    } = {}) {
      const expected = (sha256 || parseDigest(digest)).toLowerCase();
      let parsed;
      try { parsed = new URL(url); } catch { parsed = null; }
      const loopback = Boolean(parsed && ["127.0.0.1", "[::1]", "localhost", "::1"].includes(parsed.hostname));
      if (!parsed || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))) {
        return { ok: false, error: "只支持 HTTPS 的下载地址" };
      }
      if (task && (task.state === "downloading" || task.state === "cancelling")) {
        if (task.url === url && (!expected || task.sha256 === expected)) return { ok: true, task: publicTask(task), existing: true };
        return { ok: false, error: "已有下载任务正在进行，请先取消或等待完成" };
      }
      controller = new AbortController();
      task = {
        id: randomUUID(),
        url,
        name: typeof name === "string" && name ? name : "Knorvia-update",
        version,
        sha256: expected,
        verified: false,
        state: "downloading",
        receivedBytes: 0,
        totalBytes: Number(size) || 0,
        destinationDir: destinationDir && path.isAbsolute(destinationDir) ? destinationDir : defaultDownloadDir,
        publishedPath: "",
        error: "",
        startedAt: new Date(now()).toISOString(),
        tempPath: "",
        onProgress,
      };
      task.tempPath = path.join(task.destinationDir, `.${task.id}.part`);
      fsp.mkdir(task.destinationDir, { recursive: true })
        .then(() => fsp.writeFile(task.tempPath, "", { flag: "wx" }))
        .then(() => run(task))
        .catch(async (error) => {
          await removeTemp(task);
          task.state = "failed";
          task.error = String(error?.message || error).slice(0, 300);
          task.onProgress?.(publicTask(task));
        });
      return { ok: true, task: publicTask(task) };
    },

    async cancel() {
      if (!task || task.state !== "downloading") return { cancelled: false };
      task.state = "cancelling";
      try { controller.abort(); } catch { /* already done */ }
      // Give the stream loop a moment to unwind and clean its temp file.
      for (let waited = 0; task.state === "cancelling" && waited < 5000; waited += 50) {
        await delay(50);
      }
      await removeTemp(task);
      return { cancelled: task.state === "cancelled" };
    },

    status() {
      return publicTask(task);
    },

    // A completed, digest-verified download can be revealed in the shell.
    revealTarget() {
      if (task?.state === "published" && task.verified && task.publishedPath) return task.publishedPath;
      return "";
    },
  };
}

// X (06:34 card item 0): resolve the default downloads root without
// letting a native path failure block startup. dir === null means the
// caller keeps downloads unavailable until the user picks a directory.
function resolveDownloadsRoot(getPath) {
  try {
    const dir = getPath("downloads");
    if (typeof dir === "string" && dir) return { dir: path.join(dir, "Knorvia"), error: null };
    return { dir: null, error: "downloads directory unavailable" };
  } catch (error) {
    return { dir: null, error: String(error?.message || error) };
  }
}

module.exports = { createUpdateDownloadManager, parseDigest, safeFileName, resolveDownloadsRoot };
