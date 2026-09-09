export type ReadingPreference = { size: number; width: 'focused' | 'standard' | 'wide'; reducedMotion: boolean };
export const READING_KEY = 'knorvia-reading-v1';
export function readingPreference(raw: string): ReadingPreference {
  let value; try { value = JSON.parse(raw); } catch { /* use defaults */ }
  return { size: Number.isFinite(value?.size) ? Math.max(13, Math.min(20, Math.round(value.size))) : 15, width: ['focused', 'standard', 'wide'].includes(value?.width) ? value.width : 'standard', reducedMotion: value?.reducedMotion === true };
}
