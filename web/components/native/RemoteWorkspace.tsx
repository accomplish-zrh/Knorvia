"use client";
import { useState } from 'react';
import { FolderOpen, Server, TerminalSquare } from 'lucide-react';
import { SshConnections } from './SshConnections';
import { SshTerminalPanel } from './SshTerminalPanel';
import { SshFilesPanel } from './SshFilesPanel';
import { useWorkbench } from './NativeWorkbenchProvider';

export function RemoteWorkspace({ active = true, threadId, initialSessionId }: { active?: boolean; threadId?: string; initialSessionId?: string }) {
  const { t } = useWorkbench();
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [view, setView] = useState<'terminal' | 'files'>('terminal');
  return <div className="nw-remote-workspace">
    {sessionId ? <><div className="nw-usage-toolbar" role="group" aria-label={t('远程工作空间', 'Remote workspace')}><button className="nw-button" onClick={() => setSessionId(undefined)}><Server size={14} />{t('主机', 'Hosts')}</button><button className="nw-button" aria-pressed={view === 'terminal'} onClick={() => setView('terminal')}><TerminalSquare size={14} />{t('终端', 'Terminal')}</button><button className="nw-button" aria-pressed={view === 'files'} onClick={() => setView('files')}><FolderOpen size={14} />{t('文件', 'Files')}</button></div>
      <div className="nw-settings-ssh-panel" hidden={view !== 'terminal'}><SshTerminalPanel sessionId={sessionId} active={active && view === 'terminal'} onClose={() => setSessionId(undefined)} onNew={() => setSessionId(undefined)} /></div>
      {view === 'files' && <SshFilesPanel sessionId={sessionId} threadId={threadId} />}
    </> : <SshConnections onOpenSession={session => { setSessionId(session.sessionId); setView('terminal'); }} />}
  </div>;
}
