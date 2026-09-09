"use client";

import { useState } from 'react';
import { ChevronRight, File, FileText, Folder, FolderOpen, Image } from 'lucide-react';
import { libraryKind, type LibraryEntry } from '@/lib/native-library';
import { useWorkbench } from './NativeWorkbenchProvider';

export function LibraryTree({ entries, folders, selected, currentFolder, openFile, openFolder, actions }: { entries: LibraryEntry[]; folders: string[]; selected?: LibraryEntry; currentFolder: string; openFile: (entry: LibraryEntry) => void; openFolder: (folder: string) => void; actions: (path: string, entry?: LibraryEntry) => React.ReactNode }) {
  const { t } = useWorkbench(); const [expanded, setExpanded] = useState<Set<string>>(new Set()), [limit, setLimit] = useState(80);
  const folder = selected?.path.includes('/') ? selected.path.slice(0, selected.path.lastIndexOf('/')) : currentFolder;
  const [previousFolder, setPreviousFolder] = useState('');
  if (folder !== previousFolder) {
    setPreviousFolder(folder);
    setExpanded(current => { const next = new Set(current), parts = folder.split('/'); for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join('/')); return next; });
  }
  const parent = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const active = entries.filter(entry => !entry.trashedAt);
  function branch(root: string, depth = 0): React.ReactNode {
    const children = folders.filter(folder => parent(folder) === root).sort((a, b) => a.localeCompare(b)); const files = active.filter(entry => parent(entry.path) === root).sort((a, b) => a.name.localeCompare(b.name));
    return <>{children.slice(0, limit).map(folder => <div key={folder}>
      <div className={`nl-tree-row ${currentFolder === folder && !selected ? 'is-active' : ''}`} style={{ paddingInlineStart: 7 + Math.min(depth, 5) * 13 }}><button className="nl-tree-chevron" aria-label={`${expanded.has(folder) ? t('收起文件夹', 'Collapse folder') : t('展开文件夹', 'Expand folder')}: ${folder}`} aria-expanded={expanded.has(folder)} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(folder)) next.delete(folder); else next.add(folder); return next; })}><ChevronRight size={13} /></button><button className="nl-tree-name" title={folder} onClick={() => { setExpanded(current => new Set([...current, folder])); openFolder(folder); }}>{expanded.has(folder) ? <FolderOpen size={16} /> : <Folder size={16} />}<span>{folder.split('/').at(-1)}</span></button>{actions(folder)}</div>
      {expanded.has(folder) && branch(folder, depth + 1)}
    </div>)}{files.slice(0, limit).map(entry => { const kind = libraryKind(entry.name), Icon = kind === 'image' ? Image : ['text', 'docx'].includes(kind) ? FileText : File; return <div className={`nl-tree-row is-file ${selected?.id === entry.id ? 'is-active' : ''}`} key={entry.id} style={{ paddingInlineStart: 28 + Math.min(depth, 5) * 13 }}><button className="nl-tree-name" title={entry.path} aria-current={selected?.id === entry.id ? 'page' : undefined} onClick={() => openFile(entry)}><Icon size={15} /><span>{entry.name}</span></button>{actions(entry.path, entry)}</div>; })}{(children.length > limit || files.length > limit) && <button className="nl-tree-more" onClick={() => setLimit(value => value + 80)}>{t('显示更多', 'Show more')}</button>}</>;
  }
  return <div className="nl-folder-tree" aria-label={t('我的资料目录', 'My file directory')}>{branch('')}{!active.length && !folders.length && <p>{t('添加的资料会出现在这里', 'Your files will appear here')}</p>}</div>;
}
