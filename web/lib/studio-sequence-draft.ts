import type { StudioReference, StudioSequence, StudioSequenceShot, StudioTemplate } from './native-studio';

export const SEQUENCE_PAGE_SIZE = 20;
export const MAX_SEQUENCE_SHOTS = 200;
export type SequenceShotDraft = {
  id: string; prompt: string; profileId: string; seconds: number;
  continuity: 'previous-tail' | 'none'; templateId?: string; templateRevision?: number;
  templateParams?: Record<string, string>; templateSnapshot?: string; acceptedPrompt?: string; locked?: boolean;
  firstFrame?: StudioReference;
};
export type SequenceDraft = { title: string; globalPrompt: string; profileId: string; seconds: number; shots: SequenceShotDraft[] };
export const makeSequenceShot = (profileId = '', seconds = 4, index = 0): SequenceShotDraft => ({ id: crypto.randomUUID(), prompt: '', profileId, seconds, continuity: index ? 'previous-tail' : 'none' });
export const makeSequenceDraft = (): SequenceDraft => ({ title: '', globalPrompt: '', profileId: '', seconds: 4, shots: [makeSequenceShot()] });

export function draftFromSequence(sequence: StudioSequence): SequenceDraft {
  return { title: sequence.title, globalPrompt: sequence.globalPrompt, profileId: sequence.defaults.profileId, seconds: sequence.defaults.seconds,
    shots: sequence.shots.map((shot: StudioSequenceShot) => ({ ...shot, templateParams: shot.templateParams as Record<string, string> | undefined, locked: !!(shot.jobId || shot.acceptedPrompt) })) };
}

// Preserve server identities and submitted positions. A move is allowed only
// within the unsubmitted suffix; changing the first slot removes its dependency.
export function moveSequenceShot(shots: SequenceShotDraft[], id: string, delta: number): SequenceShotDraft[] {
  const source = shots.findIndex(shot => shot.id === id), target = source + delta;
  if (source < 0 || target < 0 || target >= shots.length || shots[source].locked || shots[target].locked) return shots;
  const next = [...shots]; [next[source], next[target]] = [next[target], next[source]];
  return next.map((shot, index) => index === 0 && shot.continuity !== 'none' ? { ...shot, continuity: 'none' } : shot);
}

export function sequenceShotInput(shot: SequenceShotDraft) {
  return { id: shot.id, prompt: shot.prompt, profileId: shot.profileId, seconds: shot.seconds, continuity: shot.continuity,
    ...(shot.continuity === 'none' && shot.firstFrame ? { firstFrame: shot.firstFrame } : {}),
    ...(shot.templateId ? { templateId: shot.templateId, templateRevision: shot.templateRevision, templateParams: shot.templateParams } : {}) };
}

// Match the server's single-pass substitution. Values containing {{...}} are
// literal data and must not recursively substitute other values.
export function renderSequenceTemplate(shot: SequenceShotDraft, template?: StudioTemplate): { text: string; missing: string[] } {
  if (!shot.templateId) return { text: shot.prompt, missing: [] };
  if (shot.templateSnapshot !== undefined) return { text: shot.templateSnapshot, missing: [] };
  if (!template || (shot.templateRevision && template.revision !== shot.templateRevision)) return { text: '', missing: ['template-version'] };
  const values = { ...template.defaults, ...shot.templateParams }, missing: string[] = [];
  const text = template.prompt.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (raw, name: string) => {
    if (values[name] === undefined) { if (!missing.includes(name)) missing.push(name); return raw; }
    return String(values[name]);
  });
  return { text, missing };
}

export function readSequenceDraft(raw: unknown): SequenceDraft | undefined {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as SequenceDraft;
  if (typeof value.title !== 'string' || typeof value.globalPrompt !== 'string' || typeof value.profileId !== 'string' || !Number.isInteger(value.seconds) || value.seconds < 1 || value.seconds > 60 || !Array.isArray(value.shots) || !value.shots.length || value.shots.length > MAX_SEQUENCE_SHOTS) return;
  const ids = new Set<string>();
  for (const shot of value.shots) {
    if (!shot || typeof shot.id !== 'string' || !shot.id || ids.has(shot.id) || typeof shot.prompt !== 'string' || typeof shot.profileId !== 'string' || !Number.isInteger(shot.seconds) || shot.seconds < 1 || shot.seconds > 60 || !['none', 'previous-tail'].includes(shot.continuity)) return;
    ids.add(shot.id);
  }
  return value;
}
