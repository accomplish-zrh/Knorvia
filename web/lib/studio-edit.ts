export type EditClip = { id: string; startFrame: number; endFrame: number; volume: number; fadeFrames: number; fit?: 'contain' | 'cover'; rotation?: 0 | 90 | 180 | 270; mirror?: boolean };
export type EditCaption = { startFrame: number; endFrame: number; text: string };
export type EditManifest = { fps: number; aspect: string; clips: EditClip[]; captions?: EditCaption[] };
export type EditSource = { id: string; jobId?: string; origin?: 'library'; libraryId?: string; index: number; name: string; sha256: string; frames: number; hasAudio: boolean; title: string };
export type EditProject = { id: string; title: string; revision: number; sources: EditSource[]; edit: EditManifest; lastRenderId?: string; lastSubtitleId?: string; appliedSubtitleId?: string; lastRetakeId?: string; appliedRetakeId?: string; retakeUndo?: { revision: number } };
export type EditRender = { id: string; status: string; phase: string; progress: number; revision: number; edit?: EditManifest; error?: string; cancelRequested?: boolean; output?: { frames: number; fps: number; size: number }; libraryId?: string };
export const editFrames = (edit: EditManifest) => edit.clips.reduce((sum, c) => sum + c.endFrame - c.startFrame, 0);
export function moveEditClip(edit: EditManifest, index: number, step: number): EditManifest {
  const target = index + step;
  if (target < 0 || target >= edit.clips.length) return edit;
  const clips = [...edit.clips];
  [clips[index], clips[target]] = [clips[target], clips[index]];
  return { ...edit, clips };
}
