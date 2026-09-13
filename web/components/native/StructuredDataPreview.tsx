"use client";

import { useEffect, useMemo, useState } from "react";
import { Braces, Copy, Table2 } from "lucide-react";
import { isStructuredFile, jsonNodePath, jsonNodeSource, searchJsonNodes, parseCsv, parseJsonPreview, type JsonNode } from "@/lib/native-data-preview";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";

const TABLE_PAGE = 200;

/**
 * Read-only structured review (B18): CSV/TSV tables and JSON trees derived
 * from the already-loaded text. Pure text remains one toggle away, cells and
 * node paths copy verbatim, and nothing here executes content or writes.
 */
export function StructuredDataPreview({ name, text, truncated }: { name: string; text: string; truncated: boolean }) {
  const kind = isStructuredFile(name);
  const { t, setNotice } = useWorkbench();
  const [raw, setRaw] = useState(false);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [nodePages, setNodePages] = useState<Record<string, number>>({});
  useEffect(() => { setFilter(""); setPage(0); setExpanded({}); setNodePages({}); }, [name, text]);
  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setNotice(t(`${label}已复制`, `${label} copied`)); }
    catch (error) { setNotice(errorText(error)); }
  };

  const csv = useMemo(() => kind === "csv" || kind === "tsv" ? parseCsv(text, { delimiter: kind === "tsv" ? "\t" : undefined }) : null, [kind, text]);
  const json = useMemo(() => kind === "json" ? parseJsonPreview(text) : null, [kind, text]);
  const jsonMatches = useMemo(() => searchJsonNodes(json?.root, filter), [json, filter]);

  const rows = useMemo(() => {
    if (!csv) return [];
    if (!filter.trim()) return csv.rows;
    const needle = filter.trim().toLowerCase();
    return csv.rows.filter(row => row.some(cell => cell.toLowerCase().includes(needle)));
  }, [csv, filter]);

  const visibleRows = rows.slice(0, (page + 1) * TABLE_PAGE);

  const copyNode = (node: JsonNode, path: (string | number)[]) => <button className="nw-icon nw-json-copy" aria-label={`${t("复制此处内容", "Copy value")}: ${jsonNodePath(path)}`} title={t("复制此处原始 JSON", "Copy the original JSON at this location")} onClick={() => void copy(jsonNodeSource(text, node), t("内容", "Value"))}><Copy size={11} /></button>;
  const renderNode = (node: JsonNode, path: (string | number)[], depth: number): React.ReactNode => {
    const key = jsonNodePath(path);
    if (node.kind === "object" || node.kind === "array") {
      const isOpen = expanded[key] ?? depth < 2;
      const count = node.childCount ?? 0;
      return <div key={key || "root"} className="nw-json-node">
        <button className="nw-json-toggle" aria-expanded={isOpen} onClick={() => setExpanded(current => ({ ...current, [key]: !isOpen }))}>
          {node.kind === "object" ? "{}" : "[]"} <small>{t(`${count} 项`, `${count} items`)}</small>
        </button>
        {copyNode(node, path)}
        {isOpen && <div className="nw-json-children">{(node.entries ?? []).slice(0, nodePages[key] ?? TABLE_PAGE).map(entry => {
          const childPath = [...path, node.kind === "array" ? Number(entry.key) : entry.key];
          const childKey = jsonNodePath(childPath);
          const scalar = entry.node.kind !== "object" && entry.node.kind !== "array";
          return <div key={childKey} className="nw-json-entry">
            <span className="nw-json-key">{node.kind === "array" ? `[${entry.key}]` : entry.key}:</span>
            {scalar ? <code className="nw-json-value" title={entry.node.value}>{entry.node.kind === "string" ? JSON.stringify(entry.node.value) : entry.node.value}</code>
              : renderNode(entry.node, childPath, depth + 1)}
            {scalar && copyNode(entry.node, childPath)}
            <button className="nw-icon nw-json-copy" aria-label={`${t("复制路径", "Copy path")}: ${childKey}`} title={t("复制路径", "Copy path")} onClick={() => void copy(childKey, t("路径", "Path"))}><Copy size={11} /></button>
          </div>;
        })}{count > (nodePages[key] ?? TABLE_PAGE) && <button className="nw-button nw-button-small" onClick={() => setNodePages(current => ({ ...current, [key]: (current[key] ?? TABLE_PAGE) + TABLE_PAGE }))}>{t("显示更多项", "Show more items")}</button>}</div>}
      </div>;
    }
    return <><code className="nw-json-value">{node.kind === "string" ? JSON.stringify(node.value) : node.value}</code>{copyNode(node, path)}</>;
  };

  if (!kind) return null;
  return <div className="nw-structured" aria-label={t("结构化数据", "Structured data")}>
    <div className="nw-structured-toolbar">
      <button className="nw-button nw-button-small" onClick={() => setRaw(value => !value)}>{raw ? <><Table2 size={13} />{t("结构视图", "Structured")}</> : <><Braces size={13} />{t("文本原貌", "Raw text")}</>}</button>
      {!raw && <input className="nw-structured-find" aria-label={kind === "json" ? t("查找字段或值", "Find keys or values") : t("筛选行", "Filter rows")} placeholder={t("查找包含的文本…", "Find containing text…")} value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }} />}
      {truncated && <span className="nw-structured-note" role="note">{t("文件被截断：以下仅是已加载的前缀，不代表完整文件。", "The file is truncated: only the loaded prefix is shown, not the whole file.")}</span>}
    </div>
    {raw ? <div className="nw-preview-reading"><pre className="nw-preview-code">{text}</pre></div>
      : csv ? <>
        <div className="nw-table-wrap"><table className="nw-data-table">
          <thead><tr>{csv.headers.map((header, index) => <th key={index} title={header ? 'Col ' + (index + 1) + ': ' + header : 'Col ' + (index + 1)}>{header || t("（空）", "(empty)")}</th>)}</tr></thead>
          <tbody>{visibleRows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} title={cell}><button className="nw-cell-copy" onClick={() => void copy(cell, t("单元格", "Cell"))}>{cell}</button></td>)}</tr>)}</tbody>
        </table></div>
        <p className="nw-structured-note" role="status">{t(`已解析 ${csv.rows.length} 行（显示前 ${visibleRows.length} 行），分隔符 ${JSON.stringify(csv.delimiter)}。`, `Parsed ${csv.rows.length} rows (showing first ${visibleRows.length}); delimiter ${JSON.stringify(csv.delimiter)}.`)}{csv.truncated ? t("内容超出解析上限，已按截断处理。", " Content beyond the parse bound was treated as truncated.") : ""}{rows.length !== csv.rows.length ? t(`筛选后剩余 ${rows.length} 行。`, ` ${rows.length} rows match the filter.`) : ""}</p>
        {rows.length > visibleRows.length && <button className="nw-button" onClick={() => setPage(value => value + 1)}>{t("显示更多行", "Show more rows")}</button>}
      </>
      : json ? json.valid
        ? filter.trim() ? <div className="nw-json-search"><p role="status">{t(`在已加载 JSON 中找到 ${jsonMatches.matches.length} 项${jsonMatches.truncated ? "（仅显示前 200 项）" : ""}。`, `${jsonMatches.matches.length} matches in the loaded JSON${jsonMatches.truncated ? " (showing the first 200)" : ""}.`)}</p>{jsonMatches.matches.map(match => <div className="nw-json-entry" key={jsonNodePath(match.path)}><code className="nw-json-key">{jsonNodePath(match.path)}</code><code className="nw-json-value">{match.node.value ?? `${match.node.kind}: ${match.node.childCount} items`}</code>{copyNode(match.node, match.path)}<button className="nw-icon" aria-label={`${t("复制路径", "Copy path")}: ${jsonNodePath(match.path)}`} onClick={() => void copy(jsonNodePath(match.path), t("路径", "Path"))}><Copy size={11} /></button></div>)}</div>
          : <div className="nw-json-tree">{renderNode(json.root!, [], 0)}</div>
        : <div className="nw-structured-note" role="alert"><p>{t("JSON 无法完整解析：", "The JSON could not be fully parsed: ")}{json.error}</p><p>{t("可切换到文本原貌查看已加载内容。", "Switch to the raw text view to inspect what loaded.")}</p></div>
      : null}
  </div>;
}
