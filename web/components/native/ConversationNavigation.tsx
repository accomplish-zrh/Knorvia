"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ArrowDown, ArrowUp, Bookmark, List, Search, X } from 'lucide-react';
import { ConversationBookmarks } from './ConversationBookmarks';
import { conversationMatches, conversationMessages } from '@/lib/native-conversation';
import type { ThreadSnapshot } from '@/lib/native-workbench-state';
import { useWorkbench } from './NativeWorkbenchProvider';

export function ConversationNavigation({ thread, scroll, searching, setSearching, navigate }: {
  thread: ThreadSnapshot; scroll: RefObject<HTMLDivElement | null>; searching: boolean; setSearching: (open: boolean) => void; navigate: () => void;
}) {
  const { t } = useWorkbench();
  const [query, setQuery] = useState('');
  const [locateTick, setLocateTick] = useState(0);
  const [selection, setSelection] = useState(0);
  const [outline, setOutline] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const messages = useMemo(() => conversationMessages(thread.items, thread.goalId), [thread.items, thread.goalId]);
  const users = messages.filter(item => item.user);
  const matches = useMemo(() => conversationMatches(messages, query), [messages, query]);
  const selected = matches.length ? selection % matches.length : 0;
  // Timeline items live inside a bounded window: an id that is not currently
  // mounted is requested through this event, and the timeline mounts its chunk.
  const locate = (id: string, then: () => void) => {
    const seek = (tries: number) => {
      const item = scroll.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
      if (item) { then(); return; }
      if (tries === 0) window.dispatchEvent(new CustomEvent('knorvia:locate-timeline-item', { detail: { id } }));
      if (tries < 60) requestAnimationFrame(() => seek(tries + 1));
    };
    seek(0);
  };
  const jumpTo = (id: string) => {
    navigate();
    locate(id, () => {
      const el = scroll.current, item = el?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
      if (el && item) el.scrollTo({ top: el.scrollTop + item.getBoundingClientRect().top - el.getBoundingClientRect().top - 70, behavior: 'instant' });
    });
  };
  useEffect(() => {
    if (!searching) return;
    previousFocus.current = document.activeElement as HTMLElement;
    input.current?.focus(); input.current?.select();
    return () => { if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true }); };
  }, [searching]);
  const currentId = searching ? matches[selected]?.id : undefined;
  useEffect(() => {
    if (!outline) return;
    const outside = (event: PointerEvent) => { if (!navigation.current?.contains(event.target as Node)) setOutline(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setOutline(false); navigation.current?.querySelector<HTMLButtonElement>('.nw-outline-toggle')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [outline]);
  useEffect(() => {
    if (!currentId) return;
    const el = scroll.current, item = el?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(currentId)}"]`);
    if (!el || !item) {
      // The match lives in an unmounted window chunk: ask the timeline to
      // mount it, then re-run this effect once the chunk is on the page.
      window.dispatchEvent(new CustomEvent('knorvia:locate-timeline-item', { detail: { id: currentId } }));
      const poll = window.setTimeout(() => setLocateTick(tick => tick + 1), 80);
      return () => window.clearTimeout(poll);
    }
    navigate(); item.dataset.findCurrent = 'true';
    const ranges: Range[] = [];
    const needle = query.trim().toLocaleLowerCase();
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && ranges.length < 500) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('button, summary, .nw-message-actions')) continue;
      const content = node.textContent?.toLocaleLowerCase() ?? '';
      for (let start = content.indexOf(needle); needle && start >= 0 && ranges.length < 500; start = content.indexOf(needle, start + needle.length)) {
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, Math.min((node.textContent ?? '').length, start + needle.length)); ranges.push(range);
      }
    }
    if ('highlights' in CSS && typeof Highlight !== 'undefined') CSS.highlights.set('knorvia-conversation-find', new Highlight(...ranges));
    const first = ranges[0], paragraph = first?.startContainer.parentElement?.closest('p');
    if (paragraph && paragraph.scrollHeight > paragraph.clientHeight) paragraph.scrollTo({ top: paragraph.scrollTop + first.getBoundingClientRect().top - paragraph.getBoundingClientRect().top - 8, behavior: 'instant' });
    el.scrollTo({ top: el.scrollTop + item.getBoundingClientRect().top - el.getBoundingClientRect().top - 70, behavior: 'instant' });
    return () => { delete item.dataset.findCurrent; if ('highlights' in CSS) CSS.highlights.delete('knorvia-conversation-find'); };
  }, [currentId, query, scroll, navigate, locateTick]);
  const step = (direction: number) => { if (matches.length) setSelection((selected + direction + matches.length) % matches.length); };
  return <>
    {searching && <div className="nw-conversation-find" role="search" aria-label={t('在对话中查找', 'Find in conversation')} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSearching(false); }
      if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
    }}><Search size={16} /><input ref={input} aria-label={t('查找对话内容', 'Find conversation text')} placeholder={t('搜索此对话…', 'Search this conversation…')} value={query} onChange={event => { setQuery(event.target.value); setSelection(0); }} /><span role="status">{query.trim() ? matches.length ? `${selected + 1} / ${matches.length}` : t('无匹配', 'No matches') : ''}</span><button className="nw-icon" disabled={!matches.length} onClick={() => step(-1)} aria-label={t('上一个匹配', 'Previous match')}><ArrowUp size={15} /></button><button className="nw-icon" disabled={!matches.length} onClick={() => step(1)} aria-label={t('下一个匹配', 'Next match')}><ArrowDown size={15} /></button><button className="nw-icon" onClick={() => setSearching(false)} aria-label={t('关闭对话查找', 'Close conversation search')}><X size={16} /></button>{thread.hasMoreItems && <small>{t('仅查找已加载内容，可在对话顶部加载更早记录。', 'Searching loaded messages. Load earlier history at the top for more.')}</small>}</div>}
    {users.length > 1 && <nav ref={navigation} className="nw-conversation-nav" aria-label={t('用户消息', 'User messages')}>
      <button className="nw-icon" aria-pressed={bookmarksOpen} aria-label={t('书签与摘录', 'Bookmarks and excerpts')} title={t('书签与摘录', 'Bookmarks and excerpts')} onClick={() => setBookmarksOpen(value => !value)}><Bookmark size={16} /></button>
      <button className="nw-icon nw-outline-toggle" aria-expanded={outline} aria-label={t('对话目录', 'Conversation outline')} onClick={() => setOutline(value => !value)}><List size={16} /></button>
      <div className="nw-message-rail">{users.slice(-80).map((item, index) => <button key={item.id} title={item.text.slice(0, 160)} aria-label={`${t('跳转到用户消息', 'Jump to user message')} ${Math.max(0, users.length - 80) + index + 1}: ${item.text.slice(0, 50)}`} onClick={() => jumpTo(item.id)}><span /></button>)}</div>
      {outline && <div className="nw-outline-list"><header><strong>{t('对话目录', 'Conversation outline')}</strong><button className="nw-icon" aria-label={t('关闭对话目录', 'Close conversation outline')} onClick={() => setOutline(false)}><X size={14} /></button></header>{users.map((item, index) => <button key={item.id} onClick={() => { jumpTo(item.id); setOutline(false); }}><small>{index + 1}</small><span>{item.text.slice(0, 160)}</span></button>)}</div>}
    </nav>}
    {bookmarksOpen && <ConversationBookmarks thread={thread} open={bookmarksOpen} close={() => setBookmarksOpen(false)} navigate={navigate} />}
  </>;
}
