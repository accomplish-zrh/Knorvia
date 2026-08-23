"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Film,
  Search,
  Square,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  cancelStudioJob,
  followStudioJob,
  getStudioJob,
  studioAssetUrl,
  type StudioJob,
} from "@/lib/image-studio-api";
import {
  followVideoJob,
  getVideoJob,
  videoAssetUrl,
  type VideoJob,
} from "@/lib/video-studio-api";
import {
  classifyVideoJobError,
  jobErrorMessage,
  normalizedJobProgress,
  videoJobErrorLabelKey,
} from "@/lib/video-studio/studio-logic";
import { bookApi } from "@/lib/book-api";
import type { Book } from "@/lib/book-types";
import {
  collectBookIds,
  collectStudioJobRefs,
  collectVideoStudioJobRefs,
  collectVideoStudioProjectRefs,
  hasResearchEvents,
  latestResearchLabelKey,
  type StudioJobRef,
  type VideoStudioJobRef,
  type VideoStudioProjectRef,
  videoStudioJobHref,
  videoStudioProjectHref,
} from "@/lib/chat-task-cards";
import type { StreamEvent } from "@/lib/unified-ws";

const LIVE_STATUSES = new Set(["queued", "running"]);
const LIVE_VIDEO_STATUSES = new Set(["queued", "submitting", "running"]);

function statusLabel(
  status: string,
  t: (key: string) => string,
): string {
  const labels: Record<string, string> = {
    queued: t("Queued"),
    submitting: t("Submitting"),
    running: t("Creating"),
    succeeded: t("Completed"),
    partial: t("Partially completed"),
    failed: t("Failed"),
    cancelled: t("Cancelled"),
    interrupted: t("Interrupted"),
    draft: t("Draft"),
    spine_ready: t("Spine ready"),
    compiling: t("Compiling"),
    ready: t("Ready"),
    error: t("Failed"),
  };
  return labels[status] || status;
}

function VideoTaskCard({
  refItem,
  isStreaming,
}: {
  refItem: VideoStudioJobRef;
  isStreaming?: boolean;
}) {
  const { t } = useTranslation();
  const [job, setJob] = useState<VideoJob | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const apply = (next: VideoJob) => {
      if (!controller.signal.aborted) setJob(next);
    };
    void getVideoJob(refItem.jobId, controller.signal)
      .then((initial) => {
        apply(initial);
        if (!LIVE_VIDEO_STATUSES.has(initial.status)) return initial;
        return followVideoJob(
          refItem.jobId,
          apply,
          undefined,
          0,
          controller.signal,
        );
      })
      .then((finished) => {
        if (finished) apply(finished);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [refItem.jobId]);

  const live = Boolean(
    (job && LIVE_VIDEO_STATUSES.has(job.status)) || (isStreaming && !job),
  );
  const outputId = job?.output_asset_ids?.[0];
  // Phase 5 error taxonomy: show a translated category line in chat, keep the
  // raw provider detail available through the native tooltip.
  const errorDetail = job ? jobErrorMessage(job) : "";
  const friendlyErrorKey = job ? videoJobErrorLabelKey(classifyVideoJobError(job)) : "";
  const errorMessage = friendlyErrorKey
    ? t(friendlyErrorKey)
    : errorDetail || t("The video task failed.");
  const showError = Boolean(job && (friendlyErrorKey || errorDetail));
  const href = videoStudioJobHref({
    ...refItem,
    projectId: job?.project_id || refItem.projectId,
  });

  return (
    <div className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
      <div className="flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--muted)]/60">
        {outputId ? (
          <video
            src={videoAssetUrl(outputId)}
            muted
            playsInline
            preload="metadata"
            aria-label={t("Video result preview")}
            className="h-full w-full object-cover"
          />
        ) : (
          <Film size={18} className="text-[var(--muted-foreground)]" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--foreground)]">
          {live ? <Loader2 size={12} className="animate-spin" /> : null}
          <span>{statusLabel(job?.status || "queued", t)}</span>
          {job && live ? (
            <span className="text-[10px] font-normal text-[var(--muted-foreground)]">
              {Math.round(normalizedJobProgress(job))}%
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-[11.5px] text-[var(--muted-foreground)]">
          {job?.prompt || t("Video Studio")}
        </p>
        {showError ? (
          <p
            className="mt-1 line-clamp-2 text-[10.5px] text-[var(--destructive)]"
            title={errorDetail || undefined}
          >
            {errorMessage}
          </p>
        ) : null}
        <Link
          href={href}
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <ExternalLink size={11} />
          {t("Open in Video Studio")}
        </Link>
      </div>
    </div>
  );
}

function projectActionTitle(
  action: string,
  t: (key: string) => string,
): string {
  if (action === "plan_episode") return t("Storyboard planned");
  if (action === "analyze_script") return t("Script analyzed");
  if (action === "apply_production") return t("Storyboard applied");
  return t("Video Studio");
}

function VideoProjectTaskCard({ refItem }: { refItem: VideoStudioProjectRef }) {
  const { t } = useTranslation();
  const href = videoStudioProjectHref(refItem);
  return (
    <div className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
      <div className="flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--muted)]/60">
        <Film size={18} className="text-[var(--muted-foreground)]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--foreground)]">
          <span>{projectActionTitle(refItem.action, t)}</span>
        </div>
        {refItem.shotCount > 0 ? (
          <p className="mt-0.5 truncate text-[11.5px] text-[var(--muted-foreground)]">
            {t("{{count}} shots written", { count: refItem.shotCount })}
          </p>
        ) : (
          <p className="mt-0.5 truncate text-[11.5px] text-[var(--muted-foreground)]">
            {t("Video Studio")}
          </p>
        )}
        <Link
          href={href}
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <ExternalLink size={11} />
          {t("Open in Video Studio")}
        </Link>
      </div>
    </div>
  );
}

function researchCaption(
  key: string,
  t: (key: string) => string,
): string {
  if (key === "decompose_target" || key === "decomposing") {
    return t("Decomposing Target");
  }
  if (key === "research_topic" || key === "researching") {
    return t("Researching Topic");
  }
  if (key === "report_intro") return t("Reporting Intro");
  if (key === "report_outline") return t("Reporting Outline");
  if (key === "report_conclusion") return t("Reporting Conclusion");
  if (key === "report_section" || key === "reporting") return t("Reporting");
  if (key === "rephrasing") return t("Rephrasing");
  return t("Researching");
}

function StudioTaskCard({
  refItem,
  isStreaming,
}: {
  refItem: StudioJobRef;
  isStreaming?: boolean;
}) {
  const { t } = useTranslation();
  const [job, setJob] = useState<StudioJob | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const apply = (next: StudioJob) => {
      if (!cancelled) setJob(next);
    };
    void getStudioJob(refItem.jobId)
      .then(apply)
      .catch(() => undefined);

    const live = async () => {
      try {
        await followStudioJob(refItem.jobId, (event) => {
          if (event.payload?.status) {
            void getStudioJob(refItem.jobId).then(apply).catch(() => undefined);
          }
        });
      } catch {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (cancelled) return;
          try {
            const next = await getStudioJob(refItem.jobId);
            apply(next);
            if (!LIVE_STATUSES.has(next.status)) return;
          } catch {
            /* keep polling */
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
        }
      }
      if (!cancelled) {
        void getStudioJob(refItem.jobId).then(apply).catch(() => undefined);
      }
    };
    void live();
    return () => {
      cancelled = true;
    };
  }, [refItem.jobId]);

  const live = Boolean(
    job && (LIVE_STATUSES.has(job.status) || (isStreaming && !job)),
  );
  const preview = job?.outputs?.[0]?.asset_id
    ? studioAssetUrl(job.outputs[0].asset_id)
    : null;
  const href = (() => {
    const search = new URLSearchParams();
    const projectId = job?.project_id || refItem.projectId;
    if (projectId) search.set("project", projectId);
    if (job?.id || refItem.jobId) search.set("job", job?.id || refItem.jobId);
    const query = search.toString();
    return query ? `/image-studio?${query}` : "/image-studio";
  })();

  return (
    <div className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--muted)]/60">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="h-full w-full object-cover" />
        ) : (
          <ImageIcon size={18} className="text-[var(--muted-foreground)]" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--foreground)]">
          {live ? <Loader2 size={12} className="animate-spin" /> : null}
          <span>{statusLabel(job?.status || "queued", t)}</span>
        </div>
        <p className="mt-0.5 truncate text-[11.5px] text-[var(--muted-foreground)]">
          {job?.prompt || t("Image Studio")}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Link
            href={href}
            className="inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <ExternalLink size={11} />
            {t("Open in Image Studio")}
          </Link>
          {job && LIVE_STATUSES.has(job.status) ? (
            <button
              type="button"
              disabled={cancelling}
              onClick={() => {
                setCancelling(true);
                void cancelStudioJob(job.id)
                  .then(() => getStudioJob(job.id))
                  .then(setJob)
                  .finally(() => setCancelling(false));
              }}
              className="inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <Square size={10} />
              {t("Cancel")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ResearchTaskCard({
  events,
  isStreaming,
}: {
  events: StreamEvent[];
  isStreaming?: boolean;
}) {
  const { t } = useTranslation();
  const key = latestResearchLabelKey(events);
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
        <Search size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--foreground)]">
          {isStreaming ? <Loader2 size={12} className="animate-spin" /> : null}
          <span>{t("Research")}</span>
        </div>
        <p className="mt-0.5 text-[11.5px] text-[var(--muted-foreground)]">
          {researchCaption(key, t)}
        </p>
      </div>
    </div>
  );
}

function BookTaskCard({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const [book, setBook] = useState<Book | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bookApi
      .get(bookId)
      .then((detail) => {
        if (!cancelled) setBook(detail.book);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const live = Boolean(
    book && ["draft", "spine_ready", "compiling"].includes(book.status),
  );

  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400">
        <BookOpen size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--foreground)]">
          {live ? <Loader2 size={12} className="animate-spin" /> : null}
          <span>{book?.title || t("Book")}</span>
        </div>
        <p className="mt-0.5 text-[11.5px] text-[var(--muted-foreground)]">
          {statusLabel(book?.status || "draft", t)}
        </p>
        <Link
          href={`/book?book=${encodeURIComponent(bookId)}`}
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <ExternalLink size={11} />
          {t("Open book")}
        </Link>
      </div>
    </div>
  );
}

export function ChatTaskCards({
  events,
  isStreaming,
}: {
  events: StreamEvent[];
  isStreaming?: boolean;
}) {
  const studio = useMemo(() => collectStudioJobRefs(events), [events]);
  const videoStudio = useMemo(
    () => collectVideoStudioJobRefs(events),
    [events],
  );
  const videoProjects = useMemo(
    () => collectVideoStudioProjectRefs(events),
    [events],
  );
  const books = useMemo(() => collectBookIds(events), [events]);
  const research = useMemo(() => hasResearchEvents(events), [events]);
  if (
    !studio.length &&
    !videoStudio.length &&
    !videoProjects.length &&
    !books.length &&
    !research
  )
    return null;

  return (
    <div className="mt-2 space-y-2">
      {studio.map((item) => (
        <StudioTaskCard
          key={item.jobId}
          refItem={item}
          isStreaming={isStreaming}
        />
      ))}
      {videoProjects.map((item) => (
        <VideoProjectTaskCard
          key={`${item.action}:${item.projectId}`}
          refItem={item}
        />
      ))}
      {videoStudio.map((item) => (
        <VideoTaskCard
          key={item.jobId}
          refItem={item}
          isStreaming={isStreaming}
        />
      ))}
      {research ? (
        <ResearchTaskCard events={events} isStreaming={isStreaming} />
      ) : null}
      {books.map((bookId) => (
        <BookTaskCard key={bookId} bookId={bookId} />
      ))}
    </div>
  );
}
