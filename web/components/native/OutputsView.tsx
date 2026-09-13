"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowLeftRight, ChevronLeft, History, Layers, Loader2, Pencil, RotateCcw, Save, X } from "lucide-react";
import { displayTime, type Artifact, type ArtifactContent } from "@/lib/native-workbench-state";
import { diffTextLines, walkRevisionChain, type DiffResult, type RevisionChain } from "@/lib/native-artifact-history";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { Markdown } from "./TaskTimeline";
import { SaveToLibrary } from "./SaveToLibrary";
import { MediaOutputReader, parseMediaManifest } from "./MediaOutputReader";
import { OutputCatalog } from "./OutputCatalog";

const RPC_CONFLICT = -32005;
const ATTEMPT_STORAGE_KEY = "knorvia-output-save-attempt";
const COPY_ATTEMPT_STORAGE_KEY = "knorvia-output-copy-attempt";

type ArtifactRevisionRef = { id: string };

export function OutputsView({ embedded = false }: { embedded?: boolean }) {
  const { t, locale, request, workspaces, connection, setError, setNotice } = useWorkbench();
  const [totalCount, setTotalCount] = useState(0);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [contentError, setContentError] = useState("");
  // P03: the revision this reader is editing, and one stable idempotency
  // identity per save attempt so a transport retry replays instead of
  // re-executing stage/commit.
  const [baseRevisionId, setBaseRevisionId] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [copyBusy, setCopyBusy] = useState(false);
  // CODEX-0615-B01: one shared in-flight guard for saves AND copies — a copy
  // in flight blocks switching/typing (pending) and a new save cannot start
  // under it.
  const inFlightRef = useRef<"save" | "copy" | null>(null);
  // B03: the reader identity every in-flight version/diff request is checked
  // against. The ref is updated synchronously at each selection change, so a
  // response that finishes after the user switched outputs can never write
  // the previous output's versions, diff, or loading state into the new one.
  const selectedIdRef = useRef<string | null>(null);
  const chainGenerationRef = useRef(0);
  const diffGenerationRef = useRef(0);
  const selectedId = selected?.id;
  const mediaManifest = parseMediaManifest(selected?.type, content?.content);
  const dirty = Boolean(content && !mediaManifest && !revisionId && draft !== content.content);
  const canLeave = () => !pending && (!dirty || window.confirm(t("成果尚未保存，放弃这些修改吗？", "Discard unsaved changes to this output?")));
  useEffect(() => {
    if (!dirty && !pending) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target.closest('a[href]');
      if (!anchor || anchor.getAttribute('target') === '_blank' || anchor.hasAttribute('download')) return;
      if (pending || !window.confirm(t("成果尚未保存，放弃这些修改吗？", "Discard unsaved changes to this output?"))) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigate, true); };
  }, [dirty, pending, t]);
  const refresh = useCallback(() => setRefreshSignal(value => value + 1), []);
  useEffect(() => {
    if (connection !== "connected") return;
    setLoading(false);
    // P02: a selected output is restorable from the URL (?output=<id>).
    const fromUrl = new URLSearchParams(window.location.search).get("output");
    if (!fromUrl) return;
    let cancelled = false;
    void request<Artifact>("artifact/read", { id: fromUrl })
      .then(artifact => { if (!cancelled) { selectedIdRef.current = artifact.id; chainGenerationRef.current += 1; setSelected(artifact); } })
      .catch(() => { /* stale link: keep the catalog view */ });
    return () => { cancelled = true; };
  }, [connection, request]);
  // CODEX-0215-B01: both callbacks depend on the live dirty/pending state —
  // stale closures here used to bypass the unsaved-changes guard.
  const selectArtifact = useCallback((artifact: Artifact) => {
    const currentId = selectedIdRef.current;
    if (currentId === artifact.id && !revisionId) return;
    // Only a running save blocks switching; unsaved edits ask first.
    if (pending || (dirty && !window.confirm(t("成果尚未保存，放弃这些修改吗？", "Discard unsaved changes to this output?")))) return;
    selectedIdRef.current = artifact.id;
    chainGenerationRef.current += 1;
    diffGenerationRef.current += 1;
    setBaseRevisionId(null);
    setRevisionId(null);
    setSelected(artifact);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("output", artifact.id);
      window.history.replaceState(null, "", url.toString());
    } catch { /* URL sync is best-effort */ }
  }, [revisionId, pending, dirty, t]);
  const closeArtifact = useCallback(() => {
    if (pending) return;
    if (dirty && !window.confirm(t("成果尚未保存，放弃这些修改吗？", "Discard unsaved changes to this output?"))) return;
    selectedIdRef.current = null;
    chainGenerationRef.current += 1;
    diffGenerationRef.current += 1;
    setSelected(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("output");
      window.history.replaceState(null, "", url.toString());
    } catch { /* URL sync is best-effort */ }
  }, [pending, dirty, t]);
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setContent(null); setEditing(false); setContentError(""); setSaveConflict(false);
    void request<ArtifactContent>("artifact/content", { id: selectedId, ...(revisionId ? { revisionId } : {}) }).then(value => { if (!cancelled) { setContent(value); setDraft(value.content); if (!revisionId) setBaseRevisionId(value.revision?.id ?? null); } }).catch(error => { if (!cancelled) setContentError(errorText(error)); });
    return () => { cancelled = true; };
  }, [selectedId, revisionId, reloadTick, request]);
  // B03: bounded version list + local diff. The chain walk and the diff are
  // separate from the reader states, so loading them can never disturb an
  // unsaved draft.
  const [versionPanel, setVersionPanel] = useState(false);
  // B03: chain and diff results are stored with the reader identity they were
  // loaded for and only render while that identity is current. A walk or
  // compare that finishes after switching outputs/revisions is stale and can
  // never attach its result to the new selection.
  const [chainState, setChainState] = useState<{ key: string; result: RevisionChain } | null>(null);
  const [chainLoading, setChainLoading] = useState(false);
  const [diffState, setDiffState] = useState<{ key: string; result: DiffResult } | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const currentTextRef = useRef<string | null>(null);
  const chain = chainState?.key === (selectedId ?? "") ? chainState.result : null;
  const diff = diffState?.key === `${selectedId ?? ""}@${revisionId ?? ""}` ? diffState.result : null;
  const currentRevisionId = baseRevisionId ?? selected?.currentRevision ?? null;
  useEffect(() => { chainGenerationRef.current += 1; setVersionPanel(false); setChainState(null); setChainLoading(false); currentTextRef.current = null; }, [selectedId]);
  useEffect(() => { diffGenerationRef.current += 1; setDiffBusy(false); setDiffState(null); }, [selectedId, revisionId]);
  useEffect(() => { currentTextRef.current = null; }, [baseRevisionId]);
  const loadVersions = useCallback(async () => {
    if (!selectedId || chainLoading) return;
    if (versionPanel) { setVersionPanel(false); return; }
    if (!versionPanel && chain) { setVersionPanel(true); return; }
    setVersionPanel(true);
    const requestedId = selectedId;
    const generation = ++chainGenerationRef.current;
    const startId = currentRevisionId ?? "";
    if (!startId) return;
    setChainLoading(true);
    try {
      const result = await walkRevisionChain(async revisionId => {
        const page = await request<ArtifactContent>("artifact/content", { id: requestedId, ...(revisionId ? { revisionId } : {}) });
        if (page.revision?.id !== revisionId || !Array.isArray(page.revision.parentIds)) throw new Error("Incomplete revision metadata");
        return page.revision;
      }, startId);
      // A walk that finishes after the reader moved to another output (or a
      // newer walk started) is stale: its result must never be shown.
      if (selectedIdRef.current !== requestedId || generation !== chainGenerationRef.current) return;
      setChainState({ key: requestedId, result });
    } catch (error) {
      if (selectedIdRef.current === requestedId && generation === chainGenerationRef.current) setError(errorText(error));
    }
    finally { if (generation === chainGenerationRef.current) setChainLoading(false); }
  }, [selectedId, chainLoading, versionPanel, chain, currentRevisionId, request, setError]);
  const compareWithCurrent = useCallback(async () => {
    if (!selectedId || !content || diffBusy) return;
    const requestedId = selectedId;
    const requestedRevisionId = revisionId;
    const generation = ++diffGenerationRef.current;
    const isCurrent = () => selectedIdRef.current === requestedId && generation === diffGenerationRef.current;
    setDiffBusy(true);
    try {
      let current = currentTextRef.current;
      if (current === null) {
        const page = await request<ArtifactContent>("artifact/content", { id: requestedId });
        if (!isCurrent()) return;
        current = page.content;
        currentTextRef.current = page.content;
      }
      if (!isCurrent()) return;
      setDiffState({ key: `${requestedId}@${requestedRevisionId ?? ""}`, result: diffTextLines(content.content, current) });
    } catch (error) {
      if (isCurrent()) setError(errorText(error));
    }
    finally { if (isCurrent()) setDiffBusy(false); }
  }, [selectedId, revisionId, content, diffBusy, request, setError]);
  const chooseRevision = (target: string | null) => {
    if (!canLeave()) return;
    diffGenerationRef.current += 1;
    setDiffState(null);
    setRevisionId(target);
  };
  // P03 (CODEX-0415/0615/0715): a save/copy attempt freezes its whole
  // identity (workspace/type/title/content + every idempotency key).
  // Resolution REPLAYS the attempt under its original keys and classifies
  // the outcome: saved / failed (definitively never executed) / unknown.
  // Unknown attempts persist across reloads, surface as a recovery banner,
  // and block conflicting new attempts until the facts are settled.
  type SaveAttempt = { artifactId: string; workspaceId: string; content: string; baseRevisionId: string | null; stageKey: string; commitKey: string; stagedId?: string };
  type CopyAttempt = { sourceArtifactId?: string; workspaceId: string; type: string; title: string; content: string; createKey: string; stageKey: string; commitKey: string; createdId?: string; stagedId?: string };
  const saveAttemptRef = useRef<SaveAttempt | null>(null);
  const copyAttemptRef = useRef<CopyAttempt | null>(null);
  const [recovery, setRecovery] = useState<"save" | "copy" | null>(null);
  useEffect(() => {
    try {
      const saveRaw = sessionStorage.getItem(ATTEMPT_STORAGE_KEY);
      if (saveRaw) saveAttemptRef.current = JSON.parse(saveRaw) as SaveAttempt;
      const copyRaw = sessionStorage.getItem(COPY_ATTEMPT_STORAGE_KEY);
      if (copyRaw) copyAttemptRef.current = JSON.parse(copyRaw) as CopyAttempt;
      if (saveAttemptRef.current || copyAttemptRef.current) setRecovery(saveAttemptRef.current ? "save" : "copy");
    } catch { /* storage optional */ }
  }, []);
  const persistSaveAttempt = (attempt: SaveAttempt | null) => {
    saveAttemptRef.current = attempt;
    try {
      if (attempt) sessionStorage.setItem(ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
      else sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
    } catch { /* storage optional */ }
  };
  const persistCopyAttempt = (attempt: CopyAttempt | null) => {
    copyAttemptRef.current = attempt;
    try {
      if (attempt) sessionStorage.setItem(COPY_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
      else sessionStorage.removeItem(COPY_ATTEMPT_STORAGE_KEY);
    } catch { /* storage optional */ }
  };
  // A typed conflict during a replay means different things by message: the
  // daemon's "no durable outcome" marker leaves the attempt unknown, while
  // every other conflict proves the attempt never executed.
  const classifyReplayFailure = (error: unknown): "failed" | "unknown" => {
    const code = (error as { code?: number }).code;
    const message = String((error as { message?: string }).message ?? "");
    if (code === RPC_CONFLICT && /no durable outcome/i.test(message)) return "unknown";
    if (code === RPC_CONFLICT) return "failed";
    return "unknown";
  };
  const resolveSaveAttempt = useCallback(async (attempt: SaveAttempt): Promise<"saved" | "failed" | "unknown"> => {
    let stagedId = attempt.stagedId;
    if (!stagedId) {
      // CODEX-0715-B01 counterexample 1: a missing stagedId does NOT mean
      // the stage never started. Replay it under the original key first.
      try {
        const staged = await request<ArtifactRevisionRef>("artifact/stage", {
          id: attempt.artifactId, content: attempt.content,
          expectedCurrentRevision: attempt.baseRevisionId, idempotencyKey: attempt.stageKey,
        });
        stagedId = attempt.stagedId = staged.id;
        persistSaveAttempt(attempt);
      } catch (stageError) {
        // An explicit base conflict proves the stage never executed; the
        // daemon's pending marker means the outcome is still unknown.
        return classifyReplayFailure(stageError);
      }
    }
    try {
      const updated = await request<Artifact>("artifact/commit", { id: attempt.artifactId, stagedRevisionId: stagedId, idempotencyKey: attempt.commitKey });
      refresh();
      setNotice(t("上一次保存已完成", "The previous save had completed"));
      void updated;
      return "saved";
    } catch (commitError) {
      const current = await request<Artifact | null>("artifact/read", { id: attempt.artifactId }).catch(() => null);
      if (current?.currentRevision === stagedId && current?.lifecycle === "published") {
        refresh();
        setNotice(t("上一次保存已完成", "The previous save had completed"));
        return "saved";
      }
      return classifyReplayFailure(commitError);
    }
  }, [request, refresh, setNotice, t]);
  const resolveCopyAttempt = useCallback(async (attempt: CopyAttempt): Promise<"saved" | "failed" | "unknown"> => {
    // The create replay returns the SAME artifact for a completed attempt.
    const created = await request<Artifact>("artifact/create", {
      workspaceId: attempt.workspaceId, title: attempt.title, type: attempt.type, idempotencyKey: attempt.createKey,
    });
    attempt.createdId = created.id;
    persistCopyAttempt(attempt);
    let stagedId = attempt.stagedId;
    if (!stagedId) {
      try {
        const staged = await request<ArtifactRevisionRef>("artifact/stage", {
          id: created.id, content: attempt.content, expectedCurrentRevision: null, idempotencyKey: attempt.stageKey,
        });
        stagedId = attempt.stagedId = staged.id;
        persistCopyAttempt(attempt);
      } catch (stageError) {
        return classifyReplayFailure(stageError);
      }
    }
    try {
      await request<Artifact>("artifact/commit", { id: created.id, stagedRevisionId: stagedId, idempotencyKey: attempt.commitKey });
    } catch (commitError) {
      const current = await request<Artifact | null>("artifact/read", { id: created.id }).catch(() => null);
      if (current?.currentRevision === stagedId && current?.lifecycle === "published") {
        refresh();
        setNotice(t("上一次的副本已创建", "The previous copy had been created"));
        return "saved";
      }
      return classifyReplayFailure(commitError);
    }
    refresh();
    setNotice(t("上一次的副本已创建", "The previous copy had been created"));
    return "saved";
  }, [request, refresh, setNotice, t]);
  const restoreSavedReader = useCallback(async (attempt: SaveAttempt) => {
    if (selected?.id !== attempt.artifactId) return;
    try {
      const fresh = await request<ArtifactContent>("artifact/content", { id: attempt.artifactId });
      const artifact = fresh.artifact ?? await request<Artifact>("artifact/read", { id: attempt.artifactId });
      const currentRevision = fresh.revision?.id ?? artifact.currentRevision ?? null;
      if (!dirty || draft === attempt.content) {
        setContent(fresh); setDraft(fresh.content); setSelected(artifact);
        setBaseRevisionId(currentRevision); setEditing(false); setRevisionId(null);
      } else if (currentRevision === attempt.stagedId) {
        // The newer local draft remains editable; only our confirmed revision
        // can advance its base. An intervening writer still causes a conflict.
        setContent(fresh); setBaseRevisionId(currentRevision);
      }
    } catch (error) { setError(errorText(error)); }
  }, [selected, dirty, draft, request, setError]);
  const restoreCopyReader = useCallback(async (attempt: CopyAttempt) => {
    if (!attempt.createdId || (selected && selected.id !== attempt.sourceArtifactId) || (dirty && draft !== attempt.content)) return;
    try {
      const fresh = await request<ArtifactContent>("artifact/content", { id: attempt.createdId });
      const artifact = fresh.artifact ?? await request<Artifact>("artifact/read", { id: attempt.createdId });
      setSelected(artifact); setContent(fresh); setDraft(fresh.content);
      setBaseRevisionId(fresh.revision?.id ?? artifact.currentRevision ?? null);
      setEditing(false); setRevisionId(null);
      const url = new URL(window.location.href); url.searchParams.set("output", attempt.createdId);
      window.history.replaceState(null, "", url.toString());
    } catch (error) { setError(errorText(error)); }
  }, [selected, dirty, draft, request, setError]);
  const resolveRecovery = useCallback(async () => {
    if (inFlightRef.current) return;
    setPending(true); inFlightRef.current = "save";
    try {
      if (recovery === "save" && saveAttemptRef.current) {
        const attempt = saveAttemptRef.current;
        let outcome: "saved" | "failed" | "unknown" = "unknown";
        try { outcome = await resolveSaveAttempt(attempt); } catch { outcome = "unknown"; }
        if (outcome === "unknown") {
          setError(t("结果仍未确定，稍后可再次查明。", "The outcome is still unknown; check again later."));
          return;
        }
        persistSaveAttempt(null); setRecovery(null);
        if (outcome === "saved") await restoreSavedReader(attempt);
        if (outcome === "failed") setNotice(t("上次保存未执行，当前内容可重新保存。", "The previous save never executed; the current content can be saved again."));
        refresh();
      } else if (recovery === "copy" && copyAttemptRef.current) {
        const attempt = copyAttemptRef.current;
        let outcome: "saved" | "failed" | "unknown" = "unknown";
        try { outcome = await resolveCopyAttempt(attempt); } catch { outcome = "unknown"; }
        if (outcome === "unknown") {
          setError(t("结果仍未确定，稍后可再次查明。", "The outcome is still unknown; check again later."));
          return;
        }
        persistCopyAttempt(null); setRecovery(null);
        if (outcome === "saved") await restoreCopyReader(attempt);
        if (outcome === "failed") setNotice(t("上次副本未创建，可重新另存。", "The previous copy was never created; you can save a copy again."));
        refresh();
      }
    } finally { inFlightRef.current = null; setPending(false); }
  }, [recovery, resolveSaveAttempt, resolveCopyAttempt, restoreSavedReader, restoreCopyReader, refresh, setError, setNotice, t]);
  const saveRevision = useCallback(async () => {
    if (!selected || !dirty) return;
    if (inFlightRef.current) return;
    setPending(true); setSaveConflict(false); inFlightRef.current = "save";
    try {
      const prior = saveAttemptRef.current;
      if (prior) {
        // CODEX-0715/0815: a prior attempt is ALWAYS resolved by replaying
        // it under its own keys first. A replayed success ends the whole
        // operation - the frozen payload is exactly what the user wanted to
        // save, so no second request may follow.
        let outcome: "saved" | "failed" | "unknown" = "unknown";
        try { outcome = await resolveSaveAttempt(prior); } catch { outcome = "unknown"; }
        if (outcome === "unknown") {
          inFlightRef.current = null; setPending(false);
          setError(t("上次保存的结果仍未确定，已保留该次身份。恢复网络后再次保存以查明结果；期间草稿可下载或另存资料库。", "The previous save's outcome is still unknown and its identity is preserved. Restore connectivity and save again to resolve it; meanwhile the draft can be downloaded or saved to the library."));
          return;
        }
        persistSaveAttempt(null); setRecovery(null);
        if (outcome === "saved") {
          await restoreSavedReader(prior);
          refresh();
          return;
        }
        // failed: definitively never executed - a fresh save follows.
        if (!dirty || draft.length === 0) { inFlightRef.current = null; setPending(false); return; }
      }
      let attempt = saveAttemptRef.current;
      if (!attempt) {
        attempt = { artifactId: selected.id, workspaceId: selected.workspaceId, content: draft, baseRevisionId, stageKey: crypto.randomUUID(), commitKey: crypto.randomUUID() };
        persistSaveAttempt(attempt);
      }
      try {
        const staged = attempt.stagedId
          ? { id: attempt.stagedId }
          : await request<ArtifactRevisionRef>("artifact/stage", {
              id: attempt.artifactId, content: attempt.content,
              expectedCurrentRevision: attempt.baseRevisionId, idempotencyKey: attempt.stageKey,
            });
        attempt.stagedId = staged.id;
        persistSaveAttempt(attempt);
        let updated: Artifact;
        try {
          updated = await request<Artifact>("artifact/commit", { id: attempt.artifactId, stagedRevisionId: staged.id, idempotencyKey: attempt.commitKey });
        } catch (commitError) {
          const current = await request<Artifact | null>("artifact/read", { id: attempt.artifactId }).catch(() => null);
          if (current?.currentRevision === staged.id && current?.lifecycle === "published") updated = current;
          else throw commitError;
        }
        persistSaveAttempt(null); saveAttemptRef.current = null;
        setContent({ content: attempt.content, artifact: updated }); setEditing(false); setRevisionId(null);
        setBaseRevisionId(updated.currentRevision ?? null);
        setSelected(updated); setNotice(t("新版本已保存", "New revision saved"));
        try { const fresh = await request<ArtifactContent>("artifact/content", { id: updated.id }); setContent(fresh); setDraft(fresh.content); setBaseRevisionId(fresh.revision?.id ?? null); } catch (error) { setError(errorText(error)); }
        refresh();
      } catch (error) {
        const replayMessage = String((error as { message?: string }).message ?? "");
        if ((error as { code?: number }).code === RPC_CONFLICT && /no durable outcome/i.test(replayMessage)) {
          // CODEX-0815-B01: a pending "no durable outcome" conflict leaves
          // the frozen attempt unknown - it is kept, never cleared like a
          // settled conflict.
          setError(t("上次保存的结果仍未确定，已保留该次身份。恢复网络后再次保存以查明结果。", "The previous save's outcome is still unknown and its identity is preserved. Restore connectivity and save again to resolve it."));
        } else if ((error as { code?: number }).code === RPC_CONFLICT) {
          persistSaveAttempt(null); saveAttemptRef.current = null;
          setSaveConflict(true);
          setError(t("成果已被其他人修改，你的草稿已保留。载入最新版本或另存为副本。", "This output changed elsewhere. Your draft is kept — load the latest version or save a copy."));
        } else {
          setError(errorText(error));
        }
      }
    } finally { inFlightRef.current = null; setPending(false); }
  }, [selected, dirty, draft, baseRevisionId, request, refresh, setError, setNotice, resolveSaveAttempt, restoreSavedReader, t]);
  // Conflict path "另存为副本" (CODEX-0715-B01 counterexamples 3-4): the
  // copy attempt freezes workspace/type/title/content AND its three keys.
  // An unresolved copy is replayed under those keys before any new copy is
  // minted, and the retry always uses the frozen fields - never whatever
  // output happens to be selected now.
  const saveAsCopy = useCallback(async () => {
    if (!selected || !draft.length) return;
    if (inFlightRef.current) return;
    setPending(true); setCopyBusy(true); setSaveConflict(false); inFlightRef.current = "copy";
    try {
      const prior = copyAttemptRef.current;
      if (prior) {
        let outcome: "saved" | "failed" | "unknown" = "unknown";
        try { outcome = await resolveCopyAttempt(prior); } catch { outcome = "unknown"; }
        if (outcome === "unknown") {
          // Unknown: the frozen copy attempt stays recorded and blocks a
          // conflicting new copy until the facts are settled.
          inFlightRef.current = null; setPending(false); setCopyBusy(false);
          setError(t("上次副本的结果仍未确定，已保留该次身份。恢复网络后再次另存以查明结果。", "The previous copy's outcome is still unknown and its identity is preserved. Restore connectivity and save a copy again to resolve it."));
          return;
        }
        persistCopyAttempt(null); setRecovery(null);
        if (outcome === "saved") {
          // CODEX-0815-B01: the replay proved the copy EXISTS - the operation
          // ends here. Creating a second copy would break idempotency.
          setNotice(t("副本已创建（已查明上次结果）", "The copy was created (previous outcome resolved)"));
          await restoreCopyReader(prior);
          refresh();
          inFlightRef.current = null; setPending(false); setCopyBusy(false);
          return;
        }
        // failed: definitively never created - a fresh copy follows.
      }
      let attempt = copyAttemptRef.current;
      if (!attempt) {
        attempt = { sourceArtifactId: selected.id, workspaceId: selected.workspaceId, type: selected.type || "text/markdown", title: `${selected.title} (${t("副本", "copy")})`, content: draft, createKey: crypto.randomUUID(), stageKey: crypto.randomUUID(), commitKey: crypto.randomUUID() };
        persistCopyAttempt(attempt);
      }
      try {
        const created = await request<Artifact>("artifact/create", {
          workspaceId: attempt.workspaceId, title: attempt.title, type: attempt.type, idempotencyKey: attempt.createKey,
        });
        const staged = await request<ArtifactRevisionRef>("artifact/stage", {
          id: created.id, content: attempt.content, expectedCurrentRevision: null, idempotencyKey: attempt.stageKey,
        });
        attempt.createdId = created.id;
        const published = await request<Artifact>("artifact/commit", { id: created.id, stagedRevisionId: staged.id, idempotencyKey: attempt.commitKey });
        persistCopyAttempt(null); copyAttemptRef.current = null;
        setSaveConflict(false); setEditing(false); setRevisionId(null);
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("output", published.id);
          window.history.replaceState(null, "", url.toString());
        } catch { /* URL sync is best-effort */ }
        setSelected(published); setBaseRevisionId(published.currentRevision ?? null);
        try { const fresh = await request<ArtifactContent>("artifact/content", { id: published.id }); setContent(fresh); setDraft(fresh.content); setBaseRevisionId(fresh.revision?.id ?? null); } catch (error) { setError(errorText(error)); }
        setNotice(t("已另存为副本", "Saved as a copy"));
        refresh();
      } catch (error) {
        // The frozen copy attempt stays recorded; a retry replays the same
        // keys instead of minting another unowned copy.
        setError(errorText(error));
      }
    } finally { inFlightRef.current = null; setCopyBusy(false); setPending(false); }
  }, [selected, draft, request, refresh, setError, setNotice, resolveCopyAttempt, restoreCopyReader, t]);
  return <div className={`nw-outputs-view ${selected ? "is-reading" : ""}`}><div className="nw-page"><div className="nw-page-heading"><div><h1>{t("资料库", "Library")}</h1><p>{embedded ? t("任务生成的内容都在这里，随时查看、编辑和继续打磨。", "Find, edit and keep working on content from your tasks.") : t("留下有用的结果，再继续打磨。", "Keep useful results, then make them better.")}</p></div><span className="nw-muted-label">{totalCount} {t("项资料", "items")}</span></div>{recovery && <div className="nw-output-conflict" role="alert" style={{ margin: "0 0 12px" }}><span>{recovery === "save" ? t("有刷新前发起的保存，结果未确认。", "A save started before the reload has an unconfirmed outcome.") : t("有刷新前发起的副本创建，结果未确认。", "A copy started before the reload has an unconfirmed outcome.")}</span><button className="nw-button nw-button-small" disabled={pending} onClick={() => { void resolveRecovery(); }}>{t("查明结果", "Resolve")}</button></div>}{loading ? <Loader2 className="nw-spin" size={20} /> : <OutputCatalog workspaces={workspaces} selectedId={selected?.id} pending={pending} enabled={connection === "connected"} refreshSignal={refreshSignal} onSelect={selectArtifact} onCountChange={setTotalCount} />}</div>
    {selected && <aside className="nw-output-reader"><div className="nw-detail-heading"><strong>{selected.title}</strong><button className="nw-icon" disabled={pending} onClick={() => closeArtifact()} aria-label={t("关闭成果", "Close output")}><X size={17} /></button></div>{contentError ? <p role="alert" className="nw-inline-error">{contentError}</p> : !content ? <Loader2 className="nw-spin" size={20} /> : mediaManifest ? <MediaOutputReader manifest={mediaManifest} /> : <><div className="nw-output-actions"><button className="nw-button nw-button-small" disabled={revisionId !== null || pending} onClick={() => setEditing(!editing)}><Pencil size={13} />{editing ? t("预览", "Preview") : t("编辑", "Edit")}</button><button className="nw-button nw-button-small" onClick={() => {
      const blob = new Blob([draft], { type: selected.type || "text/plain" });
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${selected.title.replace(/[<>:"/\\|?*]/g, "-")}.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}><ArrowDownToLine size={13} />{t("下载", "Download")}</button><SaveToLibrary name={selected.title} text={draft} />{!revisionId && <button className="nw-button nw-button-primary nw-button-small" disabled={pending || !dirty || draft.length === 0 || connection !== 'connected'} title={draft.length === 0 ? t("空白内容无法存为新版本。", "An empty revision cannot be saved.") : undefined} onClick={() => { void saveRevision(); }}>{pending ? <Loader2 size={13} className="nw-spin" /> : <Save size={13} />}{t("保存新版本", "Save revision")}</button>}</div>{dirty && <p className="nw-output-unsaved" role="status">{t("预览包含未保存的修改", "Preview includes unsaved changes")}</p>}{saveConflict && <div className="nw-output-conflict" role="alert"><span>{t("其他人已保存新版本，当前草稿未丢失。", "Someone else saved a newer version. This draft is intact.")}</span><button className="nw-button nw-button-small" disabled={pending} onClick={() => { if (!canLeave()) return; setRevisionId(null); setSaveConflict(false); setReloadTick(value => value + 1); }}>{t("载入最新版本", "Load latest")}</button><button className="nw-button nw-button-small" disabled={copyBusy || pending || draft.length === 0} onClick={() => { void saveAsCopy(); }}>{copyBusy ? <Loader2 size={13} className="nw-spin" /> : null}{t("另存为副本", "Save a copy")}</button></div>}<div className="nw-output-body">{editing ? <textarea className="nw-output-editor" disabled={pending} aria-label={t("成果内容", "Output content")} value={draft} onChange={event => setDraft(event.target.value)} /> : <Markdown text={draft} />}</div><div className="nw-output-versions"><div className="nw-output-versions-head"><button className="nw-button nw-button-small" disabled={chainLoading || pending} onClick={() => { void loadVersions(); }}><History size={13} />{versionPanel ? t("隐藏版本列表", "Hide version list") : t("版本列表", "Version list")}</button>{revisionId && <button className="nw-button nw-button-small" disabled={diffBusy || pending} onClick={() => { void compareWithCurrent(); }}><ArrowLeftRight size={13} />{diffBusy ? t("正在对比…", "Comparing…") : t("与当前版本对比", "Compare with current")}</button>}</div>
      {versionPanel && (chainLoading ? <p className="nw-version-note" role="status"><Loader2 size={13} className="nw-spin" />{t("正在读取版本列表…", "Reading versions…")}</p> : chain && <ul className="nw-version-list">{chain.revisions.map((revision, index) => <li key={revision.id}><button className={revisionId === revision.id || (!revisionId && revision.id === currentRevisionId) ? "is-active" : ""} disabled={pending} onClick={() => chooseRevision(revision.id === currentRevisionId ? null : revision.id)}><span>{revision.id === currentRevisionId ? t("当前", "Current") : `v${chain.revisions.length - index}`}</span>{revision.createdAt && <time>{displayTime(revision.createdAt, locale)}</time>}</button></li>)}
        {chain.cycle && <li className="nw-version-note" role="note">{t("版本链存在环，已停止追溯；列表可能不完整。", "The version chain contains a loop; the walk stopped. The list may be incomplete.")}</li>}
        {chain.brokenAt && <li className="nw-version-note" role="note">{t("有版本记录无法读取，列表只包含可读的版本。", "Some revision records could not be read; only readable versions are listed.")}</li>}
        {chain.truncated && <li className="nw-version-note" role="note">{t(`为控制读取量，仅追溯了最近 ${chain.revisions.length} 个版本。`, `Only the latest ${chain.revisions.length} versions were read.`)}</li>}
      </ul>)}
      {diff && <div className="nw-output-diff" role="region" aria-label={t("版本差异", "Version differences")}><div className="nw-output-diff-head"><span>{diff.same ? t("两个版本内容相同。", "Both versions are identical.") : t(`+${diff.rows.filter(row => row.kind === "add").length} / -${diff.rows.filter(row => row.kind === "remove").length} 行`, `+${diff.rows.filter(row => row.kind === "add").length} / -${diff.rows.filter(row => row.kind === "remove").length} lines`)}{diff.truncated ? t(" · 内容过大，仅显示部分差异", " · too large, partially shown") : ""}</span><button className="nw-icon" onClick={() => setDiffState(null)} aria-label={t("关闭差异", "Close diff")}><X size={14} /></button></div><div className="nw-output-diff-body">{diff.rows.map((row, index) => <div key={index} className={`nw-diff-row is-${row.kind}`}><code>{row.before ?? ""}</code><code>{row.after ?? ""}</code><span>{row.text}</span></div>)}</div></div>}
      </div><footer className="nw-output-footer"><span><Layers size={13} />{revisionId ? t("历史版本", "Previous revision") : t("当前版本", "Current revision")}{content.revision?.createdAt && <time>{displayTime(content.revision.createdAt, locale)}</time>}</span><div>{content.revision?.parentIds?.[0] && <button className="nw-button nw-button-small" disabled={pending} onClick={() => { if (canLeave()) setRevisionId(content.revision!.parentIds![0]); }}><ChevronLeft size={13} />{t("上一版本", "Previous revision")}</button>}{revisionId && <button className="nw-button nw-button-small" disabled={pending} onClick={() => chooseRevision(null)}><RotateCcw size={13} />{t("回到当前", "Back to current")}</button>}</div></footer></> }</aside>}
  </div>;
}
