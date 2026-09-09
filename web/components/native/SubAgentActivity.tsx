"use client";
import { useMemo, useState } from 'react';
import { Check, ChevronRight, CircleAlert, CirclePause, Loader2, Network, Square } from 'lucide-react';
import type { Item } from '@/lib/native-workbench-state';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';

type Agent = { id: string; status: string; items: Item[]; lastTurnId?: string };
type Scope = { threadId: string; turnId: string; active: boolean };
function AgentCard({ agent, number, scope }: { agent: Agent; number: number; scope: Scope }) {
  const { t, request, readThread } = useWorkbench();
  const [limit, setLimit] = useState(20);
  const [stopping, setStopping] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState('');
  const Icon = agent.status === 'completed' ? Check : agent.status === 'failed' ? CircleAlert : ['interrupted', 'cancelled'].includes(agent.status) ? CirclePause : agent.status === 'running' ? Loader2 : Network;
  const label = agent.status === 'completed' ? t('已完成', 'Completed') : agent.status === 'failed' ? t('执行失败', 'Failed') : ['interrupted', 'cancelled'].includes(agent.status) ? t('已停止', 'Stopped') : agent.status === 'running' ? t('执行中', 'Working') : t('已有活动', 'Activity recorded');
  const details = agent.items.filter(item => ['item/completed', 'error'].includes(String(item.payload.event)));
  return <details className="nw-subagent"><summary><Network size={16} /><strong>{t(`协作代理 ${number}`, `Agent ${number}`)}</strong><span className="nw-subagent-status"><Icon size={13} className={agent.status === 'running' ? 'nw-spin' : undefined} />{label}</span><ChevronRight size={14} /></summary>
    <div className="nw-subagent-detail"><p className="nw-help">{t('与主任务共享审批入口，各自保留执行记录。', 'Approvals appear in the main task; each agent keeps its own activity.')}</p>
      {scope.active && agent.status === 'running' && <button className="nw-button" disabled={stopping || requested} onClick={async () => {
        if (stopping || requested) return; setStopping(true); setError('');
        try { await request('turn/agent/interrupt', { threadId: scope.threadId, turnId: scope.turnId, kernelThreadId: agent.id }); setRequested(true); await readThread(scope.threadId); }
        catch (cause) { setError(errorText(cause)); } finally { setStopping(false); }
      }}><Square size={13} />{requested ? t('已请求停止', 'Stop requested') : t('停止这个代理', 'Stop this agent')}</button>}
      {error && <p className="nw-inline-error" role="alert">{error}</p>}
      {details.slice(-limit).map(event => {
        const data = event.payload.data && typeof event.payload.data === 'object' ? event.payload.data as Record<string, unknown> : {};
        const item = data.item && typeof data.item === 'object' ? data.item as Record<string, unknown> : data;
        const content = Array.isArray(item.content) ? item.content.flatMap(part => part && typeof part === 'object' && typeof part.text === 'string' ? [part.text] : []).join('\n') : '';
        const text = item.text ?? item.command ?? item.message ?? (content || undefined);
        return <div className="nw-subagent-event" key={event.id}><span>{typeof item.type === 'string' ? ({ userMessage: t('分配的任务', 'Assigned task'), agentMessage: t('回复', 'Response'), commandExecution: t('运行命令', 'Command'), fileChange: t('文件改动', 'File change'), reasoning: t('工作思路', 'Approach') } as Record<string, string>)[item.type] || t('工具活动', 'Tool activity') : t('执行记录', 'Activity')}</span>{typeof text === 'string' ? <pre>{text}</pre> : <details><summary>{t('查看活动详情', 'View activity details')}</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>}{typeof item.aggregatedOutput === 'string' && item.aggregatedOutput && <pre>{item.aggregatedOutput}</pre>}</div>;
      })}
      {details.length > limit && <button className="nw-button" onClick={() => setLimit(value => value + 20)}>{t('显示更早的活动', 'Show earlier activity')}</button>}
      <details className="nw-subagent-identity"><summary>{t('代理标识', 'Agent identity')}</summary><code>{agent.id}</code></details>
    </div>
  </details>;
}

export function SubAgentActivity({ items, scope }: { items: Item[]; scope: Scope }) {
  const { t } = useWorkbench();
  const active = scope.active;
  const agents = useMemo(() => {
    const grouped = new Map<string, Agent>();
    for (const item of items) {
      const id = item.payload.kernelThreadId;
      if (item.kind !== 'subAgent' || typeof id !== 'string') continue;
      const group: Agent = grouped.get(id) ?? { id, status: 'unknown', items: [] };
      group.items.push(item);
      if (typeof item.payload.kernelTurnId === 'string') group.lastTurnId = item.payload.kernelTurnId;
      const data = item.payload.data as { turn?: { status?: string } } | undefined;
      if (item.payload.event === 'turn/started') group.status = 'running';
      else if (item.payload.event === 'turn/completed') group.status = data?.turn?.status || 'completed';
      else if (item.payload.event === 'error') group.status = 'failed';
      grouped.set(id, group);
    }
    return [...grouped.values()].map(agent => !active && agent.status === 'running' ? { ...agent, status: 'unknown' } : agent);
  }, [items, active]);
  return <section className="nw-subagents" aria-label={t('多代理协作', 'Agent collaboration')}>{agents.map((agent, index) => <AgentCard key={`${agent.id}:${agent.lastTurnId}`} agent={agent} number={index + 1} scope={scope} />)}</section>;
}
