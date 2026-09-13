"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Download, Gauge, Loader2, RefreshCw, SlidersHorizontal, Upload } from "lucide-react";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { PRICE_TABLE_STORAGE_KEY, estimateDatedRows, parsePriceTable, type PriceTable } from "@/lib/usage-prices";

import { usageCsv, type UsageExportRow } from "@/lib/usage-export";
import { dayStartToMs, fetchUsageSummaryWithIndexRetry } from "@/lib/native-usage-ledger";
import { UsageLedger } from "./UsageLedger";
import "./usage-ledger.css";
import "./usage.css";

interface UsageTotals {
  turns: number;
  knownTurns: number;
  partialTurns: number;
  unknownTurns: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

interface MediaUsageRow {
  providerId: string;
  model: string;
  jobs: number;
  unknownAttempts: number;
  units: Record<string, number>;
}

interface UsageSummary {
  billingRows?: UsageExportRow[];
  filterOptions?: { bots: Array<{ id: string; name: string }>; conversations: Array<{ id: string; title: string; kind: string }> };
  totals: UsageTotals;
  cache?: {
    knownTurns: number;
    unknownTurns: number;
    knownWriteTurns?: number;
    unknownWriteTurns?: number;
    fullyKnownTurns?: number;
    knownUncachedInputTokens?: number;
    knownInputTokens: number;
    knownCachedInputTokens: number;
    knownCacheWriteInputTokens: number;
    hitRatio: number | null;
  };
  byAgentRole?: Array<UsageTotals & { role: 'main' | 'subAgent' }>;
  byModel: Array<{ model: string; turns: number; inputTokens: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningOutputTokens?: number; outputTokens: number; totalTokens: number }>;
  byDay: Array<{ day: string; turns: number; totalTokens: number }>;
  byProvider?: Array<{ providerId: string; turns: number; totalTokens: number }>;
  appliedFilters?: Record<string, unknown>;
  media?: { jobsScanned: number; unknownJobs: number; byProvider: MediaUsageRow[]; note: string };
  paging: { offset: number; limit: number; total: number; snapshot: string; generation: string };
  notes: string[];
}

const RANGES = [
  { id: "today", zh: "今天", en: "Today", days: 0 },
  { id: "7d", zh: "7 天", en: "7 days", days: 7 },
  { id: "all", zh: "全部", en: "All time", days: -1 },
] as const;

function fmt(value: number) {
  return value.toLocaleString();
}

function dayStartMs(now: Date, daysBack: number, utc: boolean) {
  return utc ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysBack)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).getTime();
}

function downloadSummary(summary: UsageSummary, csv: boolean) {
  const body = csv ? usageCsv(summary.billingRows ?? [], summary.appliedFilters) : JSON.stringify(summary, null, 2);
  const url = URL.createObjectURL(new Blob([body], { type: csv ? 'text/csv;charset=utf-8' : 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `knorvia-usage-${new Date().toISOString().slice(0, 10)}.${csv ? 'csv' : 'json'}`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TrendBar({ row, max }: { row: { day: string; totalTokens: number }; max: number }) {
  const width = max > 0 && row.totalTokens > 0 ? Math.max(2, Math.round((row.totalTokens / max) * 100)) : 0;
  return <div className="nw-usage-trend-row">
    <span className="nw-usage-trend-day">{row.day.slice(5)}</span>
    <span className="nw-usage-trend-track" role="presentation"><span className="nw-usage-trend-fill" style={{ width: `${width}%` }} /></span>
    <span className="nw-usage-trend-value">{fmt(row.totalTokens)}</span>
  </div>;
}

export function UsageSettings() {
  const { request, t, connection, workspaces, connectionInfo } = useWorkbench();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [model, setModel] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [provider, setProvider] = useState('');
  const [bot, setBot] = useState('');
  const [conversation, setConversation] = useState('');
  const [conversationKind, setConversationKind] = useState('');
  const [thread, setThread] = useState('');
  const [utc, setUtc] = useState(false);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [knownModels, setKnownModels] = useState<string[]>([]);
  const [mediaProfiles, setMediaProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [knownProviders, setKnownProviders] = useState<string[]>([]);
  const [priceTable, setPriceTable] = useState<PriceTable | null>(null);
  const [indexBuilding, setIndexBuilding] = useState(false);
  const generation = useRef(0);
  const retryAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PRICE_TABLE_STORAGE_KEY);
      if (stored) setPriceTable(parsePriceTable(stored));
    } catch {
      // storage unavailable: estimation simply stays unknown
    }
  }, []);
  useEffect(() => {
    if (connection !== 'connected') return;
    let active = true;
    void request<{ profiles: Array<{ id: string; name: string }> }>('studio/models')
      .then(value => { if (active) setMediaProfiles(value.profiles); }).catch(() => {});
    return () => { active = false; };
  }, [connection, request]);

  // One filter object drives both the aggregate summary and the per-turn
  // ledger, so a page change in the ledger never alters these numbers.
  const summaryParams = useMemo((): Record<string, unknown> => {
    const now = new Date();
    const params: Record<string, unknown> = { toMs: now.getTime(), timezoneOffsetMinutes: utc ? 0 : now.getTimezoneOffset(),
      ...(model ? { model } : {}), ...(provider ? { providerId: provider } : {}), ...(workspace ? { workspaceId: workspace } : {}),
      ...(bot ? { botId: bot } : {}), ...(conversation ? { conversationId: conversation } : {}),
      ...(conversationKind ? { conversationKind } : {}), ...(thread ? { threadId: thread } : {}) };
    const fromMs = customFrom ? dayStartToMs(customFrom, utc) : NaN;
    const toMs = customTo ? dayStartToMs(customTo, utc, true) : NaN;
    if (Number.isFinite(fromMs)) params.fromMs = fromMs;
    if (Number.isFinite(toMs)) params.toMs = toMs;
    if (!Number.isFinite(fromMs) && !Number.isFinite(toMs)) {
      if (range === "today") params.fromMs = dayStartMs(now, 0, utc);
      if (range === "7d") params.fromMs = dayStartMs(now, 6, utc);
    }
    return params;
  }, [range, utc, customFrom, customTo, model, provider, workspace, bot, conversation, conversationKind, thread]);

  const load = useCallback(async () => {
    retryAbort.current?.abort();
    const controller = new AbortController();
    retryAbort.current = controller;
    const current = ++generation.current;
    setLoading(true); setError("");
    try {
      const params = summaryParams;
      const value = await fetchUsageSummaryWithIndexRetry<UsageSummary>({
        request, params, signal: controller.signal,
        onBuilding: () => {
          if (current !== generation.current) return;
          setSummary(null);
          setIndexBuilding(true);
          setError("");
        },
      });
      if (current !== generation.current) return;
      setSummary(value);
      setIndexBuilding(false);
      setKnownModels(previous => [...new Set([...previous, ...value.byModel.map(row => row.model), ...(value.media?.byProvider ?? []).map(row => row.model)])].sort());
      setKnownProviders(previous => [...new Set([...previous, ...(value.byProvider ?? []).map(row => row.providerId), ...(value.media?.byProvider ?? []).map(row => row.providerId)])]);
    } catch (cause) {
      if (current !== generation.current) return;
      setIndexBuilding(false);
      setError(errorText(cause));
    } finally {
      if (retryAbort.current === controller) retryAbort.current = null;
      if (current === generation.current) setLoading(false);
    }
  }, [request, summaryParams]);

  // Child effects run before the provider creates the client, so gate the
  // first load on the workbench connection actually being established.
  useEffect(() => {
    if (connection === "connected") void load();
    return () => {
      generation.current += 1;
      retryAbort.current?.abort();
      retryAbort.current = null;
    };
  }, [connection, load]);

  const totals = summary?.totals;
  const filterCount = [model, workspace, provider, bot, conversation, conversationKind, thread].filter(Boolean).length;
  const maxDay = Math.max(0, ...(summary?.byDay ?? []).map(row => row.totalTokens));
  const providerNames = new Map([...(connectionInfo?.providers ?? []), ...mediaProfiles].map(profile => [profile.id, profile.name]));
  providerNames.set('knorvia', t('历史连接', 'Historical connection'));
  for (const id of knownProviders) if (!providerNames.has(id)) providerNames.set(id, t(`历史连接 · ${id.slice(0, 8)}`, `Historical connection · ${id.slice(0, 8)}`));

  return <div className="nw-usage-panel" aria-busy={loading}>
    <div className="nw-usage-toolbar nw-usage-overview-toolbar">
      <div className="nw-usage-range-group" role="group" aria-label={t("时间范围", "Time range")}>{RANGES.map(item => <button key={item.id} className={`nw-usage-range${range === item.id ? " is-active" : ""}`} aria-pressed={range === item.id} onClick={() => setRange(item.id)}>{t(item.zh, item.en)}</button>)}</div>
      <button className="nw-button" onClick={() => void load()} disabled={loading || connection !== 'connected'}>{loading ? <Loader2 className="nw-spin" size={15} /> : <RefreshCw size={15} />}{t("刷新", "Refresh")}</button>
    </div>
    <details className="nw-usage-filter-panel">
      <summary><SlidersHorizontal size={15} aria-hidden="true" /><span>{t('筛选用量', 'Filter usage')}</span><small>{filterCount ? t(`${filterCount} 项已选`, `${filterCount} active`) : t('模型、项目与会话', 'Models, projects and conversations')}</small><ChevronDown size={15} aria-hidden="true" /></summary>
      <div className="nw-usage-filters">
      <label><span>{t('模型', 'Model')}</span><select aria-label={t('筛选模型', 'Filter model')} value={model} onChange={event => setModel(event.target.value)}><option value="">{t('全部模型', 'All models')}</option>{knownModels.map(value => <option key={value}>{value}</option>)}</select></label>
      <label><span>{t('项目', 'Project')}</span><select aria-label={t('筛选项目', 'Filter project')} value={workspace} onChange={event => setWorkspace(event.target.value)}><option value="">{t('全部项目', 'All projects')}</option>{workspaces.map(value => <option value={value.id} key={value.id}>{value.title}</option>)}</select></label>
      <label><span>{t('提供商', 'Provider')}</span><select aria-label={t('筛选提供商', 'Filter provider')} value={provider} onChange={event => setProvider(event.target.value)}><option value="">{t('全部提供商', 'All providers')}</option>{[...providerNames].map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
      <label><span>{t('Bot', 'Bot')}</span><select aria-label={t('筛选 Bot', 'Filter Bot')} value={bot} onChange={event => setBot(event.target.value)}><option value="">{t('全部 Bot', 'All Bots')}</option>{summary?.filterOptions?.bots.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
      <label><span>{t('会话类型', 'Conversation type')}</span><select aria-label={t('会话类型', 'Conversation type')} value={conversationKind} onChange={event => { setConversationKind(event.target.value); setConversation(''); }}><option value="">{t('群聊与私聊', 'Groups and DMs')}</option><option value="group">{t('群聊', 'Groups')}</option><option value="dm">{t('私聊', 'DMs')}</option></select></label>
      <label><span>{t('会话', 'Conversation')}</span><select aria-label={t('筛选会话', 'Filter conversation')} value={conversation} onChange={event => setConversation(event.target.value)}><option value="">{t('全部会话', 'All conversations')}</option>{summary?.filterOptions?.conversations.filter(value => !conversationKind || value.kind === conversationKind).map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</select></label>
      <label><span>{t('任务 ID', 'Task ID')}</span><input aria-label={t('筛选任务 ID', 'Filter task ID')} placeholder={t('任务 ID（可选）', 'Task ID (optional)')} value={thread} onChange={event => setThread(event.target.value.trim())} maxLength={256} /></label>
      <label className="nw-usage-custom-range"><span>{t('自定义起止', 'Custom range')}</span>
        <input type="date" aria-label={t('开始日期', 'Start date')} value={customFrom} onChange={event => setCustomFrom(event.target.value)} />
        <span>–</span>
        <input type="date" aria-label={t('结束日期', 'End date')} value={customTo} onChange={event => setCustomTo(event.target.value)} />
        {(customFrom || customTo) && <button type="button" className="nw-button nw-button-small" onClick={() => { setCustomFrom(''); setCustomTo(''); }}>{t('清除', 'Clear')}</button>}
      </label>
      <label><span>{t('统计时区', 'Reporting timezone')}</span><select aria-label={t('统计时区', 'Reporting timezone')} value={utc ? 'utc' : 'local'} onChange={event => setUtc(event.target.value === 'utc')}><option value="local">{t('本地时间', 'Local time')}</option><option value="utc">{t('UTC', 'UTC')}</option></select></label>
      </div>
      {filterCount > 0 && <div className="nw-usage-filter-footer"><button type="button" className="nw-button nw-button-small" onClick={() => { setModel(''); setWorkspace(''); setProvider(''); setBot(''); setConversation(''); setConversationKind(''); setThread(''); setCustomFrom(''); setCustomTo(''); }}>{t('清除筛选', 'Clear filters')}</button></div>}
    </details>
    <div className="nw-usage-export-actions">
      <span>{t('导出当前范围', 'Export this range')}</span>
      <button className="nw-button" disabled={!summary?.billingRows || loading || !!error} onClick={() => summary && downloadSummary(summary, true)}><Download size={14} />{t('CSV 汇总', 'CSV summary')}</button>
      <button className="nw-button" disabled={!summary || loading || !!error} onClick={() => summary && downloadSummary(summary, false)}>{t('JSON 汇总', 'JSON summary')}</button>
    </div>
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
    {!summary && !error && <div className="nw-settings-loading" role="status">{connection === 'connected' ? <Loader2 size={18} className="nw-spin" /> : <Gauge size={18} />}<span>{connection === 'connected'
      ? indexBuilding ? t('正在建立用量索引；可靠总数暂不可用…', 'Building the usage index; a reliable total is not available yet…') : t('正在整理用量…', 'Loading usage…')
      : t('连接工作引擎后查看用量。', 'Connect your engine to view usage.')}</span></div>}
    {totals && <div className="nw-preference-card nw-usage-totals nw-usage-primary-totals">
      <div className="nw-usage-stat"><strong>{fmt(totals.totalTokens)}</strong><span>{t("总 token", "Total tokens")}</span></div>
      <div className="nw-usage-stat"><strong>{fmt(totals.inputTokens)}</strong><span>{t("输入", "Input")}</span></div>
      <div className="nw-usage-stat"><strong>{fmt(totals.outputTokens)}</strong><span>{t("输出", "Output")}</span></div>
      <div className="nw-usage-stat"><strong>{fmt(totals.turns)}</strong><span>{t("回合", "Turns")}</span></div>
    </div>}
    {totals && (totals.unknownTurns > 0 || totals.partialTurns > 0) && <p className="nw-help" role="status">{t(`其中 ${totals.unknownTurns} 个回合供应商未回报用量,${totals.partialTurns} 个回合只有部分数据;未知不按零计算。`, `${totals.unknownTurns} turns have no provider-reported usage and ${totals.partialTurns} have partial data; unknown is never counted as zero.`)}</p>}
    {totals && <p className="nw-help">{t("缓存已计入输入，推理已计入输出；总量不会重复相加。", "Cache is included in input and reasoning in output; totals never count them twice.")}</p>}
    {summary?.cache && (summary.cache.knownTurns > 0 || summary.cache.unknownTurns > 0) && <section className="nw-preference-section"><h2>{t("缓存", "Cache")}</h2>
      <div className="nw-preference-card nw-usage-totals">
        <div className="nw-usage-stat"><strong>{summary.cache.hitRatio == null ? t("未知", "Unknown") : `${(summary.cache.hitRatio * 100).toFixed(1)}%`}</strong><span>{t("缓存命中率", "Cache hit ratio")}</span></div>
        <div className="nw-usage-stat"><strong>{summary.cache.knownTurns > 0 ? fmt(summary.cache.knownCachedInputTokens) : t("未知", "Unknown")}</strong><span>{t("缓存读取（已知）", "Cache read (known)")}</span></div>
        <div className="nw-usage-stat"><strong>{(summary.cache.knownWriteTurns ?? 0) > 0 ? fmt(summary.cache.knownCacheWriteInputTokens) : t("未知", "Unknown")}</strong><span>{t("缓存写入（已知）", "Cache write (known)")}</span><span className="nw-help">{t(`${fmt(summary.cache.unknownWriteTurns ?? 0)} 个回合未回报写入`, `${fmt(summary.cache.unknownWriteTurns ?? 0)} turns without write reporting`)}</span></div>
        <div className="nw-usage-stat"><strong>{fmt(summary.cache.unknownTurns)}</strong><span>{t("未回报缓存的回合", "Turns without cache reporting")}</span></div>
      </div>
      {(summary.cache.fullyKnownTurns ?? 0) > 0 && <p className="nw-help">{t(`已完整回报缓存的 ${fmt(summary.cache.fullyKnownTurns ?? 0)} 个回合，非缓存输入 ${fmt((summary.cache.knownUncachedInputTokens ?? 0))}。`, `Uncached input across ${fmt(summary.cache.fullyKnownTurns ?? 0)} fully reported turns: ${fmt((summary.cache.knownUncachedInputTokens ?? 0))}.`)}</p>}
      <p className="nw-help">{t(
        `命中率只统计真实回报了缓存字段的 ${fmt(summary.cache.knownTurns)} 个回合；${fmt(summary.cache.unknownTurns)} 个未回报的回合按未知显示，不算 0% 命中。`,
        `The ratio covers only the ${fmt(summary.cache.knownTurns)} turns whose provider reported cache fields; ${fmt(summary.cache.unknownTurns)} unreported turns are shown as unknown, never as a 0% hit.`,
      )}</p>
    </section>}
    {!loading && totals?.turns === 0 && !summary?.media?.byProvider.length && <p className="nw-settings-no-results">{t('此范围还没有用量记录。完成任务后可在这里查看。', 'No usage records in this range yet. Finish a task to see its usage here.')}</p>}
    {!!summary?.byAgentRole?.length && <section className="nw-preference-section"><h2>{t('代理协作', 'Agent collaboration')}</h2><div className="nw-preference-card">{summary.byAgentRole.map(row => <div className="nw-preference-row" key={row.role}><div><strong>{row.role === 'main' ? t('主代理', 'Main agent') : t('协作代理', 'Sub-agents')}</strong><p>{t(`${fmt(row.turns)} 个回合 · ${fmt(row.unknownTurns + row.partialTurns)} 个用量不完整`, `${fmt(row.turns)} turns · ${fmt(row.unknownTurns + row.partialTurns)} with incomplete usage`)}</p></div><strong>{t(`${fmt(row.totalTokens)} token`, `${fmt(row.totalTokens)} tokens`)}</strong></div>)}</div></section>}
    {summary && !!summary.byModel.length && <section className="nw-preference-section"><h2>{t("按模型", "By model")}</h2>
      <div className="nw-preference-card nw-usage-table-scroll" role="region" tabIndex={0} aria-label={t("按模型统计的 token 用量", "Token usage grouped by model")}><table className="nw-usage-table">
        <caption className="nw-visually-hidden">{t("按模型统计的 token 用量", "Token usage grouped by model")}</caption>
        <thead><tr><th scope="col">{t("模型", "Model")}</th><th scope="col" className="nw-num">{t("回合", "Turns")}</th><th scope="col" className="nw-num">{t("输入", "Input")}</th><th scope="col" className="nw-num">{t("输出", "Output")}</th><th scope="col" className="nw-num">{t("估算成本", "Est. cost")}</th><th scope="col" className="nw-num">{t("总量", "Total")}</th></tr></thead>
        <tbody>{(() => {
          const estimates = new Map(summary.byModel.map(row => [row.model, estimateDatedRows((summary.billingRows ?? []).filter(value => value.model === row.model), priceTable)]));
          return summary.byModel.map(row => {
            const estimate = estimates.get(row.model);
            return <tr key={row.model}>
              <th scope="row">{row.model}</th>
              <td className="nw-num">{fmt(row.turns)}</td>
              <td className="nw-num">{fmt(row.inputTokens)}</td>
              <td className="nw-num">{fmt(row.outputTokens)}</td>
              <td className="nw-num">{estimate ? (estimate.amount == null ? t("未知", "Unknown") : `${estimate.amount.toFixed(4)} ${estimate.currency}`) : t("未知", "Unknown")}</td>
              <td className="nw-num">{fmt(row.totalTokens)}</td>
            </tr>;
          });
        })()}</tbody>
      </table></div>
      <p className="nw-help">{t(
        "成本为可配置价格的估算（本机保存，按生效日期取用）；缺价格或用量未知时显示“未知”，绝不推算。订阅额度不换算成账单金额。",
        "Cost is an estimate from locally saved, dated price entries; missing prices or unknown usage show “Unknown” and are never guessed. Subscription quota is never converted into a bill.",
      )}</p>
      <div className="nw-usage-toolbar">
        <label className="nw-button">
          <Upload size={13} /> {priceTable ? t("更新价格表", "Update price table") : t("导入价格表 (JSON)", "Import price table (JSON)")}
          <input
            type="file"
            accept="application/json"
            className="nw-visually-hidden"
            onChange={event => void (async () => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (file.size > 2_000_000) { setError(t("价格表不能超过 2 MB。", "Price tables must be under 2 MB.")); return; }
              try {
              const parsed = parsePriceTable(await file.text());
              if (!parsed) {
                setError(t("价格表格式不正确：需要 {version, prices[]}。", "Invalid price table: expected {version, prices[]}."));
                return;
              }
              setPriceTable(parsed);
              setError("");
              try { window.localStorage.setItem(PRICE_TABLE_STORAGE_KEY, JSON.stringify(parsed)); } catch { /* ignore */ }
              } catch (cause) { setError(errorText(cause)); }
            })()}
          />
        </label>
        {priceTable && <button className="nw-button" onClick={() => {
          setPriceTable(null);
          try { window.localStorage.removeItem(PRICE_TABLE_STORAGE_KEY); } catch { /* ignore */ }
        }}>{t("清除价格表", "Clear price table")}</button>}
        {priceTable && <span className="nw-help">{t(`已载入 ${priceTable.prices.length} 条价格（版本 ${priceTable.version}，更新于 ${priceTable.updatedAt}）。`, `${priceTable.prices.length} prices loaded (version ${priceTable.version}, updated ${priceTable.updatedAt}).`)}</span>}
      </div>
    </section>}
    {summary && !!summary.byDay.length && <section className="nw-preference-section"><h2>{t("日趋势", "Daily trend")}</h2>
      <div className="nw-preference-card nw-usage-trend">{summary.byDay.map(row => <TrendBar key={row.day} row={row} max={maxDay} />)}</div>
    </section>}
    {summary?.media && !!summary.media.byProvider.length && <section className="nw-preference-section"><h2>{t("媒体生成", "Media generation")}</h2>
      <div className="nw-preference-card nw-usage-table-scroll" role="region" tabIndex={0} aria-label={t("媒体生成用量", "Media generation usage")}><table className="nw-usage-table">
        <thead><tr><th scope="col">{t("提供商 / 模型", "Provider / model")}</th><th scope="col" className="nw-num">{t("任务", "Jobs")}</th><th scope="col" className="nw-num">{t("计量", "Units")}</th><th scope="col" className="nw-num">{t("未知", "Unknown")}</th></tr></thead>
        <tbody>{summary.media.byProvider.map(row => <tr key={`${row.providerId}/${row.model}`}>
          <th scope="row" title={row.providerId}>{providerNames.get(row.providerId) || row.providerId.slice(0, 8)}<span className="nw-usage-model-name">{row.model}</span></th>
          <td className="nw-num">{fmt(row.jobs)}</td>
          <td className="nw-num">{Object.entries(row.units).map(([name, value]) => `${value} ${name}`).join(", ") || t("未知", "Unknown")}</td>
          <td className="nw-num">{fmt(row.unknownAttempts)}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="nw-help">{t('媒体生成按图片、秒数等单位单独记录，不与 token 相加。历史任务没有计量时间时使用任务更新时间。', summary.media.note)}</p>
    </section>}
    <UsageLedger params={summaryParams} utc={utc} />
    {summary && <details className="nw-model-catalog"><summary>{t("统计口径", "How this is counted")}</summary><ul className="nw-help">{[
      t('汇总包含筛选范围内的全部记录；导出的 JSON 明细最多包含 100 条。', summary.notes[0]),
      t('缓存输入和推理输出已计入对应用量，不会重复相加。', summary.notes[1]),
      t('未知用量不代表零消耗；这里不推算价格或账单金额。', summary.notes[2]),
      t('日趋势采用当前本地时区偏移。跨历史夏令时核对时请切换 UTC。', summary.notes[4]),
    ].map(note => <li key={note}>{note}</li>)}</ul></details>}
  </div>;
}
