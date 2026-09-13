"use client";

import { BookOpen, Brain, CalendarClock, ChartNoAxesColumn, Check, CircleAlert, CirclePause, FilePenLine, FileSpreadsheet, FileText, Film, FolderOpen, Globe, Hourglass, Image, LayoutGrid, Loader2, Network, Presentation, Search, Target, Terminal, Wrench, type LucideIcon } from 'lucide-react';
import { toolPresentation, type ToolCategory, type ToolState } from '@/lib/native-tool-presentation';
import type { Item } from '@/lib/native-workbench-state';
import { useWorkbench } from './NativeWorkbenchProvider';

const icons: Record<ToolCategory, LucideIcon> = { canvas: LayoutGrid, terminal: Terminal, read: FileText, edit: FilePenLine, search: Search, browser: Globe, image: Image, video: Film, agent: Network, library: BookOpen, automation: CalendarClock, goal: Target, document: FileText, spreadsheet: FileSpreadsheet, presentation: Presentation, usage: ChartNoAxesColumn, reasoning: Brain, folder: FolderOpen, tool: Wrench };
export function ToolIcon({ item }: { item: Item }) {
  const { t } = useWorkbench(), presentation = toolPresentation(item), Icon = icons[presentation.category];
  return <span className="nw-tool-symbol" data-tool-category={presentation.category} data-tool-state={presentation.state} role="img" aria-label={t(presentation.zh, presentation.en)} title={t(presentation.zh, presentation.en)}><Icon size={16} strokeWidth={1.65} aria-hidden="true" /></span>;
}
export function ToolStatus({ item }: { item: Item }) {
  const { t } = useWorkbench(), { state } = toolPresentation(item);
  if (!state) return null;
  const labels: Record<Exclude<ToolState, undefined>, string> = { running: t('进行中', 'Running'), done: t('已完成', 'Completed'), failed: t('失败', 'Failed'), stopped: t('已停止', 'Stopped'), waiting: t('等待确认', 'Waiting for input') };
  const Icon = { running: Loader2, done: Check, failed: CircleAlert, stopped: CirclePause, waiting: Hourglass }[state];
  return <span className="nw-tool-state" data-tool-state={state} aria-label={labels[state]} title={labels[state]}><Icon size={13} className={state === 'running' ? 'nw-spin' : undefined} aria-hidden="true" /><span>{labels[state]}</span></span>;
}
