/**
 * §Phase D3: project-level BGM slot logic (pure functions, UI-free).
 *
 * The project's BGM slot is the source of truth: the compose panel edits it,
 * PATCH /projects/{id} persists it, and the composition request leaves the BGM
 * keys absent so the server inherits the slot (an explicit `bgm_asset_id: ''`
 * still means "no music this time").
 */

export type BgmBounds = { min: number; max: number; step: number; fallback: number }

/** Mirrors the backend store bounds (PROJECT_BGM_VOLUME_RANGE / FADE_RANGE). */
export const BGM_VOLUME_BOUNDS: BgmBounds = { min: 0, max: 2, step: 0.05, fallback: 0.6 }
export const BGM_FADE_BOUNDS: BgmBounds = { min: 0, max: 10, step: 0.5, fallback: 1 }

/** The editable BGM slot state used by the compose panel. */
export type BgmSlot = {
  bgm_asset_id: string
  bgm_volume: number
  bgm_fade_in: number
  bgm_fade_out: number
}

export const NEUTRAL_BGM_SLOT: BgmSlot = {
  bgm_asset_id: '',
  bgm_volume: BGM_VOLUME_BOUNDS.fallback,
  bgm_fade_in: BGM_FADE_BOUNDS.fallback,
  bgm_fade_out: BGM_FADE_BOUNDS.fallback,
}

function clampNumber(value: unknown, bounds: BgmBounds): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return bounds.fallback
  return Math.min(bounds.max, Math.max(bounds.min, parsed))
}

/** Read a BGM slot off a project row, tolerating missing/legacy fields. */
export function bgmSlotFromProject(
  project: Partial<{
    bgm_asset_id?: string | null
    bgm_volume?: number | null
    bgm_fade_in?: number | null
    bgm_fade_out?: number | null
  }> | null | undefined
): BgmSlot {
  return {
    bgm_asset_id: String(project?.bgm_asset_id || ''),
    bgm_volume: clampNumber(project?.bgm_volume, BGM_VOLUME_BOUNDS),
    bgm_fade_in: clampNumber(project?.bgm_fade_in, BGM_FADE_BOUNDS),
    bgm_fade_out: clampNumber(project?.bgm_fade_out, BGM_FADE_BOUNDS),
  }
}

/** Clamp user-typed slot values back into the backend bounds. */
export function normalizeBgmSlot(slot: Partial<BgmSlot>): BgmSlot {
  return {
    bgm_asset_id: String(slot.bgm_asset_id || ''),
    bgm_volume: clampNumber(slot.bgm_volume, BGM_VOLUME_BOUNDS),
    bgm_fade_in: clampNumber(slot.bgm_fade_in, BGM_FADE_BOUNDS),
    bgm_fade_out: clampNumber(slot.bgm_fade_out, BGM_FADE_BOUNDS),
  }
}

/**
 * The per-composition audio payload. The panel persists the slot via PATCH, so
 * the compose request keeps the BGM keys absent and lets the server inherit —
 * the §Phase D3 fallback. Only `voiceovers` is per-request state.
 */
export function composeAudioPayload(voiceovers: boolean): { voiceovers: boolean } {
  return { voiceovers }
}

/** Which slot fields differ between two snapshots (drives PATCH bodies). */
export function bgmSlotDiff(
  before: BgmSlot,
  after: BgmSlot
): Partial<BgmSlot> {
  const diff: Partial<BgmSlot> = {}
  if (before.bgm_asset_id !== after.bgm_asset_id) diff.bgm_asset_id = after.bgm_asset_id
  if (before.bgm_volume !== after.bgm_volume) diff.bgm_volume = after.bgm_volume
  if (before.bgm_fade_in !== after.bgm_fade_in) diff.bgm_fade_in = after.bgm_fade_in
  if (before.bgm_fade_out !== after.bgm_fade_out) diff.bgm_fade_out = after.bgm_fade_out
  return diff
}

/** True when the slot actually selects music (drives volume/fade enabled state). */
export function bgmSlotHasMusic(slot: BgmSlot): boolean {
  return slot.bgm_asset_id.trim().length > 0
}
