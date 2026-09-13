"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ScanSearch } from "lucide-react";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import {
  DUPLICATE_JACCARD_THRESHOLD,
  fetchAllMemoryRecords,
  findDuplicatePairs,
  mergeRequestForPair,
  type DuplicatePair,
} from "@/lib/native-memory-duplicates";
import type { MemoryRecord } from "./memory-types";
import "./memory-duplicates.css";

type Phase = "idle" | "scanning" | "ready" | "merging";

function sideLabel(record: MemoryRecord): string {
  const status = record.status === "active" ? "" : ` · ${record.status}`;
  return `v${record.revision}${status}`;
}

/**
 * Scope-wide duplicate tidy-up (B03): full pagination discovery, explainable
 * similarity, keeper choice with a preview of the real merge effect, then an
 * explicit execution guarded by BOTH revisions (source CAS since ever, target
 * CAS added this night). A conflict re-reads both records and re-arms the
 * preview instead of applying a stale merge.
 */
export function MemoryDuplicatesPanel({ scope, onChanged }: {
  scope: { owner: string; workspace?: string | null; bot?: string | null; conversation?: string | null };
  onChanged: () => void;
}) {
  const { t, request } = useWorkbench();
  const [phase, setPhase] = useState<Phase>("idle");
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [summary, setSummary] = useState<{ records: number; pages: number; total: number; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const [keepers, setKeepers] = useState<Record<string, "a" | "b">>({});
  const [conflicts, setConflicts] = useState<Record<string, string>>({});
  const [mergedIds, setMergedIds] = useState<Set<string>>(new Set());

  const scan = async () => {
    setPhase("scanning");
    setError("");
    setConflicts({});
    setMergedIds(new Set());
    try {
      const result = await fetchAllMemoryRecords({ scope, request });
      const found = findDuplicatePairs(result.records);
      setPairs(found);
      setSummary({ records: result.records.length, pages: result.pages, total: result.total, truncated: result.truncated });
      setKeepers(Object.fromEntries(found.map((pair, index) => [pairKey(pair, index), chooseKeeper(pair)])));
      setPhase("ready");
    } catch (cause) {
      setError(errorText(cause));
      setPhase("idle");
    }
  };

  const mergeOne = async (pair: DuplicatePair, index: number) => {
    const key = pairKey(pair, index);
    const keeperSide = keepers[key] ?? chooseKeeper(pair);
    const loser = keeperSide === "a" ? pair.b : pair.a;
    const keeper = keeperSide === "a" ? pair.a : pair.b;
    setPhase("merging");
    setError("");
    try {
      await request("memory/merge", { scope, ...mergeRequestForPair(loser, keeper) });
      setMergedIds(current => new Set(current).add(key));
      setConflicts(current => { const next = { ...current }; delete next[key]; return next; });
      onChanged();
    } catch (cause) {
      // A revision conflict means one side moved since the preview. Re-read
      // both records and surface the fresh state — never merge on stale data.
      const message = errorText(cause);
      const [freshLoser, freshKeeper] = await Promise.all([
        request<{ record: MemoryRecord | null }>("memory/get", { id: loser.id, scope }).catch(() => null),
        request<{ record: MemoryRecord | null }>("memory/get", { id: keeper.id, scope }).catch(() => null),
      ]);
      const freshA = freshLoser?.record?.id === pair.a.id ? freshLoser?.record : freshKeeper?.record;
      const freshB = freshA && freshLoser?.record?.id === pair.a.id ? freshKeeper?.record : freshLoser?.record;
      if (freshA) setPairs(current => current.map((entry, i) => i === index ? { ...entry, a: freshA } : entry));
      if (freshB) setPairs(current => current.map((entry, i) => i === index ? { ...entry, b: freshB! } : entry));
      setConflicts(current => ({ ...current, [key]: message }));
    } finally {
      setPhase("ready");
    }
  };

  const statusNote = useMemo(() => {
    if (!summary) return "";
    const base = t(
      `扫描了 ${summary.records}${summary.truncated ? "+" : ""}/${summary.total} 条记录（${summary.pages} 页，跨过旧版 200 条上限），发现 ${pairs.length} 组可解释相似候选（阈值 ${Math.round(DUPLICATE_JACCARD_THRESHOLD * 100)}%）。`,
      `Scanned ${summary.records}${summary.truncated ? "+" : ""}/${summary.total} records (${summary.pages} pages, beyond the old 200-row cap); ${pairs.length} explainable candidate pairs at ≥${Math.round(DUPLICATE_JACCARD_THRESHOLD * 100)}%.`,
    );
    return base;
  }, [summary, pairs.length, t]);

  return <section className="ht-memdup" aria-label={t("整理重复记忆", "Tidy duplicate memories")}>
    <div className="ht-memdup-toolbar">
      <button type="button" className="nw-button" disabled={phase === "scanning" || phase === "merging"} onClick={() => void scan()}>
        {phase === "scanning" ? <Loader2 size={15} className="nw-spin" /> : <ScanSearch size={15} />}
        {t("扫描当前范围内的重复记忆", "Scan this scope for duplicates")}
      </button>
      <span className="nw-help">{t("仅限当前范围的活动记录；不会调用任何模型。", "Active records in this scope only; no model calls.")}</span>
    </div>
    {phase === "scanning" && <p className="nw-help" role="status">{t("正在全量分页读取当前范围…", "Paging through the whole scope…")}</p>}
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
    {statusNote && <p className="nw-help" role="status">{statusNote}</p>}
    {summary?.truncated && <p className="nw-inline-error" role="alert">{t("扫描未覆盖全部记录（服务端分页未推进），结果可能不完整。", "The scan did not cover every record (server paging did not advance); results may be incomplete.")}</p>}
    <ul className="ht-memdup-pairs">
      {pairs.map((pair, index) => {
        const key = pairKey(pair, index);
        if (mergedIds.has(key)) return <li key={key} className="ht-memdup-pair is-merged"><CheckCircle2 size={15} /> {t("已合并：失败方现指向保留项，双方历史可在时间线查看。", "Merged: the loser now points at the keeper; both histories remain in the timeline.")}</li>;
        const keeperSide = keepers[key] ?? chooseKeeper(pair);
        const loser = keeperSide === "a" ? pair.b : pair.a;
        const keeper = keeperSide === "a" ? pair.a : pair.b;
        const conflict = conflicts[key];
        const loserInactive = loser.status !== "active" || keeper.status !== "active";
        return <li key={key} className="ht-memdup-pair">
          <div className="ht-memdup-explain">
            <strong>{pair.exact ? t("完全相同", "Identical after normalization") : t(`相似度 ${Math.round(pair.similarity * 100)}%`, `${Math.round(pair.similarity * 100)}% similar`)}</strong>
            {!pair.exact && pair.sharedTerms.length > 0 && <span>{t(`共享词：${pair.sharedTerms.join("、")}`, `Shared terms: ${pair.sharedTerms.join(", ")}`)}</span>}
          </div>
          <div className="ht-memdup-sides">
            {(["a", "b"] as const).map(side => {
              const record = side === "a" ? pair.a : pair.b;
              const isKeeper = keeperSide === side;
              return <div key={side} className={`ht-memdup-side${isKeeper ? " is-keeper" : ""}`}>
                <label className="ht-memdup-choose">
                  <input type="radio" name={key} checked={keeperSide === side} onChange={() => setKeepers(current => ({ ...current, [key]: side }))} />
                  <span>{isKeeper ? t("保留", "Keep") : t("并入", "Merge away")}</span>
                </label>
                <p>{record.content}</p>
                <footer>
                  <span>{sideLabel(record)}</span>
                  <span>{record.scope.workspace || "*"} · {record.scope.conversation || "*"}</span>
                  <span>{t(`来源 ${record.sourceRefs.length}`, `${record.sourceRefs.length} sources`)}</span>
                </footer>
              </div>;
            })}
          </div>
          <p className="ht-memdup-preview">
            {t(`执行后：保留「${keeper.content.slice(0, 40)}」正文不变；「${loser.content.slice(0, 40)}」标记为已合并并指向保留项，正文不被拼接；双方修改轨迹都保留，可通过时间线查看。`,
              `After execution: "${keeper.content.slice(0, 40)}" keeps its content untouched; "${loser.content.slice(0, 40)}" is marked merged pointing at the keeper (never concatenated); both histories stay queryable.`)}
            {t(`（以 source v${loser.revision} / target v${keeper.revision} 提交，目标变化将拒绝执行）`, ` (submitted against source v${loser.revision} / target v${keeper.revision}; a changed target refuses the merge)`)}
          </p>
          {conflict && <p className="nw-inline-error" role="alert"><AlertTriangle size={13} /> {t(`执行被拒绝：${messageOr(conflict)}。已重新读取最新版本，请确认后重试。`, `Rejected: ${messageOr(conflict)}. Fresh versions re-read; confirm before retrying.`)}</p>}
          <div className="ht-memdup-actions">
            <button type="button" className="nw-button nw-button-primary" disabled={phase === "merging" || loserInactive || !!conflict}
              title={loserInactive ? t("两侧都必须是活动记录才能合并", "Both sides must be active records") : undefined}
              onClick={() => void mergeOne(pair, index)}>
              {t(`合并：保留「${keeperSide}」，并入「${keeperSide === "a" ? "b" : "a"}」`, `Merge: keep ${keeperSide}, absorb ${keeperSide === "a" ? "b" : "a"}`)}
            </button>
            {conflict && <button type="button" className="nw-button" onClick={() => void mergeOne(pair, index)}>{t("用最新版本重试", "Retry with fresh versions")}</button>}
          </div>
        </li>;
      })}
    </ul>
    {phase === "ready" && pairs.length === 0 && <p className="nw-help">{t("这个范围没有发现可解释的重复候选。", "No explainable duplicate candidates in this scope.")}</p>}
  </section>;
}

const pairKey = (pair: DuplicatePair, index: number) => `${pair.a.id}~${pair.b.id}~${index}`;

/** Default keeper: the more evolved record (higher revision), then the older id for stability. */
function chooseKeeper(pair: DuplicatePair): "a" | "b" {
  if (pair.a.revision !== pair.b.revision) return pair.a.revision > pair.b.revision ? "a" : "b";
  return pair.a.id.localeCompare(pair.b.id) <= 0 ? "a" : "b";
}

function messageOr(message: string): string {
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}
