"use client";
import { useCallback, useEffect, useState } from 'react';
import { BatteryLow, MoonStar } from 'lucide-react';
import { errorText, useWorkbench } from './NativeWorkbenchProvider';

// C20: user control for "keep the computer awake during long tasks". The
// blocker only runs while authoritative tasks (durable running Turns,
// managed CLI jobs) are active, has a maximum duration, and never blocks on
// battery unless the user opts in. An idle or minimized app stays sleepable.
type PowerState = {
  blocking: boolean;
  windowExpired: boolean;
  onBattery: boolean;
  expiresAt: number | null;
  stoppedReason: string;
  preferences: { enabled: boolean; onBattery: 'keep' | 'release' };
  references: { key: string; reason: string; at: string }[];
};

export function PowerSettings() {
  const { request, connection, t } = useWorkbench();
  const [state, setState] = useState<PowerState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (connection !== 'connected') return;
    try { setState(await request<PowerState>('power/read', {})); } catch (cause) { setError(errorText(cause)); }
  }, [request, connection]);
  useEffect(() => { void refresh(); }, [refresh]);
  const update = async (patch: { enabled?: boolean; onBattery?: 'keep' | 'release' }) => {
    setBusy(true); setError('');
    try { setState(await request<PowerState>('power/update', patch)); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return <section className="nw-preference-section nw-power-settings"><h2>{t('电源与长任务', 'Power and long tasks')}</h2>
    <p className="nw-help">{t('开启后，有正在运行的任务时电脑不会自动休眠（屏幕仍会正常关闭）。空闲或最小化时不会阻止休眠；使用电池时可改为不保持唤醒。手动休眠电脑始终有效，恢复后应用只重新读取任务状态。', 'While enabled, the computer stays awake during running tasks (the screen still turns off normally). Idle or minimized windows never block sleep. On battery you can choose not to keep the system awake. Manually sleeping the PC always works; the app only re-reads task state after resume.')}</p>
    <div className="nw-preference-card">
      <div className="nw-preference-row"><div><strong>{t('执行长任务时保持电脑唤醒', 'Keep the computer awake during long tasks')}</strong>
        <p>{state ? (state.blocking
          ? t('正在保持唤醒（最多 4 小时）', 'Awake (at most 4 hours)')
          : state.preferences.enabled ? t('当前没有需要保持唤醒的任务', 'No active task needs to keep the computer awake') : t('已关闭', 'Off')) : ''}</p></div>
        <div className="nw-preference-control"><input type="checkbox" aria-label={t('执行长任务时保持电脑唤醒', 'Keep the computer awake during long tasks')} disabled={busy || connection !== 'connected'} checked={state?.preferences.enabled ?? true} onChange={(event) => void update({ enabled: event.target.checked })} /></div>
      </div>
      <div className="nw-preference-row"><div><strong>{t('使用电池时', 'On battery power')}</strong>
        <p>{state?.onBattery ? t('当前使用电池', 'On battery now') : t('当前使用外接电源', 'On AC power now')}</p></div>
        <div className="nw-preference-control"><select aria-label={t('电池策略', 'Battery policy')} disabled={busy || connection !== 'connected'} value={state?.preferences.onBattery ?? 'keep'} onChange={(event) => void update({ onBattery: event.target.value as 'keep' | 'release' })}>
          <option value="keep">{t('保持唤醒', 'Keep awake')}</option>
          <option value="release">{t('不保持唤醒', "Don't keep awake")}</option>
        </select></div>
      </div>
      {state?.blocking && state.references.length > 0 && <div className="nw-preference-row"><div><strong>{t('保持唤醒的原因', 'Why the system is kept awake')}</strong>
        <p>{state.references.map((reference) => reference.reason).join('；')}</p></div>
        <div className="nw-preference-control"><BatteryLow size={16} /></div>
      </div>}
      {state && !state.blocking && state.stoppedReason === 'resumed' && <div className="nw-preference-row"><div><strong><MoonStar size={14} /> {t('系统刚刚恢复', 'The system just resumed')}</strong><p>{t('已重新读取任务状态；需要时由真实任务重新保持唤醒。', 'Task state re-read; a real task re-acquires the wake lock when needed.')}</p></div></div>}
    </div>
    {error && <p className="nw-inline-error" role="alert">{error}</p>}
  </section>;
}
