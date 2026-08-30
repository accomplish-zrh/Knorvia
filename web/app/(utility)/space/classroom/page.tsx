"use client";

/**
 * AI Classroom hub (OpenMAIC-inspired): generate an interactive micro-lesson
 * from one topic, then play it — teacher + classmates + quizzes + a live
 * class discussion. Generation streams OpenMAIC-style progress events.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  deleteClassroom,
  generateClassroom,
  listClassrooms,
  type ClassroomCard,
  type GenerationProgress,
} from "@/lib/classroom-api";

export default function ClassroomPage() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const [cards, setCards] = useState<ClassroomCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [topic, setTopic] = useState("");
  const [minutes, setMinutes] = useState(12);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    void listClassrooms()
      .then(setCards)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  const startGeneration = () => {
    if (!topic.trim() || generating) return;
    setGenerating(true);
    setError("");
    setProgress(null);
    void generateClassroom(
      {
        topic: topic.trim(),
        minutes,
        language: i18n.language?.startsWith("zh") ? "zh" : "en",
      },
      setProgress,
    )
      .then((result) => {
        router.push(`/space/classroom/${encodeURIComponent(result.id)}`);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : t("Generation failed"));
        setGenerating(false);
      });
  };

  const progressLabel = (p: GenerationProgress) => {
    if (p.step === "generating_scenes") {
      return t("Writing scene {{n}}/{{total}}…", {
        n: (p.scenes_generated ?? 0) + 1,
        total: p.total_scenes ?? "?",
      });
    }
    if (p.step === "generating_outlines") return t("Drafting the lesson outline…");
    if (p.step === "completed") return t("Lesson ready");
    return t("Preparing…");
  };

  return (
    <div data-classroom-page="" className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-[var(--foreground)]">
            {t("AI Classroom")}
          </h1>
          <p className="mt-1 text-[13px] text-[var(--muted-foreground)]">
            {t(
              "One topic in — a full class out: an AI teacher, AI classmates, quizzes, and a live discussion.",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3.5 py-2 text-[13px] font-medium text-[var(--primary-foreground)]"
        >
          {showForm ? <Loader2 className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {t("New lesson")}
        </button>
      </div>

      {showForm && (
        <div data-classroom-create="" className="mt-4 rounded-2xl border border-[var(--border)] p-4">
          <label className="mb-1.5 block text-[12px] font-medium text-[var(--foreground)]">
            {t("What should this class teach?")}
          </label>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={2}
            disabled={generating}
            placeholder={t("e.g. Recursion in programming · How compound interest works")}
            className="w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-[13.5px] outline-none focus:border-[var(--ring)]"
          />
          <div className="mt-3 flex items-center gap-3">
            <label className="text-[12px] text-[var(--muted-foreground)]">
              {t("Length")}
            </label>
            <select
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              disabled={generating}
              className="rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--ring)]"
            >
              {[8, 12, 20, 30].map((value) => (
                <option key={value} value={value}>
                  {t("~{{minutes}} min", { minutes: value })}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={startGeneration}
              disabled={!topic.trim() || generating}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-2 text-[13px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
            >
              <Sparkles size={14} />
              {t("Generate class")}
            </button>
          </div>
          {generating && progress && (
            <div
              data-classroom-progress=""
              className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-[12.5px] text-[var(--muted-foreground)]"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {progressLabel(progress)}
            </div>
          )}
          {error && <p className="mt-2 text-[12.5px] text-red-500">{error}</p>}
        </div>
      )}

      <div className="mt-5 space-y-2.5">
        {loading ? (
          <Loader2 className="mx-auto mt-8 h-5 w-5 animate-spin text-[var(--muted-foreground)]" />
        ) : cards.length === 0 ? (
          <p className="mt-8 text-center text-[13px] text-[var(--muted-foreground)]">
            {t("No lessons yet — generate your first class above.")}
          </p>
        ) : (
          cards.map((card) => (
            <div
              key={card.id}
              className="group flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 transition-colors hover:border-[var(--ring)]"
            >
              <Link
                href={`/space/classroom/${encodeURIComponent(card.id)}`}
                className="min-w-0 flex-1"
              >
                <p className="truncate text-[14px] font-medium text-[var(--foreground)]">
                  {card.title || card.topic}
                </p>
                <p className="mt-0.5 truncate text-[11.5px] text-[var(--muted-foreground)]">
                  {card.topic} · {card.scene_count} {t("scenes")}
                </p>
              </Link>
              <button
                type="button"
                onClick={() => {
                  void deleteClassroom(card.id).then(refresh);
                }}
                className="rounded-md p-1.5 text-[var(--muted-foreground)] opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                aria-label={t("Delete")}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
