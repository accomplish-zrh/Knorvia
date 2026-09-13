"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { ArrowLeftRight, Check, PanelTop, SunMedium } from "lucide-react";
import { WORKBENCH_STYLE_KEY, workbenchStylePreference, type WorkbenchStyle } from "@/lib/native-workbench-style";
import { useWorkbench } from "./NativeWorkbenchProvider";
import { useLocalPreference } from "./useLocalPreference";

const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** Keep this mounted in the workbench layout, outside route-specific content. */
export function WorkbenchStyleSync() {
  const [style] = useLocalPreference(WORKBENCH_STYLE_KEY, workbenchStylePreference);
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  useLayoutEffect(() => {
    // The server snapshot is Minimal. Preserve the inline script's saved choice
    // until useLocalPreference has read its client snapshot, including StrictMode.
    if (hydrated) document.documentElement.setAttribute("data-workbench-style", style);
  }, [hydrated, style]);
  return null;
}

export function WorkbenchStyleToggle() {
  const { t } = useWorkbench();
  const [style, update] = useLocalPreference(WORKBENCH_STYLE_KEY, workbenchStylePreference);
  const luminous = style === "luminous";
  const label = luminous
    ? t("当前界面：澄光，切换为简约", "Current style: Luminous. Switch to Minimal")
    : t("当前界面：简约，切换为澄光", "Current style: Minimal. Switch to Luminous");
  const Icon = luminous ? SunMedium : PanelTop;
  return <button type="button" className="nw-workbench-style-toggle" aria-label={label} title={label} onClick={() => update(current => current === "luminous" ? "minimal" : "luminous")}>
    <Icon size={14} aria-hidden="true" />
    <span>{luminous ? t("澄光", "Luminous") : t("简约", "Minimal")}</span>
    <ArrowLeftRight size={12} className="nw-workbench-style-toggle-arrow" aria-hidden="true" />
  </button>;
}

function StylePreview({ style }: { style: WorkbenchStyle }) {
  return <span className="nw-workbench-style-preview" data-style={style} aria-hidden="true">
    <span className="nw-workbench-style-preview-rail"><i /><b /><b /><b /><b /></span>
    <span className="nw-workbench-style-preview-main">
      <span className="nw-workbench-style-preview-top"><span>{"Knorvia"}</span><i /></span>
      <span className="nw-workbench-style-preview-copy"><i /><b /><b /></span>
      <span className="nw-workbench-style-preview-composer"><i /><b /></span>
      <span className="nw-workbench-style-preview-hints"><i /><i /><i /></span>
    </span>
  </span>;
}

export function WorkbenchStyleChoices() {
  const { t } = useWorkbench();
  const [style, update] = useLocalPreference(WORKBENCH_STYLE_KEY, workbenchStylePreference);
  const choices: { id: WorkbenchStyle; title: string; description: string }[] = [
    { id: "minimal", title: t("简约", "Minimal"), description: t("清晰而克制，让内容成为焦点。", "Clear and understated. Put your work in focus.") },
    { id: "luminous", title: t("澄光", "Luminous"), description: t("柔和光感与浅水蓝，轻盈有层次。", "Soft light and aqua tones, with room to breathe.") },
  ];
  return <section className="nw-preference-section nw-workbench-style-section">
    <div className="nw-appearance-heading"><h2>{t("界面风格", "Interface style")}</h2><span>{t("随时切换", "Make it yours")}</span></div>
    <div className="nw-workbench-style-choices" role="group" aria-label={t("界面风格", "Interface style")}>
      {choices.map(choice => <button type="button" key={choice.id} className="nw-workbench-style-choice" aria-pressed={style === choice.id} onClick={() => update(() => choice.id)}>
        <StylePreview style={choice.id} />
        <span className="nw-workbench-style-choice-label"><span><strong>{choice.title}</strong><small>{choice.description}</small></span><span className="nw-workbench-style-check" aria-hidden="true">{style === choice.id && <Check size={13} />}</span></span>
      </button>)}
    </div>
  </section>;
}
