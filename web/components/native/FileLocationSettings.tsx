"use client";
import { useEffect, useState } from 'react';
import { Copy, FolderOpen, Loader2 } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';

type Locations = { home: string; defaultTaskLocation: string; state: string; artifacts: string };
export function FileLocationSettings() {
  const { request, connection, connectionInfo, t, setNotice } = useWorkbench();
  const [paths, setPaths] = useState<Locations>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (connection !== 'connected') return;
    let active = true;
    request<Locations>('system/paths').then(value => { if (active) { setPaths(value); setError(''); } }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [request, connection]);
  return <section className="nw-preference-section nw-location-settings"><h2>{t('文件位置', 'File locations')}</h2>
    <p className="nw-help">{t('未选择项目的新任务各有一个持久文件夹；选择项目后，文件写入该项目。便携版的数据保存在程序旁的 Knorvia-data，升级时请保留它。', 'New tasks without a project each get a persistent folder. Project tasks use their project folder. Portable app data is kept in Knorvia-data beside the app; keep this folder when upgrading.')}</p>
    <p className="nw-help">{t('外观、背景与浏览偏好保存在本机用户配置中。迁移到另一台电脑时，这些偏好需要单独备份。', 'Appearance, backgrounds and browsing preferences are saved in this device’s user profile. Back them up separately when moving to another computer.')}</p>
    {paths ? <div className="nw-preference-card">{([['defaultTaskLocation', '默认任务文件夹', 'Default task folders'], ['home', '应用数据', 'App data'], ['artifacts', '成果', 'Outputs'], ['state', '任务记录', 'Task records']] as const).map(([key, zh, en]) => <div className="nw-preference-row" key={key}><div><strong>{t(zh, en)}</strong><p className="nw-location-path">{paths[key]}</p></div><div className="nw-preference-control nw-location-actions"><button className="nw-icon" title={t('复制路径', 'Copy path')} aria-label={t(`复制${zh}路径`, `Copy ${en} path`)} onClick={() => void navigator.clipboard.writeText(paths[key]).then(() => setNotice(t('路径已复制', 'Path copied'))).catch(cause => setError(errorText(cause)))}><Copy size={15} /></button><button className="nw-button" aria-label={t(`打开${zh}`, `Open ${en}`)} title={!connectionInfo?.capabilities.openPath ? t('在桌面应用中打开文件夹', 'Open folders in the desktop app') : paths[key]} disabled={!connectionInfo?.capabilities.openPath} onClick={() => void request('desktop/open-location', { location: key }).catch(cause => setError(errorText(cause)))}><FolderOpen size={15} />{t('打开', 'Open')}</button></div></div>)}</div> : !error && <div className="nw-settings-loading" role="status">{connection === 'connected' && <Loader2 size={17} className="nw-spin" />}<span>{connection === 'connected' ? t('正在读取文件位置…', 'Loading file locations…') : t('连接工作引擎后查看文件位置。', 'Connect your engine to view file locations.')}</span></div>}
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
  </section>;
}
