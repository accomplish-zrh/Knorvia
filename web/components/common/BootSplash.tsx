"use client";

/**
 * Boot splash — the app-entry loading animation.
 *
 * Rendered by the root layout until the workspace UI signals readiness
 * (first paint + fonts + i18n init). Pure CSS animation, zero JS on the
 * animation itself; the fade-out is a class swap so it never janks.
 *
 * Visual: the Knorvia logo breathes while three orbiting motes trace a
 * ring around it and a slim progress line sweeps underneath — quiet,
 * branded, and gone in about a second.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Image from "next/image";

export default function BootSplash() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"visible" | "fading" | "gone">("visible");

  useEffect(() => {
    // Minimum display so a fast boot doesn't flash; then fade, then unmount.
    const fadeTimer = window.setTimeout(() => setPhase("fading"), 900);
    const goneTimer = window.setTimeout(() => setPhase("gone"), 1500);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(goneTimer);
    };
  }, []);

  if (phase === "gone") return null;

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-0 z-[200] flex flex-col items-center justify-center bg-[var(--background)] transition-opacity duration-500 ease-out ${
        phase === "fading" ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      {/* Logo with orbiting motes */}
      <div className="boot-ring relative flex h-28 w-28 items-center justify-center">
        <Image
          src="/logo.png"
          alt=""
          width={72}
          height={72}
          priority
          className="boot-breathe relative z-10 h-[72px] w-[72px] object-contain"
        />
        <span className="boot-mote boot-mote-1 absolute inset-0 rounded-full border border-[var(--primary)]/30" />
        <span className="boot-mote boot-mote-2 absolute inset-0 rounded-full border border-[var(--primary)]/20" />
        <span className="boot-dot absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--primary)]" />
      </div>

      <p
        className="mt-5 font-serif text-[21px] font-semibold tracking-[-0.02em] text-[var(--foreground)]"
        style={{ animation: "boot-rise 0.7s cubic-bezier(0.16, 1, 0.3, 1) both" }}
      >
        {t("Knorvia")}
      </p>
      <p
        className="mt-1 text-[12px] text-[var(--muted-foreground)]"
        style={{ animation: "boot-rise 0.7s 0.12s cubic-bezier(0.16, 1, 0.3, 1) both" }}
      >
        {t("正在启动桌面 AI 引擎…")}
      </p>

      {/* Sweeping progress line */}
      <div className="mt-6 h-[2px] w-40 overflow-hidden rounded-full bg-[var(--muted)]">
        <div className="boot-sweep h-full w-full origin-left rounded-full bg-[var(--primary)]" />
      </div>

      <style jsx global>{`
        @keyframes boot-breathe {
          0%,
          100% {
            transform: scale(1);
            opacity: 1;
          }
          50% {
            transform: scale(0.94);
            opacity: 0.88;
          }
        }
        @keyframes boot-spin {
          to {
            transform: translate(-50%, -50%) rotate(360deg);
          }
        }
        @keyframes boot-sweep {
          0% {
            transform: scaleX(0);
            opacity: 0.4;
          }
          55% {
            transform: scaleX(0.75);
            opacity: 1;
          }
          100% {
            transform: scaleX(1);
            opacity: 0.25;
          }
        }
        @keyframes boot-rise {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .boot-breathe {
          animation: boot-breathe 1.8s ease-in-out infinite;
        }
        .boot-mote {
          animation: boot-spin 2.4s linear infinite;
        }
        .boot-mote::before {
          content: "";
          position: absolute;
          top: -3px;
          left: 50%;
          width: 6px;
          height: 6px;
          margin-left: -3px;
          border-radius: 9999px;
          background: var(--primary);
          opacity: 0.85;
        }
        .boot-mote-2 {
          animation-duration: 3.4s;
          animation-direction: reverse;
        }
        .boot-mote-2::before {
          top: auto;
          bottom: -3px;
          opacity: 0.55;
        }
        .boot-dot {
          animation: boot-breathe 1.8s ease-in-out infinite;
        }
        .boot-sweep {
          animation: boot-sweep 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .boot-breathe,
          .boot-mote,
          .boot-dot,
          .boot-sweep {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
