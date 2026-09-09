"use client";

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, MessageCirclePlus } from 'lucide-react';
import type { Thread, ThreadSnapshot } from '@/lib/native-workbench-state';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import { TaskComposer } from './TaskComposer';
import { TaskTimeline } from './TaskTimeline';

export function SideChatPanel({ parent, tabId, existingThreadId, onThreadCreated }: { parent: ThreadSnapshot; tabId: string; existingThreadId?: string; onThreadCreated: (id: string) => void }) {
  const { t, request, readThread, sendTurn, snapshots, connection, setError } = useWorkbench();
  const [threadId, setThreadId] = useState(existingThreadId ?? '');
  const created = useRef<Thread | undefined>(undefined);
  const attempt = useRef(tabId);
  const scroll = useRef<HTMLDivElement>(null);
  const thread = snapshots[threadId];
  useEffect(() => { if (threadId && connection === 'connected') void readThread(threadId).catch(error => setError(errorText(error))); }, [threadId, connection, readThread, setError]);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [thread?.items.length, thread?.activeTurn]);
  return <section className="nw-side-chat" aria-label={t('侧边聊天', 'Side chat')}>
    <header><span><MessageCirclePlus size={15} />{t('侧边聊天', 'Side chat')}</span>{threadId && <Link href={`/workbench/task/${encodeURIComponent(threadId)}`} title={t('打开完整对话', 'Open full conversation')}><ArrowUpRight size={16} /></Link>}</header>
    <div ref={scroll} className="nw-side-chat-history">{thread ? <TaskTimeline thread={thread} /> : <div className="nw-preview-empty"><MessageCirclePlus size={28} /><p>{t('在同一项目中另开一段对话。主对话会保留。', 'Start another conversation in this project while keeping the main task open.')}</p></div>}</div>
    {threadId && !thread ? <button className="nw-button" onClick={() => void readThread(threadId).catch(error => setError(errorText(error)))}>{t('重新读取侧边聊天', 'Reload side conversation')}</button> : <TaskComposer thread={thread} projectId={parent.workspaceId} draftScope={`side:${parent.id}:${tabId}`} onCreate={async (input, options) => {
      created.current ??= await request<Thread>('thread/start', { workspaceId: parent.workspaceId, title: input.split('\n')[0].slice(0, 200), ...(options.model ? { model: options.model } : {}), ...(parent.cwd ? { cwd: parent.cwd } : {}), idempotencyKey: attempt.current });
      const id = created.current.id;
      onThreadCreated(id);
      // Set the durable task before sending. A failed send retries that task,
      // rather than creating a duplicate or changing the main route.
      await readThread(id); setThreadId(id);
      await sendTurn(id, input, { ...options, cwd: parent.cwd ?? options.cwd });
      return id;
    }} />}
  </section>;
}
