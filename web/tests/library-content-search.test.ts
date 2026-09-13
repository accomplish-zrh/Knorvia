import test from "node:test";
import assert from "node:assert/strict";
import { LibraryContentSearch, CONTENT_HITS_CAP, type ContentSearchPage } from "../lib/library-content-search";

const hit = (id: string, path = `notes/${id}.md`) => ({ id, path, name: `${id}.md`, sha256: `sha-${id}`, totalLines: 3, snippets: [{ line: 1, text: `match in ${id}` }] });

const pageOf = (ids: string[], nextCursor: number | null, extra: Partial<ContentSearchPage> = {}): ContentSearchPage => ({
  hits: ids.map(id => hit(id)), nextCursor, coverage: { indexed: 10, tooLarge: 0, unreadable: 0 }, ...extra,
});

const controller = (pages: ContentSearchPage[], log: { requests: Record<string, unknown>[] } = { requests: [] }) => {
  const queue = [...pages];
  const search = new LibraryContentSearch(async params => {
    log.requests.push(params);
    return queue.shift() ?? { hits: [], nextCursor: null };
  });
  return search;
};

test("pagination walks every page, dedupes by id, and stops when the cursor repeats or ends", async () => {
  const log = { requests: [] as Record<string, unknown>[] };
  const search = controller([pageOf(["a", "b"], 2), pageOf(["b", "c"], 4), pageOf(["c"], 5), pageOf(["d"], null)], log);
  const seen: string[][] = [];
  search.subscribe(() => seen.push(search.getSnapshot().hits.map(item => item.id)));
  search.begin("keyword");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(search.getSnapshot().hits.map(item => item.id), ["a", "b"]);
  assert.equal(search.getSnapshot().hasMore, true);
  search.more();
  await new Promise(resolve => setTimeout(resolve, 0));
  search.more();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(search.getSnapshot().hits.map(item => item.id), ["a", "b", "c"]);
  search.more();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(search.getSnapshot().hits.map(item => item.id), ["a", "b", "c", "d"]);
  assert.equal(search.getSnapshot().hasMore, false);
  assert.equal(search.getSnapshot().loading, false);
});

test("a newer query discards the older query's page and cancels it by request id", async () => {
  const log = { requests: [] as Record<string, unknown>[] };
  let releaseFirst: (page: ContentSearchPage) => void = () => {};
  const first = new Promise<ContentSearchPage>(resolve => { releaseFirst = resolve; });
  let call = 0;
  const search = new LibraryContentSearch(async params => {
    log.requests.push(params);
    return ++call === 1 ? first : pageOf(["new"], null);
  });
  search.begin("slow");
  search.begin("fast");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(search.getSnapshot().hits.map(item => item.id), ["new"]);
  assert.equal(search.getSnapshot().query, "fast");
  // The slow query resolves late with stale results — they must be dropped.
  releaseFirst(pageOf(["stale-1", "stale-2"], 2));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(search.getSnapshot().hits.map(item => item.id), ["new"]);
  assert.equal(log.requests[1].cancelRequestId, log.requests[0].requestId);
});

test("an aborted walk or freshness sweep marks results partial instead of complete", async () => {
  const search = controller([pageOf(["a"], null, { refreshAborted: true })]);
  search.begin("keyword");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(search.getSnapshot().partial, true);

  const abortedWalk = controller([pageOf(["a"], null, { aborted: true })]);
  abortedWalk.begin("keyword");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(abortedWalk.getSnapshot().partial, true);

  const complete = controller([pageOf(["a"], null)]);
  complete.begin("keyword");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(complete.getSnapshot().partial, false);
});

test("a failed page keeps earlier hits and reports the error instead of faking success", async () => {
  const search = new LibraryContentSearch(async () => { throw new Error("library busy"); });
  search.begin("keyword");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(search.getSnapshot().error, "library busy");
  assert.equal(search.getSnapshot().hasMore, false);
});

test("repeated cursors exhaust pagination rather than looping", async () => {
  const search = new LibraryContentSearch(async () => pageOf(["a"], 2));
  search.begin("keyword");
  await new Promise(resolve => setTimeout(resolve, 0));
  for (let round = 0; round < 5; round++) {
    search.more();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.deepEqual(search.getSnapshot().hits.map(item => item.id), ["a"]);
  assert.equal(search.getSnapshot().hasMore, false);
});

test("the display cap bounds the walk and is reported honestly", async () => {
  let offset = 0;
  const search = new LibraryContentSearch(async () => {
    const ids = Array.from({ length: 400 }, (_, index) => `file-${offset + index}`);
    offset += 400;
    return pageOf(ids, offset < 3000 ? offset : null);
  }, 400);
  search.begin("keyword");
  await new Promise(resolve => setTimeout(resolve, 0));
  while (search.getSnapshot().hasMore) {
    search.more();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(search.getSnapshot().hits.length, CONTENT_HITS_CAP);
  assert.equal(search.getSnapshot().capped, true);
  assert.equal(search.getSnapshot().hasMore, false);
});

test("reset clears everything and a fresh query after reset works", async () => {
  const log = { requests: [] as Record<string, unknown>[] };
  const search = controller([pageOf(["a"], null), pageOf(["b"], null)], log);
  search.begin("first");
  await new Promise(resolve => setTimeout(resolve, 0));
  search.reset();
  assert.deepEqual(search.getSnapshot().hits, []);
  assert.equal(search.getSnapshot().query, "");
  search.begin("second");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(search.getSnapshot().hits.map(item => item.id), ["b"]);
});
