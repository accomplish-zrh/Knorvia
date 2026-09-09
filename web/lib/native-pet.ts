// Pet animation state machine for the renderer (B19/B22). Mirrors the
// desktop-side pet-runtime semantics: real task states map one-way onto
// sprite rows, reduced motion pins a frame, and hidden surfaces draw nothing.
// Layouts follow the official hatch-pet contract (schemaVersion 1: 8×9,
// 192×208 cells) and the community v2 (8×11).
export type PetLayout = { schemaVersion: 1 | 2; columns: number; rows: number; cellWidth: number; cellHeight: number; atlasWidth: number; atlasHeight: number };
export type PetManifest = { schemaVersion: 1 | 2; id: string; displayName: string; description: string; spritesheetPath: string; atlasSha256?: string };
export type PetCell = { index: number; row: number; column: number; x: number; y: number; width: number; height: number; state: PetState; at: number };
export type PetState = 'idle' | 'working' | 'waiting' | 'succeeded' | 'failed' | 'review' | 'running-right' | 'running-left';
export const PET_LAYOUTS: Record<1 | 2, PetLayout> = {
  1: { schemaVersion: 1, columns: 8, rows: 9, cellWidth: 192, cellHeight: 208, atlasWidth: 1536, atlasHeight: 1872 },
  2: { schemaVersion: 2, columns: 8, rows: 11, cellWidth: 192, cellHeight: 208, atlasWidth: 1536, atlasHeight: 2288 },
};
export const STATE_ROWS: Record<PetState, number> = { idle: 0, working: 7, waiting: 6, succeeded: 3, failed: 5, review: 8, 'running-right': 1, 'running-left': 2 };
export const PET_ROWS = ['idle','running-right','running-left','waving','jumping','failed','waiting','running','review'];
export const PET_DURATIONS = [[280,110,110,140,140,320],[120,120,120,120,120,120,120,220],[120,120,120,120,120,120,120,220],[140,140,140,280],[140,140,140,140,280],[140,140,140,140,140,140,140,240],[150,150,150,150,150,260],[120,120,120,120,120,220],[150,150,150,150,150,280]];
export type PetCandidate = { id: string; manifest: PetManifest; atlasSha256: string; layout: PetLayout; url?: string; qa: { passed: boolean; errors: string[]; warnings: string[]; visualReviewRequired: boolean } };
export type PetHatchJob = { id: string; status: string; phase: string; error?: string; active?: boolean; candidateId?: string; pipeline?: { completedRows?: number; phase?: string }; input: { name: string; profileId: string } };
export type PetIndex = { packages: PetCandidate[]; selected: { id: string | null }; jobs: PetHatchJob[]; invalid: string[] };

export function createPetRuntime({ layout, fps = 8, reducedMotion = false, outcomeHoldMs = 4000 }: { layout: PetLayout; fps?: number; reducedMotion?: boolean; outcomeHoldMs?: number }) {
  let state: PetState = 'idle';
  let stateSince = 0;
  return {
    get state() { return state; },
    setState(next: PetState, now = Date.now()): boolean {
      if (!(next in STATE_ROWS) || next === state) return false;
      state = next;
      stateSince = now;
      return true;
    },
    frame(now = Date.now(), { visible = true }: { visible?: boolean } = {}): PetCell | null {
      if (!visible) return null;
      if ((state === 'succeeded' || state === 'failed') && now - stateSince > outcomeHoldMs) {
        state = 'idle';
        stateSince = now;
      }
      const row = STATE_ROWS[state];
      const timings = PET_DURATIONS[row]; let phase = Math.max(0, now - stateSince) % timings.reduce((sum, time) => sum + time, 0), frame = 0;
      while (frame < timings.length - 1 && phase >= timings[frame]) { phase -= timings[frame]; frame++; }
      const index = reducedMotion || state === 'succeeded' || state === 'failed' ? row * layout.columns : row * layout.columns + frame;
      const column = index % layout.columns;
      const cellRow = Math.floor(index / layout.columns);
      if (cellRow >= layout.rows) return null;
      return { index, row: cellRow, column, x: column * layout.cellWidth, y: cellRow * layout.cellHeight, width: layout.cellWidth, height: layout.cellHeight, state, at: now };
    },
  };
}
// A durable pet identity for the renderer: manifest plus content hash, so a
// reload can verify the atlas before animating it.
export type PetPackageRecord = { manifest: PetManifest; atlasSha256: string };
export function petRecordFromManifest(manifest: PetManifest, atlasSha256: string): PetPackageRecord {
  return { manifest: { ...manifest, atlasSha256 }, atlasSha256 };
}
