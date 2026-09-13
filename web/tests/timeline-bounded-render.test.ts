import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const timelinePath = path.join(process.cwd(), "components", "native", "TaskTimeline.tsx");

test("TaskTimeline keeps memo boundaries so live updates stay bounded", () => {
  const source = fs.readFileSync(timelinePath, "utf8");
  // The memoised markdown renderer now lives in NativeMathMarkdown (shared
  // with the math pipeline); the memo boundary itself is unchanged.
  const markdownSource = fs.readFileSync(path.join(process.cwd(), "components", "native", "NativeMathMarkdown.tsx"), "utf8");
  assert.match(markdownSource, /const MarkdownContent = memo\(/, "markdown parse is memoised");
  assert.match(markdownSource, /before\.text === after\.text/, "markdown memo compares text");
  assert.match(source, /const AgentMessageRow = memo\(/, "agent rows are memoised");
  assert.match(source, /const UserMessageRow = memo\(/, "user rows are memoised");
  assert.match(source, /const ToolRow = memo\(/, "tool rows are memoised");
  assert.match(source, /before\.item === after\.item/, "rows compare item identity");
  // Stable callbacks keep memoisation effective across live updates.
  assert.match(source, /const onCopy = useCallback\(/);
  assert.match(source, /const onSave = useCallback\(/);
  assert.match(source, /threadRef\.current = thread/, "live thread read through a ref");
  // Collapsed heavy details defer their bodies until first open.
  assert.match(source, /function LazyDetails\(/);
  assert.match(source, /revealed \? children : null/);
  assert.match(source, /LazyDetails className="nw-tool"/, "command/tool bodies are lazy");
});

test("content-visibility CSS keeps off-screen timeline rows cheap", () => {
  const cssPath = path.join(process.cwd(), "components", "native", "workbench.css");
  const css = fs.readFileSync(cssPath, "utf8");
  assert.match(css, /\.nw-agent-message, \.nw-user-message[^\n]*\{ content-visibility: auto; contain-intrinsic-size: auto 96px; \}/);
});

test("the P07 perf harness exists and measures real Chrome against a mocked gateway", () => {
  const harnessPath = path.join(process.cwd(), "tests", "fixtures", "timeline-perf", "run-timeline-perf.mjs");
  const harness = fs.readFileSync(harnessPath, "utf8");
  assert.match(harness, /routeWebSocket/, "WebSocket is intercepted (no daemon needed)");
  assert.match(harness, /agentMessage\.delta/, "live streaming is exercised");
  assert.match(harness, /typing/, "input latency is recorded");
  assert.match(harness, /domNodes/, "DOM size is recorded");
});
