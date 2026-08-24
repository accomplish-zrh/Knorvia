"use client";

import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";

/** Small copy-to-clipboard chip used by code block headers. */
export default function CopyButton({
  text,
  label,
  copiedLabel,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-secure contexts (desktop http origin).
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(textarea);
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [text]);

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? (copiedLabel ?? "Copied") : (label ?? "Copy")}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors ${
        copied
          ? "text-emerald-400"
          : "opacity-70 hover:opacity-100 hover:bg-white/10"
      }`}
      style={{ color: copied ? "#34d399" : undefined }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      <span>{copied ? (copiedLabel ?? "Copied") : (label ?? "Copy")}</span>
    </button>
  );
}
