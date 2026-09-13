'use client';

import { useCallback, useEffect, useState } from 'react';
import { TerminalSquare } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';
import './ssh.css';

type TerminalProfile = { id: string; name: string; executable: string; args: string[] };
type TerminalCatalog = { available: boolean; profiles: TerminalProfile[]; defaultProfileId?: string; defaultMissing?: boolean };

// C18: pick the host-detected shell new terminals start with. The list only
// contains profiles the host manages; the renderer never names an executable.
export function TerminalSettings() {
  const { request, t } = useWorkbench();
  const [catalog, setCatalog] = useState<TerminalCatalog | null>(null);
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const result = await request<TerminalCatalog>('terminal/profiles/list', {});
    setCatalog(result);
    setChoice(result.defaultProfileId);
  }, [request]);
  useEffect(() => { setError(''); void load().catch(e => setError(errorText(e))); }, [load]);
  const save = async (profileId?: string) => {
    setBusy(true); setError(''); setNotice('');
    try { const result = await request<TerminalCatalog>('terminal/profiles/default', { profileId: profileId ?? null }); setCatalog(prev => prev ? { ...prev, defaultProfileId: result.defaultProfileId } : prev); setChoice(result.defaultProfileId); setNotice(t('已保存；只对新开的终端生效。', 'Saved; only newly opened terminals use it.')); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return <section className="nw-preference-section nw-terminal-settings" aria-label={t('终端 Shell', 'Terminal shell')}>
    <div className="nw-appearance-heading"><h2><TerminalSquare size={18} /> {t('终端 Shell', 'Terminal shell')}</h2></div>
    {error && <p role="alert" className="nw-inline-error">{error}</p>}
    {notice && <p role="status" className="nw-help">{notice}</p>}
    {!catalog && <p className="nw-help">{t('正在读取主机上的可用 Shell…', 'Detecting the shells available on this host…')}</p>}
    {catalog && !catalog.available && <p className="nw-help">{t('此安装暂未接入终端配置；终端继续使用默认 Shell。', 'This installation has no terminal shell wiring yet; terminals keep using the default shell.')}</p>}
    {catalog?.available && <div className="nw-ssh-form">
      {catalog.defaultMissing && <p role="alert" className="nw-inline-error">{t('之前选择的默认 Shell 已卸载；新终端会报错，请在下面重新选择。', 'The previously selected default shell is no longer installed; new terminals will fail until you pick another one below.')}</p>}
      <label className="nw-field">{t('新终端默认使用', 'Default shell for new terminals')}
        <select value={choice ?? ''} disabled={busy} onChange={e => setChoice(e.target.value || undefined)}>
          <option value="">{t('系统默认（PowerShell / Bash）', 'System default (PowerShell / Bash)')}</option>
          {catalog.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>
      {catalog.profiles.length > 0 && <ul className="nw-help">{catalog.profiles.map(profile => <li key={profile.id}>{profile.name}: <code>{profile.executable}</code></li>)}</ul>}
      <p className="nw-help">{t('只列出主机上实际安装的 Shell；已打开的终端不受影响，缺失的 Shell 会明确报错而不是静默换用其他环境。', 'Only shells actually installed on this host are listed. Opened terminals are unaffected, and a missing shell fails clearly instead of silently switching.')}</p>
      <button className="nw-button nw-button-primary" disabled={busy || choice === catalog.defaultProfileId} onClick={() => void save(choice)}>{busy ? t('保存中…', 'Saving…') : t('保存默认 Shell', 'Save default shell')}</button>
    </div>}
  </section>;
}
