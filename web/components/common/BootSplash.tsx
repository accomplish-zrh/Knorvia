"use client";

/**
 * Boot splash v3 — keep in lockstep with desktop/main.js `loadingPage()`.
 *
 * Quiet room, one light, one mark, one line. No breathing logo, no dual
 * spinners, no orbiting motes. Choreography (~1.9s hold, 0.58s curtain):
 *   0.00s  dual-lobe aura (the mark's own blue / amber) blooms
 *   0.08s  logo arrives — lift, tiny scale, brief focus
 *   0.22s  a single hairline arc draws, then drifts like a clock
 *   0.34s  wordmark: tracking settles, almost no travel
 *   0.50s  status fades (no tracking — Chinese copy)
 *   0.64s  signature rule grows from the centre
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
    const fadeTimer = window.setTimeout(() => setPhase("fading"), reduced ? 280 : 1900);
    const goneTimer = window.setTimeout(() => setPhase("gone"), reduced ? 480 : 2480);
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

      <div className="boot-emblem relative flex h-32 w-32 items-center justify-center">
        <span className="boot-aura" />
        <svg className="boot-halo" viewBox="0 0 128 128" fill="none">
          <g transform="rotate(-108 64 64)">
            <circle cx="64" cy="64" r="61.5" />
          </g>
        </svg>
        <Image
          src="/logo.png"
          alt=""
          width={78}
          height={78}
          priority
          className="boot-logo relative z-10 h-[78px] w-[78px] object-contain"
        />
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
            opacity 0.58s cubic-bezier(0.22, 1, 0.36, 1),
            transform 0.58s cubic-bezier(0.22, 1, 0.36, 1),
            filter 0.58s cubic-bezier(0.22, 1, 0.36, 1);
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
          width: 380px;
          height: 250px;
          margin-left: -190px;
          margin-top: -125px;
          border-radius: 50%;
          pointer-events: none;
          filter: blur(14px);
          background:
            radial-gradient(circle at 36% 40%, rgba(80, 150, 230, 0.22), transparent 46%),
            radial-gradient(circle at 66% 60%, rgba(236, 154, 82, 0.18), transparent 48%),
            radial-gradient(
              circle at 50% 50%,
              color-mix(in srgb, var(--primary) 12%, transparent),
              transparent 58%
            );
          animation: boot-aura-in 1.35s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        html.dark .boot-aura {
          filter: blur(16px);
          background:
            radial-gradient(circle at 36% 40%, rgba(80, 150, 230, 0.42), transparent 46%),
            radial-gradient(circle at 66% 60%, rgba(236, 154, 82, 0.36), transparent 48%),
            radial-gradient(
              circle at 50% 50%,
              color-mix(in srgb, var(--primary) 22%, transparent),
              transparent 60%
            );
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

        .boot-logo {
          animation: boot-arrive 0.95s 0.08s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes boot-arrive {
          from {
            opacity: 0;
            transform: translateY(12px) scale(0.96);
            filter: blur(7px);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
            filter: blur(0);
          }
        }

        .boot-halo {
          position: absolute;
          inset: 0;
          width: 128px;
          height: 128px;
          color: var(--primary);
          pointer-events: none;
          animation: boot-drift 36s linear infinite;
        }
        .boot-halo circle {
          fill: none;
          stroke: currentColor;
          stroke-width: 1;
          stroke-linecap: round;
          stroke-dasharray: 168 386;
          opacity: 0.7;
          animation: boot-draw 1.15s 0.22s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @keyframes boot-draw {
          from {
            stroke-dashoffset: 168;
            opacity: 0;
          }
          to {
            stroke-dashoffset: 0;
            opacity: 0.7;
          }
        }
        @keyframes boot-drift {
          to {
            transform: rotate(360deg);
          }
        }

        .boot-wordmark {
          margin: 32px 0 0;
          letter-spacing: 0.06em;
          animation: boot-word 0.9s 0.34s cubic-bezier(0.16, 1, 0.3, 1) both;
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
          animation: boot-status-in 0.7s 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
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
          width: 52px;
          height: 1px;
          overflow: hidden;
        }
        .boot-rule span {
          display: block;
          height: 100%;
          width: 100%;
          transform-origin: center;
          background: color-mix(in srgb, var(--primary) 55%, transparent);
          animation: boot-rule-in 0.85s 0.64s cubic-bezier(0.22, 1, 0.36, 1) both;
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
          .boot-halo,
          .boot-halo circle,
          .boot-wordmark,
          .boot-status,
          .boot-rule span {
            animation: none;
          }
          .boot-logo,
          .boot-halo circle,
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
