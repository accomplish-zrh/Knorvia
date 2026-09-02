"use client";

/**
 * Boot splash v4 — keep in lockstep with desktop/main.js `loadingPage()`.
 *
 * Glass plate, mint/lavender light, one sheen. No breathing logo, no dual
 * spinners, no orbiting motes. Choreography (~2.1s hold, 0.62s curtain):
 *   0.00s  mint + lavender aura blooms (the mark's own glass)
 *   0.10s  squircle arrives — lift, tiny scale, brief focus
 *   0.22s  a squircle hairline draws, then a light walks the rim
 *   0.40s  a single diagonal sheen crosses the plate
 *   0.48s  wordmark: tracking settles
 *   0.64s  status fades (no tracking — Chinese copy)
 *   0.78s  mint→lavender rule grows from the centre
 *   exit   curtain lift: fade + rise + soft blur (not a zoom)
 *
 * CSS-only. Reduced motion: static composition, short fade.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Image from "next/image";
import { initI18n } from "@/i18n/init";

const i18n = initI18n();

export default function BootSplash() {
  const { t } = useTranslation("app", { i18n });
  const [phase, setPhase] = useState<"visible" | "fading" | "gone">("visible");

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fadeTimer = window.setTimeout(() => setPhase("fading"), reduced ? 280 : 2100);
    const goneTimer = window.setTimeout(() => setPhase("gone"), reduced ? 480 : 2720);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(goneTimer);
    };
  }, []);

  if (phase === "gone") return null;

  return (
    <div
      aria-hidden="true"
      className={`boot-root fixed inset-0 z-[200] flex flex-col items-center justify-center bg-[var(--background)] ${
        phase === "fading" ? "boot-exit pointer-events-none" : ""
      }`}
    >
      <div
        data-desktop-drag=""
        aria-hidden
        className="desktop-drag-hit absolute inset-x-0 top-0 h-9"
      />

      <div className="boot-emblem relative flex h-[136px] w-[136px] items-center justify-center">
        <span className="boot-aura" />
        <svg className="boot-halo" viewBox="0 0 136 136" fill="none">
          <rect x="8" y="8" width="120" height="120" rx="28" ry="28" />
        </svg>
        <div className="boot-mark">
          <Image
            src="/logo.png"
            alt=""
            width={100}
            height={100}
            priority
            className="boot-logo brand-mark relative z-10 h-[100px] w-[100px] object-contain"
          />
          <span className="boot-sheen" />
        </div>
      </div>

      <h1 className="boot-wordmark font-serif text-[21px] font-semibold text-[var(--foreground)]">
        {t("Knorvia")}
      </h1>
      <p className="boot-status text-[12px] leading-none text-[var(--muted-foreground)]">
        {t("正在启动桌面 AI 引擎…")}
      </p>
      <div className="boot-rule" role="presentation">
        <span />
      </div>

      <style jsx global>{`
        .boot-root {
          user-select: none;
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          transition:
            opacity 0.62s cubic-bezier(0.22, 1, 0.36, 1),
            transform 0.62s cubic-bezier(0.22, 1, 0.36, 1),
            filter 0.62s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .boot-exit {
          opacity: 0;
          transform: translateY(-10px);
          filter: blur(8px);
        }

        .boot-aura {
          position: absolute;
          left: 50%;
          top: 50%;
          width: 420px;
          height: 280px;
          margin-left: -210px;
          margin-top: -140px;
          border-radius: 50%;
          pointer-events: none;
          filter: blur(16px);
          background:
            radial-gradient(circle at 34% 38%, rgba(143, 212, 200, 0.34), transparent 48%),
            radial-gradient(circle at 68% 62%, rgba(183, 182, 227, 0.3), transparent 50%),
            radial-gradient(circle at 50% 50%, rgba(186, 206, 214, 0.16), transparent 58%);
          animation: boot-aura-in 1.4s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        html.dark .boot-aura {
          filter: blur(18px);
          background:
            radial-gradient(circle at 34% 38%, rgba(143, 212, 200, 0.48), transparent 48%),
            radial-gradient(circle at 68% 62%, rgba(183, 182, 227, 0.44), transparent 50%),
            radial-gradient(circle at 50% 50%, rgba(186, 206, 214, 0.22), transparent 60%);
        }
        @keyframes boot-aura-in {
          from {
            opacity: 0;
            transform: scale(0.78);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }

        .boot-mark {
          position: relative;
          z-index: 2;
          width: 100px;
          height: 100px;
          overflow: hidden;
          border-radius: 22px;
        }
        .boot-logo {
          animation: boot-arrive 0.95s 0.1s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes boot-arrive {
          from {
            opacity: 0;
            transform: translateY(10px) scale(0.94);
            filter: blur(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
            filter: blur(0);
          }
        }

        .boot-sheen {
          position: absolute;
          inset: -30%;
          pointer-events: none;
          background: linear-gradient(
            115deg,
            transparent 36%,
            rgba(255, 255, 255, 0.55) 50%,
            transparent 64%
          );
          animation: boot-sheen 1.15s 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        html.dark .boot-sheen {
          background: linear-gradient(
            115deg,
            transparent 36%,
            rgba(255, 255, 255, 0.28) 50%,
            transparent 64%
          );
        }
        @keyframes boot-sheen {
          from {
            transform: translateX(-130%);
            opacity: 0;
          }
          18% {
            opacity: 1;
          }
          to {
            transform: translateX(130%);
            opacity: 0;
          }
        }

        .boot-halo {
          position: absolute;
          inset: 0;
          width: 136px;
          height: 136px;
          color: #8bb8c4;
          pointer-events: none;
        }
        html.dark .boot-halo {
          color: #a8c8d4;
        }
        .boot-halo rect {
          fill: none;
          stroke: currentColor;
          stroke-width: 1.15;
          stroke-linecap: round;
          stroke-dasharray: 150 432;
          opacity: 0.7;
          animation:
            boot-draw 1.15s 0.22s cubic-bezier(0.22, 1, 0.36, 1) both,
            boot-orbit 28s 1.4s linear infinite;
        }
        @keyframes boot-draw {
          from {
            stroke-dashoffset: 150;
            opacity: 0;
          }
          to {
            stroke-dashoffset: 0;
            opacity: 0.7;
          }
        }
        @keyframes boot-orbit {
          to {
            stroke-dashoffset: -432;
          }
        }

        .boot-wordmark {
          margin: 28px 0 0;
          letter-spacing: 0.06em;
          animation: boot-word 0.9s 0.48s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes boot-word {
          from {
            opacity: 0;
            transform: translateY(6px);
            letter-spacing: 0.2em;
          }
          to {
            opacity: 1;
            transform: translateY(0);
            letter-spacing: 0.06em;
          }
        }

        .boot-status {
          margin: 10px 0 0;
          animation: boot-status-in 0.7s 0.64s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes boot-status-in {
          from {
            opacity: 0;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .boot-rule {
          margin-top: 28px;
          width: 56px;
          height: 1px;
          overflow: hidden;
        }
        .boot-rule span {
          display: block;
          height: 100%;
          width: 100%;
          transform-origin: center;
          background: linear-gradient(90deg, #8fd4c8, #b7b6e3);
          animation: boot-rule-in 0.85s 0.78s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @keyframes boot-rule-in {
          from {
            transform: scaleX(0);
            opacity: 0;
          }
          to {
            transform: scaleX(1);
            opacity: 1;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .boot-aura,
          .boot-logo,
          .boot-sheen,
          .boot-halo rect,
          .boot-wordmark,
          .boot-status,
          .boot-rule span {
            animation: none;
          }
          .boot-logo,
          .boot-halo rect,
          .boot-wordmark,
          .boot-status,
          .boot-rule span {
            opacity: 1;
            transform: none;
            filter: none;
            letter-spacing: 0.06em;
            stroke-dashoffset: 0;
          }
          .boot-aura {
            opacity: 1;
            transform: none;
          }
          .boot-sheen {
            opacity: 0;
          }
          .boot-root {
            transition: opacity 0.2s ease-out;
          }
          .boot-exit {
            transform: none;
            filter: none;
          }
        }
      `}</style>
    </div>
  );
}
