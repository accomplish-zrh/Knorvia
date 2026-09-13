"use client";

import { useSyncExternalStore, type CSSProperties } from "react";
import { Check, Layers2, RotateCcw } from "lucide-react";
import { THEMES, THEME_PALETTES } from "@/lib/theme";
import { DEFAULT_FROST_CLARITY, DEFAULT_FROST_PLATES } from "@/lib/window-frost";
import { useWorkbench } from "./NativeWorkbenchProvider";
import { ReadingSettings } from './ReadingSettings';
import { BackgroundSettings } from './BackgroundSettings';
import { PetSettings } from './PetSettings';
import { WorkbenchStyleChoices } from './WorkbenchStyle';

const subscribe = () => () => {};
const environment = () => !window.knorviaDesktop ? "browser" : window.knorviaDesktop.chrome?.backdropSupported === false ? "unsupported" : "desktop";

export function AppearanceSettings() {
  const { t, theme, chooseTheme, frost, setFrost } = useWorkbench();
  const host = useSyncExternalStore(subscribe, environment, () => "browser");
  const palette = THEME_PALETTES[theme];
  return <>
    <WorkbenchStyleChoices />
    <section className="nw-preference-section">
      <div className="nw-appearance-heading"><h2>{t("主题", "Theme")}</h2><span>{t("切换即生效", "Changes apply instantly")}</span></div>
      <div className="nw-theme-choices" role="group" aria-label={t("主题", "Theme")}>
        {THEMES.map(id => {
          const entry = THEME_PALETTES[id];
          return <button type="button" key={id} aria-label={t(entry.zh, entry.en)} aria-pressed={theme === id} className="nw-theme-choice" onClick={() => chooseTheme(id)}>
            <span className="nw-theme-miniature" aria-hidden="true" style={{ "--mini-bg": entry.colors.bg, "--mini-side": entry.colors.sidebar, "--mini-ink": entry.colors.ink, "--mini-line": entry.colors.line, "--mini-action": entry.colors.action } as CSSProperties}>
              <i className="nw-mini-sidebar"><b /><b /><b /></i><i className="nw-mini-conversation"><b /><b /><b /><i /></i>
            </span>
            <span className="nw-theme-label"><span><strong>{t(entry.zh, entry.en)}</strong><small>{t(entry.descriptionZh, entry.descriptionEn)}</small></span><span className="nw-theme-check" aria-hidden="true">{theme === id && <Check size={13} />}</span></span>
          </button>;
        })}
      </div>
    </section>
    <section className="nw-preference-section">
      <div className="nw-appearance-heading"><h2>{t("玻璃效果", "Glass effect")}</h2><span>{t("适用于所有主题", "Available with every theme")}</span></div>
      <div className="nw-glass-card">
        <div className="nw-glass-heading"><span className="nw-glass-icon"><Layers2 size={20} /></span><div><strong>{t("亚克力磨砂", "Frosted acrylic")}</strong><p>{t("柔化窗后背景，保留清晰的文字。", "Soften the view behind your window. Keep the text crisp.")}</p></div><button type="button" className="nw-appearance-switch" role="switch" aria-label={t("玻璃效果", "Glass effect")} aria-checked={frost.enabled} aria-describedby="nw-glass-support" onClick={() => setFrost({ ...frost, enabled: !frost.enabled })}><span /></button></div>
        <div className={`nw-glass-controls ${frost.enabled ? "is-enabled" : ""}`}>
          <div className="nw-glass-preview" role="img" aria-label={t("当前主题的玻璃效果示意", "Illustration of glass in the current theme")}>
            <div className="nw-glass-preview-window" style={{ "--preview-canvas": frost.enabled ? `${Math.round(100 - frost.clarity * .88)}%` : "100%", "--preview-plate": frost.enabled ? `${Math.round(62 + frost.plates * .34)}%` : "100%" } as CSSProperties}>
              <div className="nw-glass-preview-caption"><i /><i /><i /><span>{"Knorvia"}</span></div><div className="nw-glass-preview-copy"><strong>{t("让想法更进一步", "Room for your next idea")}</strong><span>{t(palette.zh, palette.en)} · {frost.enabled ? t("玻璃已开启", "Glass on") : t("实色外观", "Solid appearance")}</span></div><div className="nw-glass-preview-input"><span>{t("开始一段对话…", "Start a conversation…")}</span><i>↑</i></div>
            </div>
          </div>
          <fieldset disabled={!frost.enabled} className="nw-glass-sliders"><legend className="nw-sr-only">{t("玻璃参数", "Glass controls")}</legend>
            <label className="nw-appearance-slider"><span><strong>{t("透明度", "Transparency")}</strong><output>{frost.clarity}%</output></span><input type="range" min="0" max="100" step="1" aria-label={t("透明度", "Transparency")} aria-valuetext={`${frost.clarity}%`} value={frost.clarity} onChange={event => setFrost({ ...frost, clarity: Number(event.target.value) })} style={{ "--range-value": `${frost.clarity}%` } as CSSProperties} /><small>{t("越高，窗后背景越明显。", "Higher values reveal more of the background.")}</small></label>
            <label className="nw-appearance-slider"><span><strong>{t("阅读区域底色", "Reading surface")}</strong><output>{frost.plates}%</output></span><input type="range" min="0" max="100" step="1" aria-label={t("阅读区域底色", "Reading surface")} aria-valuetext={`${frost.plates}%`} value={frost.plates} onChange={event => setFrost({ ...frost, plates: Number(event.target.value) })} style={{ "--range-value": `${frost.plates}%` } as CSSProperties} /><small>{t("加深输入框、菜单和卡片的底色。", "Give composers, menus and cards a more solid base.")}</small></label>
          </fieldset>
        </div>
        <footer className="nw-glass-footer"><p id="nw-glass-support">{host === "desktop" ? t("窗口后的背景由系统柔化。关闭效果会恢复实色，调节值会保留。", "Your system softens the background behind the window. Turning glass off preserves your adjustments.") : host === "unsupported" ? t("当前系统采用实色显示；玻璃偏好仍会保留。", "This system uses solid surfaces. Your glass preferences are still saved.") : t("这里可预览与调节外观。使用桌面版时，可透出窗口后的背景。", "Preview and adjust the look here. The desktop app can reveal the background behind its window.")}</p><button type="button" className="nw-button nw-button-small" onClick={() => setFrost({ ...frost, clarity: DEFAULT_FROST_CLARITY, plates: DEFAULT_FROST_PLATES })} disabled={frost.clarity === DEFAULT_FROST_CLARITY && frost.plates === DEFAULT_FROST_PLATES}><RotateCcw size={13} />{t("重置参数", "Reset controls")}</button></footer>
      </div>
      <p className="nw-settings-footnote">{t("主题与玻璃设置自动保存在此设备上。", "Your theme and glass settings are saved automatically on this device.")}</p>
    </section>
    <BackgroundSettings />
    <ReadingSettings />
    <PetSettings />
  </>;
}
