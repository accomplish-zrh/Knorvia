// P09: durable article-video drafts. A draft captures the uncommitted edit
// state of the StudioArticle dialog (new-project fields, or narration/scenes/
// aspect on top of a project at a known base revision) so a refresh, a route
// change, or switching projects cannot silently destroy work.
//
// All functions are pure with respect to an injected storage handle
// (`localStorage`-shaped) so they are unit-testable; a corrupt store is
// dropped rather than thrown, and an unwritable store is reported instead of
// losing edits silently.

export const ARTICLE_DRAFT_VERSION = 1;
export const ARTICLE_DRAFT_CAP = 12;
const LIMITS = {
  title: 100,
  article: 60000,
  audience: 500,
  narration: 30000,
  aspect: ['16:9', '9:16', '1:1'],
  scenes: 80,
  sceneHeading: 100,
  sceneDetail: 350,
};

export type ArticleDraftScene = { heading: string; detail: string; reference?: { id: string; version: string } };
export type ArticleDraft = {
  version: typeof ARTICLE_DRAFT_VERSION;
  workspaceId: string;
  /** null = the new-project form (no server project behind it yet). */
  projectId: string | null;
  /** Server revision this edit started from; null for new-project drafts. */
  baseRevision: number | null;
  title: string;
  article: string;
  audience: string;
  narration: string;
  aspect: string;
  scenes: ArticleDraftScene[];
  /** Stable idempotency key carried across a save whose response was lost. */
  saveKey?: string;
  updatedAt: number;
};

export type DraftStorage = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem?: (key: string) => void };

export const storageKey = (workspaceId: string) => `knorvia-studio-article-draft:${workspaceId || 'default'}`;
export const articleDraftSlot = (draft: Pick<ArticleDraft, 'projectId'>): string => draft.projectId ?? 'new';

export function makeArticleDraft(workspaceId: string, fields: Partial<ArticleDraft> = {}): ArticleDraft {
  return {
    version: ARTICLE_DRAFT_VERSION,
    workspaceId,
    projectId: null,
    baseRevision: null,
    title: '',
    article: '',
    audience: '',
    narration: '',
    aspect: '16:9',
    scenes: [],
    ...fields,
    updatedAt: Date.now(),
  };
}

/** Snapshot of an in-progress edit on top of a project at its current revision. */
export function draftFromProject(workspaceId: string, project: {
  id: string; revision: number; narration: string; aspect: string; scenes: ArticleDraftScene[];
}, edits: { narration: string; aspect: string; scenes: ArticleDraftScene[] }, saveKey?: string): ArticleDraft {
  return makeArticleDraft(workspaceId, {
    projectId: project.id,
    baseRevision: project.revision,
    narration: edits.narration,
    aspect: edits.aspect,
    scenes: edits.scenes,
    ...(saveKey ? { saveKey } : {}),
  });
}

function validScenes(scenes: unknown): scenes is ArticleDraftScene[] {
  if (!Array.isArray(scenes) || scenes.length > LIMITS.scenes) return false;
  return scenes.every(scene => {
    if (!scene || typeof scene !== 'object') return false;
    const value = scene as ArticleDraftScene;
    if (typeof value.heading !== 'string' || value.heading.length > LIMITS.sceneHeading) return false;
    if (typeof value.detail !== 'string' || value.detail.length > LIMITS.sceneDetail) return false;
    if (value.reference !== undefined) {
      if (!value.reference || typeof value.reference !== 'object') return false;
      const reference = value.reference as { id?: unknown; version?: unknown };
      if (typeof reference.id !== 'string' || typeof reference.version !== 'string') return false;
    }
    return true;
  });
}

/** Strict validation: anything malformed is dropped, never applied to a project. */
export function readArticleDraft(raw: unknown): ArticleDraft | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as ArticleDraft;
  if (value.version !== ARTICLE_DRAFT_VERSION) return undefined;
  if (typeof value.workspaceId !== 'string') return undefined;
  if (value.projectId !== null && (typeof value.projectId !== 'string' || !value.projectId)) return undefined;
  if (value.baseRevision !== null && !Number.isSafeInteger(value.baseRevision)) return undefined;
  for (const field of ['title', 'article', 'audience', 'narration', 'aspect'] as const) {
    if (typeof value[field] !== 'string') return undefined;
  }
  if (value.title.length > LIMITS.title || value.article.length > LIMITS.article
    || value.audience.length > LIMITS.audience || value.narration.length > LIMITS.narration) return undefined;
  if (!LIMITS.aspect.includes(value.aspect)) return undefined;
  if (!validScenes(value.scenes)) return undefined;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return undefined;
  if (value.saveKey !== undefined && (typeof value.saveKey !== 'string' || value.saveKey.length > 128)) return undefined;
  return value;
}

/** Parse a whole stored document; corrupt entries are dropped individually. */
export function readArticleDrafts(raw: string | null): ArticleDraft[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!parsed || typeof parsed !== 'object') return [];
  const drafts = (parsed as { drafts?: unknown }).drafts;
  if (!Array.isArray(drafts)) return [];
  return drafts
    .map(entry => readArticleDraft(entry))
    .filter((draft): draft is ArticleDraft => !!draft)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, ARTICLE_DRAFT_CAP);
}

export function loadArticleDrafts(storage: DraftStorage | undefined, workspaceId: string): { drafts: ArticleDraft[]; unwritable: boolean } {
  if (!storage) return { drafts: [], unwritable: false };
  let raw: string | null;
  try { raw = storage.getItem(storageKey(workspaceId)); } catch { return { drafts: [], unwritable: true }; }
  return { drafts: readArticleDrafts(raw), unwritable: false };
}

/** Upsert by slot (project id or the new-project form), most-recent first, capped. */
export function storeArticleDraft(storage: DraftStorage | undefined, workspaceId: string, draft: ArticleDraft): { unwritable: boolean } {
  if (!storage) return { unwritable: false };
  const { drafts } = loadArticleDrafts(storage, workspaceId);
  const next = [draft, ...drafts.filter(existing => articleDraftSlot(existing) !== articleDraftSlot(draft))].slice(0, ARTICLE_DRAFT_CAP);
  try {
    storage.setItem(storageKey(workspaceId), JSON.stringify({ version: ARTICLE_DRAFT_VERSION, drafts: next }));
    return { unwritable: false };
  } catch {
    return { unwritable: true };
  }
}

export function clearArticleDraft(storage: DraftStorage | undefined, workspaceId: string, projectId: string | null): { unwritable: boolean } {
  if (!storage) return { unwritable: false };
  const { drafts } = loadArticleDrafts(storage, workspaceId);
  const next = drafts.filter(existing => existing.projectId !== projectId);
  try {
    storage.setItem(storageKey(workspaceId), JSON.stringify({ version: ARTICLE_DRAFT_VERSION, drafts: next }));
    return { unwritable: false };
  } catch {
    return { unwritable: true };
  }
}

export type DraftReplayDecision = 'fast-forward' | 'server-ahead' | 'irrelevant';

/**
 * Decide how a stored project draft relates to the live project revision.
 * Equal → the draft applies cleanly; the server having moved on means both
 * versions are kept and the user chooses.
 */
export function draftReplayDecision(draft: ArticleDraft, serverRevision: number | undefined): DraftReplayDecision {
  if (draft.projectId === null) return 'irrelevant';
  if (draft.baseRevision === null) return 'irrelevant';
  if (serverRevision === undefined) return 'irrelevant';
  return draft.baseRevision === serverRevision ? 'fast-forward' : 'server-ahead';
}

/** A readable rescue copy for the download path (no data leaves the machine). */
export function draftToMarkdown(draft: ArticleDraft): string {
  const lines: string[] = [];
  if (draft.projectId) lines.push(`# ${draft.projectId} @ v${draft.baseRevision ?? '?'}`);
  else lines.push(draft.title ? `# ${draft.title}` : '# 文章草稿');
  if (draft.audience) lines.push('', draft.audience);
  if (draft.article) lines.push('', draft.article);
  if (draft.narration) lines.push('', '## 口播稿', '', draft.narration);
  lines.push('', '## 画幅', '', draft.aspect);
  if (draft.scenes.length) {
    lines.push('', '## 分镜', '');
    draft.scenes.forEach((scene, index) => {
      lines.push(`${index + 1}. ${scene.heading}`, `   ${scene.detail}`);
    });
  }
  lines.push('', `<!-- knorvia article draft, updated ${new Date(draft.updatedAt).toISOString()} -->`);
  return lines.join('\n');
}
