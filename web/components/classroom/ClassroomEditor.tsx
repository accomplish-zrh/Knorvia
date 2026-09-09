"use client";

/**
 * AI Classroom editor (T4) — per-scene atomic edits over PATCH ops.
 *
 * Every save builds a small op list (set / retitle / quiz_edit / reorder /
 * insert_blank / delete_scene) and sends it as ONE transaction; the server
 * answers 409 naming the failing op, or 200 with the fresh document the
 * player refreshes from. The html textarea mirrors the server's safety
 * gate for a save-time preview only — the backend stays authoritative.
 */

import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  FilePlus2,
  Loader2,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  ClassroomDocument,
  ClassroomQuizQuestion,
  ClassroomScene,
} from "@/lib/classroom-api";

export type ClassroomEditOp = Record<string, unknown>;

const DEGRADE_PATTERNS: [string, RegExp][] = [
  ["<script src>", /<script\b[^>]*\bsrc\s*=/i],
  ["srcdoc", /\bsrcdoc\s*=/i],
  ["javascript:", /javascript\s*:/i],
];

const STRIP_PATTERNS: [string, RegExp][] = [
  ["fetch(", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["import(", /\bimport\s*\(/],
  ["window.top/parent", /\bwindow\s*\.\s*(?:top|parent)\b/],
  ["localStorage", /\blocalStorage\b/],
  ["<form action>", /\s+action\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i],
];

/** Client-side preview of the server's deterministic safety gate. */
function scanWidgetHtml(html: string): { degrade: string[]; strip: string[] } {
  const degrade = DEGRADE_PATTERNS.filter(([, re]) => re.test(html)).map(([n]) => n);
  const strip = STRIP_PATTERNS.filter(([, re]) => re.test(html)).map(([n]) => n);
  return { degrade, strip };
}

export default function ClassroomEditor({
  document: doc,
  scene,
  sceneIndex,
  onApply,
  onNavigate,
}: {
  document: ClassroomDocument;
  scene: ClassroomScene;
  sceneIndex: number;
  onApply: (ops: ClassroomEditOp[]) => Promise<ClassroomDocument>;
  onNavigate: (index: number) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(scene.title);
  const [objective, setObjective] = useState(scene.objective || "");
  const [keyPoints, setKeyPoints] = useState(scene.key_points.join("\n"));
  const [narration, setNarration] = useState((scene.narration || []).join("\n"));
  const [html, setHtml] = useState(scene.html || "");
  const [questions, setQuestions] = useState<ClassroomQuizQuestion[]>(
    JSON.parse(JSON.stringify(scene.questions || [])) as ClassroomQuizQuestion[],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  // The player remounts this component with key={scene.id} on navigation,
  // so the draft state always starts from the freshly selected scene.

  const lines = (value: string) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  const htmlScan = useMemo(
    () => (scene.type === "interactive" ? scanWidgetHtml(html) : null),
    [scene.type, html],
  );

  const runApply = async (ops: ClassroomEditOp[]) => {
    if (busy || ops.length === 0) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await onApply(ops);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Edit failed"));
    } finally {
      setBusy(false);
    }
  };

  const saveContent = () => {
    const ops: ClassroomEditOp[] = [];
    if (title !== scene.title) {
      ops.push({ type: "retitle", scene_id: scene.id, title });
    }
    if (objective !== (scene.objective || "")) {
      ops.push({ type: "set", scene_id: scene.id, field: "objective", value: objective });
    }
    if (lines(keyPoints).join("\n") !== scene.key_points.join("\n")) {
      ops.push({
        type: "set",
        scene_id: scene.id,
        field: "key_points",
        value: lines(keyPoints),
      });
    }
    if (scene.type === "interactive") {
      if (lines(narration).join("\n") !== (scene.narration || []).join("\n")) {
        ops.push({
          type: "set",
          scene_id: scene.id,
          field: "narration",
          value: lines(narration),
        });
      }
      if (html !== (scene.html || "") && !(htmlScan && htmlScan.degrade.length > 0)) {
        ops.push({ type: "set", scene_id: scene.id, field: "html", value: html });
      }
    }
    return runApply(ops);
  };

  const saveQuiz = () => {
    if (scene.type !== "quiz") return;
    return runApply([
      { type: "quiz_edit", scene_id: scene.id, questions },
    ]);
  };

  const move = (direction: -1 | 1) => {
    const target = sceneIndex + direction;
    if (target < 0 || target >= doc.scenes.length) return;
    const ids = doc.scenes.map((s) => s.id);
    const moved = [...ids];
    moved[sceneIndex] = ids[target];
    moved[target] = ids[sceneIndex];
    return runApply([{ type: "reorder", ordered_ids: moved }]).then(() => {
      onNavigate(target);
    });
  };

  const removeScene = () => {
    if (doc.scenes.length <= 1) return;
    const nextIndex = Math.max(0, sceneIndex - 1);
    return runApply([{ type: "delete_scene", scene_id: scene.id }]).then(() => {
      onNavigate(nextIndex);
    });
  };

  const insertBlank = () => {
    return runApply([{ type: "insert_blank", at: sceneIndex + 1 }]).then(() => {
      onNavigate(sceneIndex + 1);
    });
  };

  const updateQuestion = (index: number, patch: Partial<ClassroomQuizQuestion>) => {
    setQuestions((prev) =>
      prev.map((q, i) => (i === index ? { ...q, ...patch } : q)),
    );
  };

  const quizDraftValid = questions.every((q) => {
    if (!q.question.trim()) return false;
    if (q.type === "short") return Boolean(q.analysis?.trim());
    if ((q.options || []).length < 2) return false;
    const parts = (q.answer || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return false;
    return parts.every((p) => /^\d+$/.test(p) && Number(p) < (q.options || []).length);
  });

  return (
    <div
      data-classroom-editor=""
      className="space-y-4 rounded-2xl border border-[var(--ring)] bg-[var(--card)] p-4"
    >
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--foreground)]">
        {t("Edit scene")}
      </p>

      <label className="block">
        <span className="text-[11.5px] text-[var(--muted-foreground)]">{t("Title")}</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-1.5 text-[13px] outline-none focus:border-[var(--ring)]"
        />
      </label>
      <label className="block">
        <span className="text-[11.5px] text-[var(--muted-foreground)]">{t("Objective")}</span>
        <input
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-1.5 text-[13px] outline-none focus:border-[var(--ring)]"
        />
      </label>
      <label className="block">
        <span className="text-[11.5px] text-[var(--muted-foreground)]">
          {t("Key points (one per line)")}
        </span>
        <textarea
          value={keyPoints}
          onChange={(e) => setKeyPoints(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-1.5 text-[13px] outline-none focus:border-[var(--ring)]"
        />
      </label>

      {scene.type === "interactive" && (
        <>
          <label className="block">
            <span className="text-[11.5px] text-[var(--muted-foreground)]">
              {t("Narration (one per line)")}
            </span>
            <textarea
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-1.5 text-[13px] outline-none focus:border-[var(--ring)]"
            />
          </label>
          <label className="block">
            <span className="text-[11.5px] text-[var(--muted-foreground)]">
              {t("Widget HTML source")}
            </span>
            <textarea
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              rows={6}
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--ring)]"
            />
          </label>
          {htmlScan && htmlScan.degrade.length > 0 && (
            <p className="flex items-center gap-1.5 text-[12px] text-red-500" data-editor-html-warning="">
              <TriangleAlert size={13} />
              {t("The server will reject this html: {{items}}", {
                items: htmlScan.degrade.join(", "),
              })}
            </p>
          )}
          {htmlScan && htmlScan.degrade.length === 0 && htmlScan.strip.length > 0 && (
            <p className="text-[12px] text-[var(--muted-foreground)]" data-editor-html-warning="">
              {t("Unsafe constructs will be stripped: {{items}}", {
                items: htmlScan.strip.join(", "),
              })}
            </p>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-editor-save=""
          onClick={() => void saveContent()}
          disabled={busy || Boolean(htmlScan && htmlScan.degrade.length > 0)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : null}
          {saved ? t("Saved") : t("Save changes")}
        </button>
        <span className="mx-1 h-4 w-px bg-[var(--border)]" />
        <button
          type="button"
          onClick={() => void move(-1)}
          disabled={busy || sceneIndex === 0}
          title={t("Move up")}
          className="rounded-lg border border-[var(--border)] p-1.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-40"
        >
          <ArrowUp size={13} />
        </button>
        <button
          type="button"
          onClick={() => void move(1)}
          disabled={busy || sceneIndex >= doc.scenes.length - 1}
          title={t("Move down")}
          className="rounded-lg border border-[var(--border)] p-1.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-40"
        >
          <ArrowDown size={13} />
        </button>
        <button
          type="button"
          onClick={() => void insertBlank()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[12px] text-[var(--foreground)] disabled:opacity-40"
        >
          <FilePlus2 size={13} />
          {t("Insert blank page")}
        </button>
        <button
          type="button"
          onClick={() => void removeScene()}
          disabled={busy || doc.scenes.length <= 1}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[12px] text-red-500 disabled:opacity-40"
        >
          <Trash2 size={13} />
          {t("Delete this page")}
        </button>
      </div>

      {scene.type === "quiz" && (
        <div className="space-y-3 rounded-xl border border-[var(--border)] p-3" data-editor-quiz="">
          <p className="text-[12px] font-medium text-[var(--foreground)]">
            {t("Quiz editor")}
          </p>
          {questions.map((question, qIndex) => (
            <div key={qIndex} className="space-y-2 rounded-lg border border-[var(--border)] p-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[var(--muted-foreground)]">
                  {qIndex + 1}
                </span>
                <select
                  value={question.type}
                  onChange={(e) =>
                    updateQuestion(qIndex, {
                      type: e.target.value as ClassroomQuizQuestion["type"],
                    })
                  }
                  className="rounded-lg border border-[var(--border)] bg-transparent px-2 py-1 text-[12px] outline-none focus:border-[var(--ring)]"
                >
                  <option value="single">{t("Single choice")}</option>
                  <option value="multiple">{t("Multiple choice")}</option>
                  <option value="short">{t("Short answer")}</option>
                </select>
                <button
                  type="button"
                  onClick={() =>
                    setQuestions((prev) => prev.filter((_, i) => i !== qIndex))
                  }
                  className="ml-auto rounded-md p-1 text-[var(--muted-foreground)] hover:text-red-500"
                  aria-label={t("Remove")}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <input
                value={question.question}
                onChange={(e) => updateQuestion(qIndex, { question: e.target.value })}
                placeholder={t("Question")}
                className="w-full rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--ring)]"
              />
              {question.type !== "short" ? (
                <>
                  <label className="block">
                    <span className="text-[11px] text-[var(--muted-foreground)]">
                      {t("Options (one per line)")}
                    </span>
                    <textarea
                      value={(question.options || []).join("\n")}
                      onChange={(e) =>
                        updateQuestion(qIndex, {
                          options: e.target.value.split("\n"),
                        })
                      }
                      rows={2}
                      className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--ring)]"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-[var(--muted-foreground)]">
                      {t("Answer (option indexes, e.g. 0 or 0,2)")}
                    </span>
                    <input
                      value={question.answer || ""}
                      onChange={(e) => updateQuestion(qIndex, { answer: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--ring)]"
                    />
                  </label>
                </>
              ) : (
                <label className="block">
                  <span className="text-[11px] text-[var(--muted-foreground)]">
                    {t("Analysis / rubric (required)")}
                  </span>
                  <textarea
                    value={question.analysis || ""}
                    onChange={(e) => updateQuestion(qIndex, { analysis: e.target.value })}
                    rows={2}
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--ring)]"
                  />
                </label>
              )}
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setQuestions((prev) => [
                  ...prev,
                  { id: `q-${Date.now().toString(36)}`, type: "single", question: "", options: ["", ""], answer: "0", analysis: "", points: 1 },
                ])
              }
              disabled={questions.length >= 4}
              className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[12px] text-[var(--foreground)] disabled:opacity-40"
            >
              {t("Add question")}
            </button>
            <button
              type="button"
              data-editor-save-quiz=""
              onClick={() => void saveQuiz()}
              disabled={busy || !quizDraftValid || questions.length === 0}
              className="ml-auto rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
            >
              {t("Save quiz")}
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-[12px] text-red-500">{error}</p>}
    </div>
  );
}
