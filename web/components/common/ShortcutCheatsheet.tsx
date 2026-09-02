"use client";

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { APP_SHORTCUTS } from "@/lib/keyboard-shortcuts";

export default function ShortcutCheatsheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="animate-overlay-in fixed inset-0 z-[130] flex items-start justify-center bg-[var(--overlay)] p-4 pt-[16vh] backdrop-blur-[6px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("Keyboard shortcuts")}
    >
      <div
        className="chrome-card w-full max-w-md overflow-hidden border border-[var(--border)] bg-[var(--card)] shadow-[0_24px_60px_-20px_rgba(16,21,28,0.35)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-[14px] font-semibold text-[var(--foreground)]">
            {t("Keyboard shortcuts")}
          </h2>
          <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
            {t("Esc")}
          </kbd>
        </div>
        <ul className="divide-y divide-[var(--border)]/60 p-1.5">
          {APP_SHORTCUTS.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px]"
            >
              <span className="text-[var(--foreground)]">{t(item.label)}</span>
              <kbd className="shrink-0 rounded border border-[var(--border)] bg-[var(--muted)]/40 px-1.5 py-0.5 font-mono text-[11px] text-[var(--muted-foreground)]">
                {item.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
