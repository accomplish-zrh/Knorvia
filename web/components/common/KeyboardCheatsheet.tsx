"use client";

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CHAT_CHEATSHEET } from "@/lib/keyboard-cheatsheet";

export default function KeyboardCheatsheet({
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
      role="dialog"
      aria-modal="true"
      aria-label={t("Keyboard shortcuts")}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[360px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--popover)] shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--border)] px-4 py-3 text-[13px] font-semibold text-[var(--foreground)]">
          {t("Keyboard shortcuts")}
        </div>
        <ul className="py-2">
          {CHAT_CHEATSHEET.map((row) => (
            <li
              key={row.keys}
              className="flex items-center justify-between gap-3 px-4 py-1.5 text-[13px]"
            >
              <span className="text-[var(--muted-foreground)]">{t(row.action)}</span>
              <kbd className="rounded-md border border-[var(--border)] bg-[var(--muted)]/50 px-1.5 py-0.5 font-mono text-[11px] text-[var(--foreground)]">
                {row.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
