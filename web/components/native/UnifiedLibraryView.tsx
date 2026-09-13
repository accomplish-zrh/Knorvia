"use client";

import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, Layers } from 'lucide-react';
import { LibraryView } from './LibraryView';
import { OutputsView } from './OutputsView';
import { useWorkbench } from './NativeWorkbenchProvider';
import './unified-library.css';

const subscribeHeader = () => () => {};
const getHeader = () => document.getElementById('nw-task-header-tools');
const noHeader = () => null;

// Both collections retain their existing service, version history and reader.
// Links deliberately use the editors' existing capture-phase navigation guard.
export function UnifiedLibraryView({ view = 'files' }: { view?: 'files' | 'outputs' }) {
  const { t } = useWorkbench();
  const header = useSyncExternalStore(subscribeHeader, getHeader, noHeader);
  const collections = <nav className="nl-collections" aria-label={t('资料库内容', 'Library collections')}>
      <Link href="/workbench/library" aria-current={view === 'files' ? 'page' : undefined}><FolderOpen size={16} />{t('我的资料', 'My files')}</Link>
      <Link href="/workbench/library?view=outputs" aria-current={view === 'outputs' ? 'page' : undefined}><Layers size={16} />{t('任务生成', 'From tasks')}</Link>
    </nav>;
  return <div className="nl-unified">
    {header && createPortal(collections, header)}
    <div className="nl-collection-body">{view === 'outputs' ? <OutputsView embedded /> : <LibraryView />}</div>
  </div>;
}
