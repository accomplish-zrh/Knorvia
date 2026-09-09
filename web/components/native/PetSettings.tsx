"use client";

import { useState } from 'react';
import { Cat } from 'lucide-react';
import { PetManager } from './PetManager';
import { useLocalPreference } from './useLocalPreference';
import { useWorkbench } from './NativeWorkbenchProvider';

export function PetSettings() {
  const { t } = useWorkbench();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useLocalPreference('knorvia-pet-enabled-v1', raw => raw === 'true');
  return <section className="nw-preference-section">
    <h2>{t('宠物伙伴', 'Companions')}</h2>
    <div className="nw-preference-card">
      <div className="nw-preference-row"><div><strong>{t('显示宠物', 'Show companion')}</strong><p>{t('在工作台陪伴你，随任务进展做出回应。', 'A companion that responds to your task progress.')}</p></div><button type="button" className="nw-appearance-switch" role="switch" aria-label={t('显示宠物', 'Show companion')} aria-checked={enabled} onClick={() => setEnabled(value => !value)}><span /></button></div>
      <div className="nw-preference-row"><div><strong>{t('我的伙伴', 'My companions')}</strong><p>{t('选用内置伙伴、导入宠物包，或用图片模型创建。', 'Choose the built-in companion, import a package, or create one with an image model.')}</p></div><button type="button" className="nw-button" onClick={() => setOpen(true)}><Cat size={16} />{t('管理伙伴', 'Manage companions')}</button></div>
    </div>
    {open && <PetManager close={() => setOpen(false)} changed={() => setEnabled(() => true)} />}
  </section>;
}
