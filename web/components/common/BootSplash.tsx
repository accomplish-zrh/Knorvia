"use client";

/**
 * Boot splash — the app-entry loading animation (v2).
 *
 * Choreography (total ~1.6s, then 450ms fade):
 *   0.00s  logo scales in from 0.86 with a soft settle
 *   0.15s  two orbit rings draw themselves in (conic wipe), motes light up
 *          and start counter-rotating at different speeds
 *   0.30s  wordmark rises with letter-spacing easing from wide to normal
 *   0.42s  status line rises
 *   0.55s  progress bar appears; its sweep is a moving gradient (indeterminate
 *          shimmer, not a scaleX loop) so it reads as "working" not "looping"
 *   exit   whole splash fades + scales up 1.02 — feels like a door opening
 *
 * All motion is CSS-only; reduced-motion collapses to a static logo + text.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Image from "next/image";

export default function BootSplash() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"visible" | "fading" | "gone">("visible");

  useEffect(() => {
    const fadeTimer = window.setTimeout(() => setPhase("fading"), 1600);
    const goneTimer = window.setTimeout(() => setPhase("gone"), 2100);
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
      {/* Emblem: rings draw in around the breathing logo */}
      <div className="boot-emblem relative flex h-32 w-32 items-center justify-center">
        <span className="boot-ring boot-ring-outer absolute inset-0 rounded-full" />
        <span className="boot-ring boot-ring-inner absolute inset-[14px] rounded-full" />
        <Image
          src="/logo.png"
          alt=""
          width={76}
          height={76}
          priority
          className="boot-logo relative z-10 h-[76px] w-[76px] object-contain"
        />
        {/* Motes ride the outer ring via nested rotators (no layout thrash) */}
        <span className="boot-orbit absolute inset-0">
          <i className="boot-mote" />
        </span>
        <span className="boot-orbit boot-orbit-rev absolute inset-[14px]">
          <i className="boot-mote boot-mote-dim" />
        </span>
      </div>

      <h1 className="boot-wordmark mt-7 font-serif text-[22px] font-semibold text-[var(--foreground)]">
        {t("Knorvia")}
      </h1>
      <p className="boot-status mt-1.5 text-[12px] leading-none text-[var(--muted-foreground)]">
        {t("正在启动桌面 AI 引擎…")}
      </p>

      {/* Indeterminate shimmer bar */}
      <div
        className="boot-bar mt-7 h-[3px] w-44 overflow-hidden rounded-full bg-[var(--muted)]"
        role="presentation"
      >
        <span className="boot-bar-fill block h-full w-full rounded-full" />
      </div>

      <style jsx global>{`
        .boot-root {
          opacity: 1;
          transition:
            opacity 0.45s ease-out,
            transform 0.45s ease-out;
        }
        .boot-exit {
          opacity: 0;
          transform: scale(1.02);
        }

        /* Logo: settle-in, then a slow breathe */
        .boot-logo {
          animation:
            boot-settle 0.65s cubic-bezier(0.16, 1, 0.3, 1) both,
            boot-breathe 2.2s 0.65s ease-in-out infinite;
        }
        @keyframes boot-settle {
          from {
            opacity: 0;
            transform: scale(0.86);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        @keyframes boot-breathe {
          0%,
          100% {
            transform: scale(1);
          }
          50% {
            transform: scale(0.955);
          }
        }

        /* Rings draw themselves with a conic-gradient wipe */
        .boot-ring {
          border-radius: 9999px;
          animation: boot-ring-in 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        .boot-ring-outer {
          background: conic-gradient(
            from 180deg,
            var(--primary) 0deg,
            color-mix(in srgb, var(--primary) 26%, transparent) 110deg,
            transparent 200deg,
            transparent 360deg
          );
          -webkit-mask: radial-gradient(
            farthest-side,
            transparent calc(100% - 1.5px),
            #000 calc(100% - 1.5px)
          );
          mask: radial-gradient(
            farthest-side,
            transparent calc(100% - 1.5px),
            #000 calc(100% - 1.5px)
          );
        }
        .boot-ring-inner {
          animation-delay: 0.12s;
          background: conic-gradient(
            from 0deg,
            color-mix(in srgb, var(--primary) 55%, transparent) 0deg,
            transparent 140deg,
            transparent 360deg
          );
          -webkit-mask: radial-gradient(
            farthest-side,
            transparent calc(100% - 1px),
            #000 calc(100% - 1px)
          );
          mask: radial-gradient(
            farthest-side,
            transparent calc(100% - 1px),
            #000 calc(100% - 1px)
          );
        }
        @keyframes boot-ring-in {
          from {
            opacity: 0;
            transform: rotate(-120deg) scale(0.92);
          }
          to {
            opacity: 1;
            transform: rotate(0deg) scale(1);
          }
        }

        /* Motes orbit on dedicated layers (transform-only) */
        .boot-orbit {
          animation: boot-spin 1.9s linear infinite;
        }
        .boot-orbit-rev {
          animation-duration: 2.9s;
          animation-direction: reverse;
        }
        @keyframes boot-spin {
          to {
            transform: rotate(360deg);
          }
        }
        .boot-mote {
          position: absolute;
          top: -2.5px;
          left: calc(50% - 2.5px);
          display: block;
          width: 5px;
          height: 5px;
          border-radius: 9999px;
          background: var(--primary);
          box-shadow: 0 0 10px 1px color-mix(in srgb, var(--primary) 55%, transparent);
          animation: boot-mote-in 0.5s 0.35s both;
        }
        .boot-mote-dim {
          width: 4px;
          height: 4px;
          top: auto;
          bottom: -2px;
          opacity: 0.6;
          box-shadow: none;
        }
        @keyframes boot-mote-in {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        /* Wordmark: rise + tracking settles from airy to normal */
        .boot-wordmark {
          margin-block: 28px 6px;
          animation: boot-rise-track 0.75s 0.18s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes boot-rise-track {
          from {
            opacity: 0;
            transform: translateY(10px);
            letter-spacing: 0.14em;
          }
          to {
            opacity: 1;
            transform: translateY(0);
            letter-spacing: -0.02em;
          }
        }
        .boot-status {
          animation: boot-rise-track 0.75s 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
        }

        /* Progress: gradient shimmer travels through the track */
        .boot-bar {
          opacity: 0;
          animation: boot-fade-in 0.4s 0.5s ease-out both;
        }
        .boot-bar-fill {
          background: linear-gradient(
            90deg,
            transparent 0%,
            color-mix(in srgb, var(--primary) 70%, transparent) 30%,
            var(--primary) 50%,
            color-mix(in srgb, var(--primary) 70%, transparent) 70%,
            transparent 100%
          );
          background-size: 220% 100%;
          animation: boot-shimmer 1.25s linear infinite;
        }
        @keyframes boot-shimmer {
          from {
            background-position: 130% 0;
          }
          to {
            background-position: -90% 0;
          }
        }
        @keyframes boot-fade-in {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .boot-logo,
          .boot-ring,
          .boot-orbit,
          .boot-bar-fill,
          .boot-wordmark,
          .boot-status,
          .boot-bar {
            animation: none;
          }
          .boot-ring,
          .boot-bar,
          .boot-mote,
          .boot-status,
          .boot-wordmark {
            opacity: 1;
          }
          .boot-root {
            transition: opacity 0.2s ease-out;
          }
        }
      `}</style>
    </div>
  );
}
