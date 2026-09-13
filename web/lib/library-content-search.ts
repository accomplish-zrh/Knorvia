/**
 * Library content-search pagination (B01).
 *
 * The backend returns `nextCursor` and per-index coverage, but a page-only
 * consumer shows the first 20 hits and drops the rest. This controller keeps
 * the full walk: cursor pagination with per-id dedupe, generation guards so a
 * stale response can never mix into a newer query, cancellation chaining, and
 * honest coverage flags — a partially indexed library must not present itself
 * as a complete "no matches".
 */

export type ContentHit = {
  id: string;
  path: string;
  name: string;
  sha256: string;
  totalLines: number;
  snippets: { line: number; text: string }[];
  stale?: boolean;
};

export type ContentCoverage = { indexed: number; tooLarge: number; unreadable: number };

export type ContentSearchPage = {
  hits: ContentHit[];
  nextCursor: number | string | null;
  coverage?: ContentCoverage;
  truncated?: boolean;
  aborted?: boolean;
  refreshAborted?: boolean;
};

export type ContentSearchRequest = (params: {
  query: string;
  limit: number;
  cursor?: number | string;
  requestId: string;
  cancelRequestId?: string;
}) => Promise<ContentSearchPage>;

export const CONTENT_PAGE_LIMIT = 20;
/** DOM bound: pagination stays honest about anything past this cap. */
export const CONTENT_HITS_CAP = 1000;

export type ContentSearchState = {
  query: string;
  hits: ContentHit[];
  hasMore: boolean;
  loading: boolean;
  error: string;
  coverage: ContentCoverage | null;
  /** The freshness sweep or a page walk stopped early: results may be incomplete. */
  partial: boolean;
  /** True once pagination reached the server cap (hits were dropped). */
  capped: boolean;
};

const initialState: ContentSearchState = {
  query: "", hits: [], hasMore: false, loading: false, error: "", coverage: null, partial: false, capped: false,
};

/** Server snapshot for useSyncExternalStore during SSR/hydration. */
export const EMPTY_CONTENT_SEARCH: ContentSearchState = initialState;

export class LibraryContentSearch {
  private state: ContentSearchState = initialState;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private requestId = 0;
  private lastRequestId: string | null = null;
  private cursor: number | string | null = null;
  private seen = new Set<string>();
  private loadingMore = false;

  constructor(private readonly requestPage: ContentSearchRequest, private readonly pageLimit = CONTENT_PAGE_LIMIT) {}

  getSnapshot = (): ContentSearchState => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(patch: Partial<ContentSearchState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Drop all state and cancel in-flight work without starting a new query. */
  reset() {
    this.generation += 1;
    this.lastRequestId = null;
    this.cursor = null;
    this.seen = new Set();
    this.loadingMore = false;
    this.publish({ ...initialState });
  }

  /** Reset to a fresh query, cancelling whatever request is still in flight. */
  begin(query: string) {
    const generation = ++this.generation;
    const cancelRequestId = this.lastRequestId ?? undefined;
    this.lastRequestId = null;
    this.cursor = null;
    this.seen = new Set();
    this.loadingMore = false;
    const trimmed = query.trim();
    if (!trimmed) {
      this.publish({ ...initialState });
      return;
    }
    this.publish({ query: trimmed, hits: [], hasMore: false, loading: true, error: "", coverage: null, partial: false, capped: false });
    const requestId = `content-search-${++this.requestId}`;
    this.lastRequestId = requestId;
    this.requestPage({ query: trimmed, limit: this.pageLimit, requestId, cancelRequestId }).then(
      page => {
        if (generation !== this.generation) return;
        this.lastRequestId = null;
        this.applyPage(page, generation);
      },
      error => {
        if (generation !== this.generation) return;
        this.lastRequestId = null;
        this.publish({ loading: false, hasMore: false, error: error instanceof Error ? error.message : String(error) });
      },
    );
  }

  /** Fetch the next page for the current query; concurrent calls are ignored. */
  more() {
    const generation = this.generation;
    if (this.loadingMore || !this.state.hasMore || this.state.capped || this.cursor === null || this.state.loading) return;
    this.loadingMore = true;
    this.publish({ error: "" });
    const requestId = `content-search-${++this.requestId}`;
    this.lastRequestId = requestId;
    this.requestPage({ query: this.state.query, limit: this.pageLimit, cursor: this.cursor, requestId }).then(
      page => {
        this.loadingMore = false;
        if (generation !== this.generation) return;
        this.applyPage(page, generation);
      },
      error => {
        this.loadingMore = false;
        if (generation !== this.generation) return;
        this.publish({ error: error instanceof Error ? error.message : String(error) });
      },
    );
  }

  private applyPage(page: ContentSearchPage, generation: number) {
    if (generation !== this.generation) return;
    const fresh = (page.hits ?? []).filter(hit => hit && typeof hit.id === "string" && !this.seen.has(hit.id));
    for (const hit of fresh) this.seen.add(hit.id);
    const hits = [...this.state.hits, ...fresh];
    const capped = hits.length >= CONTENT_HITS_CAP;
    const keptHits = capped ? hits.slice(0, CONTENT_HITS_CAP) : hits;
    // A cursor that repeats cannot advance the walk; treat it as exhaustion
    // instead of letting "load more" loop forever.
    const advanced = page.nextCursor !== null && page.nextCursor !== undefined && page.nextCursor !== this.cursor;
    this.cursor = advanced ? page.nextCursor : null;
    this.publish({
      hits: keptHits,
      hasMore: Boolean(advanced) && !capped,
      loading: false,
      coverage: page.coverage ?? this.state.coverage,
      // An aborted page walk or an aborted freshness sweep both mean the
      // library was not fully searched.
      partial: this.state.partial || page.aborted === true || page.refreshAborted === true,
      capped,
    });
  }
}
