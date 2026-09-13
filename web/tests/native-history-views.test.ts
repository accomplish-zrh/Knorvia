import test from "node:test";
import assert from "node:assert/strict";
import { parseHistoryViews, upsertHistoryView, removeHistoryView, readViewIdFromSearch, viewSearch, parseLocation, HISTORY_VIEWS_LIMIT, type HistoryViewConfig } from "../lib/native-history-views";

const view = (overrides: Partial<HistoryViewConfig> = {}): HistoryViewConfig => ({
  id: "v1", name: "项目A最近的失败", filter: "attention", projectId: "w-a", dateRange: "7d", query: "",
  visible: 50, createdAt: 1, updatedAt: 1, ...overrides,
});

test("named views persist filter combinations and are validated and capped", () => {
  const many = Array.from({ length: HISTORY_VIEWS_LIMIT + 5 }, (_, index) => view({ id: `v${index}`, name: `视图 ${index}` }));
  const parsed = parseHistoryViews(JSON.stringify(many));
  assert.equal(parsed.length, HISTORY_VIEWS_LIMIT);
  assert.deepEqual(parseHistoryViews("junk"), []);
  assert.equal(parseHistoryViews(JSON.stringify([view({ filter: "bogus" as HistoryViewConfig["filter"] }), view({ name: "" }), view({ query: "x".repeat(300) })])).length, 0);
  assert.equal(parseHistoryViews(JSON.stringify([view(), view()])).length, 1);
});

test("upsert updates in place; remove never disturbs other views", () => {
  let views = [view(), view({ id: "v2", name: "待处理" })];
  views = upsertHistoryView(views, view({ id: "v1", name: "项目A最近的失败（更新）" }));
  assert.equal(views.find(item => item.id === "v1")?.name, "项目A最近的失败（更新）");
  assert.equal(views.length, 2);
  views = removeHistoryView(views, "v2");
  assert.deepEqual(views.map(item => item.id), ["v1"]);
});

test("URL carries only the view id; hostile params are ignored", () => {
  assert.equal(readViewIdFromSearch("?view=abc_1"), "abc_1");
  assert.equal(readViewIdFromSearch("?view=<script>"), null);
  assert.equal(readViewIdFromSearch("?other=1"), null);
  assert.equal(viewSearch("abc_1"), "?view=abc_1");
  assert.equal(viewSearch(null), "");
});

test("the browsing location snapshot validates shapes and restores sane bounds", () => {
  assert.deepEqual(parseLocation(JSON.stringify({ viewId: "v1", filter: "running", projectId: "w-a", dateRange: "30d", query: "api", visible: 150 })),
    { viewId: "v1", filter: "running", projectId: "w-a", dateRange: "30d", query: "api", visible: 150 });
  const clamped = parseLocation(JSON.stringify({ filter: "all", dateRange: "anytime", visible: 100000 }));
  assert.equal(clamped?.visible, 50);
  assert.equal(clamped?.viewId, null);
  assert.equal(parseLocation("junk"), null);
});

test("history locations retain bounded source anchors and explicit failed filters", () => {
  const saved = parseLocation(JSON.stringify({ viewId: 'v1', filter: 'failed', projectId: 'w-a', dateRange: '7d', query: '', visible: 650, anchor: { threadId: 'thread-600', offset: -12 }, scrollTop: 30000 }));
  assert.equal(saved?.visible, 650);
  assert.deepEqual(saved?.anchor, { threadId: 'thread-600', offset: -12 });
  assert.equal(saved?.scrollTop, 30000);
  const invalid = parseLocation(JSON.stringify({ filter: 'all', dateRange: 'anytime', anchor: { threadId: 'x', offset: 1e20 }, scrollTop: -3 }));
  assert.equal(invalid?.anchor, undefined);
  assert.equal(invalid?.scrollTop, undefined);
  assert.equal(readViewIdFromSearch('?view=a&view=b'), null);
});
