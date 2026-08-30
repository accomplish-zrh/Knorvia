"use client";

/**
 * AI Classroom player — OpenMAIC-inspired (MIT, © 2026 THU-MAIC).
 *
 * A lesson is a deterministic action timeline: the player walks scenes,
 * reveals speech actions in order (with a length-derived beat so it reads
 * like a lecture), pauses on quiz/discussion actions, and can open a live
 * stateless discussion (the server picks the next speaker per call; the
 * state round-trips from the client).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookPlus,
  ChevronRight,
  Loader2,
  MessagesSquare,
  Save,
  SkipForward,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  discussionTurn,
  exportClassroomToNotebook,
  gradeQuizScene,
  saveClassroomQuestions,
  type ClassroomAction,
  type ClassroomAgentProfile,
  type ClassroomDocument,
  type ClassroomQuizQuestion,
  type ClassroomScene,
  type DiscussionState,
  type GradeResult,
} from "@/lib/classroom-api";

/** Length-derived beat per speech line (OpenMAIC's no-TTS fallback). */
function speechBeatMs(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const words = text.length - cjk;
  return Math.min(9000, 1400 + cjk * 130 + Math.ceil(words / 5) * 260);
}

interface SpeechLine {
  agentId: string;
  text: string;
}

export default function ClassroomPlayer({
  document: doc,
  onBack,
  onToast,
}: {
  document: ClassroomDocument;
  onBack: () => void;
  onToast?: (message: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [sceneIndex, setSceneIndex] = useState(0);
  const [lines, setLines] = useState<SpeechLine[]>([]);
  const [phase, setPhase] = useState<"idle" | "playing">("playing");
  const consumedDiscussions = useRef(new Set<string>());
  const [discussion, setDiscussion] = useState<null | {
    seed: string;
    transcript: { agentId: string; text: string }[];
    state: DiscussionState;
    pending: string;
    live: boolean;
  }>(null);
  const [quizState, setQuizState] = useState<null | {
    sceneId: string;
    results: GradeResult[] | null;
    answers: Record<string, string>;
    savedToBank: boolean;
  }>(null);
  const [savedNotebook, setSavedNotebook] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scene = doc.scenes[sceneIndex];
  const profileFor = useMemo(() => {
    const map = new Map<string, ClassroomAgentProfile>();
    for (const profile of doc.agent_profiles) map.set(profile.id, profile);
    return (id: string) => map.get(id);
  }, [doc.agent_profiles]);

  // (Re)play the current scene's speech timeline whenever the scene changes.
  useEffect(() => {
    if (!scene) return;
    const speeches = scene.actions.filter(
      (a): a is Extract<ClassroomAction, { type: "speech" }> => a.type === "speech",
    );
    setLines([]);
    setPhase("playing");
    let cancelled = false;
    let index = 0;
    const step = () => {
      if (cancelled) return;
      if (index >= speeches.length) {
        setPhase("idle");
        onSpeechesDone(scene);
        return;
      }
      const action = speeches[index];
      setLines((prev) => [
        ...prev,
        { agentId: action.agent_id || "teacher", text: action.text || "" },
      ]);
      index += 1;
      window.setTimeout(step, speechBeatMs(action.text || ""));
    };
    const kickoff = window.setTimeout(step, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(kickoff);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene?.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines.length, discussion?.transcript.length]);

  /** The scene's tail interaction (OpenMAIC discussion/quiz consumption). */
  const onSpeechesDone = (current: ClassroomScene) => {
    const discussionAction = current.actions.find((a) => a.type === "discussion");
    if (discussionAction && !consumedDiscussions.current.has(current.id)) {
      consumedDiscussions.current.add(current.id);
      setDiscussion({
        seed: discussionAction.prompt || current.objective || current.title,
        transcript: [],
        state: { turn_count: 0, summaries: [] },
        pending: "",
        live: false,
      });
      return;
    }
    const quizAction = current.actions.find((a) => a.type === "quiz_trigger");
    if (quizAction && current.questions?.length) {
      setQuizState({ sceneId: current.id, results: null, answers: {}, savedToBank: false });
    }
  };

  const gotoScene = (next: number) => {
    if (next < 0 || next >= doc.scenes.length) return;
    setDiscussion(null);
    setQuizState(null);
    setSceneIndex(next);
  };

  const startDiscussion = (userMessage: string) => {
    if (!scene || !discussion) return;
    setDiscussion({ ...discussion, live: true });
    void runDiscussionTurn(userMessage);
  };

  const runDiscussionTurn = async (userMessage: string) => {
    if (!discussion || !doc.id || !scene) return;
    const base = {
      scene_id: scene.id,
      scene_title: scene.title,
      scene_key_points: scene.key_points,
      seed_prompt: discussion.seed,
      transcript: discussion.transcript.map((line) => ({
        agent_id: line.agentId,
        text: line.text,
      })),
      summaries: discussion.state.summaries,
      turn_count: discussion.state.turn_count,
      pending_question: discussion.pending,
      quiz_results: (quizState?.results ?? []) as GradeResult[],
      user_message: userMessage,
    };
    try {
      const result = await discussionTurn(
        doc.id,
        base,
        {
          onAgentStart: (agentId) =>
            setDiscussion((prev) =>
              prev
                ? {
                    ...prev,
                    transcript: [
                      ...prev.transcript,
                      { agentId, text: "…" },
                    ],
                  }
                : prev,
            ),
          onDelta: (agentId, text) =>
            setDiscussion((prev) => {
              if (!prev) return prev;
              const transcript = [...prev.transcript];
              const last = transcript[transcript.length - 1];
              if (last && last.agentId === agentId && last.text === "…") {
                transcript[transcript.length - 1] = { agentId, text };
              } else if (last && last.agentId === agentId) {
                transcript[transcript.length - 1] = {
                  agentId,
                  text: last.text + text,
                };
              } else {
                transcript.push({ agentId, text });
              }
              return { ...prev, transcript };
            }),
        },
      );
      setDiscussion((prev) =>
        prev ? { ...prev, state: result.state, live: result.next !== "END" } : prev,
      );
    } catch {
      setDiscussion((prev) => (prev ? { ...prev, live: false } : prev));
    }
  };

  if (!scene) return null;
  const progress = ((sceneIndex + 1) / doc.scenes.length) * 100;

  return (
    <div data-classroom-player="" className="flex h-full min-h-0 flex-col">
      {/* Header: back, title, scene progress */}
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          aria-label={t("Back")}
        >
          <ArrowLeft size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-[var(--foreground)]">
            {doc.title}
          </p>
          <div className="mt-1 h-1 w-full max-w-xs overflow-hidden rounded-full bg-[var(--muted)]">
            <div
              className="h-full rounded-full bg-[var(--primary)] transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <span className="shrink-0 text-[11.5px] text-[var(--muted-foreground)]">
          {sceneIndex + 1} / {doc.scenes.length}
        </span>
        <button
          type="button"
          data-classroom-save-notebook=""
          onClick={() => {
            void exportClassroomToNotebook(doc.id).then(() => {
              setSavedNotebook(true);
              onToast?.(t("Lesson saved to notebook"));
            });
          }}
          disabled={savedNotebook}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2 py-1 text-[11.5px] text-[var(--foreground)] disabled:opacity-50"
          title={t("Save to notebook")}
        >
          {savedNotebook ? <Save size={12} /> : <BookPlus size={12} />}
          {savedNotebook ? t("Saved") : t("Save to notebook")}
        </button>
      </div>

      {/* Stage: key-point card + speech lines */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
        data-classroom-stage=""
      >
        <div className="mx-auto max-w-2xl space-y-4">
          <div
            data-classroom-card=""
            className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-sm"
          >
            <p className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
              {scene.type === "quiz" ? t("Quiz") : scene.type === "discussion" ? t("Discussion") : t("Lesson")}
            </p>
            <h2 className="mt-1 text-[19px] font-semibold text-[var(--foreground)]">
              {scene.title}
            </h2>
            {scene.key_points.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {scene.key_points.map((point, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[13.5px] leading-relaxed text-[var(--foreground)]"
                  >
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--primary)]" />
                    {point}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {lines.map((line, i) => {
            const profile = profileFor(line.agentId);
            return (
              <div key={i} className="flex items-start gap-2.5">
                <span
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                  style={{ backgroundColor: profile?.color || "#3b82f6" }}
                >
                  {(profile?.name || line.agentId).slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    {profile?.name || line.agentId}
                    {profile?.role === "teacher" ? ` · ${t("Teacher")}` : ""}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-[var(--foreground)]">
                    {line.text}
                  </p>
                </div>
              </div>
            );
          })}

          {phase === "playing" && (
            <div className="flex items-center gap-2 pl-9 text-[12px] text-[var(--muted-foreground)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("The class is in session…")}
            </div>
          )}

          {quizState && quizState.sceneId === scene.id && (
            <QuizCard
              questions={scene.questions || []}
              results={quizState.results}
              answers={quizState.answers}
              onAnswer={(questionId, value) =>
                setQuizState((prev) =>
                  prev
                    ? {
                        ...prev,
                        answers: { ...prev.answers, [questionId]: value },
                      }
                    : prev,
                )
              }
              onSubmit={() => {
                void gradeQuizScene(
                  doc.id,
                  scene.id,
                  quizState.answers,
                ).then((results) =>
                  setQuizState((prev) =>
                    prev ? { ...prev, results } : prev,
                  ),
                );
              }}
              onSaveWrong={() => {
                if (!quizState.results || quizState.savedToBank) return;
                const entries = quizState.results.map((result) => ({
                  question_id: result.question_id,
                  user_answer: result.given,
                  is_correct: result.correct,
                }));
                void saveClassroomQuestions(doc.id, scene.id, entries).then(() =>
                  setQuizState((prev) =>
                    prev ? { ...prev, savedToBank: true } : prev,
                  ),
                );
                onToast?.(t("Wrong answers saved to the question bank"));
              }}
              savedToBank={quizState.savedToBank}
              onToast={onToast}
            />
          )}

          {discussion && (
            <div
              data-classroom-discussion=""
              className="rounded-2xl border border-[var(--ring)] bg-[var(--accent)]/60 p-4"
            >
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--foreground)]">
                <MessagesSquare size={14} className="text-[var(--primary)]" />
                {t("Class discussion")}
              </p>
              <p className="mt-1.5 text-[13px] text-[var(--foreground)]">
                {discussion.seed}
              </p>
              {discussion.transcript.map((line, i) => {
                const profile = profileFor(line.agentId);
                return (
                  <div key={i} className="mt-2.5 flex items-start gap-2">
                    <span
                      className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: profile?.color || "#3b82f6" }}
                    />
                    <p className="text-[12.5px] leading-relaxed text-[var(--foreground)]">
                      <span className="font-medium">{profile?.name || line.agentId}: </span>
                      {line.text}
                    </p>
                  </div>
                );
              })}
              <DiscussionInput
                live={discussion.live}
                onSend={(message) => startDiscussion(message)}
                onSkip={() => gotoScene(sceneIndex + 1)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Footer: scene navigation */}
      <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-2.5">
        <button
          type="button"
          onClick={() => gotoScene(sceneIndex - 1)}
          disabled={sceneIndex === 0}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12.5px] text-[var(--foreground)] disabled:opacity-40"
        >
          {t("Previous")}
        </button>
        {phase === "playing" ? (
          <button
            type="button"
            onClick={() => {
              const speeches = scene.actions.filter(
                (a): a is Extract<ClassroomAction, { type: "speech" }> =>
                  a.type === "speech",
              );
              setLines(
                speeches.map((a) => ({
                  agentId: a.agent_id || "teacher",
                  text: a.text || "",
                })),
              );
              setPhase("idle");
              onSpeechesDone(scene);
            }}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <SkipForward size={13} />
            {t("Skip narration")}
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => gotoScene(sceneIndex + 1)}
          disabled={sceneIndex >= doc.scenes.length - 1}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
        >
          {t("Next scene")}
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

function QuizCard({
  questions,
  results,
  answers,
  onAnswer,
  onSubmit,
  onSaveWrong,
  savedToBank,
  onToast,
}: {
  questions: ClassroomQuizQuestion[];
  results: GradeResult[] | null;
  answers: Record<string, string>;
  onAnswer: (questionId: string, value: string) => void;
  onSubmit: () => void;
  onSaveWrong?: () => void;
  savedToBank?: boolean;
  onToast?: (message: string) => void;
}) {
  const { t } = useTranslation();
  const resultFor = (id: string) => results?.find((r) => r.question_id === id);
  const allAnswered = questions.every((q) => (answers[q.id] ?? "").trim() !== "");

  return (
    <div
      data-classroom-quiz=""
      className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4"
    >
      {questions.map((question, qIndex) => {
        const result = resultFor(question.id);
        return (
          <div key={question.id}>
            <p className="text-[13.5px] font-medium text-[var(--foreground)]">
              {qIndex + 1}. {question.question}
            </p>
            {question.type !== "short" ? (
              <div className="mt-2 space-y-1.5">
                {(question.options || []).map((option, oIndex) => {
                  const value = String(oIndex);
                  const selected = answers[question.id] === value;
                  return (
                    <button
                      key={oIndex}
                      type="button"
                      onClick={() => onAnswer(question.id, value)}
                      className={`block w-full rounded-lg border px-3 py-1.5 text-left text-[13px] transition-colors ${
                        selected
                          ? "border-[var(--ring)] bg-[var(--accent)]"
                          : "border-[var(--border)] hover:border-[var(--ring)]"
                      }`}
                    >
                      {String.fromCharCode(65 + oIndex)}. {option}
                    </button>
                  );
                })}
              </div>
            ) : (
              <textarea
                value={answers[question.id] || ""}
                onChange={(e) => onAnswer(question.id, e.target.value)}
                rows={2}
                className="mt-2 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-[13px] outline-none focus:border-[var(--ring)]"
                placeholder={t("Type your answer…")}
              />
            )}
            {result && (
              <p
                className={`mt-1.5 text-[12px] ${
                  result.correct
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-500"
                }`}
              >
                {result.correct ? "✓ " : "✗ "}
                {result.comment || result.analysis}
              </p>
            )}
          </div>
        );
      })}
      {results === null && (
        <button
          type="button"
          onClick={onSubmit}
          disabled={!allAnswered}
          className="rounded-lg bg-[var(--primary)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
        >
          {t("Submit answers")}
        </button>
      )}
      {results !== null && onSaveWrong && (
        <button
          type="button"
          data-classroom-save-questions=""
          onClick={onSaveWrong}
          disabled={savedToBank}
          className="rounded-lg border border-[var(--border)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--foreground)] disabled:opacity-50"
        >
          {savedToBank ? t("In the question bank") : t("Save wrong answers to the question bank")}
        </button>
      )}
    </div>
  );
}

function DiscussionInput({
  live,
  onSend,
  onSkip,
}: {
  live: boolean;
  onSend: (message: string) => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const send = () => {
    const trimmed = message.trim();
    if (live || !trimmed) return;
    onSend(trimmed);
    setMessage("");
  };
  return (
    <div className="mt-3 flex items-center gap-2">
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
        }}
        placeholder={t("Join the discussion…")}
        disabled={live}
        className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 py-1.5 text-[13px] outline-none focus:border-[var(--ring)] disabled:opacity-50"
      />
      {live ? (
        <Loader2 className="h-4 w-4 animate-spin text-[var(--muted-foreground)]" />
      ) : (
        <>
          <button
            type="button"
            onClick={send}
            disabled={!message.trim()}
            className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
          >
            {t("Speak")}
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12.5px] text-[var(--foreground)]"
          >
            {t("Skip")}
          </button>
        </>
      )}
    </div>
  );
}
