"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import {
  describeCompleteness,
  fetchAllUsageRecords,
  fetchUsageLedgerPage,
  isUsageIndexBuilding,
  isUsageSnapshotRestartError,
  ledgerCsv,
  LEDGER_PAGE_SIZE,
  type UsageLedgerRecord,
} from "@/lib/native-usage-ledger";
import "./usage-ledger.css";

function fmt(value: number) {
  return value.toLocaleString();
}

/**
 * Per-turn usage ledger (B04). The ledger pages the daemon's detail records
 * independently of the aggregate summary: changing pages never re-requests
 * (or changes) the totals, and fast filter switches drop stale responses via
 * a generation guard.
 */
export function UsageLedger({ params, utc }: { params: Record<string, unknown>; utc: boolean }) {
  const { request, t, connection } = useWorkbench();
  const [records, setRecords] = useState<UsageLedgerRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [building, setBuilding] = useState(false);
  const [ready, setReady] = useState(false);
  const [restartNotice, setRestartNotice] = useState("");
  const [retryVersion, setRetryVersion] = useState(0);
  const generation = useRef(0);
  const paging = useRef<{ params: Record<string, unknown>; snapshot?: string; generation?: string }>({ params });
  // Filter changes reset to the first page; page changes keep the filters.
  useEffect(() => {
    paging.current = { params };
    setOffset(0);
    setRecords([]);
    setTotal(0);
    setReady(false);
    setBuilding(false);
    setRestartNotice("");
  }, [params]);

  useEffect(() => {
    if (connection !== "connected") return;
    const cursor = paging.current;
    // A filter reset from a later page commits offset=0 on the next render.
    // Never issue that transient offset with no snapshot.
    if (cursor.params !== params || (offset > 0 && !cursor.snapshot)) return;
    const current = ++generation.current;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError("");
    void fetchUsageLedgerPage({
      request, params, offset, limit: LEDGER_PAGE_SIZE,
      snapshot: cursor.snapshot, generation: cursor.generation,
    })
      .then(page => {
        if (current !== generation.current) return;
        paging.current = { params, snapshot: page.snapshot, generation: page.generation };
        setRecords(page.records);
        setTotal(page.total);
        setReady(true);
        setBuilding(false);
      })
      .catch(cause => {
        if (current !== generation.current) return;
        if (isUsageIndexBuilding(cause)) {
          setBuilding(true);
          setReady(false);
          setRecords([]);
          setTotal(0);
          retryTimer = setTimeout(() => {
            if (current === generation.current) setRetryVersion(value => value + 1);
          }, 400);
          return;
        }
        if (cursor.snapshot && isUsageSnapshotRestartError(cause)) {
          paging.current = { params };
          setRecords([]);
          setTotal(0);
          setReady(false);
          setBuilding(false);
          setRestartNotice(t("账本快照已过期，已从第 1 页重新读取。", "The ledger snapshot expired, so paging restarted from page 1."));
          if (offset === 0) setRetryVersion(value => value + 1);
          else setOffset(0);
          return;
        }
        setBuilding(false);
        setError(errorText(cause));
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => {
      generation.current += 1;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [request, params, offset, connection, retryVersion, t]);

  const exportAll = useCallback(async () => {
    if (connection !== "connected") return;
    setExporting(true);
    setError("");
    try {
      const walk = await fetchAllUsageRecords({ request, params });
      if (walk.truncated) throw new Error(t(`明细超过安全页数上限，导出被拒绝（已读 ${walk.records.length}/${walk.total} 条）。`, `The detail set exceeds the page safety bound; export refused (${walk.records.length}/${walk.total} read).`));
      if (walk.restarts > 0) {
        setRestartNotice(t("导出时原快照已过期，已从第 1 页重新读取完整账本。", "The original export snapshot expired, so the complete ledger was reread from page 1."));
      }
      const body = ledgerCsv({ records: walk.records, appliedFilters: params, utc });
      const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `knorvia-usage-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setExporting(false);
    }
  }, [request, params, utc, t, connection]);

  const page = ready && total > 0 ? Math.floor(offset / LEDGER_PAGE_SIZE) + 1 : 0;
  const pages = Math.max(1, Math.ceil(total / LEDGER_PAGE_SIZE));
  return <section className="nw-preference-section ht-ledger" aria-label={t("逐回合用量账本", "Per-turn usage ledger")}>
    <h2>{t("逐回合账本", "Per-turn ledger")}</h2>
    <div className="ht-ledger-toolbar">
      <span className="nw-help">{building
        ? t("用量索引正在构建，可靠总数暂不可用。", "The usage index is being built; a reliable total is not available yet.")
        : ready
          ? t(`共 ${fmt(total)} 条明细；每页 ${LEDGER_PAGE_SIZE} 条。汇总数字与账本分页相互独立，换页不会改变汇总。`,
            `${fmt(total)} detail records, ${LEDGER_PAGE_SIZE} per page. The aggregate above is independent of ledger paging.`)
          : t("正在读取账本总数…", "Loading the ledger total…")}</span>
      <button type="button" className="nw-button" disabled={exporting || loading || building || !ready || total === 0} onClick={() => void exportAll()}>
        {exporting ? <Loader2 size={14} className="nw-spin" /> : <Download size={14} />}
        {t("导出全部筛选明细 (CSV)", "Export all filtered rows (CSV)")}
      </button>
    </div>
    {restartNotice && <p className="nw-help" role="status">{restartNotice}</p>}
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
    <div className="nw-usage-table-scroll" role="region" tabIndex={0} aria-label={t("逐回合明细", "Per-turn details")}>
      <table className="nw-usage-table ht-ledger-table">
        <caption className="nw-visually-hidden">{t("逐回合用量明细", "Per-turn usage details")}</caption>
        <thead><tr>
          <th scope="col">{t("时间", "Time")}</th>
          <th scope="col">{t("任务", "Task")}</th>
          <th scope="col">{t("状态", "Status")}</th>
          <th scope="col">{t("模型", "Model")}</th>
          <th scope="col">{t("提供商", "Provider")}</th>
          <th scope="col" className="nw-num">{t("输入", "Input")}</th>
          <th scope="col" className="nw-num">{t("输出", "Output")}</th>
          <th scope="col" className="nw-num">{t("总量", "Total")}</th>
          <th scope="col">{t("用量口径", "Completeness")}</th>
        </tr></thead>
        <tbody>
          {records.map(record => {
            const completeness = describeCompleteness(record);
            return <tr key={`${record.threadId}/${record.turnId}/${record.recordedAtMs}`}>
              <td>{new Date(record.recordedAtMs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
              <td><a className="ht-ledger-task" href={`/workbench/task/${encodeURIComponent(record.threadId)}`}>{t("打开", "Open")}</a></td>
              <td>{record.turnStatus}</td>
              <td title={record.model}>{record.model}</td>
              <td title={record.providerId}>{record.providerId}</td>
              <td className="nw-num">{fmt(record.inputTokens)}</td>
              <td className="nw-num">{fmt(record.outputTokens)}</td>
              <td className="nw-num">{fmt(record.totalTokens)}</td>
              <td><span className={`ht-ledger-badge is-${completeness.kind}`}>{t(completeness.zh, completeness.en)}</span></td>
            </tr>;
          })}
          {records.length === 0 && ready && !loading && <tr><td colSpan={9}>{t("当前筛选没有明细记录。", "No detail records for this filter.")}</td></tr>}
        </tbody>
      </table>
      {loading && <p className="nw-help" role="status"><Loader2 size={13} className="nw-spin" /> {t("正在读取明细…", "Loading details…")}</p>}
      {building && !loading && <p className="nw-help" role="status"><Loader2 size={13} className="nw-spin" /> {t("正在建立用量索引…", "Building the usage index…")}</p>}
    </div>
    <div className="ht-ledger-paging" role="navigation" aria-label={t("账本分页", "Ledger paging")}>
      <button type="button" className="nw-button nw-button-small" disabled={loading || building || !ready || offset === 0} onClick={() => { setRestartNotice(""); setOffset(Math.max(0, offset - LEDGER_PAGE_SIZE)); }}>{t("上一页", "Previous")}</button>
      <span>{ready ? `${page} / ${pages}` : "— / —"}</span>
      <button type="button" className="nw-button nw-button-small" disabled={loading || building || !ready || offset + LEDGER_PAGE_SIZE >= total} onClick={() => { setRestartNotice(""); setOffset(offset + LEDGER_PAGE_SIZE); }}>{t("下一页", "Next")}</button>
    </div>
  </section>;
}
