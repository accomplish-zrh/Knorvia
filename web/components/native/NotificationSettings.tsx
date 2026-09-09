"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, Loader2 } from "lucide-react";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";

type Preferences = { enabled: boolean; completed: boolean; failed: boolean; interrupted: boolean; cancelled: boolean; needsInput: boolean; sound: boolean; quietHours: boolean; quietStart: string; quietEnd: string; locale: string };
type State = { preferences: Preferences; supported: boolean; persistent: boolean; storageError: boolean };

export function NotificationSettings() {
  const { request, connection, t, locale } = useWorkbench();
  const [state, setState] = useState<State>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    if (connection !== 'connected') return;
    let alive = true;
    request<State>('notifications/read').then(value => { if (alive) setState(value); }).catch(cause => { if (alive) setError(errorText(cause)); });
    return () => { alive = false; };
  }, [request, connection]);
  async function save(value: Partial<Preferences>) {
    if (lock.current) return;
    lock.current = true; setSaving(true); setError('');
    try { setState(await request<State>('notifications/update', { ...value, locale })); }
    catch (cause) { setError(errorText(cause)); } finally { lock.current = false; setSaving(false); }
  }
  return <section className="nw-preference-section nw-notification-settings"><h2><Bell size={18} /> {t('任务通知', 'Task notifications')}</h2>
    <p className="nw-help">{t('任务结束后在后台提醒你。正在查看应用时不打扰，点击通知可回到对应任务。', 'Get a notification when a task finishes in the background. Click it to return to the task.')}</p>
    {state && !state.supported && <p className="nw-help" role="status">{t('此预览环境不发送系统通知。可保存偏好，在桌面应用中使用。', 'System notifications are unavailable in this preview. These preferences are available in the desktop app.')}</p>}
    {state?.storageError && <p className="nw-inline-error" role="alert">{t('无法读取已保存的通知设置，当前保持只读。原设置文件已保留。', 'Saved notification settings could not be read. The original file is preserved and settings are read-only.')}</p>}
    {!state && !error && <div className="nw-settings-loading" role="status">{connection === 'connected' && <Loader2 size={17} className="nw-spin" />}<span>{connection === 'connected' ? t('正在读取通知偏好…', 'Loading notification preferences…') : t('连接工作引擎后设置通知。', 'Connect your engine to configure notifications.')}</span></div>}
    {state && <fieldset disabled={saving || state.storageError} aria-busy={saving} className="nw-provider-editor-fields"><legend className="nw-sr-only">{t('任务通知偏好', 'Task notification preferences')}</legend><div className="nw-preference-card">
      {([['enabled', '允许任务通知', 'Enable task notifications'], ['completed', '任务完成', 'Completed'], ['needsInput', '需要我确认或补充', 'Needs my attention'], ['failed', '任务失败', 'Failed'], ['interrupted', '任务中断', 'Interrupted'], ['cancelled', '任务取消', 'Cancelled'], ['sound', '播放声音', 'Play a sound'], ['quietHours', '定时免打扰', 'Quiet hours']] as const).map(([key, zh, en]) => <div key={key} className="nw-preference-row"><strong>{t(zh, en)}</strong><button type="button" className="nw-appearance-switch" role="switch" aria-label={t(zh, en)} aria-checked={state.preferences[key]} onClick={() => void save({ [key]: !state.preferences[key] })}><span /></button></div>)}
      {state.preferences.quietHours && <div className="nw-preference-row"><span>{t('本地时间', 'Local time')}</span><div className="nw-preference-control nw-quiet-hours-control"><label><span>{t('开始', 'From')}</span><input type="time" aria-label={t('免打扰开始', 'Quiet hours start')} value={state.preferences.quietStart} onChange={event => void save({ quietStart: event.target.value })} /></label><span>{t('至', 'to')}</span><label><span>{t('结束', 'To')}</span><input type="time" aria-label={t('免打扰结束', 'Quiet hours end')} value={state.preferences.quietEnd} onChange={event => void save({ quietEnd: event.target.value })} /></label></div></div>}
    </div></fieldset>}
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
  </section>;
}
